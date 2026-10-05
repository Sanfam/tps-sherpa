import { describe, expect, it } from "vitest";
import type { Entity } from "../sync/catalog.ts";
import type { StoredMessage } from "../sync/tier0-store.ts";
import { checkActivity, isActivityDue, newestId, planActivity, recentSources } from "./activity.ts";

const entity = (last: string | null): Entity => ({
  id: "500",
  type: "post",
  name: "Elden Ring",
  url: "https://discord.com/channels/1/500",
  parent_id: null,
  description_status: "present",
  topic: null,
  applied_tags: [],
  region: [],
  topics: [],
  topics_version: null,
  thread_state: "open",
  last_message_id: last,
  last_activity_at: null,
  summary_generated: "The identity line.",
  summary_override: null,
});

const msg = (id: string, content: string, over: Partial<StoredMessage> = {}): StoredMessage => ({
  entityId: "500",
  messageId: id,
  authorId: "a1",
  authorIsBot: false,
  content,
  createdAt: "",
  window: "head",
  ...over,
});

describe("isActivityDue", () => {
  const newest = (...ids: string[]) => newestId(ids.map((id) => msg(id, "x")));

  it("is due when the newest message has moved and Tier 0's newest is that one", () => {
    expect(isActivityDue(entity("900"), newest("800", "900"), { "500": { summary: "old", as_of: "800" } })).toBe(true);
  });

  it("is not due when nothing has moved since the last summary", () => {
    expect(isActivityDue(entity("900"), newest("900"), { "500": { summary: "old", as_of: "900" } })).toBe(false);
  });

  it("waits while the snapshot is behind the Catalog", () => {
    // A stale capture, a deleted last message, or a silently empty 200.
    expect(isActivityDue(entity("900"), newest("800"), {})).toBe(false);
    expect(isActivityDue(entity("900"), newest(), {})).toBe(false);
  });

  it("waits while the snapshot is ahead of the Catalog", () => {
    // A message arrived between sync and capture, or the Catalog moved back
    // past messages since deleted. Summarising now would record activity the
    // cursor does not cover.
    expect(isActivityDue(entity("900"), newest("900", "1000"), {})).toBe(false);
  });

  it("is never due for an Entity nobody has posted in", () => {
    expect(isActivityDue(entity(null), newest(), {})).toBe(false);
  });
});

describe("recentSources", () => {
  it("takes the newest messages by snowflake, whatever window label they carry", () => {
    // Capture lets head overwrite tail on overlap, so a short Thread's recent
    // messages may all be labelled head. Numeric order, not string order:
    // "1000" is newer than "999".
    const sources = recentSources([msg("999", "older"), msg("1000", "newest"), msg("998", "oldest")], 2);

    expect(sources.map((m) => m.content)).toEqual(["older", "newest"]);
  });

  it("drops bots and webhooks before deduplicating, so they cannot crowd members out", () => {
    const sources = recentSources([
      msg("1", "Patch notes are out"),
      msg("2", "patch notes are out!", { authorIsBot: true }),
      msg("3", "Anyone tried the new boss?"),
    ]);

    expect(sources.map((m) => m.messageId)).toEqual(["1", "3"]);
  });

  it("treats messages differing only in case, punctuation and spacing as one", () => {
    const sources = recentSources([msg("1", "lol"), msg("2", "LOL!"), msg("3", " lol "), msg("4", "gg")]);

    // The most recent wording is the one kept: this is a summary of lately.
    expect(sources.map((m) => m.messageId)).toEqual(["3", "4"]);
  });

  it("drops messages with no words in them, including a bare mention", () => {
    // A lone mention would reach the model as "@member" and invite it to
    // invent a subject.
    expect(
      recentSources([msg("1", "🎉🎉"), msg("2", ""), msg("3", "<@732682426853359667>"), msg("4", "<:pog:123> https://x.y/z"), msg("5", "10/10"), msg("6", "HTTPS://Example.com/x"), msg("7", "www.example.com"), msg("8", "discord.gg/raid"), msg("9", "example.com"), msg("10", "example.com?invite=raid"), msg("11", "mailto:dave@example.com")]),
    ).toEqual([]);
  });

  it("treats messages differing only in spacing inside them as one", () => {
    expect(recentSources([msg("1", "co-op tonight"), msg("2", "co op tonight")]).map((m) => m.messageId)).toEqual(["2"]);
  });
});

describe("planActivity", () => {
  it("reads Tier 0 once per Entity and summarises from that same read", () => {
    // The second read sees a capture committed in between. If the sources
    // came from it, message 1000 would be summarised under cursor 900.
    let reads = 0;
    const snapshotOf = () =>
      ++reads === 1 ? [msg("900", "raid tonight")] : [msg("900", "raid tonight"), msg("1000", "new boss")];

    const plan = planActivity([entity("900")], snapshotOf, {});

    expect(reads).toBe(1);
    expect(plan[0]?.sources.map((m) => m.messageId)).toEqual(["900"]);
  });
});

describe("checkActivity", () => {
  it("accepts a short line about the subject", () => {
    expect(checkActivity("Comparing builds for the new DLC boss and co-op tips.")).toBeNull();
  });

  it("rejects a line that has grown into a paragraph", () => {
    expect(checkActivity("word ".repeat(21))).toMatchObject({ reason: "too-long" });
  });

  it("rejects a line that talks about a mentioned member", () => {
    expect(checkActivity("@member is asking about co-op")).toEqual({ reason: "names-a-member" });
  });
});
