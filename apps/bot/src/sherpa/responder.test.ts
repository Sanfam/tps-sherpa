import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageType } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AskRequest, type Extraction, WATCHED_CHANNEL } from "../llm/boundary.ts";
import type { Vocabulary } from "../llm/vocabulary.ts";
import type { Entity } from "../sync/catalog.ts";
import { initDurableStore, withDurableStore } from "../sync/durable-store.ts";
import { type ResponderStore, withResponderStore } from "./responder-store.ts";
import {
  type ResponderDeps,
  SHADOW_CHANNEL,
  type WatchedMessage,
  createResponder,
  snowflakeAt,
  writePort,
} from "./responder.ts";

const GUILD = "1055290132250501135";
const MEMBER = "500000000000000001";
const OTHER = "500000000000000002";
/** Processing off. */
const QUIET = "500000000000000003";
const VETERAN = "500000000000000004";
const SHERPA = "500000000000000009";
const JOINED = "2026-01-01T00:00:00.000000+00:00";
const MIN = 60_000;
const T0 = Date.parse("2026-10-20T03:00:00.000Z");
const at = (minutes: number) => T0 + minutes * MIN;

const MEMBER_ROLE = "900000000000000001";
const entity = (over: Partial<Entity> & { id: string; name: string }): Entity => ({
  type: "post",
  view_roles: [MEMBER_ROLE],
  allow_roles: [],
  deny_roles: [],
  url: `https://discord.com/channels/${GUILD}/${over.id}`,
  parent_id: null,
  description_status: "present",
  topic: null,
  applied_tags: [],
  region: [],
  topics: [],
  topics_version: null,
  thread_state: null,
  last_message_id: null,
  last_activity_at: null,
  summary_generated: null,
  summary_override: null,
  ...over,
});
// Candidates in this order are e1 and e2 in the match prompt.
const woodshop = entity({ id: "100000000000000001", name: "woodshop", type: "forum" });
const gliders = entity({ id: "100000000000000002", name: "gliders", type: "channel" });
// Seen by the bot and Staff, not by the Member role (#53): never offered.
const staffroom = entity({ id: "100000000000000003", name: "staffroom", type: "channel", view_roles: ["900000000000000002"] });
const catalog = [entity({ id: WATCHED_CHANNEL, name: "introductions", type: "channel" }), woodshop, gliders, staffroom];
const monitored: ReadonlySet<string> = new Set([WATCHED_CHANNEL]);
const vocabulary = {
  version: 1,
  frozen_at: "2026-09-26",
  status: "frozen",
  topics: [{ slug: "gaming", label: "Gaming", description: "Games." }],
} as Vocabulary;

let seq = 0n;
const message = (author: string, minutes: number, over: Partial<WatchedMessage> = {}): WatchedMessage => ({
  id: (BigInt(snowflakeAt(at(minutes))) + ++seq).toString(),
  channel_id: WATCHED_CHANNEL,
  author: { id: author, username: `user-${author}`, discriminator: "0", global_name: null, avatar: null },
  content: "Hi all, I build oak furniture in my garage most weekends",
  timestamp: new Date(at(minutes)).toISOString(),
  edited_timestamp: null,
  type: MessageType.Default,
  mentions: [],
  attachments: [],
  embeds: [],
  ...over,
});
const gif = {
  type: "gifv",
  url: "https://tenor.com/view/hello",
  thumbnail: { url: "https://media.tenor.com/x.png", proxy_url: "https://media.discordapp.net/x.png", width: 498, height: 280 },
} as WatchedMessage["embeds"][number];

const SAID: Extraction = { signal: "some", interests: ["woodworking"], topics: [], life_stage: [] };

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "responder-"));
  path = join(dir, "bot.db");
  initDurableStore(path, { exclusionSeed: null, catalog: null, roleManifest: null });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = <T>(work: (s: ResponderStore) => T): T => withResponderStore(work, path);
