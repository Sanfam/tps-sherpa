import { matchRegions, type Gazetteer } from "./facets.ts";
import { normaliseDescription, type NameLookup } from "./normalise.ts";
import { ChannelType } from "./ports.ts";
import type {
  DiscordReadPort,
  RawChannel,
  RoleManifestEntry,
  RawThread,
  SyncOutcome,
} from "./ports.ts";

export type EntityType = "channel" | "forum" | "post" | "thread";

export type DescriptionStatus = "present" | "absent" | "withheld";

/**
 * open   - members can reply
 * closed - archived: a mod or the author closed it, or it went idle
 * locked - only a mod can reopen it or reply
 */
export type ThreadState = "open" | "closed" | "locked";

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
  /**
   * The Topic facet: slugs from the frozen vocabulary. The one derived axis —
   * everything else about an Entity is mod-authored or mechanical.
   */
  topics: string[];
  /**
   * Which vocabulary version those slugs were assigned under. Null means never
   * classified. A version bump leaves every Entity stale, which is what makes
   * a bump a full retag rather than a silent drift.
   */
  topics_version: number | null;
  /**
   * Whether a Post or Thread is open, closed or locked, as of the last sync.
   * Null for Channels and Forums, which have no such state. Mechanical, like
   * the Platform and Region facets — from Discord, never derived — and kept
   * out of `identityKey`: closing a Post does not change what it is about.
   */
  thread_state: ThreadState | null;
  /** Newest message. Null if nothing has been posted. */
  last_message_id: string | null;
  /**
   * Derived from the snowflake, not fetched: Discord IDs embed their creation
   * time, so this costs nothing and is exact.
   */
  last_activity_at: string | null;
  /**
   * Bot-owned. Carried forward while the Entity's identity is unchanged and
   * dropped the moment it is not — see `identityKey`. The sync used to blank
   * it every run, which would have meant regenerating 1,253 summaries on the
   * strong model on every scheduled sync to replace them with the same text.
   */
  summary_generated: string | null;
  /**
   * Human-authored, and the renderer prefers it. The sync only ever copies
   * this forward from the previous Catalog — it never derives a value — so a
   * correction cannot be clobbered by a later run.
   */
  summary_override: string | null;
  /**
   * Who can see it in Discord, by role id, as of the last sync (#53):
   *
   * - allow_roles: the role's own overwrite allows it, or the role carries
   *   ADMINISTRATOR. Either shows it whatever else is held.
   * - view_roles: the role shows it, held alone beside @everyone.
   * - deny_roles: the role's own overwrite hides it.
   *
   * A Post or Thread has its parent's. Read only through `visibleTo`, in
   * code: roles never reach a model. Absent on an Entity synced before #53
   * (or, for allow_roles, before it existed), which `visibleTo` shows to
   * nobody until the next sync writes them.
   *
   * A member's own deny is not here: it is member data, kept bot-side only
   * (`member_deny` in the durable store).
   */
  allow_roles?: string[];
  view_roles?: string[];
  deny_roles?: string[];
}

/**
 * Whether a holder of `roles` can see this Entity in Discord, as Discord
 * decides it from role overwrites: @everyone's, then every held role's denies,
 * then every held role's allows, so one role's allow beats another's deny.
 * Hence: a held role allows it, or a held role shows it and none denies it.
 * A place only the bot can see shows to nobody, and one only Staff can see to
 * Staff alone. No access recorded means nobody. A member's own overwrite is
 * `deniedTo`'s.
 */
export const visibleTo = (entity: Entity, roles: readonly string[]): boolean => {
  const { allow_roles: allow, view_roles: view, deny_roles: deny } = entity;
  if (!Array.isArray(allow) || !Array.isArray(view) || !Array.isArray(deny)) return false;
  return (
    roles.some((r) => allow.includes(r)) ||
    (roles.some((r) => view.includes(r)) && !roles.some((r) => deny.includes(r)))
  );
};

/**
 * Whether a member's own overwrite hides this Entity from them. `denied` is
 * their denied places (`readDeniedPlaces`); a Post or Thread is hidden with
 * its parent.
 *
 * ponytail: a member-specific deny wins even over ADMINISTRATOR, which Discord
 * lets bypass it. That fails closed: an administrator denied a place by name
 * is not shown it here, though they can open it. Carry guild-wide admin role
 * ids beside the denies if that case ever matters.
 */
export const deniedTo = (entity: Entity, denied: ReadonlySet<string>): boolean =>
  denied.has(entity.id) || (entity.parent_id !== null && denied.has(entity.parent_id));

