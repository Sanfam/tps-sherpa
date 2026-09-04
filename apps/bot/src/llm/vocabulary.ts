/**
 * The Topic vocabulary: derived once, reviewed by a human, then frozen.
 *
 * Everything in here is the mechanical half of the bootstrap — stratification,
 * skew measurement, consensus, and the guard that stops a critique pass
 * inventing a tag. The model half is `bootstrap-vocabulary.ts`.
 *
 * The reason this is a one-time job rather than a step in the sync: steady
 * state classifies **against** the frozen vocabulary and never re-derives.
 * A vocabulary that re-derives on the fly drifts under the Index silently,
 * and nobody notices until a tag people were filtering on stops existing.
 */
import type { Entity } from "../sync/catalog.ts";

export interface Topic {
  /** The stable key. Kebab-case, and what the Catalog stores. */
  slug: string;
  /** What a person sees. Mutable; the slug is not. */
  label: string;
  /** What belongs under it. Fed to the classifier, so it earns its keep. */
  description: string;
}

export interface Vocabulary {
  /**
   * Bumped by a human, deliberately. A bump means "retag everything", so it
   * is not a field any script increments on its own.
   */
  version: number;
  frozen_at: string;
  topics: Topic[];
  /**
   * `proposed` until a human has reviewed it. The bootstrap only ever writes
   * a proposal, and nothing classifies against anything but `frozen` —
   * freezing is a person changing this word and committing the file, which is
   * what makes the review checkpoint a gate rather than a suggestion.
   *
   * Required, and checked positively. Rejecting only the literal string
   * `proposed` would mean a missing status, a typo, or any format this file
   * has not seen yet reads as reviewed — a gate that opens for everything it
   * does not recognise is not a gate.
   */
  status: "proposed" | "frozen";
}

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * The key consensus matches on.
 *
 * Plural drift — `board-game` in one run, `board-games` in the next — is the
 * likeliest way four independent runs disagree about a tag they all proposed.
 * Matching on a de-pluralised key means that disagreement does not silently
 * cost a good tag. `ss` is left alone so `fitness` survives.
 */
export const consensusKey = (slug: string): string =>
  slug.replace(/(?<![s])s$/, "").replace(/^-|-$/g, "");

export const parseVocabulary = (source: string | null): Vocabulary => {
  if (!source)
    throw new Error(
      "No frozen Topic vocabulary. Classification runs against a committed, " +
        "versioned vocabulary and must never derive one on the fly — run the " +
        "bootstrap, have a human review it, and commit the result.",
    );
  const parsed = JSON.parse(source) as Partial<Vocabulary>;
  if (parsed.status !== "frozen")
    throw new Error(
      `This Topic vocabulary is marked ${JSON.stringify(parsed.status ?? null)}, ` +
        `not "frozen". Freezing is the human review checkpoint — a person reads ` +
        `the tags, sets the status and the date, and commits. Nothing ` +
        `classifies against a vocabulary that has not been through it.`,
    );
  // A freeze is an event, so it has a date. Without one there is no way to
  // tell a reviewed vocabulary from a file someone typed the word into.
  if (!parsed.frozen_at || Number.isNaN(Date.parse(parsed.frozen_at)))
    throw new Error(
      `Topic vocabulary is marked frozen but its frozen_at is ` +
        `${JSON.stringify(parsed.frozen_at ?? null)}, which is not a date.`,
    );
  if (typeof parsed.version !== "number" || !Number.isInteger(parsed.version))
    throw new Error("Topic vocabulary has no integer version. A retag depends on it.");
  if (!Array.isArray(parsed.topics) || parsed.topics.length === 0)
    throw new Error("Topic vocabulary has no topics.");
  const slugs = new Set<string>();
  for (const t of parsed.topics) {
    if (!t?.slug || slugify(t.slug) !== t.slug)
      throw new Error(`Topic slug is not kebab-case: ${JSON.stringify(t?.slug)}`);
    if (slugs.has(t.slug)) throw new Error(`Duplicate Topic slug: ${t.slug}`);
    slugs.add(t.slug);
    if (!t.label || !t.description)
      throw new Error(`Topic "${t.slug}" is missing a label or description.`);
  }
  return {
    version: parsed.version,
    frozen_at: parsed.frozen_at,
    topics: parsed.topics,
    status: "frozen",
  };
};

