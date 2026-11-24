// The site's side of the Catalog snapshot (ADR-0001): what it accepts from the
// bot, what it keeps through a restart, and what it tells Staff.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { snapshotEnvelope } from "../../bot/src/snapshot.ts";
import { buildCatalog } from "../../bot/src/sync/catalog.ts";
import { readEvents } from "../../bot/src/sync/events.ts";
import { fixtureDiscord } from "../../bot/src/sync/fixture-discord.ts";
import type { RawScheduledEvent } from "../../bot/src/sync/ports.ts";
import type { CatalogEntity } from "../src/catalog-snapshot.ts";

const BOT_URL = "http://bot.railway.internal:8080/snapshot";
const STAFF_MESSAGES = "https://discord.com/api/v10/channels/1544502247587582033/messages";
const HOUR = 60 * 60_000;
const SIX_HOURS = 6 * HOUR;

// What the bot serves; tests change it between pulls.
let served: { body: unknown; etag: string };
let alerts: string[];
// Discord answering 503 to the Staff channel, as in an outage.
let discordDown: boolean;
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
  discordDown = false;
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
    if (input === STAFF_MESSAGES && discordDown) return new Response(null, { status: 503 });
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
  // Two of the guild's real events as Discord sent them (2026-11-19), creator left out,
  // and two a member might make: an external one by a member who opted out, which
  // mentions people and a channel, and a voice one in a recorded lounge.
  const OPTED_OUT = "731000000000000001";
  const MENTIONED = "731000000000000002";
  const HOST = "731000000000000003";
  const HIDDEN = "1154240105817575446";
  const made = (id: string, entity_type: number, extra: object) => ({
    id, guild_id: "1055290132250501135", description: "Pull up a chair.", channel_id: null, creator_id: OPTED_OUT,
    image: null, scheduled_start_time: "2026-12-01T02:00:00+00:00", scheduled_end_time: "2026-12-01T04:00:00+00:00", status: 1, entity_type,
    entity_id: null, privacy_level: 2, entity_metadata: null, recurrence_rule: null, guild_scheduled_event_exceptions: [],
    ...extra,
  });
  const scheduled = [
    made("1300000000000000005", 3, {
      name: "Garage sale at 12 Elm Street",
      image: "abc123",
      entity_metadata: { location: "12 Elm Street, Springfield" },
    }),
    // A status Discord may add one day: this event is left out, not the snapshot rejected.
    made("1300000000000000008", 3, { creator_id: HOST, name: "Mystery night", status: 9 }),
    // Weekly, two hours; Discord's next night was cut to one hour on its own.
    made("1300000000000000006", 3, {
      creator_id: HOST,
      name: "Trivia",
      scheduled_start_time: "2026-12-01T02:00:00+00:00",
      scheduled_end_time: "2026-12-01T03:00:00+00:00",
      recurrence_rule: { start: "2026-11-03T02:00:00+00:00", end: null, frequency: 2, interval: 1, by_weekday: [1],
        by_n_weekday: null, by_month: null, by_month_day: null, by_year_day: null, count: null },
      guild_scheduled_event_exceptions: [{
        event_exception_id: (BigInt(Date.parse("2026-12-01T02:00:00Z") - 1420070400000) << 22n).toString(),
        is_canceled: false, scheduled_start_time: null, scheduled_end_time: "2026-12-01T03:00:00+00:00",
      }],
    }),
    // Weekly; Discord's next night was moved to 03:00 on its own, and its end lives on the event.
    made("1300000000000000007", 3, {
      creator_id: HOST,
      name: "Quiz",
      scheduled_start_time: "2026-12-02T03:00:00+00:00",
      scheduled_end_time: "2026-12-02T06:00:00+00:00",
      recurrence_rule: { start: "2026-11-04T02:00:00+00:00", end: null, frequency: 2, interval: 1, by_weekday: [2],
        by_n_weekday: null, by_month: null, by_month_day: null, by_year_day: null, count: null },
      guild_scheduled_event_exceptions: [{
        event_exception_id: (BigInt(Date.parse("2026-12-02T02:00:00Z") - 1420070400000) << 22n).toString(),
        is_canceled: false, scheduled_start_time: "2026-12-02T03:00:00+00:00", scheduled_end_time: null,
      }],
    }),
    made("1300000000000000003", 3, {
      creator_id: HOST,
      name: `Coffee with <@${MENTIONED}>`,
      entity_metadata: {
        location:
          `<#${HIDDEN}>, or ask ${MENTIONED} (https://discord.com/users/%3${MENTIONED}, example.org/discord.com/channels/${MENTIONED}, ` +
          `https://discord.com/channels/1055290132250501135/${MENTIONED}, https://discord.com/channels/1055290132250501135/1185019630109085807)`,
      },
    }),
    // Discord shows a voice event only to those who can see its channel: the site cannot check that.
    made("1300000000000000004", 2, { creator_id: HOST, name: "Lounge night", channel_id: "1194065843789770782" }),
    {
      id: "1300000000000000001", guild_id: "1055290132250501135", name: "Book Club Discussion",
      description: "Come and chat about last month's book if you read it!", channel_id: null, creator_id: "1",
      image: null, scheduled_start_time: "2026-12-10T02:00:00+00:00", scheduled_end_time: "2026-12-10T03:00:00+00:00",
      status: 1, entity_type: 3, entity_id: null, privacy_level: 2, entity_metadata: { location: "Voice Chat" },
      recurrence_rule: { start: "2026-11-12T02:00:00+00:00", end: null, frequency: 1, interval: 1, by_weekday: null,
        by_n_weekday: [{ n: 2, day: 3 }], by_month: null, by_month_day: null, by_year_day: null, count: null },
      guild_scheduled_event_exceptions: [],
    },
    {
      id: "1300000000000000002", guild_id: "1055290132250501135", name: "Papa Squad Video Chat Night",
      description: "Low key and judgement free.", channel_id: null, creator_id: "1", image: "abc123",
      scheduled_start_time: "2026-11-22T02:00:00+00:00", scheduled_end_time: "2026-11-22T04:00:00+00:00",
      status: 1, entity_type: 3, entity_id: null, privacy_level: 2,
      entity_metadata: { location: "https://discord.com/channels/1055290132250501135/1399120902490292394" },
      recurrence_rule: { start: "2025-11-23T02:00:00+00:00", end: null, frequency: 2, interval: 2, by_weekday: [6],
        by_n_weekday: null, by_month: null, by_month_day: null, by_year_day: null, count: null },
      guild_scheduled_event_exceptions: [],
    },
  ] as unknown as RawScheduledEvent[];
  const seen = await readEvents(
    { ...fixtureDiscord({ channels: recorded }), listScheduledEvents: async () => scheduled },
    () => new Set([OPTED_OUT]),
    { channels: new Map(), roles: new Map() },
    { guildId: "1055290132250501135", known: new Set(catalog.map((e) => e.id)) },
  );
  const sent = snapshotEnvelope({ catalog, roleManifest, generatedAt: new Date().toISOString() }, {}, seen);
  // An opted-out organiser's event stays behind whole: its title, place and cover could say who they are.
  expect(sent.events.map((e) => e.name)).toEqual(["Trivia", "Quiz", "Coffee with @member", "Book Club Discussion", "Papa Squad Video Chat Night"]);
  // A night moved on its own keeps the end Discord gives it.
  expect(sent.events[1]!.moved).toEqual([
    { from: "2026-12-02T02:00:00.000Z", start: "2026-12-02T03:00:00.000Z", end: "2026-12-02T06:00:00.000Z" },
  ]);
  // One night's new end is that night's alone, not every night's.
  expect(sent.events[0]).toMatchObject({
    end: null,
    moved: [{ from: "2026-12-01T02:00:00.000Z", start: "2026-12-01T02:00:00.000Z", end: "2026-12-01T03:00:00.000Z" }],
  });
  expect(JSON.stringify(sent.events)).not.toContain("Elm Street");
  expect(sent.events[2]!.description).toBe("Pull up a chair.");
  // No member's snowflake crosses, and no channel a Member may not see is named.
  // A link to a place the Catalog holds survives whole (clubs are matched on it, and the
  // site names its Channel); one carrying anything else in either slot does not.
  expect(sent.events[2]!.location).toBe(
    "#unknown-channel, or ask [id] (https://discord.com/users/[id], example.org/discord.com/channels/[id], " +
      "[link], https://discord.com/channels/1055290132250501135/1185019630109085807)",
  );
  expect(JSON.stringify(sent.events)).not.toMatch(new RegExp(`${OPTED_OUT}|${MENTIONED}|${HOST}|${HIDDEN}|watch-together|creator`));

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

test("an alert Discord drops during an outage still reaches Staff once Discord is back", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-17T00:00:00.000Z");
  vi.setSystemTime(start);
  const { pullOnce } = await site();
  served = { body: envelope(new Date(start).toISOString(), [entity("1100000000000000001")]), etag: '"g1"' };
  await pullOnce();

  // The bot stops syncing, and Discord is down just as the snapshot goes stale.
  vi.setSystemTime(start + 2 * SIX_HOURS + HOUR + 60_000);
  discordDown = true;
  await pullOnce();
  // The bot then serves a broken generation while Discord is still down.
  served = { body: envelope(new Date().toISOString(), [entity("1100000000000000001", { type: "nope" as never })]), etag: '"b1"' };
  await pullOnce();
  expect(alerts).toHaveLength(0);

  discordDown = false;
  await pullOnce();
  await pullOnce();
  // Both the staleness and the rejection, each once.
  expect(alerts).toHaveLength(2);
});
