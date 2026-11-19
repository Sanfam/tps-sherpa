/**
 * Why `import-wiki.ts --rewrite` must leave a page alone, or null when no one
 * has changed it since the import. An untouched import has exactly one
 * revision, the starting one its publish keeps; an editor's save adds another,
 * and an unpublish leaves it a draft. Without revisions an edit would leave
 * the count at one, so a collection without them is refused.
 * ponytail: count-based, so a page whose history was purged, or pruned past
 * 90 days, after an edit reads as untouched. Fine for rewriting days after the
 * import; compare against the import's own revision if it is ever used later.
 *
 * Staging (`--stage`) may also fill an unpublished stub: the draft page the
 * import makes for a link to a page the wiki never had, still without a
 * revision and still its one "to be written" block. A stub an editor has since changed is
 * edited, like any other page.
 */
const STUB_TEXT = "This page is still to be written.";
const isStub = (content: unknown) => {
  const [block, ...rest] = Array.isArray(content) ? content : [];
  const spans = block?.children ?? [];
  return rest.length === 0 && block?._type === "block" && spans.length === 1 && spans[0].text === STUB_TEXT;
};

export function editedSinceImport(entry: {
  revisions: number;
  status: string;
  supportsRevisions: boolean;
  stage?: boolean;
  content?: unknown;
}): string | null {
  if (!entry.supportsRevisions) return "the collection keeps no revisions, so edits cannot be told apart";
  // A stub is created and never published, which keeps no revision; any save adds one.
  if (entry.stage && entry.status !== "published" && entry.revisions === 0 && isStub(entry.content)) return null;
  if (entry.status !== "published") return `it is ${entry.status}, not published`;
  if (entry.revisions !== 1) return `it has ${entry.revisions} revisions: edited since the import`;
  return null;
}
