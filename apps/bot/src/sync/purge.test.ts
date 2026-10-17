import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Entity } from "./catalog.ts";
import { initDurableStore, withDurableStore } from "./durable-store.ts";
import { purgeActivity, purgeMonitored, purgeTier0, runPurge, snowflakeTime } from "./purge.ts";
import { captureEach, selectForCapture } from "./tier0.ts";
import { RETAIN_MS, openTier0, type StoredMessage } from "./tier0-store.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const msg = (entityId: string, messageId: string, authorId = "a1", createdAt = ago(DAY_MS)): StoredMessage => ({
  entityId,
  messageId,
  authorId,
  authorIsBot: false,
  content: "text",
  createdAt,
  window: "head",
});

const entity = (id: string): Entity => ({
  id,
  type: "post",
  name: id,
  url: `https://discord.com/channels/1/${id}`,
  parent_id: null,
  description_status: "present",
  topic: null,
  applied_tags: [],
  region: [],
  topics: [],
  topics_version: null,
  thread_state: "open",
  last_message_id: "1",
  last_activity_at: null,
  summary_generated: null,
  summary_override: null,
});

/** A snowflake minted `days` before NOW. */
const minted = (days: number) => String(BigInt(NOW.getTime() - days * 86_400_000 - 1_420_070_400_000) << 22n);
const entry = { summary: "s", as_of: minted(1), authors: ["a1"] };

afterEach(() => vi.useRealTimers());

describe("purgeMonitored", () => {
  it("drops what was captured from a channel Staff since monitored, its Threads, and their authors' names", () => {
    const tier0 = openTier0(":memory:");
    tier0.record("intro", "1", [{ ...msg("intro", "m1", "a1"), authorNames: ["Jughfer"] }]);
    tier0.record("thread", "1", [msg("thread", "m2", "a2")]);
    tier0.record("other", "1", [msg("other", "m3", "a3")]);
    const catalog = [entity("intro"), { ...entity("thread"), parent_id: "intro" }, entity("other")];

    const result = purgeMonitored({ tier0, monitored: new Set(["intro"]), catalog });

    expect(result.dropped).toBe(2);
    expect(tier0.stats().messages).toBe(1);
    expect(tier0.messagesFor("other")).toHaveLength(1);
    expect(tier0.memberNames()).toEqual([]);
    // Cursors go too, so a channel no longer monitored is captured afresh.
    expect([...tier0.state().keys()]).toEqual(["other"]);
    tier0.close();
  });
});

describe("purgeTier0", () => {
  it("drops what was written more than RETAIN_MS ago, and keeps the cursor", () => {
    const tier0 = openTier0(":memory:");
    tier0.record("e1", "1", [
      msg("e1", "old", "a1", ago(RETAIN_MS + 60_000)),
      msg("e1", "young", "a1", ago(RETAIN_MS - 60_000)),
    ]);

    const result = purgeTier0({ tier0, optedOut: new Set(), now: NOW });

    expect(result.aged).toBe(1);
    expect(tier0.messagesFor("e1").map((m) => m.messageId)).toEqual(["young"]);
    expect(tier0.state().has("e1")).toBe(true);
    tier0.close();
  });

  it("sweeps every message from a member with processing off", () => {
    const tier0 = openTier0(":memory:");
    tier0.record("e1", "1", [msg("e1", "m1", "out"), msg("e1", "m2", "in")]);
    tier0.record("e2", "1", [msg("e2", "m3", "out")]);

    const result = purgeTier0({ tier0, optedOut: new Set(["out"]), now: NOW });

    expect(result.swept).toBe(2);
    expect(tier0.authoredIn("out")).toEqual([]);
    expect(tier0.stats().messages).toBe(1);
    tier0.close();
  });
});