/**
 * The stratum an Entity belongs to: its parent, or itself for a container.
 *
 * Containers are each their own stratum on purpose. There are 54 Channels and
 * 7 Forums, they are the guild's actual top-level subjects, and bucketing them
 * together would let six of them stand in for all sixty-one.
 */
export const stratumOf = (entity: Entity): string => entity.parent_id ?? entity.id;

export interface Skew {
  entities: number;
  strata: number;
  /** The stratum holding the largest share, and that share. */
  largest: { stratum: string; count: number; share: number };
}

const skewOf = (entities: Entity[]): Skew => {
  const counts = new Map<string, number>();
  for (const e of entities) counts.set(stratumOf(e), (counts.get(stratumOf(e)) ?? 0) + 1);
  const [stratum, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return {
    entities: entities.length,
    strata: counts.size,
    largest: { stratum, count, share: entities.length ? count / entities.length : 0 },
  };
};

/**
 * A stratified sample, capped per stratum.
 *
 * An unguided sweep of this corpus is 40% one gaming Forum, which yields
 * fifteen gaming tags and one called "hobbies" — and that skew freezes in
 * before a human ever sees it. Capping is the whole defence.
 *
 * Picks are spread evenly across each stratum by ID rather than taken from the
 * front, because IDs are chronological and the first six Posts in a five-year-
 * old Forum are all from its first week. Deterministic, so a re-run samples
 * the same Entities and a changed vocabulary means the corpus changed.
 */
export const stratify = (
  catalog: Entity[],
  options: { perStratum?: number; exclude?: (entity: Entity) => boolean } = {},
): { sample: Entity[]; corpus: Skew; sample_skew: Skew } => {
  const cap = options.perStratum ?? 5;
  const eligible = catalog
    .filter((e) => !options.exclude?.(e))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const strata = new Map<string, Entity[]>();
  for (const e of eligible) {
    const key = stratumOf(e);
    strata.set(key, [...(strata.get(key) ?? []), e]);
  }

  const sample = [...strata.values()].flatMap((members) => {
    const take = Math.min(cap, members.length);
    return Array.from({ length: take }, (_, i) => members[Math.floor((i * members.length) / take)]!);
  });

  return {
    sample: sample.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    corpus: skewOf(eligible),
    sample_skew: skewOf(sample),
  };
};

export interface Agreement {
  key: string;
  label: string;
  /** How many of the independent runs proposed it. */
  runs: number;
}

/**
 * Keeps only what every independent run chose.
 *
 * A tag one run in four picked is the tag most likely to be an artifact of
 * that run, and this vocabulary is about to be frozen. The discarded
 * near-misses are returned too — a good tag that three runs of four agreed on
 * is the most useful thing a human reviewer can be shown.
 *
 * **Run this over ballots, not over free-form derivations.** Measured
 * 2026-09-03: four independent derivations of the same corpus produced 55
 * distinct slugs of which 3 appeared in all four, and on another model 70 of
 * which 0 did. The concepts agreed — `tabletop-game`, `tabletop-gaming`,
 * `tabletop-and-board-game` — and the strings did not, so string consensus
 * over free-form naming measures naming variance and almost nothing else.
 * Pool the derivations first, then have independent runs vote on that one
 * list; then agreement means agreement.
 */
export const consensus = (
  runs: Topic[][],
): { topics: Topic[]; agreement: Agreement[]; pool: Topic[] } => {
  const seen = new Map<string, { runs: Set<number>; labels: string[]; topic: Topic }>();
  for (const [index, run] of runs.entries())
    for (const raw of run) {
      const topic: Topic = { ...raw, slug: slugify(raw.slug || raw.label) };
      const key = consensusKey(topic.slug);
      const existing = seen.get(key);
      if (existing) {
        existing.runs.add(index);
        existing.labels.push(topic.label);
      } else seen.set(key, { runs: new Set([index]), labels: [topic.label], topic });
    }

  const agreement = [...seen]
    .map(([key, v]) => ({ key, label: v.topic.label, runs: v.runs.size }))
    .sort((a, b) => b.runs - a.runs || (a.key < b.key ? -1 : 1));

  const topics = [...seen.values()]
    .filter((v) => v.runs.size === runs.length)
    .map((v) => v.topic)
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));

  return {
    topics,
    agreement,
    // Every distinct candidate, deduplicated on the same key. This is the
    // ballot the voting rounds choose from.
    pool: [...seen.values()].map((v) => v.topic).sort((a, b) => (a.slug < b.slug ? -1 : 1)),
  };
};

