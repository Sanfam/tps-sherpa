import { matchRegions, type Gazetteer } from "./facets.ts";
import { normaliseDescription, type NameLookup } from "./normalise.ts";
import { ChannelType } from "./ports.ts";
import type {
  DiscordReadPort,
  RawChannel,
  RoleManifestEntry,
  RawThread,
} from "./ports.ts";

export type EntityType = "channel" | "forum" | "post" | "thread";

export type DescriptionStatus = "present" | "absent" | "withheld";

export interface Entity {
  /** Discord snowflake. The key. Names are mutable; this is not. */
  id: string;
  type: EntityType;
  name: string;
  url: string;
  /** The Forum or Channel this lives in. Null for a Channel or Forum. */
  parent_id: string | null;
  /**
   * present  - a description was derived
   * absent   - readable, but nothing usable to describe it with
   * withheld - deliberately listed without content, and never sampled
   *
   * `withheld` must stay distinct from `absent`. Collapse them and a privacy
   * decision looks like a bug, and someone eventually "fixes" it by granting
   * the bot history.
   */
  description_status: DescriptionStatus;
  /** Channel topic or Post first message. Enrichment from samples is later. */
  topic: string | null;
  /**
   * The Platform facet: mod-authored Forum tag NAMES, resolved from the IDs
   * Discord returns. Ground truth — never overwritten by anything derived.
   * Posts only.
   */
  applied_tags: string[];
  /**
   * The Region facet: every region this Entity's name names, from the
   * committed gazetteer. Empty for the ~95% of Entities that name no place.
   */
  region: string[];
  /** Newest message. Null if nothing has been posted. */
  last_message_id: string | null;
  /**
   * Derived from the snowflake, not fetched: Discord IDs embed their creation
   * time, so this costs nothing and is exact.
   */
  last_activity_at: string | null;
  /** Overwritten by the sync every run. Null until Phase 2 generates one. */
  summary_generated: string | null;
  /**
   * Human-authored, and the renderer prefers it. The sync only ever copies
   * this forward from the previous Catalog — it never derives a value — so a
   * correction cannot be clobbered by a later run.
   */
  summary_override: string | null;
}

/** Discord snowflakes embed a millisecond timestamp above the low 22 bits. */
const DISCORD_EPOCH = 1420070400000;

export const snowflakeTime = (id: string | null | undefined): string | null => {
  if (!id || !/^\d{17,20}$/.test(id)) return null;
  return new Date(Number(BigInt(id) >> 22n) + DISCORD_EPOCH).toISOString();
};

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const deepLink = (guildId: string, entityId: string) =>
  `https://discord.com/channels/${guildId}/${entityId}`;

