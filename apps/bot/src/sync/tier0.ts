/**
 * Tier 0: raw message text kept bot-side so the corpus can be reprocessed
 * without touching Discord again.
 *
 * This is the piece that decouples "regenerate the corpus" from "hit the API".
 * Every prompt revision, tag-vocabulary bump or model change would otherwise
 * cost a full crawl.
 *
 * **It is a cache, not durable state.** The volume is disposable and nothing
 * here is replicated: losing it costs one re-run. Replicating raw
 * member-authored text off-vendor would also outlive the member's own
 * deletions, which the privacy model does not extend to.
 */
import type { Entity } from "./catalog.ts";

/** What a previous run already stored, keyed by Entity id. */
export type CaptureState = Map<string, { lastMessageId: string | null }>;

export interface CaptureDecision {
  capture: Entity[];
  skippedUnchanged: number;
  skippedWithheld: number;
  /** Forums, which have no messages of their own. */
  skippedNoOwnContent: number;
  /** Monitored channels. Their conversation is extract-and-discard. */
  skippedMonitored: number;
}

/**
 * Channels the bot watches to build member profiles — archetypally
 * `👋︱introductions`. Their conversation is **extract-and-discard** under the
 * privacy model and must never be stored: a member introducing themselves is
 * having a conversation, not authoring a description.
 *
 * This is the carve-out the privacy model actually specifies. It is not a ban
 * on Channel content generally.
 */
export const DEFAULT_MONITORED_CHANNELS = ["👋︱introductions"];

/**
 * What Tier 0 may capture: Channels, Posts and Threads.
 *
 * Forums are excluded because they carry no messages of their own — their
 * content lives in their Posts. Monitored channels are excluded on privacy
 * grounds, not because there is nothing there.
 */
const isCapturable = (e: Entity) =>
  e.type === "post" || e.type === "thread" || e.type === "channel";

export const selectForCapture = (
  catalog: Entity[],
  state: CaptureState,
  options: { monitored?: readonly string[] } = {},
): CaptureDecision => {
  const monitored = new Set(options.monitored ?? DEFAULT_MONITORED_CHANNELS);
  const byId = new Map(catalog.map((e) => [e.id, e]));

  // A Thread inside a monitored channel is monitored conversation too. The
  // intro threads are where the actual introductions are, so matching only on
  // the channel's own name would have captured exactly what the carve-out
  // exists to protect.
  const isMonitored = (e: Entity): boolean => {
    if (monitored.has(e.name) || monitored.has(e.id)) return true;
    const parent = e.parent_id ? byId.get(e.parent_id) : undefined;
    return parent ? monitored.has(parent.name) || monitored.has(parent.id) : false;
  };
  const decision: CaptureDecision = {
    capture: [],
    skippedUnchanged: 0,
    skippedWithheld: 0,
    skippedNoOwnContent: 0,
    skippedMonitored: 0,
  };

  for (const entity of catalog) {
    if (isMonitored(entity)) {
      decision.skippedMonitored++;
      continue;
    }
    if (!isCapturable(entity)) {
      decision.skippedNoOwnContent++;
      continue;
    }
    // Defence in depth, not the live guard. The real protection is upstream:
    // buildCatalog only enumerates threads from containers whose content is
    // readable, so a withheld Entity never reaches the Catalog with children
    // in the first place, and `fromThread` cannot emit "withheld" today. This
    // stays because the invariant is one refactor away from changing, and
    // because Discord answers a denied history with 200 and an empty array
    // rather than 403 — an empty response would look like a successful read.
    if (entity.description_status === "withheld") {
      decision.skippedWithheld++;
      continue;
    }
    const seen = state.get(entity.id);
    if (seen && seen.lastMessageId === entity.last_message_id) {
      decision.skippedUnchanged++;
      continue;
    }
    decision.capture.push(entity);
  }
  return decision;
};

/** Two calls per Entity: one head window, one tail window. */
export const CALLS_PER_ENTITY = 2;

/** Discord's global ceiling: 10,000 invalid-or-otherwise requests per 10 min. */
export const GLOBAL_REQUEST_CEILING = 10_000;

export const projectedCalls = (entityCount: number) =>
  entityCount * CALLS_PER_ENTITY;
