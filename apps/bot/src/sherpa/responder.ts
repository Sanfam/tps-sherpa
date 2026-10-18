/**
 * The introductions responder's autonomous path: `#introductions`' gateway
 * events, the watch on each new member's introduction, Sherpa's one post, and
 * the erasure that undoes what it holds
 * (docs/proposals/introductions-responder.md §2–§8).
 *
 * Every port is injected: `run.ts` wires Discord, the durable store and the
 * boundary, and tests use fakes. What is held in memory — the watches, what
 * was extracted, the per-member erasure count — lives here and nowhere else.
 * Others' messages are read mechanically, as they arrive, and only ids and
 * minutes are kept from them (§5).
 *
 * Silence on doubt throughout: an error closes the member's row `failed` and
 * nothing is posted, and a crash between the post's claim and Discord costs
 * the post rather than repeating it (F12).
 *
 * Logs carry member and message ids (D26), never message text, names or image
 * URLs.
 */
import type { APIMessage, RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import { type Boundary, type Extraction, type ImageMeaning, WATCHED_CHANNEL } from "../llm/boundary.ts";
import type { Vocabulary } from "../llm/vocabulary.ts";
import type { Entity } from "../sync/catalog.ts";
import type { Preferences } from "../sync/durable-store.ts";
import { MAX_QUERY_LENGTH, MAX_MESSAGE_CHARS, findPlaces, isCandidate } from "./find.ts";
import type { DailyCap } from "./interactions.ts";
import {
  INVITED_QUESTION,
  type OwnMessage,
  PROCESSING_OFF,
  type PostKind,
  type ReplyKind,
  type ShadowTimeline,
  type TimingSettings,
  WELCOME_ONLY,
  WELCOME_WITH_QUESTION,
  afterCap,
  countsAsIntroduction,
  decide,
  namedPlaces,
  recommendPost,
  shadowPost,
  widestDoors,
} from "./responder-decide.ts";
import { fetchStill, imagesOf } from "./responder-images.ts";
import { type Introduction, MAX_EXCHANGES, type Outcome, type Reason, type ResponderStore } from "./responder-store.ts";
import { timingSettings } from "./sherpa-command.ts";

/** `#bot-tests`: where `shadow` posts go (owner, 2026-10-16). Excluded, and never monitored. */
export const SHADOW_CHANNEL = "1544502247587582033";
/** The Index, where the invited path's last replies point (owner, 2026-10-18). */
export const INDEX_URL = "https://sherpa.omgod.com";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Discord's page size for a Channel's messages. */
const PAGE = 100;
/** Room in a 2,000-character message for the shadow post's header and its `> ` quoting. */
const SHADOW_OVERHEAD = 400;
const BY = "responder";

/** A message in `#introductions`, as the gateway and REST both deliver it. */
export type WatchedMessage = Pick<
  APIMessage,
  | "id"
  | "channel_id"
  | "author"
  | "content"
  | "timestamp"
  | "edited_timestamp"
  | "type"
  | "mentions"
  | "message_reference"
  | "attachments"
  | "embeds"
  | "webhook_id"
  | "referenced_message"
>;

/** What the bot may do in one Channel, from its computed permissions. */
export interface ChannelAccess {
  view: boolean;
  history: boolean;
  send: boolean;
}

/** One model session over the current Catalog: built per call, so each sees today's names and opt-outs. */
export interface Session {
  catalog: Entity[];
  monitored: ReadonlySet<string>;
  vocabulary: Vocabulary;
  boundary: Pick<Boundary, "ask" | "extractIntroduction" | "readImage">;
}

export interface ResponderDeps {
  guildId: string;
  discord: {
    /** `GET /guilds/{guild}/members/{user}`. Null when they are not in the guild. */
    member: (userId: string) => Promise<{ joinedAt: string | null; names: string[] } | null>;
    /** One page of `#introductions`, up to 100 messages after or before a snowflake, in any order. */
    messages: (query: { after: string } | { before: string }) => Promise<WatchedMessage[]>;
    /** One message in `#introductions`. Null once it is deleted (a 404); anything else throws. */
    message: (id: string) => Promise<WatchedMessage | null>;
    /** Whether Message Content is granted, and the bot's access to the two Channels. */
    probe: () => Promise<{ messageContent: boolean; watched: ChannelAccess | null; shadow: ChannelAccess | null }>;
    /** Sherpa's own user id, for telling a mention of it or a reply to it (§9). */
    botId: () => Promise<string>;
    /** The raw send. Only the write port calls it. */
    createMessage: (channelId: string, body: RESTPostAPIChannelMessageJSONBody) => Promise<unknown>;
  };
  /** One connection for one piece of work (`withResponderStore`). */
  store: <T>(work: (store: ResponderStore) => T) => T;
  preferences: (memberId: string) => Preferences;
  /** The monitored ids, checked against the current Catalog (`readMonitored`). */
  monitored: () => ReadonlySet<string>;
  excluded: () => ReadonlySet<string>;
  session: () => Session;
  fetchImage: (url: string, init: RequestInit) => Promise<Response>;
  /** The responder's own cap: 60 paid calls a day, one taken per model call (§11). */
  cap: Pick<DailyCap, "take">;
  now: () => number;
  log: (message: string) => void;
}

/** What a post carries: the reply a member would see, and the counts the shadow post adds (§8). */
export interface PostBody {
  reply: string;
  timeline: ShadowTimeline;
}

/**
 * The one write port (§7). Its only write is `post`, and the target comes from
 * the mode at call time: `shadow` to `#bot-tests` with a jump link to
 * `replyTo`, `live` as an inline reply to `replyTo` in `#introductions`. No
 * channel argument, and Sherpa never deletes a post (F6).
 */
export const writePort = (deps: Pick<ResponderDeps, "guildId" | "monitored" | "store"> & {
  createMessage: ResponderDeps["discord"]["createMessage"];
}) => ({
  post: async (kind: ReplyKind, body: PostBody, replyTo: string): Promise<void> => {
    const mode = deps.store((s) => s.mode());
    const monitored = deps.monitored();
    if (mode === "shadow") {
      if (monitored.has(SHADOW_CHANNEL)) throw new Error("The shadow target is monitored. Refusing to post.");
      const link = `https://discord.com/channels/${deps.guildId}/${WATCHED_CHANNEL}/${replyTo}`;
      await deps.createMessage(SHADOW_CHANNEL, {
        content: shadowPost({ kind, replyingTo: link, timeline: body.timeline, reply: body.reply }),
        allowed_mentions: { parse: [] },
      });
      return;
    }
    if (mode === "live") {
      if (!monitored.has(WATCHED_CHANNEL)) throw new Error("The live target is not monitored. Refusing to post.");
      // The reply ping stays (§7); nobody else is pinged, whatever the text holds.
      await deps.createMessage(WATCHED_CHANNEL, {
        content: body.reply,
        message_reference: { message_id: replyTo },
        allowed_mentions: { parse: [], replied_user: true },
      });
      return;
    }
    throw new Error("The mode is off. Nothing is posted.");
  },
});

/**
 * The match query (§4): life stage, then Topics, then interests, whole items
 * dropped from the end until it fits. Built from the extraction alone, never
 * from what the member wrote.
 */
export const matchQuery = (extraction: Extraction, vocabulary: Vocabulary): string => {
  const labels = new Map(vocabulary.topics.map((t) => [t.slug, t.label]));
  const items = [
    ...extraction.life_stage.map((s) => s.replace(/_/g, " ")),
    ...extraction.topics.map((t) => labels.get(t) ?? t),
    ...extraction.interests,
  ];
  while (items.join(", ").length > MAX_QUERY_LENGTH) items.pop();
  return items.join(", ");
};

/** The snowflake of a moment: an id no message posted at or after it can be below. */
export const snowflakeAt = (ms: number): string => ((BigInt(ms) - 1_420_070_400_000n) << 22n).toString();

const byId = (a: { id: string }, b: { id: string }) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
const fromBot = (m: WatchedMessage) => m.author.bot === true || Boolean(m.webhook_id);
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 160);

