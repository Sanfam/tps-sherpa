/**
 * Retention for what Sherpa holds of members' words (Staff, 2026-10-15):
 *
 *   node src/sync/purge.ts
 *
 * - **Tier 0 holds no message written more than seven days ago.** Capture
 *   stores nothing older than `RETAIN_MS`; this deletes what has aged past it
 *   since. By when a message was written, not when it was captured — capture
 *   refetches the same windows, so a capture-time clock would never run out on
 *   an old Entity's opening messages. Cursors are kept, so an Entity with
 *   nothing new is not fetched again.
 * - **Nothing from a member with processing off stays.** Capture already
 *   drops them; this sweeps up anything stored by a capture that was running
 *   when they opted out.
 * - **Activity summaries go with their Entity, and with their authors.** An
 *   entry for an Entity that has left the Catalog or is no longer eligible is
 *   dropped, and so is one any of whose authors has turned processing off, or
 *   whose authors are not recorded.
 *
 * Raw text goes first, before the Catalog or activity.json is even parsed: a
 * corrupt file there fails the purge (and so stops the cycle before capture),
 * but never keeps a message past its time.
 *
 * The first step of every cycle in `serve.ts`, ahead of the sync, so a sync
 * that keeps failing cannot hold retention back.
 */
import { keepAttributed, pruneActivity, type ActivityStore } from "../llm/activity.ts";
import { ACTIVITY_PATH, readActivity, writeActivity } from "../llm/session.ts";
import type { Entity } from "./catalog.ts";
import { ACTIVE_WITHIN_DAYS } from "./facets.ts";
import { DURABLE_STORE_PATH, withDurableStore } from "./durable-store.ts";
import { RETAIN_MS, TIER0_PATH, openTier0 } from "./tier0-store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tier 0's half: aged rows, and everything from members with processing off. */
export const purgeTier0 = (deps: {
  tier0: ReturnType<typeof openTier0>;
  optedOut: ReadonlySet<string>;
  now?: Date;
}): { aged: number; swept: number; checkpointed: boolean } => {
  const now = deps.now ?? new Date();
  const aged = deps.tier0.dropWrittenBefore(new Date(now.getTime() - RETAIN_MS).toISOString());
  let swept = 0;
  for (const id of deps.optedOut) swept += deps.tier0.deleteAuthor(id);
  return { aged, swept, checkpointed: deps.tier0.checkpoint() };
};

/** Activity's half. Null Catalog: before the first complete sync, nothing to check Entities against. */
/** When a snowflake was minted: Discord's epoch plus its top 42 bits. Zero if it isn't one. */
export const snowflakeTime = (id: string): number => {
  try {
    return Number(BigInt(id) >> 22n) + 1_420_070_400_000;
  } catch {
    return 0;
  }
};

/**
 * An entry whose newest source is older than `/lately`'s window is expired:
 * nothing can show it, and its `authors` must not outlive their use.
 */
export const purgeActivity = (
  activity: ActivityStore,
  optedOut: ReadonlySet<string>,
  catalog: Entity[] | null,
  now: Date = new Date(),
): { activity: ActivityStore; dropped: number } => {
  const cutoff = now.getTime() - ACTIVE_WITHIN_DAYS * DAY_MS;
  const current = Object.fromEntries(Object.entries(activity).filter(([, e]) => snowflakeTime(e.as_of) >= cutoff));
  const kept = keepAttributed(catalog ? pruneActivity(current, catalog) : current, optedOut);
  return { activity: kept, dropped: Object.keys(activity).length - Object.keys(kept).length };
};

/** The whole purge, in the order that keeps the promise. Throws once raw text is already gone. */
export const runPurge = (
  log: (m: string) => void,
  paths = { durable: DURABLE_STORE_PATH, tier0: TIER0_PATH, activity: ACTIVITY_PATH },
  now?: Date,
): void => {
  const optedOut = withDurableStore((s) => s.processingOptOuts(), paths.durable);

  const tier0 = openTier0(paths.tier0);
  try {
    const result = purgeTier0({ tier0, optedOut, now });
    log(`Tier 0  : ${paths.tier0}`);
    log(`  written over ${RETAIN_MS / DAY_MS} days ago: ${result.aged} messages dropped`);
    log(`  from members with processing off: ${result.swept} messages dropped`);
    if (!result.checkpointed) log("  checkpoint busy; the next purge completes it");
  } finally {
    tier0.close();
  }

  // Not `readCurrent`, which refuses an empty store: a fresh deployment has no
  // Catalog until its first sync, and that sync runs after this.
  const catalog = withDurableStore((s) => s.current()?.catalog ?? null, paths.durable);
  // ponytail: the gateway can edit activity.json for a deletion while this
  // rewrites it, and the later write wins — milliseconds wide. A deletion
  // overwritten here turned processing off, so the next purge (one cycle, six
  // hours) drops the entry; unless the member has opted back in by then, when
  // it stays until the Entity moves. Move activity into tier0.db for a
  // transaction if it ever matters.
  const { activity, dropped } = purgeActivity(readActivity(paths.activity), optedOut, catalog, now);
  if (dropped) writeActivity(activity, paths.activity);
  log(`Activity: ${paths.activity}`);
  log(
    `  ${dropped} entries dropped: expired, Entities gone or no longer eligible${catalog ? "" : " (no Catalog yet, not checked)"}, ` +
      "or an author opted out or unrecorded",
  );
};

if (import.meta.main) runPurge((m) => console.log(m));
