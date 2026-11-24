/**
 * The Catalog snapshot the site pulls from the bot (ADR-0001, "Bot → site").
 *
 * The site pulls in the background, accepts a snapshot only when it is
 * complete and valid, and keeps the last one it accepted in memory and in a
 * file beside EmDash's database. The file is a cache, not replicated: a lost
 * one is pulled again from the bot. A rejected snapshot never replaces or
 * merges into the accepted one; Staff are alerted instead. There is no maximum
 * snapshot age: a snapshot two scheduled syncs old is served, marked stale.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./auth.ts";

/** One place in the Catalog: the bot's `Entity` (apps/bot/src/sync/catalog.ts), as carried. */
export interface CatalogEntity {
  id: string;
  type: "channel" | "forum" | "post" | "thread";
  name: string;
  url: string;
  parent_id: string | null;
  description_status: "present" | "absent" | "withheld";
  topic: string | null;
  applied_tags: string[];
  region: string[];
  topics: string[];
  topics_version: number | null;
  thread_state: "open" | "closed" | "locked" | null;
  last_message_id: string | null;
  last_activity_at: string | null;
  summary_generated: string | null;
  summary_override: string | null;
  allow_roles?: string[];
  view_roles?: string[];
  deny_roles?: string[];
}

export interface RoleManifestEntry {
  name: string;
  color: number;
  ids: string[];
}

/**
 * A Discord Scheduled Event, as the bot carries it. Discord returns only the
 * next occurrence of a recurring event; the site expands the rest from
 * `recurrence` (src/events.ts). Weekdays are Discord's: 0 is Monday.
 */
export interface SnapshotEvent {
  id: string;
  name: string;
  description: string | null;
  /** ISO 8601. For a recurring event, its first occurrence. */
  start: string;
  /** Discord's next occurrence, or the one running; every earlier occurrence is over. */
  next: string;
  end: string | null;
  status: "scheduled" | "active" | "completed" | "canceled";
  entity_type: "stage" | "voice" | "external";
  /** The stage or voice channel; null for an external event. */
  channel_id: string | null;
  /** An external event's place: free text, or a discord.com/channels link. */
  location: string | null;
  image_url: string | null;
  recurrence: null | {
    frequency: "yearly" | "monthly" | "weekly" | "daily";
    interval: number;
    by_weekday: number[] | null;
    by_n_weekday: Array<{ n: number; day: number }> | null;
    by_month: number[] | null;
    by_month_day: number[] | null;
    end: string | null;
    count: number | null;
  };
  /** Starts of occurrences canceled one at a time. */
  canceled_starts: string[];
  /** Occurrences moved one at a time: the rule's `from` happens at `start` instead. */
  moved: Array<{ from: string; start: string; end: string | null }>;
}

/** The envelope the bot serves at `GET /snapshot`, version 1. */
export interface SnapshotEnvelope {
  version: 1;
  /** When the bot's current generation was written by a complete sync. ISO 8601. */
  generatedAt: string;
  /** The bot's scheduled sync cadence, so the site can tell a missed sync. */
  syncEveryMs: number;
  outcome: { complete: true } | { complete: false; failed: Array<{ id: string; reason: string }> };
  roleManifest: RoleManifestEntry[];
  catalog: CatalogEntity[];
  /** Entity id → members' messages in about the last week. A place the bot does not read has none. */
  weeklyMessages?: Record<string, number>;
  /** Discord's Scheduled Events. A bot older than events sends none, which is no events. */
  events?: SnapshotEvent[];
}

/** The last snapshot the site accepted, and whether two scheduled syncs have since been missed. */
export interface SnapshotView {
  snapshot: SnapshotEnvelope;
  stale: boolean;
}

const PULL_EVERY_MS = 60_000;
const STALE_GRACE_MS = 60 * 60_000;
const MAX_PROBLEMS = 5;
// #bot-tests, the Staff channel the bot's shadow posts use (owner, 2026-11-17).
const STAFF_CHANNEL = "1544502247587582033";

const snapshotPath = () =>
  process.env["SITE_SNAPSHOT_PATH"] ?? `${process.env["SITE_EMDASH_DIR"] ?? ".data"}/catalog-snapshot.json`;

