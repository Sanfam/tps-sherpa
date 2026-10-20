import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageType, type RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WATCHED_CHANNEL } from "../llm/boundary.ts";
import type { Entity } from "../sync/catalog.ts";
import { initDurableStore, withDurableStore } from "../sync/durable-store.ts";
import { ALERTS_CHANNEL, type AlertMember, type AlertsDeps, alertPort, createAlerts, withAlertsStore } from "./alerts.ts";
import { withResponderStore } from "./responder-store.ts";
import type { ChannelAccess, WatchedMessage } from "./responder.ts";

const MEMBER_ROLE = "10";
const AMBASSADOR = "20";
const NEWCOMER = "300000000000000001";
const HOLDER = "300000000000000002";
const LAPSED = "300000000000000003";
const SINCE = "2026-10-18T00:00:00.000Z";
const JOINED = "2026-10-18T12:00:00.000Z";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alerts-"));
  path = join(dir, "bot.db");
  initDurableStore(path, { exclusionSeed: null, catalog: null, roleManifest: null });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const harness = (
  over: {
    on?: boolean;
    catalog?: () => Entity[];
    access?: () => Promise<ChannelAccess>;
    introOf?: AlertsDeps["introOf"];
    members?: Record<string, AlertMember | null>;
    /** Runs inside each member lookup, as something that happens meanwhile. */
    during?: (id: string) => void | Promise<void>;
  } = {},
) => {
  const posts: Array<{ channelId: string; body: RESTPostAPIChannelMessageJSONBody }> = [];
  const members: Record<string, AlertMember | null> = {
    [NEWCOMER]: { joinedAt: JOINED, roles: [MEMBER_ROLE] },
    [HOLDER]: { joinedAt: SINCE, roles: [MEMBER_ROLE, AMBASSADOR] },
    [LAPSED]: { joinedAt: SINCE, roles: [MEMBER_ROLE] },
    ...over.members,
  };
  const deps: AlertsDeps = {
    guildId: "1",
    discord: {
      member: async (id) => {
        await over.during?.(id);
        return members[id] ?? null;
      },
      access: over.access ?? (async () => ({ view: true, history: true, send: true })),
      createMessage: async (channelId, body) => void posts.push({ channelId, body }),
    },
    store: (work) => withAlertsStore(work, path),
    switch: () => ({ on: over.on ?? true, since: SINCE }),
    seeded: () => true,
    introOf: over.introOf ?? (() => null),
    preferences: (id) => withDurableStore((s) => s.preferences(id), path),
    loadCatalog: over.catalog ?? (() => []),
    roles: () => ({ member: new Set([MEMBER_ROLE]), holder: new Set([AMBASSADOR]) }),
    cap: { take: () => true },
    now: () => Date.parse("2026-10-19T00:00:00.000Z"),
    log: () => {},
  };
  for (const id of [HOLDER, LAPSED]) withAlertsStore((s) => (s.subscribe(id, "join", true), s.subscribe(id, "intro", true)), path);
  return { alerts: createAlerts(deps), posts };
};

const intro = (over: Partial<WatchedMessage> = {}): WatchedMessage => ({
  id: "400000000000000001",
  channel_id: WATCHED_CHANNEL,
  author: { id: NEWCOMER, username: "n", discriminator: "0", global_name: null, avatar: null },
  content: "Hi, I'm new here.",
  timestamp: JOINED,
  edited_timestamp: null,
  type: MessageType.Default,
  mentions: [],
  mention_roles: [],
  attachments: [],
  embeds: [],
  ...over,
});

const joined = (joined_at = JOINED) => ({ user: { id: NEWCOMER }, roles: [MEMBER_ROLE], joined_at });

