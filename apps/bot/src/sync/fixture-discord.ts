import type { DiscordReadPort, RawChannel } from "./ports.ts";

export const fixtureDiscord = (data: {
  channels: RawChannel[];
  messageContentIntent?: boolean;
}): DiscordReadPort => ({
  listChannels: async () => data.channels,
  hasMessageContentIntent: async () => data.messageContentIntent ?? true,
});
