/**
 * `/monitored`: Staff's list of monitored channels — the Channels whose
 * conversation, and whose Threads', is extract-and-discard (#33). Edited here
 * so a new one needs no deploy.
 *
 * Staff-only: registered with Manage Server as its default member
 * permission, so Discord shows it to nobody else, and the bit is checked
 * again on every use, since admins can override that default. Every reply is
 * ephemeral, like every other.
 *
 * Removing an entry weakens a privacy carve-out — that Channel's conversation
 * can be stored and sent to a model from the next cycle on — so it is logged
 * loudly, with who did it.
 */
import {
  type APIApplicationCommandChannelOption,
  type APIChatInputApplicationCommandInteraction,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  PermissionFlagsBits,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import type { Entity } from "../sync/catalog.ts";
import { type MonitoredChannel, withDurableStore } from "../sync/durable-store.ts";

const channelOption: APIApplicationCommandChannelOption = {
  name: "channel",
  type: ApplicationCommandOptionType.Channel,
  description: "Which channel.",
  required: true,
  channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum],
};

export const MONITORED_COMMAND: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: "monitored",
  type: ApplicationCommandType.ChatInput,
  description: "Staff: the channels Sherpa never stores or sends to its model.",
  default_member_permissions: String(PermissionFlagsBits.ManageGuild),
  options: [
    { name: "list", type: ApplicationCommandOptionType.Subcommand, description: "Show the monitored channels." },
    {
      name: "add",
      type: ApplicationCommandOptionType.Subcommand,
      description: "Monitor a channel: its messages and its threads are never stored.",
      options: [channelOption],
    },
    {
      name: "remove",
      type: ApplicationCommandOptionType.Subcommand,
      description: "Stop monitoring a channel. Its messages can then be stored.",
      options: [channelOption],
    },
  ],
};

/** What `/monitored` reads and changes. A real store on a temp path in tests. */
export interface Monitored {
  list: () => MonitoredChannel[];
  add: (id: string, name: string, by: string) => boolean;
  remove: (id: string) => boolean;
}

export const openMonitored = (path: string): Monitored => ({
  list: () => withDurableStore((s) => s.monitoredChannels(), path),
  add: (id, name, by) => withDurableStore((s) => s.addMonitored(id, name, by), path),
  remove: (id) => withDurableStore((s) => s.removeMonitored(id), path),
});

const line = (c: MonitoredChannel, inCatalog: boolean) =>
  `• <#${c.id}>${c.name ? ` (${c.name})` : ""} — added by ${c.addedBy === "seed" ? "the initial setup" : `<@${c.addedBy}>`} ` +
  `<t:${Math.floor(Date.parse(c.addedAt) / 1000)}:R>` +
  (inCatalog ? "" : " — **not in the current Catalog: capture, enrichment and `/find` are stopped until it is removed or restored**");

export const NOT_STAFF = "`/monitored` is for Staff with the Manage Server permission.";

/** The invoker's computed permissions, as Discord sends them: a decimal bitfield. Absent or malformed is no. */
const canManageServer = (permissions: string | undefined): boolean => {
  if (!permissions || !/^\d+$/.test(permissions)) return false;
  const bits = BigInt(permissions);
  return (bits & (PermissionFlagsBits.ManageGuild | PermissionFlagsBits.Administrator)) !== 0n;
};

/** One `/monitored` interaction. Logs ids only. Null for a shape it does not know. */
export const answerMonitored = (
  interaction: APIChatInputApplicationCommandInteraction,
  monitored: Monitored,
  catalog: Entity[],
  log: (m: string) => void,
  tag: string,
): string | null => {
  const by = interaction.member?.user.id;
  const sub = interaction.data.options?.[0];
  if (!by || sub?.type !== ApplicationCommandOptionType.Subcommand) return null;
  // Checked here too: admins can override a command's default permission per
  // role or channel, and this list is a privacy control.
  if (!canManageServer(interaction.member?.permissions)) {
    log(`${tag} refused: no Manage Server`);
    return NOT_STAFF;
  }
  const id = sub.options?.find((o) => o.name === "channel")?.value;
  const byId = new Map(catalog.map((e) => [e.id, e]));

  switch (sub.name) {
    case "list": {
      const all = monitored.list();
      log(`${tag} list ${all.length}`);
      return all.length
        ? ["Monitored channels — never stored, never sent to the model, threads included:", ...all.map((c) => line(c, byId.has(c.id)))].join("\n")
        : "No channels are monitored. Every channel's messages can be stored and summarised.";
    }
    case "add": {
      if (typeof id !== "string") return null;
      const entity = byId.get(id);
      // A container only: the carve-out reaches one level down, to its Threads or Posts.
      if (!entity || (entity.type !== "channel" && entity.type !== "forum")) {
        log(`${tag} add refused ${id}: not a channel in the Catalog`);
        return `<#${id}> isn't a channel in Sherpa's current Catalog, so it can't be monitored. If it's new, try again after the next sync.`;
      }
      const added = monitored.add(id, entity.name, by);
      log(`${tag} add ${id} by ${by}${added ? "" : " (already monitored)"}`);
      return added
        ? `Done. <#${id}> is monitored: its messages and its threads' are no longer stored or sent to the model. ` +
            "Text Sherpa already stored from them is removed at its next cleanup; anything it can't place under " +
            "this channel ages out within 7 days."
        : `<#${id}> is already monitored.`;
    }
    case "remove": {
      if (typeof id !== "string") return null;
      const removed = monitored.remove(id);
      if (removed)
        log(
          `${tag} MONITORED CHANNEL REMOVED ${id} by ${by}: the carve-out no longer covers it, ` +
            "and its conversation can be stored and sent to the model from the next cycle on.",
        );
      else log(`${tag} remove ${id}: was not monitored`);
      return removed
        ? `Done. <#${id}> is no longer monitored. From the next cycle on, its messages and its threads' can be stored for up to 7 days and summarised.`
        : `<#${id}> wasn't monitored.`;
    }
  }
  return null;
};
