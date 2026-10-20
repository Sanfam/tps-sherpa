import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationCommandOptionType, ChannelType, type RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Observation } from "../llm/moderation.ts";
import type { Entity } from "../sync/catalog.ts";
import { initDurableStore } from "../sync/durable-store.ts";
import { WATCH_FORUM, type WatchDeps, createWatch, forumPort, withWatchStore } from "./watch.ts";

const MEMBER_ROLE = "2";
const WATCHED = "500000000000000001";
const OTHER = "500000000000000002";
const SETTER = "500000000000000009";
const place = (id: string, over: Partial<Entity> = {}): Entity =>
  ({ id, name: `p${id}`, type: "channel", parent_id: null, description_status: "present", allow_roles: [], view_roles: [MEMBER_ROLE], deny_roles: [], ...over }) as Entity;
const general = place("10");
const staffOnly = place("12", { view_roles: ["4"] });
const withheld = place("13", { description_status: "withheld" });

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "watch-"));
  path = join(dir, "bot.db");
  initDurableStore(path, { exclusionSeed: null, catalog: null, roleManifest: null });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const harness = (
  over: {
    observation?: Partial<Observation>;
    catalog?: Entity[];
    search?: WatchDeps["discord"]["search"];
    during?: () => Promise<void> | void;
    postMessages?: WatchDeps["discord"]["postMessages"];
    locked?: boolean;
    access?: boolean;
    memberVisible?: boolean;
    deletedPost?: () => boolean;
    retrying?: WatchDeps["retrying"];
    take?: () => boolean;
  } = {},
) => {
  const writes: Array<{ postId: string; body: RESTPostAPIChannelMessageJSONBody }> = [];
  const created: string[] = [];
  const calls: string[][] = [];
  const histories: string[][] = [];
  let clock = Date.parse("2026-10-19T00:00:00.000Z");
  const deps: WatchDeps = {
    guildId: "1",
    discord: {
      member: async (id) => ({ names: ["Watched Dad"], serverName: "Watched Dad", username: `u${id}` }),
      channel: async (id) =>
        id === "30"
          ? { type: ChannelType.PrivateThread, parent_id: general.id }
          : id === "31"
            ? { type: ChannelType.PublicThread, parent_id: staffOnly.id }
            : id === "33"
              ? { type: ChannelType.GuildText, parent_id: general.id }
              : id === "700000000000000001" && over.deletedPost?.()
                ? null
                : { type: ChannelType.PublicThread, parent_id: WATCH_FORUM, locked: over.locked === true },
      forumTags: async () => [{ id: "t1", name: "Monitor Activity" }, { id: "t2", name: "Wellness Concern" }],
      access: async () =>
        over.access === false ? null : { view: true, history: true, send: true, threads: true, memberVisible: over.memberVisible === true },
      createPost: async (_, body) => (created.push(body.name), { id: `70000000000000000${created.length}` }),
      send: async (postId, body) => void writes.push({ postId, body }),
      setTags: async () => {},
      postMessages: over.postMessages ?? (async () => []),
      postTags: async () => [],
      search: over.search ?? (async () => ({ total_results: 0, doing_deep_historical_index: false, messages: [] }) as never),
      botId: async () => "999",
    },
    store: (work) => withWatchStore(work, path),
    session: () => ({
      catalog: over.catalog ?? [general, staffOnly, withheld],
      memberRoles: [MEMBER_ROLE],
      excluded: new Set(),
      boundary: {
        observeMember: async (_, request) => {
          calls.push(request.messages.map((m) => m.source.content));
          histories.push(request.post.map((m) => m.content));
          await over.during?.();
          return { level: "alert", matched: [0], observation: "Sharp with a newcomer.", cites: [0], tags: [], ...over.observation };
        },
      },
    }),
    retrying: over.retrying ?? ((work) => work()),
    cap: { take: over.take ?? (() => true) },
    now: () => clock,
    log: () => {},
  };
  return { watch: createWatch(deps), writes, created, calls, histories, advance: (ms: number) => (clock += ms), deps };
};

const start = (days = 30, triggers = "hostile to newcomers; selling") =>
  ({
    id: "1",
    member: { user: { id: SETTER } },
    data: {
      name: "sherpa",
      options: [
        {
          name: "watch",
          type: ApplicationCommandOptionType.SubcommandGroup,
          options: [
            {
              name: "start",
              type: ApplicationCommandOptionType.Subcommand,
              options: [
                { name: "member", value: WATCHED },
                { name: "days", value: days },
                { name: "triggers", value: triggers },
              ],
            },
          ],
        },
      ],
    },
  }) as never;

const message = (id: string, channel_id: string, author = WATCHED) => ({
  id,
  channel_id,
  author: { id: author },
  content: `words ${id}`,
  timestamp: "2026-10-19T00:00:00.000Z",
});

const flushNow = async (h: ReturnType<typeof harness>) => {
  h.advance(31 * 60 * 1000);
  await h.watch.tick();
};

