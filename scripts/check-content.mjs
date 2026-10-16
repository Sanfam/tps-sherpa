/**
 * Validates the content the bot writes.
 *
 * Unit tests cover the code that produces the Catalog; nothing covers the
 * artifact itself once it is on disk. A truncated write, a bad merge or a
 * hand-edit would otherwise reach the site unchallenged.
 */
import { readFileSync } from "node:fs";
import { parseVocabulary } from "../apps/bot/src/llm/vocabulary.ts";

const problems = [];
// `undefined` means unreadable (already reported) or optional and absent, so
// a file that parses to literal `null` still fails as "not an array".
const read = (path, { optional = false } = {}) => {
  try {
    return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  } catch (error) {
    if (!(optional && error.code === "ENOENT")) problems.push(`${path}: ${error.message}`);
    return undefined;
  }
};

// Both are sync output, untracked since ADR-0001 (#26), so CI has neither;
// checked wherever a sync has written them.
const catalog = read("content/index/data.json", { optional: true });
const roles = read("content/config/roles.json", { optional: true });
// One sync writes both, so exactly one on disk is a half-written generation.
if ((catalog === undefined) !== (roles === undefined) && !problems.length)
  problems.push("Only one of the Catalog and the role manifest is on disk");
// Committed and required: classification refuses to run without it, and on a
// clean checkout it is the only content there is to check. Validated by the
// bot's own parser, so CI and the enrichment run cannot disagree on what a
// valid vocabulary is.
let knownTopics = null;
try {
  const { topics } = parseVocabulary(
    readFileSync(new URL("../content/config/topics.json", import.meta.url), "utf8"),
  );
  knownTopics = new Set(topics.map((t) => t.slug));
} catch (error) {
  problems.push(`content/config/topics.json: ${error.message}`);
}

if (Array.isArray(catalog)) {
  const seen = new Set();
  const statuses = new Set(["present", "absent", "withheld"]);
  const types = new Set(["channel", "forum", "post", "thread"]);
  const threadStates = new Set(["open", "closed", "locked"]);
  for (const e of catalog) {
    if (!/^\d{17,20}$/.test(e?.id ?? "")) problems.push(`Entity with a bad id: ${JSON.stringify(e?.id)}`);
    if (seen.has(e.id)) problems.push(`Duplicate Entity id: ${e.id}`);
    seen.add(e.id);
    if (!types.has(e.type)) problems.push(`${e.id}: unknown type ${e.type}`);
    if (!statuses.has(e.description_status))
      problems.push(`${e.id}: unknown description_status ${e.description_status}`);
    // withheld means deliberately listed without content. A topic here would
    // mean content leaked past the privacy boundary.
    if (e.description_status === "withheld" && e.topic !== null)
      problems.push(`${e.id}: withheld but carries a topic`);
    if (!e.url?.endsWith(`/${e.id}`)) problems.push(`${e.id}: url does not end in its own id`);
    // Platform tags are published as mod-authored names. A snowflake here is
    // the old script's defect wearing a new hat, and it reaches the page.
    if (e.applied_tags?.some((t) => /^\d{17,20}$/.test(t)))
      problems.push(`${e.id}: applied_tags contains a raw Discord id`);
    if (!Array.isArray(e.region) || e.region.some((r) => typeof r !== "string"))
      problems.push(`${e.id}: region is not an array of names`);
    if (!Array.isArray(e.topics) || e.topics.some((t) => typeof t !== "string"))
      problems.push(`${e.id}: topics is not an array of vocabulary slugs`);
    // Unknown tags are skipped and logged, never created — a standing
    // anti-goal. The classifier enforces it per call; this enforces it on the
    // artifact, which is what a hand-edit or a bad merge would get past.
    if (knownTopics)
      for (const t of e.topics ?? [])
        if (!knownTopics.has(t))
          problems.push(`${e.id}: topic "${t}" is not in the frozen vocabulary`);
    if (e.topics_version !== null && !Number.isInteger(e.topics_version))
      problems.push(`${e.id}: topics_version is neither null nor an integer`);
    // Tags with no version cannot be retagged on a bump, because nothing can
    // tell they are stale.
    if (e.topics?.length && e.topics_version === null)
      problems.push(`${e.id}: carries topics but no vocabulary version`);
    // Open, closed or locked for a Post or Thread; null for the containers,
    // which have no such state. Mechanical, from the last sync.
    const threadLike = e.type === "post" || e.type === "thread";
    if (threadLike ? !threadStates.has(e.thread_state) : e.thread_state !== null)
      problems.push(`${e.id}: thread_state ${JSON.stringify(e.thread_state)} is not valid for a ${e.type}`);
    if (e.summary_generated !== null && typeof e.summary_generated !== "string")
      problems.push(`${e.id}: summary_generated is neither null nor a string`);
    // Human-authored and carried forward by every sync; see parsePrevious.
    if (e.summary_override !== null && typeof e.summary_override !== "string")
      problems.push(`${e.id}: summary_override is neither null nor a string`);
  }
  // Sorted by id, so a re-run produces no diff. An unsorted Catalog means
  // something wrote it by hand.
  // An established Catalog is never empty; the next sync would refuse it.
  if (catalog.length === 0) problems.push("Catalog is empty");
  const sorted = [...catalog].map((e) => e.id).sort();
  if (JSON.stringify(sorted) !== JSON.stringify(catalog.map((e) => e.id)))
    problems.push("Catalog is not sorted by id");
} else if (catalog !== undefined) {
  problems.push("content/index/data.json is not an array");
}

if (Array.isArray(roles)) {
  for (const r of roles) {
    if (typeof r?.name !== "string" || !Array.isArray(r?.ids))
      problems.push(`Role manifest entry is malformed: ${JSON.stringify(r)}`);
    if (r?.ids?.some((id) => !/^\d{17,20}$/.test(id)))
      problems.push(`Role "${r.name}" has a bad id`);
  }
} else if (roles !== undefined) {
  problems.push("content/config/roles.json is not an array");
}

if (problems.length) {
  console.error(`Content check failed (${problems.length}):`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `Content OK: ${knownTopics.size} Topics, ${catalog ? `${catalog.length} Entities` : "no Catalog on disk"}, ` +
    `${roles ? `${roles.length} role manifest entries` : "no role manifest on disk"}.`,
);
