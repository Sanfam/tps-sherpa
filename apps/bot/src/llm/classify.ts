/**
 * Steady state: every Entity gets Topic tags from the frozen vocabulary.
 *
 * Narrow job, cheap model. The vocabulary is an input here and never an
 * output — nothing in this file can add a tag, rename one, or decide that a
 * tag it wanted is missing. A classifier that can extend its own label set is
 * a classifier whose labels mean something different every month.
 */
import type { Entity } from "../sync/catalog.ts";
import {
  MANDATORY_TOPICS,
  consensusKey,
  slugify,
  type Topic,
  type Vocabulary,
} from "./vocabulary.ts";

/**
 * Whether an Entity is due for classification.
 *
 * Version-based, not content-based: the sync already drops `topics` when an
 * Entity's identity changes (see `identityKey`), so "no version" covers both
 * the never-classified and the changed. A version bump makes every Entity
 * stale at once, which is exactly what "a bump retags the whole corpus" means
 * — and it retags from the committed Catalog, with no Discord call.
 */
export const needsClassifying = (entity: Entity, vocabulary: Vocabulary): boolean =>
  entity.topics_version !== vocabulary.version;

export const classifySystemPrompt = (vocabulary: Vocabulary): string =>
  [
    "You are tagging one entry in a Discord community's catalog.",
    "",
    "Choose the tags from this fixed vocabulary that describe what the entry is about.",
    "Choose 1 to 3. Choose none only if no tag genuinely applies — a wrong tag is worse than none.",
    "",
    ...vocabulary.topics.map((t) => `${t.slug}: ${t.description}`),
    "",
    "You may only use slugs from that list. There is no tag for anything else.",
    'Reply with JSON: {"topics": [slug, ...]}',
  ].join("\n");

/**
 * Keeps the slugs that exist and drops the ones that do not.
 *
 * An unknown tag is skipped and logged, never created. This is a standing
 * anti-goal, and it is enforced here rather than in the prompt because a
 * prompt is a request: the model will eventually answer `cozy-games` however
 * firmly it was told not to, and the only question is whether that invents a
 * nineteenth tag in the Index or produces a line in a log.
 */
export const parseTags = (
  value: unknown,
  vocabulary: Vocabulary,
  warn?: (message: string) => void,
): string[] => {
  const raw = (value as { topics?: unknown }).topics;
  if (!Array.isArray(raw))
    throw new Error(`No topics array in ${JSON.stringify(value).slice(0, 200)}`);
  const known = new Set(vocabulary.topics.map((t) => t.slug));
  const kept = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const slug = slugify(entry);
    if (!known.has(slug)) {
      warn?.(
        `[topics] model proposed "${slug}", which is not in vocabulary v` +
          `${vocabulary.version}. Skipped — tags are never created.`,
      );
      continue;
    }
    kept.add(slug);
  }
  return [...kept].sort();
};

/**
 * Topics a mod's own Forum tags already assert.
 *
 * A Forum tag asserts a Topic only when it names the whole Topic — `Music`
 * claims `music`, `Board Games` claims `board-game`. It used to match any word
 * of the slug, which held while slugs were single words and broke on v1's
 * compounds: the lifestyle Forum's `home` tag claimed `home-and-diy` for a
 * movie night, and `sports` put a politics Post under `sports-and-outdoors`,
 * overriding the model both times (#22). Where the two facets do not overlap,
 * that is not a failure: Platform is a separate axis and stays in
 * `applied_tags`. Nothing here invents a correspondence.
 */
export const nativeTopics = (entity: Entity, topics: Topic[]): string[] => {
  const claimed = new Set(
    entity.applied_tags.map((tag) => consensusKey(slugify(tag))).filter(Boolean),
  );
  return topics.filter((t) => claimed.has(consensusKey(t.slug))).map((t) => t.slug);
};

/**
 * The model's tags, with mod intent overriding them.
 *
 * Native `applied_tags` are ground truth. Where the model omitted a Topic the
 * mod's own tag asserts, the mod wins and the disagreement is logged for
 * someone to look at — never resolved by overwriting what the mod chose.
 */
export const reconcile = (
  entity: Entity,
  modelTags: string[],
  vocabulary: Vocabulary,
  warn?: (message: string) => void,
): string[] => {
  const native = nativeTopics(entity, vocabulary.topics);
  for (const slug of native)
    if (!modelTags.includes(slug))
      warn?.(
        `[topics] "${entity.name}" (${entity.id}) carries the mod tag set ` +
          `[${entity.applied_tags.join(", ")}], which asserts "${slug}", but the ` +
          `model did not. Keeping the mod's tag.`,
      );
  const tags = new Set([...modelTags, ...native]);
  // A coarse core tag follows from the specific tags it covers. Only when the
  // vocabulary actually carries it: an older version without it must not
  // acquire a slug it never had.
  const known = new Set(vocabulary.topics.map((t) => t.slug));
  for (const m of MANDATORY_TOPICS)
    if (known.has(m.slug) && m.covers?.some((slug) => tags.has(slug))) tags.add(m.slug);
  return [...tags].sort();
};