describe("User Monitoring", () => {
  it("keeps only the watched member's own messages from places a Member can see", async () => {
    const h = harness();
    await h.watch.check();
    await h.watch.answer(start(), "t");
    await h.watch.onMessage(message("1", general.id, OTHER));
    for (const [id, channel] of [["2", staffOnly.id], ["3", withheld.id], ["4", "30"], ["5", "31"], ["6", "32"], ["66", "33"], ["7", general.id]] as const)
      await h.watch.onMessage(message(id, channel));
    await flushNow(h);
    expect(h.calls).toEqual([["words 7"]]);
  });

  it("makes the member's Post at the start, titled with their server name and username, and writes only there", async () => {
    const h = harness();
    await h.watch.check();
    await h.watch.answer(start(), "t");
    expect(h.created).toEqual([`Watched Dad (u${WATCHED})`]);
    await h.watch.onMessage(message("7", general.id));
    await flushNow(h);
    expect(h.writes.map((w) => w.postId)).toEqual(["700000000000000001"]);
  });

  it("pings the setter alone on an alert, and nobody on a note", async () => {
    const h = harness();
    await h.watch.check();
    await h.watch.answer(start(), "t");
    await h.watch.onMessage(message("7", general.id));
    await flushNow(h);
    expect(h.writes[0]!.body.allowed_mentions).toEqual({ parse: [], users: [SETTER] });
    const note = harness({ observation: { level: "note" } });
    await note.watch.check();
    await note.watch.answer(start(), "t");
    await note.watch.onMessage(message("8", general.id));
    await flushNow(note);
    expect(note.writes[0]!.body.allowed_mentions).toEqual({ parse: [], users: [] });
  });

  it("refuses a write to a member with no Post, whatever the content", async () => {
    const writes: string[] = [];
    const port = forumPort({
      store: (work) => withWatchStore(work, path),
      createPost: async () => ({ id: "1" }),
      send: async (id) => void writes.push(id),
      channel: async (id) => ({ type: ChannelType.PublicThread, parent_id: id === "800000000000000001" ? general.id : WATCH_FORUM }),
    });
    await expect(port.write(WATCHED, "x", null)).rejects.toThrow(/no Post/);
    // A mapping to anything but a Post in the Forum is refused, however it got there.
    withWatchStore((s) => s.linkPost(WATCHED, "800000000000000001", SETTER), path);
    await expect(port.write(WATCHED, "x", null)).rejects.toThrow(/not in the Forum/);
    expect(writes).toEqual([]);
  });

  it("ends an expired watch with one line, keeps nothing and makes no call, across a restart", async () => {
    const h = harness();
    await h.watch.check();
    await h.watch.answer(start(1), "t");
    h.advance(2 * 24 * 60 * 60 * 1000);
    const restarted = createWatch({ ...h.deps });
    await restarted.check();
    await restarted.onMessage(message("7", general.id));
    await restarted.tick();
    expect(withWatchStore((s) => s.watches(), path)).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.writes.map((w) => w.body.content)).toEqual([`Sherpa: the watch on <@${WATCHED}> has ended.`]);
  });

  it("pauses while the Forum is in the Catalog", async () => {
    const h = harness({ catalog: [general, place(WATCH_FORUM)] });
    expect(await h.watch.check()).toBe(false);
    await h.watch.answer(start(), "t");
    await h.watch.onMessage(message("7", general.id));
    await flushNow(h);
    expect([h.calls, h.created]).toEqual([[], []]);
  });

  it("notes a departure with up to 5 of their last messages, quoted, clipped and inert", async () => {
    const long = "a".repeat(300);
    const h = harness({
      search: async () =>
        ({
          total_results: 7,
          doing_deep_historical_index: false,
          messages: [
            [{ ...message("9", staffOnly.id), content: "staff-only words" }],
            ...Array.from({ length: 6 }, (_, i) => [{ ...message(`1${i}`, general.id), content: i === 0 ? `@everyone ${long}` : `m${i}` }]),
          ],
        }) as never,
    });
    await h.watch.check();
    await h.watch.answer(start(), "t");
    await h.watch.onLeave(WATCHED);
    const note = h.writes.at(-1)!;
    expect(note.body.allowed_mentions).toEqual({ parse: [], users: [] });
    expect(note.body.content).not.toContain("staff-only words");
    expect(note.body.content!.match(/^> /gm)).toHaveLength(5);
    expect(note.body.content).toContain("\\@everyone");
    expect(note.body.content!.split("\n").every((l) => l.length <= 210)).toBe(true);
    expect(withWatchStore((s) => [s.watches().length, s.post(WATCHED)], path)).toEqual([0, "700000000000000001"]);
  });
});

const list = { id: "1", member: { user: { id: SETTER } }, data: { name: "sherpa", options: [{ name: "watch", type: ApplicationCommandOptionType.SubcommandGroup, options: [{ name: "list", type: ApplicationCommandOptionType.Subcommand }] }] } } as never;

