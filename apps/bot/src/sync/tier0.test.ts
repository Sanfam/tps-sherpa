import { describe, expect, it } from "vitest";
import type { Entity } from "./catalog.ts";
import { openTier0 } from "./tier0-store.ts";
import { captureEach, projectedCalls, selectForCapture, toStored, type CaptureState } from "./tier0.ts";

const entity = (over: Partial<Entity> & { id: string }): Entity => ({
  type: "post",
  name: "x",
  url: "https://discord.com/channels/1/1",
  parent_id: "999",
  description_status: "present",
  topic: "something",
  applied_tags: [],
  region: [],
  topics: [],
  topics_version: null,
  thread_state: null,
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

  it("captures Channels too — they are Entities that need describing", () => {
    const d = selectForCapture([entity({ id: "1", type: "channel" })], new Map());
    expect(d.capture.map((e) => e.id)).toEqual(["1"]);
  });

  it("never captures a Forum, which has no messages of its own", () => {
    const d = selectForCapture([entity({ id: "2", type: "forum" })], new Map());
    expect(d.capture).toEqual([]);
    expect(d.skippedNoOwnContent).toBe(1);
  });

  it("never captures a monitored channel", () => {
    // The privacy carve-out that actually exists: a member introducing
    // themselves is having a conversation, not authoring a description. That
    // content is extract-and-discard and must never be stored.
    const d = selectForCapture(
      [
        entity({ id: "1", type: "channel", name: "👋︱introductions" }),
        entity({ id: "2", type: "channel", name: "🖥︱pc-gaming" }),
      ],
      new Map(),
    );
    expect(d.capture.map((e) => e.name)).toEqual(["🖥︱pc-gaming"]);
    expect(d.skippedMonitored).toBe(1);
  });

  it("never captures a Thread INSIDE a monitored channel", () => {
    // This is where the actual introductions are. Matching only on the
    // channel's own name would capture exactly what the carve-out protects.
    const d = selectForCapture(
      [
        entity({ id: "1", type: "channel", name: "👋︱introductions" }),
        entity({ id: "2", type: "thread", name: "Jughfer intro", parent_id: "1" }),
        entity({ id: "3", type: "thread", name: "Wingspan", parent_id: "9" }),
      ],
      new Map(),
    );
    expect(d.capture.map((e) => e.name)).toEqual(["Wingspan"]);
    expect(d.skippedMonitored).toBe(2);
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

describe("toStored", () => {
  it("never stores a member with processing off, and keeps bots flagged as before", () => {
    const raw = (id: string, authorId: string, authorIsBot = false) => ({
      id,
      authorId,
      authorIsBot,
      content: "text",
      createdAt: new Date().toISOString(),
      window: "head" as const,
    });
    const stored = toStored("e1", [raw("1", "in"), raw("2", "out"), raw("3", "bot", true)], new Set(["out"]));
    expect(stored.map((m) => [m.messageId, m.entityId, m.authorIsBot])).toEqual([
      ["1", "e1", false],
      ["3", "e1", true],
    ]);
  });
});

describe("captureEach", () => {
  const raw = (id: string, authorId: string) => ({
    id,
    authorId,
    authorIsBot: false,
    content: "text",
    createdAt: new Date().toISOString(),
    window: "head" as const,
  });

  it("hears an opt-out made mid-run before storing the next Entity", async () => {
    let optedOut = new Set<string>();
    const store = openTier0(":memory:");
    await captureEach({
      entities: [entity({ id: "e1" }), entity({ id: "e2" })],
      fetch: async (id) => {
        // The gateway records the opt-out while e2 is being fetched.
        if (id === "e2") optedOut = new Set(["member"]);
        return [raw(`${id}-m`, "member"), raw(`${id}-o`, "other")];
      },
      store,
      optedOut: () => new Set(optedOut),
    });
    expect(store.messagesFor("e1").map((m) => m.authorId).sort()).toEqual(["member", "other"]);
    expect(store.messagesFor("e2").map((m) => m.authorId)).toEqual(["other"]);
    store.close();
  });

  it("leaves an Entity uncaptured when the opt-outs cannot be read, rather than storing it unchecked", async () => {
    const store = openTier0(":memory:");
    const result = await captureEach({
      entities: [entity({ id: "e1" })],
      fetch: async () => [raw("m", "member")],
      store,
      optedOut: () => {
        throw new Error("database is locked");
      },
    });
    expect(result.failed.map((f) => f.id)).toEqual(["e1"]);
    expect(store.state().size).toBe(0);
    store.close();
  });
});
