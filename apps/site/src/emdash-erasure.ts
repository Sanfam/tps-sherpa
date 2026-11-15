import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const ANONYMOUS_NAME = "Anonymous";
const DAY_MS = 24 * 60 * 60_000;
const NINETY_DAYS_MS = 90 * DAY_MS;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const dbPath = () => `${process.env["SITE_EMDASH_DIR"] ?? ".data"}/emdash.db`;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tableName = (collection: string) => {
  if (!IDENTIFIER.test(collection)) throw new Error("invalid collection");
  return `ec_${collection}`;
};

function openDatabase() {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
  return db;
}

function sqliteDate(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Folds the WAL back into the main file, best effort. PASSIVE never waits: a
 * TRUNCATE here, retried, could block the event loop, and so the whole site,
 * for about 25 seconds while Litestream held a reader. What it cannot fold
 * now, Litestream's own checkpoint folds shortly after (owner's concession,
 * ADR-0002).
 */
function checkpoint(db: DatabaseSync) {
  try {
    db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
  } catch (error) {
    console.error("[emdash] SQLite WAL checkpoint failed:", error);
  }
}

function tables(db: DatabaseSync, prefix: string) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?").all(`${prefix}%`) as { name: string }[]).map(
    ({ name }) => name,
  );
}

function hasColumn(db: DatabaseSync, table: string, column: string) {
  return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).some((row) => row.name === column);
}

function clearQueueRows(db: DatabaseSync, where = "", ...params: string[]) {
  // EmDash internal `_emdash_revision_prune_queue` must not retain deleted revision IDs.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_emdash_revision_prune_queue'").get()) return;
  db.prepare(
    `DELETE FROM _emdash_revision_prune_queue WHERE ${where || "NOT EXISTS (SELECT 1 FROM revisions WHERE revisions.id = _emdash_revision_prune_queue.revision_id)"}`,
  ).run(...params);
}

export function purgeHistory(collection: string, entryId: string) {
  const db = openDatabase();
  let completed = false;
  try {
    // EmDash internals `ec_*`, `revisions` and their live/draft pointers define history ownership.
    const content = tableName(collection);
    const row = db.prepare(`SELECT live_revision_id, draft_revision_id FROM ${quote(content)} WHERE id = ?`).get(entryId) as
      | { live_revision_id: string | null; draft_revision_id: string | null }
      | undefined;
    if (!row) throw new Error("entry not found");
    const keep = [row.live_revision_id, row.draft_revision_id].filter((id): id is string => Boolean(id));
    if (keep.length) {
      const placeholders = keep.map(() => "?").join(", ");
      db.prepare(
        `DELETE FROM revisions WHERE collection = ? AND entry_id = ? AND id NOT IN (${placeholders})`,
      ).run(collection, entryId, ...keep);
    } else {
      db.prepare("DELETE FROM revisions WHERE collection = ? AND entry_id = ?").run(collection, entryId);
    }
    clearQueueRows(
      db,
      "collection = ? AND entry_id = ? AND NOT EXISTS (SELECT 1 FROM revisions WHERE revisions.id = _emdash_revision_prune_queue.revision_id)",
      collection,
      entryId,
    );
    completed = true;
  } finally {
    if (completed) checkpoint(db);
    db.close();
  }
}

export function pruneRevisions(now = Date.now()) {
  const db = openDatabase();
  let committed = false;
  try {
    // EmDash internal `ec_*` tables hold the live_revision_id/draft_revision_id rows that pruning must protect.
    const contentTables = tables(db, "ec_");
    const protectedByContent = contentTables
      .filter((name) => hasColumn(db, name, "live_revision_id") && hasColumn(db, name, "draft_revision_id"))
      .map(
        (name) =>
          `NOT EXISTS (SELECT 1 FROM ${quote(name)} WHERE ${quote(name)}.live_revision_id = revisions.id OR ${quote(name)}.draft_revision_id = revisions.id)`,
      );
    const keep = protectedByContent.length ? ` AND ${protectedByContent.join(" AND ")}` : "";
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`DELETE FROM revisions WHERE datetime(created_at) < datetime(?)${keep}`).run(
      sqliteDate(now - NINETY_DAYS_MS),
    );
    clearQueueRows(db);
    db.exec("COMMIT");
    committed = true;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    if (committed) checkpoint(db);
    db.close();
  }
}

