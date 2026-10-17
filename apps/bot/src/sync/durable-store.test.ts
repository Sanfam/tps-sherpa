import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.ts";
import { GenerationChanged, MONITORED_SEED, initDurableStore, openDurableStore, readMonitored } from "./durable-store.ts";
import { fixtureDiscord } from "./fixture-discord.ts";
import { ChannelType } from "./ports.ts";

const GUILD_ID = "1088552078709891240";
const seed = JSON.stringify({ exclude: [{ id: "999", name: "bot-tests", reason: "testing" }] });

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "durable-store-"));
  path = join(dir, "bot.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const guild = {
  channels: [
    { id: "100", name: "general", type: ChannelType.GuildText, topic: "Chat" },
    { id: "200", name: "games", type: ChannelType.GuildForum, topic: "Games" },
  ],
  threads: [
    { id: "201", name: "Rocket League", parentId: "200", appliedTags: [], firstPost: "Cars" },
  ],
};
const sync = (discord = fixtureDiscord(guild), previous?: ReturnType<typeof readCatalog>) =>
  buildCatalog({ discord, guildId: GUILD_ID, previous });
const readCatalog = () => {
  const store = openDurableStore(path);
  const catalog = store.current()?.catalog ?? [];
  store.close();
  return catalog;
};

/** A store holding one complete generation, with a Staff override on a Post. */
const established = async () => {
  const { catalog } = await sync();
  const withOverride = catalog.map((e) =>
    e.id === "201" ? { ...e, summary_override: "Staff wrote this" } : e,
  );
  initDurableStore(path, {
    exclusionSeed: seed,
    catalog: JSON.stringify(withOverride),
    roleManifest: "[]",
  });
  return withOverride;
};

describe("the startup contract", () => {
  it("refuses a missing store, names the init command, and creates nothing", () => {
    expect(() => openDurableStore(path)).toThrow(/missing.*init-store\.ts.*not wired yet/s);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a store that has no initialisation marker", () => {
    new DatabaseSync(path).close();
    expect(() => openDurableStore(path)).toThrow(/no initialisation marker/);
  });

  it("opens an initialised store, empty on purpose until the first sync", () => {
    initDurableStore(path, { exclusionSeed: seed, catalog: null, roleManifest: null });
    const store = openDurableStore(path);
    expect(store.current()).toBeNull();
    expect(store.exclusions()).toEqual(new Set(["999"]));
    store.close();
  });
});

describe("first initialisation", () => {
  it("refuses a file that already exists, and leaves it alone", () => {
    writeFileSync(path, "restored data");
    expect(() =>
      initDurableStore(path, { exclusionSeed: seed, catalog: null, roleManifest: null }),
    ).toThrow(/already exists/);
    expect(readFileSync(path, "utf8")).toBe("restored data");
  });

  it("leaves no store behind when the Catalog import is invalid, so a retry works", async () => {
    // Valid seed, then a bad Catalog: the seed must not be left committed.
    const bad = JSON.stringify([{ id: "1", summary_override: {} }]);
    expect(() =>
      initDurableStore(path, { exclusionSeed: seed, catalog: bad, roleManifest: "[]" }),
    ).toThrow(/not a list of Entities/);
    expect(existsSync(path)).toBe(false);

    const imported = await established();
    expect(readCatalog()).toEqual(imported);
  });

  it("refuses a role manifest that is not a list of roles, leaving no store", async () => {
    const { catalog } = await sync();
    expect(() =>
      initDurableStore(path, {
        exclusionSeed: seed,
        catalog: JSON.stringify(catalog),
        roleManifest: JSON.stringify([{ name: "Staff" }]),
      }),
    ).toThrow(/not a list of roles/);
    expect(existsSync(path)).toBe(false);
  });

  it("clears what a crashed attempt left behind, rather than refusing the retry", async () => {
    writeFileSync(`${path}.init`, "half-written");
    await established();
    expect(existsSync(`${path}.init`)).toBe(false);
    expect(readCatalog().map((e) => e.id)).toContain("201");
  });

  it("migrates a local Catalog with its overrides and summaries intact", async () => {
    const imported = await established();
    expect(readCatalog().find((e) => e.id === "201")?.summary_override).toBe("Staff wrote this");
    expect(readCatalog()).toEqual(imported);
  });
});

