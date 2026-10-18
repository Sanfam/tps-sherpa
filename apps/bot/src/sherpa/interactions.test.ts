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
import { MONITORED_SEED, initDurableStore, readMonitored, withDurableStore } from "../sync/durable-store.ts";
import type { RoleManifestEntry } from "../sync/ports.ts";
import { RETAIN_MS, openTier0 } from "../sync/tier0-store.ts";
import { EMPTY_QUERY } from "./find.ts";
import {
  CAP_REACHED,
  FIND_OFF,
  FIND_OPTED_OUT,
  DEFAULT_FIND_DAILY_CAP,
  FAILED,
  NOT_A_MEMBER,
  NOT_STAFF,
  UNKNOWN,
  type EphemeralReply,
  type Sherpa,
  commandDefinitions,
  dailyCap,
  findDailyCap,
  handleInteraction,
} from "./interactions.ts";
import { openMonitored } from "./monitored.ts";
import {
  BACKFILL_OPT_IN_FIRST,
  BACKFILL_PENDING,
  BACKFILL_REQUESTED,
  MAX_EMBED_DESCRIPTION,
  NOTHING_DELETED,
  POLICY_INTRO,
  openPrivacy,
  renderDeleted,
} from "./privacy.ts";
import { withResponderStore } from "./responder-store.ts";

