import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type APIInteraction,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionType,
  MessageFlags,
} from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import type { ActivityStore } from "../llm/activity.ts";
import { createBoundary, type ChatPort } from "../llm/boundary.ts";
import { PRIVACY_POLICY_PATH, retrying } from "../llm/session.ts";
import type { Vocabulary } from "../llm/vocabulary.ts";
import type { Entity } from "../sync/catalog.ts";
import { initDurableStore } from "../sync/durable-store.ts";
import type { RoleManifestEntry } from "../sync/ports.ts";
import { openTier0 } from "../sync/tier0-store.ts";
import { EMPTY_QUERY } from "./find.ts";
import {
  CAP_REACHED,
  FIND_OFF,
  FIND_OPTED_OUT,
  DEFAULT_FIND_DAILY_CAP,
  FAILED,
  NOT_A_MEMBER,
  UNKNOWN,
  type EphemeralReply,
  type Sherpa,
  commandDefinitions,
  dailyCap,
  findDailyCap,
  handleInteraction,
} from "./interactions.ts";
import { MAX_EMBED_DESCRIPTION, NOTHING_DELETED, POLICY_INTRO, openPrivacy, renderDeleted } from "./privacy.ts";

const GUILD = "400000000000000001";
const MEMBER_ROLE = "400000000000000002";
const OTHER_ROLE = "400000000000000003";

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
  thread_state: "open",
  last_message_id: null,
  last_activity_at: new Date().toISOString(),
  summary_generated: null,
  summary_override: null,
  ...over,
});

const catalog = [
  entity({ id: "100000000000000001", name: "Rocket League", summary_generated: "Car football." }),
  entity({ id: "100000000000000002", name: "Flight Simulators", summary_generated: "Sims." }),
];

const vocabulary = {
  version: 2,
  frozen_at: "2026-09-26",
  status: "frozen",
  topics: [{ slug: "gaming", label: "Gaming", description: "Games." }],
} as Vocabulary;

const manifest: RoleManifestEntry[] = [
  { name: "Member", color: 1, ids: ["400000000000000009"] },
  // A duplicate-named role: the sync unions them, and so must the gate.
  { name: "Member", color: 2, ids: [MEMBER_ROLE] },
  { name: "Moderator", color: 3, ids: [OTHER_ROLE] },
];

const QUERY = "distinctive-query-text flying and rocket league";

const command = (
  name: string,
  options: Record<string, string> = {},
  over: { guild_id?: string; roles?: string[]; type?: number; dataType?: number } = {},
): APIInteraction =>
  ({
    id: "600000000000000001",
    application_id: "600000000000000002",
    token: "interaction-token",
    type: over.type ?? InteractionType.ApplicationCommand,
    guild_id: over.guild_id ?? GUILD,
    member: { roles: over.roles ?? [MEMBER_ROLE], user: { id: "500000000000000001" } },
    data: {
      name,
      type: over.dataType ?? ApplicationCommandType.ChatInput,
      options: Object.entries(options).map(([n, value]) => ({
        name: n,
        type: ApplicationCommandOptionType.String,
        value,
      })),
    },
  }) as unknown as APIInteraction;

const INVOKER = "500000000000000001";

/** `/privacy <sub>` with its options, as Discord nests them under the subcommand. */
const privacyCommand = (
  sub: string,
  options: Record<string, string | boolean> = {},
  over: { roles?: string[] } = {},
): APIInteraction => {
  const base = command("privacy", {}, over) as unknown as { data: object };
  return {
    ...base,
    data: {
      ...base.data,
      options: [
        {
          name: sub,
          type: ApplicationCommandOptionType.Subcommand,
          options: Object.entries(options).map(([name, value]) => ({
            name,
            type: typeof value === "boolean" ? ApplicationCommandOptionType.Boolean : ApplicationCommandOptionType.String,
            value,
          })),
        },
      ],
    },
  } as unknown as APIInteraction;
};

/** `/privacy`'s real stores, on temp paths: bot.db, tier0.db, activity.json and the policy. */
const tempPrivacy = (policy = "The policy.") => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-privacy-"));
  const paths = {
    durable: join(dir, "bot.db"),
    tier0: join(dir, "tier0.db"),
    activity: join(dir, "activity.json"),
    policy: join(dir, "privacy-policy.md"),
  };
  initDurableStore(paths.durable, { exclusionSeed: null, catalog: null, roleManifest: null });
  writeFileSync(paths.policy, policy);
  return { paths, privacy: openPrivacy(paths) };
};

