// The wiki converter (scripts/markdown-to-portable-text.ts), on synthetic
// Markdown only. What it must get right is invisible until a Club Lead edits a
// migrated page: EmDash's editor converts Portable Text to ProseMirror on open
// and back on save, and anything it cannot hold is changed or lost then. The
// same page holds entity decoding and the refusal of unsafe link schemes.
import { portableTextToProsemirror, prosemirrorToPortableText } from "emdash";
import { expect, test } from "vitest";
import { markdownToPortableText, restructure, type Block } from "../scripts/markdown-to-portable-text.ts";

type Span = { text: string; marks?: string[] };

type MarkDefs = { _key: string; href: string }[] | undefined;

/** Text with each span's marks after it, and a link mark as its href. Span boundaries do not show. */
const text = (spans: Span[], defs: MarkDefs) => {
  const hrefs = new Map(defs?.map((d) => [d._key, d.href]));
  return spans.map((s) => s.text + (s.marks ?? []).map((m) => (hrefs.has(m) ? `<${hrefs.get(m)}>` : `[${m}]`)).join("")).join("");
};

type Image = { asset: { _ref: string }; alt?: string; link?: { href: string } };
const image = (i: Image) => `${i.asset._ref} "${i.alt ?? ""}"${i.link ? ` <${i.link.href}>` : ""}`;

/** What a reader sees of each block: its kind, text, links, images' alt text, list placement and alignment. */
const seen = (blocks: Block[]) =>
  blocks.map((b) => {
    if (b._type === "block") {
      return [b["style"], b["listItem"] ?? "", b["level"] ?? "", text(b["children"] as Span[], b["markDefs"] as MarkDefs)].join(" ");
    }
    if (b._type === "image") return `image ${image(b as unknown as Image)}`;
    if (b._type === "gallery") return `gallery ${(b["images"] as Image[]).map(image).join(", ")}`;
    if (b._type === "code") return `code (${b["language"] ?? ""}) ${b["code"]}`;
    if (b._type === "table") {
      type Cell = { content: Span[]; markDefs: MarkDefs; isHeader?: boolean; textAlign?: string };
      return `table ${(b["rows"] as { cells: Cell[] }[])
        .map((r) => r.cells.map((c) => `${c.isHeader ? "H:" : ""}${c.textAlign ? `${c.textAlign}:` : ""}${text(c.content, c.markDefs)}`).join(","))
        .join(";")}`;
    }
    return b._type;
  });

const SAMPLE = `# Title ![🎲](../assets/_assets/svg/twemoji/1f3b2.svg)

Intro with **bold**, *em*, \`code\`, ~~gone~~ and a [link](https://example.com/a) and **[bold link](https://example.com/b)**.
Second line after a soft break, then a hard one
here.

## Lists

1. first
2. second
   - nested *bullet*
     - deeper
3. third

Between the lists.

4. a list that starts at four
5. five

- [another page](../other/page.md)

> A quote with a [link](https://example.com/q).

\`\`\`js
const x = 1;
\`\`\`

---

| Name | **Note** |
|:---|---:|
| a [l](https://example.com/t) | b ![icon](i.png) after |

Text before ![one](a.png) text after.

![two](b.png) ![three](c.png)

[![cover](cover.jpg)](https://example.com/book)

AT&amp;T, a [query](https://example.com/?a=1&amp;b=2), [bad](javascript:alert(1)) and [hidden](java&#115;cript:alert(1)).
`;