const GUILD = "400000000000000001";
const MEMBER_ROLE = "400000000000000002";
const OTHER_ROLE = "400000000000000003";
const STAFF_ROLE = "400000000000000004";
const EVENT_MANAGERS_ROLE = "400000000000000005";

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
  view_roles: [MEMBER_ROLE],
  deny_roles: [],
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
  { name: "Staff", color: 4, ids: [STAFF_ROLE] },
  { name: "Event Managers", color: 5, ids: [EVENT_MANAGERS_ROLE] },
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
  } & Partial<Pick<Sherpa, "loadCatalog" | "loadVocabulary" | "loadActivity" | "tally">> = {},
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
  // The real seed's Channel is not in these fixtures; a test that wants one
  // missing adds it back.
  const monitored = openMonitored(paths.durable);
  for (const c of MONITORED_SEED) monitored.remove(c.id);
  const sherpa: Sherpa = {
    guildId: GUILD,
    loadCatalog: opts.loadCatalog ?? (() => catalog),
    loadRoleManifest: () => opts.roles ?? manifest,
    loadVocabulary: opts.loadVocabulary ?? (() => vocabulary),
    loadActivity: opts.loadActivity ?? (() => ({})),
    privacy,
    monitored,
    settings: (work) => withResponderStore(work, paths.durable),
    tally: opts.tally,
    loadMonitored: (c) => readMonitored(c, paths.durable),
    askFor: (c) =>
      createBoundary({
        chat,
        models: { strong: "s", cheap: "c" },
        catalog: c,
        monitored: readMonitored(c, paths.durable),
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

describe("the invoker's own roles decide what is named (#53)", () => {
  const gated = entity({ id: "100000000000000003", name: "Moderators' corner", view_roles: [OTHER_ROLE] });
  const link = `**Moderators' corner** ([open](${gated.url}))`;

  it.each([
    ["holds the role", [MEMBER_ROLE, OTHER_ROLE], true],
    ["does not", [MEMBER_ROLE], false],
  ])("a role-gated place, to a Member who %s", async (_, roles, shown) => {
    const { run, calls } = harness({ loadCatalog: () => [...catalog, gated] });
    await run(command("find", { interests: QUERY }, { roles }));
    expect(calls[0]!.includes("Moderators' corner")).toBe(shown);
    expect((await run(command("lately", {}, { roles })))!.includes(link)).toBe(shown);
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
    expect(privacy.options.map((o) => o.name)).toEqual(["policy", "settings", "opt-out", "opt-in", "backfill", "delete-my-data"]);
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

describe("names kept for an opted-out member", () => {
  /** The interaction as Discord sends it: username, display name, server nickname. */
  const named = (sub: string, options: Record<string, string | boolean>, roles?: string[]) => {
    const base = privacyCommand(sub, options, roles ? { roles } : {}) as unknown as { member: { user: object } };
    return {
      ...base,
      member: { ...base.member, nick: "Papa G", user: { ...base.member.user, username: "gonzo", global_name: "Gonzo Rex" } },
    } as unknown as APIInteraction;
  };
  const kept = (durable: string) => withDurableStore((s) => s.optedOutNames().sort(), durable);

  it("are kept only for a Member — anyone else's opt-out still works, but keeps no names", async () => {
    const { run, privacy, paths } = harness();
    await run(named("opt-out", { setting: "processing" }, [OTHER_ROLE]));
    expect(privacy.settings(INVOKER).processing).toBe(false);
    expect(kept(paths.durable)).toEqual([]);
  });

  it("keeps none, and still opts out, before any sync has written a manifest", async () => {
    const { run, privacy, paths } = harness({ roles: [] });
    await run(named("opt-out", { setting: "processing" }));
    expect(privacy.settings(INVOKER).processing).toBe(false);
    expect(kept(paths.durable)).toEqual([]);
  });

  it("are taken from the opt-out itself, and only for processing", async () => {
    const { run, paths } = harness();
    await run(named("opt-out", { setting: "approach" }));
    expect(kept(paths.durable)).toEqual([]);
    await run(named("opt-out", { setting: "processing" }));
    expect(kept(paths.durable)).toEqual(["Gonzo Rex", "Papa G", "gonzo"]);
  });

  it("go when they opt back in", async () => {
    const { run, paths } = harness();
    await run(named("opt-out", { setting: "processing" }));
    await run(named("opt-in", { setting: "processing" }));
    expect(kept(paths.durable)).toEqual([]);
  });

  it("go with delete-my-data", async () => {
    const { run, paths } = harness();
    await run(named("opt-out", { setting: "processing" }));
    await run(named("delete-my-data", { confirm: true }));
    expect(kept(paths.durable)).toEqual([]);
  });
});

describe("/privacy backfill", () => {
  it("records nothing for someone with processing off, and says to opt in first", async () => {
    const { run, paths } = harness({ optedOut: true });
    expect(await run(privacyCommand("backfill"))).toBe(BACKFILL_OPT_IN_FIRST);
    expect(withDurableStore((s) => s.pendingBackfills(), paths.durable)).toEqual([]);
  });

  it("records one request per member, a repeat is a no-op, and opting out drops it", async () => {
    const { run, paths } = harness();
    expect(await run(privacyCommand("backfill"))).toBe(BACKFILL_REQUESTED);
    expect(await run(privacyCommand("backfill"))).toBe(BACKFILL_PENDING);
    expect(withDurableStore((s) => s.pendingBackfills(), paths.durable).map((r) => r.memberId)).toEqual([INVOKER]);
    await run(privacyCommand("opt-out", { setting: "processing" }));
    expect(withDurableStore((s) => s.pendingBackfills(), paths.durable)).toEqual([]);
  });

  it("is dropped by delete-my-data too", async () => {
    const { run, paths } = harness();
    await run(privacyCommand("backfill"));
    await run(privacyCommand("delete-my-data", { confirm: true }));
    expect(withDurableStore((s) => s.pendingBackfills(), paths.durable)).toEqual([]);
  });

  it("promises no more than Tier 0 keeps", () => {
    expect(BACKFILL_REQUESTED).toContain(`last ${RETAIN_MS / 86_400_000} days`);
  });
});

/** `/monitored <sub>`, with a channel option when given one, from Staff unless `roles` says otherwise. */
const monitoredCommand = (sub: string, channel?: string, roles: string[] = [STAFF_ROLE]): APIInteraction => {
  const base = command("monitored", {}, { roles }) as unknown as { data: object };
  return {
    ...base,
    data: {
      ...base.data,
      options: [
        {
          name: sub,
          type: ApplicationCommandOptionType.Subcommand,
          options: channel ? [{ name: "channel", type: ApplicationCommandOptionType.Channel, value: channel }] : [],
        },
      ],
    },
  } as unknown as APIInteraction;
};

/** `/sherpa introductions <sub>`, from Staff unless `roles` says otherwise. */
const sherpaCommand = (
  sub: string,
  options: Record<string, string | number> = {},
  roles: string[] = [STAFF_ROLE],
): APIInteraction => {
  const base = command("sherpa", {}, { roles }) as unknown as { data: object };
  return {
    ...base,
    data: {
      ...base.data,
      options: [
        {
          name: "introductions",
          type: ApplicationCommandOptionType.SubcommandGroup,
          options: [
            {
              name: sub,
              type: ApplicationCommandOptionType.Subcommand,
              options: Object.entries(options).map(([name, value]) => ({
                name,
                type: typeof value === "number" ? ApplicationCommandOptionType.Integer : ApplicationCommandOptionType.String,
                value,
              })),
            },
          ],
        },
      ],
    },
  } as unknown as APIInteraction;
};

describe("monitored channels fail closed", () => {
  it("/find and /lately refuse, without a model call, while a configured id is missing from the Catalog", async () => {
    const { run, calls, logs, paths } = harness();
    withDurableStore((s) => s.addMonitored("100000000000000099", "gone", "500000000000000002"), paths.durable);
    expect(await run(command("find", { interests: QUERY }))).toBe(FAILED);
    expect(await run(command("lately"))).toBe(FAILED);
    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("Monitored channel 100000000000000099 is not in the current Catalog");
  });

  it("keeps a monitored channel out of /find's prompt and /lately", async () => {
    const { run, calls, paths } = harness();
    withDurableStore((s) => s.addMonitored("100000000000000001", "Rocket League", "500000000000000002"), paths.durable);
    await run(command("find", { interests: QUERY }));
    expect(calls[0]).not.toContain("Rocket League");
    expect(await run(command("lately"))).not.toContain("<#100000000000000001>");
  });
});

describe("/monitored", () => {
  it("adds a channel in the Catalog, recording who, and refuses one that is not", async () => {
    const channel = entity({ id: "100000000000000003", name: "👋︱intros", type: "channel" });
    const { run, paths } = harness({ loadCatalog: () => [...catalog, channel] });
    expect(await run(monitoredCommand("add", "100000000000000098"))).toMatch(/isn't a channel/);
    // A Post: the carve-out reaches only one level down from what it names.
    expect(await run(monitoredCommand("add", "100000000000000001"))).toMatch(/isn't a channel/);
    expect(await run(monitoredCommand("add", channel.id))).toMatch(/^Done/);
    expect(withDurableStore((s) => s.monitoredChannels(), paths.durable)).toEqual([
      expect.objectContaining({ id: channel.id, name: "👋︱intros", addedBy: INVOKER }),
    ]);
    expect(await run(monitoredCommand("list"))).toContain(`<#${channel.id}>`);
  });

  it("logs a removal loudly, with who did it", async () => {
    const channel = entity({ id: "100000000000000003", name: "👋︱intros", type: "channel" });
    const { run, logs } = harness({ loadCatalog: () => [...catalog, channel] });
    await run(monitoredCommand("add", channel.id));
    expect(await run(monitoredCommand("remove", channel.id))).toMatch(/no longer monitored/);
    expect(logs.at(-1)).toMatch(new RegExp(`MONITORED CHANNEL REMOVED ${channel.id} by ${INVOKER}`));
  });

});

describe("the Staff gate, for /monitored and /sherpa", () => {
  const intros = entity({ id: "100000000000000003", name: "👋︱intros", type: "channel" });
  it.each([
    ["Staff", true, [STAFF_ROLE]],
    ["Event Managers alone, without Member", true, [EVENT_MANAGERS_ROLE]],
    ["Member alone", false, [MEMBER_ROLE]],
    ["no role", false, []],
  ])("%s: admitted %s", async (_, admitted, roles) => {
    const { run, paths } = harness({ loadCatalog: () => [...catalog, intros] });
    const monitoredAnswer = await run(monitoredCommand("add", intros.id, roles));
    const sherpaAnswer = await run(sherpaCommand("mode", { mode: "live" }, roles));
    const mode = withResponderStore((s) => s.mode(), paths.durable);
    const channels = withDurableStore((s) => s.monitoredChannels(), paths.durable);
    if (admitted) {
      expect(monitoredAnswer).toMatch(/^Done/);
      expect(sherpaAnswer).toMatch(/^Done/);
      expect([mode, channels.length]).toEqual(["live", 1]);
    } else {
      expect([monitoredAnswer, sherpaAnswer]).toEqual([NOT_STAFF, NOT_STAFF]);
      expect([mode, channels.length]).toEqual(["off", 0]);
    }
  });

  it("admits nobody before any sync has written a manifest", async () => {
    const { run } = harness({ roles: [] });
    expect(await run(sherpaCommand("status"))).toBe(NOT_STAFF);
    expect(await run(monitoredCommand("list"))).toBe(NOT_STAFF);
  });
});

describe("/sherpa introductions", () => {
  const SETTINGS =
    "Mode: **off**\nClock: **wall**\nGreet: **10** minutes\nRecommend: **20** minutes\nCeiling: **6** active hours";

  it("is off with no mode row, and shows the default thresholds, then the tally", async () => {
    const { run } = harness({ tally: async () => "TALLY" });
    expect(await run(sherpaCommand("status"))).toBe(`${SETTINGS}\nTALLY`);
  });

  it("still shows the settings when the tally cannot be read", async () => {
    const { run, logs } = harness({
      tally: async () => {
        throw new Error("Discord 503");
      },
    });
    expect(await run(sherpaCommand("status"))).toBe(`${SETTINGS}\nShadow tally: unavailable right now.`);
    expect(logs.at(-1)).toMatch(/tally unavailable: Discord 503/);
  });

  it("logs live loudly, with who set it", async () => {
    const { run, logs, paths } = harness();
    await run(sherpaCommand("mode", { mode: "shadow" }));
    expect(logs.at(-1)).not.toMatch(/LIVE/);
    await run(sherpaCommand("mode", { mode: "live" }));
    expect(logs.at(-1)).toMatch(new RegExp(`INTRODUCTIONS MODE SET TO LIVE by ${INVOKER}`));
    expect(withResponderStore((s) => s.mode(), paths.durable)).toBe("live");
  });

  it("refuses timing out of bounds, or recommend below greet against what is stored, writing nothing", async () => {
    const { run, paths } = harness();
    const stored = () =>
      withResponderStore(
        (s) => (["greet_minutes", "recommend_minutes", "ceiling_active_hours"] as const).map((k) => s.setting(k)),
        paths.durable,
      );
    for (const options of [
      { greet: 0 } as Record<string, number>,
      { greet: 121 },
      { recommend: 361 },
      { ceiling: 25 },
      { greet: 5, ceiling: 0 },
      // Against the default recommend of 20, and the default greet of 10.
      { greet: 30 },
      { recommend: 5 },
    ])
      expect(await run(sherpaCommand("timing", options))).toMatch(/^Nothing changed/);
    expect(stored()).toEqual([null, null, null]);

    expect(await run(sherpaCommand("timing", { greet: 30, recommend: 30 }))).toMatch(/^Done/);
    expect(await run(sherpaCommand("timing", { recommend: 20 }))).toMatch(/^Nothing changed/);
    expect(await run(sherpaCommand("timing", { ceiling: 24 }))).toMatch(/^Done/);
    expect(stored()).toEqual(["30", "30", "24"]);
  });
});
