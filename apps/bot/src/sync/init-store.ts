/**
 * First initialisation of the bot's durable store. Run once, ever:
 *
 *   node src/sync/init-store.ts
 *
 * Refuses if the store already exists. Imports the exclusion seed from
 * `content/config/index-flags.json` — the only time that file is read — and,
 * if a local sync left one, migrates `content/index/data.json` with its role
 * manifest, so generated summaries and overrides are not lost. A file that is
 * present but invalid aborts the whole thing and leaves no store behind.
 *
 * `BOT_DB_PATH` overrides where the store goes, as it does everywhere else.
 */
import { readFileSync, statSync } from "node:fs";
import { contentPath, readIfPresent } from "../llm/session.ts";
import { DURABLE_STORE_PATH, initDurableStore } from "./durable-store.ts";

const CATALOG_PATH = contentPath("index/data.json");

const catalog = readIfPresent(CATALOG_PATH);
const { exclusions, entities } = initDurableStore(DURABLE_STORE_PATH, {
  // Missing means "exclude nothing" here, and only here.
  exclusionSeed: readIfPresent(contentPath("config/index-flags.json")),
  catalog,
  roleManifest: catalog === null ? null : readFileSync(contentPath("config/roles.json"), "utf8"),
  catalogGeneratedAt: catalog === null ? undefined : statSync(CATALOG_PATH).mtime.toISOString(),
});

console.log(`Initialised ${DURABLE_STORE_PATH}`);
console.log(`  exclusions: ${exclusions} from the seed`);
console.log(
  entities
    ? `  Catalog:    ${entities} Entities migrated from ${CATALOG_PATH}`
    : "  Catalog:    none yet; the first sync writes it",
);
