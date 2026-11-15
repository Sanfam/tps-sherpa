/**
 * Markdown to EmDash Portable Text, for the Wiki.js migration (Phase 6). EmDash
 * has no Markdown importer, so this converts the reconstituted export's pages
 * into the block shapes EmDash's own editor writes (emdash/src/content/
 * converters/types.ts): text blocks with styles, list items and marks, `image`,
 * `gallery`, `code`, `table` and `break`.
 *
 * Text, image sources and link `href`s are entity-decoded, and otherwise left as
 * written: the import rewrites sources and hrefs once it has uploaded the files. Whatever has no
 * Portable Text shape is kept as plain text and named in `warnings`.
 */
import { decodeHTML } from "entities";
import { marked, type Token, type Tokens } from "marked";

type Span = { _type: "span"; _key: string; text: string; marks: string[] };
type MarkDef = { _type: "link"; _key: string; href: string };
export type Block = { _type: string; _key: string; [field: string]: unknown };
/** An image as the Markdown wrote it: the source, its alt text, and the link around it. */
type Image = { src: string; alt: string; href?: string };

// Wiki.js renders emoji as Twemoji images whose alt text is the emoji itself.
const EMOJI = /\/twemoji\//;

/**
 * A link's href, entity-decoded and stripped as a browser strips a URL (control
 * characters and spaces at either end, tabs and newlines anywhere); or null for
 * a scheme other than http(s) or mailto (`javascript:`, or Discord's
 * `<id:customize>`), which stays text. A URL has a scheme when a colon comes
 * before any `/`, `?` or `#`.
 */