describe("replacing the Catalog", () => {
  it("keeps the previous generation and its overrides when the sync is incomplete", async () => {
    const before = await established();
    // The Forum's archived Posts were denied: 201 is missing, not removed.
    const fixture = fixtureDiscord(guild);
    const partial = await sync(
      {
        ...fixture,
        listThreads: async () => ({ threads: [], failed: [{ id: "200", reason: "50001" }] }),
      },
      before,
    );
    expect(partial.outcome).toEqual({ complete: false, failed: [{ id: "200", reason: "50001" }] });

    const store = openDurableStore(path);
    expect(() => store.replaceCatalog(partial)).toThrow(/incomplete/);
    store.close();
    expect(readCatalog()).toEqual(before);
  });

  it("replaces it on a complete sync, carrying the override forward", async () => {
    const before = await established();
    const next = await sync(fixtureDiscord(guild), before);
    expect(next.outcome).toEqual({ complete: true });

    const store = openDurableStore(path);
    store.replaceCatalog(next);
    store.close();
    expect(readCatalog().find((e) => e.id === "201")?.summary_override).toBe("Staff wrote this");
  });

  it("refuses an empty Catalog, which would drop every override", async () => {
    await established();
    const store = openDurableStore(path);
    expect(() =>
      store.replaceCatalog({ catalog: [], roleManifest: [], outcome: { complete: true } }),
    ).toThrow(/empty/);
    store.close();
    expect(readCatalog()).toHaveLength(3);
  });

  it("zeroes a removed Entity's bytes in the file, not just its row (secure_delete)", async () => {
    await established();
    const secret = "ERASE-ME-0xC0FFEE";
    const store = openDurableStore(path);
    const { catalog } = await sync();
    store.replaceCatalog({
      catalog: [...catalog, { ...catalog[0]!, id: "300", name: secret }],
      roleManifest: [],
      outcome: { complete: true },
    });
    store.close();
    expect(readFileSync(path).includes(secret)).toBe(true);

    const again = openDurableStore(path);
    again.replaceCatalog({ catalog, roleManifest: [], outcome: { complete: true } });
    again.close();
    // Closing the last connection checkpoints the WAL into the file.
    expect(readFileSync(path).includes(secret)).toBe(false);
  });
});

describe("enrichment writes", () => {
  it("patches only the fields given, leaving a Staff override in place", async () => {
    await established();
    const store = openDurableStore(path);
    const { generatedAt } = store.current()!;
    store.patchEntities(generatedAt, [{ id: "201", summary_generated: "A Post about cars." }, { id: "gone" }]);
    store.close();
    expect(readCatalog().find((e) => e.id === "201")).toMatchObject({
      summary_generated: "A Post about cars.",
      summary_override: "Staff wrote this",
    });
    expect(readCatalog()).toHaveLength(3);
  });
});

/**
 * Sync and enrichment on two connections to one file, as two processes would
 * be (#31). The sync's replace is what `run.ts` does; the enrichment reads a
 * generation, works, then patches.
 */
describe("sync and enrichment interleaved", () => {
  const renamed = async () =>
    (await sync(fixtureDiscord({ ...guild, threads: [{ ...guild.threads[0]!, name: "Rocket League 2" }] }))).catalog;

  it("refuses a patch when a sync replaced the generation after enrichment read it, writing nothing", async () => {
    await established();
    const enrichment = openDurableStore(path);
    const syncing = openDurableStore(path);
    const read = enrichment.current()!;
    await new Promise((r) => setTimeout(r, 2)); // a later generated_at
    syncing.replaceCatalog({ catalog: read.catalog, roleManifest: [], outcome: { complete: true } });
    expect(() =>
      enrichment.patchEntities(read.generatedAt, [{ id: "100", summary_generated: "stale" }]),
    ).toThrow(GenerationChanged);
    enrichment.close();
    syncing.close();
    expect(readCatalog().find((e) => e.id === "100")!.summary_generated).toBeNull();
  });

  it("lets a sync after a patch win cleanly, and a second patch from the old read is refused", async () => {
    await established();
    const enrichment = openDurableStore(path);
    const syncing = openDurableStore(path);
    const read = enrichment.current()!;
    enrichment.patchEntities(read.generatedAt, [{ id: "100", summary_generated: "fresh" }]);
    await new Promise((r) => setTimeout(r, 2));
    const next = await renamed();
    syncing.replaceCatalog({ catalog: next, roleManifest: [], outcome: { complete: true } });
    expect(readCatalog()).toEqual(next);
    expect(() => enrichment.patchEntities(read.generatedAt, [{ id: "100", summary_generated: "x" }])).toThrow(
      /changed under this run/,
    );
    enrichment.close();
    syncing.close();
  });

  it("never patches a renamed Entity with a result computed for its old name", async () => {
    await established();
    const enrichment = openDurableStore(path);
    const syncing = openDurableStore(path);
    const read = enrichment.current()!;
    await new Promise((r) => setTimeout(r, 2));
    syncing.replaceCatalog({ catalog: await renamed(), roleManifest: [], outcome: { complete: true } });
    expect(() =>
      enrichment.patchEntities(read.generatedAt, [{ id: "201", summary_generated: "About Rocket League." }]),
    ).toThrow(GenerationChanged);
    enrichment.close();
    syncing.close();
    expect(readCatalog().find((e) => e.id === "201")).toMatchObject({
      name: "Rocket League 2",
      summary_generated: null,
    });
  });
});

