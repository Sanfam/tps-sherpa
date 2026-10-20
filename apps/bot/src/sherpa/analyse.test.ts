import { ChannelType } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import type { ModerationMessage } from "../llm/boundary.ts";
import type { Entity } from "../sync/catalog.ts";
import type { Report } from "../llm/moderation.ts";
import { type AnalyseDeps, createAnalyse } from "./analyse.ts";

const MEMBER_ROLE = "2";
const SUBJECT = "500000000000000001";
const place = (id: string, view: string[]): Entity =>
  ({ id, name: `p${id}`, type: "channel", parent_id: null, description_status: "present", allow_roles: [], view_roles: view, deny_roles: [] }) as unknown as Entity;
const general = place("10", [MEMBER_ROLE]);
const staffOnly = place("12", ["4"]);

const msg = (id: string, channel_id: string) => ({
  id,
  channel_id,
  author: { id: SUBJECT, username: "departed-name", global_name: "Departed Display" },
  content: `text ${id}`,
  timestamp: "2026-10-01T00:00:00.000Z",
});

const ask = (since: string | null = null, fresh = false) => ({ since, fresh, by: "9" });

const harness = (
  over: Partial<AnalyseDeps["discord"]> & {
    chunk?: (call: number) => Promise<never> | undefined;
    report?: Partial<Report>;
    notes?: string;
    excluded?: string[];
    recent?: string;
    retrying?: AnalyseDeps["retrying"];
    lastReview?: string;
    writable?: boolean;
    postFails?: boolean;
  } = {},
) => {
  const posted: Array<{ memberId: string; by: string; content: string; embeds: import("discord-api-types/v10").APIEmbed[] }> = [];
  const sent: ModerationMessage[][] = [];
  const names: string[] = [];
  let chunkCalls = 0;
  let taken = 0;
  let clock = Date.parse("2026-10-19T00:00:00.000Z");
  const deps: AnalyseDeps = {
    guildId: "1",
    discord: {
      search: async () =>
        ({
          total_results: 4,
          doing_deep_historical_index: false,
          messages: [
            [msg("900000000000000004", general.id)],
            [msg("900000000000000003", staffOnly.id)],
            [msg("900000000000000002", "20")],
            [msg("900000000000000001", "21")],
          ],
          threads: [
            { id: "20", type: ChannelType.PublicThread, parent_id: general.id },
            { id: "21", type: ChannelType.PrivateThread, parent_id: general.id },
          ],
        }) as never,
      member: async () => ({ joinedAt: "2026-01-01T00:00:00.000Z", names: ["s"] }),
      message: async () => null,
      ...over,
    },
    session: () => ({
      catalog: [general, staffOnly],
      memberRoles: [MEMBER_ROLE],
      excluded: new Set(over.excluded ?? []),
      boundary: {
        analyseChunk: async (who, messages) => {
          names.push(...who.memberNames);
          chunkCalls++;
          const forced = over.chunk?.(chunkCalls);
          if (forced) return forced;
          sent.push([...messages]);
          return { events: [{ at: 0, kind: "contribution", note: "Helped" }], tone: [] };
        },
        analyseReduce: async () => ({
          timeline: [],
          key_events: [0],
          recent: over.recent ?? "Calm.",
          trend: "stable",
          notes: over.notes ?? "None.",
          actions: [],
          ...over.report,
        }),
      },
    }),
    forum: {
      writable: () => over.writable ?? true,
      last: async () => over.lastReview ?? null,
      post: async (memberId, by, content, embeds) => {
        if (over.postFails) throw new Error("locked");
        posted.push({ memberId, by, content, embeds });
        return "https://discord.com/channels/1/77/88";
      },
    },
    retrying: over.retrying ?? ((work) => work()),
    cap: { take: () => (taken++, true) },
    now: () => clock,
    log: () => {},
  };
  const advance = (ms: number) => (clock += ms);
  return { analyse: createAnalyse(deps), sent, names, posted, chunkCalls: () => chunkCalls, taken: () => taken, advance };
};