/** One member's watch, in memory only (§3, §5). */
interface Watch {
  memberId: string;
  introId: string;
  introAt: number;
  /** Their username, global name and nickname, for redaction. Never logged. */
  names: string[];
  /** The erasure count when the watch began: any erasure since makes it, and every result for it, stale. */
  erasures: number;
  /** Their own messages for `decide`, the intro first. */
  messages: OwnMessage[];
  ownIds: Set<string>;
  /** `id@edited_at` already extracted, so a redelivered event is not paid for twice. */
  handled: Set<string>;
  extraction: Extraction | null;
  /** From others' messages, mechanically: minutes, places named, whether one was a question to them. */
  active: Set<number>;
  named: Set<string>;
  askedByHuman: boolean;
  acknowledgedAt: number | null;
  imageMeaning: ImageMeaning | null;
}

/** One member's invited conversation, in memory only (§5, §9). */
interface Conversation {
  memberId: string;
  /** The erasure count when it began, as a watch's. */
  erasures: number;
  /** Every exchange's extraction, merged. */
  extraction: Extraction | null;
  /** The messages already answered: a redelivered event is dropped, and a delete of one drops the conversation. */
  handled: Set<string>;
  lastAt: number;
}

/** Exchanges add up (§9): a later one keeps what an earlier one found, life stage included. */
const merge = (earlier: Extraction | null, later: Extraction): Extraction =>
  earlier
    ? {
        signal: earlier.signal === "some" || later.signal === "some" ? "some" : "none",
        interests: [...new Set([...earlier.interests, ...later.interests])],
        topics: [...new Set([...earlier.topics, ...later.topics])],
        life_stage: [...new Set([...earlier.life_stage, ...later.life_stage])],
      }
    : later;

/** Whole places off the end, until the reply leaves room for the shadow post's header. */
const fit = (places: readonly Entity[], render: (places: Entity[]) => string): Entity[] => {
  const kept = [...places];
  while (kept.length > 1 && render(kept).length > MAX_MESSAGE_CHARS - SHADOW_OVERHEAD) kept.pop();
  return kept;
};

