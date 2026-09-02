import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import type { DiscordReadPort, RawChannel } from "./ports.ts";

const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ADMINISTRATOR = 1n << 3n;

export interface Overwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}
export interface RawGuildChannel {
  id: string;
  name: string;
  type: number;
  topic?: string | null;
  permission_overwrites?: Overwrite[];
}

/**
 * Discord returns 200 with an EMPTY ARRAY, not 403, when READ_MESSAGE_HISTORY
 * is denied. So "no messages" cannot be distinguished from "no permission" at
 * the message endpoint — it has to be decided from permissions up front.
 * Verified against this guild on 2026-09-01.
 */
export const canReadHistory = (
  channel: { permission_overwrites?: Overwrite[] },
  ctx: { guildId: string; roleIds: string[]; basePermissions: bigint },
): boolean => {
  if ((ctx.basePermissions & ADMINISTRATOR) !== 0n) return true;
  let p = ctx.basePermissions;
  const ow = channel.permission_overwrites ?? [];
  const everyone = ow.find((o) => o.id === ctx.guildId && o.type === 0);
  if (everyone) {
    p &= ~BigInt(everyone.deny);
    p |= BigInt(everyone.allow);
  }
  let allow = 0n;
  let deny = 0n;
  for (const rid of ctx.roleIds) {
    const o = ow.find((x) => x.id === rid && x.type === 0);
    if (o) {
      deny |= BigInt(o.deny);
      allow |= BigInt(o.allow);
    }
  }
  p &= ~deny;
  p |= allow;
  return (p & VIEW_CHANNEL) !== 0n && (p & READ_MESSAGE_HISTORY) !== 0n;
};

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
      const [channels, roles, me] = (await Promise.all([
        rest.get(Routes.guildChannels(config.guildId)),
        rest.get(Routes.guildRoles(config.guildId)),
        rest.get(Routes.user("@me")),
      ])) as [
        RawGuildChannel[],
        Array<{ id: string; permissions: string }>,
        { id: string },
      ];
      const member = (await rest.get(
        Routes.guildMember(config.guildId, me.id),
      )) as { roles: string[] };
      const byId = new Map(roles.map((r) => [r.id, r]));
      let basePermissions = BigInt(byId.get(config.guildId)?.permissions ?? "0");
      for (const rid of member.roles)
        basePermissions |= BigInt(byId.get(rid)?.permissions ?? "0");
      const ctx = {
        guildId: config.guildId,
        roleIds: member.roles,
        basePermissions,
      };
      return channels.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        topic: c.topic ?? null,
        contentReadable: canReadHistory(c, ctx),
      }));
    },

    hasMessageContentIntent: async (): Promise<boolean> => {
      const app = (await rest.get(Routes.currentApplication())) as {
        flags?: number;
      };
      return messageContentUsable(app.flags ?? 0);
    },
  };
};
