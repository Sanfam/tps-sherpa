import type {
  DiscordReadPort,
  RawChannel,
  RawCapturedMessage,
  RawRole,
  RawThread,
} from "./ports.ts";

export const fixtureDiscord = (data: {
  channels: Array<
    Omit<RawChannel, "contentReadable" | "visible" | "memberVisible"> & {
      contentReadable?: boolean;
      visible?: boolean;
      memberVisible?: boolean;
    }
  >;
  threads?: RawThread[];
  roles?: RawRole[];
  windows?: Record<string, RawCapturedMessage[]>;
  messageContentIntent?: boolean;
}): DiscordReadPort => ({
  listChannels: async () =>
    data.channels.map((c) => ({
      ...c,
      visible: c.visible ?? true,
      memberVisible: c.memberVisible ?? c.visible ?? true,
      contentReadable: c.contentReadable ?? true,
    })),
  listThreads: async (parentIds) => ({
    threads: (data.threads ?? []).filter((t) => parentIds.includes(t.parentId)),
    failed: [],
  }),
  listRoles: async () => data.roles ?? [],
  captureWindows: async (entityId) => data.windows?.[entityId] ?? [],
  hasMessageContentIntent: async () => data.messageContentIntent ?? true,
});
