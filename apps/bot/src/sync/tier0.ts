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
 *
 * Nothing in it was written more than seven days ago (`toStored` below, then
 * `purge.ts`), and nothing in it was written by a member who has turned
 * processing off.
 */
import type { Entity } from "./catalog.ts";
import type { RawCapturedMessage } from "./ports.ts";
import { RETAIN_MS, type StoredMessage, type openTier0 } from "./tier0-store.ts";

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

/**
 * Whether an Entity's conversation is monitored, and so extract-and-discard.
 *
 * A Thread inside a monitored channel is monitored conversation too. The intro
 * threads are where the actual introductions are, so matching only on the
 * channel's own name would have captured exactly what the carve-out exists to
 * protect.
 *
 * Exported because Tier 0 is not the only place this has to hold: the LLM
 * boundary enforces the same carve-out, and a second definition of "monitored"
 * is a second thing to keep in step.
 */
export const isMonitored = (
  entity: Entity,
  byId: Map<string, Entity>,
  monitored: ReadonlySet<string>,
): boolean => {
  if (monitored.has(entity.name) || monitored.has(entity.id)) return true;
  const parent = entity.parent_id ? byId.get(entity.parent_id) : undefined;
  return parent ? monitored.has(parent.name) || monitored.has(parent.id) : false;
};

export const selectForCapture = (
  catalog: Entity[],
  state: CaptureState,
  options: { monitored?: readonly string[] } = {},
): CaptureDecision => {
  const monitored = new Set(options.monitored ?? DEFAULT_MONITORED_CHANNELS);
  const byId = new Map(catalog.map((e) => [e.id, e]));

  const decision: CaptureDecision = {
    capture: [],
    skippedUnchanged: 0,
    skippedWithheld: 0,
    skippedNoOwnContent: 0,
    skippedMonitored: 0,
  };

  for (const entity of catalog) {
    if (isMonitored(entity, byId, monitored)) {
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

/**
 * What capture stores from one Entity's windows.
 *
 * A member who has turned processing off is dropped here, before storage —
 * not filtered later at prompt time. What is never stored cannot be sent,
 * summarised or need deleting. So is a message older than `RETAIN_MS`: the
 * windows reach back to an Entity's opening, and the purge would only delete
 * it again. Bots and webhooks are kept and flagged, as before: they are
 * dropped where the text is used.
 */
export const toStored = (
  entityId: string,
  raw: RawCapturedMessage[],
  optedOut: ReadonlySet<string>,
  now = new Date(),
): StoredMessage[] =>
  raw
    .filter((m) => !optedOut.has(m.authorId))
    // A timestamp that does not parse is NaN, fails this, and is not stored.
    .filter((m) => Date.parse(m.createdAt) >= now.getTime() - RETAIN_MS)
    .map((m) => ({
      entityId,
      messageId: m.id,
      authorId: m.authorId,
      authorIsBot: m.authorIsBot,
      content: m.content,
      createdAt: m.createdAt,
      window: m.window,
    }));

/**
 * Captures each Entity in turn.
 *
 * One Entity failing must not abort the crawl. A single 50001 used to kill the
 * whole ~1,200-Entity run, and because the failing Entity was never recorded,
 * every retry died in the same place.
 *
 * Opt-outs are read for each Entity, just before its messages are stored, not
 * once for the run: a crawl takes minutes, and someone who opts out part-way
 * is not stored from the next Entity on. A read that fails fails that Entity,
 * which is left uncaptured rather than stored unchecked.
 *
 * ponytail: an opt-out or a deletion that lands between that read and the
 * write — milliseconds — is stored over. The next purge (within one cycle, six
 * hours) sweeps every message from a member with processing off; a member who
 * deleted and has opted back in by then keeps those until they age out.
 */
export const captureEach = async (deps: {
  entities: Entity[];
  fetch: (entityId: string) => Promise<RawCapturedMessage[]>;
  store: Pick<ReturnType<typeof openTier0>, "record">;
  optedOut: () => ReadonlySet<string>;
  progress?: (handled: number) => void;
}): Promise<{ done: number; calls: number; failed: Array<{ id: string; name: string; error: string }> }> => {
  let calls = 0;
  let done = 0;
  const failed: Array<{ id: string; name: string; error: string }> = [];
  for (const entity of deps.entities) {
    try {
      const raw = await deps.fetch(entity.id);
      calls += CALLS_PER_ENTITY;
      deps.store.record(entity.id, entity.last_message_id, toStored(entity.id, raw, deps.optedOut()));
      done++;
    } catch (error) {
      calls += CALLS_PER_ENTITY;
      failed.push({
        id: entity.id,
        name: entity.name,
        error: `${(error as { status?: number }).status ?? "?"} ${(error as { code?: number }).code ?? ""}`.trim(),
      });
    }
    deps.progress?.(done + failed.length);
  }
  return { done, calls, failed };
};
