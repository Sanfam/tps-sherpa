/**
 * Fills the empty fields of the CMS's `works` entries (year, link,
 * description, cover) from Open Library, in two steps with a file an editor
 * reads in between (the owner asked to "enrich the details for the missing
 * books/works"). It never changes a field that has a value.
 *
 * Like import-wiki.ts it goes through EmDash's REST API on a running site,
 * signed in with the site's session cookie, so each fill is an edit EmDash
 * records in the entry's revisions.
 *
 *   SITE_COOKIE='better-auth.session_token=…' node scripts/enrich-works.ts \
 *     --site <origin> --plan <out.json>
 *   SITE_COOKIE='better-auth.session_token=…' node scripts/enrich-works.ts \
 *     --site <origin> --apply <plan.json> [--dry-run]
 *
 * `--site` is https, or http on a loopback host only, since the cookie goes to it.
 *
 * `--plan` lists the works, and for each book-kind entry with an empty field
 * looks its title and creators up on Open Library, about one request a
 * second. It writes the plan file, which must be outside the repository: per
 * work the Open Library work it chose, a confidence, and the values proposed
 * for the fields that are empty, namely the first publish year, the Open
 * Library work page, the first paragraph of Open Library's description (at
 * most about 600 characters) and a cover URL. Works it could not match, and
 * works of another kind, are listed under `unmatched` with the reason;
 * nothing is guessed for them.
 *
 * Read the plan before applying it. `--apply` fills only works whose
 * confidence is `high`: change a `low` one to `high` once you have checked its
 * match, and delete a work, or one of its proposed values, to leave it out.
 * Each work is read again and only fields still empty are set; the cover is
 * uploaded to the media library as the import does. The entry is saved and
 * published. An entry that is unpublished, or has unpublished changes, is
 * left alone, since publishing it would publish an editor's work in progress.
 * `--dry-run` reads the site and fetches the covers but writes nothing.
 */
import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { connect, coverField, fetchImage, inRepository, uploadMedia } from "./emdash-api.ts";
import { workKey } from "./wiki-works.ts";
import { empty, fillable, firstParagraph, people, pickMatch, type Doc, type Entry, type Proposed } from "./enrichment.ts";

// Names the script and nothing about who runs it.
const USER_AGENT = "works-enrich-script/1.0 (catalog metadata lookups; about 1 request a second)";
const OPEN_LIBRARY = "https://openlibrary.org";
const SEARCH_FIELDS = "key,title,subtitle,author_name,first_publish_year,cover_i,edition_count";
const FIELDS = ["year", "link", "description", "cover"] as const;

const { values: args } = parseArgs({
  options: {
    site: { type: "string" },
    plan: { type: "string" },
    apply: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!args.site || !args.plan === !args.apply || (args["dry-run"] && !args.apply)) {
  throw new Error("usage: --site <origin> (--plan <out.json> | --apply <plan.json> [--dry-run])");
}
const cookie = process.env["SITE_COOKIE"];
if (!cookie) throw new Error("SITE_COOKIE is not set");
const { api, all } = connect(args.site, cookie);
const site = new URL(args.site).origin;

type Listed = { id: string; status: string; data?: { title?: string; creators?: string } & Record<string, unknown> };
type Planned = {
  id: string;
  title: string;
  creators?: string;
  confidence: "high" | "low";
  match: { key: string; title: string; authors: string[]; editions?: number };
  propose: Proposed;
};
type Plan = { site: string; works: Planned[]; unmatched: { id: string; title: string; creators?: string; reason: string }[] };

let lastRequest = 0;
/** A GET to Open Library, at most one a second. */
async function openLibrary<T>(url: string): Promise<T> {
  const wait = lastRequest + 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open Library answered ${res.status}`);
  return (await res.json()) as T;
}

const search = async (params: Record<string, string>) =>
  (await openLibrary<{ docs: Doc[] }>(
    `${OPEN_LIBRARY}/search.json?${new URLSearchParams({ ...params, fields: SEARCH_FIELDS, limit: "20" })}`,
  )).docs;

async function plan(out: string) {
  // The plan file names entries and editors' text: never inside the repository.
  const file = join(realpathSync(dirname(out)), basename(out));
  if (inRepository(file)) throw new Error("the plan file must be outside the repository");
  const result: Plan = { site, works: [], unmatched: [] };
  for (const w of await all<Listed>("/content/works?limit=100")) {
    const title = w.data?.title;
    if (!title) continue;
    const creators = w.data?.creators || undefined;
    const missing = FIELDS.filter((f) => empty(w.data?.[f]));
    if (!missing.length) continue;
    const unmatched = (reason: string) => result.unmatched.push({ id: w.id, title, ...(creators && { creators }), reason });
    const { terms } = await api<{ terms: { slug: string; label: string }[] }>("GET", `/content/works/${w.id}/terms/work_kind`);
    if (!terms.some((t) => t.slug === "book" || t.label === "book")) {
      unmatched(`not a book (kind: ${terms.map((t) => t.label).join(", ") || "none"})`);
      continue;
    }
    try {
      const author = creators && people(creators)[0];
      let match = pickMatch(title, creators, await search(author ? { title, author } : { title }));
      // Open Library's author search misses some spellings; the match still checks the creators.
      if ("reason" in match && author) match = pickMatch(title, creators, await search({ title }));
      if ("reason" in match) {
        unmatched(match.reason);
        continue;
      }
      const { doc } = match;
      const propose: Proposed = {};
      if (missing.includes("year") && doc.first_publish_year) propose.year = doc.first_publish_year;
      if (missing.includes("link")) propose.link = `${OPEN_LIBRARY}${doc.key}`;
      let coverId = doc.cover_i;
      if (missing.includes("description") || (missing.includes("cover") && !coverId)) {
        const work = await openLibrary<{ description?: string | { value?: string }; covers?: number[] }>(`${OPEN_LIBRARY}${doc.key}.json`);
        if (missing.includes("description")) propose.description = firstParagraph(work.description);
        coverId ??= work.covers?.find((c) => c > 0);
      }
      if (missing.includes("cover") && coverId) propose.cover = `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
      result.works.push({
        id: w.id,
        title,
        ...(creators && { creators }),
        confidence: match.confidence,
        match: { key: doc.key, title: doc.subtitle ? `${doc.title}: ${doc.subtitle}` : doc.title, authors: doc.author_name ?? [], editions: doc.edition_count },
        propose,
      });
    } catch (e) {
      unmatched(`lookup failed: ${(e as Error).message}`);
    }
  }
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  const low = result.works.filter((w) => w.confidence === "low").length;
  console.log(JSON.stringify({ plan: file, high: result.works.length - low, low, unmatched: result.unmatched.length }, null, 2));
}

