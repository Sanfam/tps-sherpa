import { MessageType } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { type ChatPort, createBoundary } from "../llm/boundary.ts";
import type { Entity } from "../sync/catalog.ts";
import { MENTION_OPTED_OUT, type MentionMessage, type MentionsDeps, createMentions, mentionWritePort } from "./mentions.ts";
import type { Mode } from "./responder-store.ts";
import { SHADOW_CHANNEL } from "./responder.ts";

const place = (id: string, over: Partial<Entity> = {}): Entity => ({
  id,
  type: "channel",
  name: `place-${id}`,
  url: `https://discord.com/channels/1/${id}`,
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
  ...over,
});

const INTRO = "30";
const GENERAL = "40";
const SHERPA = "900";
const ASKER = "500";
const STAFF_ROLE = "800";
const catalog = [place(INTRO), place(GENERAL)];

const asking = (over: Partial<MentionMessage> = {}): MentionMessage =>
  ({
    id: "1000",
    channel_id: GENERAL,
    guild_id: "1",
    type: MessageType.Default,
    author: { id: ASKER, username: "jughfer", global_name: "Jughfer", discriminator: "0", avatar: null },
    content: `<@${SHERPA}> any co-op games?`,
    mentions: [{ id: SHERPA, username: "Sherpa", global_name: null, discriminator: "0", avatar: null }],
    mention_roles: [],
    member: { roles: [STAFF_ROLE], nick: null },
    ...over,
  }) as MentionMessage;