const row = (member = MEMBER) => store((s) => s.introduction(member));
const tombstone = (member: string) => {
  const db = new DatabaseSync(path);
  const found = db.prepare("SELECT joined_at FROM tombstone WHERE member_id = ?").get(member);
  db.close();
  return found as { joined_at: string | null } | undefined;
};
const setMode = (mode: "off" | "shadow" | "live", minutes: number) =>
  store((s) => s.setMode(mode, "staff", new Date(at(minutes))));

/** Everything a responder touches, faked, over a real durable store on a temp path. */
const harness = () => {
  const h = {
    clock: at(-30),
    history: [] as WatchedMessage[],
    members: new Map<string, { joinedAt: string | null; names: string[] } | null>(),
    /** Runs inside every member lookup, when set: to hold it, or to make it throw. */
    lookup: null as (() => Promise<void>) | null,
    shadowVisibleToMember: false,
    /** Every send rejects, when set, as Discord answering 500. */
    sendFails: false,
    writes: [] as Array<{ channelId: string; body: { content?: string } }>,
    extracts: [] as unknown[],
    readings: [] as unknown[],
    asks: [] as Array<AskRequest<unknown>>,
    denied: new Map<string, ReadonlySet<string>>(),
    extraction: SAID,
    /** Holds every `ask` until released, when set. */
    askGate: null as Promise<void> | null,
    asked: () => {},
    /** Holds the seed's history read until released, when set. */
    seedGate: null as Promise<void> | null,
    seeding: () => {},
    logs: [] as string[],
    touched: 0,
  };
  const touch =
    <A extends unknown[], R>(f: (...a: A) => R) =>
    (...a: A): R => {
      h.touched++;
      return f(...a);
    };
  const deps: ResponderDeps = {
    guildId: GUILD,
    discord: {
      member: touch(async (id: string) => {
        if (h.lookup) await h.lookup();
        return h.members.has(id) ? h.members.get(id)! : { joinedAt: JOINED, names: [`user-${id}`] };
      }),
      messages: touch(async (query: { after: string } | { before: string }) => {
        const sorted = [...h.history].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        if ("after" in query) return sorted.filter((m) => BigInt(m.id) > BigInt(query.after)).slice(0, 100);
        h.seeding();
        if (h.seedGate) await h.seedGate;
        return sorted.filter((m) => BigInt(m.id) < BigInt(query.before)).reverse().slice(0, 100);
      }),
      message: touch(async (id: string) => h.history.find((m) => m.id === id) ?? null),
      botId: touch(async () => SHERPA),
      probe: touch(async () => {
        const all = { view: true, history: true, send: true };
        return { messageContent: true, watched: all, shadow: all, shadowVisibleToMember: h.shadowVisibleToMember };
      }),
      createMessage: touch(async (channelId: string, body: { content?: string }) => {
        if (h.sendFails) throw new Error("Discord answered 500");
        h.writes.push({ channelId, body });
      }),
    },
    store: ((work: (s: ResponderStore) => unknown) => {
      h.touched++;
      return store(work);
    }) as ResponderDeps["store"],
    preferences: touch((id: string) => withDurableStore((s) => s.preferences(id), path)),
    monitored: touch(() => monitored),
    excluded: touch(() => new Set([SHADOW_CHANNEL])),
    session: touch(() => ({
      catalog,
      monitored,
      vocabulary,
      memberRoles: [MEMBER_ROLE],
      denied: (memberId: string) => h.denied.get(memberId) ?? new Set<string>(),
      boundary: {
        extractIntroduction: async (request) => {
          h.extracts.push(request);
          return h.extraction;
        },
        readImage: async (request) => {
          h.readings.push(request);
          return { kind: "meme" as const, meaning: "greeting" as const };
        },
        ask: async <T>(request: AskRequest<T>): Promise<T> => {
          h.asks.push(request as AskRequest<unknown>);
          h.asked();
          if (h.askGate) await h.askGate;
          return request.parse({ matches: ["e1", "e2"], topics: [] });
        },
      },
    })),
    fetchImage: touch(
      async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } }),
    ),
    cap: { take: touch(() => true) },
    now: () => h.clock,
    log: (m) => h.logs.push(m),
  };
  const responder = createResponder(deps);
  /** A message posted now: into the history the REST fakes read, and onto the gateway. */
  const say = (m: WatchedMessage) => {
    h.history.push(m);
    h.clock = Math.max(h.clock, Date.parse(m.timestamp));
    return responder.onMessage(m);
  };
  return { h, responder, say };
};

