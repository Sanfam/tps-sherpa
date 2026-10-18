/**
 * The introductions responder's decisions and fixed texts, with no I/O: when
 * the one autonomous post is due, whether a message is an introduction at all,
 * which matches another member already named, and what Sherpa says. The clock
 * is an argument and nothing here reads Discord or the database
 * (docs/proposals/introductions-responder.md §3, §4, §8, §9).
 *
 * Every word Sherpa posts is a template in this file or a Catalog field
 * rendered by `placeLine`. No model text reaches Discord: not an interest, not
 * a meme's `known_as`, not a summary of what a member said.
 */
import { type APIMessage, MessageType } from "discord-api-types/v10";
import { IMAGE_MEANINGS, type ImageMeaning } from "../llm/boundary.ts";
import type { Entity } from "../sync/catalog.ts";
import { placeLine } from "./find.ts";

// The `/find` opt-out text, reused: one wording for "processing is off".
export { FIND_OPTED_OUT as PROCESSING_OFF } from "./interactions.ts";

// --- decide (§3) ---------------------------------------------------------

export type ClockMode = "wall" | "active";

/** Staff's runtime settings (`/sherpa introductions clock|timing`). The 24-hour hard stop is fixed. */
export interface TimingSettings {
  clock: ClockMode;
  greetMinutes: number;
  recommendMinutes: number;
  ceilingActiveHours: number;
}

/** One of the member's own messages. Times are epoch milliseconds. */
export interface OwnMessage {
  at: number;
  /** An image-only message is a greeting, not signal (§4): the caller passes false. */
  signal: boolean;
}

export interface Timeline {
  intro: OwnMessage;
  /** The member's own later messages in the watch. */
  followUps: readonly OwnMessage[];
  /** Another member has asked them a question. */
  askedByHuman: boolean;
  /**
   * Minutes (epoch milliseconds divided by 60,000, rounded down) in which a
   * non-bot message from someone other than the member, and not from a member
   * with processing off, was posted (D10). The caller filters; duplicates are fine.
   */
  activeMinutes: readonly number[];
}

export type PostKind = "question" | "recommend" | "welcome_only";
export type Decision = { action: "wait" } | { action: "post"; kind: PostKind };

const MINUTE = 60_000;
const HARD_STOP_MS = 24 * 60 * MINUTE;
const WAIT: Decision = { action: "wait" };

/**
 * Whether the one autonomous post is due, and which. Called whenever anything
 * changes or the minute turns; it holds no state.
 *
 * - The ceiling (active hours since the intro, in either clock mode) and the
 *   hard stop end the watch, and the extraction with it, so they come first
 *   and the post is the welcome with no suggestions.
 * - A member's signal makes the recommend threshold run from their latest
 *   message carrying it. A human's question does not hold that back (Mark Weigl).
 * - With no signal at all, the greet threshold from the intro asks one
 *   question, unless another member already has (Zifei).
 *
 * "Minutes since" is wall minutes, or active minutes strictly after the
 * minute of the starting message: a message in the same minute may have
 * landed before the intro.
 */
export const decide = (timeline: Timeline, settings: TimingSettings, now: number): Decision => {
  const active = new Set(timeline.activeMinutes);
  const activeSince = (since: number): number => {
    let count = 0;
    for (const m of active) if (m > Math.floor(since / MINUTE) && m <= Math.floor(now / MINUTE)) count++;
    return count;
  };
  const minutesSince = (since: number): number =>
    settings.clock === "wall" ? (now - since) / MINUTE : activeSince(since);

  const { intro } = timeline;
  if (now - intro.at >= HARD_STOP_MS || activeSince(intro.at) >= settings.ceilingActiveHours * 60) {
    return { action: "post", kind: "welcome_only" };
  }

  const signalAt = [intro, ...timeline.followUps]
    .filter((m) => m.signal)
    .reduce<number | null>((latest, m) => (latest === null || m.at > latest ? m.at : latest), null);
  if (signalAt !== null) {
    return minutesSince(signalAt) >= settings.recommendMinutes ? { action: "post", kind: "recommend" } : WAIT;
  }
  if (!timeline.askedByHuman && minutesSince(intro.at) >= settings.greetMinutes) {
    return { action: "post", kind: "question" };
  }
  return WAIT;
};

// --- countsAsIntroduction (§3, F2) --------------------------------------

/** The gateway message, as much of it as the test reads. */
export type IntroCandidate = Pick<
  APIMessage,
  "type" | "content" | "author" | "mentions" | "message_reference" | "attachments" | "embeds"
>;

/** The types the vision call reads (§4). */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const hasImage = (message: IntroCandidate): boolean =>
  message.attachments.some((a) => IMAGE_TYPES.has(a.content_type ?? "")) ||
  message.embeds.some((e) => e.type === "gifv" || e.type === "image");

/**
 * Whether a message starts an evaluation: it is not a reply, mentions no other
 * member, and its author has never posted in `#introductions` (F2, so a veteran's
 * "Welcome!" under a newcomer's intro is not an introduction). The caller
 * answers "never posted" from tombstones.
 *
 * A message with no words and no image starts nothing, which is how a sticker
 * (a sticker is neither) is left out; an image alone does start one, and takes
 * the greeting path.
 */
