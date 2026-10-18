import { MessageType } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
  type IntroCandidate,
  type ShadowTimeline,
  type Timeline,
  type TimingSettings,
  countsAsIntroduction,
  decide,
  novelty,
  shadowPost,
} from "./responder-decide.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-20T03:23:00.000Z");
const at = (minutes: number) => T0 + minutes * MIN;
/** Every minute from `from` to `to` (minutes after the intro) has another member active. */
const busy = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => Math.floor(at(from + i) / MIN));

const defaults = { greetMinutes: 10, recommendMinutes: 20, ceilingActiveHours: 6 };
const settings = (clock: TimingSettings["clock"]): TimingSettings => ({ clock, ...defaults });
const timeline = (over: Partial<Timeline> = {}): Timeline => ({
  intro: { at: T0, signal: true },
  followUps: [],
  askedByHuman: false,
  activeMinutes: [],
  ...over,
});
const at_ = (t: Timeline, clock: TimingSettings["clock"], minutes: number) =>
  decide(t, settings(clock), at(minutes));
const post = (kind: string) => ({ action: "post", kind });
const wait = { action: "wait" };

describe("decide: the golden cases (§3)", () => {
  it("HammerFoe: signal in the intro recommends at the recommend threshold, counted in either clock", () => {
    const t = timeline({ activeMinutes: busy(1, 40) });
    for (const clock of ["wall", "active"] as const) {
      expect(at_(t, clock, 19)).toEqual(wait);
      expect(at_(t, clock, 20)).toEqual(post("recommend"));
    }
  });

  it("Rat. with signal, overnight: wall posts at 20 minutes, active stays silent until humans are", () => {
    const t = timeline();
    expect(at_(t, "wall", 20)).toEqual(post("recommend"));
    expect(at_(t, "active", 20)).toEqual(wait);
    expect(at_(t, "active", 300)).toEqual(wait);
    // Humans wake at +280: twenty active minutes later, the post is due.
    const morning = timeline({ activeMinutes: busy(281, 310) });
    expect(at_(morning, "active", 299)).toEqual(wait);
    expect(at_(morning, "active", 301)).toEqual(post("recommend"));
  });

  it("Rat. with no signal, overnight: the question at 10 wall minutes, never in an empty room on the active clock", () => {
    const t = timeline({ intro: { at: T0, signal: false } });
    expect(at_(t, "wall", 10)).toEqual(post("question"));
    expect(at_(t, "active", 10)).toEqual(wait);
    expect(at_(t, "active", 200)).toEqual(wait);
  });

  it("Mark Weigl: a human's question holds back Sherpa's question; it then waits for late signal", () => {
    const quiet = timeline({ intro: { at: T0, signal: false }, askedByHuman: true, activeMinutes: busy(1, 200) });
    for (const clock of ["wall", "active"] as const) {
      expect(at_(quiet, clock, 10)).toEqual(wait);
      expect(at_(quiet, clock, 90)).toEqual(wait);
    }
    // His reply at +90 carries signal: the recommend clock starts there, not at the intro.
    const replied = { ...quiet, followUps: [{ at: at(90), signal: true }] };
    for (const clock of ["wall", "active"] as const) {
      expect(at_(replied, clock, 109)).toEqual(wait);
      expect(at_(replied, clock, 110)).toEqual(post("recommend"));
    }
  });

  it("Zifei: nothing to match on and nobody asked: one question at the greet threshold, both clocks", () => {
    const t = timeline({ intro: { at: T0, signal: false }, activeMinutes: busy(1, 30) });
    for (const clock of ["wall", "active"] as const) {
      expect(at_(t, clock, 9)).toEqual(wait);
      expect(at_(t, clock, 10)).toEqual(post("question"));
    }
  });

  it("an image-only intro takes the same path: its signal is false, so the question", () => {
    // The caller marks an image-only message signal:false (§4); that is all decide sees.
    const t = timeline({ intro: { at: T0, signal: false }, followUps: [{ at: at(2), signal: false }] });
    expect(at_(t, "wall", 10)).toEqual(post("question"));
  });

  it("later signal restarts the recommend clock from that message, and a later signal-free message does not move it", () => {
    const t = timeline({
      followUps: [
        { at: at(15), signal: true },
        { at: at(30), signal: false },
      ],
    });
    expect(at_(t, "wall", 34)).toEqual(wait);
    expect(at_(t, "wall", 35)).toEqual(post("recommend"));
  });
});

