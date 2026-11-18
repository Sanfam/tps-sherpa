// The site's side of the Catalog snapshot (ADR-0001): what it accepts from the
// bot, what it keeps through a restart, and what it tells Staff.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { snapshotEnvelope } from "../../bot/src/snapshot.ts";
import { buildCatalog } from "../../bot/src/sync/catalog.ts";
import { fixtureDiscord } from "../../bot/src/sync/fixture-discord.ts";
import type { CatalogEntity } from "../src/catalog-snapshot.ts";

const BOT_URL = "http://bot.railway.internal:8080/snapshot";
const STAFF_MESSAGES = "https://discord.com/api/v10/channels/1544502247587582033/messages";
const HOUR = 60 * 60_000;
const SIX_HOURS = 6 * HOUR;

// What the bot serves; tests change it between pulls.
let served: { body: unknown; etag: string };
let alerts: string[];
let dir: string;

/** The module with fresh process state, as after a restart. */
const site = async () => {
  vi.resetModules();
  return import("../src/catalog-snapshot.ts");
};

const entity = (id: string, fields: Partial<CatalogEntity> = {}): CatalogEntity => ({
  id,
  type: "channel",
  name: "dads-who-climb",
  url: `https://discord.com/channels/1055290132250501135/${id}`,
  parent_id: null,
  description_status: "present",
  topic: "Saturday bouldering, all levels",
  applied_tags: [],
  region: [],
  topics: ["climbing"],
  topics_version: 1,
  thread_state: null,
  last_message_id: id,
  last_activity_at: "2026-11-01T12:00:00.000Z",
  summary_generated: "Dads arranging climbing meet-ups.",
  summary_override: null,
  allow_roles: [],
  view_roles: ["300000000000000001"],
  deny_roles: [],
  ...fields,
});

const envelope = (generatedAt: string, catalog: unknown[], outcome: unknown = { complete: true }) => ({
  version: 1,
  generatedAt,
  syncEveryMs: SIX_HOURS,
  outcome,
  roleManifest: [{ name: "Member", color: 0, ids: ["300000000000000001"] }],
  catalog,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "catalog-snapshot-"));
  alerts = [];
  vi.stubEnv("SITE_SNAPSHOT_PATH", join(dir, "catalog-snapshot.json"));
  vi.stubEnv("BOT_SNAPSHOT_URL", BOT_URL);
  vi.stubEnv("DISCORD_BOT_TOKEN", "test-bot-token");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (input === BOT_URL) {
      if (headers.get("If-None-Match") === served.etag) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(served.body), { headers: { ETag: served.etag } });
    }
    if (input === STAFF_MESSAGES && headers.get("Authorization") === "Bot test-bot-token") {
      const { content, allowed_mentions } = JSON.parse(String(init.body));
      expect(allowed_mentions).toEqual({ parse: [] });
      alerts.push(content);
      return Response.json({ id: "1" });
    }
    return new Response(null, { status: 404 });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

test("a bad generation from the bot never replaces a good one, and Staff hear once per problem without member content", async () => {
  const { currentSnapshot, pullOnce } = await site();
  const good = envelope(new Date().toISOString(), [entity("1100000000000000001"), entity("1100000000000000002")]);
  served = { body: good, etag: '"g1"' };
  await pullOnce();

  // Member content that must reach neither Discord nor the logs.
  const secret = { name: "zq-name-sentinel", topic: "zq-topic-sentinel", summary_generated: "zq-summary-sentinel" };
  // A sync where some Forums' Posts could not be listed, then a generation with
  // a Post in a state the site does not know.
  const incomplete = envelope(new Date().toISOString(), [entity("1100000000000000001", secret)], {
    complete: false,
    failed: [{ id: "1100000000000000009", reason: "50001 listing zq-name-sentinel" }],
  });
  const malformed = envelope(new Date().toISOString(), [
    entity("1100000000000000001"),
    entity("1100000000000000003", { ...secret, type: "post", thread_state: "archived" as never }),
  ]);
  served = { body: incomplete, etag: '"b1"' };
  for (let i = 0; i < 3; i++) await pullOnce();
  served = { body: malformed, etag: '"b2"' };
  for (let i = 0; i < 3; i++) await pullOnce();

  expect(currentSnapshot()?.snapshot).toEqual(good);
  expect(JSON.parse(readFileSync(join(dir, "catalog-snapshot.json"), "utf8"))).toEqual(good);
  expect(alerts).toHaveLength(2);
  const logged = vi.mocked(console.error).mock.calls.flat().map(String);
  for (const text of [...alerts, ...logged]) expect(text).not.toMatch(/zq-/);
});

test("after a restart the saved snapshot is served before any pull, and a corrupt one is not", async () => {
  const good = envelope(new Date().toISOString(), [entity("1100000000000000001")]);
  served = { body: good, etag: '"g1"' };
  await (await site()).pullOnce();

  // The bot is down at restart: nothing but the file can supply the Index.
  vi.stubEnv("BOT_SNAPSHOT_URL", "");
  const restarted = await site();
  restarted.startSnapshotPuller();
  expect(restarted.currentSnapshot()?.snapshot).toEqual(good);

  const path = join(dir, "catalog-snapshot.json");
  writeFileSync(path, readFileSync(path, "utf8").slice(0, 100));
  const corrupted = await site();
  corrupted.startSnapshotPuller();
  expect(corrupted.currentSnapshot()).toBeNull();
});

test("a snapshot the bot builds from the recorded guild is accepted", async () => {
  const recorded = JSON.parse(
    readFileSync(new URL("../../bot/src/sync/__fixtures__/guild-channels.json", import.meta.url), "utf8"),
  );
  const { catalog, roleManifest } = await buildCatalog({
    discord: fixtureDiscord({ channels: recorded }),
    guildId: "1055290132250501135",
  });
  const sent = snapshotEnvelope({ catalog, roleManifest, generatedAt: new Date().toISOString() });

  const { validateSnapshot } = await site();
  // Through JSON, as it crosses the network.
  const result = validateSnapshot(JSON.parse(JSON.stringify(sent)));
  expect(result).toMatchObject({ ok: true });
});

test("two missed syncs mark the snapshot stale and alert Staff once, until a fresh one is accepted", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-17T00:00:00.000Z");
  vi.setSystemTime(start);
  const { currentSnapshot, pullOnce } = await site();
  served = { body: envelope(new Date(start).toISOString(), [entity("1100000000000000001")]), etag: '"g1"' };
  await pullOnce();

  // Two six-hourly syncs missed, inside the hour's grace: not yet.
  vi.setSystemTime(start + 2 * SIX_HOURS + 59 * 60_000);
  await pullOnce();
  expect(currentSnapshot()?.stale).toBe(false);

  vi.setSystemTime(start + 2 * SIX_HOURS + HOUR + 60_000);
  for (let i = 0; i < 5; i++) await pullOnce();
  expect(currentSnapshot()?.stale).toBe(true);
  expect(alerts).toHaveLength(1);

  const fresh = start + 2 * SIX_HOURS + HOUR + 60_000;
  served = { body: envelope(new Date(fresh).toISOString(), [entity("1100000000000000001")]), etag: '"g2"' };
  await pullOnce();
  expect(currentSnapshot()?.stale).toBe(false);

  // And when that one goes stale in turn, Staff hear again.
  vi.setSystemTime(fresh + 2 * SIX_HOURS + HOUR + 60_000);
  await pullOnce();
  await pullOnce();
  expect(alerts).toHaveLength(2);
});