/** A timeline with nothing in it: the invited path keeps no watch to count. */
const quiet = (clock: TimingSettings["clock"]): ShadowTimeline => ({
  clock,
  acknowledgedAfterMinutes: null,
  activeMinutes: 0,
  extractions: 0,
  noveltyDropped: 0,
  images: 0,
  imageMeaning: null,
});

export const createResponder = (deps: ResponderDeps) => {
  const { log } = deps;
  const watches = new Map<string, Watch>();
  const conversations = new Map<string, Conversation>();
  /** Learned by the checks; until then nothing is taken for an invitation. */
  let botId: string | null = null;
  const erasures = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  /** The checks passed and the seed is complete: nothing is evaluated before both (§2, F2). */
  let ready = false;
  /**
   * `idle`: off or paused, so new messages are dropped and the next catch-up
   * reads them. `catching`: they wait for the catch-up to finish. `live`: they
   * are handled as they come.
   */
  let phase: "idle" | "catching" | "live" = "idle";
  let pending: Array<{ message: WatchedMessage; invitable: boolean }> = [];
  let ticking = false;
  const date = () => new Date(deps.now());
  const erasureCount = (memberId: string) => erasures.get(memberId) ?? 0;

  const post = writePort({ ...deps, createMessage: deps.discord.createMessage }).post;

  /** Drops what is held of a member, and makes every call in flight for them stale (§6, F8). */
  const forget = (memberId: string) => {
    watches.delete(memberId);
    conversations.delete(memberId);
    erasures.set(memberId, erasureCount(memberId) + 1);
  };

  /**
   * One member's work at a time, in arrival order: a tick waits for an
   * extraction in flight, and two events for one member never interleave.
   * An error closes their row `failed`.
   */
  const serial = (memberId: string, work: () => Promise<void>): Promise<void> => {
    const next = (queues.get(memberId) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      log(`[responder] member ${memberId}: ${reason(error)}`);
      const watch = watches.get(memberId);
      try {
        if (watch) close(watch, "failed", "error");
      } catch (closing) {
        log(`[responder] member ${memberId}: could not close their row: ${reason(closing)}`);
      }
    });
    queues.set(memberId, next);
    void next.then(() => {
      if (queues.get(memberId) === next) queues.delete(memberId);
    });
    return next;
  };

  const close = (watch: Watch, outcome: Outcome, why: Reason) => {
    if (watches.get(watch.memberId) === watch) watches.delete(watch.memberId);
    if (deps.store((s) => s.closeIntroduction(watch.memberId, outcome, why, date())))
      log(`[responder] member ${watch.memberId} intro ${watch.introId}: ${outcome} (${why})`);
  };

  /** A claimed post that cannot go: the mode went off, or something else came between. */
  const abandon = (watch: Watch) =>
    deps.store((s) => s.mode()) === "off" ? close(watch, "expired", "off") : close(watch, "failed", "error");

  /**
   * §5's re-check, before every model call and post and after every call
   * returns: no erasure since the watch began, both settings still on, the row
   * still open, and the mode not `off`.
   */
  const current = (watch: Watch): boolean => {
    if (erasureCount(watch.memberId) !== watch.erasures) return false;
    const { approach, processing } = deps.preferences(watch.memberId);
    if (!approach || !processing) return false;
    const { mode, row } = deps.store((s) => ({ mode: s.mode(), row: s.introduction(watch.memberId) }));
    return mode !== "off" && row !== null && row.outcome === null;
  };

  /** Who a paid call is for: the re-check run around it, and what silence means when the cap refuses. */
  interface Guard {
    memberId: string;
    current: () => boolean;
    silence: () => void;
  }
  const watchGuard = (watch: Watch): Guard => ({
    memberId: watch.memberId,
    current: () => current(watch),
    silence: () => close(watch, "failed", "cap"),
  });

  /**
   * One paid call under the guards. Null when a guard or `claim` refused, when
   * the daily cap refused (silence), or when the result came back stale,
   * which is then discarded.
   */
  const paid = async <T>(
    guard: Guard,
    work: (session: Session) => Promise<T>,
    claim: () => boolean = () => true,
  ): Promise<T | null> => {
    if (!guard.current() || !claim()) return null;
    if (!deps.cap.take()) {
      log(`[responder] member ${guard.memberId}: the daily cap is spent`);
      guard.silence();
      return null;
    }
    const result = await work(deps.session());
    if (guard.current()) return result;
    log(`[responder] member ${guard.memberId}: a result came back stale and was discarded`);
    return null;
  };

  /**
   * Messages that fed a row, re-fetched by id, so their text is held for the
   * call only (§5); `fresh` is used as the event gave it. Null if one is gone,
   * which erases the row.
   */
  const refetch = async (ids: readonly string[], fresh: WatchedMessage): Promise<WatchedMessage[] | null> => {
    const messages: WatchedMessage[] = [];
    for (const id of ids) {
      const found = id === fresh.id ? fresh : await deps.discord.message(id);
      if (!found) {
        eraseMessage(id);
        return null;
      }
      messages.push(found);
    }
    return messages;
  };

  /** As the read port built them: author and origin from each message itself, so the boundary can refuse (§4). */
  const sourcesOf = (messages: readonly WatchedMessage[]) =>
    messages.map((m) => ({ authorId: m.author.id, authorIsBot: fromBot(m), content: m.content, origin: m.channel_id }));

  /** A deleted message that fed a watch: its row goes, with a tombstone, and the watch with it (§6). */
  const eraseMessage = (messageId: string) => {
    const memberId = deps.store((s) => s.eraseMessage(messageId, date()));
    if (!memberId) return;
    forget(memberId);
    log(`[responder] member ${memberId}: message ${messageId} deleted, row erased`);
  };

  /**
   * One extraction over every message that fed the watch (§3, §4), the
   * others re-fetched by id: their text is held for the call only (§5).
   * Returns whether this message added signal.
   */
  const extract = async (watch: Watch, message: WatchedMessage): Promise<boolean> => {
    const row = deps.store((s) => s.introduction(watch.memberId));
    const messages = row && (await refetch(row.messages.map((m) => m.id), message));
    if (!messages) return false;
    const before = watch.extraction;
    const result = await paid(
      watchGuard(watch),
      (s) =>
        s.boundary.extractIntroduction({
          memberId: watch.memberId,
          sources: sourcesOf(messages),
          memberNames: watch.names,
          vocabulary: s.vocabulary,
        }),
      () => deps.store((s) => s.claimExtraction(watch.memberId)),
    );
    if (!result) return false;
    watch.extraction = result;
    if (result.signal !== "some") return false;
    const had = new Set([...(before?.interests ?? []), ...(before?.topics ?? [])]);
    return before?.signal !== "some" || [...result.interests, ...result.topics].some((x) => !had.has(x));
  };

  /** A message's images, claimed together, each read as a gesture and never as signal (§4). */
  const readImages = async (watch: Watch, message: WatchedMessage) => {
    const images = imagesOf(message);
    if (!images.length || !current(watch)) return;
    if (!deps.store((s) => s.claimImages(watch.memberId, message.id, images.length))) return;
    for (const image of images) {
      if (!current(watch)) return;
      const dataUrl = await fetchStill(image, deps.fetchImage);
      if (!dataUrl) continue;
      const reading = await paid(watchGuard(watch), (s) =>
        s.boundary.readImage({
          memberId: watch.memberId,
          image: { authorId: message.author.id, origin: message.channel_id, dataUrl },
        }),
      );
      if (reading) watch.imageMeaning = reading.meaning;
    }
  };

  /** The member's own message in their watch: the intro, a follow-up, or an edit of either. */
  const own = async (watch: Watch, message: WatchedMessage) => {
    if (!deps.store((s) => s.recordMessage(watch.memberId, message.id, message.edited_timestamp))) return;
    watch.ownIds.add(message.id);
    const key = `${message.id}@${message.edited_timestamp ?? ""}`;
    if (!watch.handled.has(key)) {
      watch.handled.add(key);
      // Words alone are signal: an image-only message is a greeting (§4).
      const signal = message.content.trim() ? await extract(watch, message) : false;
      const at = Date.parse(message.edited_timestamp ?? message.timestamp);
      watch.messages.push({ at: watch.messages.length ? at : watch.introAt, signal });
    }
    await readImages(watch, message);
  };

  /** Another member's message, read mechanically for every watch it falls in (§3, D10). */
  const notice = (watch: Watch, message: WatchedMessage) => {
    const at = Date.parse(message.timestamp);
    if (at < watch.introAt) return;
    watch.active.add(Math.floor(at / MINUTE));
    for (const id of namedPlaces(message.content)) watch.named.add(id);
    const to = message.message_reference?.message_id;
    if (message.mentions.some((u) => u.id === watch.memberId) || (to !== undefined && watch.ownIds.has(to))) {
      watch.acknowledgedAt ??= at;
      if (message.content.includes("?")) watch.askedByHuman = true;
    }
  };

  const watch = (memberId: string, intro: WatchedMessage, names: string[]): Watch => {
    const w: Watch = {
      memberId,
      introId: intro.id,
      introAt: Date.parse(intro.timestamp),
      names,
      erasures: erasureCount(memberId),
      messages: [],
      ownIds: new Set([intro.id]),
      handled: new Set(),
      extraction: null,
      active: new Set(),
      named: new Set(),
      askedByHuman: false,
      acknowledgedAt: null,
      imageMeaning: null,
    };
    watches.set(memberId, w);
    return w;
  };

  /** A message from someone with no watch: an open row's intro after a restart, or perhaps a new intro (§3). */
  const consider = async (message: WatchedMessage) => {
    const author = message.author.id;
    const { mode, row, onSince } = deps.store((s) => ({
      mode: s.mode(),
      row: s.introduction(author),
      onSince: s.setting("on_since"),
    }));
    if (mode === "off") return;
    if (row && row.outcome === null) {
      // An open row is rebuilt from its intro, read again by the catch-up. Nothing else of it is.
      if (row.postedAt !== null || row.messages[0]?.id !== message.id) return;
      const member = await deps.discord.member(author);
      if (!member) {
        log(`[responder] member ${author}: not in the guild, so their open watch is not rebuilt`);
        return void deps.store((s) => s.closeIntroduction(author, "failed", "error", date()));
      }
      log(`[responder] member ${author} intro ${message.id}: watch rebuilt`);
      return own(watch(author, message, member.names), message);
    }
    // Older than the switch out of `off`: it may feed an open row, never start one (§2, F11).
    if (onSince !== null && Date.parse(message.timestamp) < Date.parse(onSince)) return;
    if (!deps.preferences(author).approach) return;
    // "Never posted before" is the tombstone, which `startIntroduction` checks against `joined_at`.
    if (!countsAsIntroduction(message, false)) return;
    const member = await deps.discord.member(author);
    if (!member?.joinedAt) {
      log(`[responder] member ${author} message ${message.id}: the lookup gave no joined_at, so not evaluated`);
      return;
    }
    // After the last await: the row is one conditional insert (§5).
    if (deps.store((s) => s.mode()) === "off") return;
    const joinedAt = member.joinedAt;
    const started = deps.store((s) =>
      s.startIntroduction(author, { messageId: message.id, editedAt: message.edited_timestamp, joinedAt }, date()),
    );
    if (!started) return;
    log(`[responder] member ${author} intro ${message.id}: watching`);
    await own(watch(author, message, member.names), message);
  };

  // --- the invited path (§9) -------------------------------------------

  /** Mentions Sherpa, or replies to one of its posts. */
  const invites = (message: WatchedMessage): boolean =>
    botId !== null &&
    (message.mentions.some((u) => u.id === botId) || message.referenced_message?.author.id === botId);

  /** Being watched: an open, unposted row. A closed row and a tombstone never hold back an ask (F9). */
  const watched = (memberId: string): boolean => {
    const row = deps.store((s) => s.introduction(memberId));
    return row !== null && row.outcome === null && row.postedAt === null;
  };

  /** A fixed text, with no model call and nothing recorded: processing off, or past the cap. */
  const answerFixed = async (kind: ReplyKind, reply: string, message: WatchedMessage) => {
    const { mode, clock } = deps.store((s) => ({ mode: s.mode(), clock: timingSettings(s).clock }));
    if (mode === "off") return;
    await post(kind, { reply, timeline: quiet(clock) }, message.id);
    log(`[responder] member ${message.author.id} message ${message.id}: answered ${kind}`);
  };

  /** §5's re-check for a conversation: no erasure since it began, still held, processing on, its row there, not `off`. */
  const conversationIsCurrent = (c: Conversation): boolean =>
    erasureCount(c.memberId) === c.erasures &&
    conversations.get(c.memberId) === c &&
    deps.preferences(c.memberId).processing &&
    deps.store((s) => s.mode() !== "off" && s.invitation(c.memberId) !== null);

  /**
   * The widest doors (§9): each match's own Channel or Forum rather than a
   * Post or Thread inside it, once each, so the last reply points at rooms.
   */
  const doorsOf = (matches: readonly Entity[], session: Session): Entity[] => {
    const entities = new Map(session.catalog.map((e) => [e.id, e]));
    const doors = matches.flatMap((e) => {
      const door = e.parent_id ? entities.get(e.parent_id) : e;
      return door && isCandidate(door, entities, session.monitored) ? [door] : [];
    });
    return [...new Set(doors)];
  };

  /**
   * One invited exchange (§9): claimed, then an extraction from the new
   * message and the intro's contributing messages while their row lives,
   * merged into the conversation. Signal is matched with no novelty, since
   * the member asked; otherwise one fixed question. The third exchange
   * answers with the widest doors and ends the conversation.
   */
  const invite = async (message: WatchedMessage) => {
    const memberId = message.author.id;
    const now = deps.now();
    const held = conversations.get(memberId);
    const existing = held && now - held.lastAt < DAY ? held : undefined;
    if (existing?.handled.has(message.id)) return;
    if (deps.store((s) => s.mode()) === "off") return;
    if (!deps.store((s) => s.openInvitation(memberId, date()))) return;
    const images = imagesOf(message);
    const granted = deps.store((s) => s.claimExchange(memberId, images.length, date()));
    if (granted === null) return answerFixed("after_cap", afterCap(INDEX_URL), message);

    const conversation: Conversation = existing ?? {
      memberId,
      erasures: erasureCount(memberId),
      extraction: null,
      handled: new Set(),
      lastAt: now,
    };
    conversation.handled.add(message.id);
    conversation.lastAt = now;
    conversations.set(memberId, conversation);
    const exchange = deps.store((s) => s.invitation(memberId))?.exchanges ?? MAX_EXCHANGES;
    const last = exchange >= MAX_EXCHANGES;
    const guard: Guard = {
      memberId,
      current: () => conversationIsCurrent(conversation),
      silence: () => {
        if (conversations.get(memberId) === conversation) conversations.delete(memberId);
      },
    };
    log(`[responder] member ${memberId} message ${message.id}: invited exchange ${exchange}`);

    const row = deps.store((s) => s.introduction(memberId));
    const messages = await refetch([...(row?.messages.map((m) => m.id) ?? []), message.id], message);
    if (!messages) return;
    if (messages.some((m) => m.content.trim())) {
      // Their own names are what redaction keeps out of the call: without them, silence.
      const member = await deps.discord.member(memberId);
      if (!member) {
        log(`[responder] member ${memberId} message ${message.id}: not found, so not answered`);
        return;
      }
      const names = member.names;
      const result = await paid(guard, (s) =>
        s.boundary.extractIntroduction({
          memberId,
          sources: sourcesOf(messages),
          memberNames: names,
          vocabulary: s.vocabulary,
        }),
      );
      if (!result) return;
      conversation.extraction = merge(conversation.extraction, result);
    }

    // Read as gestures, under the claim's share of the 6 (F7); never matched on.
    let read = 0;
    let meaning: ImageMeaning | null = null;
    for (const image of images.slice(0, granted)) {
      if (!guard.current()) return;
      const dataUrl = await fetchStill(image, deps.fetchImage);
      if (!dataUrl) continue;
      const reading = await paid(guard, (s) =>
        s.boundary.readImage({ memberId, image: { authorId: memberId, origin: message.channel_id, dataUrl } }),
      );
      if (reading) {
        read++;
        meaning = reading.meaning;
      }
    }

    const extraction = conversation.extraction;
    let places: Entity[] = [];
    if (extraction?.signal === "some") {
      const found = await paid(guard, async (s) => {
        const result = await findPlaces({
          query: matchQuery(extraction, s.vocabulary),
          invokerId: memberId,
          catalog: s.catalog,
          monitored: s.monitored,
          vocabulary: s.vocabulary,
          ask: s.boundary.ask,
          origin: { derivedFromIntroduction: memberId },
        });
        const entities = new Map(s.catalog.map((e) => [e.id, e]));
        const matches = result.matches.filter((e) => isCandidate(e, entities, s.monitored));
        return last ? doorsOf(matches, s) : matches;
      });
      if (!found) return;
      places = found;
    }
    const doors = (p: Entity[]) => widestDoors(p, INDEX_URL);
    const [kind, reply]: [ReplyKind, string] = last
      ? ["widest_doors", doors(fit(places, doors))]
      : places.length
        ? ["invited_recommend", recommendPost(fit(places, recommendPost))]
        : ["invited_question", INVITED_QUESTION];
    if (!guard.current()) return;
    const clock = deps.store((s) => timingSettings(s).clock);
    await post(
      kind,
      { reply, timeline: { ...quiet(clock), extractions: exchange, images: read, imageMeaning: meaning } },
      message.id,
    );
    log(`[responder] member ${memberId} message ${message.id}: answered ${kind}`);
    if (last) guard.silence();
  };

  /** Every create and update the filter let through, live or from the catch-up. */
  const handle = async (message: WatchedMessage, invitable = false): Promise<void> => {
    // A partial update carries no author, and nothing can be said of it.
    if (!message.author || fromBot(message)) return;
    const author = message.author.id;
    const invited = invitable && invites(message);
    if (!deps.preferences(author).processing) {
      // An ask gets the fixed opt-out text and nothing more (§9). Anything else
      // counts for nothing: not activity, not an acknowledgement, not novelty (D10).
      if (invited) await serial(author, () => answerFixed("processing_off", PROCESSING_OFF, message));
      return;
    }
    for (const w of watches.values()) if (w.memberId !== author) notice(w, message);
    await serial(author, async () => {
      if (invited && !watched(author)) return invite(message);
      const w = watches.get(author);
      await (w ? own(w, message) : consider(message));
    });
  };

  /** A gateway event, or one held during the catch-up: a failure is logged, never thrown at the gateway. */
  const receive = (message: WatchedMessage, invitable: boolean): Promise<void> =>
    handle(message, invitable).catch((error: unknown) => log(`[responder] message ${message.id}: ${reason(error)}`));

  /**
   * §2's catch-up: one paginated read from the older of the oldest open row's
   * intro and the later of now−24h and `on_since`, in id order, through the
   * same path as the gateway.
   */
  const catchUp = async (now: number) => {
    const { rows, onSince } = deps.store((s) => ({ rows: s.introductions(), onSince: s.setting("on_since") }));
    let after = BigInt(snowflakeAt(Math.max(now - DAY, onSince ? Date.parse(onSince) : 0)));
    for (const row of rows) {
      const intro = row.messages[0];
      if (row.outcome === null && row.postedAt === null && intro && BigInt(intro.id) - 1n < after)
        after = BigInt(intro.id) - 1n;
    }
    let read = 0;
    for (;;) {
      const page = (await deps.discord.messages({ after: after.toString() })).sort(byId);
      for (const message of page) await handle(message);
      read += page.length;
      if (page.length < PAGE) break;
      after = BigInt(page.at(-1)!.id);
    }
    log(`[responder] caught up: ${read} messages read`);
  };

  /**
   * The seed (F2): every author of the Channel's history up to `seed_until`
   * gets a tombstone, then `seeded_at` is written. A restart part-way reads
   * it all again against the same boundary; the tombstones are idempotent.
   */
  const seed = async () => {
    const until = deps.store((s) => s.setting("seed_until"));
    if (!until) throw new Error("seed_until is not set.");
    let before = until;
    let read = 0;
    for (;;) {
      const page = await deps.discord.messages({ before });
      const authors = page.filter((m) => !fromBot(m)).map((m) => m.author.id);
      deps.store((s) => s.seedTombstones(authors, date()));
      read += page.length;
      if (page.length < PAGE) break;
      before = page.reduce((low, m) => (BigInt(m.id) < BigInt(low) ? m.id : low), before);
    }
    deps.store((s) => s.setSetting("seeded_at", date().toISOString(), BY, date()));
    log(`[responder] seeded: ${read} messages read up to ${until}`);
  };

  /**
   * §2's checks, at startup and hourly. A failure pauses the responder, and
   * the erasure loop and slash commands carry on. The seed runs after the
   * first pass, since an unreadable Channel answers its history with `[]`.
   */
  const check = async (): Promise<boolean> => {
    const failures: string[] = [];
    try {
      const mode = deps.store((s) => s.mode());
      botId ??= await deps.discord.botId();
      const probe = await deps.discord.probe();
      if (!probe.messageContent) failures.push("Message Content is not granted");
      if (!probe.watched?.view || !probe.watched.history) failures.push("#introductions is not visible and readable");
      if (!probe.shadow?.view || !probe.shadow.send || !probe.shadow.history)
        failures.push("#bot-tests cannot be viewed, sent to and read");
      if (mode === "live" && !probe.watched?.send) failures.push("#introductions cannot be sent to");
      const monitored = deps.monitored();
      if (!monitored.has(WATCHED_CHANNEL)) failures.push("#introductions is not monitored");
      if (monitored.has(SHADOW_CHANNEL)) failures.push("#bot-tests is monitored");
      if (!deps.excluded().has(SHADOW_CHANNEL)) failures.push("#bot-tests is not excluded");
    } catch (error) {
      failures.push(`the checks could not be made: ${reason(error)}`);
    }
    if (failures.length) {
      ready = false;
      log(`[responder] CHECKS FAILED, RESPONDER PAUSED: ${failures.join("; ")}. Erasure and commands carry on.`);
      return false;
    }
    if (!deps.store((s) => s.setting("seeded_at"))) await seed();
    ready = true;
    return true;
  };

  /**
   * §6's loop, hourly in every mode, checks or no checks: each row's messages
   * are fetched again, and one that is gone erases the row. Then the 30-day
   * purge.
   */
  const eraseLoop = async () => {
    for (const row of deps.store((s) => s.introductions())) {
      try {
        for (const { id } of row.messages) {
          if ((await deps.discord.message(id)) === null) {
            eraseMessage(id);
            break;
          }
        }
      } catch (error) {
        log(`[responder] member ${row.memberId}: could not check their messages: ${reason(error)}`);
      }
    }
    const purged = deps.store((s) => s.purge(date()));
    if (purged.introductions || purged.invitations)
      log(`[responder] purged ${purged.introductions} introductions, ${purged.invitations} invitations`);
  };

  /** Sherpa's one post for a watch (§3, §4, §7). */
  const respond = async (watch: Watch, decided: PostKind, settings: TimingSettings, now: number) => {
    if (!current(watch)) return;
    if (!deps.store((s) => s.claimPost(watch.memberId, date()))) {
      watches.delete(watch.memberId);
      return;
    }
    let kind = decided;
    let places: Entity[] = [];
    let dropped = 0;
    if (kind === "recommend") {
      const extraction = watch.extraction;
      if (!extraction) return abandon(watch);
      const found = await paid(watchGuard(watch), async (s) => {
        const result = await findPlaces({
          query: matchQuery(extraction, s.vocabulary),
          invokerId: watch.memberId,
          catalog: s.catalog,
          monitored: s.monitored,
          vocabulary: s.vocabulary,
          ask: s.boundary.ask,
          origin: { derivedFromIntroduction: watch.memberId },
        });
        const entities = new Map(s.catalog.map((e) => [e.id, e]));
        return result.matches.filter((e) => isCandidate(e, entities, s.monitored));
      });
      if (!found) return abandon(watch);
      // Novelty (§4): what another member named since the intro is theirs, not Sherpa's.
      places = found.filter((e) => !watch.named.has(e.id));
      dropped = found.length - places.length;
      places = fit(places, recommendPost);
      if (!places.length) kind = "welcome_only";
    }
    const reply = kind === "recommend" ? recommendPost(places) : kind === "question" ? WELCOME_WITH_QUESTION : WELCOME_ONLY;
    const row = deps.store((s) => s.introduction(watch.memberId));
    if (!row || !current(watch)) return abandon(watch);
    const introMinute = Math.floor(watch.introAt / MINUTE);
    await post(
      kind,
      {
        reply,
        timeline: {
          clock: settings.clock,
          acknowledgedAfterMinutes:
            watch.acknowledgedAt === null ? null : Math.round((watch.acknowledgedAt - watch.introAt) / MINUTE),
          activeMinutes: [...watch.active].filter((m) => m > introMinute && m <= Math.floor(now / MINUTE)).length,
          extractions: row.extractions,
          noveltyDropped: dropped,
          images: row.imagesRead,
          imageMeaning: watch.imageMeaning,
        },
      },
      watch.introId,
    );
    close(watch, "responded", kind === "recommend" ? "recommended" : kind);
  };

  const evaluate = async (watch: Watch, settings: TimingSettings, now: number) => {
    if (watches.get(watch.memberId) !== watch) return;
    const [intro, ...followUps] = watch.messages;
    if (!intro) return;
    const decided = decide(
      { intro, followUps, askedByHuman: watch.askedByHuman, activeMinutes: [...watch.active] },
      settings,
      now,
    );
    if (decided.action === "post") await respond(watch, decided.kind, settings, now);
  };

  /** In `off`, a watch past the hard stop closes unanswered: there is no catch-up to finish it (F11). */
  const expireWhileOff = (rows: Introduction[], now: number) => {
    for (const row of rows) {
      if (row.outcome !== null || Date.parse(row.startedAt) > now - DAY) continue;
      watches.delete(row.memberId);
      if (deps.store((s) => s.closeIntroduction(row.memberId, "expired", "off", date())))
        log(`[responder] member ${row.memberId}: expired while off`);
    }
  };

  return {
    /** For the invited path: the same write port, the same mode. */
    post,

    /** `/privacy`'s hook (F8): the rows are already erased; this drops the memory. */
    forget,

    /**
     * `MESSAGE_CREATE`, and `MESSAGE_UPDATE` with `edited`: an edit never
     * invites (§9). Resolves once handled, for tests; the gateway does not wait.
     */
    onMessage: (message: WatchedMessage, edited = false): Promise<void> => {
      if (message.channel_id !== WATCHED_CHANNEL) return Promise.resolve();
      if (phase === "idle") return Promise.resolve();
      if (phase === "catching") {
        pending.push({ message, invitable: !edited });
        return Promise.resolve();
      }
      return receive(message, !edited);
    },

    /** `MESSAGE_DELETE` and `MESSAGE_DELETE_BULK`: in any mode and any state, at once (§6). */
    onDelete: (event: { channel_id: string; ids: readonly string[] }): void => {
      if (event.channel_id !== WATCHED_CHANNEL) return;
      for (const id of event.ids) {
        for (const c of conversations.values()) if (c.handled.has(id)) conversations.delete(c.memberId);
        try {
          eraseMessage(id);
        } catch (error) {
          log(`[responder] message ${id}: erasure failed, the hourly loop retries it: ${reason(error)}`);
        }
      }
    },

    /**
     * The seed's boundary first, whatever else fails (§3). A row whose post
     * was claimed but never closed is a crash between the two: it is closed
     * `failed`, with no retry (F12). Then the erasure loop, the checks (and
     * the seed), and a first tick, which catches up.
     */
    start: async () => {
      deps.store((s) => s.seedUntil(snowflakeAt(deps.now()), BY, date()));
      for (const row of deps.store((s) => s.introductions()))
        if (row.postedAt !== null && row.outcome === null)
          deps.store((s) => s.closeIntroduction(row.memberId, "failed", "error", date()));
      await eraseLoop();
      await check();
      await tick();
    },

    check,
    eraseLoop,

    /**
     * Each minute: settings read fresh, a catch-up when the responder has
     * just become active, and `decide` for every watch.
     */
    tick: () => tick(),
  };

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = deps.now();
      for (const c of conversations.values()) if (now - c.lastAt >= DAY) conversations.delete(c.memberId);
      const { mode, settings, rows } = deps.store((s) => ({
        mode: s.mode(),
        settings: timingSettings(s),
        rows: s.introductions(),
      }));
      if (!ready || mode === "off") {
        phase = "idle";
        pending = [];
        if (mode === "off") expireWhileOff(rows, now);
        return;
      }
      if (phase === "idle") {
        phase = "catching";
        try {
          await catchUp(now);
          phase = "live";
          for (const held of pending) void receive(held.message, held.invitable);
        } catch (error) {
          phase = "idle";
          log(`[responder] catch-up failed, retried next tick: ${reason(error)}`);
          return;
        } finally {
          pending = [];
        }
      }
      await Promise.all([...watches.values()].map((w) => serial(w.memberId, () => evaluate(w, settings, now))));
    } finally {
      ticking = false;
    }
  }
};

export type Responder = ReturnType<typeof createResponder>;