const tempCap = (limit: number, now?: () => Date) => {
  const path = join(mkdtempSync(join(tmpdir(), "sherpa-cap-")), "find-usage.json");
  return { path, cap: dailyCap(path, limit, () => {}, now) };
};

/** A Sherpa wired to fixtures: a real boundary over a fake wire, a real cap on a temp file. */
const harness = (
  opts: {
    reply?: string | (() => string);
    limit?: number;
    roles?: RoleManifestEntry[];
    policy?: string;
    /** The invoker has turned processing off. */
    optedOut?: boolean;
  } & Partial<Pick<Sherpa, "loadCatalog" | "loadVocabulary" | "loadActivity">> = {},
) => {
  const calls: string[] = [];
  const logs: string[] = [];
  const chat: ChatPort = {
    complete: async ({ user }) => {
      calls.push(user);
      const r = opts.reply ?? '{"matches":["e1","e2"],"topics":["gaming"]}';
      return typeof r === "function" ? r() : r;
    },
  };
  const { cap, path } = tempCap(opts.limit ?? 10);
  const { privacy, paths } = tempPrivacy(opts.policy);
  if (opts.optedOut) privacy.set(INVOKER, "processing", false);
  const sherpa: Sherpa = {
    guildId: GUILD,
    loadCatalog: opts.loadCatalog ?? (() => catalog),
    loadRoleManifest: () => opts.roles ?? manifest,
    loadVocabulary: opts.loadVocabulary ?? (() => vocabulary),
    loadActivity: opts.loadActivity ?? (() => ({})),
    privacy,
    askFor: (c) =>
      createBoundary({
        chat,
        models: { strong: "s", cheap: "c" },
        catalog: c,
        names: { channels: new Map(), roles: new Map() },
      }).ask,
    retrying: (work) => retrying(work),
    cap,
    log: (m) => logs.push(m),
  };
  const sent: { defers: unknown[]; replies: EphemeralReply[] } = { defers: [], replies: [] };
  const run = async (interaction: APIInteraction) => {
    await handleInteraction(interaction, sherpa, {
      defer: async (body) => sent.defers.push(body),
      followUp: async (body) => sent.replies.push(body),
    });
    return sent.replies.at(-1)?.content;
  };
  return { run, sent, calls, logs, capPath: path, privacy, paths };
};

describe("every reply is ephemeral", () => {
  it("on every branch the handlers have", async () => {
    const branches: Array<[string, Parameters<typeof harness>[0], APIInteraction]> = [
      ["find, matches", {}, command("find", { interests: QUERY })],
      ["find, few", { reply: '{"matches":[]}' }, command("find", { interests: QUERY })],
      ["find, empty", {}, command("find", { interests: "  " })],
      // The first call spends the only one; the retry finds the day spent.
      ["find, capped", { limit: 1, reply: "not json" }, command("find", { interests: QUERY })],
      ["find, off", { limit: 0 }, command("find", { interests: QUERY })],
      ["find, model broken", { reply: "not json" }, command("find", { interests: QUERY })],
      ["find, not a Member", {}, command("find", { interests: QUERY }, { roles: [OTHER_ROLE] })],
      ["lately", {}, command("lately")],
      ["lately, topic", {}, command("lately", { topic: "gaming" })],
      ["find, processing off", { optedOut: true }, command("find", { interests: QUERY })],
      ["privacy, policy", {}, privacyCommand("policy")],
      ["privacy, settings", {}, privacyCommand("settings")],
      ["privacy, opt-out", {}, privacyCommand("opt-out", { setting: "processing" })],
      ["privacy, opt-in", {}, privacyCommand("opt-in", { setting: "approach" })],
      ["privacy, delete unconfirmed", {}, privacyCommand("delete-my-data", { confirm: false })],
      ["privacy, delete", {}, privacyCommand("delete-my-data", { confirm: true })],
      ["unknown command", {}, command("nope")],
    ];
    const contents = new Set<string>();
    for (const [, opts, interaction] of branches) {
      const { run, sent } = harness(opts);
      contents.add((await run(interaction))!);
      expect(sent.defers).toEqual([{ flags: MessageFlags.Ephemeral }]);
      expect(sent.replies).toHaveLength(1);
      expect(sent.replies[0]!.flags).toBe(64);
      expect(sent.replies[0]!.allowed_mentions).toEqual({ parse: [] });
    }
    // Each branch reached a different answer, so none was skipped by accident.
    expect(contents.size).toBe(branches.length);
    expect(contents).toContain(CAP_REACHED);
    expect(contents).toContain(FIND_OFF);
    expect(contents).toContain(FAILED);
    expect(contents).toContain(NOT_A_MEMBER);
    expect(contents).toContain(EMPTY_QUERY);
    expect(contents).toContain(UNKNOWN);
  });

  it("ignores what is not a slash command, sending nothing", async () => {
    const { run, sent } = harness();
    await run(command("find", {}, { type: InteractionType.MessageComponent }));
    await run(command("find", {}, { dataType: ApplicationCommandType.User }));
    expect(sent.defers).toEqual([]);
    expect(sent.replies).toEqual([]);
  });
});

