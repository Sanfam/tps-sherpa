/**
 * The sync entry point. Reads the guild, builds the Catalog, writes it into
 * the repository.
 *
 *   node --env-file=.env src/sync/run.ts
 *
 * Committing is deliberately not done here — see #10. This writes files; CI
 * and the scheduled job decide what happens to them.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildCatalog, type Entity } from "./catalog.ts";
import { discordRest } from "./discord-adapter.ts";
import { parseExclusions } from "./exclusions.ts";
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
const EXCLUSIONS_PATH = contentPath("config/index-flags.json");
const REGIONS_PATH = contentPath("config/regions.json");

/** Overrides are human-authored and must survive every sync. */
const readPrevious = async (): Promise<Entity[]> => {
  try {
    return JSON.parse(await readFile(CATALOG_PATH, "utf8")) as Entity[];
  } catch {
    return [];
  }
};

const previous = await readPrevious();
// A missing file means no exclusions. Any OTHER read failure must not be
// swallowed: silently becoming "exclude nothing" would republish exactly what
// the file exists to hide.
const exclusionSource = await readFile(EXCLUSIONS_PATH, "utf8").catch(
  (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  },
);
const exclusions = parseExclusions(exclusionSource);
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
const { catalog, roleManifest, exclusionsApplied } = await buildCatalog({
  discord: discordRest({ token, guildId, warn }),
  guildId,
  previous,
  exclusions,
  regions,
  warn,
});

/** Returns true if the file already held exactly this content. */
const writeIfChanged = async (path: string, value: unknown): Promise<boolean> => {
  await mkdir(dirname(path), { recursive: true });
  const serialised = JSON.stringify(value, null, 2) + "\n";
  const before = await readFile(path, "utf8").catch(() => "");
  if (serialised === before) return true;
  await writeFile(path, serialised);
  return false;
};

const catalogUnchanged = await writeIfChanged(CATALOG_PATH, catalog);
const rolesUnchanged = await writeIfChanged(ROLES_PATH, roleManifest);
const unchanged = catalogUnchanged && rolesUnchanged;

const byStatus = catalog.reduce<Record<string, number>>((acc, e) => {
  acc[e.description_status] = (acc[e.description_status] ?? 0) + 1;
  return acc;
}, {});

console.log(`Catalog: ${CATALOG_PATH}`);
console.log(`Roles:   ${ROLES_PATH} (${roleManifest.length} roles)`);
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
console.log(unchanged ? "  UNCHANGED — nothing to commit" : "  changed");
