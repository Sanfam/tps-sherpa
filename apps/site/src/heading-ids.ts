// Anchors for rendered headings, so the `#fragment` links the wiki import kept
// (scripts/import-wiki.ts) land on the heading they name. The rule is Wiki.js's:
// lowercase, spaces to hyphens, punctuation and emoji dropped, and a repeated
// heading gets `-1`, `-2`, … in page order.

type Block = { _type?: string; style?: string; children?: { text?: string }[]; anchor?: string };

/** Wiki.js's heading slug: letters, numbers, `_` and `-` kept, the rest dropped. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-");
}

/** The blocks with each heading's `anchor` set, unique within the page. */
export function withHeadingAnchors<T>(content: T): T {
  if (!Array.isArray(content)) return content;
  const used = new Set<string>();
  return content.map((block: Block) => {
    if (block._type !== "block" || !/^h[1-6]$/.test(block.style ?? "")) return block;
    const base = slugify((block.children ?? []).map((c) => c.text ?? "").join(""));
    if (!base) return block;
    let anchor = base;
    for (let n = 1; used.has(anchor); n++) anchor = `${base}-${n}`;
    used.add(anchor);
    return { ...block, anchor };
  }) as T;
}