/** Shadow from an hour before T0, started half an hour before it. */
const started = async () => {
  setMode("shadow", -60);
  const t = harness();
  await t.responder.start();
  return t;
};

describe("the gateway filter (§2)", () => {
  it("drops every event outside #introductions, Threads under it included, before touching anything", async () => {
    const { h, responder } = await started();
    h.touched = 0;
    h.logs = [];
    const elsewhere = (channel: string) => message(MEMBER, 0, { channel_id: channel });
    for (const channel of ["1088128866033356801", "1084293546183495721", SHADOW_CHANNEL]) {
      await responder.onMessage(elsewhere(channel));
      responder.onDelete({ channel_id: channel, ids: [elsewhere(channel).id] });
    }
    expect(h.touched).toBe(0);
    expect(h.logs).toEqual([]);
    expect(row()).toBeNull();
  });
});

describe("a member with processing off (D10)", () => {
  it("counts for nothing: not activity, not an acknowledgement, not novelty", async () => {
    withDurableStore((s) => s.setPreference(QUIET, "processing", false), path);
    const { h, responder, say } = await started();
    const intro = message(MEMBER, 0);
    await say(intro);
    for (let minute = 1; minute <= 25; minute++)
      await say(
        message(QUIET, minute, {
          content: `Welcome! Have you seen <#${woodshop.id}>? What do you make?`,
          message_reference: { message_id: intro.id, channel_id: WATCHED_CHANNEL },
          mentions: [{ id: MEMBER, username: "m", discriminator: "0", global_name: null, avatar: null }],
        }),
      );
    h.clock = at(30);
    await responder.tick();
    expect(h.writes).toHaveLength(1);
    const post = h.writes[0]!.body.content!;
    expect(post).toContain("acknowledged none · active minutes 0");
    expect(post).toContain("novelty dropped 0");
    expect(post).toContain(`<#${woodshop.id}>`);
  });
});

describe("the write port (§7)", () => {
  const body = {
    reply: "Welcome!",
    timeline: {
      clock: "wall" as const,
      acknowledgedAfterMinutes: null,
      activeMinutes: 0,
      extractions: 1,
      noveltyDropped: 0,
      images: 0,
      imageMeaning: null,
    },
  };
  const INTRO = "1300000000000000001";
  const portFor = (mode: "off" | "shadow" | "live", ids: ReadonlySet<string> = monitored) => {
    const writes: Array<{ channelId: string; body: unknown }> = [];
    const port = writePort({
      guildId: GUILD,
      monitored: () => ids,
      store: <T>(work: (s: ResponderStore) => T) => work({ mode: () => mode } as ResponderStore),
      createMessage: async (channelId, sent) => {
        if (channelId !== (mode === "shadow" ? SHADOW_CHANNEL : WATCHED_CHANNEL))
          throw new Error(`a ${mode} write to ${channelId}`);
        writes.push({ channelId, body: sent });
      },
    });
    return { port, writes };
  };

  it("posts shadow to #bot-tests with a jump link, and live inline in #introductions, and nothing else", async () => {
    const shadow = portFor("shadow");
    await shadow.port.post("question", body, INTRO);
    expect(shadow.writes).toEqual([
      {
        channelId: SHADOW_CHANNEL,
        body: {
          content: expect.stringContaining(
            `would POST question · replying to: https://discord.com/channels/${GUILD}/${WATCHED_CHANNEL}/${INTRO}`,
          ),
          allowed_mentions: { parse: [] },
        },
      },
    ]);
    const live = portFor("live");
    await live.port.post("question", body, INTRO);
    expect(live.writes).toEqual([
      {
        channelId: WATCHED_CHANNEL,
        body: {
          content: "Welcome!",
          message_reference: { message_id: INTRO },
          allowed_mentions: { parse: [], replied_user: true },
        },
      },
    ]);
  });

  it("writes nothing in off, to a monitored shadow target, or to an unmonitored live one", async () => {
    const off = portFor("off");
    await expect(off.port.post("question", body, INTRO)).rejects.toThrow();
    const shadow = portFor("shadow", new Set([WATCHED_CHANNEL, SHADOW_CHANNEL]));
    await expect(shadow.port.post("question", body, INTRO)).rejects.toThrow();
    const live = portFor("live", new Set());
    await expect(live.port.post("question", body, INTRO)).rejects.toThrow();
    expect([...off.writes, ...shadow.writes, ...live.writes]).toEqual([]);
  });
});

