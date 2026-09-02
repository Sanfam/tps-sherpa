import { describe, expect, it } from "vitest";
import { openTier0, type StoredMessage } from "./tier0-store.ts";

const msg = (over: Partial<StoredMessage> & { entityId: string; messageId: string }): StoredMessage => ({
  authorId: "a1",
  authorIsBot: false,
  content: "hello there",
  createdAt: "2026-01-01T00:00:00.000Z",
  window: "head",
  ...over,
});

describe("Tier 0 store", () => {
  it("reports what it has captured, so the next run can skip it", () => {
    const store = openTier0(":memory:");
    store.record("e1", "500", [msg({ entityId: "e1", messageId: "m1" })]);
    expect(store.state()).toEqual(new Map([["e1", { lastMessageId: "500" }]]));
    store.close();
  });

  it("re-capturing an Entity does not duplicate its messages", () => {
    const store = openTier0(":memory:");
    store.record("e1", "500", [msg({ entityId: "e1", messageId: "m1" })]);
    store.record("e1", "600", [
      msg({ entityId: "e1", messageId: "m1" }),
      msg({ entityId: "e1", messageId: "m2" }),
    ]);
    expect(store.stats().messages).toBe(2);
    expect(store.state().get("e1")).toEqual({ lastMessageId: "600" });
    store.close();
  });

  it("records an Entity with no messages so it is not re-fetched forever", () => {
    const store = openTier0(":memory:");
    store.record("e1", null, []);
    expect(store.state().get("e1")).toEqual({ lastMessageId: null });
    expect(store.stats().entities).toBe(1);
    store.close();
  });

  it("measures its own footprint, which is the thing the volume has to hold", () => {
    const store = openTier0(":memory:");
    store.record("e1", "1", [msg({ entityId: "e1", messageId: "m1", content: "12345" })]);
    expect(store.stats()).toEqual({ messages: 1, contentBytes: 5, entities: 1 });
    store.close();
  });
});

describe("Tier 0 store — binding edge cases", () => {
  it("accepts an Entity whose last message id is undefined, not just null", () => {
    // A Catalog written before last_message_id existed has no value at all,
    // and node:sqlite rejects undefined outright.
    const store = openTier0(":memory:");
    expect(() => store.record("e1", undefined, [])).not.toThrow();
    expect(store.state().get("e1")).toEqual({ lastMessageId: null });
    store.close();
  });
});

describe("Tier 0 store — deletion propagates", () => {
  it("drops messages that are gone from Discord on the next capture", () => {
    // Without this, raw member text outlives the member's own deletion, and
    // the privacy rationale for not replicating Tier 0 would be false.
    const store = openTier0(":memory:");
    store.record("e1", "1", [
      msg({ entityId: "e1", messageId: "m1" }),
      msg({ entityId: "e1", messageId: "m2", content: "deleted later" }),
    ]);
    expect(store.stats().messages).toBe(2);

    store.record("e1", "2", [msg({ entityId: "e1", messageId: "m1" })]);
    expect(store.stats().messages).toBe(1);
    store.close();
  });

  it("does not disturb another Entity when one is re-captured", () => {
    const store = openTier0(":memory:");
    store.record("e1", "1", [msg({ entityId: "e1", messageId: "m1" })]);
    store.record("e2", "1", [msg({ entityId: "e2", messageId: "m9" })]);
    store.record("e1", "2", []);
    expect(store.stats().messages).toBe(1);
    expect(store.state().size).toBe(2);
    store.close();
  });

  it("measures bytes, not characters, because the figure is a volume footprint", () => {
    const store = openTier0(":memory:");
    // Four-byte emoji: LENGTH() on text would report 2.
    store.record("e1", "1", [msg({ entityId: "e1", messageId: "m1", content: "🧔‍♂" })]);
    expect(store.stats().contentBytes).toBeGreaterThan(4);
    store.close();
  });
});
