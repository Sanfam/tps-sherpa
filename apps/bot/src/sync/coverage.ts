/**
 * Compares the Catalog against the page this project replaces.
 *
 * Coverage is Phase 1's mechanical gate, and the delta in the other direction
 * — Entities the old script missed — is the headline result: the value the
 * replacement adds on day one.
 */
import type { Entity } from "./catalog.ts";

export interface BaselineEntry {
  id: string;
  name: string;
  hasDescription: boolean;
}

export type AbsenceReason =
  /** On the Staff exclusion list. Expected. */
  | "excluded"
  /** The bot cannot see it. Expected while permissions say so. */
  | "not-visible"
  /** No explanation. These are the ones worth a human's attention. */
  | "unexplained";

export interface CoverageReport {
  baselineCount: number;
  catalogCount: number;
  covered: string[];
  /** In the Catalog, absent from the old page. The value this adds. */
  added: string[];
  missing: Array<{ id: string; name: string; reason: AbsenceReason }>;
}

/**
 * The old page lists entries as `- [name](url) description`, where the URL is
 * a Discord deep link. Entity IDs come from the links, never the names — the
 * names on that page are already two years stale.
 */
export const parseOldIndex = (markdown: string): BaselineEntry[] => {
  const entries = new Map<string, BaselineEntry>();
  // Two traps, both found against the real page:
  //   `\s*` matches newlines, so a bare entry swallowed its own line break and
  //   captured the NEXT entry as its description.
  //   `[^\]]+` for the link text stops at the `]` of an escaped `\]`, which
  //   dropped 7 entries with names like `Gris \[Video Game Boom Club\]`.
  const line =
    /^[^\S\n]*-[^\S\n]+\[((?:\\.|[^\]\\])+)\]\(https:\/\/discord\.com\/channels\/\d+\/(\d+)\)[^\S\n]*(.*)$/gm;
  for (const m of markdown.matchAll(line)) {
    const [, name, id, rest] = m;
    if (!id || !name) continue;
    // The old page's own duplicates collapse: same id listed twice is one
    // Entity, and it is the id that identifies it.
    if (!entries.has(id))
      entries.set(id, {
        id,
        // Markdown escaping is the page's, not the Entity's name.
        name: name.replace(/\\(.)/g, "$1"),
        hasDescription: (rest ?? "").trim().length > 0,
      });
  }
  return [...entries.values()];
};

export const compareCoverage = (
  baseline: BaselineEntry[],
  catalog: Entity[],
  context: { excluded: Set<string>; invisible: Set<string> },
): CoverageReport => {
  const inCatalog = new Map(catalog.map((e) => [e.id, e]));
  const inBaseline = new Set(baseline.map((b) => b.id));

  const covered: string[] = [];
  const missing: CoverageReport["missing"] = [];

  for (const entry of baseline) {
    if (inCatalog.has(entry.id)) {
      covered.push(entry.id);
      continue;
    }
    const reason: AbsenceReason = context.excluded.has(entry.id)
      ? "excluded"
      : context.invisible.has(entry.id)
        ? "not-visible"
        : "unexplained";
    missing.push({ id: entry.id, name: entry.name, reason });
  }

  return {
    baselineCount: baseline.length,
    catalogCount: catalog.length,
    covered,
    added: catalog.filter((e) => !inBaseline.has(e.id)).map((e) => e.id),
    missing,
  };
};
