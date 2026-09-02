import { ChannelType } from "./ports.ts";
import type { DiscordReadPort } from "./ports.ts";

export type EntityType = "channel" | "forum" | "post" | "thread";

export interface Entity {
  /** Discord snowflake. The key. Names are mutable; this is not. */
  id: string;
  type: EntityType;
  name: string;
  url: string;
  /**
   * present  - a description was derived
   * absent   - readable, but nothing usable to describe it with
   * withheld - deliberately listed without content, and never sampled
   *
   * `withheld` must stay distinct from `absent`. Collapse them and a privacy
   * decision looks like a bug, and someone eventually "fixes" it by granting
   * the bot history.
   */
  description_status: "present" | "absent" | "withheld";
  /** Channel topic, verbatim. Enrichment from message samples comes later. */
  topic: string | null;
  /** Overwritten by the sync every run. Null until Phase 2 generates one. */
  summary_generated: string | null;
  /**
   * Human-authored, and the renderer prefers it. The sync only ever copies
   * this forward from the previous Catalog — it never derives a value — so a
   * correction cannot be clobbered by a later run.
   */
  summary_override: string | null;
}

const deepLink = (guildId: string, entityId: string) =>
  `https://discord.com/channels/${guildId}/${entityId}`;

export const buildCatalog = async (deps: {
  discord: DiscordReadPort;
  guildId: string;
  previous?: Entity[];
}): Promise<{ catalog: Entity[] }> => {
  if (!(await deps.discord.hasMessageContentIntent())) {
    throw new Error(
      "Message Content intent is not enabled for this application. It gates " +
        "content over REST as well as the gateway, so descriptions would be " +
        "silently empty. Enable it in the Discord developer portal and re-run.",
    );
  }

  const overrides = new Map(
    (deps.previous ?? []).map((e) => [e.id, e.summary_override]),
  );
  // A Channel is a standing text channel that is not a Forum. Categories are
  // headers, voice channels are not readable, and Forums are their own Entity
  // type handled elsewhere — none of them belong in the Catalog as Channels.
  const channels = (await deps.discord.listChannels()).filter(
    (c) =>
      c.visible &&
      (c.type === ChannelType.GuildText ||
        c.type === ChannelType.GuildAnnouncement),
  );
  return {
    catalog: channels.map((c) => ({
      id: c.id,
      type: "channel" as const,
      name: c.name,
      url: deepLink(deps.guildId, c.id),
      topic: c.contentReadable ? ((c.topic ?? "").trim() || null) : null,
      description_status: !c.contentReadable
        ? ("withheld" as const)
        : (c.topic ?? "").trim()
          ? ("present" as const)
          : ("absent" as const),
      summary_generated: null,
      summary_override: overrides.get(c.id) ?? null,
    })),
  };
};
