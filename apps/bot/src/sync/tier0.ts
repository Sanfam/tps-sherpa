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
  skippedNotThreadContent: number;
}

/**
 * Tier 0 covers **indexed thread content only** — Posts and Threads. It must
 * not quietly expand to Channel conversation, which stays extract-and-discard
 * under the privacy model. Channels get their description from their topic,
 * which needs no capture at all.
 */
const isThreadContent = (e: Entity) => e.type === "post" || e.type === "thread";

export const selectForCapture = (
  catalog: Entity[],
  state: CaptureState,
): CaptureDecision => {
  const decision: CaptureDecision = {
    capture: [],
    skippedUnchanged: 0,
    skippedWithheld: 0,
    skippedNotThreadContent: 0,
  };

  for (const entity of catalog) {
    if (!isThreadContent(entity)) {
      decision.skippedNotThreadContent++;
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
