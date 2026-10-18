import type {
  DiscordReadPort,
  RawChannel,
  RawCapturedMessage,
  RawRole,
  RawThread,
} from "./ports.ts";

type Defaulted = "contentReadable" | "visible" | "memberVisible" | "allowRoles" | "viewRoles" | "denyRoles" | "deniedMembers";

export const fixtureDiscord = (data: {
  channels: Array<Omit<RawChannel, Defaulted> & Partial<Pick<RawChannel, Defaulted>>>;
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
      allowRoles: c.allowRoles ?? [],
      viewRoles: c.viewRoles ?? [],
      denyRoles: c.denyRoles ?? [],
      deniedMembers: c.deniedMembers ?? [],
    })),
  listThreads: async (parentIds) => ({
    threads: (data.threads ?? []).filter((t) => parentIds.includes(t.parentId)),
    failed: [],
  }),
  listRoles: async () => data.roles ?? [],
  captureWindows: async (entityId) => data.windows?.[entityId] ?? [],
  hasMessageContentIntent: async () => data.messageContentIntent ?? true,
});
