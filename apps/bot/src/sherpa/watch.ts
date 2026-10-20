/**
 * User Monitoring (#52, docs/proposals/user-monitoring.md, ADR-0003): a
 * time-limited watch on one member under triggers Staff write, with Sherpa's
 * observations posted to the member's Post in `📊︱user-monitoring`.
 *
 * For holders of the `Staff` role alone (O7). A watch lasts up to 90 days
 * (D52-2) under at most 5 triggers. The member's new messages, from places a
 * Member can see, are buffered in memory for up to 30 minutes or 20 messages,
 * then one observation call reads them with the Post's history. `none` posts
 * nothing; `note` posts; `alert` posts and pings the setter alone (D52-7).
 * Sherpa adds up to 2 of the Forum's tags and never removes one (D52-5).
 * When the member leaves, the watch ends and Sherpa notes it, quoting up to 5
 * of their last messages, clipped (D52-6; owner, 2026-10-19).
 *
 * The only writes go to the member's own Post, resolved from
 * `monitoring_post`; the Forum is a constant. Sherpa never deletes a post.
 * The Forum is under the Staff category, so it is never in the Catalog.
 *
 * Logs carry ids and counts only.
 */
import {
  type APIChatInputApplicationCommandInteraction,
  type APIEmbed,
  type APIMessage,
  ApplicationCommandOptionType,
  ChannelType,
  MessageSearchSortMode,
  type RESTGetAPIGuildMessagesSearchQuery,
  type RESTGetAPIGuildMessagesSearchResult,
  type RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import type { Boundary, ModerationMessage } from "../llm/boundary.ts";
import { moderationPlace } from "../llm/moderation.ts";
import type { Entity } from "../sync/catalog.ts";
import { DURABLE_STORE_PATH, openDurableDatabase } from "../sync/durable-store.ts";
import { clip, plainName } from "./find.ts";
import type { DailyCap } from "./interactions.ts";
import type { ChannelAccess } from "./responder.ts";

/** `📊︱user-monitoring` (owner, 2026-10-18). */
export const WATCH_FORUM = "1534214620976254977";
/** How Sherpa finds its own reviews (`/sherpa analyse`) in a member's Post. */
export const REVIEW_TITLE = "Member review";
export const MAX_WATCH_DAYS = 90;
export const MAX_TRIGGERS = 5;
export const MAX_TRIGGER_CHARS = 200;
export const MAX_WATCHES = 10;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const BUFFER_MS = 30 * MINUTE;
const BUFFER_MAX = 20;
const MEMBER_DAILY = 24;
const QUOTED = 5;
const QUOTE_CHARS = 200;
const OPENING_TAG = "Monitor Activity";

// --- the store -----------------------------------------------------------

export interface Watch {
  memberId: string;
  setBy: string;
  setAt: string;
  expiresAt: string;
  triggers: string[];
  /** When they left the server: the departure note is still to be posted (D52-6). */
  leftAt: string | null;
}

export const openWatchStore = (path: string = DURABLE_STORE_PATH) => {
  const db = openDurableDatabase(path);
  const toWatch = (r: Record<string, string>): Watch => ({
    memberId: r["member_id"]!,
    setBy: r["set_by"]!,
    setAt: r["set_at"]!,
    expiresAt: r["expires_at"]!,
    triggers: JSON.parse(r["triggers"]!) as string[],
    leftAt: r["left_at"] ?? null,
  });
  return {
    watches: (): Watch[] =>
      (db.prepare("SELECT * FROM watch ORDER BY set_at").all() as Array<Record<string, string>>).map(toWatch),
    watch: (memberId: string): Watch | null => {
      const row = db.prepare("SELECT * FROM watch WHERE member_id = ?").get(memberId) as Record<string, string> | undefined;
      return row ? toWatch(row) : null;
    },
    /** Whether a watch on this member could start: one of theirs is replaced, or fewer than 10 others run. */
    hasRoom: (memberId: string): boolean =>
      (db.prepare("SELECT COUNT(*) AS n FROM watch WHERE member_id != ?").get(memberId) as { n: number }).n < MAX_WATCHES,
    /** One watch per member: starting again replaces it. False when 10 others are already running. */
    start: (w: Omit<Watch, "leftAt">): boolean => {
      const others = (db.prepare("SELECT COUNT(*) AS n FROM watch WHERE member_id != ?").get(w.memberId) as { n: number }).n;
      if (others >= MAX_WATCHES) return false;
      db.prepare(
        `INSERT INTO watch (member_id, set_by, set_at, expires_at, triggers) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (member_id) DO UPDATE SET set_by = excluded.set_by, set_at = excluded.set_at,
           expires_at = excluded.expires_at, triggers = excluded.triggers, left_at = NULL`,
      ).run(w.memberId, w.setBy, w.setAt, w.expiresAt, JSON.stringify(w.triggers));
      return true;
    },
    /** Durably, so the departure note is retried until it posts, whatever the checks say meanwhile. */
    markLeft: (memberId: string, at: string): boolean =>
      db.prepare("UPDATE watch SET left_at = ? WHERE member_id = ? AND left_at IS NULL").run(at, memberId).changes === 1,
    end: (memberId: string): boolean => db.prepare("DELETE FROM watch WHERE member_id = ?").run(memberId).changes === 1,
    post: (memberId: string): string | null =>
      (db.prepare("SELECT post_id FROM monitoring_post WHERE member_id = ?").get(memberId) as { post_id: string } | undefined)
        ?.post_id ?? null,
    /** When the member's Post is gone from the Forum: the next watch, or flush, makes or links another. */
    /** Only while it still points at `postId`: a Post made meanwhile is never let go by a stale call. */
    unlinkPost: (memberId: string, postId: string): boolean =>
      db.prepare("DELETE FROM monitoring_post WHERE member_id = ? AND post_id = ?").run(memberId, postId).changes === 1,
    /** Once per member, and a Post belongs to one member only. */
    linkPost: (memberId: string, postId: string, by: string): boolean =>
      db.prepare("INSERT OR IGNORE INTO monitoring_post (member_id, post_id, linked_by) VALUES (?, ?, ?)").run(memberId, postId, by)
        .changes === 1,
    close: () => db.close(),
  };
};

export type WatchStore = ReturnType<typeof openWatchStore>;

export const withWatchStore = <T>(work: (store: WatchStore) => T, path: string = DURABLE_STORE_PATH): T => {
  const store = openWatchStore(path);
  try {
    return work(store);
  } finally {
    store.close();
  }
};

// --- the runtime -----------------------------------------------------------

/** A message as the gateway delivers it, as much of it as the watch reads. */
export type WatchedMessage = Pick<APIMessage, "id" | "channel_id" | "content" | "timestamp" | "webhook_id"> & {
  author: { id: string; bot?: boolean };
};

export interface WatchDeps {
  guildId: string;
  discord: {
    member: (userId: string) => Promise<{ names: string[]; serverName: string; username: string } | null>;
    /** A Channel or Thread: its type, parent and lock. Null when it is gone (a 404); lost access throws. */
    channel: (id: string) => Promise<{ type: number; parent_id?: string | null; locked?: boolean } | null>;
    forumTags: () => Promise<Array<{ id: string; name: string }>>;
    /** The bot's access to the Forum, with whether it may write in its Posts. */
    access: () => Promise<(ChannelAccess & { threads: boolean; memberVisible: boolean }) | null>;
    /** The raw writes. The write port sends; `setTags` only adds tags to a Post the port just wrote to. */
    createPost: (forumId: string, body: { name: string; message: RESTPostAPIChannelMessageJSONBody; applied_tags: string[] }) => Promise<{ id: string }>;
    send: (postId: string, body: RESTPostAPIChannelMessageJSONBody) => Promise<{ id: string }>;
    setTags: (postId: string, tagIds: string[]) => Promise<unknown>;
    /** The Post's newest 50 messages, in any order. */
    postMessages: (postId: string) => Promise<APIMessage[]>;
    postTags: (postId: string) => Promise<string[]>;
    search: (query: RESTGetAPIGuildMessagesSearchQuery) => Promise<RESTGetAPIGuildMessagesSearchResult>;
    /** Sherpa's own user id: only its messages in a Post are its earlier observations. */
    botId: () => Promise<string>;
  };
  store: <T>(work: (store: WatchStore) => T) => T;
  session: () => {
    catalog: Entity[];
    memberRoles: readonly string[];
    excluded: ReadonlySet<string>;
    boundary: Pick<Boundary, "observeMember">;
  };
  retrying: <T>(work: () => Promise<T>) => Promise<T>;
  /** Observation calls a day, across every watch (`SHERPA_WATCH_DAILY_CAP`). */
  cap: Pick<DailyCap, "take">;
  now: () => number;
  log: (message: string) => void;
}

/**
 * The one write port. Its targets come from `monitoring_post` and the Forum
 * constant, never from a caller: a Post that is not the member's cannot be
 * written to. Pings only the user given, and nobody when none is.
 */
export const forumPort = (deps: Pick<WatchDeps, "store"> & Pick<WatchDeps["discord"], "createPost" | "send" | "channel">) => ({
  create: async (memberId: string, name: string, opening: string, tagIds: string[], by: string): Promise<string> => {
    const { id } = await deps.createPost(WATCH_FORUM, {
      name,
      message: { content: opening, allowed_mentions: { parse: [] } },
      applied_tags: tagIds,
    });
    if (!deps.store((s) => s.linkPost(memberId, id, by))) throw new Error("The member already has a Post. The new one is left unused.");
    return id;
  },
  write: async (memberId: string, content: string, ping: string | null, embeds?: APIEmbed[]): Promise<{ postId: string; id: string }> => {
    const postId = deps.store((s) => s.post(memberId));
    if (!postId) throw new Error("The member has no Post. Nothing is written.");
    // The mapping is checked against Discord, so no stored id can point a write anywhere but the Forum.
    if ((await deps.channel(postId))?.parent_id !== WATCH_FORUM) throw new Error("The member's Post is not in the Forum. Nothing is written.");
    const sent = await deps.send(postId, {
      content,
      ...(embeds ? { embeds } : {}),
      allowed_mentions: { parse: [], users: ping ? [ping] : [] },
    });
    return { postId, id: (sent as { id: string }).id };
  },
});

const inert = (text: string): string => plainName(text);
const at = (iso: string, style: "R" | "F" = "R") => `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;

export const createWatch = (deps: WatchDeps) => {
  const { log } = deps;
  const port = forumPort({ store: deps.store, createPost: deps.discord.createPost, send: deps.discord.send, channel: deps.discord.channel });
  /** Why a watch is paused, for `list`. */
  const paused = new Map<string, string>();
  /** One Post being made per member at a time, so two starts cannot make two. */
  const making = new Map<string, Promise<string>>();
  let ready = false;
  let watched = new Set<string>();
  const buffers = new Map<string, { firstAt: number; messages: Array<WatchedMessage & { origin: string }> }>();
  const daily = new Map<string, { day: string; count: number; pausedNoted?: boolean }>();
  const parents = new Map<string, { type: number; parent_id?: string | null } | null>();
  const date = () => new Date(deps.now());
  const today = () => date().toISOString().slice(0, 10);
  const link = (channelId: string, messageId: string) => `https://discord.com/channels/${deps.guildId}/${channelId}/${messageId}`;

  const reload = () => {
    watched = new Set(deps.store((s) => s.watches()).map((w) => w.memberId));
    for (const id of buffers.keys()) if (!watched.has(id)) buffers.delete(id);
  };

  /**
   * Where a message may come from (ADR-0003): a Catalog place a Member can
   * see, or a public, unexcluded Thread under one. Null drops it. The Forum
   * is not in the Catalog, so nothing written there is read back as the
   * member's.
   */
  const originOf = async (channelId: string, session: ReturnType<WatchDeps["session"]>): Promise<string | null> => {
    const byId = new Map(session.catalog.map((e) => [e.id, e]));
    if (byId.has(channelId)) return moderationPlace(channelId, byId, session.memberRoles) ? channelId : null;
    if (!parents.has(channelId)) parents.set(channelId, await deps.discord.channel(channelId));
    const thread = parents.get(channelId);
    // Only a public Thread stands in for its parent: anything else not in the Catalog is not yet a place.
    const publicThread = thread?.type === ChannelType.PublicThread || thread?.type === ChannelType.AnnouncementThread;
    if (!thread || !publicThread || !thread.parent_id || session.excluded.has(channelId)) return null;
    return moderationPlace(thread.parent_id, byId, session.memberRoles) ? thread.parent_id : null;
  };

  /**
   * The member's Post, made if they have none: titled with their server name
   * and username (D52-4). It holds Staff's reviews of them as well as the
   * watch (owner, 2026-10-20), so its opening names neither.
   */
  const ensurePost = async (watch: Pick<Watch, "memberId" | "setBy">, byWatch = true): Promise<string> => {
    const existing = deps.store((s) => s.post(watch.memberId));
    if (existing) {
      // A Post Staff deleted, or moved out of the Forum, is let go and replaced, so the watch is never wedged on it.
      if ((await deps.discord.channel(existing))?.parent_id === WATCH_FORUM) return existing;
      deps.store((s) => s.unlinkPost(watch.memberId, existing));
      // Another call may have replaced it while this one checked.
      const meanwhile = deps.store((s) => s.post(watch.memberId));
      if (meanwhile) return meanwhile;
      log(`[watch] member ${watch.memberId}: their Post ${existing} is gone; a new one is made`);
    }
    const inProgress = making.get(watch.memberId);
    if (inProgress) return inProgress;
    const made = makePost(watch, byWatch).finally(() => making.delete(watch.memberId));
    making.set(watch.memberId, made);
    return made;
  };
  const makePost = async (watch: Pick<Watch, "memberId" | "setBy">, byWatch: boolean): Promise<string> => {
    const member = await deps.discord.member(watch.memberId);
    const name = clip(member ? `${member.serverName} (${member.username})` : watch.memberId, 100);
    const opening = `Sherpa's Post on <@${watch.memberId}>: Staff's reviews and watches of this member.`;
    // Tagged as monitored only when a watch makes it: a review alone is not monitoring.
    const tag = byWatch ? (await deps.discord.forumTags()).find((t) => t.name === OPENING_TAG) : undefined;
    return port.create(watch.memberId, name, opening, tag ? [tag.id] : [], watch.setBy);
  };

  /** Adds tags by name, never removing one, within Discord's 5 a Post. */
  const addTags = async (postId: string, names: readonly string[]) => {
    if (!names.length) return;
    const available = await deps.discord.forumTags();
    const current = await deps.discord.postTags(postId);
    const added = available.filter((t) => names.includes(t.name) && !current.includes(t.id)).map((t) => t.id);
    if (added.length) await deps.discord.setTags(postId, [...current, ...added].slice(0, 5));
  };

  /** Spends one observation call: the member's 24 a day and the 200 across every watch. Each attempt counts, retries too. */
  const spend = (memberId: string): boolean => {
    const count = daily.get(memberId)?.day === today() ? daily.get(memberId)! : { day: today(), count: 0 };
    daily.set(memberId, count);
    if (count.count >= MEMBER_DAILY || !deps.cap.take()) return false;
    count.count++;
    return true;
  };

  const flush = async (memberId: string) => {
    const buffer = buffers.get(memberId);
    buffers.delete(memberId);
    const watch = deps.store((s) => s.watch(memberId));
    if (!buffer?.messages.length || !watch || watch.leftAt || !ready || Date.parse(watch.expiresAt) <= deps.now()) return;
    const postId = await ensurePost(watch);
    if ((await deps.discord.channel(postId))?.locked) {
      paused.set(memberId, "their Post is locked");
      log(`[watch] member ${memberId}: their Post is locked; the watch is paused`);
      return;
    }
    paused.delete(memberId);
    const session = deps.session();
    const member = await deps.discord.member(memberId);
    const me = await deps.discord.botId();
    // Sherpa's own earlier observations, and Staff's notes. Any other bot's or webhook's words are not history.
    const post = (await deps.discord.postMessages(postId))
      .filter((m) => m.author.id === me || (!m.author.bot && !m.webhook_id))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const tags = (await deps.discord.forumTags()).map((t) => t.name);
    const messages: ModerationMessage[] = buffer.messages.map((m, n) => ({
      n,
      date: m.timestamp.slice(0, 10),
      place: session.catalog.find((e) => e.id === m.origin)?.name ?? "",
      source: { authorId: memberId, authorIsBot: false, content: m.content, origin: m.origin },
    }));
    let capped = false;
    let observation;
    try {
      observation = await deps.retrying(() => {
        if (!spend(memberId)) {
          capped = true;
          return Promise.reject(new Error("the daily cap is reached"));
        }
        return session.boundary.observeMember(
          { memberId, memberNames: member?.names ?? [], otherNames: [], memberRoles: session.memberRoles },
          {
            triggers: watch.triggers,
            post: post.map((m) => ({ authorId: m.author.id, authorIsBot: m.author.id === me, content: m.content })),
            tags,
            messages,
          },
        );
      });
    } catch (error) {
      log(`[watch] member ${memberId}: ${capped ? "the daily cap is reached" : "the observation failed"}; ${messages.length} messages dropped: ${(error as Error).message.slice(0, 160)}`);
      const count = daily.get(memberId)!;
      if (capped && !count.pausedNoted) {
        count.pausedNoted = true;
        await port.write(memberId, "Sherpa: observations are paused until the next UTC day: the daily cap is reached.", null);
      }
      return;
    }
    // The same watch, still running: a replaced one has other triggers and another setter.
    const still = deps.store((s) => s.watch(memberId));
    if (!still || still.setAt !== watch.setAt || still.leftAt || Date.parse(still.expiresAt) <= deps.now() || !ready) return;
    if (observation.level === "none") {
      log(`[watch] member ${memberId}: nothing to note in ${messages.length} messages`);
      return;
    }
    const cited = observation.cites.map((n, i) => `[${i + 1}](${link(buffer.messages[n]!.channel_id, buffer.messages[n]!.id)})`);
    // Fitted after escaping, which can double Staff's triggers and the model's text, so the post always fits.
    const content = [
      `Sherpa observation · ${observation.level} · watch set by <@${still.setBy}> · ends ${at(still.expiresAt)}`,
      ...(observation.matched.length
        ? [clip(`Matched: ${observation.matched.map((i) => inert(still.triggers[i] ?? "")).join("; ")}`, 500)]
        : []),
      `> ${clip(inert(observation.observation), 800)}`,
      ...(cited.length ? [`Messages: ${cited.join(" ")}`] : []),
    ].join("\n");
    await port.write(memberId, content, observation.level === "alert" ? still.setBy : null);
    await addTags(postId, observation.tags).catch((error: Error) => log(`[watch] member ${memberId}: tags not added: ${error.message.slice(0, 160)}`));
    log(`[watch] member ${memberId}: ${observation.level} posted, ${messages.length} messages, ${cited.length} cited`);
  };

  /** Up to 5 of the member's newest messages from places a Member can see, quoted and clipped (D52-6). */
  const lastWords = async (memberId: string): Promise<string[]> => {
    const session = deps.session();
    const byId = new Map(session.catalog.map((e) => [e.id, e]));
    const result = await deps.discord.search({
      author_id: [memberId],
      limit: 25,
      sort_by: MessageSearchSortMode.Timestamp,
      sort_order: "desc",
      include_nsfw: true,
    });
    if (!("messages" in result)) return [];
    const threads = new Map((result.threads ?? []).map((t) => [t.id, t]));
    return result.messages
      .map((g) => g.find((m) => m.author.id === memberId) ?? g[0]!)
      .filter((m) => {
        if (m.author.id !== memberId) return false;
        if (byId.has(m.channel_id)) return moderationPlace(m.channel_id, byId, session.memberRoles);
        const t = threads.get(m.channel_id);
        return !!t && (t.type === ChannelType.PublicThread || t.type === ChannelType.AnnouncementThread) && !!t.parent_id && !session.excluded.has(t.id) && moderationPlace(t.parent_id, byId, session.memberRoles);
      })
      .slice(0, QUOTED)
      .map((m) => `> ${clip(inert(m.content) || "(no text)", QUOTE_CHARS)}\n${link(m.channel_id, m.id)}`);
  };

  /**
   * The note that a watched member left, with their last messages, then the
   * watch's end. A failure leaves the watch marked, for the next tick to retry.
   */
  const noting = new Set<string>();
  const noteDeparture = async (memberId: string) => {
    const watch = deps.store((s) => s.watch(memberId));
    if (!watch?.leftAt || noting.has(memberId)) return;
    // Retried until the watch would have ended, then given up: never a row past its 90 days.
    if (Date.parse(watch.expiresAt) <= deps.now()) {
      deps.store((s) => s.end(memberId));
      reload();
      log(`[watch] member ${memberId}: the departure note never posted; the watch ended at its expiry`);
      return;
    }
    noting.add(memberId);
    try {
      const postId = await ensurePost(watch);
      // A locked Post cannot be written to: no search is spent on a note that cannot post.
      if ((await deps.discord.channel(postId))?.locked) throw new Error("their Post is locked");
      const quoted = await lastWords(memberId);
      await port.write(
        memberId,
        [
          `Sherpa note · <@${memberId}> left the server ${at(watch.leftAt, "F")}. The watch has ended.`,
          ...(quoted.length ? ["Their last messages:", ...quoted] : []),
        ].join("\n"),
        null,
      );
      deps.store((s) => s.end(memberId));
      reload();
      log(`[watch] member ${memberId}: the departure is noted, ${quoted.length} messages quoted; the watch ended`);
    } catch (error) {
      log(`[watch] member ${memberId}: the departure note failed, retried next tick: ${(error as Error).message.slice(0, 160)}`);
    } finally {
      noting.delete(memberId);
    }
  };

  return {
    /** `MESSAGE_CREATE`: everything but a watched member's own is dropped on the spot, unstored and unlogged. */
    onMessage: async (message: WatchedMessage): Promise<void> => {
      if (!watched.has(message.author.id) || !ready || message.author.bot || message.webhook_id) return;
      const origin = await originOf(message.channel_id, deps.session());
      if (!origin) return;
      const buffer = buffers.get(message.author.id) ?? { firstAt: deps.now(), messages: [] };
      buffers.set(message.author.id, buffer);
      buffer.messages.push({ ...message, origin });
      if (buffer.messages.length >= BUFFER_MAX) await flush(message.author.id);
    },

    /** `MESSAGE_DELETE` and `MESSAGE_DELETE_BULK`: a deleted message leaves the buffer at once. */
    onDelete: (ids: readonly string[]): void => {
      for (const buffer of buffers.values()) buffer.messages = buffer.messages.filter((m) => !ids.includes(m.id));
    },

    /** `GUILD_MEMBER_REMOVE`: the watch ends, and Sherpa notes the departure in their Post (D52-6). */
    onLeave: async (memberId: string): Promise<void> => {
      buffers.delete(memberId);
      // Recorded first, whatever the checks say: Discord will not tell Sherpa twice.
      if (!deps.store((s) => s.markLeft(memberId, date().toISOString()))) return;
      log(`[watch] member ${memberId}: left`);
      if (ready) await noteDeparture(memberId);
    },

    /** Each minute: buffers past 30 minutes flush, departure notes still owed are posted, and watches past their end close. */
    tick: async (): Promise<void> => {
      const now = deps.now();
      // One member's failure is theirs alone: the rest of the tick goes on.
      const each = async (memberId: string, work: () => Promise<unknown>) =>
        work().catch((error: Error) => log(`[watch] member ${memberId}: ${error.message.slice(0, 160)}`));
      for (const [id, buffer] of [...buffers]) if (now - buffer.firstAt >= BUFFER_MS) await each(id, () => flush(id));
      for (const watch of deps.store((s) => s.watches())) {
        if (watch.leftAt) {
          if (ready) await noteDeparture(watch.memberId);
          continue;
        }
        if (Date.parse(watch.expiresAt) > now) continue;
        buffers.delete(watch.memberId);
        if (!deps.store((s) => s.end(watch.memberId))) continue;
        if (ready && deps.store((s) => s.post(watch.memberId)))
          await each(watch.memberId, () => port.write(watch.memberId, `Sherpa: the watch on <@${watch.memberId}> has ended.`, null));
        log(`[watch] member ${watch.memberId}: the watch expired`);
      }
      reload();
    },

    /** At startup and hourly. The watches pause, loudly, if the Forum is in the Catalog or the bot cannot work there. */
    check: async (): Promise<boolean> => {
      const failures: string[] = [];
      try {
        if (deps.session().catalog.some((e) => e.id === WATCH_FORUM)) {
          failures.push("#user-monitoring is in the Catalog");
          ready = false;
        }
        const access = await deps.discord.access();
        if (!access?.view || !access.send || !access.threads || !access.history)
          failures.push("#user-monitoring cannot be viewed, posted in, written to in its Posts and read");
        // Observations name a person: a Forum Members could read is never written to.
        if (access?.memberVisible) failures.push("#user-monitoring is visible to the Member role");
      } catch (error) {
        failures.push(`the checks could not be made: ${(error as Error).message.slice(0, 160)}`);
      }
      ready = failures.length === 0;
      if (!ready) log(`[watch] CHECKS FAILED, WATCHES PAUSED: ${failures.join("; ")}.`);
      reload();
      return ready;
    },

    /**
     * `/sherpa analyse`'s home (owner, 2026-10-20): reviews post to the
     * member's Post, in the Forum's full view, and a recent one is linked
     * instead of run again.
     */
    reviews: {
      writable: (): boolean => ready,
      /** A link to Sherpa's newest review in the member's Post within `withinMs`, from its newest 50 messages. */
      last: async (memberId: string, withinMs: number): Promise<string | null> => {
        const postId = deps.store((s) => s.post(memberId));
        if (!postId || (await deps.discord.channel(postId))?.parent_id !== WATCH_FORUM) return null;
        const botId = await deps.discord.botId();
        const review = (await deps.discord.postMessages(postId))
          .filter((m) => m.author.id === botId && m.embeds[0]?.title === REVIEW_TITLE && deps.now() - Date.parse(m.timestamp) < withinMs)
          .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
        return review ? link(postId, review.id) : null;
      },
      /** Posts a review to the member's Post, made if they have none. Returns its link. */
      post: async (memberId: string, by: string, content: string, embeds: APIEmbed[]): Promise<string> => {
        const postId = await ensurePost({ memberId, setBy: by }, false);
        if ((await deps.discord.channel(postId))?.locked) throw new Error("their Post is locked");
        const { id } = await port.write(memberId, content, null, embeds);
        return link(postId, id);
      },
    },

    /** The `/sherpa watch` subcommands, for a holder of the `Staff` role the dispatcher already checked. */
    answer: async (interaction: APIChatInputApplicationCommandInteraction, tag: string): Promise<string | null> => {
      const by = interaction.member?.user.id;
      const group = interaction.data.options?.[0];
      if (!by || group?.type !== ApplicationCommandOptionType.SubcommandGroup || group.name !== "watch") return null;
      const sub = group.options[0];
      const value = (name: string) => sub?.options?.find((o) => o.name === name)?.value;
      switch (sub?.name) {
        case "list": {
          const all = deps.store((s) => s.watches());
          log(`${tag} watch list ${all.length}`);
          if (!all.length) return "No members are being watched.";
          return [
            ...(ready ? [] : ["**Watches are paused: Sherpa's checks are failing.**"]),
            ...all.map((w) => {
              const post = deps.store((s) => s.post(w.memberId));
              const why = w.leftAt ? "left the server; the note is pending" : paused.get(w.memberId);
              return `• <@${w.memberId}> · set by <@${w.setBy}> · ends ${at(w.expiresAt)}${post ? ` · <#${post}>` : ""}${why ? ` · **paused: ${why}**` : ""}`;
            }),
          ].join("\n");
        }
        case "stop": {
          const memberId = value("member");
          if (typeof memberId !== "string") return null;
          const ended = deps.store((s) => s.end(memberId));
          buffers.delete(memberId);
          reload();
          log(`${tag} watch stop ${memberId} by ${by}${ended ? "" : " (none)"}`);
          // In the Post's full view, as every watch change is (owner, 2026-10-20).
          const noted =
            !ended ||
            !deps.store((s) => s.post(memberId)) ||
            (ready &&
              (await port.write(memberId, `Sherpa: the watch on <@${memberId}> was stopped by <@${by}>.`, null).then(
                () => true,
                (error: Error) => (log(`${tag} watch stop notice not posted: ${error.message.slice(0, 160)}`), false),
              )));
          return ended
            ? `Done. The watch on <@${memberId}> has stopped.` + (noted ? "" : " **The stop couldn't be noted in the Post.**")
            : `<@${memberId}> isn't being watched.`;
        }
        case "start": {
          const memberId = value("member");
          const days = value("days");
          const raw = value("triggers");
          const postLink = value("post");
          if (typeof memberId !== "string" || typeof days !== "number" || typeof raw !== "string") return null;
          if (interaction.data.resolved?.users?.[memberId]?.bot) return "Sherpa doesn't watch bots.";
          if (!Number.isInteger(days) || days < 1 || days > MAX_WATCH_DAYS) return `Give \`days\` as a whole number from 1 to ${MAX_WATCH_DAYS}.`;
          const triggers = raw.split(";").map((t) => t.trim()).filter(Boolean);
          if (!triggers.length || triggers.length > MAX_TRIGGERS || triggers.some((t) => [...t].length > MAX_TRIGGER_CHARS))
            return `Give 1 to ${MAX_TRIGGERS} triggers, separated by \`;\`, each at most ${MAX_TRIGGER_CHARS} characters.`;
          if (!deps.store((s) => s.hasRoom(memberId))) return `${MAX_WATCHES} members are already being watched. Stop one first.`;
          if (typeof postLink === "string") {
            const postId = /(\d{17,20})\/?$/.exec(postLink.trim())?.[1];
            const post = postId ? await deps.discord.channel(postId) : null;
            if (!postId || !post || post.parent_id !== WATCH_FORUM) return `That isn't a Post in <#${WATCH_FORUM}>.`;
            const current = deps.store((s) => s.post(memberId));
            if (current && current !== postId) {
              if ((await deps.discord.channel(current))?.parent_id === WATCH_FORUM) return `<@${memberId}> already has a Post: <#${current}>.`;
              deps.store((s) => s.unlinkPost(memberId, current));
            }
            if (deps.store((s) => s.post(memberId)) !== postId && !deps.store((s) => s.linkPost(memberId, postId, by)))
              return `<#${postId}> is already another member's Post.`;
          }
          const setAt = date();
          const watch: Omit<Watch, "leftAt"> = {
            memberId,
            setBy: by,
            setAt: setAt.toISOString(),
            expiresAt: new Date(setAt.getTime() + days * DAY).toISOString(),
            triggers,
          };
          const replacing = deps.store((s) => s.watch(memberId)) !== null;
          if (!deps.store((s) => s.start(watch))) return `${MAX_WATCHES} members are already being watched. Stop one first.`;
          reload();
          log(`${tag} watch ${replacing ? "replaced" : "start"} ${memberId} by ${by} for ${days} days, ${triggers.length} triggers`);
          // The Post now, so Staff have it from the start; a failure here leaves it to the first observation.
          paused.delete(memberId);
          // Escaping can double a trigger, so five long ones are clipped to one message.
          const notice = clip(
            [
              `Sherpa: a watch on <@${memberId}> was ${replacing ? "replaced" : "started"} by <@${by}>. It ends ${at(watch.expiresAt, "F")}.`,
              "Triggers:",
              ...triggers.map((t, i) => `${i + 1}. ${inert(t)}`),
            ].join("\n"),
            2000,
          );
          const postId = ready
            ? await ensurePost(watch).catch((error: Error) => (log(`${tag} watch post not made: ${error.message.slice(0, 160)}`), null))
            : null;
          const noted =
            postId !== null &&
            (await port.write(memberId, notice, null).then(
              () => true,
              (error: Error) => (log(`${tag} watch notice not posted: ${error.message.slice(0, 160)}`), false),
            ));
          return (
            `Done. <@${memberId}> is watched until ${at(watch.expiresAt, "F")}, under ${triggers.length} trigger${triggers.length === 1 ? "" : "s"}.` +
            (replacing ? " This replaces the earlier watch." : "") +
            (postId ? ` Observations go to <#${postId}>.` : " Its Post couldn't be made yet: Sherpa makes it with the first observation.") +
            (noted ? "" : " **The start couldn't be noted in the Post.**") +
            (ready ? "" : " **Watches are paused: Sherpa's checks are failing.**")
          );
        }
      }
      return null;
    },
  };
};

export type WatchRuntime = ReturnType<typeof createWatch>;
