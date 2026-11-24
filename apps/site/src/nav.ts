// The members' navigation, derived from the published `pages` entries so it
// needs no upkeep. The slugs keep the wiki's paths: `parenting/home` is the
// Parenting section's page, and `parenting/child/school-lunch` sits under
// `parenting/child/home`. A page's place is its slug less a trailing `/home`
// (the root `home` is ""); its parent is the nearest published place above it.
import { getEmDashCollection } from "emdash";
import { getRequestContext, runWithContext } from "emdash/request-context";

export type Pages = Map<string, { href: string; title: string }>;

export const placeOf = (slug: string) => (slug === "home" ? "" : slug.replace(/\/home$/, ""));

/** Every published page by its place. */
export async function publishedPages(): Promise<Pages> {
  // Published only, even in edit mode, where EmDash would title a published
  // page with its pending draft and list draft-only pages: menus show what
  // Members see.
  const { entries, error } = await runWithContext({ ...getRequestContext(), editMode: false, preview: undefined }, () =>
    getEmDashCollection("pages"),
  );
  if (error) throw error;
  const pages: Pages = new Map();
  for (const e of entries) {
    const place = placeOf(e.id);
    // `x` and `x/home` both published: the section page `x/home` holds the place.
    if (!pages.has(place) || e.id.endsWith("/home")) pages.set(place, { href: `/${e.id}`, title: String(e.data["title"] || e.id) });
  }
  return pages;
}

export function parentOf(pages: Pages, place: string): string | undefined {
  while (place) {
    place = place.slice(0, Math.max(place.lastIndexOf("/"), 0));
    if (pages.has(place)) return place;
  }
  return undefined;
}

const byTitle = (pages: Pages) => (a: string, b: string) => pages.get(a)!.title.localeCompare(pages.get(b)!.title);

/** The root `home` and each published `<section>/home`. */
export const sections = (pages: Pages) => [
  ...(pages.has("") ? [""] : []),
  ...[...pages.keys()].filter((p) => p && !p.includes("/") && pages.get(p)!.href === `/${p}/home`).sort(byTitle(pages)),
];

/** A page's published ancestors, root first. */
export function trail(pages: Pages, place: string) {
  const up: string[] = [];
  for (let p = parentOf(pages, place); p !== undefined; p = parentOf(pages, p)) up.unshift(p);
  return up;
}

// ponytail: walks every page's ancestors per call; fine for the wiki's few dozen pages.
export const childrenOf = (pages: Pages, place: string) =>
  [...pages.keys()].filter((p) => p !== place && parentOf(pages, p) === place).sort(byTitle(pages));