describe("a restart (F12)", () => {
  it("gives a row whose post was claimed no second post, and closes it failed", async () => {
    setMode("shadow", -60);
    const intro = message(MEMBER, 0);
    store((s) => s.startIntroduction(MEMBER, { messageId: intro.id, editedAt: null, joinedAt: JOINED }, new Date(at(0))));
    store((s) => s.claimPost(MEMBER, new Date(at(20))));
    const { h, responder } = harness();
    h.history.push(intro);
    h.clock = at(21);
    await responder.start();
    h.clock = at(60 * 25);
    await responder.tick();
    expect(h.writes).toEqual([]);
    expect(h.logs.some((m) => m.includes("rebuilt"))).toBe(false);
    expect(row()?.outcome).toBe("failed");
  });

  it("closes an open row failed when the lookup that would rebuild its watch throws", async () => {
    setMode("shadow", -60);
    const intro = message(MEMBER, 0);
    store((s) => s.startIntroduction(MEMBER, { messageId: intro.id, editedAt: null, joinedAt: JOINED }, new Date(at(0))));
    const { h, responder } = harness();
    h.history.push(intro);
    h.lookup = async () => {
      throw new Error("Discord answered 500");
    };
    h.clock = at(1);
    await responder.start();
    expect(row()?.outcome).toBe("failed");
  });

  it("times a rebuilt signal from the follow-up that carried it, so the post is never brought forward", async () => {
    setMode("shadow", -60);
    const intro = message(MEMBER, 0);
    const followUp = message(MEMBER, 15, { content: "I fly gliders on Sundays" });
    store((s) => s.startIntroduction(MEMBER, { messageId: intro.id, editedAt: null, joinedAt: JOINED }, new Date(at(0))));
    store((s) => s.recordMessage(MEMBER, followUp.id, null));
    const { h, responder } = harness();
    h.history.push(intro, followUp);
    h.clock = at(16);
    await responder.start();
    h.clock = at(21);
    await responder.tick();
    expect(h.writes).toEqual([]);
    h.clock = at(35);
    await responder.tick();
    expect(h.writes).toHaveLength(1);
  });

  it("rebuilds a row whose 3 extractions were all claimed without losing its signal", async () => {
    setMode("shadow", -60);
    const intro = message(MEMBER, 0);
    store((s) => s.startIntroduction(MEMBER, { messageId: intro.id, editedAt: null, joinedAt: JOINED }, new Date(at(0))));
    for (let i = 0; i < 3; i++) store((s) => s.claimExtraction(MEMBER));
    const { h, responder } = harness();
    h.history.push(intro);
    h.clock = at(1);
    await responder.start();
    h.clock = at(21);
    await responder.tick();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.body.content).toContain("would POST recommend");
    expect(row()?.extractions).toBe(3);
  });

  it("stops re-extracting on rebuild after three restarts, so a crash loop cannot spend the cap", async () => {
    setMode("shadow", -60);
    const intro = message(MEMBER, 0);
    store((s) => s.startIntroduction(MEMBER, { messageId: intro.id, editedAt: null, joinedAt: JOINED }, new Date(at(0))));
    for (let i = 0; i < 3; i++) store((s) => s.claimRebuild(MEMBER));
    const { h, responder } = harness();
    h.history.push(intro);
    h.clock = at(1);
    await responder.start();
    expect(h.extracts).toEqual([]);
  });

  it("does not extract a follow-up again when the catch-up replays it after a rebuild", async () => {
    setMode("shadow", -60);
    const intro = message(MEMBER, 0);
    const followUp = message(MEMBER, 5);
    store((s) => s.startIntroduction(MEMBER, { messageId: intro.id, editedAt: null, joinedAt: JOINED }, new Date(at(0))));
    store((s) => s.recordMessage(MEMBER, followUp.id, null));
    for (let i = 0; i < 2; i++) store((s) => s.claimExtraction(MEMBER));
    const { h, responder } = harness();
    h.history.push(intro, followUp);
    h.clock = at(6);
    await responder.start();
    expect(h.extracts).toHaveLength(1);
    expect(row()?.extractions).toBe(2);
  });

  it("gives a member answered before the restart nothing more", async () => {
    const first = await started();
    const intro = message(MEMBER, 0);
    await first.say(intro);
    first.h.clock = at(21);
    await first.responder.tick();
    expect(first.h.writes).toHaveLength(1);

    const again = harness();
    again.h.history.push(intro);
    again.h.clock = at(22);
    await again.responder.start();
    again.h.clock = at(60);
    await again.responder.tick();
    expect(again.h.writes).toEqual([]);
    expect(again.h.extracts).toEqual([]);
  });
});

