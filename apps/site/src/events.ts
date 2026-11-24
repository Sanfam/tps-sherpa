/**
 * Events as Members see them: Discord's Scheduled Events from the accepted
 * Catalog snapshot, each expanded into its occurrences and put with the club
 * it belongs to.
 */
import { clubs } from "../../../content/config/clubs.json";
import type { SnapshotEvent } from "./catalog-snapshot.ts";

export type Club = (typeof clubs)[number];
export { clubs };

const DAY = 86_400_000;
/** Discord's weekday: 0 is Monday, 6 is Sunday. */
const weekday = (d: Date) => (d.getUTCDay() + 6) % 7;

/**
 * Whether a day after the first occurrence is one the rule recurs on. Discord
 * evaluates its rules in UTC, so the day, weekday and month here are UTC's.
 */
function recursOn(rule: NonNullable<SnapshotEvent["recurrence"]>, first: Date, d: Date): boolean {
  const month = d.getUTCMonth() + 1;
  const date = d.getUTCDate();
  if (rule.by_month && !rule.by_month.includes(month)) return false;
  const days = Math.round((d.getTime() - first.getTime()) / DAY);
  switch (rule.frequency) {
    case "daily":
      return days % rule.interval === 0 && (rule.by_weekday?.includes(weekday(d)) ?? true);
    case "weekly":
      // Fortnightly counts its weeks from the first occurrence. ponytail: 7-day blocks from that
      // day, not calendar weeks, which differs only for a several-weekday rule with interval > 1.
      return Math.floor(days / 7) % rule.interval === 0 && (rule.by_weekday ?? [weekday(first)]).includes(weekday(d));
    case "monthly": {
      const months = (d.getUTCFullYear() - first.getUTCFullYear()) * 12 + d.getUTCMonth() - first.getUTCMonth();
      if (months % rule.interval !== 0) return false;
      // The nth of a weekday in its month: the 8th to the 14th are the second.
      // A month with no fifth one is skipped.
      // ponytail: n is the nth from the start; if Discord's 5 ever means "last", four-weekday months are skipped.
      if (rule.by_n_weekday) return rule.by_n_weekday.some((x) => x.day === weekday(d) && x.n === Math.ceil(date / 7));
      return (rule.by_month_day ?? [first.getUTCDate()]).includes(date);
    }
    case "yearly":
      return (
        (d.getUTCFullYear() - first.getUTCFullYear()) % rule.interval === 0 &&
        (rule.by_month ?? [first.getUTCMonth() + 1]).includes(month) &&
        (rule.by_month_day ?? [first.getUTCDate()]).includes(date)
      );
  }
}

/**
 * The start of every occurrence of `event` from its first up to `until` (ms),
 * less those canceled one at a time. Each keeps the first occurrence's UTC
 * time of day, as Discord's do, so its local time moves an hour across a DST
 * change. `count` counts canceled occurrences too, as RFC 5545 counts excluded ones.
 */
export function occurrenceStarts(event: SnapshotEvent, until: number): number[] {
  const first = Date.parse(event.start);
  const rule = event.recurrence;
  // Compared as instants: the bot's ISO strings need not match ours character for character.
  const canceled = new Set(event.canceled_starts.map(Date.parse));
  const starts = first <= until ? [first] : [];
  if (rule) {
    const last = Math.min(until, rule.end ? Date.parse(rule.end) : Infinity);
    // ponytail: walks day by day from the first occurrence; a few thousand steps for a years-old daily event.
    for (let at = first + DAY; at <= last && (rule.count === null || starts.length < rule.count); at += DAY)
      if (recursOn(rule, new Date(first), new Date(at))) starts.push(at);
  }
  return starts.filter((s) => !canceled.has(s));
}

const CHANNEL_LINK = /https:\/\/discord\.com\/channels\/\d+\/(\d+)/g;

/**
 * The club an event belongs to: its channel is a club's; else it links one of
 * a club's channels; else its name holds one of a club's patterns. Null is
 * an independent event.
 */
export function clubOf(event: SnapshotEvent): Club | null {
  const linked = [...`${event.location ?? ""} ${event.description ?? ""}`.matchAll(CHANNEL_LINK)].map((m) => m[1]!);
  const name = event.name.toLowerCase();
  return (
    clubs.find((c) => event.channel_id !== null && c.channels.includes(event.channel_id)) ??
    clubs.find((c) => linked.some((id) => c.channels.includes(id))) ??
    clubs.find((c) => c.patterns.some((p) => name.includes(p.toLowerCase()))) ??
    null
  );
}

export interface Occurrence {
  /** The event's id and this occurrence's start, unique on a page. */
  key: string;
  name: string;
  description: string | null;
  start: string;
  end: string | null;
  club: Club | null;
  /** Where it happens: free text, or a link into Discord. */
  place: { text: string; href: string | null } | null;
  image: string | null;
  /** Before Discord's next occurrence, so over, even if an organiser ended it early. */
  over: boolean;
  /** Discord's own word that this occurrence is running, as of the last sync. */
  live: boolean;
}

/**
 * Every occurrence up to `until` of the guild's events, earliest first. The
 * bot carries external events only, which Discord shows every Member. A
 * Channel an event links is never named: whether a Member may see it can turn
 * on a deny for that one member, which the site does not hold. A canceled
 * event has no occurrences.
 */
export function eventsView(events: readonly SnapshotEvent[], until: number): Occurrence[] {
  const placeOf = (e: SnapshotEvent): Occurrence["place"] => {
    if (!e.location) return null;
    const link = /^https:\/\/discord\.com\/channels\/\d+\/\d+\/?$/.test(e.location.trim());
    return link ? { text: "Open in Discord", href: e.location.trim() } : { text: e.location, href: null };
  };

  return events
    // External only, should a newer bot ever carry more.
    .filter((e) => e.status !== "canceled" && e.entity_type === "external")
    .flatMap((e) => {
      const length = e.end ? Date.parse(e.end) - Date.parse(e.start) : null;
      const club = clubOf(e);
      const place = placeOf(e);
      const image = e.image_url?.startsWith("https://") ? e.image_url : null;
      const next = Date.parse(e.next);
      const occurrence = (start: number, end: number | null) => ({
        key: `${e.id}-${start}`,
        name: e.name,
        description: e.description,
        start: new Date(start).toISOString(),
        end: end === null ? null : new Date(end).toISOString(),
        club,
        place,
        image,
        // Before Discord's next occurrence, or that one itself once Discord says it is completed.
        over: start < next || (start === next && e.status === "completed"),
        live: start === next && e.status === "active",
      });
      // A moved occurrence leaves the rule's date and happens at its own.
      const movedFrom = new Set(e.moved.map((m) => Date.parse(m.from)));
      return [
        ...occurrenceStarts(e, until)
          .filter((start) => !movedFrom.has(start))
          .map((start) => occurrence(start, length === null ? null : start + length)),
        ...e.moved
          .filter((m) => Date.parse(m.start) <= until)
          .map((m) => occurrence(Date.parse(m.start), m.end ? Date.parse(m.end) : null)),
      ];
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** About three months ahead: how far the events page and club pages look. */
export const horizon = (now: number) => now + 92 * DAY;

/**
 * Whether an occurrence has not yet ended: not before Discord's next one, and
 * not past its end. One with no end counts as running for `UNENDED` after it starts.
 */
// ponytail: a fixed two hours; carry Discord's "active" status per occurrence if one runs longer.
const UNENDED = 2 * 60 * 60_000;
export const upcoming = (o: Occurrence, now: number) =>
  !o.over && (o.end ? Date.parse(o.end) : Date.parse(o.start) + UNENDED) >= now;
