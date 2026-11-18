/**
 * Imports the reconstituted Wiki.js export into EmDash's `pages` collection
 * (Phase 6; owner decisions of 2026-11-14 in ASTRO-ARCHITECTURE.md).
 *
 * It goes through EmDash's own REST API on a running site, signed in as an
 * Admin with the site's session cookie, so EmDash's permissions, revisions,
 * search index and media library all see the import as an edit, and the gate
 * applies as it does to anyone. Nothing here writes to EmDash's tables.
 *
 *   SITE_COOKIE='better-auth.session_token=…' node scripts/import-wiki.ts \
 *     --export <dir> --site <origin> [--owners <file>] [--allow-missing-draft] [--dry-run]
 *
 * `--site` is https, or http on a loopback host only, since the cookie goes to it.
 *
 * `--owners` is a JSON object from page path to the owner's EmDash address,
 * `<snowflake>@discord.local`. It names members, so it must be outside the
 * repository; the script refuses a path inside it, and `wiki-owners*.json` is
 * gitignored as a backstop. It is optional: every page, the draft included,
 * starts owned by the importing Admin (owner, 2026-11-15), and the file
 * reassigns pages later. Each owner it names must already have an enabled
 * EmDash account at Author or above, made by signing in to the CMS once. A
 * missing draft stops the run unless `--allow-missing-draft` is given.
 *
 * Each page keeps its wiki path as its slug (`parenting/child/home`), and its
 * internal links become site paths (`/parenting/child/home`); links to the
 * excluded channel index go to `/index`, where the Index will live. A link to
 * a page the wiki never had gets a draft stub at that slug, so it resolves
 * once someone writes and publishes the page.
 *
 * Owner decisions of 2026-11-15 also shape the content: the wiki's top heading
 * becomes the title, headings start at h2, decorative icon rows are dropped,
 * wiki tags go into the `tag` taxonomy, and the book club's book lists become
 * `works` entries that the club pages reference. The script creates the
 * schema these need through EmDash's schema API when it is missing.
 *
 * A re-run finishes what an interrupted run left: for a slug that already
 * exists it sets the owner named in the owners file, if that differs, and
 * publishes the entry if the wiki page is published and the entry is not. It
 * never creates a second entry for a slug, and never rewrites an existing
 * entry's content, so edits made in the CMS since are kept, and so is a
 * failed image in an entry already created.
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { connect, coverField, fetchImage, inRepository, uploadMedia, type Media } from "./emdash-api.ts";
import { markdownToPortableText, restructure, type Block } from "./markdown-to-portable-text.ts";
import { extractBookList, extractSchedule, extractTableWorks, workKey, type Work } from "./wiki-works.ts";

// The stale generated channel index, replaced by the Catalog (owner, 2026-11-14);
// links to it go to the Index's placeholder path (owner, 2026-11-15).
const EXCLUDED = ["papasquad/threads-and-channels"];
const INDEX_PATH = "/index";
const WORK_KINDS = ["book", "movie", "show", "video game", "board game", "other"];
// Unpublished on the wiki; migrates as a draft (owner, 2026-11-14).
const DRAFTS = ["entertainment/Need4ReadBookClub/Voting"];
const ADMIN = 50;
const AUTHOR = 30;
const OWNER = /^\d{17,20}@discord\.local$/;

const { values: args } = parseArgs({
  options: {
    export: { type: "string" },
    site: { type: "string" },
    owners: { type: "string" },
    "allow-missing-draft": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!args.export || !args.site) {
  throw new Error("usage: --export <dir> --site <origin> [--owners <file>] [--allow-missing-draft] [--dry-run]");
}
const cookie = process.env["SITE_COOKIE"];
if (!cookie && !args["dry-run"]) throw new Error("SITE_COOKIE is not set");
const exportDir = realpathSync(args.export);
// The pages directory and every page file must resolve inside the export, as assets must.
const pagesDir = realpathSync(join(exportDir, "pages"));
if (!pagesDir.startsWith(exportDir + sep)) throw new Error("the pages directory resolves outside the export");
const { api, all, find } = connect(args.site, cookie);


// The export's front matter is one `key: <JSON value>` per line.
function readPage(file: string) {
  if (!realpathSync(file).startsWith(exportDir + sep)) throw new Error(`a page resolves outside the export: ${file}`);
  const text = readFileSync(realpathSync(file), "utf8");
  const [, head = "", body = text] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  const meta = Object.fromEntries(
    head.split("\n").map((line) => {
      const i = line.indexOf(": ");
      return [line.slice(0, i), JSON.parse(line.slice(i + 2))];
    }),
  ) as { title: string; path: string; created: string; tags?: string[]; source?: string };
  return { file, meta, body };
}

const pages = readdirSync(pagesDir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".md"))
  .map((f) => readPage(join(pagesDir, f)))
  .filter((p) => !EXCLUDED.includes(p.meta.path))
  .sort((a, b) => a.meta.path.localeCompare(b.meta.path));
const paths = new Set(pages.map((p) => p.meta.path));
// The old wiki's host, from each page's source URL, to map absolute links to it.
const wikiHosts = new Set(pages.flatMap((p) => (p.meta.source ? [new URL(p.meta.source).host] : [])));
for (const p of pages) {
  if (p.meta.path !== relative(pagesDir, p.file).slice(0, -3).split(sep).join("/")) {
    throw new Error(`front-matter path does not match the file: ${p.file}`);
  }
}

const missingDrafts = DRAFTS.filter((d) => !paths.has(d));
if (missingDrafts.length && !args["allow-missing-draft"]) {
  throw new Error(`not in the export: ${missingDrafts.join(", ")}. Pass --allow-missing-draft to import without it.`);
}

let owners: Record<string, string> = {};
if (args.owners) {
  const file = realpathSync(args.owners);
  if (inRepository(file)) throw new Error("the owners file names members: keep it outside the repository");
  owners = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
}
for (const [path, email] of Object.entries(owners)) {
  if (!paths.has(path)) throw new Error(`owners file names a page not in the import: ${path}`);
  if (!OWNER.test(email)) throw new Error(`owners file: not a <snowflake>@discord.local address, for ${path}`);
}

const report = {
  pages: 0,
  published: 0,
  drafts: 0,
  /** Slugs that already existed: owner and status reconciled, content left alone. */
  existing: [] as string[],
  /** Draft pages made for links to pages the wiki never had. */
  stubs: [] as string[],
  works: { created: [] as string[], existing: 0, published: 0 },
  schema: [] as string[],
  reassigned: 0,
  images: 0,
  missingDrafts,
  warnings: [] as string[],
};