describe("an erasure during a model call (§5)", () => {
  it("discards the call's result: nothing is posted", async () => {
    const { h, responder, say } = await started();
    await say(message(MEMBER, 0));
    let release = () => {};
    h.askGate = new Promise((done) => (release = done));
    const asked = new Promise<void>((done) => (h.asked = done));
    h.clock = at(21);
    const ticked = responder.tick();
    await asked;
    // The `/privacy` hook's in-memory half, with the row still there: only the erasure count can tell.
    responder.forget(MEMBER);
    release();
    await ticked;
    expect(h.writes).toEqual([]);
    expect(h.logs.some((m) => m.includes(`member ${MEMBER}: a result came back stale`))).toBe(true);
  });
});

describe("a delete racing the first handling (§6)", () => {
  it("drops a message deleted during its lookup or behind its member's queue: no row of it, no call", async () => {
    const { h, responder, say } = await started();
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    let looking = 0;
    let bothLooking = () => {};
    const looked = new Promise<void>((done) => (bothLooking = done));
    h.lookup = () => {
      if (++looking === 2) bothLooking();
      return held;
    };
    const intro = message(MEMBER, 0, { content: "Hi, I restore old motorbikes" });
    const otherIntro = message(OTHER, 0);
    const followUp = message(OTHER, 1, { content: "I fly gliders on Sundays" });
    const handled = [say(intro), say(otherIntro), say(followUp)];
    await looked;
    // MEMBER's intro is mid-lookup; OTHER's follow-up waits behind OTHER's intro.
    for (const gone of [intro, followUp]) {
      h.history = h.history.filter((m) => m.id !== gone.id);
      responder.onDelete({ channel_id: WATCHED_CHANNEL, ids: [gone.id] });
    }
    release();
    await Promise.all(handled);
    expect(row()).toBeNull();
    expect(tombstone(MEMBER)).toBeUndefined();
    expect(row(OTHER)?.messages.map((m) => m.id)).toEqual([otherIntro.id]);
    expect(h.extracts).toHaveLength(1);
    expect(JSON.stringify(h.extracts)).not.toMatch(/motorbikes|gliders/);
  });
});

