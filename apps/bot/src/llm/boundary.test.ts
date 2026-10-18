import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Entity } from "../sync/catalog.ts";
import type { NameLookup } from "../sync/normalise.ts";
import { WATCHED_CHANNEL, createBoundary, type ChatPort, type Source } from "./boundary.ts";
import { wireFromEnv } from "./openai-wire.ts";
import type { Vocabulary } from "./vocabulary.ts";

const names: NameLookup = {
  channels: new Map([["1088552078709891242", "pc-gaming"]]),
  roles: new Map([["732682426853359667", "Member"]]),
};

const entity = (over: Partial<Entity> & { id: string; name: string }): Entity => ({
  type: "post",
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
  ...over,
});

/** Records what it was sent and answers whatever the test tells it to. */
const fixtureChat = (reply: string | (() => string)) => {
  const calls: Array<Parameters<ChatPort["complete"]>[0]> = [];
  const chat: ChatPort = {
    complete: async (request) => {
      calls.push(request);
      return typeof reply === "function" ? reply() : reply;
    },
  };
  return { chat, calls };
};

const intro = entity({ id: "30", name: "👋︱introductions", type: "channel" });
const introThread = entity({
  id: "31",
  name: "Hi, I am new here",
  type: "thread",
  parent_id: intro.id,
});
const post = entity({ id: "20", name: "Helldivers squad" });

const boundary = (chat: ChatPort, over: Partial<Parameters<typeof createBoundary>[0]> = {}) =>
  createBoundary({
    chat,
    models: { strong: "test-strong", cheap: "test-cheap", vision: "test-vision" },
    catalog: [post, intro, introThread],
    monitored: new Set([intro.id]),
    names,
    ...over,
  });

const ask = { role: "cheap" as const, system: "Answer in JSON.", subject: post, parse: (v: unknown) => v };

describe("the redaction boundary", () => {
  it("replaces member mentions before the text leaves", async () => {
    const { chat, calls } = fixtureChat('{"summary":"co-op shooter nights"}');

    await boundary(chat).ask({
      ...ask,
      sources: [{ authorId: "1", authorIsBot: false, content: "<@732682426853359667> is in", origin: post.id }],
    });

    expect(calls[0]?.user).toBe("@member is in");
  });

  it("strips a bare snowflake nobody wrapped in mention syntax", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');

    await boundary(chat).ask({
      ...ask,
      sources: [{ authorId: "1", authorIsBot: false, content: "ping 732682426853359667 about it", origin: post.id }],
    });

    expect(calls[0]?.user).toBe("ping [id] about it");
    expect(calls[0]?.user).not.toContain("732682426853359667");
  });

  it("resolves channel mentions to names, which are not member identifiers", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');

    await boundary(chat).ask({ ...ask, context: "moved from <#1088552078709891242>" });

    expect(calls[0]?.user).toBe("moved from #pc-gaming");
  });
});