export function safeHref(raw: string): string | null {
  const href = decodeHTML(raw)
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
    .replace(/[\t\n\r]/g, "");
  return /^(https?|mailto):/i.test(href) || !/^[^/?#]*:/.test(href) ? href : null;
}

/**
 * Raw HTML as the text a reader would see: comments removed, then each real tag
 * (`<` and a letter) dropped, so a bare `<` or `>` in text stays. Each image and
 * link the tags held is named in `dropped`, for the report.
 */
export function stripHtml(raw: string): { text: string; dropped: string[] } {
  const html = raw.replace(/<!--[\s\S]*?-->/g, " ");
  const attr = (tag: string, name: string) => decodeHTML(tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1] ?? "");
  const dropped = [...html.matchAll(/<(img|a)\b[^>]*>/gi)].map(([tag, name]) =>
    name!.toLowerCase() === "img" ? `image "${attr(tag, "alt")}"` : `link to ${attr(tag, "href")}`,
  );
  const text = decodeHTML(html.replace(/<\/?[a-zA-Z][^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return { text, dropped };
}

const tagName = (raw: string) => `<${raw.match(/^\s*<\/?\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase() ?? "?"}>`;

export function markdownToPortableText(markdown: string): { blocks: Block[]; warnings: string[] } {
  let n = 0;
  const key = () => `k${++n}`;
  const blocks: Block[] = [];
  const warnings: string[] = [];

  /** Spans and images, in order, for one run of inline Markdown. */
  function inline(tokens: Token[], marks: string[], markDefs: MarkDef[], href?: string): (Span | Image)[] {
    const out: (Span | Image)[] = [];
    const text = (t: string) => out.push({ _type: "span", _key: "", text: t, marks });
    for (const t of tokens) {
      switch (t.type) {
        case "text":
          // A soft line break stays a newline, which EmDash renders as a line
          // break: Wiki.js converts line breaks by default, so the wiki showed one.
          if ("tokens" in t && t.tokens?.length) out.push(...inline(t.tokens, marks, markDefs, href));
          else text(decodeHTML(t.text));
          break;
        case "escape":
          text(t.text);
          break;
        case "br":
          text("\n");
          break;
        case "codespan":
          out.push({ _type: "span", _key: "", text: t.text, marks: [...marks, "code"] });
          break;
        case "strong":
        case "em":
        case "del": {
          const mark = { strong: "strong", em: "em", del: "strike-through" }[t.type];
          out.push(...inline((t as Tokens.Strong).tokens, [...marks, mark], markDefs, href));
          break;
        }
        case "link": {
          const link = t as Tokens.Link;
          const href = safeHref(link.href);
          if (href === null) {
            text(decodeHTML(link.raw));
            break;
          }
          let def = markDefs.find((d) => d.href === href);
          if (!def) markDefs.push((def = { _type: "link", _key: key(), href }));
          out.push(...inline(link.tokens, [...marks, def._key], markDefs, href));
          break;
        }
        case "image": {
          const image = t as Tokens.Image;
          const alt = decodeHTML(image.text);
          if (EMOJI.test(image.href)) text(alt);
          else out.push({ src: decodeHTML(image.href), alt, ...(href && { href }) });
          break;
        }
        case "html":
          // An inline tag (Wiki.js writes `# <h1 …>Title</h1>`) is dropped; the
          // text between tags comes as its own tokens and stays.
          warnings.push(`inline HTML tag dropped: ${tagName(t.raw)}`);
          for (const d of stripHtml(t.raw).dropped) warnings.push(`inline HTML: ${d} dropped`);
          break;
        default:
          warnings.push(`inline ${t.type} kept as text: ${t.raw.slice(0, 40)}`);
          text(t.raw);
      }
    }
    return out;
  }

  /** Adjacent spans with the same marks as one; markDefs trimmed to those used. */
  function tidy(spans: Span[], markDefs: MarkDef[]) {
    const merged: Span[] = [];
    for (const s of spans) {
      const last = merged.at(-1);
      if (last && last.marks.join() === s.marks.join()) last.text += s.text;
      else merged.push({ ...s, _key: key() });
    }
    const first = merged[0];
    const end = merged.at(-1);
    if (first) first.text = first.text.trimStart();
    if (end) end.text = end.text.trimEnd();
    const used = new Set(merged.flatMap((s) => s.marks));
    return { children: merged.filter((s) => s.text !== ""), markDefs: markDefs.filter((d) => used.has(d._key)) };
  }

  const imageBlock = (i: Image): Block => ({
    _type: "image",
    _key: key(),
    asset: { _ref: i.src },
    alt: i.alt,
    ...(i.href && i.href !== i.src && { link: { href: i.href } }),
  });

  /**
   * One text block, or several: an image cannot sit inside a Portable Text
   * block, so each one splits the text around it, and a run of two or more
   * unlinked images becomes one gallery. The block's style and list fields go
   * on every text part. A row of the same unlinked image three or more times
   * over is decoration (the wiki's icon rows), and is dropped.
   */
  function textBlocks(tokens: Token[], fields: Record<string, unknown>) {
    const markDefs: MarkDef[] = [];
    const parts = inline(tokens, [], markDefs);
    let spans: Span[] = [];
    let images: Image[] = [];
    const flushText = () => {
      const { children, markDefs: used } = tidy(spans, markDefs);
      spans = [];
      if (children.length) blocks.push({ _type: "block", _key: key(), ...fields, children, markDefs: used });
    };
    const flushImages = () => {
      images = images.filter((img, i) => {
        const same = (j: number) => images[j]?.src === img.src && !images[j]?.href;
        let start = i;
        while (same(start - 1)) start--;
        let end = i;
        while (same(end + 1)) end++;
        const row = !img.href && end - start >= 2;
        if (row && i === start) warnings.push(`decorative row dropped: ${end - start + 1} x ${img.src.split("/").pop()}`);
        return !row;
      });
      if (images.length > 1 && images.every((i) => !i.href)) {
        blocks.push({
          _type: "gallery",
          _key: key(),
          images: images.map((i) => ({ _type: "image", _key: key(), asset: { _ref: i.src }, alt: i.alt })),
        });
      } else blocks.push(...images.map(imageBlock));
      images = [];
    };
    for (const p of parts) {
      if ("src" in p) {
        // Whitespace between images keeps them in one run.
        if (spans.some((s) => s.text.trim())) flushText();
        spans = [];
        images.push(p);
      } else {
        if (images.length && p.text.trim()) flushImages();
        spans.push(p);
      }
    }
    if (images.length) flushImages();
    flushText();
  }

  function list(token: Tokens.List, level: number) {
    const listId = token.ordered ? `list-${key()}` : undefined;
    const fields = {
      style: "normal",
      listItem: token.ordered ? "number" : "bullet",
      level,
      ...(listId && { listId, listStart: typeof token.start === "number" ? token.start : 1 }),
    };
    for (const item of token.items) {
      if (item.task) warnings.push("task-list checkbox dropped");
      let paragraphs = 0;
      for (const child of item.tokens) {
        if (child.type === "list") list(child as Tokens.List, level + 1);
        else if (child.type === "text" || child.type === "paragraph") {
          if (paragraphs++) warnings.push("second paragraph in a list item becomes its own item");
          const tokens = ((child as Tokens.Paragraph).tokens ?? []).filter((t) => t.type !== "checkbox");
          textBlocks(tokens, fields);
        } else if (child.type !== "space") block(child, `in a list item, ${child.type}`);
      }
    }
  }

  function cell(c: Tokens.TableCell, isHeader: boolean) {
    const markDefs: MarkDef[] = [];
    // An image cannot sit in a cell: its alt text takes its place.
    const spans = inline(c.tokens, [], markDefs).map((p): Span => {
      if (!("src" in p)) return p;
      warnings.push("image in a table cell kept as its alt text");
      return { _type: "span", _key: "", text: p.alt, marks: [] };
    });
    const { children, markDefs: used } = tidy(spans, markDefs);
    return {
      _type: "tableCell",
      _key: key(),
      content: children,
      markDefs: used,
      ...(isHeader && { isHeader: true }),
      ...(c.align && { textAlign: c.align }),
    };
  }

  function block(t: Token, context?: string) {
    if (context) warnings.push(`${context} flattened`);
    switch (t.type) {
      case "space":
      case "def":
        return;
      case "heading":
        return textBlocks((t as Tokens.Heading).tokens, { style: `h${Math.min((t as Tokens.Heading).depth, 6)}` });
      case "paragraph":
      case "text":
        return textBlocks((t as Tokens.Paragraph).tokens ?? [], { style: "normal" });
      case "blockquote":
        for (const child of (t as Tokens.Blockquote).tokens) {
          if (child.type === "paragraph") textBlocks((child as Tokens.Paragraph).tokens, { style: "blockquote" });
          else block(child, `in a blockquote, ${child.type}`);
        }
        return;
      case "list":
        return list(t as Tokens.List, 1);
      case "code": {
        const code = t as Tokens.Code;
        return void blocks.push({ _type: "code", _key: key(), code: code.text, ...(code.lang && { language: code.lang }) });
      }
      case "hr":
        return void blocks.push({ _type: "break", _key: key(), style: "lineBreak" });
      case "table": {
        const table = t as Tokens.Table;
        const row = (cells: Tokens.TableCell[], header: boolean) => ({
          _type: "tableRow",
          _key: key(),
          cells: cells.map((c) => cell(c, header)),
        });
        return void blocks.push({
          _type: "table",
          _key: key(),
          hasHeaderRow: true,
          rows: [row(table.header, true), ...table.rows.map((r) => row(r, false))],
        });
      }
      default: {
        // Raw HTML never shows as text: its tags are dropped, and only the text between them is kept.
        const html = t.type === "html" ? stripHtml(t.raw) : null;
        const kept = html ? html.text : t.raw.trim();
        warnings.push(html ? `HTML block: tags dropped (${tagName(t.raw)})` : `${t.type} kept as text: ${t.raw.slice(0, 40)}`);
        for (const d of html?.dropped ?? []) warnings.push(`HTML block: ${d} dropped`);
        if (kept) {
          blocks.push({
            _type: "block",
            _key: key(),
            style: "normal",
            children: [{ _type: "span", _key: key(), text: kept, marks: [] }],
            markDefs: [],
          });
        }
      }
    }
  }

  for (const t of marked.lexer(markdown)) block(t);
  return { blocks, warnings: [...new Set(warnings)] };
}

const plain = (b: Block) => (b["children"] as Span[]).map((s) => s.text).join("").trim();

/**
 * A page made sound for the CMS: the wiki's top heading, when the body opens
 * with an h1, becomes the title and leaves the body; the remaining headings
 * start at h2 and skip no level, each keeping its place in the outline.
 */
export function restructure(blocks: Block[]): { title?: string; blocks: Block[] } {
  const [first, ...rest] = blocks;
  const opensWithTitle = first?._type === "block" && first["style"] === "h1" && plain(first) !== "";
  const body = opensWithTitle ? rest : blocks;
  const outline: { from: number; to: number }[] = [];
  const out = body.map((b) => {
    const level = b._type === "block" && /^h[1-6]$/.test(String(b["style"])) ? Number(String(b["style"]).slice(1)) : 0;
    if (!level) return b;
    while (outline.length && outline.at(-1)!.from >= level) outline.pop();
    const to = Math.min((outline.at(-1)?.to ?? 1) + 1, 6);
    outline.push({ from: level, to });
    return { ...b, style: `h${to}` };
  });
  return { ...(opensWithTitle && { title: plain(first) }), blocks: out };
}
