/**
 * The Catalog snapshot the site pulls from the bot (ADR-0001, "Bot → site").
 *
 * INTERFACE STUB: the puller, validation and persistence are being built
 * against these types. `currentSnapshot` and `startSnapshotPuller` keep these
 * signatures.
 */

/** One place in the Catalog: the bot's `Entity` (apps/bot/src/sync/catalog.ts), as carried. */
export interface CatalogEntity {
  id: string;
  type: "channel" | "forum" | "post" | "thread";
  name: string;
  url: string;
  parent_id: string | null;
  description_status: "present" | "absent" | "withheld";
  topic: string | null;
  applied_tags: string[];
  region: string[];
  topics: string[];
  topics_version: number | null;
  thread_state: "open" | "closed" | "locked" | null;
  last_message_id: string | null;
  last_activity_at: string | null;
  summary_generated: string | null;
  summary_override: string | null;
  allow_roles?: string[];
  view_roles?: string[];
  deny_roles?: string[];
}

export interface RoleManifestEntry {
  name: string;
  color: number;
  ids: string[];
}

/** The envelope the bot serves at `GET /snapshot`, version 1. */
export interface SnapshotEnvelope {
  version: 1;
  /** When the bot's current generation was written by a complete sync. ISO 8601. */
  generatedAt: string;
  /** The bot's scheduled sync cadence, so the site can tell a missed sync. */
  syncEveryMs: number;
  outcome: { complete: true } | { complete: false; failed: Array<{ id: string; reason: string }> };
  roleManifest: RoleManifestEntry[];
  catalog: CatalogEntity[];
}

/** The last snapshot the site accepted, and whether two scheduled syncs have since been missed. */
export interface SnapshotView {
  snapshot: SnapshotEnvelope;
  stale: boolean;
}

/** The last accepted snapshot, or null when the site has never accepted one. */
export function currentSnapshot(): SnapshotView | null {
  return null;
}

/** Loads the last accepted snapshot from disk and starts pulling. Idempotent. */
export function startSnapshotPuller(): void {}