async function apply(from: string) {
  const given = JSON.parse(readFileSync(from, "utf8")) as Plan;
  if (given.site !== site) throw new Error(`the plan was made for ${given.site}, not ${site}`);
  const report = { filled: [] as string[], skipped: [] as string[], failed: [] as string[], warnings: [] as string[] };
  for (const w of given.works) {
    if (w.confidence !== "high") continue;
    const p: Proposed = w.propose;
    if (p.year !== undefined && !Number.isInteger(p.year)) throw new Error(`"${w.title}": year is not a whole number`);
    for (const url of [p.link, p.cover]) {
      if (url !== undefined && new URL(url).protocol !== "https:") throw new Error(`"${w.title}": not an https URL: ${url}`);
    }
    if (p.description !== undefined && typeof p.description !== "string") throw new Error(`"${w.title}": description is not text`);

    const { item, _rev } = await api<{ item: Entry; _rev: string }>("GET", `/content/works/${encodeURIComponent(w.id)}`);
    // The plan was made for this title and these creators: an entry renamed since gets nothing.
    if (workKey(String(item.data["title"] ?? ""), item.data["creators"] as string | undefined) !== workKey(w.title, w.creators)) {
      report.skipped.push(`${w.title}: the entry's title or creators changed since the plan`);
      continue;
    }
    const verdict = fillable(item, p);
    if ("skip" in verdict) {
      report.skipped.push(`${w.title}: ${verdict.skip}`);
      continue;
    }
    const data: Record<string, unknown> = {};
    for (const field of verdict.fill) {
      if (field !== "cover") {
        data[field] = p[field];
        continue;
      }
      try {
        const { bytes, type } = await fetchImage(p.cover!);
        if (args["dry-run"]) data["cover"] = p.cover;
        else {
          const m = await uploadMedia(api, bytes, basename(new URL(p.cover!).pathname), type);
          data["cover"] = coverField(m, `${w.title}${w.creators ? ` by ${w.creators}` : ""} (book cover)`);
        }
      } catch (e) {
        report.warnings.push(`${w.title}: cover not fetched (${(e as Error).message})`);
      }
    }
    const fields = Object.keys(data);
    if (!fields.length) {
      report.skipped.push(`${w.title}: no proposed field is empty`);
      continue;
    }
    if (args["dry-run"]) {
      report.filled.push(`${w.title}: ${fields.join(", ")}`);
      continue;
    }
    // `_rev` makes the save fail if anyone saved the entry since it was read,
    // and the publish fail if anyone saved since the fill, so it never promotes their draft.
    let saved: { _rev: string };
    try {
      saved = await api<{ _rev: string }>("PUT", `/content/works/${encodeURIComponent(w.id)}`, { data, _rev });
    } catch (e) {
      report.failed.push(`${w.title}: not saved (${(e as Error).message})`);
      continue;
    }
    try {
      await api("POST", `/content/works/${encodeURIComponent(w.id)}/publish`, { _rev: saved._rev });
    } catch (e) {
      // The fill waits as a draft: publish it in the CMS, since a re-run leaves the entry alone.
      report.failed.push(`${w.title}: saved, not published (${(e as Error).message})`);
      continue;
    }
    report.filled.push(`${w.title}: ${fields.join(", ")}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (args.plan) await plan(args.plan);
else await apply(args.apply!);
