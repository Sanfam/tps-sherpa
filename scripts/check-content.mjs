/**
 * Validates the committed content the bot writes.
 *
 * Unit tests cover the code that produces the Catalog; nothing covers the
 * artifact itself once it is on disk. A truncated write, a bad merge or a
 * hand-edit would otherwise reach the site unchallenged.
 */
import { readFileSync } from "node:fs";

const problems = [];
const read = (path) => {
  try {
    return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  } catch (error) {
    problems.push(`${path}: ${error.message}`);
    return null;
  }
};

const catalog = read("content/index/data.json");
const roles = read("content/config/roles.json");

if (Array.isArray(catalog)) {
  const seen = new Set();
  const statuses = new Set(["present", "absent", "withheld"]);
  const types = new Set(["channel", "forum", "post", "thread"]);
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
  }
  // Sorted by id, so a re-run produces no diff. An unsorted Catalog means
  // something wrote it by hand.
  const sorted = [...catalog].map((e) => e.id).sort();
  if (JSON.stringify(sorted) !== JSON.stringify(catalog.map((e) => e.id)))
    problems.push("Catalog is not sorted by id");
} else if (catalog !== null) {
  problems.push("content/index/data.json is not an array");
}

if (Array.isArray(roles)) {
  for (const r of roles) {
    if (typeof r?.name !== "string" || !Array.isArray(r?.ids))
      problems.push(`Role manifest entry is malformed: ${JSON.stringify(r)}`);
    if (r?.ids?.some((id) => !/^\d{17,20}$/.test(id)))
      problems.push(`Role "${r.name}" has a bad id`);
  }
} else if (roles !== null) {
  problems.push("content/config/roles.json is not an array");
}

if (problems.length) {
  console.error(`Content check failed (${problems.length}):`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `Content OK: ${catalog.length} Entities, ${roles.length} role manifest entries.`,
);
