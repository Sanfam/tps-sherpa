import { describe, expect, it } from "vitest";
import type { Entity } from "../sync/catalog.ts";
import { type ChatPort, type ModerationMessage, type ModerationSubject, createBoundary } from "./boundary.ts";

const MEMBER_ROLE = "2";
const STAFF_ROLE = "4";
const SUBJECT = "500000000000000001";
const OTHER = "500000000000000002";

const entity = (over: Partial<Entity> & { id: string; name: string }): Entity => ({
  type: "channel",
  url: `https://discord.com/channels/1/${over.id}`,
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
  allow_roles: [],
  view_roles: [MEMBER_ROLE, STAFF_ROLE],
  deny_roles: [],
  ...over,
});

const general = entity({ id: "10", name: "general" });
const intros = entity({ id: "11", name: "introductions" });
const staffOnly = entity({ id: "12", name: "staff-chat", view_roles: [STAFF_ROLE] });
const withheld = entity({ id: "13", name: "quiet", description_status: "withheld" });
const underStaff = entity({ id: "14", name: "a thread", type: "thread", parent_id: staffOnly.id });

const fixture = (reply: string, optedOut: string[] = []) => {
  const calls: string[] = [];
  const chat: ChatPort = {
    complete: async ({ user }) => {
      calls.push(user);
      return reply;
    },
  };
  const boundary = createBoundary({
    chat,
    models: { strong: "s", cheap: "c" },
    catalog: [general, intros, staffOnly, withheld, underStaff],
    // The responder's carve-out: the subject's own words there are admitted (O4).
    monitored: new Set([intros.id]),
    names: { channels: new Map(), roles: new Map() },
    hasOptedOut: (id) => optedOut.includes(id),
  });
  return { boundary, calls };
};

const subject: ModerationSubject = {
  memberId: SUBJECT,
  memberNames: ["Jughfer"],
  otherNames: ["Wilbur"],
  memberRoles: [MEMBER_ROLE],
};

const message = (n: number, over: Partial<ModerationMessage["source"]> = {}, repliesTo?: ModerationMessage["repliesTo"]): ModerationMessage => ({
  n,
  date: "2026-10-01",
  place: "general",
  source: { authorId: SUBJECT, authorIsBot: false, content: "Jughfer here, loving the raid nights", origin: general.id, ...over },
  ...(repliesTo ? { repliesTo } : {}),
});

const CHUNK = '{"events":[{"at":0,"kind":"contribution","note":"Organised a raid"}],"tone":[{"month":"2026-10","tone":"positive"}]}';

describe("the moderation origin", () => {
  it("sends the member's own messages from places a Member can see, monitored ones included, with their names replaced", async () => {
    const { boundary, calls } = fixture(CHUNK);
    await boundary.analyseChunk(subject, [message(0), message(1, { origin: intros.id })]);
    expect(calls[0]).toContain("the raid nights");
    expect(calls[0]).not.toContain("Jughfer");
  });

  it("replaces a subject's short name, which the usual rule would leave", async () => {
    const { boundary, calls } = fixture(CHUNK);
    await boundary.analyseChunk({ ...subject, memberNames: ["Al", "Q"] }, [message(0, { content: "Al here, back again, Q too" })]);
    expect(calls[0]).toContain("@member here, back again, @member too");
  });

  it("replaces a context author's name that collides with a place, yet lets the review say the word", async () => {
    const reply = { authorId: OTHER, authorIsBot: false, content: "general says hi", origin: general.id };
    const { boundary, calls } = fixture(CHUNK.replace("Organised a raid", "Posts in general"));
    const result = await boundary.analyseChunk({ ...subject, otherNames: ["general"] }, [message(0, {}, reply)]);
    expect(calls[0]).toContain("replying to another member: @member says hi");
    expect(result.events[0]!.note).toBe("Posts in general");
  });

  it("refuses another author's message, and any from a place a Member cannot see or a withheld one", async () => {
    const { boundary, calls } = fixture(CHUNK);
    for (const bad of [
      { authorId: OTHER },
      { origin: staffOnly.id },
      { origin: underStaff.id },
      { origin: withheld.id },
      { origin: "999" },
    ])
      await expect(boundary.analyseChunk(subject, [message(0, bad)])).rejects.toThrow(/Refusing/);
    expect(calls).toHaveLength(0);
  });

  it("reads the subject whatever their own opt-out, but drops an opted-out author's context, and names neither", async () => {
    const reply = { authorId: OTHER, authorIsBot: false, content: "Wilbur says hi to the newcomer", origin: general.id };
    const { boundary, calls } = fixture(CHUNK, [SUBJECT]);
    await boundary.analyseChunk(subject, [message(0, {}, reply)]);
    expect(calls[0]).toContain("replying to another member: @member says hi");
    const optedOut = fixture(CHUNK, [OTHER]);
    await optedOut.boundary.analyseChunk(subject, [message(0, {}, reply)]);
    expect(optedOut.calls[0]).not.toContain("says hi");
  });

  it("fails a call that cites a message it was not sent, or names someone", async () => {
    await expect(
      fixture(CHUNK.replace('"at":0', '"at":7')).boundary.analyseChunk(subject, [message(0)]),
    ).rejects.toThrow(/not sent/);
    await expect(
      fixture(CHUNK.replace("Organised a raid", "Jughfer organised a raid")).boundary.analyseChunk(subject, [message(0)]),
    ).rejects.toThrow(/names a member/);
  });

  it("fails a call that dates something to a month the messages do not cover", async () => {
    await expect(fixture(CHUNK.replace('"month":"2026-10"', '"month":"2020-01"')).boundary.analyseChunk(subject, [message(0)])).rejects.toThrow(
      /not one the messages cover/,
    );
  });

  it("lets the review's key events cite only the events noted", async () => {
    const report = (key: number) =>
      `{"timeline":[],"key_events":[${key}],"recent":"Calm.","trend":"stable","notes":"None.","actions":[]}`;
    const noted = { events: [{ at: 0, kind: "contribution" as const, note: "Organised a raid", date: "2026-10-01" }], tone: [] };
    expect((await fixture(report(0)).boundary.analyseReduce(subject, noted, [message(0)])).key_events).toEqual([0]);
    await expect(fixture(report(1)).boundary.analyseReduce(subject, noted, [message(0), message(1)])).rejects.toThrow(
      /not one of the events/,
    );
  });
});

describe("an observation", () => {
  const observe = (reply: string) =>
    fixture(reply).boundary.observeMember(subject, {
      triggers: ["hostile to newcomers"],
      post: [{ authorId: OTHER, authorIsBot: false, content: "Staff note: keep an eye on it" }],
      tags: ["Wellness Concern"],
      messages: [message(0)],
    });
  const ok = { level: "note", matched: [0], observation: "Calm.", cites: [0], tags: ["Wellness Concern"] };

  it("is checked against the triggers, messages and tags offered", async () => {
    expect((await observe(JSON.stringify(ok))).level).toBe("note");
    for (const bad of [{ matched: [1] }, { cites: [3] }, { tags: ["Made Up"] }, { level: "panic" }])
      await expect(observe(JSON.stringify({ ...ok, ...bad }))).rejects.toThrow(/Moderation output/);
  });
});
