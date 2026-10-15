/**
 * Activity summaries: "what's happening here lately", from recent messages.
 *
 * The other half of the two-cadence design. Identity says what a place *is*
 * and almost never changes; activity says what it is doing now and goes stale
 * by the week. They are kept apart so a Thread that has drifted gets its
 * activity line updated without its identity being rewritten.
 *
 * **Bot-side only (Staff, 2026-10-05).** These are derived from member
 * conversation, and the repository is public, so they are written to the
 * bot's volume and never into the Catalog or its snapshot. Only a Staff-approved
 * monthly overview may ever be built from them for the public tier, and only
 * through that approval; nothing here may become a second way out. They are
 * kept out of logs for the same reason — a log line is a copy. A member name
 * said in conversation ("thanks Dave") is also not caught by anything yet —
 * the boundary has no member-name cache — which is the other reason this
 * stays off the page until a gated delivery path exists.
 */
import type { Entity } from "../sync/catalog.ts";
import type { StoredMessage } from "../sync/tier0-store.ts";
import { wordCount } from "./summarise.ts";

/** One line, a little longer than identity: activity needs a verb and an object. */
export const MAX_ACTIVITY_WORDS = 20;

/** Matches the capture's tail window, so "recent" means what capture fetched. */
export const RECENT_MESSAGES = 100;

export const ACTIVITY_SYSTEM_PROMPT = [
  "You write one-line summaries of what a Discord conversation has been about lately.",
  "",
  `Write at most ${MAX_ACTIVITY_WORDS - 2} words on what the recent messages below are discussing.`,
  "",
  "Rules:",
  "- Describe the subjects, never the people. No names, nicknames, @-handles or counts of people.",
  "- Do not name the channel or thread itself; describe what is being said.",
  "- If the messages are only greetings, reactions or noise, reply with null rather than inventing a subject.",
  "",
  'Reply with JSON: {"summary": string | null}',
].join("\n");

/** What the job has produced, keyed by Entity id. Lives on the bot's volume. */
/**
 * Entries are not removed when an Entity later becomes withheld, monitored or
 * deleted: that would be a purge of member-derived data, which is a Staff
 * decision. Anything that reads this must re-check eligibility against the
 * current Catalog.
 */
export type ActivityStore = Record<
  string,
  {
    /** Null when the recent messages had nothing to summarise. */
    summary: string | null;
    /**
     * The `last_message_id` this was generated from — a message cursor, not a
     * time. The job regenerates only when the Entity's cursor moves past it.
     */
    as_of: string;
  }
>;

/**
 * Whether an Entity needs a (new) activity summary.
 *
 * Due only when its newest message has moved since the last summary **and**
 * Tier 0's newest stored message is exactly that one — the snapshot and the
 * Catalog agree. Not the capture's recorded cursor, which is stamped from the
 * Catalog whatever Discord returned, and not mere membership: a message that
 * arrived between sync and capture would be summarised under the older
 * cursor, and a Catalog that moved backwards would summarise messages since
 * deleted. Any disagreement leaves the Entity alone until they agree.
 */
export const isActivityDue = (
  entity: Entity,
  newestStoredId: string | undefined,
  store: ActivityStore,
): boolean =>
  entity.last_message_id !== null &&
  newestStoredId === entity.last_message_id &&
  store[entity.id]?.as_of !== entity.last_message_id;

/** The newest message by snowflake, compared as a number. */
export const newestId = (messages: StoredMessage[]): string | undefined =>
  messages.reduce<string | undefined>(
    (newest, m) => (newest === undefined || BigInt(m.messageId) > BigInt(newest) ? m.messageId : newest),
    undefined,
  );

/**
 * What a message says, for deduplication and for deciding whether it says
 * anything: Discord markup (mentions, emoji, timestamps) and links removed,
 * then everything but letters and digits — spacing included, so "co-op
 * tonight" and "co op tonight" are one message. A message that is only a
 * mention or an emoji comes out empty and is dropped, rather than reaching the
 * model as "@member" and inviting it to invent a subject.
 */
const normalised = (text: string): string =>
  text
    .replace(/<[^>\s]*>/g, " ")
    // Links in any case, with or without a scheme: `HTTPS://…`, `www.…`,
    // `mailto:…`, `discord.gg/raid`, `example.com`. A message that is only a
    // link says nothing.
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b(?:mailto|tel):)\S+/gi, " ")
    // Bare domains, with or without a path or query. This only decides what
    // counts as saying something — the text sent is unchanged — so catching
    // the odd "great.thanks" costs nothing worse than one fewer message.
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:[/?#]\S*)?/gi, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The recent, human, distinct messages for one Entity, oldest first.
 *
 * Newest by snowflake rather than by the stored `window` label: capture lets
 * the head window overwrite the tail on overlap, so a short Thread can have
 * every recent message labelled `head`. Bots and webhooks go before
 * deduplication, so a bot's repeated notice cannot crowd out a member's
 * message. Near-identical means identical once markup, case, punctuation and
 * spacing are ignored — "lol", "LOL!" and "l o l" are one message.
 */
export const recentSources = (
  messages: StoredMessage[],
  limit = RECENT_MESSAGES,
): StoredMessage[] => {
  const newest = [...messages]
    .sort((a, b) => (BigInt(b.messageId) > BigInt(a.messageId) ? 1 : -1))
    .slice(0, limit);
  const seen = new Set<string>();
  return newest
    .filter((m) => !m.authorIsBot)
    .filter((m) => {
      const key = normalised(m.content);
      if (!/\p{L}/u.test(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .reverse();
};

/**
 * The Entities due for a summary, each with the sources it will be summarised
 * from — both taken from **one** read of Tier 0. Reading once for the due
 * check and again for the sources would let a capture committed in between be
 * summarised under the older cursor.
 */
export const planActivity = (
  entities: Entity[],
  snapshotOf: (entityId: string) => StoredMessage[],
  store: ActivityStore,
): Array<{ entity: Entity; sources: StoredMessage[] }> =>
  entities.flatMap((entity) => {
    const snapshot = snapshotOf(entity.id);
    return isActivityDue(entity, newestId(snapshot), store)
      ? [{ entity, sources: recentSources(snapshot) }]
      : [];
  });

export type ActivityRejection =
  | { reason: "too-long"; words: number }
  | { reason: "names-a-member" };

/**
 * Checked on the way back, after the boundary's own validation.
 *
 * `@member` is what the boundary turns a mention into; a summary that repeats
 * it is describing a person, which the prompt forbids and this enforces.
 */
export const checkActivity = (summary: string): ActivityRejection | null => {
  const words = wordCount(summary);
  if (words > MAX_ACTIVITY_WORDS) return { reason: "too-long", words };
  if (/@member/i.test(summary)) return { reason: "names-a-member" };
  return null;
};