describe("alerts", () => {
  it("ping only the subscribers who still hold the role, never the new member, and parse nothing", async () => {
    // The new member is an opted-in Ambassador too: still never pinged about themselves.
    const { alerts, posts } = harness({ members: { [NEWCOMER]: { joinedAt: JOINED, roles: [MEMBER_ROLE, AMBASSADOR] } } });
    withAlertsStore((s) => s.subscribe(NEWCOMER, "intro", true), path);
    await alerts.check();
    await alerts.onMessage(intro());
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe(ALERTS_CHANNEL);
    expect(posts[0]!.body.allowed_mentions).toEqual({ parse: [], users: [HOLDER] });
    expect(posts[0]!.body.content).toContain(`<@${NEWCOMER}>`);
  });

  it("post once per member per join, across a restart, and again after a rejoin but never again for the old join", async () => {
    const { alerts, posts } = harness();
    await alerts.check();
    await alerts.onMember(joined());
    await alerts.onMessage(intro());
    const restarted = harness();
    await restarted.alerts.check();
    await restarted.alerts.onMember(joined());
    await restarted.alerts.onMessage(intro({ id: "400000000000000002" }));
    expect(posts.map((p) => p.body.content!.split(":")[0])).toEqual(["New Member", "New introduction"]);
    expect(restarted.posts).toHaveLength(0);
    await alerts.onMember(joined("2026-10-18T13:00:00.000Z"));
    await alerts.onMember(joined());
    expect(posts).toHaveLength(3);
  });

  it("post nothing when the member turns approach off while the holders are looked up", async () => {
    const { alerts, posts } = harness({
      during: (id) => {
        if (id !== NEWCOMER) withDurableStore((s) => s.setPreference(NEWCOMER, "approach", false), path);
      },
    });
    await alerts.check();
    await alerts.onMessage(intro());
    expect(posts).toHaveLength(0);
  });

  it("do not ping a holder who opts out while the others are looked up", async () => {
    const { alerts, posts } = harness({
      during: (id) => {
        if (id === LAPSED) withAlertsStore((s) => s.subscribe(HOLDER, "intro", false), path);
      },
    });
    await alerts.check();
    await alerts.onMessage(intro());
    expect(posts).toHaveLength(0);
  });

  it("claim the first of two quick messages as the introduction, whichever lookup returns first", async () => {
    let first = true;
    const { alerts, posts } = harness({
      during: async (id) => {
        if (id === NEWCOMER && first) {
          first = false;
          await new Promise((done) => setTimeout(done, 20));
        }
      },
    });
    await alerts.check();
    await Promise.all([alerts.onMessage(intro()), alerts.onMessage(intro({ id: "400000000000000002" }))]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.content).toContain("/400000000000000001");
  });

  it("stop posting as soon as a check finds the Channel in the Catalog, before Discord answers", async () => {
    let catalog: Entity[] = [];
    let answer = () => {};
    let slow = false;
    const { alerts, posts } = harness({
      catalog: () => catalog,
      access: () =>
        slow
          ? new Promise((done) => (answer = () => done({ view: true, history: true, send: true })))
          : Promise.resolve({ view: true, history: true, send: true }),
    });
    await alerts.check();
    catalog = [{ id: ALERTS_CHANNEL } as Entity];
    slow = true;
    const checking = alerts.check();
    await alerts.onMessage(intro());
    answer();
    await checking;
    expect(posts).toHaveLength(0);
  });

  it("fit every ping it can into one message, with Discord's 100-id ceiling in reach", async () => {
    const many = Array.from({ length: 100 }, (_, i) => `3100000000000000${String(i).padStart(2, "0")}`);
    const { alerts, posts } = harness({
      members: Object.fromEntries(many.map((id) => [id, { joinedAt: SINCE, roles: [AMBASSADOR] }])),
    });
    withAlertsStore((s) => many.forEach((id) => s.subscribe(id, "intro", true)), path);
    await alerts.check();
    await alerts.onMessage(intro());
    const { content, allowed_mentions } = posts[0]!.body;
    expect(content!.length).toBeLessThanOrEqual(2000);
    expect(allowed_mentions!.users!.length).toBeGreaterThan(50);
    expect(content!.match(/<@\d+>/g)!.slice(1)).toEqual(allowed_mentions!.users!.map((id) => `<@${id}>`));
  });

  it("never alert about someone who joined before the switch was turned on", async () => {
    const { alerts, posts } = harness();
    await alerts.check();
    await alerts.onMember(joined("2026-10-17T00:00:00.000Z"));
    await alerts.onMember({ ...joined(), roles: [] });
    expect(posts).toHaveLength(0);
  });

  it("post nothing about a member with approach off", async () => {
    withDurableStore((s) => s.setPreference(NEWCOMER, "approach", false), path);
    const { alerts, posts } = harness();
    await alerts.check();
    await alerts.onMessage(intro());
    await alerts.onMember(joined());
    expect(posts).toHaveLength(0);
  });

  it("take only a first post as an introduction, whatever the responder's mode, and not after a seeded one", async () => {
    const { alerts, posts } = harness();
    await alerts.check();
    expect(withResponderStore((s) => s.mode(), path)).toBe("off");
    await alerts.onMessage(intro({ message_reference: { message_id: "1", channel_id: WATCHED_CHANNEL } }));
    await alerts.onMessage(intro({ mentions: [{ id: HOLDER, username: "h", discriminator: "0", global_name: null, avatar: null }] }));
    withResponderStore((s) => s.seedTombstones([NEWCOMER]), path);
    await alerts.onMessage(intro());
    expect(posts).toHaveLength(0);
  });

  it("take a later message as no introduction once the responder holds an earlier one for this join", async () => {
    const { alerts, posts } = harness({ introOf: () => "400000000000000009" });
    await alerts.check();
    await alerts.onMessage(intro());
    expect(posts).toHaveLength(0);
  });

  it("post nothing while the Channel is in the Catalog", async () => {
    const { alerts, posts } = harness({ catalog: () => [{ id: ALERTS_CHANNEL } as Entity] });
    expect(await alerts.check()).toBe(false);
    await alerts.onMessage(intro());
    await alerts.onMember(joined());
    expect(posts).toHaveLength(0);
  });

  it("refuse to write while the switch is off", async () => {
    const posts: string[] = [];
    const port = alertPort({ switch: () => ({ on: false, since: null }), createMessage: async (id) => void posts.push(id) });
    await expect(port.post("x", [HOLDER])).rejects.toThrow(/switched off/);
    expect(posts).toHaveLength(0);
  });
});