export const countsAsIntroduction = (message: IntroCandidate, authorPostedBefore: boolean): boolean =>
  !authorPostedBefore &&
  !message.author.bot &&
  message.type === MessageType.Default &&
  !message.message_reference &&
  !message.mentions.some((u) => u.id !== message.author.id) &&
  (message.content.trim() !== "" || hasImage(message));

// --- novelty (§4) --------------------------------------------------------

/** `<#id>` mentions and Discord channel links, which name the channel or Thread by its id. */
const NAMED = /<#(\d+)>|discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)/g;

/**
 * `matchIds` without the places another member has already named, as a `<#id>`
 * mention or a `discord.com/channels/…` link (a link to a message in a place
 * names the place). The caller passes only the contents of messages from
 * members with processing on, and checks `isCandidate` on what is left.
 */
export const novelty = (matchIds: readonly string[], othersMessageContents: readonly string[]): string[] => {
  const named = new Set<string>();
  for (const content of othersMessageContents) {
    for (const found of content.matchAll(NAMED)) named.add(found[1] ?? found[2] ?? "");
  }
  return matchIds.filter((id) => !named.has(id));
};

// --- fixed texts (§9) ----------------------------------------------------
// Draft copy: Staff judge the wording in shadow.

const places = (entities: readonly Entity[]): string => entities.map((e) => placeLine(e, null)).join("\n");

/** The recommend post, and the invited path's answer: places that survived, never padded. */
export const recommendPost = (entities: readonly Entity[]): string =>
  [
    "Welcome to the Papa Squad! Going by what you said, these places might suit you:",
    places(entities),
    "Reply to me for more, or try `/find` any time.",
  ].join("\n");

export const WELCOME_ONLY =
  "Welcome to the Papa Squad! Glad you're here. Reply to me if you'd like help finding places " +
  "that fit you, or try `/find` any time.";

export const WELCOME_WITH_QUESTION =
  "Welcome to the Papa Squad! Glad you're here. What are you into? A game, a hobby, a sport, " +
  "your line of work, where you're based. Reply to me and I'll point you at places that fit.";

export const INVITED_QUESTION =
  "I'd like to point you somewhere good, but I need a little more. What's one thing you're into, " +
  "such as a game, a hobby, a sport or where you're based?";

/** After the third exchange: the widest doors, and the Index. `indexUrl` is the Index's address. */
export const widestDoors = (entities: readonly Entity[], indexUrl: string): string =>
  [
    "That's as far as I can take this conversation.",
    ...(entities.length ? ["These are good places to start:", places(entities)] : []),
    `The whole server is laid out in the Index: <${indexUrl}>. Or try \`/find\` any time.`,
  ].join("\n");

/** A mention after the cap: no model call, nothing recorded. */
export const afterCap = (indexUrl: string): string =>
  `I've come to the end of this conversation, but \`/find\` can still match what you're into, ` +
  `and the Index has everything: <${indexUrl}>.`;

// --- the shadow post (§8) ------------------------------------------------

/** The autonomous kinds, and the invited path's replies, which share the format (F4). */
export type ReplyKind =
  | PostKind
  | "invited_recommend"
  | "invited_question"
  | "widest_doors"
  | "after_cap"
  | "processing_off";

/** The vision reading's `meaning` enum (§4): the one image detail Staff see. */

export interface ShadowTimeline {
  clock: ClockMode;
  /** Minutes from the intro to the first acknowledgement by another member, if any. */
  acknowledgedAfterMinutes: number | null;
  activeMinutes: number;
  extractions: number;
  noveltyDropped: number;
  images: number;
  imageMeaning: ImageMeaning | null;
}

/**
 * The post for `#bot-tests`. It carries no intro text, no member name and no
 * extracted field (D23): its only inputs are counts, the kind, a jump link and
 * the reply the member would see. `imageMeaning` is checked against the enum
 * at run time, so a reading that is not one of the five labels, which is
 * model text, prints as "other" and nothing more.
 */
export const shadowPost = (post: {
  kind: ReplyKind;
  replyingTo: string;
  timeline: ShadowTimeline;
  reply: string;
}): string => {
  const t = post.timeline;
  const meaning = IMAGE_MEANINGS.find((m) => m === t.imageMeaning) ?? (t.imageMeaning ? "other" : null);
  const timeline = [
    `clock ${t.clock}`,
    `acknowledged ${t.acknowledgedAfterMinutes === null ? "none" : `+${t.acknowledgedAfterMinutes}m`}`,
    `active minutes ${t.activeMinutes}`,
    `extractions ${t.extractions}`,
    `novelty dropped ${t.noveltyDropped}`,
    `images ${t.images}`,
    ...(meaning ? [`image: ${meaning}`] : []),
  ].join(" · ");
  return [
    `Intro responder (shadow) · would POST ${post.kind} · replying to: ${post.replyingTo}`,
    `Timeline: ${timeline}`,
    "Would post:",
    ...post.reply.split("\n").map((line) => `> ${line}`.trimEnd()),
  ].join("\n");
};
