/**
 * `/lately`: what has been active in the last fortnight. No model call — it is
 * the Catalog's `last_activity_at`, sorted and rendered from a template.
 *
 * Each place is described by its identity summary, never its activity summary.
 * Activity summaries are derived from member conversation and are bot-side
 * only (Staff, 2026-10-05; activity.ts): nothing may become a second way out
 * for them, and the boundary does not yet catch a member's name said in
 * conversation. Showing them here is a decision for Staff, not a default.
 */
import type { Topic } from "../llm/vocabulary.ts";
import type { Entity } from "../sync/catalog.ts";
import { ACTIVE_WITHIN_DAYS, activityBucket } from "../sync/facets.ts";
import { candidatesOf, placeLine } from "./find.ts";

/** A screenful. More than this is a list to scroll, not a nudge. */
export const MAX_LATELY = 8;

/**
 * The same candidates `/find` may name, so the two commands cannot disagree
 * about what is somewhere to go. Forums are left out: a Forum's activity is
 * its Posts, which are listed in their own right.
 */
export const latelyPlaces = (
  catalog: Entity[],
  topic: Topic | null,
  now: Date = new Date(),
): Entity[] =>
  candidatesOf(catalog)
    .filter(
      (e) =>
        e.type !== "forum" &&
        activityBucket(e.last_activity_at, now) === "active" &&
        (!topic || e.topics.includes(topic.slug)),
    )
    .sort((a, b) => b.last_activity_at!.localeCompare(a.last_activity_at!))
    .slice(0, MAX_LATELY);

const lineFor = (entity: Entity): string =>
  placeLine(
    entity,
    undefined,
    // Discord renders this in the reader's own terms ("3 days ago").
    ` <t:${Math.floor(new Date(entity.last_activity_at!).getTime() / 1000)}:R>`,
  );

export const renderLately = (places: Entity[], topic: Topic | null): string =>
  places.length === 0
    ? topic
      ? `Nothing tagged ${topic.label} has been active in the last ${ACTIVE_WITHIN_DAYS} days. ` +
        "Try `/lately` without a topic, or `/find` to look by interest."
      : `Nothing has been active in the last ${ACTIVE_WITHIN_DAYS} days.`
    : [topic ? `Active lately in ${topic.label}:` : "Active lately:", ...places.map(lineFor)].join("\n");
