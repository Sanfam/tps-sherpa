/**
 * Tier 0 capture. Run after a sync:
 *
 *   node --env-file=.env src/sync/capture.ts
 *
 * Incremental: an Entity whose newest message has not moved is skipped, so the
 * first run is expensive and every run after it is nearly free. `--full`
 * recaptures everything, for when what capture records has changed — rows
 * stored before webhooks were flagged would otherwise keep them as members.
 *
 * **The store is a disposable cache.** Nothing here is backed up. If the volume
 * is lost, delete nothing and re-run — the rebuild path is this command.
 *
 * Messages from a member who has turned processing off are never stored. The
 * opt-outs are read again for every Entity (`captureEach`), and the purge
 * sweeps anything stored in the moment before one was recorded.
 *
 * A pending `/privacy backfill` makes the run recapture every Entity active
 * within the retention window, and is cleared when that run ends; an Entity
 * that failed in it has its cursor dropped, so the next run captures it
 * afresh. Monitored channels are read from the durable store, and a missing
 * one stops the run before Discord is read.
 */
import { discordRest } from "./discord-adapter.ts";
import { readCurrent, readMonitored, readProcessingOptOuts, withDurableStore } from "./durable-store.ts";
import { RETAIN_MS, TIER0_PATH, openTier0 } from "./tier0-store.ts";
import { GLOBAL_REQUEST_CEILING, captureEach, projectedCalls, selectForCapture } from "./tier0.ts";

const token = process.env["DISCORD_BOT_TOKEN"];
const guildId = process.env["DISCORD_GUILD_ID"];
if (!token || !guildId) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must both be set.");
  process.exit(1);
}

const { catalog } = readCurrent();
// Throws, so nothing is captured, if a monitored channel is missing from the
// Catalog: its Threads could not be told apart from anyone else's (#33).
const monitored = readMonitored(catalog);
// Read once, at the start: only these are cleared at the end.
const backfills = withDurableStore((s) => s.pendingBackfills());

const store = openTier0(TIER0_PATH);
const discord = discordRest({ token, guildId });

const decision = selectForCapture(catalog, process.argv.includes("--full") ? new Map() : store.state(), {
  monitored,
  // A backfill re-reads every Entity that may hold a message young enough to
  // keep, whether or not it moved, so a member who opted back in is read again.
  ...(backfills.length ? { recaptureSince: new Date(Date.now() - RETAIN_MS) } : {}),
});
if (backfills.length) console.log(`Backfills requested    : ${backfills.length} (recapturing the last ${RETAIN_MS / 86_400_000} days)`);
console.log(`Catalog Entities        : ${catalog.length}`);
console.log(`  Forums (no own content): ${decision.skippedNoOwnContent}`);
console.log(`  monitored channels     : ${decision.skippedMonitored} (extract-and-discard — never stored)`);
// Not printed as assurance: this counter is defence in depth and reads 0 in
// practice. The real protection is that buildCatalog never enumerates threads
// inside a container whose content is withheld.
if (decision.skippedWithheld > 0)
  console.log(`  withheld              : ${decision.skippedWithheld}`);
console.log(`  unchanged since last  : ${decision.skippedUnchanged}`);
console.log(`  to capture            : ${decision.capture.length}`);

const projected = projectedCalls(decision.capture.length);
console.log(
  `\nProjected API calls     : ${projected} (${((projected / GLOBAL_REQUEST_CEILING) * 100).toFixed(1)}% of the 10,000-per-10-minutes ceiling)`,
);
if (projected > GLOBAL_REQUEST_CEILING)
  console.warn(
    `[tier0] ${projected} calls exceeds the 10,000-per-10-minutes ceiling in a single burst. ` +
      `discord.js paces requests, so this will simply take longer than ten minutes.`,
  );

const { done, calls, failed } = await captureEach({
  entities: decision.capture,
  fetch: (id) => discord.captureWindows(id),
  store,
  optedOut: () => readProcessingOptOuts(),
  progress: (n) => {
    if (n % 200 === 0) console.log(`  … ${n}/${decision.capture.length}`);
  },
});
if (failed.length) {
  console.warn(`\n[tier0] ${failed.length} Entities could not be captured:`);
  for (const f of failed.slice(0, 20)) console.warn(`    ${f.id}  ${f.name}  (${f.error})`);
  if (failed.length > 20) console.warn(`    … and ${failed.length - 20} more`);
}

const stats = store.stats();
console.log(`\nCaptured                : ${done} Entities, ${calls} API calls`);
console.log(`Store                   : ${stats.entities} Entities, ${stats.messages} messages`);
console.log(
  `Content footprint       : ${(stats.contentBytes / 1024 / 1024).toFixed(2)} MB of message text`,
);
console.log(`Path                    : ${TIER0_PATH}  (disposable — re-run to rebuild)`);
if (failed.length) console.log(`Failed                  : ${failed.length} (re-run to retry — they were not recorded)`);
// Cleared once the run has finished, failures or not: holding a request for
// one Entity that always fails would recapture six days every cycle. But a
// backfill selects Entities that have not moved, whose cursor would skip them
// next run, so a failed one's cursor (and anything held for it) is dropped
// first: the next run captures it like a new Entity.
if (backfills.length) {
  store.deleteEntities(failed.map((f) => f.id));
  withDurableStore((s) => s.clearBackfills(backfills));
  console.log(`Backfills done          : ${backfills.length}${failed.length ? ` (${failed.length} failed Entities reset for the next run)` : ""}`);
}
store.close();
