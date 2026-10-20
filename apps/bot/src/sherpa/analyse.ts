/**
 * `/sherpa analyse`: Deep User Analysis (#51, docs/proposals/deep-user-analysis.md,
 * ADR-0003). For holders of the `Staff` role alone (O7), on any member but a
 * bot (D51-6).
 *
 * Reads the member's messages since they joined (D51-3) through Discord's
 * message search, keeps only those from places a Member can see, and has the
 * model note events in chunks, then write the review from those notes and the
 * newest messages. The report is an ephemeral reply, never stored (D51-2):
 * the messages and the notes live in memory for the run.
 *
 * Bounded by time, not count: reading stops at `READ_MS`, and the whole run
 * at `RUN_MS`, inside the interaction token's 15 minutes. Search answers
 * about one page of 25 a second (measured 2026-10-19: a burst of 6, then
 * about one a second), so a run reads up to about 9,000 messages; one that
 * stops early says so. Model calls: one per 200 messages, and one more.
 *
 * Logs carry ids and counts only (D51-5).
 */
import {
  type APIEmbed,
  type APIMessage,
  ChannelType,
  MessageSearchSortMode,
  type RESTGetAPIGuildMessagesSearchQuery,
  type RESTGetAPIGuildMessagesSearchResult,
} from "discord-api-types/v10";
import type { Boundary, ModerationMessage, ModerationSubject, PlacedSource } from "../llm/boundary.ts";
import { type ChunkEvent, type ChunkResult, type Report, moderationPlace } from "../llm/moderation.ts";
import type { Entity } from "../sync/catalog.ts";
import { plainName } from "./find.ts";
import type { DailyCap } from "./interactions.ts";
import type { Answer } from "./privacy.ts";

const SECOND = 1000;
const READ_MS = 6 * 60 * SECOND;
const RUN_MS = 12 * 60 * SECOND;
const PAGE = 25;
/** Search's ceiling on `offset`: past it, the next page is asked for below the oldest id read. */
const MAX_OFFSET = 9_975;
const CHUNK = 200;
const RECENT = 100;
/** Chunk calls in flight at once. */
const PARALLEL = 4;
/** Replied-to messages fetched per run, for context (O6). Search does not carry them (verified 2026-10-19). */
const MAX_CONTEXT = 200;
const HOUR = 60 * 60 * SECOND;

const DISCORD_EPOCH = 1_420_070_400_000;
const snowflakeAt = (ms: number): string => ((BigInt(ms) - BigInt(DISCORD_EPOCH)) << 22n).toString();

