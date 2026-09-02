import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import type {
  DiscordReadPort,
  RawChannel,
  RawRole,
  RawThread,
} from "./ports.ts";

const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ADMINISTRATOR = 1n << 3n;

export interface Overwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}
interface RawDiscordThread {
  id: string;
  name: string;
  parent_id?: string | null;
  applied_tags?: string[];
  thread_metadata?: { archive_timestamp?: string };
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
export interface PermissionContext {
  guildId: string;
  roleIds: string[];
  /** The bot's own user id. Member-specific overwrites target it directly. */
  memberId: string;
  basePermissions: bigint;
}

export const canView = (
  channel: { permission_overwrites?: Overwrite[] },
  ctx: PermissionContext,
): boolean => (effective(channel, ctx) & VIEW_CHANNEL) !== 0n;

export const canReadHistory = (
  channel: { permission_overwrites?: Overwrite[] },
  ctx: PermissionContext,
): boolean => {
  const p = effective(channel, ctx);
  return (p & VIEW_CHANNEL) !== 0n && (p & READ_MESSAGE_HISTORY) !== 0n;
};

const effective = (
  channel: { permission_overwrites?: Overwrite[] },
  ctx: PermissionContext,
): bigint => {
  if ((ctx.basePermissions & ADMINISTRATOR) !== 0n) return ~0n;
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

  // A member-specific overwrite (type 1) applies last and beats every role
  // overwrite. Ignoring it computed "readable" for verification-chat-1, which
  // Discord answers with 403 — found live on 2026-09-01.
  const mine = ow.find((o) => o.id === ctx.memberId && o.type === 1);
  if (mine) {
    p &= ~BigInt(mine.deny);
    p |= BigInt(mine.allow);
  }
  return p;
};

/** The glossary's `Member`: the role that unlocks the community. */
const MEMBER_ROLE_NAME = "Member";

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
  warn?: (message: string) => void;
}): DiscordReadPort => {
  const rest = new REST({ version: "10" }).setToken(config.token);

  // Fetched once per sync. Two fetches opened a window where a role created
  // or deleted between them made the permission context and the committed
  // manifest disagree.
  type GuildRole = {
    id: string;
    name: string;
    permissions: string;
    color: number;
  };
  let rolesOnce: Promise<GuildRole[]> | undefined;
  const guildRoles = (): Promise<GuildRole[]> =>
    (rolesOnce ??= rest.get(Routes.guildRoles(config.guildId)) as Promise<
      GuildRole[]
    >);

  return {
    listChannels: async (): Promise<RawChannel[]> => {
      const [channels, roles, me] = (await Promise.all([
        rest.get(Routes.guildChannels(config.guildId)),
        guildRoles(),
        rest.get(Routes.user("@me")),
      ])) as [
        RawGuildChannel[],
        GuildRole[],
        { id: string },
      ];
      const member = (await rest.get(
        Routes.guildMember(config.guildId, me.id),
      )) as { roles: string[] };
      const byId = new Map(roles.map((r) => [r.id, r]));
      const everyonePerms = BigInt(byId.get(config.guildId)?.permissions ?? "0");

      let basePermissions = everyonePerms;
      for (const rid of member.roles)
        basePermissions |= BigInt(byId.get(rid)?.permissions ?? "0");
      const ctx: PermissionContext = {
        guildId: config.guildId,
        roleIds: member.roles,
        memberId: me.id,
        basePermissions,
      };

      // The Catalog's baseline is the `Member` role, not @everyone — here
      // @everyone can see 11 of 105 Channels and Forums, essentially just
      // verification plumbing. Without the role there is nothing to compare
      // against, so the delta check goes quiet rather than reporting noise.
      // Union every role with the name, not the first match: this guild has
      // duplicate-named roles, and picking one arbitrarily would make the
      // visibility alarm either silent or noisy depending on the draw.
      const memberRoles = roles.filter((r) => r.name === MEMBER_ROLE_NAME);
      if (memberRoles.length === 0)
        config.warn?.(
          `[visibility] No "${MEMBER_ROLE_NAME}" role found. The Member-versus-bot ` +
            `visibility check is disabled, so gaps in the Catalog will not be reported.`,
        );
      const memberCtx: PermissionContext | null = memberRoles.length
        ? {
            guildId: config.guildId,
            roleIds: memberRoles.map((r) => r.id),
            // No member-specific overwrite applies to a hypothetical member.
            memberId: "",
            basePermissions: memberRoles.reduce(
              (acc, r) => acc | BigInt(r.permissions),
              everyonePerms,
            ),
          }
        : null;
      return channels.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        topic: c.topic ?? null,
        visible: canView(c, ctx),
        memberVisible: memberCtx ? canView(c, memberCtx) : canView(c, ctx),
        contentReadable: canReadHistory(c, ctx),
      }));
    },

    listThreads: async (parentIds: string[]): Promise<RawThread[]> => {
      const wanted = new Set(parentIds);
      const raw = new Map<string, RawDiscordThread>();

      // Active threads across the whole guild arrive in one call.
      const active = (await rest.get(
        Routes.guildActiveThreads(config.guildId),
      )) as { threads: RawDiscordThread[] };
      for (const t of active.threads)
        if (t.parent_id && wanted.has(t.parent_id)) raw.set(t.id, t);

      // Archived ones are per-parent and paginated. Roughly two thirds of this
      // guild's Posts are archived, so this is the bulk of the work.
      for (const parentId of parentIds) {
        let before: string | undefined;
        for (;;) {
          const q = new URLSearchParams({ limit: "100" });
          if (before) q.set("before", before);
          // NOTE: this endpoint rejects limit=1 with NUMBER_TYPE_MIN.
          let page: { threads: RawDiscordThread[]; has_more: boolean };
          try {
            page = (await rest.get(
              `/channels/${parentId}/threads/archived/public?${q}` as never,
            )) as { threads: RawDiscordThread[]; has_more: boolean };
          } catch (error) {
            // Computed permissions and Discord disagreed. Skip loudly rather
            // than crash — and treat it as a signal, not noise.
            if ((error as { code?: number }).code === 50001) {
              console.warn(
                `[permissions] computed readable but Discord denied: ${parentId}`,
              );
              break;
            }
            throw error;
          }
          for (const t of page.threads) raw.set(t.id, t);
          const last = page.threads.at(-1)?.thread_metadata?.archive_timestamp;
          if (!page.has_more || !last) break;
          before = last;
        }
      }

      // A Post's ID equals its starter message's ID, so the first post is one
      // un-paginated call. Verified against real Posts on 2026-09-01.
      return Promise.all(
        [...raw.values()].map(async (t) => {
          let firstPost: string | null = null;
          try {
            const msg = (await rest.get(
              `/channels/${t.id}/messages/${t.id}` as never,
            )) as { content?: string };
            firstPost = msg.content ?? null;
          } catch {
            // Deleted starter message. Absent, not fatal.
          }
          return {
            id: t.id,
            name: t.name,
            parentId: t.parent_id ?? "",
            appliedTags: t.applied_tags ?? [],
            firstPost,
          };
        }),
      );
    },

    listRoles: async (): Promise<RawRole[]> => {
      return (await guildRoles()).map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color ?? 0,
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