const harness = (
  answer = '{"intent":"chat","line":"Deep Rock Galactic. Rock and stone!"}',
  over: Partial<MentionsDeps> & { modeIs?: Mode; optedOut?: string[] } = {},
) => {
  const calls: Array<Parameters<ChatPort["complete"]>[0]> = [];
  const posts: Array<{ channelId: string; body: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const histories: string[] = [];
  let now = 0;
  const optedOut = new Set(over.optedOut ?? []);
  const chat: ChatPort = { complete: async (r) => (calls.push(r), answer) };
  const mentions = createMentions({
    guildId: "1",
    discord: {
      botId: async () => SHERPA,
      botRoleId: async () => "950",
      nickOf: async () => null,
      parentOf: async (id) => (id === "77" ? INTRO : null),
      history: async (channelId) => (histories.push(channelId), []),
      createMessage: async (channelId, body) => void posts.push({ channelId, body: body as Record<string, unknown> }),
    },
    mode: () => over.modeIs ?? "live",
    persona: { voice: "A kindly gamer dad.", fallback: "My brain blue-screened.", signoffs: [{ role: "Staff", line: "Thanks, boss." }] },
    processing: (id) => !optedOut.has(id),
    roles: () => [{ name: "Staff", color: 0, ids: [STAFF_ROLE] }],
    session: () => ({
      catalog,
      monitored: new Set([INTRO]),
      boundary: createBoundary({
        chat,
        models: { strong: "s", cheap: "c" },
        catalog,
        monitored: new Set([INTRO]),
        names: { channels: new Map(), roles: new Map() },
        hasOptedOut: (id) => optedOut.has(id),
      }),
    }),
    cap: { limit: 100, take: () => true },
    now: () => now,
    log: (m) => logs.push(m),
    ...over,
  });
  return { mentions, calls, posts, logs, histories, advance: (ms: number) => (now += ms) };
};

describe("mention replies", () => {
  it("never answers in a monitored place or a Thread under one: #introductions is the responder's", async () => {
    const h = harness();
    await h.mentions.onMessage(asking({ channel_id: INTRO }));
    h.advance(20_000);
    await h.mentions.onMessage(asking({ id: "1001", channel_id: "77" }));
    // Not even read: monitored conversation is never fetched for a reply.
    expect([h.histories, h.calls, h.posts]).toEqual([[], [], []]);
  });

  it("replies inline, pinging only the asker, with the Staff sign-off added in code and no role in the prompt", async () => {
    const h = harness();
    await h.mentions.onMessage(asking());

    expect(h.calls[0]!.system + h.calls[0]!.user).not.toMatch(/staff/i);
    expect(h.posts).toEqual([
      {
        channelId: GENERAL,
        body: {
          content: "Deep Rock Galactic. Rock and stone!\n-# Thanks, boss.",
          message_reference: { message_id: "1000" },
          allowed_mentions: { parse: [], replied_user: true },
        },
      },
    ]);
  });

  it("answers Sherpa's managed role from the @ list, calls it Sherpa, and ignores another guild", async () => {
    const h = harness('{"intent":"chat","line":"Sherpa here, happy to help."}');
    await h.mentions.onMessage(asking({ guild_id: "2" }));
    await h.mentions.onMessage(asking({ content: "<@&950> hi", mentions: [], mention_roles: ["950"] }));
    h.advance(15_000);
    // Sherpa's own user, mentioned, lends no name to refuse: its reply may say "Sherpa".
    await h.mentions.onMessage(asking({ id: "1001" }));
    expect(h.calls[0]!.user).toContain("Sherpa hi");
    expect(h.posts.map((p) => p.body["content"])).toEqual([
      "Sherpa here, happy to help.\n-# Thanks, boss.",
      "Sherpa here, happy to help.\n-# Thanks, boss.",
    ]);
  });

  it("lends no name of Sherpa's own posts in the context to refuse", async () => {
    const h = harness('{"intent":"chat","line":"Sherpa here, happy to help."}', {
      discord: {
        botId: async () => SHERPA,
        botRoleId: async () => null,
        nickOf: async () => null,
        parentOf: async () => null,
        history: async () => [
          { author: { id: SHERPA, username: "Sherpa", global_name: null, discriminator: "0", avatar: null, bot: true }, content: "Hi!", mentions: [] },
        ] as never,
        createMessage: async () => undefined,
      },
    });
    await h.mentions.onMessage(asking());
    expect(h.logs.join("\n")).toContain("answered chat");
  });

  it("keeps a context author's nickname out of what is sent", async () => {
    const h = harness(undefined, {
      discord: {
        botId: async () => SHERPA,
        botRoleId: async () => null,
        nickOf: async (id) => (id === "601" ? "Bigfoot" : null),
        parentOf: async () => null,
        history: async () => [
          { author: { id: "601", username: "dave_1234", global_name: null, discriminator: "0", avatar: null }, content: "Bigfoot here", mentions: [] },
        ] as never,
        createMessage: async () => undefined,
      },
    });
    await h.mentions.onMessage(asking({ content: "<@900> thanks Bigfoot" }));
    expect(h.calls[0]!.user).not.toContain("Bigfoot");
  });

  it("in shadow, posts only to #bot-tests and pings nobody", async () => {
    const h = harness(undefined, { modeIs: "shadow" });
    await h.mentions.onMessage(asking());
    expect(h.posts.map((p) => [p.channelId, p.body["allowed_mentions"]])).toEqual([[SHADOW_CHANNEL, { parse: [] }]]);
  });

  it("answers an opted-out asker with the fixed text and sends nothing to the model", async () => {
    const h = harness(undefined, { optedOut: [ASKER] });
    await h.mentions.onMessage(asking());
    expect(h.calls).toEqual([]);
    expect(h.posts[0]!.body["content"]).toBe(MENTION_OPTED_OUT);
  });

  it("posts the fallback when the model's line is refused", async () => {
    const h = harness('{"intent":"chat","line":"go to https://example.org"}');
    await h.mentions.onMessage(asking());
    expect(h.posts[0]!.body["content"]).toBe("My brain blue-screened.\n-# Thanks, boss.");
  });

  it("holds each member to one reply per 15 seconds", async () => {
    const h = harness();
    await h.mentions.onMessage(asking());
    h.advance(14_999);
    await h.mentions.onMessage(asking({ id: "1001" }));
    h.advance(1);
    await h.mentions.onMessage(asking({ id: "1002" }));
    expect(h.posts).toHaveLength(2);
  });

  it("sends nothing when the place's history cannot be read", async () => {
    const h = harness(undefined, {
      discord: {
        botId: async () => SHERPA,
        botRoleId: async () => null,
        nickOf: async () => null,
        parentOf: async () => null,
        history: async () => {
          throw new Error("Missing Access");
        },
        createMessage: async () => {
          throw new Error("posted");
        },
      },
    });
    await h.mentions.onMessage(asking());
    expect(h.calls).toEqual([]);
  });

  it("the write port refuses a monitored place whatever its caller checked", async () => {
    const posted: string[] = [];
    const port = mentionWritePort({
      guildId: "1",
      mode: () => "live",
      refused: (p) => p.id === INTRO,
      createMessage: async (id) => void posted.push(id),
    });
    await expect(port.post({ id: INTRO, parentId: null }, "1000", "hi")).rejects.toThrow(/Refusing/);
    expect(posted).toEqual([]);
  });
});