/**
 * What an Entity *is*, as far as anything derived from it is concerned.
 *
 * A key that has not moved is a licence to keep what the last enrichment run
 * produced, so **it must cover every field that reaches a model.** That is
 * exactly the set `subjectText` renders — name, type, parent name, mod tags,
 * region, description — and the two must be changed together. Miss one and a
 * Post moved between Forums, or a Forum renamed under its Posts, keeps a
 * summary describing somewhere it no longer is, indefinitely and invisibly.
 *
 * It deliberately excludes activity: a new message in a five-year-old Post
 * does not change what that Post is about, and keying on `last_message_id`
 * would rerun the whole corpus through a model every night.
 */
export const identityKey = (entity: Entity, parent?: Entity | null): string =>
  [
    entity.type,
    entity.name,
    entity.topic ?? "",
    // The parent's NAME, not its id: `subjectText` renders the name, so a
    // rename changes the prompt without changing the parent_id.
    parent?.name ?? "",
    entity.applied_tags.join("\u001f"),
    entity.region.join("\u001f"),
  ].join("\u0000");

/**
 * Validates a previous Catalog carried in from a file: the one-time import of
 * a local `content/index/data.json` when the durable store is first
 * initialised. Overrides are human-authored and carried forward from it, so a
 * file that is not a list of Entities aborts the import rather than starting
 * from less than was there. Starting empty is the store's business, and its
 * initialisation marker says so, not a missing or empty file.
 */