export interface AnalyseDeps {
  guildId: string;
  discord: {
    search: (query: RESTGetAPIGuildMessagesSearchQuery) => Promise<RESTGetAPIGuildMessagesSearchResult>;
    /** Null when they are not in the guild. */
    member: (userId: string) => Promise<{ joinedAt: string | null; names: string[] } | null>;
    /** Null once it is deleted. */
    message: (channelId: string, messageId: string) => Promise<APIMessage | null>;
  };
  /** Built per run, so each reads today's Catalog, names and opt-outs. */
  session: () => {
    catalog: Entity[];
    memberRoles: readonly string[];
    /** The durable exclusions: an excluded Thread is not in the Catalog, and must not pass as its parent's. */
    excluded: ReadonlySet<string>;
    boundary: Pick<Boundary, "analyseChunk" | "analyseReduce">;
  };
  retrying: <T>(work: () => Promise<T>) => Promise<T>;
  /** Runs a day across all Staff (D51-4). */
  cap: Pick<DailyCap, "take">;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

const namesOf = (user: { username: string; global_name?: string | null }): string[] =>
  [user.username, user.global_name].filter((n): n is string => typeof n === "string" && n.trim() !== "");

/** Model text, inert: whitespace collapsed and Discord markdown escaped, so it can neither format, link nor ping. */
const inert = (text: string): string => plainName(text);

/** Escaping can double a string, so a field is fitted after it, never before. */
const fit = (text: string, max: number): string =>
  text.length <= max ? text || "—" : `${text.slice(0, max - 1).replace(/\\+$/, "")}…`;

const clipLines = (lines: string[], max: number): string => {
  const kept = [...lines];
  while (kept.length && kept.join("\n").length > max) kept.pop();
  return kept.join("\n") || "—";
};

export const createAnalyse = (deps: AnalyseDeps) => {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let running = false;
  /** Model calls the last run started, settled or not: the next run waits for them, even after a timed-out reply. */
  let inFlight: Promise<unknown> = Promise.resolve();
  /** The last run on each subject, for the hourly cooldown (D51-4). In memory: a restart forgets it. */
  const last = new Map<string, number>();

  return async (
    subject: { id: string; bot?: boolean },
    since: string | null,
    progress: (text: string) => Promise<unknown>,
    tag: string,
  ): Promise<Answer> => {
    if (subject.bot) return "Sherpa doesn't review bots.";
    // Round-tripped, so 2026-02-30 is refused rather than read as 2 March, and 2026-99-99 rather than as no date at all.
    const sinceMs = since === null ? null : Date.parse(since);
    if (since !== null && (Number.isNaN(sinceMs) || new Date(sinceMs!).toISOString().slice(0, 10) !== since))
      return "Give `since` as a date, like 2026-01-31.";
    const start = deps.now();
    if (running) return "Another review is running. Try again when it has finished.";
    const previous = last.get(subject.id);
    if (previous !== undefined && start - previous < HOUR)
      return `This member was reviewed <t:${Math.floor(previous / 1000)}:R>. One review per member an hour.`;
    if (!deps.cap.take()) return "Sherpa has run all the reviews it can for today. Try again tomorrow.";
    running = true;
    last.set(subject.id, start);
    try {
      return await review(subject.id, since, progress, tag, start);
    } finally {
      void inFlight.then(() => {
        running = false;
      });
    }
  };

  async function review(
    memberId: string,
    since: string | null,
    progress: (text: string) => Promise<unknown>,
    tag: string,
    start: number,
  ): Promise<Answer> {
    const { catalog, memberRoles, excluded, boundary } = deps.session();
    const byId = new Map(catalog.map((e) => [e.id, e]));
    const member = await deps.discord.member(memberId);
    const floorMs = Math.max(member?.joinedAt ? Date.parse(member.joinedAt) : 0, since ? Date.parse(since) : 0);
    // Their names from the lookup, and from every message search returns, so a member who has left is still redacted.
    const memberNames = new Set(member?.names ?? []);

    // --- reading -----------------------------------------------------------
    const read = new Map<string, { message: APIMessage; origin: string }>();
    /** Every id read, kept or left out, so a page that repeats ends the loop. */
    const seen = new Set<string>();
    let withheld = 0;
    let total = 0;
    let stoppedEarly = false;
    /** Discord said older messages were still being indexed: what was read may not reach back to the floor. */
    let stillIndexing = false;
    let pages = 0;
    let maxId: string | undefined;
    let offset = 0;
    for (;;) {
      if (deps.now() - start > READ_MS) {
        stoppedEarly = true;
        break;
      }
      const result = await deps.discord.search({
        author_id: [memberId],
        ...(floorMs > DISCORD_EPOCH ? { min_id: snowflakeAt(floorMs) } : {}),
        ...(maxId ? { max_id: maxId } : {}),
        offset,
        limit: PAGE,
        include_nsfw: true,
        sort_by: MessageSearchSortMode.Timestamp,
        sort_order: "desc",
      });
      if (!("messages" in result)) {
        // As long as Discord asks, or a second when it says zero, while reading time remains.
        const wait = Math.max(result.retry_after, 1) * SECOND;
        if (deps.now() + wait - start > READ_MS)
          return "Discord hasn't finished indexing this server's messages. Try again later.";
        await sleep(wait);
        continue;
      }
      total ||= result.total_results;
      if (result.doing_deep_historical_index) stillIndexing = true;
      const threads = new Map((result.threads ?? []).map((t) => [t.id, t]));
      const page = result.messages.map((group) => group.find((m) => m.author.id === memberId) ?? group[0]!);
      let fresh = 0;
      for (const m of page) {
        if (read.has(m.id) || seen.has(m.id) || m.author.id !== memberId) continue;
        seen.add(m.id);
        fresh++;
        for (const n of namesOf(m.author)) memberNames.add(n);
        // A message in a Thread the Catalog does not hold is checked as its parent's, unless it is private.
        const thread = threads.get(m.channel_id);
        const origin = byId.has(m.channel_id)
          ? m.channel_id
          : thread && thread.type !== ChannelType.PrivateThread && thread.parent_id && !excluded.has(thread.id)
            ? thread.parent_id
            : null;
        if (origin === null || !moderationPlace(origin, byId, memberRoles)) withheld++;
        else read.set(m.id, { message: m as APIMessage, origin });
      }
      // Search may return a short page with more behind it: only one with nothing new ends the history.
      if (fresh === 0) break;
      offset += page.length;
      if (offset > MAX_OFFSET - PAGE && page.length) {
        maxId = page.reduce((low, m) => (BigInt(m.id) < BigInt(low) ? m.id : low), page[0]!.id);
        offset = 0;
      }
      if (++pages % 16 === 0) await progress(`Read ${read.size + withheld} of about ${total} messages…`);
    }
    if (read.size === 0) {
      deps.log(`${tag} subject ${memberId}: nothing to review (left out ${withheld})`);
      return "This member has no messages Sherpa can review in places Members can see.";
    }

    // --- context (O6) ---------------------------------------------------------
    const ordered = [...read.values()].sort((a, b) => (BigInt(a.message.id) < BigInt(b.message.id) ? -1 : 1));
    const otherNames = new Set<string>();
    const replies = new Map<string, PlacedSource>();
    const newestReplies = ordered.filter(({ message }) => message.message_reference?.message_id).slice(-MAX_CONTEXT);
    for (const { message, origin } of newestReplies.reverse()) {
      const to = message.message_reference!.message_id!;
      if (deps.now() - start > READ_MS) break;
      const replied = await deps.discord.message(message.channel_id, to);
      if (!replied || replied.author.id === memberId) continue;
      for (const n of namesOf(replied.author)) otherNames.add(n);
      replies.set(message.id, { authorId: replied.author.id, authorIsBot: replied.author.bot === true, content: replied.content, origin });
    }

    const messages: ModerationMessage[] = ordered.map(({ message, origin }, n) => ({
      n,
      date: message.timestamp.slice(0, 10),
      place: byId.get(origin)?.name ?? "",
      source: { authorId: memberId, authorIsBot: false, content: message.content, origin },
      ...(replies.has(message.id) ? { repliesTo: replies.get(message.id)! } : {}),
    }));
    /** Where each numbered message is, for its jump link. */
    const refs = ordered.map(({ message }) => ({ channelId: message.channel_id, id: message.id }));
    const who: ModerationSubject = { memberId, memberNames, otherNames, memberRoles };

    // --- the model ------------------------------------------------------------
    await progress(`Read ${messages.length} messages. Reviewing them…`);
    const chunks: ModerationMessage[][] = [];
    for (let i = 0; i < messages.length; i += CHUNK) chunks.push(messages.slice(i, i + CHUNK));
    const results: ChunkResult[] = [];
    // The whole run's ceiling, around the calls too: a call started late, and its retry, cannot outlast the token.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outOfTime = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("out of time")), Math.max(0, start + RUN_MS - deps.now()));
    });
    /** Each call is tracked on its own: a sibling that failed fast must not free the gate while others run. */
    const tracked = <T>(work: Promise<T>): Promise<T> => {
      inFlight = Promise.allSettled([inFlight, work]);
      return work;
    };
    const inTime = <T>(work: Promise<T>): Promise<T> => Promise.race([work, outOfTime]);
    /** A call, or its retry, refused once the ceiling has passed: work the reply no longer waits for spends nothing more. */
    const whileInTime = <T>(call: () => Promise<T>) => () => {
      if (deps.now() - start > RUN_MS) return Promise.reject(new Error("out of time"));
      return call();
    };
    try {
      for (let i = 0; i < chunks.length; i += PARALLEL) {
        if (deps.now() - start > RUN_MS) throw new Error("out of time");
        results.push(
          ...(await inTime(
            Promise.all(
              chunks.slice(i, i + PARALLEL).map((c) => tracked(deps.retrying(whileInTime(() => boundary.analyseChunk(who, c))))),
            ),
          )),
        );
      }
      const events: Array<ChunkEvent & { date: string }> = results
        .flatMap((r) => r.events)
        .map((e) => ({ ...e, date: messages[e.at]!.date }));
      const tone = results.flatMap((r) => r.tone);
      if (deps.now() - start > RUN_MS) throw new Error("out of time");
      const report = await inTime(
        tracked(deps.retrying(whileInTime(() => boundary.analyseReduce(who, { events, tone }, messages.slice(-RECENT))))),
      );
      deps.log(`${tag} subject ${memberId}: reviewed ${messages.length}, left out ${withheld}, calls ${chunks.length + 1}`);
      return render(memberId, messages, refs, report, events, { withheld, stoppedEarly, stillIndexing, floorMs });
    } catch (error) {
      deps.log(`${tag} subject ${memberId}: review failed: ${(error as Error).message.slice(0, 160)}`);
      return "The review failed. Nothing partial is shown. Try again in an hour.";
    } finally {
      clearTimeout(timer);
      outOfTime.catch(() => {});
    }
  }

  function render(
    memberId: string,
    messages: ModerationMessage[],
    refs: Array<{ channelId: string; id: string }>,
    report: Report,
    events: Array<ChunkEvent & { date: string }>,
    left: { withheld: number; stoppedEarly: boolean; stillIndexing: boolean; floorMs: number },
  ): Answer {
    const link = (n: number) => `https://discord.com/channels/${deps.guildId}/${refs[n]!.channelId}/${refs[n]!.id}`;
    const byAt = new Map(events.map((e) => [e.at, e]));
    const first = messages[0]!.date;
    const lastDate = messages.at(-1)!.date;
    const summary: APIEmbed = {
      title: "Member review",
      description: [
        `<@${memberId}> · ${messages.length} messages, ${first} to ${lastDate}`,
        "",
        `**Recent:** ${fit(inert(report.recent), 1500)}`,
        `**Trend:** ${report.trend}`,
      ].join("\n"),
      fields: [
        { name: "Timeline", value: clipLines(report.timeline.map((t) => `${t.month}: ${inert(t.line)}`), 1024) },
        { name: "Notes", value: fit(inert(report.notes), 1024) },
        ...(report.actions.length ? [{ name: "Action items", value: clipLines(report.actions.map((a) => `• ${inert(a)}`), 1024) }] : []),
      ],
      footer: {
        text: [
          left.floorMs ? `Since ${new Date(left.floorMs).toISOString().slice(0, 10)}.` : "All history.",
          left.withheld ? `${left.withheld} messages in places Sherpa doesn't review (Staff-only, private or excluded) were left out.` : "",
          left.stoppedEarly ? "Reading stopped at the time limit: older messages were not read." : "",
          left.stillIndexing ? "Discord was still indexing older messages: some may be missing." : "",
          "Written by a model from the messages cited; open them before acting.",
        ]
          .filter(Boolean)
          .join(" "),
      },
    };
    const keyLines = report.key_events.map((n) => {
      const e = byAt.get(n)!;
      return `**${e.kind.replace("_", " ")}** · ${e.date} · [open](${link(n)}) — ${inert(e.note)}`;
    });
    // Discord's 6,000 characters count the text itself: title, description, fields, footer.
    const used = [summary.title, summary.description, summary.footer?.text, ...(summary.fields ?? []).flatMap((f) => [f.name, f.value])]
      .join("").length + "Key events".length;
    const key: APIEmbed = { title: "Key events", description: clipLines(keyLines, Math.max(0, Math.min(4096, 6000 - used))) };
    return { content: "", embeds: [summary, key] };
  }
};
