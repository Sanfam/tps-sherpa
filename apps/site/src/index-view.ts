/**
 * The Index as one User sees it: the accepted Catalog snapshot cut down to the
 * Entities they can see in Discord, and what each says. `index.astro` renders
 * this and nothing else from the snapshot, search data included, so neither
 * can carry an Entity the User may not see.
 */
import type { CatalogEntity } from "./catalog-snapshot.ts";

/**
 * Whether a holder of `roles` can see this Entity in Discord, as Discord
 * decides it from role overwrites: @everyone's, then every held role's denies,
 * then every held role's allows, so one role's allow beats another's deny.
 * Hence: a held role allows it, or a held role shows it and none denies it.
 * No access recorded means nobody.
 *
 * The bot's `visibleTo` (apps/bot/src/sync/catalog.ts), copied: the site's
 * image carries none of the bot's source. test/index-view.test.ts holds the
 * two to the same answers.
 */
export const visibleTo = (
  entity: Pick<CatalogEntity, "allow_roles" | "view_roles" | "deny_roles">,
  roles: readonly string[],
): boolean => {
  const { allow_roles: allow, view_roles: view, deny_roles: deny } = entity;
  if (!Array.isArray(allow) || !Array.isArray(view) || !Array.isArray(deny)) return false;
  return (
    roles.some((r) => allow.includes(r)) ||
    (roles.some((r) => view.includes(r)) && !roles.some((r) => deny.includes(r)))
  );
};

/** A scheme, `www.`, an invite, or a domain with a path: anything Discord could turn into a link. */
const URLISH = /[a-z][a-z0-9+.-]*:\/\/|www\.|discord\.gg|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*\/\S/i;

/**
 * Whether model text holds a link or Discord markup, which ADR-0004's bounds
 * keep from being shown wherever it is rendered. Tested with backslashes
 * dropped, since a renderer that strips them can turn `https:\//` into a
 * working link. The bot's `linkOrMarkup` (apps/bot/src/llm/boundary.ts),
 * copied like `visibleTo`.
 */
export const linkOrMarkup = (text: string): boolean => {
  const plain = text.replace(/\\/g, "");
  return URLISH.test(plain) || /[<>@]|\|\||\]\(/.test(plain);
};

export interface IndexEntry {
  id: string;
  type: CatalogEntity["type"];
  name: string;
  /** Its Discord link; null when the Catalog's is not one. */
  href: string | null;
  /** Staff's override, else the generated summary within bounds, else the topic. */
  text: string | null;
  /** Topic labels; slugs the vocabulary does not know are skipped. */
  topics: string[];
  tags: string[];
  regions: string[];
  state: CatalogEntity["thread_state"];
  lastActivity: string | null;
  /** Members' messages in about the last week; 0 when the bot does not read it. */
  weekly: number;
}

/** A Channel or Forum, with the Threads or Posts in it the User can see. */
export interface IndexSection extends IndexEntry {
  entries: IndexEntry[];
}

/** An entry's search fields, embedded in the page for MiniSearch. */
export interface SearchDoc {
  id: string;
  name: string;
  /** Its Channel or Forum's name; empty for a Channel or Forum. */
  parent: string;
  text: string;
  topics: string[];
  tags: string[];
  regions: string[];
}

const textOf = (e: CatalogEntity): string | null =>
  e.summary_override ??
  (e.summary_generated && !linkOrMarkup(e.summary_generated) ? e.summary_generated : null) ??
  e.topic;

export const indexView = (
  catalog: readonly CatalogEntity[],
  roles: readonly string[],
  vocabulary: readonly { slug: string; label: string }[],
  weeklyMessages: Readonly<Record<string, number>> = {},
): { sections: IndexSection[]; docs: SearchDoc[] } => {
  const labels = new Map(vocabulary.map((t) => [t.slug, t.label]));
  const entry = (e: CatalogEntity): IndexEntry => ({
    id: e.id,
    type: e.type,
    name: e.name,
    href: e.url.startsWith("https://discord.com/channels/") ? e.url : null,
    text: textOf(e),
    topics: e.topics.flatMap((slug) => labels.get(slug) ?? []),
    tags: e.applied_tags,
    regions: e.region,
    state: e.thread_state,
    lastActivity: e.last_activity_at,
    weekly: Object.hasOwn(weeklyMessages, e.id) ? weeklyMessages[e.id]! : 0,
  });

  const seen = catalog.filter((e) => visibleTo(e, roles));
  const sections = new Map<string, IndexSection>();
  for (const e of seen) if (e.parent_id === null) sections.set(e.id, { ...entry(e), entries: [] });
  // A Post or Thread whose Channel or Forum the User cannot see is not shown.
  for (const e of seen) if (e.parent_id !== null) sections.get(e.parent_id)?.entries.push(entry(e));

  // Most active first: messages this week, then the latest message, then name.
  // A Channel or Forum counts its own and those of the Posts and Threads shown under it.
  const byActivity = (a: { weekly: number; lastActivity: string | null; name: string }, b: typeof a) =>
    b.weekly - a.weekly || (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") || a.name.localeCompare(b.name);
  for (const s of sections.values()) {
    s.entries.sort(byActivity);
    for (const e of s.entries) {
      s.weekly += e.weekly;
      if ((e.lastActivity ?? "") > (s.lastActivity ?? "")) s.lastActivity = e.lastActivity;
    }
  }
  const sorted = [...sections.values()].sort(byActivity);
  const doc = (e: IndexEntry, parent: string): SearchDoc => ({
    id: e.id,
    name: e.name,
    parent,
    text: e.text ?? "",
    topics: e.topics,
    tags: e.tags,
    regions: e.regions,
  });
  const docs = sorted.flatMap((s) => [doc(s, ""), ...s.entries.map((e) => doc(e, s.name))]);
  return { sections: sorted, docs };
};
