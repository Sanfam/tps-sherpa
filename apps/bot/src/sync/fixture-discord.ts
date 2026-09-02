import type { DiscordReadPort, RawChannel } from "./ports.ts";

export const fixtureDiscord = (data: {
  channels: Array<
    Omit<RawChannel, "contentReadable" | "visible"> & {
      contentReadable?: boolean;
      visible?: boolean;
    }
  >;
  messageContentIntent?: boolean;
}): DiscordReadPort => ({
  listChannels: async () =>
    data.channels.map((c) => ({
      ...c,
      visible: c.visible ?? true,
      contentReadable: c.contentReadable ?? true,
    })),
  hasMessageContentIntent: async () => data.messageContentIntent ?? true,
});