// Validation. A problem names a field path and what is wrong with it, never
// the value: names, topics and summaries are member content, and problems go
// to Discord and the logs.

type Check = (value: unknown) => string | null;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str: Check = (v) => (typeof v === "string" ? null : "not a string");
const strOrNull: Check = (v) => (v === null || typeof v === "string" ? null : "not a string or null");
// The Index formats it as a date, and an unparseable one would fail every render.
const dateOrNull: Check = (v) =>
  v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v))) ? null : "not a date or null";
const strs: Check = (v) => (Array.isArray(v) && v.every((s) => typeof s === "string") ? null : "not a list of strings");
const intOrNull: Check = (v) => (v === null || Number.isInteger(v) ? null : "not an integer or null");
const oneOf =
  (...values: Array<string | null>): Check =>
  (v) =>
    values.includes(v as string | null) ? null : `not one of ${values.map(String).join("|")}`;
const date: Check = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? null : "not a date");
const ints =
  (min: number, max: number): Check =>
  (v) =>
    v === null || (Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= min && n <= max))
      ? null
      : `not null or a list of integers ${min}-${max}`;
const link: Check = (v) =>
  typeof v === "string" && v.startsWith("https://discord.com/channels/") ? null : "not a Discord channel link";

type Optional = "allow_roles" | "view_roles" | "deny_roles";
const ENTITY: Record<Exclude<keyof CatalogEntity, Optional>, Check> = {
  id: str,
  type: oneOf("channel", "forum", "post", "thread"),
  name: str,
  url: link,
  parent_id: strOrNull,
  description_status: oneOf("present", "absent", "withheld"),
  topic: strOrNull,
  applied_tags: strs,
  region: strs,
  topics: strs,
  topics_version: intOrNull,
  thread_state: oneOf("open", "closed", "locked", null),
  last_message_id: strOrNull,
  last_activity_at: dateOrNull,
  summary_generated: strOrNull,
  summary_override: strOrNull,
};
const OPTIONAL: Optional[] = ["allow_roles", "view_roles", "deny_roles"];

// Every date is formatted on the events page, and an unparseable one would fail every render.
const EVENT: Record<Exclude<keyof SnapshotEvent, "recurrence">, Check> = {
  id: str,
  name: str,
  description: strOrNull,
  start: date,
  next: date,
  end: dateOrNull,
  status: oneOf("scheduled", "active", "completed", "canceled"),
  entity_type: oneOf("stage", "voice", "external"),
  channel_id: strOrNull,
  location: strOrNull,
  image_url: strOrNull,
  canceled_starts: (v) => (Array.isArray(v) && v.every((s) => date(s) === null) ? null : "not a list of dates"),
  moved: (v) =>
    Array.isArray(v) &&
    v.every((m) => isObject(m) && date(m["from"]) === null && date(m["start"]) === null && (m["end"] === null || date(m["end"]) === null))
      ? null
      : "not a list of { from, start, end } dates",
};
const RECURRENCE: Record<keyof NonNullable<SnapshotEvent["recurrence"]>, Check> = {
  frequency: oneOf("yearly", "monthly", "weekly", "daily"),
  interval: (v) => (Number.isInteger(v) && (v as number) > 0 ? null : "not a positive integer"),
  by_weekday: ints(0, 6),
  by_n_weekday: (v) =>
    v === null ||
    (Array.isArray(v) && v.every((x) => isObject(x) && ints(1, 5)([x["n"]]) === null && ints(0, 6)([x["day"]]) === null))
      ? null
      : "not null or a list of { n: 1-5, day: 0-6 }",
  by_month: ints(1, 12),
  by_month_day: ints(1, 31),
  end: dateOrNull,
  count: intOrNull,
};

/**
 * Whether `raw` is a snapshot the site may serve: version 1, complete, and
 * every field of the envelope and its Entities of the right type. Fields the
 * bot adds later pass through unchecked.
 */