export const buildCatalog = async (deps: {
  discord: DiscordReadPort;
  guildId: string;
  previous?: Entity[];
  /** Entities that are visible and readable but are not destinations. */
  exclusions?: Set<string>;
  /** Region gazetteer. Absent means the Region facet stays empty, not wrong. */
  regions?: Gazetteer;
  /** Where to report conditions a human needs to act on. Defaults to silence. */
  warn?: (message: string) => void;
}): Promise<{
  catalog: Entity[];
  roleManifest: RoleManifestEntry[];
  /** IDs that were configured for exclusion AND actually matched something. */
  exclusionsApplied: string[];
}> => {
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
  // headers and voice channels are not readable — neither is a Catalog Entity.
  const containerTypes: number[] = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
  ];
  const excluded = deps.exclusions ?? new Set<string>();
  const allChannels = await deps.discord.listChannels();

  // A Channel is a standing text channel that is not a Forum. Categories are
  // headers and voice channels are not readable — neither is a Catalog Entity.

  // The Catalog describes what a Member can reach. Anything a Member can see
  // and the bot cannot is silently missing from it, so surface it as an alarm
  // rather than letting the Catalog quietly shrink.
  //
  // Only container types count. Categories, voice channels and stats-bot
  // channels are never Entities, and warning about them buries the real gaps
  // in noise — which is how an alarm gets ignored.
  for (const c of allChannels)
    if (containerTypes.includes(c.type) && c.memberVisible && !c.visible)
      deps.warn?.(
        `[visibility] "${c.name}" (${c.id}) is visible to Members but not to ` +
          `the bot, so it is missing from the Catalog.`,
      );

  // Pre-exclusion: a `<#id>` in someone else's description may point at an
  // excluded Entity, and publishing `#unknown-channel` for it would be the
  // very defect this normalisation exists to prevent. Excluded means "not a
  // destination", not "secret".
  const visibleContainers = allChannels.filter(
    (c) => c.visible && containerTypes.includes(c.type),
  );
  const containers = visibleContainers.filter((c) => !excluded.has(c.id));

  // Threads are only enumerated from containers whose content is readable. A
  // withheld Forum must never have its Posts read.
  const allThreads = await deps.discord.listThreads(
    containers.filter((c) => c.contentReadable).map((c) => c.id),
  );
  const threads = allThreads.filter((t) => !excluded.has(t.id));
  const containerType = new Map(containers.map((c) => [c.id, c.type]));
  const tagSets = new Map(
    containers.map((c) => [c.id, new Map((c.availableTags ?? []).map((t) => [t.id, t.name]))]),
  );

  // One entry per name, carrying every ID that name maps to. Duplicate-named
  // roles are an artifact of past bot behaviour and are interchangeable, so a
  // gate on the name must match a member holding any of them.
  // Grouped on name AND colour. Identical on both is treated as the same
  // role; that is the safeguard against merging two genuinely different roles
  // that happen to share a name.
  const grouped = new Map<string, { name: string; color: number; ids: string[] }>();
  for (const r of await deps.discord.listRoles()) {
    // @everyone is excluded deliberately. Its id equals the guild id and it
    // never appears in a member's `roles` array, so a page gated on it would
    // lock out every reader — including full Members.
    if (r.id === deps.guildId) continue;
    const key = `${r.name}\u0000${r.color}`;
    const existing = grouped.get(key);
    if (existing) existing.ids.push(r.id);
    else grouped.set(key, { name: r.name, color: r.color, ids: [r.id] });
  }

  const roleManifest = [...grouped.values()]
    .map((e) => ({ name: e.name, color: e.color, ids: [...e.ids].sort() }))
    .sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.color - b.color,
    );

  const nameCounts = new Map<string, number>();
  for (const e of roleManifest)
    nameCounts.set(e.name, (nameCounts.get(e.name) ?? 0) + 1);

  for (const entry of roleManifest) {
    if (entry.ids.length > 1)
      deps.warn?.(
        `[roles] "${entry.name}" maps to ${entry.ids.length} role IDs ` +
          `(${entry.ids.join(", ")}); same name and colour, so aggregated into ` +
          `one gate. Deleting the redundant roles in Discord would be tidier.`,
      );
    if ((nameCounts.get(entry.name) ?? 0) > 1)
      deps.warn?.(
        `[roles] "${entry.name}" exists with more than one colour and was NOT ` +
          `aggregated. An editor cannot tell these apart in a name-labelled ` +
          `picker — rename one in Discord.`,
      );
  }


  // Discord renders Post and Thread mentions with the same `<#id>` syntax as
  // Channels, so the lookup must cover every Entity. Containers alone left 7
  // real mentions publishing as `#unknown-channel`.
  const names: NameLookup = {
    channels: new Map([
      ...visibleContainers.map((c) => [c.id, c.name] as const),
      ...allThreads.map((t) => [t.id, t.name] as const),
    ]),
    roles: new Map(
      roleManifest.flatMap((r) => r.ids.map((id) => [id, r.name] as const)),
    ),
  };


  const regions = deps.regions ?? new Map();

  // Discord hands back tag IDs; the Catalog publishes names. An unresolvable
  // ID is dropped rather than published: a snowflake in the output is the
  // defect the whole render path exists to prevent, and a Post silently
  // losing a tag is the lesser failure — so it is warned about, not hidden.
  const tagNames = (t: RawThread): string[] => {
    const known = tagSets.get(t.parentId);
    return t.appliedTags.flatMap((id) => {
      const name = known?.get(id);
      if (name) return [name];
      deps.warn?.(
        `[tags] "${t.name}" (${t.id}) carries tag ${id}, which its Forum's tag ` +
          `set does not define. Dropped rather than published as a snowflake.`,
      );
      return [];
    });
  };

  const fromContainer = (c: RawChannel): Entity => {
    const topic = c.contentReadable
      ? normaliseDescription(c.topic, names)
      : null;
    return {
      id: c.id,
      type: c.type === ChannelType.GuildForum ? "forum" : "channel",
      name: c.name,
      url: deepLink(deps.guildId, c.id),
      parent_id: null,
      description_status: !c.contentReadable
        ? "withheld"
        : topic
          ? "present"
          : "absent",
      topic,
      applied_tags: [],
      region: matchRegions(c.name, regions),
      last_message_id: c.lastMessageId ?? null,
      last_activity_at: snowflakeTime(c.lastMessageId),
      summary_generated: null,
      summary_override: overrides.get(c.id) ?? null,
    };
  };

  const fromThread = (t: RawThread): Entity => {
    const first = normaliseDescription(t.firstPost, names);
    return {
      id: t.id,
      // A Post lives in a Forum; a Thread lives in a Channel. Same underlying
      // object, different Entity — only a Post carries applied_tags.
      type:
        containerType.get(t.parentId) === ChannelType.GuildForum
          ? "post"
          : "thread",
      name: t.name,
      url: deepLink(deps.guildId, t.id),
      parent_id: t.parentId,
      description_status: first ? "present" : "absent",
      topic: first,
      applied_tags: tagNames(t),
      region: matchRegions(t.name, regions),
      last_message_id: t.lastMessageId ?? null,
      last_activity_at: snowflakeTime(t.lastMessageId),
      summary_generated: null,
      summary_override: overrides.get(t.id) ?? null,
    };
  };

  // Editors pick a role by name; Access gates store the ID. Regenerating the
  // manifest each run means a rename updates the display name while every
  // gate keeps working, and a deleted role simply stops matching.
  return {
    // Sorted by ID: Discord does not promise a stable order, and an unsorted
    // Catalog would produce a reordered commit on every scheduled run.
    catalog: [...containers.map(fromContainer), ...threads.map(fromThread)].sort(
      byId,
    ),
    roleManifest,
    exclusionsApplied: [
      ...visibleContainers.filter((c) => excluded.has(c.id)).map((c) => c.id),
      ...allThreads.filter((t) => excluded.has(t.id)).map((t) => t.id),
    ].sort(),
  };
};
