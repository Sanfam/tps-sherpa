/**
 * The slash commands: their definitions, who may use them, and the one path
 * every answer takes back to Discord.
 *
 * Every reply is ephemeral. Sherpa has never posted publicly, and its first
 * public post is a decision for a person, not a side effect of a code path —
 * so there is exactly one reply builder here, and it always sets the flag.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type APIChatInputApplicationCommandInteraction,
  type APIEmbed,
  type APIInteraction,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionType,
  MessageFlags,
  type RESTPutAPIApplicationGuildCommandsJSONBody,
} from "discord-api-types/v10";
import type { ActivityStore } from "../llm/activity.ts";
import type { Boundary } from "../llm/boundary.ts";
import type { Vocabulary } from "../llm/vocabulary.ts";
import type { Entity } from "../sync/catalog.ts";
import { MEMBER_ROLE_NAME } from "../sync/discord-adapter.ts";
import type { RoleManifestEntry } from "../sync/ports.ts";
import { ALERTS_COMMAND, type AlertsStore, answerAlerts } from "./alerts.ts";
import { EMPTY_QUERY, MAX_QUERY_LENGTH, findPlaces, renderFind } from "./find.ts";
import { latelyPlaces, renderLately } from "./lately.ts";
import { MONITORED_COMMAND, type Monitored, answerMonitored } from "./monitored.ts";
import { type Answer, PRIVACY_COMMAND, type Privacy, answerPrivacy } from "./privacy.ts";
import { SHERPA_COMMAND, type TallyText, type WithSettings, answerSherpa } from "./sherpa-command.ts";

/** Discord's ceiling on a command option's choices. */
const MAX_CHOICES = 25;

export const commandDefinitions = (vocabulary: Vocabulary): RESTPutAPIApplicationGuildCommandsJSONBody => {
  if (vocabulary.topics.length > MAX_CHOICES)
    throw new Error(
      `The vocabulary has ${vocabulary.topics.length} Topics; a choice list holds ${MAX_CHOICES}. ` +
        "The /lately filter needs autocomplete before this vocabulary can ship.",
    );
  return [
    {
      name: "find",
      type: ApplicationCommandType.ChatInput,
      description: "Tell Sherpa what you're into and get places in the server to go.",
      options: [
        {
          name: "interests",
          type: ApplicationCommandOptionType.String,
          description: "Games, hobbies, work, where you're based — whatever you're into.",
          required: true,
          max_length: MAX_QUERY_LENGTH,
        },
      ],
    },
    {
      name: "lately",
      type: ApplicationCommandType.ChatInput,
      description: "See what's been active in the server lately.",
      options: [
        {
          name: "topic",
          type: ApplicationCommandOptionType.String,
          description: "Only show places about this.",
          required: false,
          choices: vocabulary.topics.map((t) => ({ name: t.label, value: t.slug })),
        },
      ],
    },
    PRIVACY_COMMAND,
    MONITORED_COMMAND,
    SHERPA_COMMAND,
    ALERTS_COMMAND,
  ];
};

/** The only shape anything here sends to Discord. */
export interface EphemeralReply {
  content: string;
  /** Only the privacy policy, which is longer than a message can be. */
  embeds?: APIEmbed[];
  flags: MessageFlags.Ephemeral;
  /** A template never pings, whatever a summary or a name happens to contain. */
  allowed_mentions: { parse: [] };
}

export const reply = (content: string, embeds?: APIEmbed[]): EphemeralReply => ({
  content,
  ...(embeds ? { embeds } : {}),
  flags: MessageFlags.Ephemeral,
  allowed_mentions: { parse: [] },
});

/** The interaction's calls back to Discord. A fake in tests. */
export interface ReplyPort {
  defer: (body: { flags: MessageFlags.Ephemeral }) => Promise<unknown>;
  followUp: (body: EphemeralReply) => Promise<unknown>;
  /** Rewrites the deferred reply: progress on a long command, then its answer in the same place. */
  edit?: (body: Omit<EphemeralReply, "flags">) => Promise<unknown>;
}

/**
 * Whether the invoker holds the `Member` role, resolved as the sync resolves
 * it: by name, every role carrying it. An empty manifest — no sync yet —
 * admits nobody. Fail closed: the commands describe the server to whoever
 * asks, and that is a Member's view.
 */
export const isMember = (
  interaction: APIChatInputApplicationCommandInteraction,
  guildId: string,
  manifest: RoleManifestEntry[],
): boolean => holdsRoleNamed(interaction, guildId, manifest, [MEMBER_ROLE_NAME]);

/**
 * The `Member` role's ids: a Member's view of the server, for matching that
 * has no asker's roles to go on (`candidatesOf`, `findPlaces`).
 */
