/**
 * Works out of the wiki's book lists (owner, 2026-11-15): a club page
 * references `works` entries rather than repeating each book. Only what the
 * export states is taken: title, creators as written, cover and link. Nothing
 * else about a book is filled in.
 */
import { decodeHTML } from "entities";
import type { Block } from "./markdown-to-portable-text.ts";

export type Work = {
  title: string;
  creators?: string;
  cover?: { src: string; alt: string };
  link?: string;
  description?: string;
};

/** One schedule entry as the book club's cover grid came out of the export:
 * month, title, creators, an optional discussion thread, then the linked cover,
 * with blank lines allowed between them. */
const ENTRY =
  /[ \t]*\*\*([A-Z][a-z]+,? \d{4})\*\*[ \t]*\n[ \t]*\*([^*\n]+)\*[ \t]*\n[ \t]*([^\n]+?)[ \t]*\n(?:[ \t]*\n)*(?:[ \t]*\[Discussion thread\]\(([^)\s]+)\)[ \t]*\n(?:[ \t]*\n)*)?[ \t]*\[\s*!\[([^\n]*?)\]\(([^)\s]+)\)\]\(([^)\s]+)\)/g;

/**
 * The schedule's entries as works, in page order, and the Markdown with each
 * entry replaced by a list item holding what belongs to the club, not the
 * book: the month, the title to name it by, and the discussion thread.
 */
export function extractSchedule(markdown: string): { markdown: string; works: Work[] } {
  const works: Work[] = [];
  const rewritten = markdown.replace(ENTRY, (_, month, title, creators, thread, alt, cover, link) => {
    const name = title.trim();
    // Some covers carry the wiki's placeholder alt text, "[Book title] by [Author]".
    works.push({ title: name, creators, cover: { src: cover, alt: alt.includes("[Book title]") ? `${name} (book cover)` : alt }, link });
    return `\n- **${month}**: *${name}*${thread ? ` ([Discussion thread](${thread}))` : ""}`;
  });
  return { markdown: rewritten, works };
}

// The voting page's book list, in Wiki.js raw HTML: a `n4r_book_list` div of
// `n4r_book` divs, each a linked italic title, the author, a linked cover and a
// description broken with `<br>`s. Only this structure is read.
const BOOK_LIST = /<div class="n4r_book_list"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/;
const BOOK = /<div class="n4r_book"[^>]*>([\s\S]*?)(?=<\/div>|$)/g;
const BOOK_PARTS =
  /^\s*(?:<br\s*\/?>\s*)*<a[^>]*href="([^"]+)"[^>]*>\s*<i>([^<]+)<\/i>\s*<\/a>\s*<br\s*\/?>\s*([^<]+?)\s*<br\s*\/?>\s*(?:<br\s*\/?>\s*)*<a[^>]*>\s*<img[^>]*src="([^"]+)"[^>]*>\s*<\/a>([\s\S]*)$/;
const text = (html: string) => decodeHTML(html.replace(/<\/?br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/**
 * The voting page's book list as works, in order, and the Markdown with the
 * list replaced by one list item per book naming its title. A book that does
 * not read as this structure throws, naming it: the list is never replaced by
 * only the books that parsed.
 */
export function extractBookList(markdown: string): { markdown: string; works: Work[] } {
  const total = (markdown.match(/class="n4r_book"/g) ?? []).length;
  const list = markdown.match(BOOK_LIST);
  if (!list) {
    if (total) throw new Error(`a book list with ${total} book(s) was not found in its expected shape`);
    return { markdown, works: [] };
  }
  const works: Work[] = [];
  const entries = [...(list[1] ?? "").matchAll(BOOK)];
  for (const [i, [, inner = ""]] of entries.entries()) {
    // The book pattern ends at the first `</div>`, so a nested div would cut it short.
    if (/<div\b/i.test(inner)) throw new Error(`book ${i + 1} of the HTML book list holds a nested <div>: "${text(inner).slice(0, 60)}"`);
    const m = inner.match(BOOK_PARTS);
    if (!m) throw new Error(`book ${i + 1} of the HTML book list does not read as expected: "${text(inner).slice(0, 60)}"`);
    const [, link = "", title = "", creators = "", cover = "", rest = ""] = m;
    const work = { title: text(title), creators: text(creators) };
    // The source alt text is often another book's, or a placeholder.
    const description = text(rest);
    works.push({
      ...work,
      cover: { src: decodeHTML(cover), alt: `${work.title} by ${work.creators} (book cover)` },
      link: decodeHTML(link),
      ...(description && { description }),
    });
  }
  if (entries.length !== total) throw new Error(`the HTML book list has ${total} books, but only ${entries.length} were found in it`);
  // The titles are plain text, so Markdown's own characters in them are escaped,
  // and a replacer function keeps `$&` and its kin in a title literal.
  const items = works.map((w) => `- *${w.title.replace(/[\\*_[\]`<]/g, "\\$&")}*`).join("\n");
  return { markdown: markdown.replace(BOOK_LIST, () => `\n${items}\n`), works };
}

type Cell = { content: { text: string; marks?: string[] }[]; isHeader?: boolean };

/**
 * A table whose every filled body cell reads "Title by Creators" is a book
 * list: its books become works, read column by column so each column's group
 * stays together, and each cell keeps only the title. Any other table is left.
 */
export function extractTableWorks(blocks: Block[]): { blocks: Block[]; works: Work[] } {
  const works: Work[] = [];
  const out = blocks.map((b) => {
    if (b._type !== "table") return b;
    const rows = b["rows"] as { cells: Cell[] }[];
    const body = rows.flatMap((r) => r.cells.filter((c) => !c.isHeader));
    const text = (c: Cell) => c.content.map((s) => s.text).join("").trim();
    const filled = body.filter((c) => text(c));
    const isBook = (c: Cell) => c.content.every((s) => !s.marks?.length) && text(c).lastIndexOf(" by ") > 0;
    if (!filled.length || !filled.every(isBook)) return b;
    const columns = Math.max(...rows.map((r) => r.cells.length));
    for (let col = 0; col < columns; col++) {
      for (const row of rows) {
        const cell = row.cells[col];
        if (!cell || cell.isHeader || !text(cell)) continue;
        const t = text(cell);
        const at = t.lastIndexOf(" by ");
        works.push({ title: t.slice(0, at).trim(), creators: t.slice(at + 4).trim() });
        cell.content = [{ ...cell.content[0]!, text: t.slice(0, at).trim() }];
      }
    }
    return b;
  });
  return { blocks: out, works };
}

const fold = (text = "") => text.toLowerCase().normalize("NFKD").replace(/[^\p{Letter}\p{Number}]+/gu, "");

/** Two works are one when title and creators both match, ignoring case,
 * accents, spacing and punctuation. The same title by other creators is another work. */
export const workKey = (title: string, creators?: string) => `${fold(title)}|${fold(creators)}`;