const isRemote = (s: string) => /^[a-z][a-z0-9+.-]*:/i.test(s);

const isLocal = (href: string) => !(isRemote(href) || href.startsWith("#") || href.startsWith("//"));
const known = (path: string) => paths.has(path) || EXCLUDED.includes(path);

/**
 * The wiki page a link names, or null when it names none: a link to the old
 * wiki's host, a root-relative path, or a path relative to the page's file,
 * with or without `.md`. A leading locale segment (`/en/…`, as Wiki.js writes
 * absolute links) is dropped when only that makes the path a page. `known`
 * says whether the page is in the export; `md` whether the link named a file.
 */
function wikiPage(href: string, pageFile: string) {
  let target: string;
  let hash: string | undefined;
  // A protocol-relative link (`//host/…`) is an absolute one.
  const absolute = /^(https?:)?\/\//i.test(href);
  if (absolute) {
    const url = new URL(href, "https://protocol-relative.invalid");
    if (!wikiHosts.has(url.host)) return null;
    target = decodeURI(url.pathname);
    hash = url.hash.slice(1) || undefined;
  } else if (isLocal(href)) {
    const [t = "", h] = href.split("#");
    target = decodeURI(t);
    hash = h;
  } else return null;
  // A root-relative or absolute link is a wiki path; a relative one is relative to the page's file.
  const file = absolute || target.startsWith("/") ? join(pagesDir, target) : resolve(dirname(pageFile), target);
  if (!file.startsWith(pagesDir + sep)) return null;
  let path = relative(pagesDir, file).split(sep).join("/").replace(/\.md$/, "");
  const bare = path.replace(/^[a-z]{2}(-[a-z]{2})?\//i, "");
  if (!known(path) && known(bare)) path = bare;
  return { path, hash, known: known(path), md: target.endsWith(".md"), absolute };
}

/**
 * A link as the site should carry it: a wiki page becomes its site path (the
 * channel index, the Index's), a file in the export its media URL, anything
 * else is kept.
 */
async function rewriteHref(href: string, pageFile: string) {
  const where = relative(pagesDir, pageFile);
  const page = wikiPage(href, pageFile);
  if (page && (page.known || page.md)) {
    // An unknown `.md` page gets a draft stub, so its site path will resolve.
    return EXCLUDED.includes(page.path) ? INDEX_PATH : `/${page.path}${page.hash ? `#${page.hash}` : ""}`;
  }
  if (page?.absolute) {
    report.warnings.push(`${where}: old-wiki link not mapped, kept as written: ${href}`);
    return href;
  }
  if (href.startsWith("//")) {
    report.warnings.push(`${where}: protocol-relative link not mapped, kept as written: ${href}`);
    return href;
  }
  if (!isLocal(href)) return href;
  if (href.startsWith("/")) {
    // A root-relative link that is no page or stub here: kept, and reported
    // unless it is a path the site has (the Index, an uploaded file).
    // `/index`, with or without a trailing slash, query or fragment.
    const indexPath = href.startsWith(INDEX_PATH) && /^(?:[/?#]|$)/.test(href.slice(INDEX_PATH.length));
    if (!(indexPath || href.startsWith("/_emdash/api/media/file/"))) {
      report.warnings.push(`${where}: root-relative link not mapped, kept as written: ${href}`);
    }
    return href;
  }
  const file = resolve(dirname(pageFile), decodeURI(href.split("#")[0] ?? ""));
  try {
    return (await upload(file)).url;
  } catch (e) {
    report.warnings.push(`${where}: link kept as written (${(e as Error).message}): ${href}`);
    return href;
  }
}

/**
 * Each page shaped once: its book lists taken out as works (the schedule, the
 * voting page's HTML list, a "Title by Creators" table), the rest converted and
 * restructured. A local cover's path is made absolute, as the work may be
 * created while another page is processed.
 */
function prepare(page: (typeof pages)[number]) {
  const schedule = extractSchedule(page.body);
  let books: ReturnType<typeof extractBookList>;
  try {
    books = extractBookList(schedule.markdown);
  } catch (e) {
    throw new Error(`${page.meta.path}: ${(e as Error).message}`);
  }
  const converted = markdownToPortableText(books.markdown);
  const shaped = restructure(converted.blocks);
  const listed = extractTableWorks(shaped.blocks);
  const absolute = (w: Work): Work =>
    w.cover && !isRemote(w.cover.src)
      ? { ...w, cover: { ...w.cover, src: resolve(dirname(page.file), decodeURI(w.cover.src)) } }
      : w;
  const warnings = [...converted.warnings];
  return { title: shaped.title, blocks: listed.blocks, works: [...schedule.works, ...books.works, ...listed.works].map(absolute), warnings };
}
const prepared = new Map(pages.map((p) => [p.meta.path, prepare(p)]));

/** Each work's fields from every list it is in: the first list to give a field wins. */
const mergedWorks = new Map<string, Work>();
for (const { works } of prepared.values()) {
  for (const w of works) {
    const key = workKey(w.title, w.creators);
    const seen = mergedWorks.get(key);
    const given = seen && Object.fromEntries(Object.entries(seen).filter(([, v]) => v !== undefined));
    mergedWorks.set(key, seen ? ({ ...w, ...given } as Work) : w);
  }
}

/** Slugs that wiki links point at but the wiki never had: each gets a draft stub.
 * Read from every page up front, so a re-run that creates no page still makes them. */
const unwritten = new Set<string>();
for (const page of pages) {
  const { blocks } = prepared.get(page.meta.path)!;
  type Defs = { markDefs?: { href: string }[]; link?: { href: string } };
  const hrefs = blocks.flatMap((b) =>
    b._type === "table"
      ? (b["rows"] as { cells: Defs[] }[]).flatMap((r) => r.cells.flatMap((c) => c.markDefs ?? []))
      : [...((b as Defs).markDefs ?? []), ...((b as Defs).link ? [(b as Defs).link!] : [])],
  );
  for (const { href } of hrefs) {
    const target = wikiPage(href, page.file);
    if (target?.md && !target.known) unwritten.add(target.path);
  }
}

/** Uploads each file once per run; EmDash also deduplicates by content hash. */
const uploaded = new Map<string, Promise<Media>>();
function upload(source: string): Promise<Media> {
  let media = uploaded.get(source);
  if (!media) {
    media = (async () => {
      let bytes: Buffer;
      let type = "";
      if (isRemote(source)) ({ bytes, type } = await fetchImage(source));
      else {
        // A local file must be inside the export, symlinks resolved.
        const file = realpathSync(source);
        if (!file.startsWith(exportDir + sep)) throw new Error("outside the export");
        bytes = readFileSync(file);
      }
      if (args["dry-run"]) return { id: source, url: source };
      const item = await uploadMedia(api, bytes, basename(new URL(source, "file:///").pathname), type);
      report.images++;
      return item;
    })();
    uploaded.set(source, media);
  }
  return media;
}

/** A visible note where an image could not be imported, for an editor to replace. */
const unavailable = (key: string, alt: unknown): Block => ({
  _type: "block",
  _key: key,
  style: "normal",
  children: [{ _type: "span", _key: `${key}s`, text: `[Image no longer available: ${String(alt ?? "")}]`, marks: ["em"] }],
  markDefs: [],
});

/** Resolves every image and link in a page's blocks; an image that cannot be imported leaves a note. */
async function resolveMedia(blocks: Block[], pageFile: string): Promise<Block[]> {
  const where = relative(pagesDir, pageFile);
  const source = (ref: string) => (isRemote(ref) ? ref : resolve(dirname(pageFile), decodeURI(ref)));
  const asset = async (img: { asset: { _ref: string }; alt?: string }) => {
    try {
      const m = await upload(source(img.asset._ref));
      return { ...img, asset: { _ref: m.id, url: m.url }, ...(m.width && { width: m.width, height: m.height }) };
    } catch (e) {
      report.warnings.push(`${where}: image not imported (${(e as Error).message}): ${img.asset._ref.split("?")[0]}`);
      return null;
    }
  };
  const links = async (defs: { href: string }[] = []) =>
    Promise.all(defs.map(async (d) => ({ ...d, href: await rewriteHref(d.href, pageFile) })));

  const out: Block[] = [];
  for (const b of blocks) {
    if (b._type === "image") {
      const img = await asset(b as unknown as { asset: { _ref: string }; alt?: string; link?: { href: string } });
      if (!img) {
        out.push(unavailable(b._key, b["alt"]));
        continue;
      }
      const link = (img as { link?: { href: string } }).link;
      out.push({ ...img, _key: b._key, _type: "image", ...(link && { link: (await links([link]))[0] }) });
    } else if (b._type === "gallery") {
      const given = b["images"] as { _key: string; asset: { _ref: string }; alt?: string }[];
      const images = await Promise.all(given.map(asset));
      const live = images.filter(Boolean);
      if (live.length) out.push({ ...b, images: live });
      given.forEach((g, i) => images[i] || out.push(unavailable(g._key, g.alt)));
    } else if (b._type === "table") {
      const rows = b["rows"] as { cells: { markDefs?: { href: string }[] }[] }[];
      for (const row of rows) for (const cell of row.cells) cell.markDefs = await links(cell.markDefs);
      out.push(b);
    } else {
      if (Array.isArray(b["markDefs"])) b["markDefs"] = await links(b["markDefs"] as { href: string }[]);
      out.push(b);
    }
  }
  return out;
}

const me = args["dry-run"] ? { id: "admin", role: ADMIN } : await api<{ id: string; role: number }>("GET", "/auth/me");
if (me.role !== ADMIN) throw new Error("the import runs as an Admin");

// Every owner must have an enabled EmDash account at Author or above before
// anything is written. The account's role is the one last synced from Discord.
const ownerIds = new Map<string, string>();
const refused: string[] = [];
for (const email of new Set(Object.values(owners))) {
  if (args["dry-run"]) {
    ownerIds.set(email, email);
    continue;
  }
  const items = await all<{ id: string; email: string; role: number; disabled: boolean }>(
    `/admin/users?search=${encodeURIComponent(email)}`,
  );
  const user = items.find((u) => u.email === email);
  const pagesOf = Object.keys(owners).filter((p) => owners[p] === email);
  if (!user) refused.push(...pagesOf.map((p) => `${p} (no account yet: they sign in to the CMS once first)`));
  else if (user.disabled) refused.push(...pagesOf.map((p) => `${p} (account disabled)`));
  else if (user.role < AUTHOR) refused.push(...pagesOf.map((p) => `${p} (role below Author)`));
  else ownerIds.set(email, user.id);
}
if (refused.length) throw new Error(`owners refused for: ${refused.join(", ")}`);

/** Terms by label, creating the missing ones; returns label → slug. */
async function ensureTerms(taxonomy: string, labels: string[]) {
  const { terms } = await api<{ terms: { slug: string; label: string }[] }>("GET", `/taxonomies/${taxonomy}/terms`);
  const slugs = new Map(terms.map((t) => [t.label, t.slug]));
  for (const label of labels) {
    if (slugs.has(label)) continue;
    const { term } = await api<{ term: { slug: string } }>("POST", `/taxonomies/${taxonomy}/terms`, { label });
    slugs.set(label, term.slug);
  }
  return slugs;
}

// The schema the content needs (EmDash keeps its schema in the database, and the
// site has no seed of its own). Everything is read and checked first: anything
// that exists but differs stops the run before a write. Then each missing piece
// is created on its own, so a re-run completes an interrupted setup. Nothing
// existing is changed except adding `pages` to the `tag` taxonomy's collections.
type Field = { slug: string; label: string; type: string; required?: boolean; searchable?: boolean; validation?: Record<string, unknown> | null };
const WORK_FIELDS: Field[] = [
  { slug: "title", label: "Title", type: "string", required: true, searchable: true },
  { slug: "creators", label: "Creator(s)", type: "string", searchable: true },
  { slug: "year", label: "Year", type: "integer" },
  { slug: "cover", label: "Cover image", type: "image" },
  { slug: "link", label: "External link", type: "url" },
  { slug: "description", label: "Short description", type: "text" },
];
const PAGE_FIELDS: Field[] = [
  { slug: "title", label: "Title", type: "string" },
  { slug: "content", label: "Content", type: "portableText" },
  { slug: "works", label: "Works", type: "reference", validation: { targetCollection: "works", multiple: true } },
];
type Collection = {
  item: { fields?: { slug: string; type: string; required: boolean; unique: boolean; validation: Record<string, unknown> | null }[] };
};
// The only fields every imported entry fills. A required field outside these
// may be left empty; a unique field the import writes may repeat (two works
// can share a title, or creators).
const ALWAYS_FILLED = new Set(["works.title", "pages.title", "pages.content"]);
type Taxonomy = { taxonomy: { collections: string[] } };

if (!args["dry-run"]) {
  const works = await find<Collection>("/schema/collections/works?includeFields=true");
  const pagesSchema = await find<Collection>("/schema/collections/pages?includeFields=true");
  const kind = await find<Taxonomy>("/taxonomies/work_kind");
  const tag = await find<Taxonomy>("/taxonomies/tag");
  const differs: string[] = [];
  if (!pagesSchema) differs.push("no pages collection");
  const check = (collection: string, have: Collection | null, want: Field[]) => {
    for (const f of want) {
      const got = have?.item.fields?.find((x) => x.slug === f.slug);
      if (!got) continue;
      if (got.type !== f.type) differs.push(`${collection}.${f.slug} is ${got.type}, not ${f.type}`);
      const target = f.validation?.["targetCollection"];
      if (target && got.validation?.["targetCollection"] !== target) {
        differs.push(`${collection}.${f.slug} references ${String(got.validation?.["targetCollection"])}, not ${String(target)}`);
      }
      if (f.validation?.["multiple"] && got.validation?.["multiple"] !== true) differs.push(`${collection}.${f.slug} takes one entry, not several`);
    }
  };
  check("works", works, WORK_FIELDS);
  check("pages", pagesSchema, PAGE_FIELDS);
  for (const [collection, have, writes] of [
    ["works", works, WORK_FIELDS],
    ["pages", pagesSchema, PAGE_FIELDS],
  ] as const) {
    for (const f of have?.item.fields ?? []) {
      if (f.required && !ALWAYS_FILLED.has(`${collection}.${f.slug}`)) differs.push(`${collection}.${f.slug} is required, and the import may leave it empty`);
      if (f.unique && writes.some((w) => w.slug === f.slug)) differs.push(`${collection}.${f.slug} is unique, and the import may repeat it`);
    }
  }
  for (const f of ["title", "content"]) {
    if (pagesSchema && !pagesSchema.item.fields?.some((x) => x.slug === f)) differs.push(`pages has no ${f} field`);
  }
  if (kind && !kind.taxonomy.collections.includes("works")) differs.push("taxonomy work_kind does not apply to works");
  if (differs.length) throw new Error(`the schema differs from what the import needs: ${differs.join("; ")}`);

  if (!works) {
    await api("POST", "/schema/collections", {
      slug: "works",
      label: "Works",
      labelSingular: "Work",
      description: "Something a club reads, watches or plays.",
      supports: ["drafts", "revisions", "search"],
    });
    report.schema.push("collection works");
  }
  const add = async (collection: string, have: Collection | null, want: Field[]) => {
    for (const f of want) {
      if (have?.item.fields?.some((x) => x.slug === f.slug)) continue;
      await api("POST", `/schema/collections/${collection}/fields`, { validation: null, ...f });
      report.schema.push(`field ${collection}.${f.slug}`);
    }
  };
  await add("works", works, WORK_FIELDS);
  await add("pages", pagesSchema, PAGE_FIELDS.filter((f) => f.slug === "works"));
  if (!kind) {
    await api("POST", "/taxonomies", { name: "work_kind", label: "Kinds", labelSingular: "Kind", collections: ["works"] });
    report.schema.push("taxonomy work_kind");
  }
  if (!tag) {
    await api("POST", "/taxonomies", { name: "tag", label: "Tags", labelSingular: "Tag", collections: ["pages"] });
    report.schema.push("taxonomy tag");
  } else if (!tag.taxonomy.collections.includes("pages")) {
    await api("PUT", "/taxonomies/tag", { collections: [...tag.taxonomy.collections, "pages"] });
    report.schema.push("tag taxonomy on pages");
  }
}
const kinds = args["dry-run"] ? new Map(WORK_KINDS.map((k) => [k, k])) : await ensureTerms("work_kind", WORK_KINDS);

type Entry = { id: string; slug: string | null; status: string; authorId: string | null; data?: { title?: string; creators?: string } };
/** Every entry in a collection. */
const listAll = (collection: string) => (args["dry-run"] ? Promise.resolve([]) : all<Entry>(`/content/${collection}?limit=100`));
const existing = new Map((await listAll("pages")).flatMap((e) => (e.slug ? [[e.slug, e] as const] : [])));

// Works by title and creators, so a book in two lists is one entry, and a
// re-run reuses them, publishing any a broken run left unpublished.
const workIds = new Map<string, string>();
const unpublishedWorks = new Set<string>();
for (const w of await listAll("works")) {
  if (!w.data?.title) continue;
  workIds.set(workKey(w.data.title, w.data.creators), w.id);
  if (w.status !== "published") unpublishedWorks.add(w.id);
}
/** The first work seen under each title, to report a title shared by different works. */
const firstByTitle = new Map<string, string>();
const reportedPairs = new Set<string>();

/** The works entry for a book, created and published the first time it is seen. */
async function ensureWork(listed: Work) {
  const key = workKey(listed.title, listed.creators);
  const work = mergedWorks.get(key) ?? listed;
  const titleKey = workKey(work.title);
  const first = firstByTitle.get(titleKey) ?? key;
  firstByTitle.set(titleKey, first);
  if (first !== key && !reportedPairs.has(key)) {
    reportedPairs.add(key);
    report.warnings.push(`works: two works titled "${work.title}", with different creators`);
  }
  const known = workIds.get(key);
  if (known) {
    if (unpublishedWorks.delete(known)) {
      await api("POST", `/content/works/${known}/publish`);
      report.works.published++;
    }
    if (!report.works.created.includes(work.title)) report.works.existing++;
    return known;
  }
  let cover: Record<string, unknown> | undefined;
  if (work.cover) {
    try {
      const m = await upload(work.cover.src);
      cover = coverField(m, work.cover.alt);
    } catch (e) {
      report.warnings.push(`works: cover for "${work.title}" not imported (${(e as Error).message})`);
    }
  }
  report.works.created.push(work.title);
  if (args["dry-run"]) {
    workIds.set(key, key);
    return key;
  }
  const { item } = await api<{ item: { id: string } }>("POST", "/content/works", {
    data: {
      title: work.title,
      ...(work.creators && { creators: work.creators }),
      ...(cover && { cover }),
      ...(work.link && { link: work.link }),
      ...(work.description && { description: work.description }),
    },
    taxonomies: { work_kind: [kinds.get("book")] },
  });
  await api("POST", `/content/works/${item.id}/publish`);
  workIds.set(key, item.id);
  return item.id;
}

for (const page of pages) {
  const { path, created, tags } = page.meta;
  const draft = DRAFTS.includes(path);
  const owner = owners[path] && ownerIds.get(owners[path]);
  const entry = existing.get(path);
  if (entry) {
    report.existing.push(path);
    if (owner && entry.authorId !== owner) {
      await api("PUT", `/content/pages/${entry.id}`, { authorId: owner });
      report.reassigned++;
    }
    if (!draft && entry.status !== "published") {
      await api("POST", `/content/pages/${entry.id}/publish`, { publishedAt: created });
      report.published++;
    }
    continue;
  }
  const shaped = prepared.get(path)!;
  report.warnings.push(...shaped.warnings.map((w) => `${path}: ${w}`));
  if (!shaped.title) report.warnings.push(`${path}: no top heading; the wiki's title is kept`);
  const content = await resolveMedia(shaped.blocks, page.file);
  const works: string[] = [];
  for (const work of shaped.works) {
    const id = await ensureWork(work);
    if (!works.includes(id)) works.push(id);
  }
  const tagSlugs = tags?.length && !args["dry-run"] ? await ensureTerms("tag", tags) : new Map<string, string>();
  report.pages++;
  report[draft ? "drafts" : "published"]++;
  if (owner && owner !== me.id) report.reassigned++;
  if (args["dry-run"]) continue;

  const { item } = await api<{ item: { id: string } }>("POST", "/content/pages", {
    data: { title: shaped.title ?? page.meta.title, content },
    slug: path,
    createdAt: created,
    ...(tags?.length && { taxonomies: { tag: tags.map((t) => tagSlugs.get(t)) } }),
    ...(works.length && { references: { works } }),
  });
  if (owner && owner !== me.id) await api("PUT", `/content/pages/${item.id}`, { authorId: owner });
  if (!draft) await api("POST", `/content/pages/${item.id}/publish`, { publishedAt: created });
}

// A draft stub for each page the wiki linked to but never had, left unpublished.
for (const path of [...unwritten].sort()) {
  if (existing.has(path)) continue;
  const title = path.split("/").pop()!.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  report.stubs.push(path);
  if (args["dry-run"]) continue;
  await api("POST", "/content/pages", {
    data: {
      title,
      content: [
        { _type: "block", _key: "stub", style: "normal", markDefs: [], children: [{ _type: "span", _key: "stubs", text: "This page is still to be written.", marks: [] }] },
      ],
    },
    slug: path,
  });
}

console.log(JSON.stringify(report, null, 2));