describe("a failed check (§2)", () => {
  it("refuses at once, not at the next tick: a new message, and a call in flight", async () => {
    const { h, responder, say } = await started();
    await say(message(MEMBER, 0));
    let release = () => {};
    h.askGate = new Promise((done) => (release = done));
    const asked = new Promise<void>((done) => (h.asked = done));
    h.clock = at(21);
    const ticked = responder.tick();
    await asked;
    h.shadowVisibleToMember = true;
    expect(await responder.check()).toBe(false);
    expect(h.logs.some((m) => m.includes("#bot-tests is visible to the Member role"))).toBe(true);
    await say(message(OTHER, 22));
    release();
    await ticked;
    expect(row(OTHER)).toBeNull();
    expect(h.writes).toEqual([]);
    expect(responder.passing()).toBe(false);
  });

  it("records nothing of an intro whose member lookup was pending when it failed", async () => {
    const { h, responder, say } = await started();
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    let looking = () => {};
    const looked = new Promise<void>((done) => (looking = done));
    h.lookup = () => {
      looking();
      return held;
    };
    const said = say(message(MEMBER, 0));
    await looked;
    h.shadowVisibleToMember = true;
    expect(await responder.check()).toBe(false);
    release();
    await said;
    expect(row()).toBeNull();
    expect(h.extracts).toEqual([]);
  });
});

describe("off (F11)", () => {
  it("creates no row for an intro, and the catch-up after switching on does not reach it", async () => {
    const { h, responder, say } = await started();
    const other = message(OTHER, -10);
    await say(other);
    expect(row(OTHER)).not.toBeNull();

    setMode("off", -5);
    h.clock = at(-5);
    await responder.tick();
    await say(message(MEMBER, 0));
    expect(row()).toBeNull();
    expect(tombstone(MEMBER)).toBeUndefined();

    // The catch-up reads from OTHER's open intro, so it passes MEMBER's, which is older than on_since.
    setMode("shadow", 5);
    h.clock = at(5);
    await responder.tick();
    expect(row()).toBeNull();
    expect(row(OTHER)?.outcome).toBeNull();
  });
});

describe("the seed (F2)", () => {
  it("evaluates nothing until seeded_at, then blocks the authors of the history", async () => {
    setMode("shadow", -60);
    const t = harness();
    const old = message(VETERAN, -40);
    t.h.history.push(old);
    let release = () => {};
    t.h.seedGate = new Promise((done) => (release = done));
    const seeding = new Promise<void>((done) => (t.h.seeding = done));
    const starting = t.responder.start();
    await seeding;
    const intro = message(MEMBER, 0);
    await t.say(intro);
    await t.responder.tick();
    expect(row()).toBeNull();
    expect(t.h.extracts).toEqual([]);

    release();
    await starting;
    expect(row()?.messages[0]?.id).toBe(intro.id);
    expect(tombstone(VETERAN)).toEqual({ joined_at: null });
    await t.say(message(VETERAN, 1, { content: "Long-time lurker, finally saying hi" }));
    expect(row(VETERAN)).toBeNull();
  });
});

describe("the member lookup (§3)", () => {
  it("starts nothing when it gives no joined_at, and logs ids alone", async () => {
    const { h, say } = await started();
    h.members.set(MEMBER, { joinedAt: null, names: ["Secret Name"] });
    const intro = message(MEMBER, 0);
    await say(intro);
    expect(row()).toBeNull();
    expect(h.extracts).toEqual([]);
    expect(h.logs).toContain(
      `[responder] member ${MEMBER} message ${intro.id}: the lookup gave no joined_at, so not evaluated`,
    );
    expect(h.logs.join("\n")).not.toMatch(/Secret Name|oak furniture/);
  });
});

describe("matching (§4)", () => {
  it("sends the query built from the extraction, under the derived origin, and never the intro's text", async () => {
    const { h, responder, say } = await started();
    h.extraction = { signal: "some", interests: ["woodworking"], topics: ["gaming"], life_stage: ["toddler"] };
    await say(message(MEMBER, 0));
    h.clock = at(21);
    await responder.tick();
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]!.sources).toEqual([
      {
        authorId: MEMBER,
        authorIsBot: false,
        content: "toddler, Gaming, woodworking",
        origin: { derivedFromIntroduction: MEMBER },
      },
    ]);
    expect(JSON.stringify(h.asks)).not.toContain("oak");
  });

  it("never shows the model a place the Member role cannot see (#53)", async () => {
    const { h, responder, say } = await started();
    h.extraction = { signal: "some", interests: ["woodworking"], topics: [], life_stage: [] };
    await say(message(MEMBER, 0));
    h.clock = at(21);
    await responder.tick();
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]!.context).toContain("woodshop");
    expect(h.asks[0]!.context).not.toContain("staffroom");
  });

  it("never shows the model a place Staff denied this member by name (#53)", async () => {
    const { h, responder, say } = await started();
    h.denied.set(MEMBER, new Set([woodshop.id]));
    h.extraction = { signal: "some", interests: ["woodworking"], topics: [], life_stage: [] };
    await say(message(MEMBER, 0));
    h.clock = at(21);
    await responder.tick();
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]!.context).toContain("gliders");
    expect(h.asks[0]!.context).not.toContain("woodshop");
  });
});