test("a converted page survives EmDash's editor: opening and saving it changes nothing a reader sees", () => {
  const { blocks, warnings } = markdownToPortableText(SAMPLE);
  expect(warnings).toEqual(["image in a table cell kept as its alt text"]);
  const resaved = prosemirrorToPortableText(portableTextToProsemirror(blocks as never)) as Block[];
  expect(seen(resaved)).toEqual(seen(blocks));
  expect(seen(blocks)).toEqual([
    "h1   Title 🎲",
    "normal   Intro with bold[strong], em[em], code[code], gone[strike-through] and a link<https://example.com/a> and bold link[strong]<https://example.com/b>.\nSecond line after a soft break, then a hard one\nhere.",
    "h2   Lists",
    "normal number 1 first",
    "normal number 1 second",
    "normal bullet 2 nested bullet[em]",
    "normal bullet 3 deeper",
    "normal number 1 third",
    "normal   Between the lists.",
    "normal number 1 a list that starts at four",
    "normal number 1 five",
    "normal bullet 1 another page<../other/page.md>",
    "blockquote   A quote with a link<https://example.com/q>.",
    "code (js) const x = 1;",
    "break",
    "table H:left:Name,H:right:Note[strong];left:a l<https://example.com/t>,right:b icon after",
    "normal   Text before",
    'image a.png "one"',
    "normal   text after.",
    'gallery b.png "two", c.png "three"',
    'image cover.jpg "cover" <https://example.com/book>',
    "normal   AT&T, a query<https://example.com/?a=1&b=2>, [bad](javascript:alert(1)) and [hidden](javascript:alert(1)).",
  ]);
});

test("separate numbered lists keep their own numbering through the editor", () => {
  const { blocks } = markdownToPortableText(SAMPLE);
  const resaved = prosemirrorToPortableText(portableTextToProsemirror(blocks as never)) as Block[];
  const numbered = resaved.filter((b) => b["listItem"] === "number");
  const lists = Map.groupBy(numbered, (b) => b["listId"]);
  // first/second/third are one list across the nested bullets; four and five another, from 4.
  expect([...lists.values()].map((l) => l.map((b) => b["listStart"]))).toEqual([[1, 1, 1], [4, 4]]);
});

test("the top heading becomes the title, and the outline starts at h2 with no skipped level", () => {
  const md = "# The Club\n\nIntro.\n\n#### Deep first\n\n## Section\n\n#### Skipped a level\n\n##### Deeper\n\n### Back up\n\n# Another top\n\n### Under it\n";
  const { title, blocks } = restructure(markdownToPortableText(md).blocks);
  expect(title).toBe("The Club");
  expect(seen(blocks)).toEqual([
    "normal   Intro.",
    "h2   Deep first",
    "h2   Section",
    "h3   Skipped a level",
    "h4   Deeper",
    "h3   Back up",
    "h2   Another top",
    "h3   Under it",
  ]);
  // A page that does not open with an h1 keeps its wiki title.
  expect(restructure(markdownToPortableText("Text first.\n\n# Later\n").blocks).title).toBeUndefined();
});

test("a row of one repeated icon is dropped and reported; a lone or linked image stays", () => {
  const md = "![big](big.png)\n![i](icon.png)![i](icon.png)![i](icon.png)\n[![c](c.png)](https://e.x/1)[![c](c.png)](https://e.x/2)[![c](c.png)](https://e.x/3)\n";
  const { blocks, warnings } = markdownToPortableText(md);
  expect(seen(blocks)).toEqual([
    'image big.png "big"',
    'image c.png "c" <https://e.x/1>',
    'image c.png "c" <https://e.x/2>',
    'image c.png "c" <https://e.x/3>',
  ]);
  expect(warnings).toEqual(["decorative row dropped: 3 x icon.png"]);
});

test("raw HTML shows only its text: a bare < or > in it stays, comments go, and each image and link is reported", () => {
  const md = '<div class="note">\nx < y and z > w <!-- hidden <b>note</b> -->\n<a href="https://e.x/a">here</a> <img src="i.png" alt="An icon">\n</div>\n';
  const { blocks, warnings } = markdownToPortableText(md);
  expect(seen(blocks)).toEqual(["normal   x < y and z > w here"]);
  expect(warnings).toEqual(['HTML block: tags dropped (<div>)', "HTML block: link to https://e.x/a dropped", 'HTML block: image "An icon" dropped']);
});