describe("purgeActivity", () => {
  it("drops entries for Entities gone or withheld, and checks no Entities without a Catalog", () => {
    const activity = { kept: entry, gone: entry, hidden: entry };
    const catalog = [entity("kept"), { ...entity("hidden"), description_status: "withheld" } as Entity];

    const pruned = purgeActivity(activity, new Set(), catalog, NOW, new Set());
    expect(Object.keys(pruned.activity)).toEqual(["kept"]);
    expect(pruned.dropped).toBe(2);

    expect(purgeActivity(activity, new Set(), null, NOW, new Set())).toEqual({ activity, dropped: 0 });
  });

  it("drops entries an opted-out member fed, and entries with no recorded authors", () => {
    const activity = {
      theirs: { ...entry, authors: ["a1", "out"] },
      others: { ...entry, authors: ["a1"] },
      unknown: { summary: "s", as_of: minted(1) },
    };
    expect(Object.keys(purgeActivity(activity, new Set(["out"]), null, NOW, new Set()).activity)).toEqual(["others"]);
  });

  it("expires entries older than /lately's window, so their authors go with them", () => {
    expect(snowflakeTime(minted(3))).toBe(NOW.getTime() - 3 * 86_400_000);
    const activity = { fresh: { ...entry, as_of: minted(13) }, stale: { ...entry, as_of: minted(15) }, junk: { ...entry, as_of: "x" } };
    const pruned = purgeActivity(activity, new Set(), null, NOW, new Set());
    expect(Object.keys(pruned.activity)).toEqual(["fresh"]);
    expect(pruned.dropped).toBe(2);
  });
});

describe("runPurge", () => {
  it("deletes raw text first, so a corrupt activity.json fails the purge without keeping any", () => {
    const dir = mkdtempSync(join(tmpdir(), "purge-"));
    const paths = { durable: join(dir, "bot.db"), tier0: join(dir, "tier0.db"), activity: join(dir, "activity.json") };
    initDurableStore(paths.durable, { exclusionSeed: null, catalog: null, roleManifest: null });
    withDurableStore((s) => s.setPreference("out", "processing", false), paths.durable);
    writeFileSync(paths.activity, "{ not json");

    const tier0 = openTier0(paths.tier0);
    tier0.record("old", "1", [{ ...msg("old", "m1", "a1", ago(RETAIN_MS + 60_000)), content: "distinctive-aged-text" }]);
    tier0.record("e1", "1", [{ ...msg("e1", "m2", "out"), content: "distinctive-opted-out-text" }, msg("e1", "m3")]);
    // Held open, as a capture or the gateway would: closing does not checkpoint for it.
    expect(() => runPurge(() => {}, paths, NOW)).toThrow(/JSON/);

    expect(tier0.messagesFor("old")).toEqual([]);
    expect(tier0.authoredIn("out")).toEqual([]);
    // Neither in the file nor left in its write-ahead log.
    for (const file of [paths.tier0, `${paths.tier0}-wal`]) {
      const bytes = readFileSync(file);
      expect(bytes.includes("distinctive-aged-text")).toBe(false);
      expect(bytes.includes("distinctive-opted-out-text")).toBe(false);
    }
    tier0.close();
  });
});

describe("capture and purge together", () => {
  it("never bring back text written more than RETAIN_MS ago, whether the Entity moved or not", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const raw = (id: string, createdAt: string) => ({
      id,
      authorId: "a1",
      authorNames: [] as string[],
      authorIsBot: false,
      content: `text-${id}`,
      createdAt,
      window: "head" as const,
    });
    // The head window reaches back to the Entity's opening, a year ago.
    const windows = [raw("1", ago(365 * DAY_MS)), raw("2", ago(DAY_MS))];
    const tier0 = openTier0(":memory:");
    const capture = async (lastMessageId: string) => {
      const catalog = [{ ...entity("e1"), last_message_id: lastMessageId }];
      const { capture: due } = selectForCapture(catalog, tier0.state(), { monitored: new Set() });
      await captureEach({ entities: due, fetch: async () => windows, store: tier0, optedOut: () => new Set() });
      return tier0.messagesFor("e1").map((m) => m.messageId);
    };

    expect(await capture("2")).toEqual(["2"]);

    // A week on, "2" has aged out too.
    vi.setSystemTime(NOW.getTime() + 7 * DAY_MS);
    purgeTier0({ tier0, optedOut: new Set(), now: new Date() });
    expect(await capture("2")).toEqual([]);

    windows.push(raw("3", new Date().toISOString()));
    expect(await capture("3")).toEqual(["3"]);
    tier0.close();
  });
});