describe("images (§4)", () => {
  it("never reach matching: a text-and-image intro matches on its words alone", async () => {
    const { h, responder, say } = await started();
    await say(message(MEMBER, 0, { embeds: [gif] }));
    expect(h.readings).toHaveLength(1);
    h.clock = at(21);
    await responder.tick();
    expect(h.asks[0]!.sources?.map((s) => s.content)).toEqual(["woodworking"]);
    expect(JSON.stringify(h.asks.map((a) => [a.context, a.sources]))).not.toMatch(/data:image|greeting|meme/);
    expect(h.writes[0]!.body.content).toContain("images 1 · image: greeting");
  });

  it("make an image-only intro a greeting: one question, no extraction, no match", async () => {
    const { h, responder, say } = await started();
    await say(message(MEMBER, 0, { content: "", embeds: [gif] }));
    h.clock = at(10);
    await responder.tick();
    expect(h.extracts).toEqual([]);
    expect(h.asks).toEqual([]);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.body.content).toContain("would POST question");
  });
});

describe("the invited path (§9)", () => {
  const sherpa = { id: SHERPA, username: "Papa Sherpa", discriminator: "0", global_name: null, avatar: null };
  const mention = (author: string, minutes: number, content = `<@${SHERPA}> anything for me?`) =>
    message(author, minutes, { content, mentions: [sherpa] });
  const invitation = (member = MEMBER) => store((s) => s.invitation(member));
  const posted = (h: ReturnType<typeof harness>["h"]) =>
    h.writes.map((w) => /would POST (\w+)/.exec(w.body.content ?? "")?.[1]);

  it("answers after a closed row or a tombstone, in #bot-tests alone, and leaves a watched member to their watch", async () => {
    const { h, say } = await started();
    const closed = message(MEMBER, -20);
    h.history.push(closed);
    store((s) => s.startIntroduction(MEMBER, { messageId: closed.id, editedAt: null, joinedAt: JOINED }));
    store((s) => s.closeIntroduction(MEMBER, "failed", "error"));
    store((s) => s.seedTombstones([OTHER]));
    await say(message(VETERAN, 0));

    await say(mention(MEMBER, 1));
    await say(mention(OTHER, 2));
    const asked = mention(VETERAN, 3);
    await say(asked);
    expect(posted(h)).toEqual(["invited_recommend", "invited_recommend"]);
    expect(h.writes.map((w) => w.channelId)).toEqual([SHADOW_CHANNEL, SHADOW_CHANNEL]);
    expect(invitation(VETERAN)).toBeNull();
    expect(row(VETERAN)?.messages.map((m) => m.id)).toContain(asked.id);
  });

  it("answers processing off with the fixed text alone: no row, no claim, no model call", async () => {
    withDurableStore((s) => s.setPreference(QUIET, "processing", false), path);
    const { h, say } = await started();
    await say(mention(QUIET, 1));
    expect(posted(h)).toEqual(["processing_off"]);
    expect(invitation(QUIET)).toBeNull();
    expect([...h.extracts, ...h.readings, ...h.asks]).toEqual([]);
  });

  it("makes no call when the member lookup finds nobody, for words or an image alone", async () => {
    const { h, say } = await started();
    h.members.set(MEMBER, null);
    await say(mention(MEMBER, 1));
    await say({ ...mention(MEMBER, 2, ""), embeds: [gif] });
    expect([...h.extracts, ...h.readings, ...h.asks]).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it("keeps the first exchange's life stage in the second", async () => {
    const { h, say } = await started();
    h.extraction = { signal: "some", interests: ["woodworking"], topics: [], life_stage: ["toddler"] };
    await say(mention(MEMBER, 1));
    h.extraction = { signal: "some", interests: ["gliding"], topics: [], life_stage: [] };
    await say(mention(MEMBER, 2));
    expect(h.asks.map((a) => a.sources?.[0]?.content)).toEqual(["toddler, woodworking", "toddler, woodworking, gliding"]);
    expect(h.asks[1]!.sources?.[0]?.origin).toEqual({ derivedFromIntroduction: MEMBER });
  });

  it("forgets the conversation on an erasure, or when a message that fed it is deleted", async () => {
    const { h, responder, say } = await started();
    const exchange = async (member: string, minutes: number, extraction: Extraction) => {
      h.extraction = extraction;
      const m = mention(member, minutes);
      await say(m);
      return m;
    };
    const toddler: Extraction = { signal: "some", interests: [], topics: [], life_stage: ["toddler"] };
    const gliding: Extraction = { signal: "some", interests: ["gliding"], topics: [], life_stage: [] };
    await exchange(MEMBER, 1, toddler);
    responder.forget(MEMBER);
    await exchange(MEMBER, 2, gliding);
    const fed = await exchange(OTHER, 3, toddler);
    responder.onDelete({ channel_id: WATCHED_CHANNEL, ids: [fed.id] });
    await exchange(OTHER, 4, gliding);
    expect(h.asks.map((a) => a.sources?.[0]?.content)).toEqual(["toddler", "gliding", "toddler", "gliding"]);
  });

  it("discards a call that resolves after an erasure: nothing is posted", async () => {
    const { h, responder, say } = await started();
    let release = () => {};
    h.askGate = new Promise((done) => (release = done));
    const asked = new Promise<void>((done) => (h.asked = done));
    const said = say(mention(MEMBER, 1));
    await asked;
    responder.forget(MEMBER);
    release();
    await said;
    expect(h.writes).toEqual([]);
  });

  it("ends with the widest doors, and answers a fourth mention with the fixed text and no call", async () => {
    const { h, say } = await started();
    for (let minute = 1; minute <= 4; minute++) await say(mention(MEMBER, minute));
    expect(posted(h)).toEqual(["invited_recommend", "invited_recommend", "widest_doors", "after_cap"]);
    expect(h.writes[2]!.body.content).toContain("<https://sherpa.omgod.com>");
    expect(h.extracts).toHaveLength(3);
    expect(h.asks).toHaveLength(3);
    expect(invitation()?.exchanges).toBe(3);
  });

  it("never names a place Staff denied this member by name, on any exchange (#53)", async () => {
    const { h, say } = await started();
    h.denied.set(MEMBER, new Set([woodshop.id]));
    for (let minute = 1; minute <= 3; minute++) await say(mention(MEMBER, minute));
    expect(posted(h)).toEqual(["invited_recommend", "invited_recommend", "widest_doors"]);
    expect(h.asks.every((a) => a.context?.includes("gliders") && !a.context.includes("woodshop"))).toBe(true);
    expect(h.writes.map((w) => w.body.content).join("\n")).not.toContain(woodshop.id);
  });

  it("drops the conversation when the third exchange's post fails", async () => {
    const { h, say } = await started();
    await say(mention(MEMBER, 1));
    await say(mention(MEMBER, 2));
    const third = mention(MEMBER, 3);
    h.sendFails = true;
    await say(third);
    h.sendFails = false;
    expect(h.asks).toHaveLength(3);
    // A held conversation would swallow the redelivered event as already answered; a dropped one answers it.
    await say(third);
    expect(posted(h)).toEqual(["invited_recommend", "invited_recommend", "after_cap"]);
  });

  it("never takes an edit for an ask", async () => {
    const { h, responder } = await started();
    await responder.onMessage({ ...mention(MEMBER, 1), edited_timestamp: new Date(at(2)).toISOString() }, true);
    expect(h.writes).toEqual([]);
    expect(invitation()).toBeNull();
  });
});
