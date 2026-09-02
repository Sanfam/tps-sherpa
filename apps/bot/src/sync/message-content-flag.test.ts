import { describe, expect, it } from "vitest";
import { messageContentUsable } from "./discord-adapter.ts";

describe("messageContentUsable", () => {
  it("accepts the _LIMITED flag a self-toggled bot actually gets", () => {
    // Real value read from this guild's application on 2026-09-01. Bit 18 is
    // clear, bit 19 is set, and content came back over REST regardless.
    expect(messageContentUsable(565248)).toBe(true);
  });

  it("accepts the unqualified flag a verified bot gets", () => {
    expect(messageContentUsable(1 << 18)).toBe(true);
  });

  it("rejects an application with neither flag", () => {
    expect(messageContentUsable(0)).toBe(false);
    // Presence and guild-members intents set, message content not.
    expect(messageContentUsable((1 << 13) | (1 << 15))).toBe(false);
  });
});
