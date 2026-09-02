/**
 * Compares the Catalog against the wiki page this project replaces.
 *
 *   node src/sync/coverage-report.ts
 *
 * Deliberately standalone. The old page is a **soft reference**, not a
 * specification: it is two years stale, its script went offline, and gating a
 * build on it would let a dead artifact hold the Catalog back. Run it when you
 * want the comparison; nothing runs it for you.
 */
import { REST } from "@discordjs/rest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Entity } from "./catalog.ts";
import { compareCoverage, parseOldIndex } from "./coverage.ts";
import { parseExclusions } from "./exclusions.ts";

const root = (rel: string) => resolve(import.meta.dirname, "../../../..", rel);
const read = (rel: string) => readFileSync(root(rel), "utf8");

const baseline = parseOldIndex(read("docs/reference/old-index.md"));
const catalog: Entity[] = JSON.parse(read("content/index/data.json"));
const excluded = parseExclusions(
  (() => {
    try {
      return read("content/config/index-flags.json");
    } catch {
      return null;
    }
  })(),
);
const channels: Array<{ id: string; visible: boolean }> = JSON.parse(
  read("apps/bot/src/sync/__fixtures__/guild-channels.json"),
);
const invisible = new Set(
  channels.filter((c) => !c.visible).map((c) => c.id),
);

const report = compareCoverage(baseline, catalog, { excluded, invisible });
const byReason = report.missing.reduce<Record<string, number>>((acc, m) => {
  acc[m.reason] = (acc[m.reason] ?? 0) + 1;
  return acc;
}, {});

console.log("Catalog vs. the old wiki index (soft reference, not a gate)\n");
console.log(`  old page Entities : ${report.baselineCount}`);
console.log(`  Catalog Entities  : ${report.catalogCount}`);
console.log(`  still covered     : ${report.covered.length}`);
console.log(
  `  ADDED             : ${report.added.length}  ← Entities the old script never listed`,
);
console.log(`  no longer present : ${report.missing.length}`);
for (const [reason, count] of Object.entries(byReason))
  console.log(`      ${reason.padEnd(14)}: ${count}`);

// "Unexplained" is only unexplained until you ask. There are a handful of
// these, this report runs on demand, so the calls are free in practice.
const unexplained = report.missing.filter((m) => m.reason === "unexplained");
if (unexplained.length) {
  const token = process.env["DISCORD_BOT_TOKEN"];
  const rest = token
    ? new REST({ version: "10" }).setToken(token)
    : null;
  const gone: string[] = [];
  const stillThere: string[] = [];
  for (const m of unexplained) {
    if (!rest) continue;
    try {
      await rest.get(`/channels/${m.id}` as never);
      stillThere.push(`${m.id}  ${m.name}`);
    } catch (error) {
      // 10003 Unknown Channel: deleted from Discord since the page was written.
      if ((error as { code?: number }).code === 10003) gone.push(`${m.id}  ${m.name}`);
      else stillThere.push(`${m.id}  ${m.name} (check failed)`);
    }
  }
  if (!rest)
    console.log(
      `\n  Unexplained (${unexplained.length}) — set DISCORD_BOT_TOKEN to check whether they still exist.`,
    );
  if (gone.length) {
    console.log(`\n  Deleted from Discord since (${gone.length}) — expected:`);
    for (const g of gone) console.log(`      ${g}`);
  }
  if (stillThere.length) {
    console.log(
      `\n  ⚠️  Still exist but absent from the Catalog (${stillThere.length}) — worth investigating:`,
    );
    for (const g of stillThere) console.log(`      ${g}`);
  }
}

const undescribed = baseline.filter((b) => !b.hasDescription).length;
console.log(
  `\n  The old page itself had ${undescribed} entries with no description at all.`,
);
