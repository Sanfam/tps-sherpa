import type { DiscordReadPort, RawChannel, RawThread } from "./ports.ts";

export const fixtureDiscord = (data: {
  channels: Array<
    Omit<RawChannel, "contentReadable" | "visible"> & {
      contentReadable?: boolean;
      visible?: boolean;
    }
  >;
  threads?: RawThread[];
  messageContentIntent?: boolean;
}): DiscordReadPort => ({
  listChannels: async () =>
    data.channels.map((c) => ({
      ...c,
      visible: c.visible ?? true,
      contentReadable: c.contentReadable ?? true,
    })),
  listThreads: async (parentIds) =>
    (data.threads ?? []).filter((t) => parentIds.includes(t.parentId)),
  hasMessageContentIntent: async () => data.messageContentIntent ?? true,
});
