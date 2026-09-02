import { describe, expect, it } from "vitest";
import type { Entity } from "./catalog.ts";
import { projectedCalls, selectForCapture, type CaptureState } from "./tier0.ts";

const entity = (over: Partial<Entity> & { id: string }): Entity => ({
  type: "post",
  name: "x",
  url: "https://discord.com/channels/1/1",
  parent_id: "999",
  description_status: "present",
  topic: "something",
  applied_tags: [],
  last_message_id: "500",
  last_activity_at: null,
  summary_generated: null,
  summary_override: null,
  ...over,
});

describe("selectForCapture", () => {
  it("captures Posts and Threads", () => {
    const d = selectForCapture(
      [entity({ id: "1", type: "post" }), entity({ id: "2", type: "thread" })],
      new Map(),
    );
    expect(d.capture.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("never captures Channel or Forum conversation", () => {
    // Tier 0 covers indexed thread content only. Channel conversation stays
    // extract-and-discard, and a Channel's description comes from its topic.
    const d = selectForCapture(
      [entity({ id: "1", type: "channel" }), entity({ id: "2", type: "forum" })],
      new Map(),
    );
    expect(d.capture).toEqual([]);
    expect(d.skippedNotThreadContent).toBe(2);
  });

  it("never captures a withheld Entity", () => {
    // Discord answers a denied history with 200 and an empty array, so an
    // empty result would look like a successful read of an empty Entity.
    // The decision has to come from the Catalog, not the response.
    const d = selectForCapture(
      [entity({ id: "1", description_status: "withheld" })],
      new Map(),
    );
    expect(d.capture).toEqual([]);
    expect(d.skippedWithheld).toBe(1);
  });

  it("skips an Entity whose newest message has not moved", () => {
    const state: CaptureState = new Map([["1", { lastMessageId: "500" }]]);
    const d = selectForCapture([entity({ id: "1", last_message_id: "500" })], state);
    expect(d.capture).toEqual([]);
    expect(d.skippedUnchanged).toBe(1);
  });

  it("re-captures an Entity that has been posted in since", () => {
    const state: CaptureState = new Map([["1", { lastMessageId: "500" }]]);
    const d = selectForCapture([entity({ id: "1", last_message_id: "600" })], state);
    expect(d.capture.map((e) => e.id)).toEqual(["1"]);
  });

  it("captures an Entity it has never seen", () => {
    const d = selectForCapture([entity({ id: "1" })], new Map());
    expect(d.capture.map((e) => e.id)).toEqual(["1"]);
  });

  it("re-captures an Entity with no messages only until it is recorded", () => {
    // A never-posted-in Entity has a null last_message_id. Once recorded as
    // null it must stop being re-fetched every run.
    const state: CaptureState = new Map([["1", { lastMessageId: null }]]);
    const d = selectForCapture([entity({ id: "1", last_message_id: null })], state);
    expect(d.capture).toEqual([]);
  });
});

describe("projectedCalls", () => {
  it("is two calls per Entity: one head window, one tail", () => {
    expect(projectedCalls(1195)).toBe(2390);
  });
});
