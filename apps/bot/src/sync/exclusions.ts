/**
 * The Staff-editable list of Entities that are visible and readable but are
 * not places to send anyone: verification plumbing, `do-not-post-here`,
 * `bot-tests`. Permissions cannot express "not a destination", so a list has to.
 */

export interface ExclusionEntry {
  id: string;
  /** For the human reading the file. Matching is on ID — names are mutable. */
  name?: string;
  reason?: string;
}

/**
 * Fails loudly on a malformed file. A corrupt exclusion list silently becoming
 * "exclude nothing" would publish exactly what someone meant to hide, so this
 * fails closed by refusing to produce a Catalog at all.
 */
export const parseExclusions = (raw: string | null | undefined): Set<string> => {
  if (raw === null || raw === undefined) return new Set();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "The exclusion config is not valid JSON. Refusing to build a Catalog: " +
        "treating it as empty would publish whatever it was meant to exclude.",
    );
  }

  const list = (parsed as { exclude?: unknown })?.exclude;
  if (!Array.isArray(list))
    throw new Error(
      'The exclusion config has no "exclude" array. Refusing to build a Catalog.',
    );

  const ids = new Set<string>();
  for (const entry of list) {
    const id = (entry as ExclusionEntry)?.id;
    if (typeof id !== "string" || id.length === 0)
      throw new Error(
        `An exclusion entry has no id: ${JSON.stringify(entry)}. Entries are ` +
          "matched on ID because names are mutable. Refusing to build a Catalog.",
      );
    ids.add(id);
  }
  return ids;
};