describe("/sherpa analyse", () => {
  it("sends only messages from places a Member can see, public Threads under them included, and links what it cites", async () => {
    const { analyse, sent, posted } = harness();
    await analyse({ id: SUBJECT }, ask(), async () => {}, "t");
    expect(sent.flat().map((m) => m.source.content)).toEqual(["text 900000000000000002", "text 900000000000000004"]);
    expect(sent.flat().map((m) => m.source.origin)).toEqual([general.id, general.id]);
    const embeds = posted[0]!.embeds;
    // Message 0 is the oldest kept: in the public Thread, linked there.
    expect(embeds[1]!.description).toContain("https://discord.com/channels/1/20/900000000000000002");
    expect(embeds[0]!.footer!.text).toContain("2 messages in places Sherpa doesn't review");
  });

  it("takes one run from the cap, once per member an hour, and refuses bots", async () => {
    const { analyse, taken, advance } = harness();
    expect(await analyse({ id: "7", bot: true }, ask(), async () => {}, "t")).toMatch(/bots/);
    await analyse({ id: SUBJECT }, ask(), async () => {}, "t");
    expect(await analyse({ id: SUBJECT }, ask(), async () => {}, "t")).toMatch(/One review per member an hour/);
    advance(60 * 60 * 1000);
    await analyse({ id: SUBJECT }, ask(), async () => {}, "t");
    expect(taken()).toBe(2);
  });
});

