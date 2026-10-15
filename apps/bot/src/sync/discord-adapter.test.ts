import { describe, expect, it } from "vitest";
import { discordRest } from "./discord-adapter.ts";

/** Answers the three routes listThreads calls, from canned Discord payloads. */
const fakeRest = (payload: { active: unknown[]; archived: unknown[] }) => ({
  get: async (route: string) => {
    if (route.includes("/threads/active")) return { threads: payload.active };
    if (route.includes("/threads/archived/public"))
      return { threads: payload.archived, has_more: false };
    return { content: "starter" };
  },
});

const listThreads = (payload: { active: unknown[]; archived: unknown[] }, warn?: (m: string) => void) =>
  discordRest({
    token: "unused",
    guildId: "1",
    warn,
    rest: fakeRest(payload) as never,
  }).listThreads(["100"]);

describe("captureWindows", () => {
  it("marks a webhook's message as not a member's, even without the bot flag", async () => {
    const page = [
      { id: "2", author: { id: "w1" }, webhook_id: "w1", content: "Free game!" },
      { id: "1", author: { id: "m1", bot: false }, content: "nice" },
    ];
    const port = discordRest({
      token: "unused",
      guildId: "1",
      rest: { get: async () => page } as never,
    });

    const messages = await port.captureWindows("500");

    expect(Object.fromEntries(messages.map((m) => [m.id, m.authorIsBot]))).toEqual({ "1": false, "2": true });
  });
});

describe("listThreads", () => {
  it("reads archived from the endpoint that answered and locked from the metadata", async () => {
    const threads = await listThreads({
      active: [
        { id: "201", name: "open", parent_id: "100", type: 11, thread_metadata: { archived: false, locked: false } },
        { id: "202", name: "locked open", parent_id: "100", type: 11, thread_metadata: { archived: false, locked: true } },
      ],
      archived: [
        // Metadata saying otherwise does not outrank the endpoint.
        { id: "203", name: "closed", parent_id: "100", type: 11, thread_metadata: { archived: false } },
      ],
    });

    expect(
      Object.fromEntries(threads.map((t) => [t.id, { archived: t.archived, locked: t.locked }])),
    ).toEqual({
      "201": { archived: false, locked: false },
      "202": { archived: false, locked: true },
      "203": { archived: true, locked: false },
    });
  });

  it("drops private Threads, which a Member cannot browse to", async () => {
    const threads = await listThreads({
      active: [
        { id: "201", name: "public", parent_id: "100", type: 11, thread_metadata: { locked: false } },
        { id: "299", name: "private", parent_id: "100", type: 12, thread_metadata: { locked: false } },
      ],
      archived: [],
    });

    expect(threads.map((t) => t.id)).toEqual(["201"]);
  });

  it("says so when a Thread arrives without metadata, rather than guessing quietly", async () => {
    const warnings: string[] = [];
    const threads = await listThreads(
      {
        active: [
          { id: "201", name: "bare", parent_id: "100", type: 11 },
          { id: "202", name: "partial", parent_id: "100", type: 11, thread_metadata: {} },
        ],
        archived: [],
      },
      (m) => warnings.push(m),
    );

    expect(threads[0]).toMatchObject({ archived: false, locked: false });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("without thread_metadata.locked");
  });
});
