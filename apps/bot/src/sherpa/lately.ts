/**
 * `/lately`: what has been active in the last fortnight. No model call — it is
 * the Catalog's `last_activity_at`, sorted and rendered from a template.
 *
 * Each place is one line, its anchor and how long ago it was active, with its
 * activity summary beneath as subtext, or its identity summary when it has
 * none (#54). Only for places listed here, which are `/find`'s candidates in the current Catalog, so an
 * entry left over for an Entity since withheld or gone is never shown. The
 * reply is ephemeral and goes only to Members; activity text never goes to a
 * log (activity.ts).
 */
import type { ActivityStore } from "../llm/activity.ts";
import type { Topic } from "../llm/vocabulary.ts";
import type { Entity } from "../sync/catalog.ts";
import { ACTIVE_WITHIN_DAYS, activityBucket } from "../sync/facets.ts";
import {
  MAX_MESSAGE_CHARS,
  MAX_SUMMARY_CHARS,
  candidatesOf,
  clip,
  placeRef,
  summaryOf,
} from "./find.ts";

export { MAX_MESSAGE_CHARS };

/** A screenful. More than this is a list to scroll, not a nudge. */
export const MAX_LATELY = 8;

/**
 * The same candidates `/find` may name, for the same asker, so the two
 * commands cannot disagree about what is somewhere to go. Forums are left out: a Forum's activity is
 * its Posts, which are listed in their own right.
 */
export const latelyPlaces = (
  catalog: Entity[],
  monitored: ReadonlySet<string>,
  roles: readonly string[],
  denied: ReadonlySet<string>,
  topic: Topic | null,
  now: Date = new Date(),
): Entity[] =>
  candidatesOf(catalog, monitored, roles, denied)
    .filter(
      (e) =>
        e.type !== "forum" &&
        activityBucket(e.last_activity_at, now) === "active" &&
        (!topic || e.topics.includes(topic.slug)),
    )
    .sort((a, b) => b.last_activity_at!.localeCompare(a.last_activity_at!))
    .slice(0, MAX_LATELY);

/** Topics whose activity lines can spoil a plot or a result: click to reveal. */
const SPOILER_TOPICS = ["movies-and-tv", "anime-and-manga", "books-and-reading"];

/**
 * Everything here was active in the last fortnight, so a client has it loaded
 * and a native mention shows its real name. A Post archived inside the window
 * would show as "#unknown", so anything not open is named as `/find` names it.
 */
const anchorOf = (entity: Entity): string =>
  entity.thread_state === null || entity.thread_state === "open" ? `<#${entity.id}>` : placeRef(entity);

const lineFor = (entity: Entity, activity: ActivityStore): string => {
  // Discord renders the time in the reader's own terms ("3 days ago").
  const line = `${anchorOf(entity)} · <t:${Math.floor(new Date(entity.last_activity_at!).getTime() / 1000)}:R>`;
  const lately = activity[entity.id]?.summary;
  // Whitespace collapsed so a summary cannot leave the subtext for a line of
  // its own. Pipes and backslashes dropped so the text can neither close the
  // spoiler tag nor escape its closing pipes; clipped short of the tag's four
  // characters so the wrapped text is no longer than an unwrapped one.
  const text = (lately ?? summaryOf(entity))?.replace(/\s+/g, " ").trim();
  if (!text) return line;
  const shown =
    lately && entity.topics.some((t) => SPOILER_TOPICS.includes(t))
      ? `||${clip(text.replace(/[|\\]/g, ""), MAX_SUMMARY_CHARS - 4)}||`
      : clip(text);
  return `${line}\n-# ${shown}`;
};

/**
 * Places that would push the reply past Discord's limit are left off the end,
 * rather than the reply failing. Eight open places with full summaries fit;
 * eight archived Posts with long, heavily escaped names do not.
 */
export const renderLately = (
  places: Entity[],
  topic: Topic | null,
  activity: ActivityStore = {},
): string => {
  if (places.length === 0)
    return topic
      ? `Nothing tagged ${topic.label} has been active in the last ${ACTIVE_WITHIN_DAYS} days. ` +
          "Try `/lately` without a topic, or `/find` to look by interest."
      : `Nothing has been active in the last ${ACTIVE_WITHIN_DAYS} days.`;
  let reply = topic ? `**Active lately in ${topic.label}**\n` : "**Active lately**\n";
  for (const place of places) {
    const next = `${reply}\n${lineFor(place, activity)}`;
    if (next.length > MAX_MESSAGE_CHARS) break;
    reply = next;
  }
  return reply;
};