export function anonymiseEditor(email: string) {
  const db = openDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    // EmDash internals `users`, `revisions.author_id`, `ec_*.author_id`, and `_emdash_bylines.user_id` are not extension points.
    const editor = db.prepare("SELECT id, name, data FROM users WHERE email = ?").get(email) as
      | { id: string; name: string | null; data: string | null }
      | undefined;
    if (!editor) throw new Error("editor not found");

    const anonymousEmail = `anonymous-${editor.id}@emdash.invalid`;
    const anonymous = db.prepare("SELECT id FROM users WHERE email = ?").get(anonymousEmail) as { id: string } | undefined;
    const anonymousId = anonymous?.id ?? randomUUID();
    if (!anonymous) {
      db.prepare(
        "INSERT INTO users (id, email, name, role, email_verified, data) VALUES (?, ?, ?, 10, 1, ?)",
      ).run(anonymousId, anonymousEmail, ANONYMOUS_NAME, JSON.stringify({ anonymous: true }));
    }

    const marker = (() => {
      try {
        const data = editor.data ? JSON.parse(editor.data) : {};
        const clean = data && typeof data === "object" ? { ...data } : {};
        delete clean.name;
        delete clean.username;
        return JSON.stringify({ ...clean, anonymised: true });
      } catch {
        return JSON.stringify({ anonymised: true });
      }
    })();
    db.prepare("UPDATE users SET name = NULL, data = ?, updated_at = ? WHERE id = ?").run(marker, new Date().toISOString(), editor.id);
    db.prepare("UPDATE revisions SET author_id = ? WHERE author_id = ?").run(anonymousId, editor.id);
    for (const table of tables(db, "ec_")) {
      if (hasColumn(db, table, "author_id")) db.prepare(`UPDATE ${quote(table)} SET author_id = ? WHERE author_id = ?`).run(anonymousId, editor.id);
    }
    if (hasColumn(db, "media", "author_id")) db.prepare("UPDATE media SET author_id = ? WHERE author_id = ?").run(anonymousId, editor.id);
    if (hasColumn(db, "_emdash_bylines", "user_id")) {
      db.prepare("UPDATE _emdash_bylines SET user_id = ?, display_name = ?, slug = ? WHERE user_id = ?").run(
        anonymousId,
        ANONYMOUS_NAME,
        `anonymous-${editor.id.toLowerCase()}`,
        editor.id,
      );
    }
    // EmDash migration 096's optional `revisions.edited_by` JSON metadata is absent in the pinned 1.4.0 trial.
    if (hasColumn(db, "revisions", "edited_by")) {
      const revisions = db.prepare("SELECT id, edited_by FROM revisions WHERE edited_by IS NOT NULL").all() as { id: string; edited_by: string }[];
      const update = db.prepare("UPDATE revisions SET edited_by = ? WHERE id = ?");
      for (const revision of revisions) {
        try {
          const ids = JSON.parse(revision.edited_by);
          if (Array.isArray(ids) && ids.includes(editor.id)) update.run(JSON.stringify(ids.map((id) => (id === editor.id ? anonymousId : id))), revision.id);
        } catch {
          // Leave malformed historical metadata untouched.
        }
      }
    }
    clearQueueRows(db);
    db.exec("COMMIT");
    checkpoint(db);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  } finally {
    db.close();
  }
}

// ponytail: opens the database on every private CMS request (authenticate()).
// Keep one connection open if that ever shows in latency.
export function isAnonymisedEmail(email: string) {
  const db = openDatabase();
  try {
    const row = db.prepare("SELECT data FROM users WHERE email = ?").get(email) as { data: string | null } | undefined;
    if (!row?.data) return false;
    try {
      return JSON.parse(row.data)?.anonymised === true;
    } catch {
      return false;
    }
  } finally {
    db.close();
  }
}

let pruneTimer: ReturnType<typeof setInterval> | undefined;
let pruneStartTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Prunes once soon after start, then daily. A deploy restarts the process, so
 * waiting a full day first would mean a site deployed daily never prunes.
 */
export function startRevisionPruner() {
  if (pruneTimer || pruneStartTimer) return;
  const prune = () => {
    try {
      pruneRevisions();
    } catch (error) {
      console.error("[emdash] Revision prune failed:", error);
    }
  };
  // A minute in, so EmDash's migrations have run on a fresh database.
  pruneStartTimer = setTimeout(() => {
    pruneStartTimer = undefined;
    prune();
    pruneTimer = setInterval(prune, DAY_MS);
    pruneTimer.unref?.();
  }, 60_000);
  pruneStartTimer.unref?.();
}
