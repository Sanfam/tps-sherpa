/**
 * The guild's Discord Scheduled Events, as the site's calendar reads them from
 * the Catalog snapshot (owner, 2026-11-19). Read over REST each sync; no
 * intent or scope beyond the bot's own.
 *
 * Who created an event is read here, to honour their opt-out, and goes no
 * further: no creator, creator id, user count or subscriber is stored or
 * carried.
 */
import { snowflakeTime } from "./catalog.ts";
import { resolveIdentifiers, type NameLookup } from "./normalise.ts";
import type { DiscordReadPort, RawScheduledEvent } from "./ports.ts";

export interface SnapshotEvent {
  /** The event's snowflake. */
  id: string;
  name: string;
  /** Null when there is none, or its creator has turned processing off. */
  description: string | null;
  /**
   * When it starts. For a recurring event, the series' first occurrence,
   * `recurrence_rule.start`, so the site can lay every occurrence out from the
   * rule: Discord moves `scheduled_start_time` on to the next occurrence each
   * time one passes. Discord defines `start` as required on every rule; the
   * fallback is for a payload without it.
   */
  start: string;
  /** When that occurrence ends: the next occurrence's length, from `start`. */
  end: string | null;
  /**
   * Discord's next occurrence (or the current one, while it runs). Any
   * occurrence the rule yields before it is over, even one an organiser ended early.
   */
  next: string;
  status: "scheduled" | "active" | "completed" | "canceled";
  entity_type: "stage" | "voice" | "external";
  /** Stage and voice events. */
  channel_id: string | null;
  /** External events: `entity_metadata.location`, a link or free text. */
  location: string | null;
  image_url: string | null;
  recurrence: null | {
    frequency: "yearly" | "monthly" | "weekly" | "daily";
    interval: number;
    /** 0 = Monday … 6 = Sunday, as Discord numbers them. */
    by_weekday: number[] | null;
    by_n_weekday: Array<{ n: number; day: number }> | null;
    by_month: number[] | null;
    by_month_day: number[] | null;
    /** The last moment an occurrence may start, inclusive. */
    end: string | null;
    count: number | null;
  };
  /** Starts of occurrences cancelled one at a time; the rule still yields them. */
  canceled_starts: string[];
  /** Occurrences moved one at a time: the rule still yields `from`, which happens at `start` instead. */
  moved: Array<{ from: string; start: string; end: string | null }>;
}

const iso = (t: string) => new Date(t).toISOString();
const STATUS = [, "scheduled", "active", "completed", "canceled"] as const;
const ENTITY_TYPE = [, "stage", "voice", "external"] as const;
const FREQUENCY = ["yearly", "monthly", "weekly", "daily"] as const;

/** Where an event may point: the guild, and the places its Catalog holds. */
export interface Places {
  guildId: string;
  known: ReadonlySet<string>;
}

const CHANNEL_LINK = /(?<![\w./-])https:\/\/discord\.com\/channels\/(\d+)\/(\d+)(?:\/\d+)?/g;

/**
 * Member-written text, with no member's snowflake left in it. Markup goes
 * through `resolveIdentifiers`. A discord.com/channels link stays only when it
 * is this guild's and names a place the Catalog holds, cut to guild and
 * Channel (a message id could be anything); any other becomes `[link]`, as
 * either slot could carry a member's id. Then every remaining snowflake goes.
 */
const scrub = (text: string, names: NameLookup, places: Places) => {
  const links: string[] = [];
  // A digit written as `%3n` is still a digit: decoded, so an encoded id is scrubbed too.
  const plain = text.replaceAll("\u0000", "").replace(/%3([0-9])/gi, "$1");
  return resolveIdentifiers(plain, names)
    .replace(CHANNEL_LINK, (_, guild: string, place: string) =>
      guild === places.guildId && places.known.has(place)
        ? `\u0000${links.push(`https://discord.com/channels/${guild}/${place}`) - 1}\u0000`
        : "[link]",
    )
    .replace(/(?<!\d)\d{17,20}(?!\d)/g, "[id]")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => links[Number(i)]!);
};

/**
 * The guild's external events as Discord lists them now.
 *
 * External events only: Discord shows every Member an external event, but a
 * stage or voice event only to those who can see its channel, which is a
 * per-member permission the site cannot check (the Catalog holds no voice
 * channels). None of the guild's events is one (2026-11-19).
 */
