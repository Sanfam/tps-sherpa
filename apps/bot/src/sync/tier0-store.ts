/**
 * SQLite storage for Tier 0, on the service's own volume.
 *
 * Uses Node's built-in `node:sqlite` — no dependency. Nothing here is backed
 * up: the volume is disposable and the rebuild path is a re-run of the capture.
 * Nothing is kept for more than seven days either: see `purge.ts`.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const TIER0_PATH =
  process.env["TIER0_PATH"] ?? resolve(import.meta.dirname, "../../.data/tier0.db");

const HOUR_MS = 60 * 60 * 1000;

/**
 * How old a message may be and still be held. The promise is seven days, by
 * when it was written. Capture stores nothing older than this, and the purge,
 * at the start of each cycle, deletes what has aged past it since. Cycles start
 * six hours apart, so a message can wait up to one cycle past this before a
 * purge sees it: 6 days + 6 hours = 6.25 days. The other 18 hours absorb a
 * cycle that overruns or a restart. Two ways past seven days, both accepted
 * (Staff, 2026-10-15): a bot down for longer than that, or a single cycle that
 * runs longer than that. Either way the next cycle purges first.
 */
export const RETAIN_MS = 6 * 24 * HOUR_MS;

export interface StoredMessage {
  entityId: string;
  messageId: string;
  /**
   * The message author. Kept because bot messages must be dropped and because
   * sampling prefers participant diversity; both need it at selection time and
   * neither can be recomputed later. Bot-side only, never replicated, never
   * published, never sent to a model.
   */
  authorId: string;
  authorIsBot: boolean;
  content: string;
  createdAt: string;
  /** Which window it came from, so sampling can tell opening from recent. */
  window: "head" | "tail";
}

export const openTier0 = (path: string) => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Secure delete so a purged or deleted message is zeroed in the file, not
  // left readable in a free page. The busy timeout because a deletion request
  // arrives through the gateway while a capture may be writing from another
  // process.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA secure_delete = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS captured_entity (
      entity_id       TEXT PRIMARY KEY,
      last_message_id TEXT,
      captured_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message (
      entity_id     TEXT NOT NULL,
      message_id    TEXT NOT NULL,
      author_id     TEXT NOT NULL,
      author_is_bot INTEGER NOT NULL,
      content       TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      window        TEXT NOT NULL,
      PRIMARY KEY (entity_id, message_id)
    );
  `);

  return {
    /** What a previous run already stored, for the incremental decision. */
    state: () => {
      const rows = db
        .prepare("SELECT entity_id, last_message_id FROM captured_entity")
        .all() as Array<{ entity_id: string; last_message_id: string | null }>;
      return new Map(
        rows.map((r) => [r.entity_id, { lastMessageId: r.last_message_id }]),
      );
    },

    record: (
    entityId: string,
    lastMessageId: string | null | undefined,
    messages: StoredMessage[],
  ) => {
      const insertMessage = db.prepare(
        `INSERT OR REPLACE INTO message
           (entity_id, message_id, author_id, author_is_bot, content, created_at, window)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      // Replacing the Entity's rows rather than merging is what lets a
      // deletion propagate: a message removed in Discord disappears here on
      // the next capture of that Entity. Without it, raw member text would
      // outlive the member's own deletion, which is precisely the posture the
      // header claims and would otherwise be false.
      const clearEntity = db.prepare("DELETE FROM message WHERE entity_id = ?");
      const markCaptured = db.prepare(
        `INSERT OR REPLACE INTO captured_entity (entity_id, last_message_id, captured_at)
         VALUES (?, ?, ?)`,
      );
      // One transaction per Entity: a crash mid-run leaves complete Entities
      // captured and the rest simply uncaptured, which the next run picks up.
      db.exec("BEGIN");
      try {
        clearEntity.run(entityId);
        for (const m of messages)
          insertMessage.run(
            m.entityId,
            m.messageId,
            m.authorId,
            m.authorIsBot ? 1 : 0,
            m.content,
            m.createdAt,
            m.window,
          );
        // node:sqlite rejects undefined; a Catalog written before this field
        // existed has no value at all.
        markCaptured.run(entityId, lastMessageId ?? null, new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    /** Everything stored for one Entity. Order is not guaranteed. */
    messagesFor: (entityId: string): StoredMessage[] =>
      (
        db
          .prepare(
            `SELECT entity_id, message_id, author_id, author_is_bot, content, created_at, window
               FROM message WHERE entity_id = ?`,
          )
          .all(entityId) as Array<{
          entity_id: string;
          message_id: string;
          author_id: string;
          author_is_bot: number;
          content: string;
          created_at: string;
          window: "head" | "tail";
        }>
      ).map((r) => ({
        entityId: r.entity_id,
        messageId: r.message_id,
        authorId: r.author_id,
        authorIsBot: r.author_is_bot === 1,
        content: r.content,
        createdAt: r.created_at,
        window: r.window,
      })),

    /**
     * Deletes every message written before `cutoff` (an ISO time). By when it
     * was written, not when it was captured: capture refetches the same
     * windows, so a capture-time clock restarts on years-old text. Cursors
     * stay — an Entity whose newest message has not moved has nothing recent
     * to fetch. Text comparison works because Discord timestamps are UTC
     * ISO 8601; one that is missing sorts first and is deleted.
     */
    dropWrittenBefore: (cutoff: string): number =>
      Number(db.prepare("DELETE FROM message WHERE created_at < ?").run(cutoff).changes),

    /** The Entities holding anything this author wrote. */
    authoredIn: (authorId: string): string[] =>
      (
        db.prepare("SELECT DISTINCT entity_id FROM message WHERE author_id = ?").all(authorId) as Array<{
          entity_id: string;
        }>
      ).map((r) => r.entity_id),

    /**
     * Deletes everything this author wrote. Cursors are left alone: their
     * messages are gone, and a recapture would only drop them again.
     */
    deleteAuthor: (authorId: string): number =>
      Number(db.prepare("DELETE FROM message WHERE author_id = ?").run(authorId).changes),

    /**
     * Moves the write-ahead log into the file and empties it. Secure delete
     * zeroes a row in the page written to the log; until a checkpoint, the
     * file itself still holds the old page — and while another process holds
     * the database open, closing does not checkpoint. False when a reader got
     * in the way: the next checkpoint finishes it.
     */
    checkpoint: (): boolean =>
      (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number }).busy === 0,

    stats: () => {
      // CAST AS BLOB: LENGTH() on text counts characters, and this figure is
      // reported as a volume footprint. Emoji-heavy content undercounts ~4x.
      const m = db.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS bytes FROM message",
      ).get() as {
        n: number;
        bytes: number;
      };
      const e = db.prepare("SELECT COUNT(*) AS n FROM captured_entity").get() as { n: number };
      return { messages: m.n, contentBytes: m.bytes, entities: e.n };
    },

    close: () => db.close(),
  };
};
