import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import type { DiscordReadPort, RawChannel } from "./ports.ts";

const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

/**
 * Whether the application can actually read message content.
 *
 * Either flag is sufficient. A bot in fewer than 100 guilds self-toggles the
 * intent and gets `_LIMITED`; only a verified bot past that threshold gets the
 * unqualified flag. Checking bit 18 alone rejects every correctly configured
 * small bot — verified against this guild on 2026-09-01, where flags were
 * 565248 (`_LIMITED` set, bit 18 clear) and message content was returned
 * normally over REST.
 */
export const messageContentUsable = (flags: number): boolean =>
  (flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0;

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
      return messageContentUsable(app.flags ?? 0);
    },
  };
};