export function validateSnapshot(raw: unknown): { ok: true; snapshot: SnapshotEnvelope } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const at = (path: string, problem: string | null) => {
    if (problem) problems.push(`${path}: ${problem}`);
  };
  if (!isObject(raw)) return { ok: false, problems: ["snapshot: not an object"] };

  at("version", raw["version"] === 1 ? null : "not 1");
  const outcome = raw["outcome"];
  if (!isObject(outcome)) at("outcome", "not an object");
  else if (outcome["complete"] !== true) {
    const failed = outcome["failed"];
    at("outcome", Array.isArray(failed) ? `incomplete (${failed.length} containers failed)` : "incomplete");
  }
  const generatedAt = raw["generatedAt"];
  at("generatedAt", typeof generatedAt === "string" && !Number.isNaN(Date.parse(generatedAt)) ? null : "not a date");
  const every = raw["syncEveryMs"];
  at("syncEveryMs", typeof every === "number" && Number.isFinite(every) && every > 0 ? null : "not a positive number");

  const roles = raw["roleManifest"];
  if (!Array.isArray(roles)) at("roleManifest", "not a list");
  else
    roles.forEach((role: unknown, i) => {
      if (!isObject(role)) return at(`roleManifest[${i}]`, "not an object");
      at(`roleManifest[${i}].name`, str(role["name"]));
      at(`roleManifest[${i}].color`, Number.isInteger(role["color"]) ? null : "not an integer");
      at(`roleManifest[${i}].ids`, strs(role["ids"]));
    });

  const weekly = raw["weeklyMessages"];
  if (weekly !== undefined)
    at(
      "weeklyMessages",
      isObject(weekly) && Object.values(weekly).every((n) => Number.isSafeInteger(n) && (n as number) >= 0)
        ? null
        : "not a map of counts",
    );

  const events = raw["events"];
  if (events !== undefined) {
    if (!Array.isArray(events)) at("events", "not a list");
    else
      events.forEach((event: unknown, i) => {
        if (!isObject(event)) return at(`events[${i}]`, "not an object");
        for (const [field, check] of Object.entries(EVENT)) at(`events[${i}].${field}`, check(event[field]));
        const rule = event["recurrence"];
        if (rule === null) return;
        if (!isObject(rule)) return at(`events[${i}].recurrence`, "not an object or null");
        for (const [field, check] of Object.entries(RECURRENCE)) at(`events[${i}].recurrence.${field}`, check(rule[field]));
      });
  }

  const catalog = raw["catalog"];
  if (!Array.isArray(catalog)) at("catalog", "not a list");
  else if (catalog.length === 0) at("catalog", "empty");
  else {
    const seen = new Set<unknown>();
    catalog.forEach((entity: unknown, i) => {
      if (!isObject(entity)) return at(`catalog[${i}]`, "not an object");
      for (const [field, check] of Object.entries(ENTITY)) at(`catalog[${i}].${field}`, check(entity[field]));
      for (const field of OPTIONAL) if (field in entity) at(`catalog[${i}].${field}`, strs(entity[field]));
      if (seen.has(entity["id"])) at(`catalog[${i}].id`, "duplicate");
      seen.add(entity["id"]);
    });
  }

  return problems.length ? { ok: false, problems } : { ok: true, snapshot: raw as unknown as SnapshotEnvelope };
}

function parse(text: string): ReturnType<typeof validateSnapshot> {
  try {
    return validateSnapshot(JSON.parse(text));
  } catch {
    return { ok: false, problems: ["snapshot: not JSON"] };
  }
}

// State, per process.

let accepted: SnapshotEnvelope | null = null;
let acceptedEtag: string | null = null;
let started = false;
let inFlight: Promise<void> | undefined;
let failing = false;
let staleAlerted = false;
// ponytail: one entry per distinct reason, cleared by a good snapshot or a restart.
const alertedReasons = new Set<string>();
// Whether Staff alerts are failing to post, so a lasting outage logs once, not every minute.
let alertsFailing = false;

const isStale = (s: SnapshotEnvelope, now = Date.now()) =>
  now - Date.parse(s.generatedAt) > 2 * s.syncEveryMs + STALE_GRACE_MS;

/** The last accepted snapshot, or null when the site has never accepted one. */
export function currentSnapshot(): SnapshotView | null {
  return accepted && { snapshot: accepted, stale: isStale(accepted) };
}

/**
 * Logs `content` and posts it to Staff; whether Discord took it. Never throws.
 * At least once: a reply lost after Discord accepted the post (a timeout) is
 * a failure, so the next pull may post it again.
 */