describe("/sherpa analyse edge cases", () => {
  it("refuses a date that is not on the calendar, rather than reading everything", async () => {
    const { analyse, taken } = harness();
    for (const since of ["2026-02-30", "2026-99-99"])
      expect(await analyse({ id: SUBJECT }, ask(since), async () => {}, "t")).toMatch(/Give `since` as a date/);
    expect(taken()).toBe(0);
  });

  it("redacts a member who has left by the names on their own messages", async () => {
    const { analyse, names } = harness({ member: async () => null });
    await analyse({ id: SUBJECT }, ask(), async () => {}, "t");
    expect(names).toEqual(expect.arrayContaining(["departed-name", "Departed Display"]));
  });

  it("fails, showing nothing, when a call outlasts the run's ceiling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { analyse } = harness({ chunk: () => new Promise<never>(() => {}) });
      const answer = analyse({ id: SUBJECT }, ask(), async () => {}, "t");
      await vi.advanceTimersByTimeAsync(12 * 60 * 1000 + 1);
      expect(await answer).toMatch(/The review failed/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("/sherpa analyse, reading and limits", () => {
  it("reads past a short page, which search may return with more behind it", async () => {
    const pages = [["900000000000000009", "900000000000000008"], ["900000000000000007"], []];
    let call = 0;
    const { analyse, sent } = harness({
      search: async () =>
        ({ total_results: 3, doing_deep_historical_index: false, messages: pages[call++]!.map((id) => [msg(id, general.id)]) }) as never,
    });
    await analyse({ id: SUBJECT }, ask(), async () => {}, "t");
    expect(sent.flat()).toHaveLength(3);
  });

  it("starts no retry once the run's ceiling has passed", async () => {
    let clockAdvance: (ms: number) => void = () => {};
    const h = harness({
      chunk: async () => {
        clockAdvance(13 * 60 * 1000);
        throw new Error("timed out");
      },
      retrying: async (work) => {
        try {
          return await work();
        } catch {
          return await work();
        }
      },
    });
    clockAdvance = h.advance;
    expect(await h.analyse({ id: SUBJECT }, ask(), async () => {}, "t")).toMatch(/The review failed/);
    expect(h.chunkCalls()).toBe(1);
  });

  it("fits a field after escaping, which can double it", async () => {
    const { analyse, posted } = harness({ notes: "-".repeat(600) });
    await analyse({ id: SUBJECT }, ask(), async () => {}, "t");
    const notes = posted[0]!.embeds[0]!.fields!.find((f) => f.name === "Notes")!.value;
    expect(notes.length).toBeLessThanOrEqual(1024);
  });
});

describe("/sherpa analyse, third pass", () => {
  const run = (h: ReturnType<typeof harness>, id = SUBJECT) => h.analyse({ id }, ask(), async () => {}, "t");

  it("returns a report within Discord's limits however full every field is", async () => {
    const full = "-".repeat(600);
    const h = harness({
      report: {
        recent: full,
        notes: full,
        timeline: Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, "0")}`, line: "-".repeat(160) })),
        actions: ["-".repeat(160), "-".repeat(160), "-".repeat(160)],
      },
    });
    await run(h);
    const text = h.posted[0]!.embeds.map((e) => [e.title, e.description, e.footer?.text, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])].join("")).join("");
    expect(text.length).toBeLessThanOrEqual(6000);
  });

  it("never passes a message in an excluded Thread off as its parent's", async () => {
    const h = harness({ excluded: ["20"] });
    await run(h);
    expect(h.sent.flat().map((m) => m.source.content)).toEqual(["text 900000000000000004"]);
  });

  it("says when Discord was still indexing older messages", async () => {
    const h = harness({
      search: async () => ({ total_results: 1, doing_deep_historical_index: true, messages: [[msg("900000000000000004", general.id)]] }) as never,
    });
    await run(h);
    expect(h.posted[0]!.embeds[0]!.footer!.text).toContain("still indexing");
  });

  it("holds the gate while a sibling call still runs after another failed", async () => {
    const many = Array.from({ length: 450 }, (_, i) => `9${String(i).padStart(17, "0")}`);
    const h = harness({
      search: async (q) =>
        ({ total_results: 450, doing_deep_historical_index: false, messages: many.slice(q.offset ?? 0, (q.offset ?? 0) + 25).map((id) => [msg(id, general.id)]) }) as never,
      chunk: (call) => (call === 1 ? Promise.reject(new Error("bad answer")) : call === 2 ? new Promise<never>(() => {}) : undefined),
    });
    expect(await run(h)).toMatch(/The review failed/);
    expect(await run(h, "500000000000000003")).toMatch(/Another review is running/);
  });
});

describe("/sherpa analyse, in full view (owner, 2026-10-20)", () => {
  it("posts the review to the member's Post, naming who asked, and answers with its link", async () => {
    const h = harness();
    const answer = await h.analyse({ id: SUBJECT }, ask(), async () => {}, "t");
    expect(answer).toContain("https://discord.com/channels/1/77/88");
    expect(h.posted.map((p) => [p.memberId, p.content])).toEqual([[SUBJECT, `Review of <@${SUBJECT}>, requested by <@9>.`]]);
  });

  it("links a review from the last 14 days instead of running, unless fresh or narrowed by date", async () => {
    const h = harness({ lastReview: "https://discord.com/channels/1/77/55" });
    expect(await h.analyse({ id: SUBJECT }, ask(), async () => {}, "t")).toContain("https://discord.com/channels/1/77/55");
    expect([h.taken(), h.chunkCalls()]).toEqual([0, 0]);
    await h.analyse({ id: SUBJECT }, ask(null, true), async () => {}, "t");
    h.advance(60 * 60 * 1000);
    await h.analyse({ id: SUBJECT }, ask("2026-02-01"), async () => {}, "t");
    expect(h.taken()).toBe(2);
    // A narrowed review is titled apart, so it is never later linked as a whole one.
    expect(h.posted.map((p) => p.embeds[0]!.title)).toEqual(["Member review", "Member review since 2026-02-01"]);
  });

  it("runs nothing, and spends nothing, while the Post cannot be written", async () => {
    const h = harness({ writable: false });
    expect(await h.analyse({ id: SUBJECT }, ask(), async () => {}, "t")).toMatch(/can't post there/);
    expect(h.taken()).toBe(0);
  });

  it("shows a review that could not be posted to the one who asked, rather than losing it", async () => {
    const h = harness({ postFails: true });
    const answer = await h.analyse({ id: SUBJECT }, ask(), async () => {}, "t");
    expect(typeof answer === "string" ? null : [answer.content, answer.embeds[0]!.title]).toEqual([
      expect.stringContaining("couldn't be posted"),
      "Member review",
    ]);
  });
});
