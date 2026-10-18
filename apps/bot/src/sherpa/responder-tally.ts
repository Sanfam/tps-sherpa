/**
 * The shadow review's tally and the go-live notice (docs/proposals/
 * introductions-responder.md §8). A daily pass lists Sherpa's own posts in
 * `#bot-tests`, reads each one's kind from its header and Staff's ✅ ❌ ⚠️
 * reactions, reactor by reactor, and checks the go-live bar. The first time the bar is reached
 * it posts one comment saying so and records it. Going live stays Staff's
 * manual switch: nothing here touches the mode.
 *
 * Every port is injected; the runtime wires Discord and the store.
 */
import type { APIMessage, RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import { SHADOW_CHANNEL } from "./responder.ts";
import type { ResponderStore } from "./responder-store.ts";

/** The bar (§8). */
const BAR_DAYS = 14;
const BAR_POSTS = 30;
/** At least this share of autonomous posts approved, as a fraction. */
const BAR_APPROVED = { of: 5, over: 4 };

const DAY = 24 * 60 * 60 * 1000;
const BY = "tally";
const AUTONOMOUS = new Set(["question", "recommend", "welcome_only"]);
/** The header `shadowPost` writes; the notice and anything else Sherpa says there does not match. */
const HEADER = /^Intro responder \(shadow\) · would POST (\w+) · replying to: /;

export type TallyMessage = Pick<APIMessage, "id" | "author" | "content" | "reactions">;

export interface Counts {
  posts: number;
  /** Staff's reactions, summed: more than one of Staff may react to a post. */
  yes: number;
  no: number;
  warn: number;
}

export interface Tally {
  /** Whole days since `shadow` was first set; null if it never was. */
  days: number | null;
  autonomous: Counts & {
    /** Posts with a ✅ and no ❌: an unreviewed post is not approved. */
    approved: number;
  };
  /** The invited path's replies: listed, but they do not count toward the bar (a ⚠️ on one still blocks it). */
  invited: Counts;
  met: boolean;
}

export interface TallyDeps {
  /** One page of a Channel's messages, newest first, up to 100 before a snowflake. Empty once none are left. */
  messages: (channelId: string, before: string | undefined) => Promise<TallyMessage[]>;
  /**
   * One page of who reacted to a message with an emoji, as user ids, up to 100
   * after a user id (`GET /channels/{id}/messages/{id}/reactions/{emoji}`).
   * `burst` asks for super reactions. Empty once none are left.
   */
  reactors: (query: {
    channelId: string;
    messageId: string;
    emoji: string;
    burst: boolean;
    after: string | undefined;
  }) => Promise<string[]>;
  /** Whether a user is Staff (`STAFF_ROLE_NAMES`, by name through the role manifest). False when not in the guild. */
  staff: (userId: string) => Promise<boolean>;
  /** The responder's checks pass (`Responder.passing`): no notice is posted while they fail. */
  passing: () => boolean;
  botId: string;
  now: () => number;
  /** One connection for one piece of work (`withResponderStore`). */
  store: <T>(work: (store: Pick<ResponderStore, "setting" | "setSetting">) => T) => T;
  monitored: () => ReadonlySet<string>;
  createMessage: (channelId: string, body: RESTPostAPIChannelMessageJSONBody) => Promise<unknown>;
  log: (message: string) => void;
}

const PAGE = 100;

/**
 * Staff's reactions to a post with one emoji. Discord names ⚠️ with or
 * without its variation selector. Each reactor is checked, since a Member
 * with another role, or a member-specific allow, can see #bot-tests while the
 * `Member` role cannot: a reaction from anyone not Staff is ignored. Reactor
 * ids live for the run in `staff` and are never stored or logged.
 */
const reacted = async (
  deps: Pick<TallyDeps, "reactors" | "staff">,
  staff: Map<string, boolean>,
  m: TallyMessage,
  emoji: string,
): Promise<number> => {
  let count = 0;
  for (const r of m.reactions ?? []) {
    const name = r.emoji.name;
    if (!r.count || !name || name.replace(/\uFE0F/g, "") !== emoji) continue;
    for (const burst of r.count_details?.burst ? [false, true] : [false]) {
      let after: string | undefined;
      for (;;) {
        const page = await deps.reactors({ channelId: SHADOW_CHANNEL, messageId: m.id, emoji: name, burst, after });
        for (const id of page) {
          if (!staff.has(id)) staff.set(id, await deps.staff(id));
          if (staff.get(id)) count++;
        }
        if (page.length < PAGE) break;
        after = page.at(-1);
      }
    }
  }
  return count;
};

export const computeTally = async (
  deps: Pick<TallyDeps, "messages" | "reactors" | "staff" | "botId" | "now" | "store">,
): Promise<Tally> => {
  const firstAt = deps.store((s) => s.setting("shadow_first_at"));
  const days = firstAt ? Math.max(0, Math.floor((deps.now() - Date.parse(firstAt)) / DAY)) : null;

  const autonomous = { posts: 0, yes: 0, no: 0, warn: 0, approved: 0 };
  const invited: Counts = { posts: 0, yes: 0, no: 0, warn: 0 };
  /** Each reactor's lookup, once per run, held for the run only. */
  const staff = new Map<string, boolean>();
  let before: string | undefined;
  for (;;) {
    const page = await deps.messages(SHADOW_CHANNEL, before);
    if (!page.length) break;
    for (const m of page) {
      const kind = m.author.id === deps.botId ? HEADER.exec(m.content)?.[1] : undefined;
      if (!kind) continue;
      const counts = AUTONOMOUS.has(kind) ? autonomous : invited;
      const yes = await reacted(deps, staff, m, "✅");
      const no = await reacted(deps, staff, m, "❌");
      const warn = await reacted(deps, staff, m, "⚠");
      counts.posts++;
      counts.yes += yes;
      counts.no += no;
      counts.warn += warn;
      if (counts === autonomous && yes > 0 && no === 0) autonomous.approved++;
    }
    before = page.reduce((low, m) => (BigInt(m.id) < BigInt(low) ? m.id : low), page[0]!.id);
  }

  const met =
    days !== null &&
    days >= BAR_DAYS &&
    autonomous.posts >= BAR_POSTS &&
    autonomous.warn + invited.warn === 0 &&
    autonomous.approved * BAR_APPROVED.of >= autonomous.posts * BAR_APPROVED.over;
  return { days, autonomous, invited, met };
};

const percent = (t: Tally) =>
  t.autonomous.posts ? `${Math.floor((t.autonomous.approved * 100) / t.autonomous.posts)}%` : "n/a";

/** One line per fact, for `/sherpa introductions status` and the notice. */
export const describeTally = (t: Tally): string =>
  [
    `Shadow days: **${t.days ?? "not started"}** (bar ${BAR_DAYS})`,
    `Autonomous posts: **${t.autonomous.posts}** (bar ${BAR_POSTS}), ✅ ${t.autonomous.yes} ❌ ${t.autonomous.no} ⚠️ ${t.autonomous.warn}, approved **${percent(t)}** (bar 80%)`,
    `Invited replies: **${t.invited.posts}**, ✅ ${t.invited.yes} ❌ ${t.invited.no} ⚠️ ${t.invited.warn} (not in the bar; a ⚠️ still blocks it)`,
    `Go-live bar: **${t.met ? "reached" : "not reached"}**`,
  ].join("\n");

/**
 * The daily pass: the tally, and, the first time the bar is reached, the one
 * notice in `#bot-tests`. The notice is recorded before it is sent, so a
 * crash or a failed send costs the notice, never a second one. It runs only
 * while the responder's checks pass, asked again after the reads, since the
 * hourly check may fail during them.
 */
export const runTally = async (deps: TallyDeps): Promise<{ tally: Tally; posted: boolean }> => {
  const paused = () => new Error("The responder's checks are failing. No tally.");
  if (!deps.passing()) throw paused();
  const tally = await computeTally(deps);
  if (!tally.met) return { tally, posted: false };
  if (!deps.passing()) throw paused();
  if (deps.monitored().has(SHADOW_CHANNEL)) throw new Error("The shadow target is monitored. Refusing to post.");
  const claimed = deps.store((s) => {
    if (s.setting("shadow_notice_at")) return false;
    s.setSetting("shadow_notice_at", new Date(deps.now()).toISOString(), BY);
    return true;
  });
  if (!claimed) return { tally, posted: false };
  await deps.createMessage(SHADOW_CHANNEL, {
    content: `The go-live bar for the introductions responder is reached.\n${describeTally(tally)}\nGoing live is Staff's switch: \`/sherpa introductions mode live\`.`,
    allowed_mentions: { parse: [] },
  });
  deps.log("[sherpa] responder: go-live notice posted in #bot-tests");
  return { tally, posted: true };
};
