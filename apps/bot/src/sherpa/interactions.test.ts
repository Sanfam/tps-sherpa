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
import { createBoundary, type ChatPort } from "../llm/boundary.ts";
import { retrying } from "../llm/session.ts";
import type { Vocabulary } from "../llm/vocabulary.ts";
import type { Entity } from "../sync/catalog.ts";
import type { RoleManifestEntry } from "../sync/ports.ts";
import { EMPTY_QUERY } from "./find.ts";
import {
  CAP_REACHED,
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

const tempCap = (limit: number, now?: () => Date) => {
  const path = join(mkdtempSync(join(tmpdir(), "sherpa-cap-")), "find-usage.json");
  return { path, cap: dailyCap(path, limit, () => {}, now) };
};

/** A Sherpa wired to fixtures: a real boundary over a fake wire, a real cap on a temp file. */
const harness = (opts: { reply?: string | (() => string); limit?: number; roles?: RoleManifestEntry[] } = {}) => {
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
  const sherpa: Sherpa = {
    guildId: GUILD,
    loadCatalog: () => catalog,
    loadRoleManifest: () => opts.roles ?? manifest,
    loadVocabulary: () => vocabulary,
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
  return { run, sent, calls, logs, capPath: path };
};

describe("every reply is ephemeral", () => {
  it("on every branch the handlers have", async () => {
    const branches: Array<[string, Parameters<typeof harness>[0], APIInteraction]> = [
      ["find, matches", {}, command("find", { interests: QUERY })],
      ["find, few", { reply: '{"matches":[]}' }, command("find", { interests: QUERY })],
      ["find, empty", {}, command("find", { interests: "  " })],
      ["find, capped", { limit: 0 }, command("find", { interests: QUERY })],
      ["find, model broken", { reply: "not json" }, command("find", { interests: QUERY })],
      ["find, not a Member", {}, command("find", { interests: QUERY }, { roles: [OTHER_ROLE] })],
      ["lately", {}, command("lately")],
      ["lately, topic", {}, command("lately", { topic: "gaming" })],
      ["unknown command", {}, command("privacy")],
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

describe("the Member gate", () => {
  it("answers a Member holding any role named Member", async () => {
    const { run, calls } = harness();
    expect(await run(command("find", { interests: QUERY }))).toContain("<#100000000000000001>");
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
