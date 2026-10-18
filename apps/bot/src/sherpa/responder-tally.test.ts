import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDurableStore } from "../sync/durable-store.ts";
import { SHADOW_CHANNEL } from "./responder.ts";
import { type TallyDeps, type TallyMessage, runTally } from "./responder-tally.ts";
import { openResponderStore } from "./responder-store.ts";

const BOT = "900000000000000001";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "responder-tally-"));
  path = join(dir, "bot.db");
  initDurableStore(path, { exclusionSeed: null, catalog: null, roleManifest: null });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
const header = (kind: string) => `Intro responder (shadow) · would POST ${kind} · replying to: https://x/y\nTimeline: …`;
const post = (kind: string, reactions: Record<string, number> = { "✅": 1 }, author = BOT): TallyMessage => ({
  id: String(1_000_000 + seq++),
  author: { id: author } as TallyMessage["author"],
  content: header(kind),
  reactions: Object.entries(reactions).map(([name, count]) => ({ emoji: { name }, count })) as TallyMessage["reactions"],
});
const good = (n: number, kind = "question") => Array.from({ length: n }, () => post(kind));

/** A fake Channel that pages 100 at a time, newest first, over `all`. */
const world = (all: TallyMessage[], daysIn: number | null = 14) => {
  const sent: Array<{ channel: string; body: { content?: string; allowed_mentions?: unknown } }> = [];
  const store = openResponderStore(path);
  if (daysIn !== null) store.setMode("shadow", "t", new Date(T0));
  store.close();
  const state = { all, monitored: new Set<string>(), fail: false };
  const deps: TallyDeps = {
    messages: async (channel, before) => {
      expect(channel).toBe(SHADOW_CHANNEL);
      if (state.fail) throw new Error("Discord 503");
      return [...state.all]
        .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)))
        .filter((m) => before === undefined || BigInt(m.id) < BigInt(before))
        .slice(0, 100);
    },
    botId: BOT,
    now: () => T0 + (daysIn ?? 0) * DAY,
    store: (work) => {
      const s = openResponderStore(path);
      try {
        return work(s);
      } finally {
        s.close();
      }
    },
    monitored: () => state.monitored,
    createMessage: async (channel, body) => void sent.push({ channel, body }),
    log: () => {},
  };
  const mode = () => {
    const s = openResponderStore(path);
    try {
      return s.mode();
    } finally {
      s.close();
    }
  };
  return { deps, sent, state, mode };
};

describe("the go-live bar", () => {
  it("is reached at 14 days, 30 autonomous posts, no warning, 80% approved", async () => {
    const { deps } = world(good(30));
    expect((await runTally(deps)).tally.met).toBe(true);
  });

  it("is not reached at 13 days", async () => {
    expect((await runTally(world(good(30), 13).deps)).tally.met).toBe(false);
  });

  it("is not reached at 29 posts", async () => {
    expect((await runTally(world(good(29)).deps)).tally.met).toBe(false);
  });

  it("is blocked by one warning, on an invited reply too", async () => {
    const warned = (kind: string) => world([...good(40), post(kind, { "✅": 5, "⚠️": 1 })]).deps;
    expect((await runTally(warned("recommend"))).tally.met).toBe(false);
    expect((await runTally(warned("invited_question"))).tally.met).toBe(false);
  });

  it("is not reached at 79% approved, and is at 80%", async () => {
    const mix = (approved: number) => [...good(approved), ...Array.from({ length: 100 - approved }, () => post("question", { "❌": 1 }))];
    expect((await runTally(world(mix(79)).deps)).tally.met).toBe(false);
    expect((await runTally(world(mix(80)).deps)).tally.met).toBe(true);
  });

  it("does not count invited replies toward the 30", async () => {
    const { tally } = await runTally(world([...good(29), ...good(10, "invited_recommend")]).deps);
    expect(tally.autonomous.posts).toBe(29);
    expect(tally.invited.posts).toBe(10);
    expect(tally.met).toBe(false);
  });

  it("reads every page, and ignores other authors, the notice, and unreviewed posts", async () => {
    const stray = [post("question", { "✅": 9 }, "someone-else"), { ...post("question"), content: "The go-live bar is reached." }];
    const { tally } = await runTally(world([...good(120), ...stray, post("question", {})]).deps);
    expect(tally.autonomous).toMatchObject({ posts: 121, approved: 120, yes: 120 });
  });

  it("is not reached if shadow was never set", async () => {
    expect((await runTally(world(good(30), null).deps)).tally).toMatchObject({ days: null, met: false });
  });
});

describe("the go-live notice", () => {
  it("posts once to #bot-tests with no mentions, and never changes the mode", async () => {
    const { deps, sent, mode } = world(good(30));
    expect((await runTally(deps)).posted).toBe(true);
    expect((await runTally(deps)).posted).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe(SHADOW_CHANNEL);
    expect(sent[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(mode()).toBe("shadow");
  });

  it("is not posted before the bar is reached", async () => {
    const { deps, sent } = world(good(29));
    expect((await runTally(deps)).posted).toBe(false);
    expect(sent).toEqual([]);
  });

  it("is not posted, nor recorded, if #bot-tests is monitored", async () => {
    const { deps, sent, state } = world(good(30));
    state.monitored.add(SHADOW_CHANNEL);
    await expect(runTally(deps)).rejects.toThrow(/monitored/);
    expect(sent).toEqual([]);
    expect(deps.store((s) => s.setting("shadow_notice_at"))).toBeNull();
  });

  it("is not posted a second time after a send that failed", async () => {
    const { deps, state } = world(good(30));
    await expect(runTally({ ...deps, createMessage: async () => Promise.reject(new Error("503")) })).rejects.toThrow();
    expect((await runTally(deps)).posted).toBe(false);
    state.fail = true;
    await expect(runTally(deps)).rejects.toThrow(/503/);
  });
});