describe("output validation", () => {
  it("refuses output carrying a Discord identifier", async () => {
    const { chat } = fixtureChat('{"summary":"ask 732682426853359667 about it"}');

    await expect(boundary(chat).ask(ask)).rejects.toThrow(/identifier/i);
  });

  it("refuses a mass mention, which would ping the guild if rendered", async () => {
    const { chat } = fixtureChat('{"summary":"@everyone welcome"}');

    await expect(boundary(chat).ask(ask)).rejects.toThrow(/mass mention/i);
  });

  it("refuses output naming a member when a name cache is configured", async () => {
    const { chat } = fixtureChat('{"summary":"Schwagle runs this one"}');

    await expect(
      boundary(chat, { memberNames: ["Schwagle"] }).ask(ask),
    ).rejects.toThrow(/names a member/i);
  });

  it("does not refuse its own system prompt for an ordinary word that is also a member's name", async () => {
    // A member called "games" must not stop every call whose instruction says "games".
    const { chat } = fixtureChat('{"ok":true}');
    const wordy = { ...ask, system: "Suggest games and places. Answer in JSON." };

    await expect(boundary(chat, { memberNames: ["games"] }).ask(wordy)).resolves.toEqual({ ok: true });
  });

  it("looks inside nested output, not just the top level", async () => {
    // A validator that only checks a summary field is a validator that gets
    // bypassed the first time a prompt returns a list.
    const { chat } = fixtureChat('{"tags":[{"note":"see 732682426853359667"}]}');

    await expect(boundary(chat).ask(ask)).rejects.toThrow(/identifier/i);
  });

  it("says so when no member-name cache is configured", async () => {
    // An empty cache passing silently would read as a working check.
    const warnings: string[] = [];
    const { chat } = fixtureChat('{"ok":true}');

    await boundary(chat, { warn: (m) => warnings.push(m) }).ask(ask);

    expect(warnings.join()).toMatch(/no member-name cache/i);
  });

  it("looks at object KEYS, not only values", async () => {
    // A model is perfectly capable of answering {"<snowflake>": "..."}.
    const { chat } = fixtureChat('{"732682426853359667":"nightly runs"}');

    await expect(boundary(chat).ask(ask)).rejects.toThrow(/identifier/i);
  });

  it("catches a name edged with emoji, which \\b would miss", async () => {
    const { chat } = fixtureChat('{"summary":"run by 👦Schwagle👧 most nights"}');

    await expect(
      boundary(chat, { memberNames: ["Schwagle"] }).ask(ask),
    ).rejects.toThrow(/names a member/i);
  });

  it("rejects prose, because the app renders from a template", async () => {
    const { chat } = fixtureChat("Sure! Here is a summary of the thread.");

    await expect(boundary(chat).ask(ask)).rejects.toThrow(/did not return JSON/i);
  });

  it("names the category of a refused output, never the refused text", async () => {
    // These errors are retried and logged; quoting what was refused copies it
    // into the log.
    for (const reply of [
      '{"summary":"Ask 732682426853359667"}',
      '{"summary":"@everyone Dave is hosting raids"}',
      '{"summary":"Dave is hosting raids"}',
    ]) {
      const { chat } = fixtureChat(reply);
      const error = await boundary(chat, { memberNames: ["Dave"] }).ask(ask).catch((e: Error) => e);

      expect(String(error)).toMatch(/identifier|mass mention|names a member/);
      expect(String(error)).not.toMatch(/Dave|732682426853359667|@everyone|raids/);
    }
  });

  it("never quotes the model's prose back in the error", async () => {
    // A model that answered with prose may have echoed member messages back,
    // and redaction cannot remove a plain-text name it was never told about.
    // An exception message is a place logs keep things.
    const { chat } = fixtureChat("Sorry! Ask Dave or 732682426853359667 instead.");

    const error = await boundary(chat).ask(ask).catch((e: Error) => e);

    expect(String(error)).toMatch(/did not return JSON/);
    expect(String(error)).not.toMatch(/Dave|732682426853359667|\[id\]/);
  });
});

