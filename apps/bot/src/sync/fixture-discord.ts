import type { DiscordReadPort, RawChannel } from "./ports.js";

export const fixtureDiscord = (data: {
  channels: RawChannel[];
  messageContentIntent?: boolean;
}): DiscordReadPort => ({
  listChannels: async () => data.channels,
  hasMessageContentIntent: async () => data.messageContentIntent ?? true,
});
