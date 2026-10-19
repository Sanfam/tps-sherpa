/**
 * The bot's durable store: the current Catalog generation, its role manifest,
 * the exclusions, the monitored channels, and members' privacy preferences and
 * backfill requests (ADR-0001), and the introductions responder's state.
 * Later, the rest of the durable state the handoff names.
 *
 * Separate from the Tier 0 cache on purpose. Litestream replicates whole
 * databases, and this is the one that gets replicated; Tier 0 must not be.
 *
 * Uses Node's built-in `node:sqlite`, as `tier0-store.ts` does — no dependency.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parsePrevious, type Entity } from "./catalog.ts";
import { parseExclusions, type ExclusionEntry } from "./exclusions.ts";
import type { RoleManifestEntry, SyncOutcome } from "./ports.ts";

export const DURABLE_STORE_PATH =
  process.env["BOT_DB_PATH"] ?? resolve(import.meta.dirname, "../../.data/bot.db");

/** From the repo root, which is where the deployed bot runs. */
export const INIT_COMMAND = "node apps/bot/src/sync/init-store.ts";

export interface Generation {
  catalog: Entity[];
  roleManifest: RoleManifestEntry[];
  generatedAt: string;
}

/**
 * Tables added after the first deployed initialisation. Applied on every open,
 * after the marker check, so a deployed store gains them in place and is never
 * re-initialised for them — and a missing or unmarked store is still refused
 * before anything is created in it.
 *
 * `preference`: one row per member and setting, written only when a member
 * sets one; no row means allowed — every member starts opted in and can opt
 * out at any time (Staff, 2026-10-15). Kept through every purge and every deletion request: it is what
 * honours them (ADR-0001, erasure policy).
 *
 * `monitored_channel`: the Channels whose conversation, and whose Threads',
 * is extract-and-discard (#33). By id, so a rename cannot undo it; the name is
 * as last seen, for the human reading the list. Staff edit it with
 * `/monitored`. `seeded` records that its seed went in, so the seed reaches a
 * store initialised before the table existed and is never re-applied over a
 * list Staff have edited — an empty list after Staff removed everything is
 * theirs, not a store that was never seeded (ADR-0001's marker, per seed).
 *
 * `backfill_request`: a member who opted back in asking for their recent
 * messages to be read again (`/privacy backfill`). One row per member, until
 * the next capture that runs to the end; dropped when they opt out.
 *
 * `opted_out_name`: the username, display name and server nickname of a
 * member with processing off, and nothing else, kept only so they are
 * redacted from other members' text and refused in model output — their own
 * messages, which would otherwise carry their names into the Tier 0 cache, are
 * never stored (owner, 2026-10-16). Written when they opt out; removed when
 * they opt back in or delete their data. Members who opted out before this
 * table existed have none until they opt out again.
 *
 * `heartbeat`: one row, rewritten by the running bot (serve.ts). Litestream
 * takes no snapshot of a database that has not changed, so without it a long
 * pipeline outage would leave the replica's only snapshot to age out under the
 * bucket's lifecycle rule, and a restore would have nothing to start from.
 *
 * The introductions responder's four (design §5; read and written only through
 * `sherpa/responder-store.ts`):
 *
 * - `introduction`: one row per member evaluated, from their intro to 30 days
 *   after it, or until erased. `message_ids` is the ids that fed an
 *   extraction, as `[{id, edited_at, images_read}]`, intro first: ids only,
 *   never content. `joined_at` is the member's, from the lookup when the
 *   evaluation started (F10).
 * - `invitation`: the invited path's counts, kept 30 days from `last_at`, its
 *   last exchange (F9). No message ids: nothing here points at member content.
 * - `tombstone`: that a member was evaluated, kept indefinitely and through
 *   erasure (F3), so no member is welcomed twice within one membership; a
 *   new `joined_at` (they left and rejoined) admits them again (F10). A NULL `joined_at` is a
 *   seeded one, from the Channel's history before the first deploy (F2), and
 *   blocks for good (F10).
 * - `sherpa_setting`: Staff's mode, clock and thresholds, and the responder's
 *   own markers (`on_since`, `seed_until`, `seeded_at`), with who set each.
 *
 * `member_deny`: a member whose own Discord overwrite hides a Catalog Channel
 * or Forum from them, so Sherpa never names it to them (`deniedTo`). Discord's
 * state, not theirs: replaced whole by every complete sync, in the same
 * transaction as the Catalog, so it is never older than the last sync. It
 * never leaves the bot: not in the Catalog, an Entity or the site's snapshot.
 *
 * The alerts' two (#50; through `sherpa/alerts.ts` only): `alert_subscription`,
 * which Ambassadors and Staff are opted in to which alert, until they turn it
 * off or delete their data; and `alert_sent`, one alert per member, per event,
 * per `joined_at`, kept indefinitely and through erasure, as tombstones are
 * (D50-5). Ids and times only.
 */
const MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS preference (
    member_id  TEXT NOT NULL,
    setting    TEXT NOT NULL CHECK (setting IN ('approach', 'processing')),
    allowed    INTEGER NOT NULL CHECK (allowed IN (0, 1)),
    changed_at TEXT NOT NULL,
    PRIMARY KEY (member_id, setting)
  );
  CREATE TABLE IF NOT EXISTS monitored_channel (
    id       TEXT PRIMARY KEY,
    name     TEXT,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seeded (
    what TEXT PRIMARY KEY,
    at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS backfill_request (
    member_id    TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS opted_out_name (
    member_id TEXT NOT NULL,
    name      TEXT NOT NULL,
    PRIMARY KEY (member_id, name)
  );
  CREATE TABLE IF NOT EXISTS introduction (
    member_id   TEXT PRIMARY KEY,
    message_ids TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    joined_at   TEXT NOT NULL,
    extractions INTEGER NOT NULL DEFAULT 0,
    rebuilds    INTEGER NOT NULL DEFAULT 0,
    images_read INTEGER NOT NULL DEFAULT 0,
    posted_at   TEXT,
    outcome     TEXT CHECK (outcome IN ('responded', 'expired', 'failed')),
    reason      TEXT
  );
  CREATE TABLE IF NOT EXISTS invitation (
    member_id   TEXT PRIMARY KEY,
    exchanges   INTEGER NOT NULL DEFAULT 0,
    images_read INTEGER NOT NULL DEFAULT 0,
    last_at     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tombstone (
    member_id TEXT PRIMARY KEY,
    joined_at TEXT,
    closed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sherpa_setting (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL,
    set_by TEXT NOT NULL,
    set_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS member_deny (
    member_id TEXT NOT NULL,
    place_id  TEXT NOT NULL,
    PRIMARY KEY (member_id, place_id)
  );
  CREATE TABLE IF NOT EXISTS alert_subscription (
    member_id TEXT NOT NULL,
    event     TEXT NOT NULL CHECK (event IN ('join', 'intro')),
    set_at    TEXT NOT NULL,
    PRIMARY KEY (member_id, event)
  );
  CREATE TABLE IF NOT EXISTS alert_sent (
    member_id TEXT NOT NULL,
    event     TEXT NOT NULL CHECK (event IN ('join', 'intro')),
    joined_at TEXT NOT NULL,
    sent_at   TEXT NOT NULL,
    PRIMARY KEY (member_id, event, joined_at)
  );
`;

/**
 * The monitored-channel seed: `👋︱introductions`, by id (verified against the
 * guild 2026-10-16). Applied once per store, on its first open after #33.
 */
export const MONITORED_SEED = [{ id: "1084293546183495720", name: "👋︱introductions" }];

export interface MonitoredChannel {
  id: string;
  name: string | null;
  addedBy: string;
  addedAt: string;
}

/** A backfill request as it stood when a capture started. */
export interface BackfillRequest {
  memberId: string;
  requestedAt: string;
}

/**
 * What a member may turn off.
 *
 * - `approach`: Sherpa may message them unprompted. Nothing does yet; the
 *   introductions responder will read it.
 * - `processing`: Sherpa may read and process what they write — Tier 0
 *   capture of their messages, their words in activity summaries, and their
 *   own words (a `/find` query included) sent to a model.
 */
export const SETTINGS = ["approach", "processing"] as const;
export type Setting = (typeof SETTINGS)[number];
export type Preferences = Record<Setting, boolean>;

/**
 * The Entity is stored whole, as today's Catalog schema: that schema is the
 * data contract the snapshot carries, so a new field is not a migration.
 */
const SCHEMA = `
  CREATE TABLE entity (
    id   TEXT PRIMARY KEY,
    body TEXT NOT NULL
  );
  CREATE TABLE generation (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    generated_at  TEXT NOT NULL,
    role_manifest TEXT NOT NULL
  );
  CREATE TABLE exclusion (
    id     TEXT PRIMARY KEY,
    name   TEXT,
    reason TEXT
  );
  CREATE TABLE initialised (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    at TEXT NOT NULL
  );
  ${MIGRATIONS}
`;

/**
 * Freed pages and cells are zeroed rather than left readable in the file, so a
 * deleted row does not survive into a replica. Per connection, so every
 * connection sets it — the erasure policy depends on it.
 *
 * The busy timeout because the gateway writes preferences while a pipeline
 * step may be mid-write in another process: a member's opt-out should wait a
 * moment for the lock, not fail.
 */
const PRAGMAS = "PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;";

/**
 * The startup contract. Runs before anything reads or migrates the file, and
 * every connection to the durable store opens through it, so each one sets
 * the pragmas.
 *
 * Never falls back to empty durable state: an empty store would write every
 * summary override and exclusion away on the next sync, and look like a clean
 * run doing it.
 */
export const openDurableDatabase = (path: string = DURABLE_STORE_PATH): DatabaseSync => {
  // Checked before opening: opening a missing file creates it.
  if (!existsSync(path))
    throw new Error(
      `The bot's durable store is missing at ${path}. Refusing to start. ` +
        `For a first initialisation only, run \`${INIT_COMMAND}\`. ` +
        `Deployed, apps/bot/start.sh restores it from the replica first; see docs/runbook.md (ADR-0001).`,
    );
  const db = new DatabaseSync(path);
  const hasMarkerTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'initialised'")
    .get();
  if (!hasMarkerTable || !db.prepare("SELECT 1 FROM initialised").get()) {
    db.close();
    throw new Error(
      `The bot's durable store at ${path} has no initialisation marker, so it was ` +
        `never seeded or its initialisation did not finish. Refusing to start.`,
    );
  }
  db.exec(PRAGMAS);
  db.exec(MIGRATIONS);
  seedMonitored(db);
  return db;
};

export const openDurableStore = (path: string = DURABLE_STORE_PATH) => {
  const db = openDurableDatabase(path);
  return {
    /** The current generation, or null before the first complete sync. */
    current: (): Generation | null => {
      // One read transaction, so the manifest and the Entities are one
      // generation even if a sync replaces it between the two reads.
      db.exec("BEGIN");
      try {
        const g = db.prepare("SELECT generated_at, role_manifest FROM generation").get() as
          | { generated_at: string; role_manifest: string }
          | undefined;
        if (!g) return null;
        const rows = db.prepare("SELECT body FROM entity ORDER BY id").all() as Array<{ body: string }>;
        return {
          catalog: rows.map((r) => JSON.parse(r.body) as Entity),
          roleManifest: JSON.parse(g.role_manifest) as RoleManifestEntry[],
          generatedAt: g.generated_at,
        };
      } finally {
        db.exec("COMMIT");
      }
    },

    exclusions: (): Set<string> =>
      new Set(
        (db.prepare("SELECT id FROM exclusion").all() as Array<{ id: string }>).map((r) => r.id),
      ),

    /**
     * Replaces the current generation, atomically. Only a complete sync may:
     * an Entity missing from a partial enumeration has not been confirmed
     * removed, and replacing would drop its override with it (#28).
     *
     * ponytail: no compare here (#31 is half closed). A sync that read the
     * generation before an enrichment patched it writes over that patch; the
     * next enrichment redoes it, which costs calls, not data. `serve.ts` runs
     * the two one at a time; compare the generation the sync read if a run by
     * hand ever overlaps it for real.
     */
    replaceCatalog: (next: {
      catalog: Entity[];
      roleManifest: RoleManifestEntry[];
      outcome: SyncOutcome;
      /** `member_deny`, replaced whole. */
      memberDenies: Array<{ placeId: string; memberId: string }>;
    }) => {
      if (!next.outcome.complete)
        throw new Error("Refusing to replace the Catalog with an incomplete sync.");
      // An established Catalog is never empty. A guild that suddenly reads as
      // empty is lost permissions, and storing it would drop every override.
      if (next.catalog.length === 0)
        throw new Error("Refusing to replace the Catalog with an empty one.");
      transaction(db, () => {
        writeCatalog(db, next.catalog);
        db.prepare(
          "INSERT OR REPLACE INTO generation (id, generated_at, role_manifest) VALUES (1, ?, ?)",
        ).run(new Date().toISOString(), JSON.stringify(next.roleManifest));
        db.exec("DELETE FROM member_deny");
        const deny = db.prepare("INSERT OR IGNORE INTO member_deny (member_id, place_id) VALUES (?, ?)");
        for (const d of next.memberDenies) deny.run(d.memberId, d.placeId);
      });
    },

    /** The Channels and Forums a member's own overwrite hides from them (`member_deny`). */
    deniedPlaces: (memberId: string): Set<string> =>
      new Set(
        (
          db.prepare("SELECT place_id FROM member_deny WHERE member_id = ?").all(memberId) as Array<{
            place_id: string;
          }>
        ).map((r) => r.place_id),
      ),

    /**
     * Writes fields an enrichment pass produced onto Entities that still
     * exist, leaving everything else — overrides above all — as stored. Not
     * a new generation: nothing was read from Discord.
     *
     * Only onto the generation the pass read (`generatedAt`), compared inside
     * the write transaction (#31). A sync that replaced it since may have
     * renamed an Entity or changed its first post, and a summary or Topics
     * computed for the old one must not land on the new. Refused whole: the
     * pass re-runs against the new generation, which costs calls, not data.
     * `serve.ts` already runs the two one at a time; this is what holds when a
     * run by hand overlaps it.
     */
    patchEntities: (generatedAt: string, patches: Array<Pick<Entity, "id"> & Partial<Entity>>) => {
      const read = db.prepare("SELECT body FROM entity WHERE id = ?");
      const write = db.prepare("UPDATE entity SET body = ? WHERE id = ?");
      transaction(
        db,
        () => {
          const current = db.prepare("SELECT generated_at FROM generation").get() as
            | { generated_at: string }
            | undefined;
          if (current?.generated_at !== generatedAt)
            throw new GenerationChanged(generatedAt, current?.generated_at ?? null);
          for (const patch of patches) {
            const row = read.get(patch.id) as { body: string } | undefined;
            if (row) write.run(JSON.stringify({ ...JSON.parse(row.body), ...patch }), patch.id);
          }
        },
        "IMMEDIATE",
      );
    },

    /** A member's settings. Anything they never set is allowed. */
    preferences: (memberId: string): Preferences => {
      const rows = db
        .prepare("SELECT setting, allowed FROM preference WHERE member_id = ?")
        .all(memberId) as Array<{ setting: Setting; allowed: number }>;
      const set = new Map(rows.map((r) => [r.setting, r.allowed === 1]));
      return { approach: set.get("approach") ?? true, processing: set.get("processing") ?? true };
    },

    /**
     * Records a setting. Its time moves only when its value does. Turning
     * processing off drops a pending backfill with it: nothing of theirs may
     * be read.
     *
     * Any change to processing replaces the member's kept names with `names`:
     * the ones an opt-out carries, none on opting back in, none on a deletion
     * request (`opted_out_name`).
     */
    setPreference: (memberId: string, setting: Setting, allowed: boolean, names: string[] = []) => {
      transaction(db, () => {
        db.prepare(
          `INSERT INTO preference (member_id, setting, allowed, changed_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (member_id, setting) DO UPDATE
             SET allowed = excluded.allowed, changed_at = excluded.changed_at
             WHERE allowed != excluded.allowed`,
        ).run(memberId, setting, allowed ? 1 : 0, new Date().toISOString());
        if (setting !== "processing") return;
        db.prepare("DELETE FROM opted_out_name WHERE member_id = ?").run(memberId);
        if (allowed) return;
        db.prepare("DELETE FROM backfill_request WHERE member_id = ?").run(memberId);
        const keep = db.prepare("INSERT OR IGNORE INTO opted_out_name (member_id, name) VALUES (?, ?)");
        for (const name of names) keep.run(memberId, name);
      });
    },

    /** Names kept for members with processing off, for the boundary. */
    optedOutNames: (): string[] =>
      (db.prepare("SELECT DISTINCT name FROM opted_out_name").all() as Array<{ name: string }>).map((r) => r.name),

    /** Every member who has turned processing off. */
    processingOptOuts: (): Set<string> =>
      new Set(
        (
          db
            .prepare("SELECT member_id FROM preference WHERE setting = 'processing' AND allowed = 0")
            .all() as Array<{ member_id: string }>
        ).map((r) => r.member_id),
      ),

    /** Records a backfill request. False if one was already pending: a no-op. */
    requestBackfill: (memberId: string): boolean =>
      db
        .prepare("INSERT OR IGNORE INTO backfill_request (member_id, requested_at) VALUES (?, ?)")
        .run(memberId, new Date().toISOString()).changes > 0,

    pendingBackfills: (): BackfillRequest[] =>
      (
        db.prepare("SELECT member_id, requested_at FROM backfill_request").all() as Array<{
          member_id: string;
          requested_at: string;
        }>
      ).map((r) => ({ memberId: r.member_id, requestedAt: r.requested_at })),

    /**
     * Clears the requests a capture read at its start, and only those: a
     * member who opted out and asked again since has a newer request, which
     * that capture may not have honoured.
     */
    clearBackfills: (served: BackfillRequest[]) => {
      const clear = db.prepare("DELETE FROM backfill_request WHERE member_id = ? AND requested_at = ?");
      transaction(db, () => {
        for (const r of served) clear.run(r.memberId, r.requestedAt);
      });
    },

    monitoredChannels: (): MonitoredChannel[] =>
      (
        db.prepare("SELECT id, name, added_by, added_at FROM monitored_channel ORDER BY added_at, id").all() as Array<{
          id: string;
          name: string | null;
          added_by: string;
          added_at: string;
        }>
      ).map((r) => ({ id: r.id, name: r.name, addedBy: r.added_by, addedAt: r.added_at })),

    /** False if it was already monitored; who added it first is kept. */
    addMonitored: (id: string, name: string, addedBy: string): boolean =>
      db
        .prepare("INSERT OR IGNORE INTO monitored_channel (id, name, added_by, added_at) VALUES (?, ?, ?, ?)")
        .run(id, name, addedBy, new Date().toISOString()).changes > 0,

    /** False if it was not monitored. */
    removeMonitored: (id: string): boolean =>
      db.prepare("DELETE FROM monitored_channel WHERE id = ?").run(id).changes > 0,

    /** Rewrites the heartbeat row, so the store changes and Litestream snapshots it. */
    beat: (at: Date = new Date()) => {
      db.prepare("INSERT OR REPLACE INTO heartbeat (id, at) VALUES (1, ?)").run(at.toISOString());
    },

    close: () => db.close(),
  };
};

/** Thrown by `patchEntities` when a sync replaced the generation the pass read. */
export class GenerationChanged extends Error {
  constructor(read: string, current: string | null) {
    super(
      `The Catalog changed under this run (it read the generation of ${read}; the current one is ` +
        `${current ?? "none"}). Nothing was written; re-run.`,
    );
  }
}

export type DurableStore = ReturnType<typeof openDurableStore>;

/** Opens the store for one piece of work and closes it again, whatever happens. */
export const withDurableStore = <T>(
  work: (store: DurableStore) => T,
  path: string = DURABLE_STORE_PATH,
): T => {
  const store = openDurableStore(path);
  try {
    return work(store);
  } finally {
    store.close();
  }
};

/** Opens the store, reads the current generation, and closes it again. */
export const readCurrent = (path: string = DURABLE_STORE_PATH): Generation =>
  withDurableStore((store) => {
    const current = store.current();
    if (!current)
      throw new Error("The durable store holds no Catalog yet. Run a sync first.");
    return current;
  }, path);

/**
 * Who has turned processing off, read fresh. Every path that stores or sends
 * a member's words reads this: capture, the purge, and every boundary.
 */
export const readProcessingOptOuts = (path: string = DURABLE_STORE_PATH): Set<string> =>
  withDurableStore((store) => store.processingOptOuts(), path);

/**
 * One member's denied places, read fresh, for `deniedTo`. Whatever names a
 * place to a member reads this: `/find` and `/lately`, and the responder.
 */
export const readDeniedPlaces = (memberId: string, path: string = DURABLE_STORE_PATH): ReadonlySet<string> =>
  withDurableStore((store) => store.deniedPlaces(memberId), path);

/**
 * The monitored-channel ids, checked against the Catalog they will be applied
 * to. Every step that stores conversation or sends anything to a model reads
 * them through here.
 *
 * Fails closed (#33): an id missing from the Catalog — the Channel deleted,
 * hidden from the bot, excluded, or mistyped — means the Threads it should
 * cover cannot be placed under it, so the carve-out cannot be vouched for.
 * Capture, enrichment and `/find` refuse until Staff fix the list or the
 * Channel comes back. The sync, which is what brings it back, reads the ids unchecked.
 */
export const readMonitored = (catalog: Entity[], path: string = DURABLE_STORE_PATH): ReadonlySet<string> => {
  const ids = readMonitoredIds(path);
  const known = new Set(catalog.map((e) => e.id));
  const missing = [...ids].filter((id) => !known.has(id));
  if (missing.length)
    throw new Error(
      `Monitored channel ${missing.join(", ")} is not in the current Catalog, so its Threads cannot be ` +
        "placed and the monitored-channel carve-out cannot be honoured. Refusing to run. If the Channel " +
        "was deleted, hidden from the bot or excluded, Staff remove it with `/monitored remove`, or restore it.",
    );
  return ids;
};

/** The configured ids as stored, unchecked. Only for taking things away — the purge. */
export const readMonitoredIds = (path: string = DURABLE_STORE_PATH): ReadonlySet<string> =>
  new Set(withDurableStore((s) => s.monitoredChannels().map((c) => c.id), path));

/**
 * First initialisation: the ADR's explicit first-run flag, as a one-off
 * command rather than an environment variable that can be left set.
 *
 * One transaction creates the schema, imports the exclusion seed and any
 * local Catalog, and writes the marker last. It is built beside the target
 * and renamed into place only once committed, so neither a failure nor a
 * crash part-way leaves a half-seeded store at the path; the next attempt
 * clears whatever a crashed one left behind.
 */
export const initDurableStore = (
  path: string,
  sources: {
    /** `content/config/index-flags.json`. Null means exclude nothing. */
    exclusionSeed: string | null;
    /** A local `content/index/data.json`, migrated once. Null if there is none. */
    catalog: string | null;
    /** Its role manifest, if one was written beside it. */
    roleManifest: string | null;
    /** When that Catalog was generated, as near as is known. */
    catalogGeneratedAt?: string;
  },
): { exclusions: number; entities: number } => {
  if (existsSync(path))
    throw new Error(
      `${path} already exists. Refusing to initialise over it: the seed is never ` +
        `re-applied over restored or Staff-edited data.`,
    );
  mkdirSync(dirname(path), { recursive: true });
  const building = `${path}.init`;
  removeDatabase(building);
  const db = new DatabaseSync(building);
  try {
    db.exec(PRAGMAS);
    const counts = { exclusions: 0, entities: 0 };
    transaction(db, () => {
      db.exec(SCHEMA);
      // Validated by the sync's own parser, then stored with the labels a
      // human wrote, which the parser does not keep.
      const ids = parseExclusions(sources.exclusionSeed);
      const entries = sources.exclusionSeed
        ? ((JSON.parse(sources.exclusionSeed) as { exclude: ExclusionEntry[] }).exclude)
        : [];
      const insert = db.prepare("INSERT OR REPLACE INTO exclusion (id, name, reason) VALUES (?, ?, ?)");
      for (const e of entries) insert.run(e.id, e.name ?? null, e.reason ?? null);
      counts.exclusions = ids.size;

      if (sources.catalog !== null) {
        const catalog = parsePrevious(sources.catalog);
        const roles: unknown = JSON.parse(sources.roleManifest ?? "[]");
        if (
          !Array.isArray(roles) ||
          !roles.every(
            (r) =>
              typeof r?.name === "string" &&
              Array.isArray(r.ids) &&
              r.ids.every((id: unknown) => typeof id === "string"),
          )
        )
          throw new Error("The role manifest is not a list of roles.");
        writeCatalog(db, catalog);
        db.prepare(
          "INSERT INTO generation (id, generated_at, role_manifest) VALUES (1, ?, ?)",
        ).run(sources.catalogGeneratedAt ?? new Date().toISOString(), JSON.stringify(roles));
        counts.entities = catalog.length;
      }

      db.prepare("INSERT INTO initialised (id, at) VALUES (1, ?)").run(new Date().toISOString());
    });
    // Closing the last connection checkpoints and removes the WAL, so the
    // database is one file by the time it moves.
    db.close();
    renameSync(building, path);
    return counts;
  } catch (error) {
    if (db.isOpen) db.close();
    removeDatabase(building);
    throw error;
  }
};

const removeDatabase = (path: string) => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
};

const writeCatalog = (db: DatabaseSync, catalog: Entity[]) => {
  db.exec("DELETE FROM entity");
  const insert = db.prepare("INSERT INTO entity (id, body) VALUES (?, ?)");
  for (const e of catalog) insert.run(e.id, JSON.stringify(e));
};

/**
 * The monitored-channel seed, once per store. Checked again inside an
 * immediate transaction, so two processes opening the store at once cannot
 * both apply it.
 */
const seedMonitored = (db: DatabaseSync) => {
  const done = () => db.prepare("SELECT 1 FROM seeded WHERE what = 'monitored_channel'").get();
  if (done()) return;
  transaction(
    db,
    () => {
      if (done()) return;
      const at = new Date().toISOString();
      const insert = db.prepare(
        "INSERT OR IGNORE INTO monitored_channel (id, name, added_by, added_at) VALUES (?, ?, 'seed', ?)",
      );
      for (const c of MONITORED_SEED) insert.run(c.id, c.name, at);
      db.prepare("INSERT INTO seeded (what, at) VALUES ('monitored_channel', ?)").run(at);
    },
    "IMMEDIATE",
  );
};

/** `IMMEDIATE` takes the write lock up front, for a write that depends on what it read. */
export const transaction = <T>(
  db: DatabaseSync,
  work: () => T,
  mode: "DEFERRED" | "IMMEDIATE" = "DEFERRED",
): T => {
  db.exec(`BEGIN ${mode}`);
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