export const memberRoleIds = (manifest: RoleManifestEntry[]): string[] =>
  manifest.filter((r) => r.name === MEMBER_ROLE_NAME).flatMap((r) => r.ids);

/** The glossary's Staff (F5). */
export const STAFF_ROLE_NAMES = ["Staff", "Event Managers"];

/**
 * Whether the invoker is Staff: holds a role named `Staff` or `Event
 * Managers`, resolved exactly as `isMember` resolves `Member`, and failing
 * closed the same way. Member is not required as well.
 */
export const isStaff = (
  interaction: APIChatInputApplicationCommandInteraction,
  guildId: string,
  manifest: RoleManifestEntry[],
): boolean => holdsRoleNamed(interaction, guildId, manifest, STAFF_ROLE_NAMES);

/**
 * Who may run the moderation tools (ADR-0003 O7): holders of the role named
 * `Staff` alone, a narrower group than the glossary's Staff.
 */
export const STAFF_ROLE_ONLY = ["Staff"];

/**
 * Who may opt in to alerts (#50): an `Ambassador`, or Staff. Resolved and
 * failing closed as `isStaff`. Spelled here, not imported: alerts.ts imports
 * this module, and a value read at load time across that cycle crashes startup.
 */
export const HOLDER_ROLE_NAMES = ["Ambassador", ...STAFF_ROLE_NAMES];

const holdsRoleNamed = (
  interaction: APIChatInputApplicationCommandInteraction,
  guildId: string,
  manifest: RoleManifestEntry[],
  names: string[],
): boolean => {
  if (interaction.guild_id !== guildId || !interaction.member) return false;
  const held = new Set(manifest.filter((r) => names.includes(r.name)).flatMap((r) => r.ids));
  return interaction.member.roles.some((id) => held.has(id));
};

export const DEFAULT_FIND_DAILY_CAP = 50;

/**
 * The cap's limit from the environment. Anything but a non-negative integer
 * stops the bot at startup: a typo read as "no cap" is a bill, and one read as
 * zero is a feature that quietly stopped working.
 */
export const findDailyCap = (
  raw: string | undefined,
  name = "SHERPA_FIND_DAILY_CAP",
  fallback = DEFAULT_FIND_DAILY_CAP,
): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const limit = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(limit))
    throw new Error(`${name} must be a non-negative integer. Got: ${raw}`);
  return limit;
};

/**
 * A global daily ceiling on `/find` model calls, persisted so a restart does
 * not hand out a fresh day. The day is UTC.
 *
 * Counted per attempt, not per command: a retry is a second paid call. A
 * store that cannot be read is treated as a spent day and overwritten as one,
 * so a corrupted file costs one day of `/find`, never an unbounded one.
 */
