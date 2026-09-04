/**
 * How an Entity is described *to* a model, for every job that needs one.
 *
 * One builder, because classification and summarisation must see the same
 * thing. If they drift, a Post is tagged from its first message and summarised
 * from its name, and the two disagree for no reason a reader can see.
 *
 * The input comes from the committed Catalog, never from a live API call. The
 * Catalog already holds the topic, the first post, the mod tags and the
 * parent, all normalised and mention-resolved by the sync — so a retag is a
 * local reprocess, which is the property Tier 0 exists to guarantee. Message
 * sampling is not used here and is a standing anti-goal.
 */
import type { Entity } from "../sync/catalog.ts";

export const parentOf = (entity: Entity, byId: Map<string, Entity>): Entity | null =>
  entity.parent_id ? (byId.get(entity.parent_id) ?? null) : null;

/**
 * Whether there is anything to describe this Entity *with*.
 *
 * A Post inside `🎲︱board-games` called `Wingspan` has plenty: name plus
 * parent is a legitimate source. A top-level Channel with no topic set has
 * nothing but its own name, and inferring what `🖥︱pc-gaming` is about is an
 * elaborate way of avoiding asking a mod to type one sentence. Those get an
 * explicit marker; they never get an invented summary.
 */
export const hasDescribableInput = (entity: Entity, byId: Map<string, Entity>): boolean => {
  if (entity.description_status === "withheld") return false;
  return Boolean(entity.topic) || parentOf(entity, byId) !== null;
};

/** The Entity as prompt text. Redaction happens after this, at the boundary. */
export const subjectText = (entity: Entity, byId: Map<string, Entity>): string => {
  const parent = parentOf(entity, byId);
  return [
    `Name: ${entity.name}`,
    `Kind: ${entity.type}`,
    parent ? `Inside: ${parent.name}` : null,
    entity.applied_tags.length ? `Mod tags: ${entity.applied_tags.join(", ")}` : null,
    entity.region.length ? `Region: ${entity.region.join(", ")}` : null,
    entity.topic ? `Description: ${entity.topic}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
};
