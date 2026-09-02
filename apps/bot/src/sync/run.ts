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

const token = process.env["DISCORD_BOT_TOKEN"];
const guildId = process.env["DISCORD_GUILD_ID"];
if (!token || !guildId) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must both be set.");
  process.exit(1);
}

const CATALOG_PATH = resolve(
  import.meta.dirname,
  "../../../../content/index/data.json",
);

/** Overrides are human-authored and must survive every sync. */
const readPrevious = async (): Promise<Entity[]> => {
  try {
    return JSON.parse(await readFile(CATALOG_PATH, "utf8")) as Entity[];
  } catch {
    return [];
  }
};

const previous = await readPrevious();
const { catalog } = await buildCatalog({
  discord: discordRest({ token, guildId }),
  guildId,
  previous,
});

await mkdir(dirname(CATALOG_PATH), { recursive: true });
const serialised = JSON.stringify(catalog, null, 2) + "\n";
const unchanged = serialised === (await readFile(CATALOG_PATH, "utf8").catch(() => ""));
await writeFile(CATALOG_PATH, serialised);

const byStatus = catalog.reduce<Record<string, number>>((acc, e) => {
  acc[e.description_status] = (acc[e.description_status] ?? 0) + 1;
  return acc;
}, {});

console.log(`Catalog written: ${CATALOG_PATH}`);
console.log(`  Entities:  ${catalog.length}`);
console.log(`  present:   ${byStatus["present"] ?? 0}`);
console.log(`  absent:    ${byStatus["absent"] ?? 0}`);
console.log(`  withheld:  ${byStatus["withheld"] ?? 0}`);
console.log(`  overrides carried forward: ${catalog.filter((e) => e.summary_override).length}`);
console.log(unchanged ? "  UNCHANGED — nothing to commit" : "  changed");