describe("User Monitoring, after review", () => {
  it("posts nothing from a call that returns after its watch was replaced", async () => {
    let h: ReturnType<typeof harness>;
    h = harness({ during: async () => { h.advance(1000); await h.watch.answer(start(30, "self-harm"), "t"); } });
    await h.watch.check();
    await h.watch.answer(start(), "t");
    await h.watch.onMessage(message("7", general.id));
    await flushNow(h);
    expect(h.writes).toEqual([]);
  });

  it("notes a departure that came while the checks failed, once they pass", async () => {
    let failing = true;
    const h = harness();
    const deps = {
      ...h.deps,
      discord: { ...h.deps.discord, access: async () => (failing ? null : { view: true, history: true, send: true, threads: true, memberVisible: false }) },
    };
    await h.watch.check();
    await h.watch.answer(start(), "t");
    const paused = createWatch(deps);
    await paused.check();
    await paused.onLeave(WATCHED);
    expect(h.writes).toEqual([]);
    failing = false;
    await paused.check();
    await paused.tick();
    expect(h.writes.at(-1)!.body.content).toContain("left the server");
    expect(withWatchStore((s) => s.watches(), path)).toEqual([]);
  });

  it("reads only Sherpa's own and Staff's messages in the Post as its history", async () => {
    const h = harness({
      postMessages: async () =>
        [
          { id: "1", author: { id: "999", bot: true }, content: "Sherpa's earlier note" },
          { id: "2", author: { id: "888", bot: true }, content: "another bot's words" },
          { id: "3", author: { id: SETTER }, content: "a Staff note" },
          { id: "4", author: { id: "777" }, webhook_id: "1", content: "a webhook's words" },
        ] as never,
    });
    await h.watch.check();
    await h.watch.answer(start(), "t");
    await h.watch.onMessage(message("7", general.id));
    await flushNow(h);
    expect(h.histories).toEqual([["Sherpa's earlier note", "a Staff note"]]);
  });

  it("fits the fullest observation into one Discord message", async () => {
    const h = harness({ observation: { matched: [0, 1, 2, 3, 4], observation: "-".repeat(400), cites: [0, 1, 2, 3, 4] } });
    await h.watch.check();
    await h.watch.answer(start(30, Array.from({ length: 5 }, () => "*".repeat(200)).join(";")), "t");
    for (let i = 0; i < 5; i++) await h.watch.onMessage(message(`90000000000000000${i}`, general.id));
    await flushNow(h);
    expect(h.writes[0]!.body.content!.length).toBeLessThanOrEqual(2000);
  });

  it("counts every attempt against the cap, a retry included", async () => {
    let taken = 0;
    const h = harness({
      take: () => (taken++, true),
      retrying: async (work) => {
        try {
          return await work();
        } catch {
          return await work();
        }
      },
      during: () => {
        if (taken === 1) throw new Error("bad answer");
      },
    });
    await h.watch.check();
    await h.watch.answer(start(), "t");
    await h.watch.onMessage(message("7", general.id));
    await flushNow(h);
    expect(taken).toBe(2);
  });

  it("says in list that a watch whose Post is locked is paused", async () => {
    const h = harness({ locked: true });
    await h.watch.check();
    await h.watch.answer(start(), "t");
    await h.watch.onMessage(message("7", general.id));
    await flushNow(h);
    expect(await h.watch.answer(list, "t")).toContain("paused: their Post is locked");
    expect(h.calls).toEqual([]);
  });
});

describe("User Monitoring, after the second review", () => {
  it("replaces a Post Staff deleted, and writes to the new one", async () => {
    let deleted = false;
    const h = harness({ deletedPost: () => deleted });
    await h.watch.check();
    await h.watch.answer(start(), "t");
    deleted = true;
    await h.watch.onMessage(message("7", general.id));
    await flushNow(h);
    expect(h.created).toHaveLength(2);
    expect(h.writes.map((w) => w.postId)).toEqual(["700000000000000002"]);
  });

  it("notes a departure once, however a tick and the event overlap", async () => {
    const h = harness();
    await h.watch.check();
    await h.watch.answer(start(), "t");
    await Promise.all([h.watch.onLeave(WATCHED), h.watch.tick(), h.watch.tick()]);
    expect(h.writes.filter((w) => w.body.content!.includes("left the server"))).toHaveLength(1);
  });

  it("pauses while the Member role can see the Forum", async () => {
    const h = harness({ memberVisible: true });
    expect(await h.watch.check()).toBe(false);
  });

  it("gives up a departure note it could not post by the time the watch would have ended", async () => {
    let failing = true;
    const h = harness();
    const deps = {
      ...h.deps,
      discord: { ...h.deps.discord, send: async (...args: Parameters<WatchDeps["discord"]["send"]>) => (failing ? Promise.reject(new Error("locked")) : h.deps.discord.send(...args)) },
    };
    await h.watch.check();
    await h.watch.answer(start(1), "t");
    const w = createWatch(deps);
    await w.check();
    await w.onLeave(WATCHED);
    expect(withWatchStore((s) => s.watches().length, path)).toBe(1);
    h.advance(2 * 24 * 60 * 60 * 1000);
    await w.tick();
    expect(withWatchStore((s) => s.watches().length, path)).toBe(0);
    failing = false;
  });
});
