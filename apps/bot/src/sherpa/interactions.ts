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
  type APIInteraction,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionType,
  MessageFlags,
  type RESTPutAPIApplicationGuildCommandsJSONBody,
} from "discord-api-types/v10";
import type { Boundary } from "../llm/boundary.ts";
import type { Vocabulary } from "../llm/vocabulary.ts";
import type { Entity } from "../sync/catalog.ts";
import { MEMBER_ROLE_NAME } from "../sync/discord-adapter.ts";
import type { RoleManifestEntry } from "../sync/ports.ts";
import { EMPTY_QUERY, MAX_QUERY_LENGTH, findPlaces, renderFind } from "./find.ts";
import { latelyPlaces, renderLately } from "./lately.ts";

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
  ];
};

/** The only shape anything here sends to Discord. */
export interface EphemeralReply {
  content: string;
  flags: MessageFlags.Ephemeral;
  /** A template never pings, whatever a summary or a name happens to contain. */
  allowed_mentions: { parse: [] };
}

export const reply = (content: string): EphemeralReply => ({
  content,
  flags: MessageFlags.Ephemeral,
  allowed_mentions: { parse: [] },
});

/** The interaction's two calls back to Discord. A fake in tests. */
export interface ReplyPort {
  defer: (body: { flags: MessageFlags.Ephemeral }) => Promise<unknown>;
  followUp: (body: EphemeralReply) => Promise<unknown>;
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
): boolean => {
  if (interaction.guild_id !== guildId || !interaction.member) return false;
  const memberRoles = new Set(
    manifest.filter((r) => r.name === MEMBER_ROLE_NAME).flatMap((r) => r.ids),
  );
  return interaction.member.roles.some((id) => memberRoles.has(id));
};

export const DEFAULT_FIND_DAILY_CAP = 50;

/**
 * The cap's limit from the environment. Anything but a non-negative integer
 * stops the bot at startup: a typo read as "no cap" is a bill, and one read as
 * zero is a feature that quietly stopped working.
 */
export const findDailyCap = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return DEFAULT_FIND_DAILY_CAP;
  const limit = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(limit))
    throw new Error(`SHERPA_FIND_DAILY_CAP must be a non-negative integer. Got: ${raw}`);
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
        warn(`[sherpa] ${path} is unreadable; treating today's /find allowance as spent.`);
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
export const CAP_REACHED =
  "Sherpa has answered all the `/find` questions it can for today. Try again tomorrow, " +
  "or use `/lately` to see what's active.";
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
): Promise<string> => {
  const tag = `[sherpa] /${interaction.data.name} ${interaction.id}`;
  if (!isMember(interaction, sherpa.guildId, sherpa.loadRoleManifest())) {
    sherpa.log(`${tag} refused: not a Member`);
    return NOT_A_MEMBER;
  }
  const catalog = sherpa.loadCatalog();
  const vocabulary = sherpa.loadVocabulary();

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
          vocabulary,
          ask,
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
    const places = latelyPlaces(catalog, topic, sherpa.now?.());
    sherpa.log(`${tag} topic=${topic?.slug ?? "-"} places=${places.length}`);
    return renderLately(places, topic);
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
  let content: string;
  try {
    content = await answer(command, sherpa);
  } catch (error) {
    sherpa.log(
      `[sherpa] /${command.data.name} ${command.id} failed: ${(error as Error).message.slice(0, 160)}`,
    );
    content = FAILED;
  }
  await discord.followUp(reply(content));
};