describe("/privacy", () => {
  const seed = (paths: { tier0: string; activity: string }) => {
    const tier0 = openTier0(paths.tier0);
    const m = (entityId: string, messageId: string, authorId: string) => ({
      entityId,
      messageId,
      authorId,
      authorIsBot: false,
      content: "distinctive-member-text",
      createdAt: "",
      window: "head" as const,
    });
    tier0.record("e1", "1", [m("e1", "m1", INVOKER), m("e1", "m2", "someone-else")]);
    tier0.record("e2", "1", [m("e2", "m3", INVOKER), m("e2", "m4", INVOKER)]);
    tier0.record("e3", "1", [m("e3", "m5", "someone-else")]);
    tier0.close();
    const activity: ActivityStore = {
      e1: { summary: "fed by them", as_of: "1", authors: ["someone-else"] },
      e3: { summary: "not fed by them", as_of: "1", authors: ["someone-else"] },
      // Their messages there are already purged from Tier 0; only the record says so.
      e4: { summary: "fed by them, long ago", as_of: "1", authors: [INVOKER] },
    };
    writeFileSync(paths.activity, JSON.stringify(activity));
  };
  const remaining = (path: string) => {
    const tier0 = openTier0(path);
    const authors = ["e1", "e2", "e3"].flatMap((id) => tier0.messagesFor(id).map((m) => m.authorId));
    tier0.close();
    return authors.sort();
  };

  it("is open to someone without the Member role", async () => {
    const { run } = harness();
    const reply = await run(privacyCommand("settings", {}, { roles: [OTHER_ROLE] }));
    expect(reply).toContain("Your Sherpa settings:");
    expect(reply).toContain("Reading what you write: on.");
  });

  it("sends the policy in an embed, and refuses one too long for it rather than cutting it", async () => {
    const { run, sent } = harness({ policy: "Sherpa keeps little." });
    expect(await run(privacyCommand("policy"))).toBe(POLICY_INTRO);
    expect(sent.replies[0]!.embeds).toEqual([{ description: "Sherpa keeps little." }]);

    const long = harness({ policy: "p".repeat(MAX_EMBED_DESCRIPTION + 1) });
    expect(await long.run(privacyCommand("policy"))).toBe(FAILED);
    expect(long.sent.replies[0]!.embeds).toBeUndefined();
  });

  it("answers a subcommand it does not know as unknown", async () => {
    const { run } = harness();
    expect(await run(privacyCommand("nope"))).toBe(UNKNOWN);
    expect(await run(privacyCommand("opt-out", { setting: "everything" }))).toBe(UNKNOWN);
  });

  it("turns a setting off and back on, for the invoker only", async () => {
    const { run, privacy } = harness();
    await run(privacyCommand("opt-out", { setting: "approach" }));
    expect(privacy.settings(INVOKER)).toEqual({ approach: false, processing: true });
    expect(privacy.settings("someone-else")).toEqual({ approach: true, processing: true });
    await run(privacyCommand("opt-in", { setting: "approach" }));
    expect(privacy.settings(INVOKER).approach).toBe(true);
  });

  it("deletes nothing without confirm, and says so", async () => {
    const { run, paths, privacy } = harness();
    seed(paths);
    expect(await run(privacyCommand("delete-my-data", { confirm: false }))).toBe(NOTHING_DELETED);
    expect(remaining(paths.tier0)).toHaveLength(5);
    expect(Object.keys(JSON.parse(readFileSync(paths.activity, "utf8")))).toEqual(["e1", "e3", "e4"]);
    expect(privacy.settings(INVOKER).processing).toBe(true);
  });

  it("reports summaries cleared even when Tier 0 had already let their messages go", () => {
    expect(renderDeleted({ messages: 2, places: 1, summaries: 0, checkpointed: false })).toContain(
      "wiped at its next cleanup, within six hours",
    );
    expect(renderDeleted({ messages: 2, places: 1, summaries: 0, checkpointed: true })).not.toContain("next cleanup");
    expect(renderDeleted({ messages: 0, places: 0, summaries: 1, checkpointed: true })).toMatch(
      /^Done\. Sherpa had none of your messages stored, and cleared 1 activity summary they fed into/,
    );
  });

  it("leaves processing off when deleting the messages fails, so a retry is safe", () => {
    const { paths, privacy } = tempPrivacy();
    // A directory where Tier 0 should be: opening it throws.
    const broken = openPrivacy({ ...paths, tier0: mkdtempSync(join(tmpdir(), "not-a-db-")) });
    expect(() => broken.deleteMyData(INVOKER)).toThrow();
    expect(privacy.settings(INVOKER).processing).toBe(false);
  });

  it("erases their messages even when activity.json is corrupt, and still reports the failure", () => {
    const { paths, privacy } = tempPrivacy();
    const other = openTier0(paths.tier0);
    other.record("e1", "1", [
      { entityId: "e1", messageId: "m1", authorId: INVOKER, authorIsBot: false, content: "distinctive-erased-text", createdAt: "", window: "head" },
    ]);
    writeFileSync(paths.activity, "{ not json");
    expect(() => privacy.deleteMyData(INVOKER)).toThrow(/JSON/);
    expect(other.authoredIn(INVOKER)).toEqual([]);
    for (const file of [paths.tier0, `${paths.tier0}-wal`])
      expect(readFileSync(file).includes("distinctive-erased-text")).toBe(false);
    other.close();
  });

  it("checkpoints Tier 0, so the deletion reaches the file while another process holds it open", () => {
    const { paths, privacy } = tempPrivacy();
    const other = openTier0(paths.tier0);
    other.record("e1", "1", [
      { entityId: "e1", messageId: "m1", authorId: INVOKER, authorIsBot: false, content: "distinctive-erased-text", createdAt: "", window: "head" },
    ]);
    expect(privacy.deleteMyData(INVOKER)).toMatchObject({ messages: 1, checkpointed: true });
    for (const file of [paths.tier0, `${paths.tier0}-wal`])
      expect(readFileSync(file).includes("distinctive-erased-text")).toBe(false);
    other.close();
  });

  it("deletes their messages and the summaries those fed, turns processing off, and echoes nothing", async () => {
    const { run, paths, privacy, logs } = harness();
    seed(paths);
    const reply = (await run(privacyCommand("delete-my-data", { confirm: true })))!;

    expect(remaining(paths.tier0)).toEqual(["someone-else", "someone-else"]);
    expect(Object.keys(JSON.parse(readFileSync(paths.activity, "utf8")))).toEqual(["e3"]);
    expect(privacy.settings(INVOKER).processing).toBe(false);

    expect(reply).toContain("3 messages of yours from 2 places");
    expect(reply).toContain("cleared 2 activity summaries");
    expect(reply).toContain("within 30 days");
    expect(reply).toContain("`/privacy opt-in processing`");
    for (const text of [reply, logs.join("\n")]) {
      expect(text).not.toContain("distinctive-member-text");
      expect(text).not.toContain("fed by them");
    }
    expect(logs.join("\n")).not.toContain(INVOKER);
  });
});

