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
export interface DiscordReadPort {
  listChannels: () => Promise<RawChannel[]>;
  /**
   * Whether the application has the Message Content intent. It gates content
   * over REST as well as the gateway, so without it the sync produces empty
   * descriptions that look like a bug in our own code.
   */
  hasMessageContentIntent: () => Promise<boolean>;
}
