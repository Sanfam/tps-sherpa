/**
 * The mechanical facets — Platform, Activity, Format and Region.
 *
 * None of them needs a model. Platform is mod-authored Forum tags, Format is
 * the Entity type, Activity falls out of a snowflake, and Region is a lookup
 * table. Leaving these to an LLM would be paying a model to guess at data we
 * already hold, and a guess that contradicts a mod is a bug.
 *
 * Two of the four are stored in the Catalog and two are derived on read:
 *
 *   stored  — Platform (`applied_tags`) and Region. Stable: they change when a
 *             mod changes them, so a sync writing them produces a real diff.
 *   derived — Format (`type`, already there) and Activity. Writing an activity
 *             bucket into the Catalog would bake in the clock, so every entity
 *             crossing a threshold would show up as a content change that
 *             nothing actually caused. `activityBucket` is the single
 *             definition, called by whoever renders.
 */

/** A Region gazetteer: canonical name → the phrases that mean it. */
export type Gazetteer = Map<string, string[]>;

export type ActivityBucket = "active" | "recent" | "quiet" | "dormant";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Thresholds are named because they are judgement calls, not measurements —
 * "active" here means "posted in within a fortnight", and someone will want to
 * argue with that. Make them argue with a constant.
 */
export const ACTIVE_WITHIN_DAYS = 14;
export const RECENT_WITHIN_DAYS = 90;
export const QUIET_WITHIN_DAYS = 365;

/**
 * Null means nothing was ever posted — which is not the same as dormant, and
 * must stay distinguishable so an empty Channel is not described as one that
 * went quiet.
 */
export const activityBucket = (
  lastActivityAt: string | null,
  now: Date = new Date(),
): ActivityBucket | null => {
  if (!lastActivityAt) return null;
  const age = now.getTime() - new Date(lastActivityAt).getTime();
  if (Number.isNaN(age)) return null;
  if (age <= ACTIVE_WITHIN_DAYS * DAY) return "active";
  if (age <= RECENT_WITHIN_DAYS * DAY) return "recent";
  if (age <= QUIET_WITHIN_DAYS * DAY) return "quiet";
  return "dormant";
};

/** Punctuation, emoji and Discord's separator glyphs all become spaces. */
const words = (text: string): string =>
  ` ${text.toLowerCase().replace(/[^a-z0-9]+/gi, " ").trim()} `;

export const parseGazetteer = (source: string | null): Gazetteer => {
  if (!source) return new Map();
  const parsed = JSON.parse(source) as { regions?: Record<string, string[]> };
  return new Map(Object.entries(parsed.regions ?? {}));
};

/**
 * Every Region an Entity's name names. Multi-valued on purpose: "Northern
 * Alabama/Southern Middle Tennessee" is two regions and picking one would be
 * the silent resolution this facet exists to avoid.
 *
 * Longest phrase wins its span. Without that, "West Virginia" matches Virginia
 * too, and a member in Charleston gets sent to the wrong state.
 */
export const matchRegions = (name: string, gazetteer: Gazetteer): string[] => {
  const candidates = [...gazetteer]
    .flatMap(([region, aliases]) => aliases.map((alias) => ({ region, alias: words(alias).trim() })))
    .sort((a, b) => b.alias.length - a.alias.length);

  let haystack = words(name);
  const matched = new Set<string>();
  for (const { region, alias } of candidates) {
    const at = haystack.indexOf(` ${alias} `);
    if (at === -1) continue;
    matched.add(region);
    // Consume the span so a shorter alias cannot match inside it.
    haystack = `${haystack.slice(0, at + 1)}${" ".repeat(alias.length)}${haystack.slice(at + 1 + alias.length)}`;
  }
  return [...matched].sort();
};