// ponytail: stage and voice events are left out; carry them with a per-viewer channel check when the guild holds one.
export const readEvents = async (
  discord: DiscordReadPort,
  /** Read once Discord has answered, so an opt-out made while it was asked still counts. */
  optedOut: () => ReadonlySet<string>,
  names: NameLookup,
  places: Places,
): Promise<SnapshotEvent[]> => {
  const raw = await discord.listScheduledEvents();
  const out = optedOut();
  return raw
    .filter((e) => ENTITY_TYPE[e.entity_type] === "external")
    // An opted-out organiser's event is not processed at all: a title, place or
    // cover could say who they are as well as a description could. A missing
    // creator id is an event too old to say whose it is: left out too.
    .filter((e) => e.creator_id && !out.has(e.creator_id))
    .map((e) => {
      const rule = e.recurrence_rule;
      const start = iso(rule?.start ?? e.scheduled_start_time);
      // A series' length is read off its next occurrence, unless that one was
      // edited on its own: then its times say nothing of the others, and the
      // length is left unknown rather than given to every night.
      const exceptions = e.guild_scheduled_event_exceptions ?? [];
      const nextStart = iso(e.scheduled_start_time);
      const nextEdited = exceptions.some(
        (x) => snowflakeTime(x.event_exception_id) === nextStart || (x.scheduled_start_time && iso(x.scheduled_start_time) === nextStart),
      );
      const length = e.scheduled_end_time && !nextEdited
        ? Date.parse(e.scheduled_end_time) - Date.parse(e.scheduled_start_time)
        : null;
      return {
          id: e.id,
          // Members may mention one another anywhere they can type: no snowflake crosses to the site.
          name: scrub(e.name, names, places),
          description: e.description ? scrub(e.description, names, places) : null,
          start,
          next: nextStart,
          end: length === null ? null : new Date(Date.parse(start) + length).toISOString(),
          status: STATUS[e.status]!,
          entity_type: ENTITY_TYPE[e.entity_type]!,
          channel_id: e.channel_id ?? null,
          location: e.entity_metadata?.location ? scrub(e.entity_metadata.location, names, places) : null,
          image_url: e.image ? `https://cdn.discordapp.com/guild-events/${e.id}/${e.image}.png?size=1024` : null,
          recurrence: rule && {
            frequency: FREQUENCY[rule.frequency],
            interval: rule.interval,
            by_weekday: rule.by_weekday,
            by_n_weekday: rule.by_n_weekday,
            by_month: rule.by_month,
            by_month_day: rule.by_month_day,
            end: rule.end && iso(rule.end),
            count: rule.count,
          },
          // Undocumented by Discord. An exception's id is the snowflake of the
          // occurrence's original start, which is what the rule yields; its
          // `scheduled_start_time` is a moved occurrence's new start, if any.
          canceled_starts: (e.guild_scheduled_event_exceptions ?? [])
            .filter((x) => x.is_canceled)
            .map((x) => snowflakeTime(x.event_exception_id))
            .filter((t) => t !== null),
          // An occurrence edited on its own: moved, or given a new end, or both.
          moved: exceptions.flatMap((x) => {
            const from = snowflakeTime(x.event_exception_id);
            return !x.is_canceled && from !== null && (x.scheduled_start_time || x.scheduled_end_time)
              ? [{
                  from,
                  start: x.scheduled_start_time ? iso(x.scheduled_start_time) : from,
                  // Discord's next occurrence carries its own end, which the exception may not repeat.
                  end: x.scheduled_end_time
                    ? iso(x.scheduled_end_time)
                    : x.scheduled_start_time && iso(x.scheduled_start_time) === nextStart && e.scheduled_end_time
                      ? iso(e.scheduled_end_time)
                      : null,
                }]
              : [];
          }),
      };
    })
    // One event Discord sends in a shape this does not know (a new status or
    // frequency, an interval of 0) is left out, rather than have the site
    // reject the whole snapshot, Catalog and all, over it.
    .filter((e) => e.status !== undefined && (!e.recurrence || (e.recurrence.frequency !== undefined && e.recurrence.interval >= 1)));
};
