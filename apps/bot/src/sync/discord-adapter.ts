import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import type { DiscordReadPort, RawChannel } from "./ports.ts";

/**
 * `GATEWAY_MESSAGE_CONTENT` on the application's flags. The `_LIMITED` variant
 * (1 << 19) means the intent was requested but not yet approved, which is not
 * good enough — content still comes back empty.
 */
const GATEWAY_MESSAGE_CONTENT = 1 << 18;

/**
 * The live adapter. Everything Discord-shaped lives here so the sync seam
 * stays testable without a network.
 */
export const discordRest = (config: {
  token: string;
  guildId: string;
}): DiscordReadPort => {
  const rest = new REST({ version: "10" }).setToken(config.token);

  return {
    listChannels: async (): Promise<RawChannel[]> => {
      const channels = (await rest.get(
        Routes.guildChannels(config.guildId),
      )) as Array<{ id: string; name: string; type: number }>;
      return channels.map((c) => ({ id: c.id, name: c.name, type: c.type }));
    },

    hasMessageContentIntent: async (): Promise<boolean> => {
      const app = (await rest.get(Routes.currentApplication())) as {
        flags?: number;
      };
      return ((app.flags ?? 0) & GATEWAY_MESSAGE_CONTENT) !== 0;
    },
  };
};