/**
 * Folds naming variants of one concept together, before anything votes.
 *
 * Without this the ballot splits: `books-and-comic` takes one vote,
 * `books-and-reading` another, `retro-gaming` and `retro-and-classic-gaming`
 * one each, and unanimous consensus then drops books and retro gaming from a
 * corpus that plainly contains both. Measured 2026-09-03: nine tags survived,
 * all of them parenting or gaming, with no books, film, music or region.
 *
 * A candidate no group mentions survives on its own. Losing a tag by omission
 * would make this pass a silent filter, and it is only meant to be a merge.
 */
export const mergeGroups = (
  pool: Topic[],
  groups: Array<{ canonical: string; members?: string[] }>,
  warn?: (message: string) => void,
): Topic[] => {
  const byKey = new Map(pool.map((t) => [consensusKey(t.slug), t]));
  const merged: Topic[] = [];
  const consumed = new Set<string>();

  for (const group of groups) {
    const canonical = byKey.get(consensusKey(slugify(group.canonical ?? "")));
    if (!canonical) {
      warn?.(
        `[vocabulary] merge named "${group.canonical}" as canonical, which is ` +
          `not one of the ${pool.length} candidates. Group ignored.`,
      );
      continue;
    }
    const key = consensusKey(canonical.slug);
    if (consumed.has(key)) continue;
    merged.push(canonical);
    consumed.add(key);
    for (const member of group.members ?? []) {
      const found = byKey.get(consensusKey(slugify(member)));
      // A member already used as another group's canonical stays where it is:
      // merging it away here would delete a tag the ballot needs to see.
      if (found && !consumed.has(consensusKey(found.slug))) consumed.add(consensusKey(found.slug));
    }
  }

  for (const t of pool) if (!consumed.has(consensusKey(t.slug))) merged.push(t);
  return merged.sort((a, b) => (a.slug < b.slug ? -1 : 1));
};

/**
 * Narrows a model's answer to tags that were actually on offer.
 *
 * Used twice: a voting round may only choose from the pooled candidates, and
 * the critique pass may only edit what survived consensus. Neither may add a
 * tag, or "consensus across independent runs" becomes a step the last model
 * call can quietly overrule.
 */
export const restrictTo = (
  candidates: Topic[],
  critique: Topic[],
  warn?: (message: string) => void,
): Topic[] => {
  const allowed = new Map(candidates.map((t) => [consensusKey(t.slug), t]));
  const kept: Topic[] = [];
  for (const t of critique) {
    const slug = slugify(t.slug || t.label);
    const source = allowed.get(consensusKey(slug));
    if (!source) {
      warn?.(
        `[vocabulary] a model answered "${slug}", which was not among the ` +
          `${candidates.length} tags it was given. Dropped — these steps ` +
          `choose from a list, they do not extend it.`,
      );
      continue;
    }
    if (kept.some((k) => consensusKey(k.slug) === consensusKey(slug))) continue;
    // The candidate's own slug, not the one the model typed back. A slug is
    // the stable key the Catalog stores; a label is the mutable display name.
    // A round that answers `board-game` for `board-games` has chosen that
    // candidate, not renamed it.
    kept.push({
      slug: source.slug,
      label: t.label || source.label,
      description: t.description || source.description,
    });
  }
  return kept.sort((a, b) => (a.slug < b.slug ? -1 : 1));
};