describe("decide: the ceiling and the hard stop", () => {
  it("the ceiling posts the warm welcome after six active hours, even on the wall clock, when nothing else fired", () => {
    const t = timeline({
      intro: { at: T0, signal: false },
      askedByHuman: true,
      activeMinutes: busy(1, 400),
    });
    for (const clock of ["wall", "active"] as const) {
      expect(at_(t, clock, 359)).toEqual(wait);
      expect(at_(t, clock, 360)).toEqual(post("welcome_only"));
    }
  });

  it("the ceiling beats a recommend that falls due in the same check", () => {
    // Signal at +340 falls due at +360, the same minute the ceiling does.
    const t = timeline({ followUps: [{ at: at(340), signal: true }], activeMinutes: busy(1, 400) });
    expect(at_(t, "wall", 361)).toEqual(post("welcome_only"));
  });

  it("the hard stop at 24 wall hours posts the warm welcome when too few humans were active to reach the ceiling", () => {
    const t = timeline({ intro: { at: T0, signal: false }, askedByHuman: true, activeMinutes: busy(1, 30) });
    for (const clock of ["wall", "active"] as const) {
      expect(at_(t, clock, 24 * 60 - 1)).toEqual(wait);
      expect(at_(t, clock, 24 * 60)).toEqual(post("welcome_only"));
    }
  });

  it("the ceiling is a Staff setting", () => {
    const t = timeline({ intro: { at: T0, signal: false }, askedByHuman: true, activeMinutes: busy(1, 120) });
    expect(decide(t, { ...settings("wall"), ceilingActiveHours: 1 }, at(59))).toEqual(wait);
    expect(decide(t, { ...settings("wall"), ceilingActiveHours: 1 }, at(60))).toEqual(post("welcome_only"));
  });
});

const message = (over: Partial<IntroCandidate> = {}): IntroCandidate => ({
  type: MessageType.Default,
  content: "Hi all, I'm new",
  author: { id: "1", bot: false } as IntroCandidate["author"],
  mentions: [],
  message_reference: undefined,
  attachments: [],
  embeds: [],
  ...over,
});

describe("countsAsIntroduction (F2)", () => {
  it("counts a plain first message", () => {
    expect(countsAsIntroduction(message(), false)).toBe(true);
  });

  it("does not count a reply, however it is marked", () => {
    expect(countsAsIntroduction(message({ type: MessageType.Reply }), false)).toBe(false);
    expect(countsAsIntroduction(message({ message_reference: { message_id: "9", channel_id: "8" } }), false)).toBe(false);
  });

  it("does not count a message that mentions another member, but a mention of oneself is fine", () => {
    const other = { id: "2" } as IntroCandidate["mentions"][number];
    const self = { id: "1" } as IntroCandidate["mentions"][number];
    expect(countsAsIntroduction(message({ mentions: [other] }), false)).toBe(false);
    expect(countsAsIntroduction(message({ mentions: [self] }), false)).toBe(true);
  });

  it("does not count an author who has posted before", () => {
    expect(countsAsIntroduction(message(), true)).toBe(false);
  });

  it("starts nothing for an empty or sticker-only message", () => {
    expect(countsAsIntroduction(message({ content: "" }), false)).toBe(false);
    expect(countsAsIntroduction(message({ content: "  \n" }), false)).toBe(false);
    // A sticker rides in `sticker_items`, which the test never reads: no words, no image.
    expect(countsAsIntroduction(message({ content: "", sticker_items: [{ id: "5" }] } as never), false)).toBe(false);
    expect(
      countsAsIntroduction(message({ content: "", attachments: [{ content_type: "application/pdf" }] as never }), false),
    ).toBe(false);
  });

  it("counts an image-only message, an attachment or a GIF link's embed", () => {
    const attachment = [{ content_type: "image/png" }] as never;
    expect(countsAsIntroduction(message({ content: "", attachments: attachment }), false)).toBe(true);
    expect(countsAsIntroduction(message({ content: "", embeds: [{ type: "gifv" }] as never }), false)).toBe(true);
  });

  it("does not count a bot", () => {
    const bot = { id: "1", bot: true } as IntroCandidate["author"];
    expect(countsAsIntroduction(message({ author: bot }), false)).toBe(false);
  });
});

