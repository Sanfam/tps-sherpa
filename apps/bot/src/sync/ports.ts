/**
 * Discord's numeric channel types, as returned by `GET /guilds/{id}/channels`.
 * Only the ones the Catalog cares about.
 */
export const ChannelType = {
  GuildText: 0,
  GuildVoice: 2,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  GuildForum: 15,
  GuildMedia: 16,
} as const;

/** Raw shapes as Discord returns them, before any normalisation. */
export interface RawChannel {
  id: string;
  name: string;
  type: number;
  /** Channel topic. The best identity source for a Channel, and free. */
  topic?: string | null;
  /** Whether the bot can see this Channel at all. False means excluded. */
  visible: boolean;
  /**
   * Whether the bot may read message history. Visible but not readable means
   * deliberately withheld — content off-limits, not broken.
   */
  contentReadable: boolean;
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
  /** From the Forum's tag set. Mod-authored ground truth. Posts only. */
  appliedTags: string[];
  /**
   * The starter message body. A Post's ID equals its starter message's ID,
   * so this costs one un-paginated call. Verified 2026-09-01.
   */
  firstPost: string | null;
}

/** A guild role, as the manifest records it. */
export interface RawRole {
  id: string;
  name: string;
}

export interface DiscordReadPort {
  listChannels: () => Promise<RawChannel[]>;
  /**
   * Every Post and Thread inside the given parents. Parents the bot cannot
   * read are never passed in — see the visibility filter.
   */
  listThreads: (parentIds: string[]) => Promise<RawThread[]>;
  listRoles: () => Promise<RawRole[]>;
  /**
   * Whether the application has the Message Content intent. It gates content
   * over REST as well as the gateway, so without it the sync produces empty
   * descriptions that look like a bug in our own code.
   */
  hasMessageContentIntent: () => Promise<boolean>;
}