describe("/find with processing off", () => {
  const broken = () => {
    throw new Error("unreadable");
  };

  it("says so and how to turn it back on, before reading the Catalog or calling a model", async () => {
    const { run, calls, capPath } = harness({ optedOut: true, loadCatalog: broken, loadVocabulary: broken });
    expect(await run(command("find", { interests: QUERY }))).toBe(FIND_OPTED_OUT);
    expect(calls).toHaveLength(0);
    expect(() => readFileSync(capPath)).toThrow();
  });

  it("says /find is off first, when it is off for everyone", async () => {
    const { run } = harness({ optedOut: true, limit: 0 });
    expect(await run(command("find", { interests: QUERY }))).toBe(FIND_OFF);
  });

  it("works again once processing is back on", async () => {
    const { run, calls } = harness({ optedOut: true });
    await run(privacyCommand("opt-in", { setting: "processing" }));
    expect(await run(command("find", { interests: QUERY }))).toContain("**Rocket League** ([open](https://discord.com/channels/1/100000000000000001))");
    expect(calls).toHaveLength(1);
  });

  it("leaves /lately alone", async () => {
    const { run } = harness({ optedOut: true });
    expect(await run(command("lately"))).toContain("Active lately");
  });
});

describe("/lately through the dispatcher", () => {
  it("shows activity summaries, and logs a count, never their text", async () => {
    const { run, logs } = harness({
      loadActivity: () => ({ "100000000000000001": { summary: "distinctive-activity-text", as_of: "1" } }),
    });
    expect(await run(command("lately"))).toContain("↳ Lately: distinctive-activity-text");
    expect(logs.join("\n")).not.toContain("distinctive-activity-text");
    expect(logs).toEqual([expect.stringMatching(/places=2 activity=1$/)]);
  });
});

