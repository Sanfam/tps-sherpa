/**
 * Why `import-wiki.ts --rewrite` must leave a page alone, or null when no one
 * has changed it since the import. An untouched import has exactly one
 * revision, the starting one its publish keeps; an editor's save adds another,
 * and an unpublish leaves it a draft. Without revisions an edit would leave
 * the count at one, so a collection without them is refused.
 */
export function editedSinceImport(entry: { revisions: number; status: string; supportsRevisions: boolean }): string | null {
  if (!entry.supportsRevisions) return "the collection keeps no revisions, so edits cannot be told apart";
  if (entry.status !== "published") return `it is ${entry.status}, not published`;
  if (entry.revisions !== 1) return `it has ${entry.revisions} revisions: edited since the import`;
  return null;
}
