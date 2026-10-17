import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("the member-name cache", () => {
  it("keeps a name exactly as long as its author has a message stored", () => {
    const store = openTier0(":memory:");
    store.record("e1", "1", [
      msg({ entityId: "e1", messageId: "m1", authorId: "a1", authorNames: ["alpha", "Alpha A"] }),
      msg({ entityId: "e1", messageId: "m2", authorId: "a2", authorNames: ["bravo"], createdAt: "2026-02-01T00:00:00.000Z" }),
      msg({ entityId: "e1", messageId: "m3", authorId: "a3", authorNames: ["charlie"], createdAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(store.memberNames().sort()).toEqual(["Alpha A", "alpha", "bravo", "charlie"]);
    store.dropWrittenBefore("2026-01-15T00:00:00.000Z"); // a1's only message ages out
    expect(store.memberNames().sort()).toEqual(["bravo", "charlie"]);
    store.deleteAuthor("a2");
    expect(store.memberNames()).toEqual(["charlie"]);
    store.record("e1", "2", []); // recaptured: a3's message is gone from Discord
    expect(store.memberNames()).toEqual([]);
    store.close();
  });
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

describe("Tier 0 store — retention and erasure", () => {
  it("deletes messages written before the cutoff, by Discord's own timestamps, and keeps every cursor", () => {
    const store = openTier0(":memory:");
    store.record("e1", "9", [
      // Discord's format: microseconds and an offset rather than a Z.
      msg({ entityId: "e1", messageId: "m1", createdAt: "2026-10-04T23:59:59.999000+00:00" }),
      msg({ entityId: "e1", messageId: "m2", createdAt: "2026-10-05T00:00:01.000000+00:00" }),
      msg({ entityId: "e1", messageId: "m3", createdAt: "" }),
    ]);

    expect(store.dropWrittenBefore("2026-10-05T00:00:00.000Z")).toBe(2);
    expect(store.messagesFor("e1").map((m) => m.messageId)).toEqual(["m2"]);
    expect(store.state().get("e1")).toEqual({ lastMessageId: "9" });
    store.close();
  });

  it("finds and deletes one author's messages, leaving everyone else's", () => {
    const store = openTier0(":memory:");
    store.record("e1", "1", [
      msg({ entityId: "e1", messageId: "m1", authorId: "gone" }),
      msg({ entityId: "e1", messageId: "m2", authorId: "stays" }),
    ]);
    store.record("e2", "1", [msg({ entityId: "e2", messageId: "m3", authorId: "gone" })]);
    store.record("e3", "1", [msg({ entityId: "e3", messageId: "m4", authorId: "stays" })]);

    expect(store.authoredIn("gone").sort()).toEqual(["e1", "e2"]);
    expect(store.deleteAuthor("gone")).toBe(2);
    expect(store.authoredIn("gone")).toEqual([]);
    expect(store.messagesFor("e1").map((m) => m.authorId)).toEqual(["stays"]);
    store.close();
  });

  it("leaves a deleted message unreadable in the file, not in a free page", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tier0-")), "tier0.db");
    const store = openTier0(path);
    const secret = "distinctive-erased-text-".repeat(40);
    store.record("e1", "1", [
      msg({ entityId: "e1", messageId: "m1", authorId: "gone", content: secret }),
      msg({ entityId: "e1", messageId: "m2", authorId: "stays" }),
    ]);
    store.deleteAuthor("gone");
    store.close();
    expect(readFileSync(path).includes("distinctive-erased-text")).toBe(false);
  });
});