describe("the Member gate", () => {
  it("answers a Member holding any role named Member", async () => {
    const { run, calls } = harness();
    expect(await run(command("find", { interests: QUERY }))).toContain("**Rocket League** ([open](https://discord.com/channels/1/100000000000000001))");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["without the role", { roles: [OTHER_ROLE] }, manifest],
    ["from another guild", { guild_id: "400000000000000099" }, manifest],
    ["before any sync has written a manifest", {}, []],
  ])("refuses an invoker %s, before any model call", async (_, over, roles) => {
    const { run, calls } = harness({ roles });
    expect(await run(command("find", { interests: QUERY }, over))).toBe(NOT_A_MEMBER);
    expect(await run(command("lately", {}, over))).toBe(NOT_A_MEMBER);
    expect(calls).toHaveLength(0);
  });

  it("refuses an interaction with no member, as from a DM", async () => {
    const { run } = harness();
    const dm = { ...(command("lately") as object), member: undefined } as unknown as APIInteraction;
    expect(await run(dm)).toBe(NOT_A_MEMBER);
  });
});

describe("/find through the dispatcher", () => {
  it("never logs the query, only ids and counts", async () => {
    const { run, logs } = harness();
    await run(command("find", { interests: QUERY }));
    expect(logs.join("\n")).not.toContain("distinctive-query-text");
    expect(logs.join("\n")).not.toContain("500000000000000001");
    expect(logs).toEqual([expect.stringMatching(/^\[sherpa\] \/find \d+ candidates=2 matches=2 topics=1 dropped=0$/)]);
  });

  it("answers an empty query from the template, without spending the cap", async () => {
    const { run, calls, capPath } = harness({ limit: 1 });
    expect(await run(command("find", { interests: "" }))).toBe(EMPTY_QUERY);
    expect(await run(command("find"))).toBe(EMPTY_QUERY);
    expect(calls).toHaveLength(0);
    expect(() => readFileSync(capPath)).toThrow();
  });
});