describe("monitored channels", () => {
  const ids = () => {
    const store = openDurableStore(path);
    const list = store.monitoredChannels().map((c) => c.id);
    store.close();
    return list;
  };

  it("are seeded once, into a store initialised before the table existed", async () => {
    await established();
    // As the deployed store was: initialised, marked, without #33's tables.
    const old = new DatabaseSync(path);
    old.exec("DROP TABLE monitored_channel; DROP TABLE seeded;");
    old.close();
    expect(ids()).toEqual(MONITORED_SEED.map((c) => c.id));
  });

  it("are never re-seeded after Staff removed everything", async () => {
    await established();
    const store = openDurableStore(path);
    for (const c of MONITORED_SEED) store.removeMonitored(c.id);
    store.close();
    expect(ids()).toEqual([]);
  });

  it("refuse, naming the id, when one is missing from the Catalog — and are ids only", async () => {
    const catalog = await established();
    expect(() => readMonitored(catalog, path)).toThrow(new RegExp(`${MONITORED_SEED[0]!.id} is not in the current Catalog`));
    const store = openDurableStore(path);
    for (const c of MONITORED_SEED) store.removeMonitored(c.id);
    store.addMonitored("200", "games", "staff");
    store.close();
    expect([...readMonitored(catalog, path)]).toEqual(["200"]);
  });
});

describe("backfill requests", () => {
  it("clears only the requests a capture read at its start", async () => {
    await established();
    const store = openDurableStore(path);
    store.requestBackfill("a");
    store.requestBackfill("b");
    const atStart = store.pendingBackfills();
    // Mid-run: b opts out and asks again, so b's new request was not served.
    store.setPreference("b", "processing", false);
    store.setPreference("b", "processing", true);
    await new Promise((r) => setTimeout(r, 2));
    store.requestBackfill("b");
    store.clearBackfills(atStart);
    expect(store.pendingBackfills().map((r) => r.memberId)).toEqual(["b"]);
    store.close();
  });
});

describe("privacy preferences", () => {
  const MEMBER = "500000000000000001";
  const fresh = () => {
    initDurableStore(path, { exclusionSeed: null, catalog: null, roleManifest: null });
    return openDurableStore(path);
  };
  const changedAt = () => {
    const db = new DatabaseSync(path);
    const row = db.prepare("SELECT changed_at FROM preference").get() as { changed_at: string };
    db.close();
    return row.changed_at;
  };

  it("allows both settings for a member who has never chosen", () => {
    const store = fresh();
    expect(store.preferences(MEMBER)).toEqual({ approach: true, processing: true });
    expect(store.processingOptOuts()).toEqual(new Set());
    store.close();
  });

  it("records a change, and when it was made only when the value moves", () => {
    const store = fresh();
    store.setPreference(MEMBER, "processing", false);
    expect(store.preferences(MEMBER)).toEqual({ approach: true, processing: false });
    expect(store.processingOptOuts()).toEqual(new Set([MEMBER]));
    const first = changedAt();
    // An opt-out repeated is not a new choice.
    const db = new DatabaseSync(path);
    db.exec("UPDATE preference SET changed_at = '2000-01-01T00:00:00.000Z'");
    db.close();
    store.setPreference(MEMBER, "processing", false);
    expect(changedAt()).toBe("2000-01-01T00:00:00.000Z");
    store.setPreference(MEMBER, "processing", true);
    expect(changedAt()).not.toBe("2000-01-01T00:00:00.000Z");
    expect(first).toMatch(/^\d{4}-/);
    expect(store.processingOptOuts()).toEqual(new Set());
    store.close();
  });

  it("adds the table to a store initialised before it existed", () => {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE entity (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE generation (id INTEGER PRIMARY KEY CHECK (id = 1), generated_at TEXT NOT NULL, role_manifest TEXT NOT NULL);
      CREATE TABLE exclusion (id TEXT PRIMARY KEY, name TEXT, reason TEXT);
      CREATE TABLE initialised (id INTEGER PRIMARY KEY CHECK (id = 1), at TEXT NOT NULL);
      INSERT INTO exclusion VALUES ('999', 'bot-tests', 'testing');
      INSERT INTO initialised VALUES (1, '2026-10-14T00:00:00.000Z');
    `);
    db.close();
    const store = openDurableStore(path);
    store.setPreference(MEMBER, "approach", false);
    expect(store.preferences(MEMBER)).toEqual({ approach: false, processing: true });
    expect(store.exclusions()).toEqual(new Set(["999"]));
    store.close();
  });

  it("migrates nothing in a store it refuses", () => {
    new DatabaseSync(path).close();
    expect(() => openDurableStore(path)).toThrow(/no initialisation marker/);
    const db = new DatabaseSync(path);
    expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
    db.close();
  });
});
