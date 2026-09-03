import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Entity } from "../sync/catalog.ts";
import type { NameLookup } from "../sync/normalise.ts";
import { createBoundary, type ChatPort, type Source } from "./boundary.ts";
import { wireFromEnv } from "./openai-wire.ts";

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
  last_message_id: null,
  last_activity_at: null,
  summary_generated: null,
  summary_override: null,
  ...over,
});

/** Records what it was sent and answers whatever the test tells it to. */
const fixtureChat = (reply: string | (() => string)) => {
  const calls: Array<{ model: string; system: string; user: string }> = [];
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
    models: { strong: "test-strong", cheap: "test-cheap" },
    catalog: [post, intro, introThread],
    names,
    ...over,
  });

const ask = { role: "cheap" as const, system: "Answer in JSON.", subject: post, parse: (v: unknown) => v };

describe("the redaction boundary", () => {
  it("replaces member mentions before the text leaves", async () => {
    const { chat, calls } = fixtureChat('{"summary":"co-op shooter nights"}');

    await boundary(chat).ask({
      ...ask,
      sources: [{ authorId: "1", authorIsBot: false, content: "<@732682426853359667> is in" }],
    });

    expect(calls[0]?.user).toBe("@member is in");
  });

  it("strips a bare snowflake nobody wrapped in mention syntax", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');

    await boundary(chat).ask({
      ...ask,
      sources: [{ authorId: "1", authorIsBot: false, content: "ping 732682426853359667 about it" }],
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

  it("redacts the model output it quotes back in the error", async () => {
    // A model that answered with prose may have echoed its input back, and an
    // exception message is a place logs keep things.
    const { chat } = fixtureChat("Sorry! Ask 732682426853359667 instead.");

    await expect(boundary(chat).ask(ask)).rejects.toThrow(/\[id\]/);
  });
});

describe("what never reaches a model", () => {
  it("refuses monitored-channel content", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');

    await expect(boundary(chat).ask({ ...ask, subject: intro })).rejects.toThrow(/monitored/i);
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

  it("refuses a subject whose parent is not in the Catalog", async () => {
    // Fail closed: an unresolvable parent is a broken input, not a permission.
    const { chat, calls } = fixtureChat('{"ok":true}');
    const orphan = entity({ id: "40", name: "Orphan", parent_id: "does-not-exist" });

    await expect(boundary(chat).ask({ ...ask, subject: orphan })).rejects.toThrow(
      /cannot be made/i,
    );
    expect(calls).toHaveLength(0);
  });

  it("replaces a known member's name before the text leaves", async () => {
    // Validating only the response would still have handed the name to the
    // provider. Redaction is outbound as well as inbound.
    const { chat, calls } = fixtureChat('{"ok":true}');

    await boundary(chat, { memberNames: ["Schwagle"] }).ask({
      ...ask,
      context: "Schwagle runs this one",
      sources: [{ authorId: "1", authorIsBot: false, content: "ask Schwagle about it" }],
    });

    expect(calls[0]?.user).not.toMatch(/Schwagle/i);
    expect(calls[0]?.user).toBe("@member runs this one\nask @member about it");
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
      { authorId: "opted-out", authorIsBot: false, content: "please forget me" },
      { authorId: "fine", authorIsBot: false, content: "great thread" },
    ];

    await boundary(chat, { hasOptedOut: (id) => id === "opted-out" }).ask({ ...ask, sources });

    expect(calls[0]?.user).toBe("great thread");
    expect(calls[0]?.user).not.toContain("forget me");
  });

  it("assumes nobody has opted out until there is a store to ask", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');

    await boundary(chat).ask({
      ...ask,
      sources: [{ authorId: "anyone", authorIsBot: false, content: "still here" }],
    });

    expect(calls[0]?.user).toBe("still here");
  });

  it("drops bot and webhook messages", async () => {
    const { chat, calls } = fixtureChat('{"ok":true}');

    await boundary(chat).ask({
      ...ask,
      sources: [
        { authorId: "bot", authorIsBot: true, content: "Poll closed." },
        { authorId: "human", authorIsBot: false, content: "good game" },
      ],
    });

    expect(calls[0]?.user).toBe("good game");
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
