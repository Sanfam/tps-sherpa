/**
 * The sync entry point. Reads the guild, builds the Catalog, and replaces the
 * current generation in the bot's durable store (ADR-0001).
 *
 *   node --env-file=.env src/sync/run.ts
 *
 * The store must exist: see `init-store.ts`. An incomplete sync leaves the
 * previous generation in place and exits non-zero (#28).
 *
 * A complete sync also exports `content/index/data.json` and
 * `content/config/roles.json`, gitignored (#26), for a human to read and for
 * `scripts/check-content.mjs`. They are derived output: nothing reads them
 * back as the previous Catalog.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildCatalog } from "./catalog.ts";
import { discordRest } from "./discord-adapter.ts";
import { DURABLE_STORE_PATH, openDurableStore } from "./durable-store.ts";
import { activityBucket, parseGazetteer } from "./facets.ts";

const token = process.env["DISCORD_BOT_TOKEN"];
const guildId = process.env["DISCORD_GUILD_ID"];
if (!token || !guildId) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must both be set.");
  process.exit(1);
}

const contentPath = (rel: string) =>
  resolve(import.meta.dirname, "../../../../content", rel);
const CATALOG_PATH = contentPath("index/data.json");
const ROLES_PATH = contentPath("config/roles.json");
const REGIONS_PATH = contentPath("config/regions.json");

// Opened first: a missing or unseeded store refuses before Discord is read.
const store = openDurableStore();
const current = store.current();
// Empty only before the first complete sync, which the marker vouches for.
const previous = current?.catalog ?? [];
const exclusions = store.exclusions();
// A missing gazetteer means no Region facet — an empty facet, not a wrong one.
// Any OTHER read failure must still throw: silently emptying every Region on a
// permissions error would rewrite the Catalog and look like a clean run.
const regions = parseGazetteer(
  await readFile(REGIONS_PATH, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  }),
);
const warn = (m: string) => console.warn(m);
const { catalog, roleManifest, exclusionsApplied, outcome } = await buildCatalog({
  discord: discordRest({ token, guildId, warn }),
  guildId,
  previous,
  exclusions,
  regions,
  warn,
});

if (!outcome.complete) {
  console.error(
    `Sync incomplete: ${outcome.failed.length} container(s) could not be fully listed. ` +
      `The previous generation${current ? ` (${current.generatedAt})` : ""} is kept, overrides included.`,
  );
  for (const f of outcome.failed) console.error(`    ${f.id}  ${f.reason}`);
  store.close();
  process.exit(1);
}

const unchanged =
  JSON.stringify(catalog) === JSON.stringify(previous) &&
  JSON.stringify(roleManifest) === JSON.stringify(current?.roleManifest ?? []);
store.replaceCatalog({ catalog, roleManifest, outcome });
store.close();

const exportJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
};
await exportJson(CATALOG_PATH, catalog);
await exportJson(ROLES_PATH, roleManifest);


const byStatus = catalog.reduce<Record<string, number>>((acc, e) => {
  acc[e.description_status] = (acc[e.description_status] ?? 0) + 1;
  return acc;
}, {});

console.log(`Store:   ${DURABLE_STORE_PATH}`);
console.log(`Exports: ${CATALOG_PATH}, ${ROLES_PATH} (${roleManifest.length} roles)`);
console.log(`  Entities:  ${catalog.length}`);
console.log(`  present:   ${byStatus["present"] ?? 0}`);
console.log(`  absent:    ${byStatus["absent"] ?? 0}`);
console.log(`  withheld:  ${byStatus["withheld"] ?? 0}`);
// Applied, not configured: a stale or mistyped ID would otherwise read as a
// working exclusion while the Entity keeps publishing.
console.log(
  `  excluded by config: ${exclusionsApplied.length} applied of ${exclusions.size} configured`,
);
for (const id of [...exclusions].filter((id) => !exclusionsApplied.includes(id)))
  console.warn(`[exclusions] configured id ${id} matched no Entity.`);
const activity = catalog.reduce<Record<string, number>>((acc, e) => {
  const bucket = activityBucket(e.last_activity_at) ?? "never posted";
  acc[bucket] = (acc[bucket] ?? 0) + 1;
  return acc;
}, {});
// Derived on read, never stored: an Entity crossing a threshold is the clock
// moving, not the Catalog changing, and writing it would churn every commit.
console.log(`  activity:  ${Object.entries(activity).map(([k, n]) => `${k} ${n}`).join(", ")}`);
console.log(`  regions:   ${catalog.filter((e) => e.region.length).length} Entities matched`);
console.log(`  platform:  ${catalog.filter((e) => e.applied_tags.length).length} Entities tagged`);
console.log(`  overrides carried forward: ${catalog.filter((e) => e.summary_override).length}`);
console.log(unchanged ? "  UNCHANGED from the previous generation" : "  changed");