export const dailyCap = (
  path: string,
  limit: number,
  warn: (m: string) => void,
  now: () => Date = () => new Date(),
) => ({
  limit,
  take: (): boolean => {
    const day = now().toISOString().slice(0, 10);
    let used: number;
    try {
      const stored = JSON.parse(readFileSync(path, "utf8")) as { day?: unknown; count?: unknown };
      // A negative or non-integer count would never reach the limit.
      if (!Number.isSafeInteger(stored.count) || (stored.count as number) < 0 || typeof stored.day !== "string")
        throw new Error("shape");
      used = stored.day === day ? (stored.count as number) : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") used = 0;
      else {
        warn(`[sherpa] ${path} is unreadable; treating today's allowance as spent.`);
        used = limit;
      }
    }
    const allowed = used < limit;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ day, count: allowed ? used + 1 : used })}\n`);
    return allowed;
  },
});

export type DailyCap = ReturnType<typeof dailyCap>;

export const NOT_A_MEMBER =
  "Sherpa is for Members of the server. Once you have the Member role, try again.";
export const NOT_STAFF = "This command is for Staff: holders of the Staff or Event Managers role.";
export const NOT_A_HOLDER = "This command is for Ambassadors and Staff.";
export const NOT_STAFF_ROLE = "This command is for holders of the Staff role.";
export const CAP_REACHED =
  "Sherpa has answered all the `/find` questions it can for today. Try again tomorrow, " +
  "or use `/lately` to see what's active.";
export const FIND_OFF = "`/find` is switched off for now. Use `/lately` to see what's active.";
/** Owner's decision (2026-10-16): back on, and a backfill, for `/find` to work. */
export const FIND_OPTED_OUT =
  "You're opted out of Sherpa reading what you write, which `/find` needs. To use it, turn reading " +
  "back on with `/privacy opt-in processing`, then run `/privacy backfill`. `/lately` works either way.";
export const FAILED = "Something went wrong on Sherpa's side. Try again in a minute.";
export const UNKNOWN = "Sherpa doesn't know that command.";

class CapReached extends Error {}

export interface Sherpa {
  guildId: string;
  /**
   * Read per command, never cached: the sync and enrichment rewrite these
   * files while the bot runs, and a stale Catalog would point at places that
   * have since been withheld.
   */
  loadCatalog: () => Entity[];
  loadRoleManifest: () => RoleManifestEntry[];
  loadVocabulary: () => Vocabulary;
  /** Activity summaries, for `/lately`. Bot-side only (activity.ts). */
  loadActivity: () => ActivityStore;
  privacy: Privacy;
  /** Staff's monitored-channel list, for `/monitored`. */
  monitored: Monitored;
  /** The introductions responder's settings, for `/sherpa`. */
  settings: WithSettings;
  /** `/sherpa analyse` (#51). Without it, the subcommand says it is unavailable. */
  analyse?: (
    subject: { id: string; bot?: boolean },
    since: string | null,
    progress: (text: string) => Promise<unknown>,
    tag: string,
  ) => Promise<Answer>;
  /** Each holder's alert subscriptions, for `/alerts`. */
  alerts: <T>(work: (store: AlertsStore) => T) => T;
  /** The shadow tally for `/sherpa introductions status`. Without it, status says the tally is unavailable. */
  tally?: TallyText;
  /**
   * The monitored ids, checked against this Catalog (`readMonitored`). Throws
   * when one is missing, so `/find` and `/lately` fail closed before any call.
   */
  loadMonitored: (catalog: Entity[]) => ReadonlySet<string>;
  /** The invoker's denied places (`readDeniedPlaces`), read per command like the Catalog. */
  loadDenied: (memberId: string) => ReadonlySet<string>;
  /** A boundary built against this Catalog, so its carve-out checks see what the candidates came from. */
  askFor: (catalog: Entity[]) => Boundary["ask"];
  /** One retry, as every other paid call gets. */
  retrying: <T>(work: () => Promise<T>) => Promise<T>;
  cap: DailyCap;
  /** Ids and counts only. Never a query, a name or a summary. */
  log: (message: string) => void;
  now?: () => Date;
}

const stringOption = (interaction: APIChatInputApplicationCommandInteraction, name: string) => {
  const option = interaction.data.options?.find((o) => o.name === name);
  return option?.type === ApplicationCommandOptionType.String ? option.value : null;
};

const answer = async (
  interaction: APIChatInputApplicationCommandInteraction,
  sherpa: Sherpa,
  progress: (text: string) => Promise<unknown>,
): Promise<Answer> => {
  const tag = `[sherpa] /${interaction.data.name} ${interaction.id}`;
  // Ahead of the Member gate: anyone in the guild may opt out or delete.
  if (interaction.data.name === "privacy") {
    // The Member check only decides whether an opt-out keeps names, so a
    // manifest that cannot be read (no sync yet) means "no", never a failed opt-out.
    const member = () => {
      try {
        return isMember(interaction, sherpa.guildId, sherpa.loadRoleManifest());
      } catch {
        return false;
      }
    };
    const answered = answerPrivacy(interaction, sherpa.privacy, sherpa.log, tag, member);
    if (answered !== null) return answered;
    sherpa.log(`${tag} unknown subcommand`);
    return UNKNOWN;
  }
  // Also ahead of the Member gate: Staff need not hold Member as well (F5).
  if (interaction.data.name === "monitored" || interaction.data.name === "sherpa") {
    if (!isStaff(interaction, sherpa.guildId, sherpa.loadRoleManifest())) {
      sherpa.log(`${tag} refused: not Staff`);
      return NOT_STAFF;
    }
    const sub = interaction.data.options?.[0];
    if (interaction.data.name === "sherpa" && sub?.type === ApplicationCommandOptionType.Subcommand && sub.name === "analyse") {
      if (!holdsRoleNamed(interaction, sherpa.guildId, sherpa.loadRoleManifest(), STAFF_ROLE_ONLY)) {
        sherpa.log(`${tag} analyse refused: not the Staff role`);
        return NOT_STAFF_ROLE;
      }
      const id = sub.options?.find((o) => o.name === "member")?.value;
      const since = sub.options?.find((o) => o.name === "since")?.value;
      if (typeof id !== "string") return UNKNOWN;
      if (!sherpa.analyse) return "Reviews are unavailable right now.";
      sherpa.log(`${tag} analyse subject ${id} by ${interaction.member!.user.id}`);
      return sherpa.analyse(
        { id, bot: interaction.data.resolved?.users?.[id]?.bot },
        typeof since === "string" ? since : null,
        progress,
        tag,
      );
    }
    const answered =
      interaction.data.name === "monitored"
        ? answerMonitored(interaction, sherpa.monitored, sherpa.loadCatalog(), sherpa.log, tag)
        : await answerSherpa(interaction, sherpa.settings, sherpa.log, tag, sherpa.tally);
    if (answered !== null) return answered;
    sherpa.log(`${tag} unknown subcommand`);
    return UNKNOWN;
  }
  if (interaction.data.name === "alerts") {
    if (!holdsRoleNamed(interaction, sherpa.guildId, sherpa.loadRoleManifest(), HOLDER_ROLE_NAMES)) {
      sherpa.log(`${tag} refused: not an Ambassador or Staff`);
      return NOT_A_HOLDER;
    }
    const answered = answerAlerts(interaction, sherpa.alerts, sherpa.log, tag);
    if (answered !== null) return answered;
    sherpa.log(`${tag} unknown subcommand`);
    return UNKNOWN;
  }
  if (!isMember(interaction, sherpa.guildId, sherpa.loadRoleManifest())) {
    sherpa.log(`${tag} refused: not a Member`);
    return NOT_A_MEMBER;
  }
  // Before anything is read: off means off, even with a broken Catalog.
  if (interaction.data.name === "find" && sherpa.cap.limit === 0) {
    sherpa.log(`${tag} refused: /find is off`);
    return FIND_OFF;
  }
  // Also before the Catalog, and after "off": telling someone to opt back in
  // for a command that is off for everyone would send them round in a circle.
  if (interaction.data.name === "find" && !sherpa.privacy.settings(interaction.member!.user.id).processing) {
    sherpa.log(`${tag} refused: processing is off`);
    return FIND_OPTED_OUT;
  }
  const catalog = sherpa.loadCatalog();

  const vocabulary = sherpa.loadVocabulary();
  const monitored = sherpa.loadMonitored(catalog);
  const roles = interaction.member!.roles;
  const denied = sherpa.loadDenied(interaction.member!.user.id);

  if (interaction.data.name === "find") {
    const query = stringOption(interaction, "interests") ?? "";
    if (!query.trim()) {
      sherpa.log(`${tag} empty query`);
      return EMPTY_QUERY;
    }
    const ask = sherpa.askFor(catalog);
    try {
      const found = await sherpa.retrying(() => {
        if (!sherpa.cap.take()) throw new CapReached();
        return findPlaces({
          query,
          invokerId: interaction.member!.user.id,
          catalog,
          monitored,
          roles,
          denied,
          vocabulary,
          ask,
          origin: { command: "find" },
        });
      });
      sherpa.log(
        `${tag} candidates=${found.candidates} matches=${found.matches.length} ` +
          `topics=${found.topics.length} dropped=${found.dropped}`,
      );
      return renderFind(found);
    } catch (error) {
      if (error instanceof CapReached) {
        sherpa.log(`${tag} refused: daily cap reached`);
        return CAP_REACHED;
      }
      throw error;
    }
  }

  if (interaction.data.name === "lately") {
    const slug = stringOption(interaction, "topic");
    const topic = vocabulary.topics.find((t) => t.slug === slug) ?? null;
    const places = latelyPlaces(catalog, monitored, roles, denied, topic, sherpa.now?.());
    const activity = sherpa.loadActivity();
    sherpa.log(
      `${tag} topic=${topic?.slug ?? "-"} places=${places.length} ` +
        `activity=${places.filter((p) => activity[p.id]?.summary).length}`,
    );
    return renderLately(places, topic, activity);
  }

  sherpa.log(`${tag} unknown command`);
  return UNKNOWN;
};

/**
 * One interaction, start to finish: defer (Discord allows three seconds, and a
 * `/find` takes longer), answer, follow up. Anything that is not a slash
 * command is ignored — Sherpa registers nothing else.
 */
export const handleInteraction = async (
  interaction: APIInteraction,
  sherpa: Sherpa,
  discord: ReplyPort,
): Promise<void> => {
  if (
    interaction.type !== InteractionType.ApplicationCommand ||
    interaction.data.type !== ApplicationCommandType.ChatInput
  )
    return;
  const command = interaction as APIChatInputApplicationCommandInteraction;
  await discord.defer({ flags: MessageFlags.Ephemeral });
  let answered: Answer;
  /** Once the deferred reply shows progress, a follow-up would be a second message beside it. */
  let progressed = false;
  try {
    answered = await answer(command, sherpa, async (text) => {
      if (!discord.edit) return;
      progressed = true;
      // Progress is a courtesy: a failed edit never fails the command.
      await discord.edit({ content: text, allowed_mentions: { parse: [] } }).catch(() => {});
    });
  } catch (error) {
    sherpa.log(
      `[sherpa] /${command.data.name} ${command.id} failed: ${(error as Error).message.slice(0, 160)}`,
    );
    answered = FAILED;
  }
  const body = typeof answered === "string" ? reply(answered) : reply(answered.content, answered.embeds);
  if (progressed && discord.edit) {
    const { flags: _, ...edit } = body;
    await discord.edit(edit);
  } else await discord.followUp(body);
};
