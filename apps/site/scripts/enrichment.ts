/**
 * The decisions enrich-works.ts makes, kept apart from its I/O: which Open
 * Library work a `works` entry is, what of its description to take, and which
 * of the entry's fields are still empty to fill.
 */

/** A hit from Open Library's search.json, with the fields the script asks for. */
export type Doc = {
  key: string;
  title: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  edition_count?: number;
};

export type Match =
  /** `high` is applied; `low` (a title that matches only in part, or an entry
   * with no creators to check) waits for an editor to check it and say `high`. */
  | { doc: Doc; confidence: "high" | "low" }
  | { reason: string };

/** Lowercase words without accents or punctuation; an apostrophe joins its word. */
const words = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/['’]/g, "").replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const ARTICLES = new Set(["the", "a", "an"]);
const titleWords = (s: string) => {
  const w = words(s);
  return w.length > 1 && ARTICLES.has(w[0]!) ? w.slice(1) : w;
};
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const startsWith = (a: string[], b: string[]) => b.length > 0 && b.length < a.length && b.every((x, i) => x === a[i]);

/**
 * How a hit's title compares with the entry's: `exact` when the words agree,
 * the hit's subtitle included if it has one (so "The Hobbit: Graphic Novel"
 * is not exact for "The Hobbit"), `partial` when one title is the
 * other with more words after it ("The Hobbit, or There and Back Again"), so
 * a sequel ("Dune Messiah") is never exact for "Dune".
 */
function titleMatch(ours: string, doc: Doc): "exact" | "partial" | null {
  const mine = titleWords(ours);
  const theirs = titleWords(doc.title);
  const full = doc.subtitle ? titleWords(`${doc.title} ${doc.subtitle}`) : theirs;
  if (same(mine, full)) return "exact";
  if (startsWith(mine, theirs) || startsWith(theirs, mine) || startsWith(full, mine)) return "partial";
  return null;
}

/**
 * Whether two spellings name one person: the surname agrees and so does the
 * first initial ("J.R.R. Tolkien", "J. R. R. Tolkien", "JRR Tolkien"). A
 * surname written as one word or two ("Le Guin", "LeGuin") agrees, and a name
 * given as a surname alone matches on that.
 */
function samePerson(a: string, b: string) {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return false;
  if (x.length === 1 || y.length === 1) return x.at(-1) === y.at(-1);
  const surname = x.at(-1) === y.at(-1) || (x.join("").endsWith(y.at(-1)!) && y.join("").endsWith(x.at(-1)!));
  return surname && x[0]![0] === y[0]![0];
}

/** The people an entry's creators field names: "A and B", "A & B", "A, B". */
export const people = (creators: string) => creators.split(/\s*(?:[,;&]|\band\b|\bwith\b)\s*/i).filter((p) => p.trim());

/**
 * The Open Library work a book entry is, from the hits for its title. A hit
 * must match the title and at least one of the entry's creators. Of those, an
 * exact title beats a partial one, then the most editions wins: Open Library
 * keeps adaptations and duplicate works under the same title and author, and
 * the book itself has by far the most editions. Anything else is no match,
 * with the reason, rather than a guess.
 */
export function pickMatch(title: string, creators: string | undefined, docs: Doc[]): Match {
  const titled = docs.flatMap((doc) => {
    const t = titleMatch(title, doc);
    return t ? [{ doc, t }] : [];
  });
  if (!titled.length) return { reason: "no Open Library work with this title" };
  const named = creators ? people(creators) : [];
  const fits = creators
    ? titled.filter(({ doc }) => named.some((p) => doc.author_name?.some((a) => samePerson(p, a))))
    : titled;
  if (!fits.length) {
    const others = [...new Set(titled.flatMap(({ doc }) => doc.author_name ?? []))].slice(0, 5);
    return { reason: `title found, but by ${others.join("; ") || "no named author"}` };
  }
  fits.sort((a, b) => (a.t === b.t ? (b.doc.edition_count ?? 0) - (a.doc.edition_count ?? 0) : a.t === "exact" ? -1 : 1));
  const best = fits[0]!;
  // A surname alone ("King") could be anyone with it: only a full name makes a match certain.
  const fullName = named.some((p) => words(p).length > 1 && best.doc.author_name?.some((a) => samePerson(p, a)));
  return { doc: best.doc, confidence: best.t === "exact" && fullName ? "high" : "low" };
}

const MAX_DESCRIPTION = 600;

/**
 * The first paragraph of an Open Library description, as plain text of at
 * most about 600 characters: Markdown links keep their text, a "([source][1])"
 * credit and a rule line go, and a long paragraph ends at its last sentence
 * that fits, or else at a word with an ellipsis.
 */
export function firstParagraph(description: string | { value?: string } | undefined) {
  const text = typeof description === "string" ? description : description?.value ?? "";
  const paragraph = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)
    .map((p) => p
      .replace(/\(\s*\[source\]\s*(?:\[[^\]]*\]|\([^)]*\))\s*\)/gi, "")
      .replace(/\[([^\]]*)\](?:\[[^\]]*\]|\([^)]*\))/g, "$1")
      .replace(/\s+/g, " ")
      .trim())
    .find((p) => p && !/^[-*_=\s]+$/.test(p));
  if (!paragraph || paragraph.length <= MAX_DESCRIPTION) return paragraph || undefined;
  const cut = paragraph.slice(0, MAX_DESCRIPTION);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence > MAX_DESCRIPTION / 3) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

export type Proposed = { year?: number; link?: string; description?: string; cover?: string };
export type Entry = {
  status: string;
  data: Record<string, unknown>;
  liveRevisionId: string | null;
  draftRevisionId: string | null;
};

/** A field with no value: absent, null, blank text or an empty object. */
export const empty = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && !v.trim()) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

/**
 * The proposed fields an entry still has empty, or why it is left alone. Only
 * a published entry with no pending draft is filled: the fill is published,
 * and publishing would also publish an editor's unfinished draft, or an entry
 * an editor keeps unpublished.
 */
export function fillable(entry: Entry, proposed: Proposed): { fill: (keyof Proposed)[] } | { skip: string } {
  if (entry.status !== "published") return { skip: `entry is ${entry.status}, not published` };
  if (entry.draftRevisionId && entry.draftRevisionId !== entry.liveRevisionId) {
    return { skip: "entry has unpublished changes" };
  }
  const fill = (Object.keys(proposed) as (keyof Proposed)[]).filter(
    (field) => proposed[field] !== undefined && empty(entry.data[field]),
  );
  return { fill };
}
