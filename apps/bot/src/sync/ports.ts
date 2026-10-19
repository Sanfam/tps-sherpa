/**
 * Discord's numeric channel types, as returned by `GET /guilds/{id}/channels`.
 * Only the ones the Catalog cares about.
 */
export const ChannelType = {
  GuildText: 0,
  GuildVoice: 2,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  PrivateThread: 12,
  GuildForum: 15,
  GuildMedia: 16,
} as const;

/** Raw shapes as Discord returns them, before any normalisation. */
export interface RawChannel {
  id: string;
  name: string;
  type: number;
  /** The category it sits under, if any. */
  categoryId?: string | null;
  /** Channel topic. The best identity source for a Channel, and free. */
  topic?: string | null;
  /** Newest message, or null if never posted in. Its snowflake carries the time. */
  lastMessageId?: string | null;
  /** Whether the bot can see this Channel at all. False means excluded. */
  visible: boolean;
  /**
   * Whether the `Member` role can see it. This — not `@everyone` — is the
   * Catalog's baseline: @everyone sees 11 of 105 here, essentially just
   * verification plumbing.
   */
  memberVisible: boolean;
  /** Who can see it, by role: the Entity's `allow_roles`, `view_roles` and `deny_roles`; see there. */
  allowRoles: string[];
  viewRoles: string[];
  denyRoles: string[];
  /**
   * Members whose own overwrite hides it. Member data: stored only in the
   * bot's durable store (`member_deny`), never on an Entity.
   */
  deniedMembers: string[];
  /**
   * Whether the bot may read message history. Visible but not readable means
   * deliberately withheld — content off-limits, not broken.
   */
  contentReadable: boolean;
  /**
   * A Forum's own tag set. `applied_tags` on a Post is a list of IDs into
   * this, so without it the Catalog can only publish snowflakes — which is
   * the exact defect class the render path exists to remove. Forums only.
   */
  availableTags?: Array<{ id: string; name: string }>;
}

/**
 * The one dependency the sync seam has on Discord. Satisfied by discord.js
 * REST in production and by `fixtureDiscord` in tests.
 */
/** A Post inside a Forum, or a Thread inside a Channel. */
export interface RawThread {
  id: string;
  name: string;
  /** The Forum or Channel it lives in. */
  parentId: string;
  /** IDs into the parent Forum's tag set. Resolved to names in the Catalog. */
  appliedTags: string[];
  /**
   * The starter message body. A Post's ID equals its starter message's ID,
   * so this costs one un-paginated call. Verified 2026-09-01.
   */
  firstPost: string | null;
  lastMessageId?: string | null;
  /** Whether it came from the archived listing rather than the active one. */
  archived?: boolean;
  /** From `thread_metadata.locked`. */
  locked?: boolean;
}

export interface RawCapturedMessage {
  id: string;
  authorId: string;
  /** A bot or a webhook: either way, not a member's words. */
  authorIsBot: boolean;
  /**
   * The author's username and display name, as the message carries them. The
   * only source of member names: there is no member list, which would need
   * the privileged GuildMembers intent. A server nickname is not here.
   */
  authorNames: string[];
  content: string;
  createdAt: string;
  window: "head" | "tail";
}

/** A guild role as Discord returns it. */
export interface RawRole {
  id: string;
  name: string;
  /** Discord's integer colour. 0 means "no colour set". */
  color: number;
}

/**
 * One manifest entry per role NAME, carrying every ID that name maps to.
 *
 * A bot once created duplicate roles: this guild has 5 names covering 13 roles
 * with identical permissions and colours, referenced by no channel overwrite.
 *
 * Roles are aggregated only when name AND colour both match. That is the
 * safeguard: two roles that genuinely differ will almost always differ in
 * colour, and merging those would silently widen an audience. A same-name,
 * different-colour pair stays separate and is warned about instead.
 */
export interface RoleManifestEntry {
  name: string;
  color: number;
  ids: string[];
}

/**
 * Whether a sync enumerated everything it set out to. Incomplete means some
 * containers' Posts or Threads could not be listed, so an Entity missing from
 * the result has not been confirmed removed (#28). A plain value, so the
 * snapshot envelope can carry it to the site.
 */
export type SyncOutcome =
  | { complete: true }
  | { complete: false; failed: FailedContainer[] };

/** A Forum or Channel whose Posts or Threads could not be listed, and why. */
export interface FailedContainer {
  id: string;
  reason: string;
}

export interface DiscordReadPort {
  listChannels: () => Promise<RawChannel[]>;
  /**
   * Every Post and Thread inside the given parents, and the parents that
   * could not be fully listed. Parents the bot cannot read are never passed
   * in — see the visibility filter.
   */
  listThreads: (
    parentIds: string[],
  ) => Promise<{ threads: RawThread[]; failed: FailedContainer[] }>;
  listRoles: () => Promise<RawRole[]>;
  /**
   * Head and tail message windows for one Entity. Two calls. Only ever asked
   * for Entities whose content the bot may read — see Tier 0.
   */
  captureWindows: (entityId: string) => Promise<RawCapturedMessage[]>;
  /**
   * Whether the application has the Message Content intent. It gates content
   * over REST as well as the gateway, so without it the sync produces empty
   * descriptions that look like a bug in our own code.
   */
  hasMessageContentIntent: () => Promise<boolean>;
}