async function alertStaff(content: string): Promise<boolean> {
  if (!alertsFailing) console.error(`[snapshot] ${content}`);
  let failure: unknown;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${STAFF_CHANNEL}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${env("DISCORD_BOT_TOKEN")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      alertsFailing = false;
      return true;
    }
    failure = `status ${res.status}`;
  } catch (error) {
    failure = error;
  }
  if (!alertsFailing) console.error("[snapshot] Staff alert failed; retrying each pull, logged once:", failure);
  alertsFailing = true;
  return false;
}

/** Reads the file the last accepted snapshot was written to. A bad file is not served. */
function load() {
  let text: string;
  try {
    text = readFileSync(snapshotPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[snapshot] Cannot read the saved snapshot; serving none:", error);
    return;
  }
  const result = parse(text);
  if (result.ok) accepted = result.snapshot;
  else console.error(`[snapshot] The saved snapshot is invalid; serving none. Problems: ${result.problems.slice(0, MAX_PROBLEMS).join("; ")}`);
}

/** Replaces the accepted snapshot whole, in memory and then on disk. */
function accept(snapshot: SnapshotEnvelope, etag: string | null) {
  accepted = snapshot;
  acceptedEtag = etag;
  // A problem that comes back after a good snapshot is news again.
  alertedReasons.clear();
  const path = snapshotPath();
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, JSON.stringify(snapshot));
    renameSync(temp, path);
  } catch (error) {
    console.error("[snapshot] Cannot save the accepted snapshot; a restart will serve the previous one:", error);
  }
}

async function reject(problems: string[]) {
  const shown = problems.slice(0, MAX_PROBLEMS).join("; ");
  const more = problems.length > MAX_PROBLEMS ? `; and ${problems.length - MAX_PROBLEMS} more` : "";
  const reason = `${shown}${more}`;
  if (alertedReasons.has(reason)) return;
  const kept = accepted ? `keeps the one generated ${accepted.generatedAt}` : "has none yet, so it shows as unavailable";
  // Marked only once Discord has it, so an alert lost to an outage goes again on the next pull.
  if (await alertStaff(`Site: rejected a Catalog snapshot from the bot; the Index ${kept}. Problems: ${reason}.`))
    alertedReasons.add(reason);
}

/** Fetches the bot's snapshot and accepts or rejects it. A failed fetch keeps what is served. */
async function pull(url: string) {
  let res: Response;
  let text = "";
  try {
    res = await fetch(url, {
      headers: acceptedEtag ? { "If-None-Match": acceptedEtag } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 200 && res.status !== 304) throw new Error(`status ${res.status}`);
    if (res.status === 200) text = await res.text();
  } catch (error) {
    // One log per run of failures. A long outage reaches Staff as staleness.
    if (!failing) console.error("[snapshot] Pulling the bot's snapshot failed; serving the last accepted:", error);
    failing = true;
    return;
  }
  failing = false;
  if (res.status === 304) return;
  // A 200 whose body is not JSON is the bot's fault, not the network's: a rejection.
  const result = parse(text);
  if (result.ok) accept(result.snapshot, res.headers.get("ETag"));
  else await reject(result.problems);
}

async function tick() {
  const url = process.env["BOT_SNAPSHOT_URL"];
  if (url) await pull(url);
  const stale = accepted !== null && isStale(accepted);
  if (!stale) staleAlerted = false;
  else if (!staleAlerted)
    staleAlerted = await alertStaff(
      `Site: the Catalog snapshot was generated ${accepted!.generatedAt} and two scheduled syncs have since been missed, so the Index marks it out of date.`,
    );
}

/** One pull and staleness check. A call while one runs shares it, so two never overlap. */
export function pullOnce(): Promise<void> {
  return (inFlight ??= tick().finally(() => (inFlight = undefined)));
}

/** Loads the last accepted snapshot from disk and starts pulling. Idempotent. */
export function startSnapshotPuller(): void {
  if (started) return;
  started = true;
  load();
  if (!process.env["BOT_SNAPSHOT_URL"]) {
    console.error("[snapshot] BOT_SNAPSHOT_URL is not set; serving the saved snapshot, if any, and not pulling.");
    return;
  }
  void pullOnce();
  setInterval(() => void pullOnce(), PULL_EVERY_MS).unref();
}
