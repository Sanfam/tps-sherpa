/**
 * Tier 0 capture. Run after a sync:
 *
 *   node --env-file=.env src/sync/capture.ts
 *
 * Incremental: an Entity whose newest message has not moved is skipped, so the
 * first run is expensive and every run after it is nearly free.
 *
 * **The store is a disposable cache.** Nothing here is backed up. If the volume
 * is lost, delete nothing and re-run — the rebuild path is this command.
 */
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Entity } from "./catalog.ts";
import { discordRest } from "./discord-adapter.ts";
import { openTier0, type StoredMessage } from "./tier0-store.ts";
import { GLOBAL_REQUEST_CEILING, projectedCalls, selectForCapture } from "./tier0.ts";

const token = process.env["DISCORD_BOT_TOKEN"];
const guildId = process.env["DISCORD_GUILD_ID"];
if (!token || !guildId) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must both be set.");
  process.exit(1);
}

const root = (rel: string) => resolve(import.meta.dirname, "../../../..", rel);
const catalog: Entity[] = JSON.parse(
  readFileSync(root("content/index/data.json"), "utf8"),
);

const dbPath = process.env["TIER0_PATH"] ?? resolve(import.meta.dirname, "../../.data/tier0.db");
mkdirSync(dirname(dbPath), { recursive: true });
const store = openTier0(dbPath);
const discord = discordRest({ token, guildId });

const decision = selectForCapture(catalog, store.state());
console.log(`Catalog Entities        : ${catalog.length}`);
console.log(`  not thread content    : ${decision.skippedNotThreadContent} (Channels and Forums — topic is their description)`);
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

let calls = 0;
let done = 0;
const failed: Array<{ id: string; name: string; error: string }> = [];

try {
  for (const entity of decision.capture) {
    // One Entity failing must not abort the crawl. A single 50001 used to kill
    // the whole ~1,200-Entity run, and because the failing Entity was never
    // recorded, every retry died in the same place.
    try {
      const raw = await discord.captureWindows(entity.id);
      calls += 2;
      const messages: StoredMessage[] = raw.map((m) => ({
        entityId: entity.id,
        messageId: m.id,
        authorId: m.authorId,
        authorIsBot: m.authorIsBot,
        content: m.content,
        createdAt: m.createdAt,
        window: m.window,
      }));
      store.record(entity.id, entity.last_message_id, messages);
      done++;
    } catch (error) {
      calls += 2;
      failed.push({
        id: entity.id,
        name: entity.name,
        error: `${(error as { status?: number }).status ?? "?"} ${(error as { code?: number }).code ?? ""}`.trim(),
      });
    }
    if ((done + failed.length) % 200 === 0)
      console.log(`  … ${done + failed.length}/${decision.capture.length}`);
  }
} finally {
  // Reported before the store closes, so a crash still leaves the numbers.
  if (failed.length) {
    console.warn(`\n[tier0] ${failed.length} Entities could not be captured:`);
    for (const f of failed.slice(0, 20))
      console.warn(`    ${f.id}  ${f.name}  (${f.error})`);
    if (failed.length > 20) console.warn(`    … and ${failed.length - 20} more`);
  }
}

const stats = store.stats();
console.log(`\nCaptured                : ${done} Entities, ${calls} API calls`);
console.log(`Store                   : ${stats.entities} Entities, ${stats.messages} messages`);
console.log(
  `Content footprint       : ${(stats.contentBytes / 1024 / 1024).toFixed(2)} MB of message text`,
);
console.log(`Path                    : ${dbPath}  (disposable — re-run to rebuild)`);
if (failed.length) console.log(`Failed                  : ${failed.length} (re-run to retry — they were not recorded)`);
store.close();