describe("what never reaches a model", () => {
  it("refuses monitored-channel content", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');

    await expect(boundary(chat).ask({ ...ask, subject: intro })).rejects.toThrow(/monitored/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses a withheld Entity, even if a caller forgot to filter it", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');
    const withheld = { ...post, description_status: "withheld" as const };

    await expect(boundary(chat).ask({ ...ask, subject: withheld })).rejects.toThrow(/withheld/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a Thread INSIDE a monitored channel", async () => {
    // The intro threads are where the actual introductions are. A check that
    // cannot resolve the parent answers "not monitored" and lets exactly the
    // protected content through.
    const { chat, calls } = fixtureChat('{"ok":true}');

    await expect(boundary(chat).ask({ ...ask, subject: introThread })).rejects.toThrow(
      /monitored/i,
    );
    expect(calls).toHaveLength(0);
  });

  it("checks every subject when given a list, not just the first", async () => {
    // The vocabulary bootstrap reasons over a whole stratified sample at once.
    // A list check that stopped at the first Entity would skip the carve-out
    // for the hundred that follow it, which is where nearly all the text is.
    const { chat, calls } = fixtureChat('{"ok":true}');

    await expect(boundary(chat).ask({ ...ask, subject: [post, introThread] })).rejects.toThrow(
      /monitored/i,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses an empty subject list rather than checking nothing", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');

    await expect(boundary(chat).ask({ ...ask, subject: [] })).rejects.toThrow(/no subject/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses a subject whose parent is not in the Catalog", async () => {
    // Fail closed: an unresolvable parent is a broken input, not a permission.
    const { chat, calls } = fixtureChat('{"ok":true}');
    const orphan = entity({ id: "40", name: "Orphan", parent_id: "does-not-exist" });

    await expect(boundary(chat).ask({ ...ask, subject: orphan })).rejects.toThrow(
      /cannot be made/i,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a source from monitored conversation, whatever the subject (#40)", async () => {
    // The subject is an ordinary Post; the words are not. A Thread under the
    // monitored Channel is monitored too, and an origin the Catalog cannot
    // place is refused rather than assumed safe.
    for (const [origin, refusal] of [
      [intro.id, /monitored/],
      [introThread.id, /monitored/],
      ["does-not-exist", /not in the Catalog/],
      // A non-Entity origin is one of two exact shapes; a malformed one is not waved through.
      [{} as never, /neither a Catalog Entity/],
      [{ command: "lately" } as never, /neither a Catalog Entity/],
      [{ derivedFromIntroduction: "" } as never, /neither a Catalog Entity/],
    ] as const) {
      const { chat, calls } = fixtureChat('{"ok":true}');
      const source = { authorId: "1", authorIsBot: false, content: "hi all", origin };

      await expect(boundary(chat).ask({ ...ask, sources: [source] })).rejects.toThrow(refusal);
      expect(calls).toHaveLength(0);
    }
  });

  it("replaces a known member's name before the text leaves", async () => {
    // Validating only the response would still have handed the name to the
    // provider. Redaction is outbound as well as inbound.
    const { chat, calls } = fixtureChat('{"ok":true}');

    await boundary(chat, { memberNames: ["Schwagle"] }).ask({
      ...ask,
      context: "Schwagle runs this one",
      sources: [{ authorId: "1", authorIsBot: false, content: "ask Schwagle about it", origin: post.id }],
    });

    expect(calls[0]?.user).not.toMatch(/Schwagle/i);
    expect(calls[0]?.user).toBe("@member runs this one\nask @member about it");
  });

  it("replaces a longer name whole, whatever order the cache gives it in", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');
    await boundary(chat, { memberNames: ["Dave", "Dave Smith"] }).ask({
      ...ask,
      sources: [{ authorId: "1", authorIsBot: false, content: "thanks Dave Smith", origin: post.id }],
    });
    expect(calls[0]?.user).toBe("thanks @member");
  });

  it("refuses a system prompt carrying member-shaped text", async () => {
    // Our own text, so it is validated rather than rewritten: silently editing
    // an instruction changes what was asked for.
    const { chat, calls } = fixtureChat('{"ok":true}');

    await expect(
      boundary(chat).ask({ ...ask, system: "Summarise for 732682426853359667." }),
    ).rejects.toThrow(/identifier/i);
    expect(calls).toHaveLength(0);
  });

  it("drops an opted-out member's words before the call, not after", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');
    const sources: Source[] = [
      { authorId: "opted-out", authorIsBot: false, content: "please forget me", origin: post.id },
      { authorId: "fine", authorIsBot: false, content: "great thread", origin: post.id },
    ];

    await boundary(chat, { hasOptedOut: (id) => id === "opted-out" }).ask({ ...ask, sources });

    expect(calls[0]?.user).toBe("great thread");
    expect(calls[0]?.user).not.toContain("forget me");
  });

  it("assumes nobody has opted out until there is a store to ask", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');

    await boundary(chat).ask({
      ...ask,
      sources: [{ authorId: "anyone", authorIsBot: false, content: "still here", origin: post.id }],
    });

    expect(calls[0]?.user).toBe("still here");
  });

  it("drops bot and webhook messages", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');

    await boundary(chat).ask({
      ...ask,
      sources: [
        { authorId: "bot", authorIsBot: true, content: "Poll closed.", origin: post.id },
        { authorId: "human", authorIsBot: false, content: "good game", origin: post.id },
      ],
    });

    expect(calls[0]?.user).toBe("good game");
  });
});

describe("when filtering leaves nothing", () => {
  const optedOut = { authorId: "9", authorIsBot: false, content: "Anyone up for raids?", origin: post.id };

  it("answers with orNothing and never calls the model", async () => {
    const { chat, calls } = fixtureChat('{"summary":"Invented."}');

    const result = await boundary(chat, { hasOptedOut: () => true }).ask({
      ...ask,
      sources: [optedOut],
      orNothing: null,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("still answers orNothing when context is present, rather than asking about the context alone", async () => {
    const { chat, calls } = fixtureChat('{"summary":"Invented."}');

    const result = await boundary(chat, { hasOptedOut: () => true }).ask({
      ...ask,
      context: "Elden Ring",
      sources: [optedOut],
      orNothing: null,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("refuses rather than sending an empty prompt when no fallback was given", async () => {
    const { chat, calls } = fixtureChat('{"summary":"Invented."}');

    await expect(
      boundary(chat, { hasOptedOut: () => true }).ask({ ...ask, sources: [optedOut] }),
    ).rejects.toThrow(/filtered out/);
    expect(calls).toHaveLength(0);
  });
});

describe("model selection", () => {
  it("sends the role's configured model, never a name from source", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');

    await boundary(chat).ask({ ...ask, role: "strong" });

    expect(calls[0]?.model).toBe("test-strong");
  });

  it("reads base URL, key and both models from the environment", () => {
    const { wire, models } = wireFromEnv({
      OPENROUTER_API_KEY: "sk-test",
      LLM_MODEL_STRONG: "moonshotai/kimi-k2",
      LLM_MODEL_CHEAP: "deepseek/deepseek-chat",
    });

    expect(wire).toMatchObject({ apiKey: "sk-test", baseUrl: "https://openrouter.ai/api/v1" });
    expect(models).toEqual({ strong: "moonshotai/kimi-k2", cheap: "deepseek/deepseek-chat" });
  });

  it("always routes to providers that keep and train on nothing, whatever LLM_PROVIDER says", () => {
    const env = { LLM_API_KEY: "sk-test", LLM_MODEL_STRONG: "s", LLM_MODEL_CHEAP: "c" };
    expect(wireFromEnv(env).wire.provider).toEqual({ data_collection: "deny", zdr: true });
    expect(
      wireFromEnv({ ...env, LLM_PROVIDER: '{"sort":"throughput","data_collection":"allow","zdr":false}' }).wire.provider,
    ).toEqual({ sort: "throughput", data_collection: "deny", zdr: true });
    expect(() => wireFromEnv({ ...env, LLM_PROVIDER: '["DeepSeek"]' })).toThrow(/JSON object/);
  });

  it("refuses a base URL anywhere but OpenRouter over https, where that routing is enforced", () => {
    const env = { LLM_API_KEY: "sk-test", LLM_MODEL_STRONG: "s", LLM_MODEL_CHEAP: "c" };
    expect(wireFromEnv({ ...env, LLM_BASE_URL: "https://openrouter.ai/api/v1" }).wire.baseUrl).toBe(
      "https://openrouter.ai/api/v1",
    );
    for (const url of [
      "https://api.deepseek.com/v1",
      "http://openrouter.ai/api/v1",
      "https://openrouter.ai.example.com/api/v1",
      "http://localhost:11434/v1",
      "not a url",
    ])
      expect(() => wireFromEnv({ ...env, LLM_BASE_URL: url })).toThrow(/LLM_BASE_URL/);
  });

  it("refuses to run with a model unset rather than picking one", () => {
    expect(() => wireFromEnv({ LLM_API_KEY: "sk-test" })).toThrow(/LLM_MODEL_STRONG/);
  });
});

describe("the containment boundary itself", () => {
  it("is the only place in the codebase that calls a model", async () => {
    // The criterion is "one module owns every model call". Left as a comment
    // it lasts until the first person in a hurry.
    const src = new URL("../", import.meta.url);
    const offenders: string[] = [];
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "llm") continue;
        const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith(".ts") && /chat\/completions|openai|anthropic/i.test(readFileSync(child, "utf8")))
          offenders.push(entry.name);
      }
    };
    walk(src);

    expect(offenders).toEqual([]);
  });
});

describe("an introduction", () => {
  const MEMBER = "500000000000000001";
  const vocabulary: Vocabulary = {
    version: 1,
    frozen_at: "",
    status: "frozen",
    topics: [{ slug: "outdoors", label: "Outdoors", description: "" }],
  };
  const said = (content: string, over: Partial<Source> = {}): Source => ({
    authorId: MEMBER,
    authorIsBot: false,
    content,
    origin: WATCHED_CHANNEL,
    ...over,
  });
  const extract = (chat: ChatPort, sources: Source[]) =>
    boundary(chat).extractIntroduction({ memberId: MEMBER, sources, memberNames: [], vocabulary });
  const image = (over: Record<string, string> = {}) => ({
    authorId: MEMBER,
    origin: WATCHED_CHANNEL,
    dataUrl: "data:image/jpeg;base64,AAAA",
    ...over,
  });

  it("refuses another member's words among the member's own", async () => {
    const { chat, calls } = fixtureChat('{"signal":"none","interests":[],"topics":[],"life_stage":[]}');

    await expect(
      extract(chat, [said("hi, I climb"), said("welcome!", { authorId: "500000000000000002" })]),
    ).rejects.toThrow(/someone other than the member/);
    await expect(
      boundary(chat).readImage({ memberId: MEMBER, image: image({ authorId: "500000000000000002" }) }),
    ).rejects.toThrow(/someone other than the member/);
    expect(calls).toHaveLength(0);
  });

  it("refuses words or an image from anywhere but the watched Channel itself", async () => {
    // A Thread under it is not it (D27), and an unmonitored Post is not either:
    // this path lifts the carve-out for one Channel, not for whatever it is handed.
    const { chat, calls } = fixtureChat('{"signal":"none","interests":[],"topics":[],"life_stage":[]}');

    for (const origin of [introThread.id, post.id, { command: "find" as const }]) {
      await expect(extract(chat, [said("hi, I climb", { origin })])).rejects.toThrow(/not from the watched Channel/);
      await expect(
        boundary(chat).readImage({ memberId: MEMBER, image: { ...image(), origin } }),
      ).rejects.toThrow(/not from the watched Channel/);
    }
    expect(calls).toHaveLength(0);
  });

  it("returns the model's signal, keeping only what the schema allows", async () => {
    // A path that called the model and threw the answer away would send every
    // real introduction down the question path, and never match it.
    const { chat } = fixtureChat(
      JSON.stringify({
        signal: "some",
        interests: ["climbing", "x".repeat(41)],
        topics: ["outdoors", "not-a-topic"],
        life_stage: ["toddler", "grandparent"],
      }),
    );

    await expect(extract(chat, [said("hi, I climb with my toddler")])).resolves.toEqual({
      signal: "some",
      interests: ["climbing"],
      topics: ["outdoors"],
      life_stage: ["toddler"],
    });
  });

  it("cuts long text at 2,000 code points, on a word boundary", async () => {
    // Code points, not UTF-16 units: an emoji is two units and one character.
    const words = Array.from({ length: 300 }, () => "🦆abcde");
    const { chat, calls } = fixtureChat('{"signal":"none","interests":[],"topics":[],"life_stage":[]}');

    await extract(chat, [said(words.join(" "))]);

    expect(calls[0]?.user).toBe(words.slice(0, 285).join(" "));
  });

  it("reads an image as a gesture only: no interests, Topics or life stage, and no model text", async () => {
    // Whatever the model adds, a reading is two enums. `known_as` is model
    // text, and nothing a template renders may come from one.
    const { chat, calls } = fixtureChat(
      JSON.stringify({
        kind: "meme",
        known_as: "Synthetic Film",
        meaning: "greeting",
        interests: ["laboratory science"],
        topics: ["outdoors"],
        life_stage: ["infant"],
      }),
    );

    const reading = await boundary(chat).readImage({ memberId: MEMBER, image: image() });

    expect(reading).toStrictEqual({ kind: "meme", meaning: "greeting" });
    expect(calls[0]).toMatchObject({ model: "test-vision", image: "data:image/jpeg;base64,AAAA" });
  });

  it("sends an image inline and still, never a link the provider would fetch or a whole GIF", async () => {
    const { chat, calls } = fixtureChat('{"kind":"meme","known_as":null,"meaning":"greeting"}');

    for (const dataUrl of ["https://media.discordapp.net/attachments/1/2/a.png", "data:image/gif;base64,AAAA"])
      await expect(
        boundary(chat).readImage({ memberId: MEMBER, image: image({ dataUrl }) }),
      ).rejects.toThrow(/inline still/);
    expect(calls).toHaveLength(0);
  });
});
