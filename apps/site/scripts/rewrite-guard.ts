/**
 * Why `import-wiki.ts --rewrite` must leave a page alone, or null when no one
 * has changed it since the import. An untouched import has exactly one
 * revision, the starting one its publish keeps; an editor's save adds another,
 * and an unpublish leaves it a draft. Without revisions an edit would leave
 * the count at one, so a collection without them is refused.
 * ponytail: count-based, so a page whose history was purged, or pruned past
 * 90 days, after an edit reads as untouched. Fine for rewriting days after the
 * import; compare against the import's own revision if it is ever used later.
 */
export function editedSinceImport(entry: { revisions: number; status: string; supportsRevisions: boolean }): string | null {
  if (!entry.supportsRevisions) return "the collection keeps no revisions, so edits cannot be told apart";
  if (entry.status !== "published") return `it is ${entry.status}, not published`;
  if (entry.revisions !== 1) return `it has ${entry.revisions} revisions: edited since the import`;
  return null;
}
