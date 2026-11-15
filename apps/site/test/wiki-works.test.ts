// The book club's lists into works (scripts/wiki-works.ts), on synthetic
// Markdown shaped like the export's flattened cover grid. A missed entry
// leaves a book in the page and out of the works; a misread one invents data.
import { expect, test } from "vitest";
import { markdownToPortableText } from "../scripts/markdown-to-portable-text.ts";
import { extractBookList, extractSchedule, extractTableWorks, workKey } from "../scripts/wiki-works.ts";

const GRID = `## Upcoming     **May, 2030**
 *First Book*
 Ann Author and Bo Writer

 [ ![[Book title] by [Author] (book cover)](https://covers.example/a)](https://books.example/1)   **June, 2030**
 *Second: A Tale*
 Cy Pen
 [Discussion thread](https://chat.example/threads/3)

 [ ![Second: A Tale by Cy Pen (book cover)](../../assets/covers/second.jpg)](https://books.example/2)

## Past

Prose about the club that stays as written.
`;

test("each schedule entry becomes a work, and the page keeps the month, the title and the thread", () => {
  const { markdown, works } = extractSchedule(GRID);
  expect(works).toEqual([
    { title: "First Book", creators: "Ann Author and Bo Writer", cover: { src: "https://covers.example/a", alt: "First Book (book cover)" }, link: "https://books.example/1" },
    { title: "Second: A Tale", creators: "Cy Pen", cover: { src: "../../assets/covers/second.jpg", alt: "Second: A Tale by Cy Pen (book cover)" }, link: "https://books.example/2" },
  ]);
  const blocks = markdownToPortableText(markdown).blocks;
  const text = (b: (typeof blocks)[number]) => (b["children"] as { text: string }[]).map((s) => s.text).join("");
  expect(blocks.map((b) => [b["style"], b["listItem"] ?? "", text(b)])).toEqual([
    ["h2", "", "Upcoming"],
    ["normal", "bullet", "May, 2030: First Book"],
    ["normal", "bullet", "June, 2030: Second: A Tale (Discussion thread)"],
    ["h2", "", "Past"],
    ["normal", "", "Prose about the club that stays as written."],
  ]);
});

test("a table of 'Title by Creators' cells becomes works column by column, keeping titles; other tables are left", () => {
  const md = `| Fantasy | Sci-fi |
|---|---|
| Sit by Lakes by Some One | Far Out by A & B |
| Deep Woods by C. D. |  |
`;
  const { blocks, works } = extractTableWorks(markdownToPortableText(md).blocks);
  expect(works).toEqual([
    { title: "Sit by Lakes", creators: "Some One" },
    { title: "Deep Woods", creators: "C. D." },
    { title: "Far Out", creators: "A & B" },
  ]);
  const cells = (blocks[0]!["rows"] as { cells: { content: { text: string }[] }[] }[]).map((r) =>
    r.cells.map((c) => c.content.map((s) => s.text).join("")),
  );
  expect(cells).toEqual([["Fantasy", "Sci-fi"], ["Sit by Lakes", "Far Out"], ["Deep Woods", ""]]);

  const other = markdownToPortableText("| Name | Note |\n|---|---|\n| a | written by hand |\n| b | plain |\n").blocks;
  expect(extractTableWorks(other).works).toEqual([]);
  expect(workKey("A Book: Of Things?", "Ann Author & Bo Writer")).toBe(workKey("a book of things", "ann author  bo writer"));
  expect(workKey("A Book: Of Things?", "Ann Author")).not.toBe(workKey("A Book: Of Things?", "Anne Author"));
});

const HTML_LIST = `# <h1 class="toc-header" id="vote">The Vote &amp; Info</h1>
Intro line.
Vote link: https://vote.example/ballot

<div class="n4r_book_list" style="width: 100%;">
<div class="n4r_book" style="display: inline-block;"><br>
    <a class="is-external-link" href="https://books.example/1?a=1&amp;b=2"><i>First &amp; Best</i></a><br>
    Ann Author<br>
    <br>
    <a class="is-external-link" href="https://books.example/1">
      <img src="https://covers.example/1" alt="Some Other Book by Someone (book cover)" class="n4r_book_cover"></a>
  <br>A tale told <br  />in two lines.</br>
  </div>

<div class="n4r_book" style="display: inline-block;"><br>
    <a class="is-external-link" href="https://books.example/2"><i>Last One</i></a><br>
    Bo Writer<br>
    <br>
    <a class="is-external-link" href="https://books.example/2">
      <img src="https://covers.example/2" alt="[Book title] by [Author] (book cover)" class="n4r_book_cover"></a>
  <br>Short.</br>
  </div>
 </div>
`;

test("the voting page's HTML book list becomes works in order, and no raw HTML is left to show", () => {
  const { markdown, works } = extractBookList(HTML_LIST);
  expect(works).toEqual([
    {
      title: "First & Best",
      creators: "Ann Author",
      cover: { src: "https://covers.example/1", alt: "First & Best by Ann Author (book cover)" },
      link: "https://books.example/1?a=1&b=2",
      description: "A tale told in two lines.",
    },
    {
      title: "Last One",
      creators: "Bo Writer",
      cover: { src: "https://covers.example/2", alt: "Last One by Bo Writer (book cover)" },
      link: "https://books.example/2",
      description: "Short.",
    },
  ]);
  const { blocks } = markdownToPortableText(markdown);
  const shown = JSON.stringify(blocks.map((b) => (b["children"] as { text: string }[]).map((s) => s.text).join("")));
  expect(shown).not.toMatch(/[<>]/);
  expect(blocks.map((b) => [b["style"], b["listItem"] ?? ""])).toEqual([
    ["h1", ""],
    ["normal", ""],
    ["normal", "bullet"],
    ["normal", "bullet"],
  ]);
  expect(shown).toContain("The Vote & Info");
});

test("a book that does not read as the structure stops the import, naming it, rather than leaving it out", () => {
  expect(() => extractBookList(HTML_LIST.replace("<i>Last One</i>", "Last One"))).toThrow(/book 2 .*Last One/);
});

test("a book title with Markdown or replacement characters comes through as written", () => {
  const odd = "Cost: $& and $' *star* [x]_y_";
  const { markdown, works } = extractBookList(HTML_LIST.replace("<i>Last One</i>", () => `<i>${odd}</i>`));
  expect(works.map((w) => w.title)).toEqual(["First & Best", odd]);
  const items = markdownToPortableText(markdown).blocks.filter((b) => b["listItem"]);
  expect(items.map((b) => (b["children"] as { text: string }[]).map((s) => s.text).join(""))).toEqual(["First & Best", odd]);
});

test("a book holding a nested <div> stops the import, naming it, rather than losing the rest of its text", () => {
  const nested = HTML_LIST.replace("<br>Short.</br>", "<br>Short <div>aside</div> and more.</br>");
  expect(() => extractBookList(nested)).toThrow(/book 2 .*nested <div>/);
});