describe("novelty (§4)", () => {
  const ids = ["111", "222", "333", "444"];

  it("drops a place named as a mention or as a channel link, and keeps the rest in order", () => {
    expect(
      novelty(ids, [
        "you should try <#222> for that",
        "also https://discord.com/channels/1055290132250501135/444 is good",
      ]),
    ).toEqual(["111", "333"]);
  });

  it("counts a link to a message inside a place as naming the place", () => {
    expect(novelty(ids, ["https://discord.com/channels/1055290132250501135/333/999999999999999999"])).toEqual([
      "111",
      "222",
      "444",
    ]);
  });

  it("does not take the guild or message id of a link for a place", () => {
    expect(novelty(["1055290132250501135", "999"], ["https://discord.com/channels/1055290132250501135/5/999"])).toEqual([
      "1055290132250501135",
      "999",
    ]);
  });

  it("keeps everything when nobody named anything, and drops everything when they named all", () => {
    expect(novelty(ids, ["welcome!", "which game?"])).toEqual(ids);
    expect(novelty(ids, ["<#111> <#222> <#333> <#444>"])).toEqual([]);
  });
});

describe("shadowPost (§8)", () => {
  const base: ShadowTimeline = {
    clock: "active",
    acknowledgedAfterMinutes: 2,
    activeMinutes: 20,
    extractions: 1,
    noveltyDropped: 1,
    images: 1,
    imageMeaning: "greeting",
  };
  const link = "https://discord.com/channels/1/2/3";

  it("is the §8 format, quoting every line of the live reply", () => {
    expect(shadowPost({ kind: "recommend", replyingTo: link, timeline: base, reply: "Welcome!\n\n• <#5>" })).toBe(
      [
        `Intro responder (shadow) · would POST recommend · replying to: ${link}`,
        "Timeline: clock active · acknowledged +2m · active minutes 20 · extractions 1 · novelty dropped 1 · images 1 · image: greeting",
        "Would post:",
        "> Welcome!",
        ">",
        "> • <#5>",
      ].join("\n"),
    );
  });

  it("omits the image label with no image, and says when nobody acknowledged", () => {
    const out = shadowPost({
      kind: "question",
      replyingTo: link,
      timeline: { ...base, acknowledgedAfterMinutes: null, images: 0, imageMeaning: null },
      reply: "x",
    });
    expect(out).toContain("acknowledged none · active minutes 20 · extractions 1 · novelty dropped 1 · images 0\n");
    expect(out).not.toContain("image:");
  });

  it("prints only an enum label for an image reading: model text such as a name or a meme's source never gets out", () => {
    const out = shadowPost({
      kind: "question",
      replyingTo: link,
      timeline: { ...base, imageMeaning: "Dave from the Hazmat Suit meme" as never },
      reply: "x",
    });
    expect(out).toContain("image: other");
    expect(out).not.toContain("Dave");
    expect(out).not.toContain("Hazmat");
  });
});