describe("the daily /find cap", () => {
  it("stops model calls at the limit", async () => {
    const { run, calls } = harness({ limit: 2 });
    for (let i = 0; i < 2; i++) expect(await run(command("find", { interests: QUERY }))).not.toBe(CAP_REACHED);
    expect(await run(command("find", { interests: QUERY }))).toBe(CAP_REACHED);
    expect(calls).toHaveLength(2);
  });

  it("counts a retry as a call", async () => {
    let n = 0;
    const { run, calls } = harness({ limit: 2, reply: () => (n++ === 0 ? "not json" : '{"matches":[]}') });
    await run(command("find", { interests: QUERY }));
    expect(calls).toHaveLength(2);
    expect(await run(command("find", { interests: QUERY }))).toBe(CAP_REACHED);
  });

  it("says /find is off, rather than spent, when the cap is 0 — reading nothing", async () => {
    const broken = () => {
      throw new Error("unreadable");
    };
    const { run, calls } = harness({ limit: 0, loadCatalog: broken, loadVocabulary: broken });
    expect(await run(command("find", { interests: QUERY }))).toBe(FIND_OFF);
    expect(calls).toHaveLength(0);
  });

  it("leaves /lately alone once spent", async () => {
    const { run } = harness({ limit: 0 });
    expect(await run(command("lately"))).toContain("Active lately");
  });

  it("survives a restart, and a new UTC day resets it", () => {
    let now = new Date("2026-10-15T23:59:00Z");
    const { path, cap } = tempCap(2, () => now);
    expect(cap.take()).toBe(true);
    expect(cap.take()).toBe(true);
    const restarted = dailyCap(path, 2, () => {}, () => now);
    expect(restarted.take()).toBe(false);
    now = new Date("2026-10-16T00:01:00Z");
    expect(restarted.take()).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ day: "2026-10-16", count: 1 });
  });

  it("treats an unreadable store as a spent day, not a fresh one", () => {
    const { path } = tempCap(5);
    writeFileSync(path, "{ not json");
    const warnings: string[] = [];
    const cap = dailyCap(path, 5, (m) => warnings.push(m));
    expect(cap.take()).toBe(false);
    expect(warnings).toHaveLength(1);
    writeFileSync(path, JSON.stringify({ day: "2026-10-15", count: "3" }));
    expect(dailyCap(path, 5, () => {}).take()).toBe(false);
    // Negative would never reach the limit; not an integer, ditto.
    for (const count of [-5, -1e308, 2.5]) {
      writeFileSync(path, JSON.stringify({ day: "2026-10-15", count }));
      expect(dailyCap(path, 5, () => {}, () => new Date("2026-10-15T12:00:00Z")).take()).toBe(false);
    }
  });

  it("reads its limit from the environment, strictly", () => {
    expect(findDailyCap(undefined)).toBe(DEFAULT_FIND_DAILY_CAP);
    expect(findDailyCap("")).toBe(DEFAULT_FIND_DAILY_CAP);
    expect(findDailyCap("0")).toBe(0);
    expect(findDailyCap(" 120 ")).toBe(120);
    for (const bad of ["-1", "1.5", "ten", "1e3", "9".repeat(400)]) expect(() => findDailyCap(bad)).toThrow(/non-negative integer/);
  });
});

describe("command definitions", () => {
  it("requires the /find text and bounds its length", () => {
    const [find] = commandDefinitions(vocabulary) as Array<{ options: Array<Record<string, unknown>> }>;
    expect(find!.options[0]).toMatchObject({ name: "interests", required: true, max_length: 300 });
  });

  it("offers the frozen vocabulary as /lately's choices, and refuses one Discord cannot hold", () => {
    const [, lately] = commandDefinitions(vocabulary) as Array<{ options: Array<{ choices: unknown }> }>;
    expect(lately!.options[0]!.choices).toEqual([{ name: "Gaming", value: "gaming" }]);
    const big = { ...vocabulary, topics: Array.from({ length: 26 }, (_, i) => ({ slug: `t${i}`, label: `T${i}`, description: "" })) };
    expect(() => commandDefinitions(big)).toThrow(/26 Topics/);
  });
});

describe("the /privacy definition", () => {
  it("offers each subcommand, a required setting, and a required confirm", () => {
    const privacy = commandDefinitions(vocabulary)[2] as {
      name: string;
      options: Array<{ name: string; options?: Array<{ name: string; type: number; required: boolean; choices?: unknown }> }>;
    };
    expect(privacy.name).toBe("privacy");
    expect(privacy.options.map((o) => o.name)).toEqual(["policy", "settings", "opt-out", "opt-in", "delete-my-data"]);
    for (const sub of ["opt-out", "opt-in"]) {
      const [setting] = privacy.options.find((o) => o.name === sub)!.options!;
      expect(setting).toMatchObject({ name: "setting", required: true });
      expect((setting!.choices as Array<{ value: string }>).map((c) => c.value)).toEqual(["approach", "processing"]);
    }
    expect(privacy.options.at(-1)!.options).toEqual([
      expect.objectContaining({ name: "confirm", type: ApplicationCommandOptionType.Boolean, required: true }),
    ]);
  });

  it("fits the policy Staff wrote in one embed", () => {
    expect(readFileSync(PRIVACY_POLICY_PATH, "utf8").length).toBeLessThanOrEqual(MAX_EMBED_DESCRIPTION);
  });
});
