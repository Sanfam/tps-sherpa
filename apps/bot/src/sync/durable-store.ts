/**
 * The bot's durable store: the current Catalog generation, its role manifest,
 * the exclusions, and members' privacy preferences (ADR-0001). Later, the rest
 * of the durable state the handoff names.
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

export const INIT_COMMAND = "node src/sync/init-store.ts";

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
 */
const MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS preference (
    member_id  TEXT NOT NULL,
    setting    TEXT NOT NULL CHECK (setting IN ('approach', 'processing')),
    allowed    INTEGER NOT NULL CHECK (allowed IN (0, 1)),
    changed_at TEXT NOT NULL,
    PRIMARY KEY (member_id, setting)
  );
`;

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
 * The startup contract. Runs before anything reads or migrates the file.
 *
 * Never falls back to empty durable state: an empty store would write every
 * summary override and exclusion away on the next sync, and look like a clean
 * run doing it.
 */
export const openDurableStore = (path: string = DURABLE_STORE_PATH) => {
  // Checked before opening: opening a missing file creates it.
  if (!existsSync(path))
    throw new Error(
      `The bot's durable store is missing at ${path}. Refusing to start. ` +
        `For a first initialisation only, run \`${INIT_COMMAND}\`. ` +
        `Restore from a replica is not wired yet (ADR-0001).`,
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
     */
    replaceCatalog: (next: {
      catalog: Entity[];
      roleManifest: RoleManifestEntry[];
      outcome: SyncOutcome;
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
      });
    },

    /**
     * Writes fields an enrichment pass produced onto Entities that still
     * exist, leaving everything else — overrides above all — as stored. Not
     * a new generation: nothing was read from Discord.
     */
    // ponytail: sync and enrichment are separate commands and nothing
    // serialises them. A sync that replaces the generation mid-enrichment
    // loses that run's output, and enrichment can patch a stale result onto an
    // Entity whose identity has since changed. Safe while both are run by
    // hand, one at a time; serialise them before either is scheduled (#31).
    patchEntities: (patches: Array<Pick<Entity, "id"> & Partial<Entity>>) => {
      const read = db.prepare("SELECT body FROM entity WHERE id = ?");
      const write = db.prepare("UPDATE entity SET body = ? WHERE id = ?");
      transaction(db, () => {
        for (const patch of patches) {
          const row = read.get(patch.id) as { body: string } | undefined;
          if (row) write.run(JSON.stringify({ ...JSON.parse(row.body), ...patch }), patch.id);
        }
      });
    },

    /** A member's settings. Anything they never set is allowed. */
    preferences: (memberId: string): Preferences => {
      const rows = db
        .prepare("SELECT setting, allowed FROM preference WHERE member_id = ?")
        .all(memberId) as Array<{ setting: Setting; allowed: number }>;
      const set = new Map(rows.map((r) => [r.setting, r.allowed === 1]));
      return { approach: set.get("approach") ?? true, processing: set.get("processing") ?? true };
    },

    /** Records a setting. Its time moves only when its value does. */
    setPreference: (memberId: string, setting: Setting, allowed: boolean) => {
      db.prepare(
        `INSERT INTO preference (member_id, setting, allowed, changed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (member_id, setting) DO UPDATE
           SET allowed = excluded.allowed, changed_at = excluded.changed_at
           WHERE allowed != excluded.allowed`,
      ).run(memberId, setting, allowed ? 1 : 0, new Date().toISOString());
    },

    /** Every member who has turned processing off. */
    processingOptOuts: (): Set<string> =>
      new Set(
        (
          db
            .prepare("SELECT member_id FROM preference WHERE setting = 'processing' AND allowed = 0")
            .all() as Array<{ member_id: string }>
        ).map((r) => r.member_id),
      ),

    close: () => db.close(),
  };
};

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

const transaction = (db: DatabaseSync, work: () => void) => {
  db.exec("BEGIN");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