export const parsePrevious = (raw: string): Entity[] => {
  const parsed: unknown = JSON.parse(raw);
  // Checks what is carried forward verbatim. Anything else malformed crashes
  // buildCatalog before a write, which already fails closed.
  // A missing field would be carried forward as null, silently.
  const isEntity = (e: unknown) => {
    if (typeof e !== "object" || e === null) return false;
    const { id, summary_override, summary_generated, topics, topics_version, allow_roles, view_roles, deny_roles } =
      e as Entity;
    const stringOrNull = (v: unknown) => v === null || typeof v === "string";
    // Absent is accepted: a Catalog written before #53 shows its places to
    // nobody (`visibleTo`) until the next sync, rather than its overrides
    // being refused for a field the sync recomputes anyway.
    const roleIds = (v: unknown) =>
      v === undefined || (Array.isArray(v) && v.every((r) => typeof r === "string"));
    return (
      typeof id === "string" &&
      roleIds(allow_roles) &&
      roleIds(view_roles) &&
      roleIds(deny_roles) &&
      stringOrNull(summary_override) &&
      stringOrNull(summary_generated) &&
      Array.isArray(topics) &&
      topics.every((t) => typeof t === "string") &&
      (topics_version === null || Number.isInteger(topics_version))
    );
  };
  if (!Array.isArray(parsed) || !parsed.every(isEntity))
    throw new Error("The previous Catalog is not a list of Entities. Refusing to import it.");
  // Duplicates would make the override lookup pick one silently.
  if (new Set(parsed.map((e: Entity) => e.id)).size !== parsed.length)
    throw new Error("The previous Catalog has duplicate Entity ids. Refusing to import it.");
  // An established Catalog is never empty, so an empty one was truncated.
  if (parsed.length === 0)
    throw new Error("The previous Catalog is empty. Refusing to import it.");
  return parsed as Entity[];
};

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
  /**
   * The monitored-channel ids (#33). Their Threads and Posts are left out of
   * the Catalog entirely (#41): an intro Thread's name may be a member's name,
   * and monitored conversation is extract-and-discard. The Channel stays.
   */
  monitored?: ReadonlySet<string>;
  /** Region gazetteer. Absent means the Region facet stays empty, not wrong. */
  regions?: Gazetteer;
  /** Where to report conditions a human needs to act on. Defaults to silence. */
  warn?: (message: string) => void;
}): Promise<{
  catalog: Entity[];
  roleManifest: RoleManifestEntry[];
  /** IDs that were configured for exclusion AND actually matched something. */
  exclusionsApplied: string[];
  /** Incomplete means this Catalog must not replace the previous one. */
  outcome: SyncOutcome;
  /**
   * Which members their own overwrite hides each Catalog Channel and Forum
   * from. For the durable store alone: never part of the Catalog.
   */
  memberDenies: Array<{ placeId: string; memberId: string }>;
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
  const previousById = new Map((deps.previous ?? []).map((e) => [e.id, e]));

  /**
   * Keeps the derived fields an LLM pass produced, but only while the Entity
   * still means the same thing.
   *
   * Regenerating them every sync would put the whole corpus through a model on
   * every scheduled run for identical output; keeping them unconditionally
   * would leave a renamed Post advertising what it used to be. The identity
   * key is the line between those two.
   */
  const carryDerived = (entity: Entity, currentById: Map<string, Entity>): Entity => {
    const before = previousById.get(entity.id);
    if (!before) return entity;
    const parentNow = entity.parent_id ? currentById.get(entity.parent_id) : null;
    const parentBefore = before.parent_id ? previousById.get(before.parent_id) : null;
    if (identityKey(before, parentBefore) !== identityKey(entity, parentNow)) return entity;
    return {
      ...entity,
      topics: before.topics ?? [],
      topics_version: before.topics_version ?? null,
      summary_generated: before.summary_generated ?? null,
    };
  };

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
  // withheld Forum must never have its Posts read. Excluded containers are
  // enumerated too, for the name lookup alone; their Posts and Threads are
  // dropped below, so they never reach the Catalog. A monitored container is
  // not passed in (#41): Discord's guild-wide active-Threads call still
  // returns its active ones, but the adapter drops them by parent before
  // fetching any first post, so none is stored.
  const monitored = deps.monitored ?? new Set<string>();
  const { threads: allThreads, failed } = await deps.discord.listThreads(
    visibleContainers.filter((c) => c.contentReadable && !monitored.has(c.id)).map((c) => c.id),
  );
  const threads = allThreads.filter((t) => !excluded.has(t.id) && !excluded.has(t.parentId));
  const containerById = new Map(containers.map((c) => [c.id, c]));
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
      topics: [],
      topics_version: null,
      thread_state: null,
      last_message_id: c.lastMessageId ?? null,
      last_activity_at: snowflakeTime(c.lastMessageId),
      summary_generated: null,
      summary_override: overrides.get(c.id) ?? null,
      allow_roles: c.allowRoles,
      view_roles: c.viewRoles,
      deny_roles: c.denyRoles,
    };
  };

  const fromThread = (t: RawThread): Entity => {
    const first = normaliseDescription(t.firstPost, names);
    return {
      id: t.id,
      // A Post lives in a Forum; a Thread lives in a Channel. Same underlying
      // object, different Entity — only a Post carries applied_tags.
      type:
        containerById.get(t.parentId)?.type === ChannelType.GuildForum
          ? "post"
          : "thread",
      name: t.name,
      url: deepLink(deps.guildId, t.id),
      parent_id: t.parentId,
      description_status: first ? "present" : "absent",
      topic: first,
      applied_tags: tagNames(t),
      region: matchRegions(t.name, regions),
      topics: [],
      topics_version: null,
      // Locked outranks closed: a locked Post may also be archived, and what
      // a member needs to know is that they cannot reopen it.
      thread_state: t.locked ? "locked" : t.archived ? "closed" : "open",
      last_message_id: t.lastMessageId ?? null,
      last_activity_at: snowflakeTime(t.lastMessageId),
      summary_generated: null,
      summary_override: overrides.get(t.id) ?? null,
      // Discord gives a Post or Thread its parent's permissions.
      allow_roles: containerById.get(t.parentId)?.allowRoles ?? [],
      view_roles: containerById.get(t.parentId)?.viewRoles ?? [],
      deny_roles: containerById.get(t.parentId)?.denyRoles ?? [],
    };
  };

  // Built before carry-forward runs, because deciding whether a child's
  // enrichment is still valid needs its parent's new name.
  const built = [...containers.map(fromContainer), ...threads.map(fromThread)];
  const builtById = new Map(built.map((e) => [e.id, e]));

  // Editors pick a role by name; Access gates store the ID. Regenerating the
  // manifest each run means a rename updates the display name while every
  // gate keeps working, and a deleted role simply stops matching.
  return {
    // Sorted by ID: Discord does not promise a stable order, and an unsorted
    // Catalog would produce a reordered commit on every scheduled run.
    catalog: built.map((e) => carryDerived(e, builtById)).sort(byId),
    roleManifest,
    exclusionsApplied: [
      ...visibleContainers.filter((c) => excluded.has(c.id)).map((c) => c.id),
      ...allThreads.filter((t) => excluded.has(t.id)).map((t) => t.id),
    ].sort(),
    outcome: failed.length ? { complete: false, failed } : { complete: true },
    memberDenies: containers.flatMap((c) => c.deniedMembers.map((memberId) => ({ placeId: c.id, memberId }))),
  };
};
