// The snapshot endpoint as the site meets it (ADR-0001): nothing before the
// first complete sync, then the generation with an ETag the site's next poll
// can match, and nothing of a member's own Discord denies.
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

let dir: string;

test("weekly counts from what capture holds: busy places are not capped, and bots and quiet bursts are not inflated", async () => {
  dir = mkdtempSync(join(tmpdir(), "activity-"));
  const { weeklyMessages } = await import("./snapshot.ts");
  const { openTier0, readActivity } = await import("./sync/tier0-store.ts");
  const path = join(dir, "tier0.db");
  const t0 = Date.now() - 24 * 60 * 60 * 1000;
  // `n` messages spread evenly over `hours` ending now; every `botEvery`th is a bot's.
  const place = (id: string, n: number, hours: number, botEvery = 0) =>
    Array.from({ length: n }, (_, i) => ({
      entityId: id,
      messageId: `${id}-${i}`,
      authorId: "900000000000000001",
      authorIsBot: botEvery > 0 && i % botEvery === 0,
      content: "x",
      createdAt: new Date(t0 + 24 * 60 * 60 * 1000 - (hours * 60 * 60 * 1000 * i) / Math.max(n - 1, 1)).toISOString(),
      window: "tail" as const,
    }));
  const tier0 = openTier0(path);
  // A chatty channel: capture's newest 100 cover only the last day.
  tier0.record("busy", "busy-0", place("busy", 100, 24));
  // As busy, but a fifth of what capture read was bots.
  tier0.record("busy-bots", "busy-bots-0", place("busy-bots", 100, 24, 5));
  // A bot's log channel: 97 bot posts over five days, and three members' messages within the hour.
  tier0.record("bot-log", "bot-log-0", [
    ...place("bot-log", 97, 120).map((m) => ({ ...m, authorIsBot: true })),
    ...place("bot-log-m", 3, 1).map((m) => ({ ...m, entityId: "bot-log" })),
  ]);
  // A steady one: 40 over five days. A quiet one: three in one hour.
  tier0.record("steady", "steady-0", place("steady", 40, 120));
  tier0.record("burst", "burst-0", place("burst", 3, 1));
  tier0.close();

  const weekly = weeklyMessages(readActivity(path));
  // A hundred a day is several hundred a week, not the hundred capture could hold.
  expect(weekly["busy"]).toBeGreaterThan(500);
  expect(weekly["busy-bots"]).toBeGreaterThan(400);
  // Bots' posts fill the window but are not members' activity.
  expect(weekly["bot-log"]).toBeLessThan(10);
  expect(weekly["steady"]).toBeGreaterThan(weekly["burst"]!);
  expect(weekly["burst"]).toBeLessThan(10);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("the site gets nothing before the first sync, then the generation, then a cheap 304 until it changes", async () => {
  dir = mkdtempSync(join(tmpdir(), "snapshot-"));
  const path = join(dir, "bot.db");
  // The store's default path is read when its module loads.
  vi.stubEnv("BOT_DB_PATH", path);
  vi.stubEnv("SNAPSHOT_PORT", "0");
  // No message cache yet, as on a fresh volume: the snapshot still goes out, and creates none.
  vi.stubEnv("TIER0_PATH", join(dir, "tier0.db"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  const { initDurableStore, openDurableStore } = await import("./sync/durable-store.ts");
  const { startSnapshotServer } = await import("./snapshot.ts");

  initDurableStore(path, { exclusionSeed: null, catalog: null, roleManifest: null });
  const server = startSnapshotServer();
  try {
    await once(server, "listening");
    const url = `http://[::1]:${(server.address() as AddressInfo).port}/snapshot`;

    expect((await fetch(url)).status).toBe(503);

    const channel = {
      id: "1100000000000000001", type: "channel", name: "general", url: "https://discord.com/channels/1/1100000000000000001",
      parent_id: null, description_status: "present", topic: null, applied_tags: [], region: [], topics: [],
      topics_version: null, thread_state: null, last_message_id: null, last_activity_at: null,
      summary_generated: null, summary_override: null, allow_roles: [], view_roles: ["300000000000000001"], deny_roles: [],
    } as const;
    const sync = (name: string) => {
      const store = openDurableStore(path);
      store.replaceCatalog({
        catalog: [{ ...channel, name, applied_tags: [], region: [], topics: [], allow_roles: [], view_roles: [...channel.view_roles], deny_roles: [] }],
        roleManifest: [],
        outcome: { complete: true },
        // A member whose own overwrite hides the channel: bot-side member data.
        memberDenies: [{ placeId: channel.id, memberId: "900000000000000042" }],
      });
      store.close();
    };

    sync("general");
    const first = await fetch(url);
    const body = await first.text();
    const etag = first.headers.get("ETag")!;
    expect(first.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ version: 1, outcome: { complete: true }, catalog: [{ name: "general" }] });
    expect(body).not.toContain("900000000000000042");

    expect((await fetch(url, { headers: { "If-None-Match": etag } })).status).toBe(304);

    sync("general-chat");
    const changed = await fetch(url, { headers: { "If-None-Match": etag } });
    expect(changed.status).toBe(200);
    expect(JSON.parse(await changed.text()).catalog[0].name).toBe("general-chat");
    // Serving read the cache without creating it.
    expect(existsSync(join(dir, "tier0.db"))).toBe(false);
  } finally {
    server.close();
  }
});
