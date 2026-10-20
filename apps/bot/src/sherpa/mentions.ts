/**
 * Replies to @mentions in Sherpa's voice (#49, ADR-0004,
 * docs/proposals/mention-replies.md). A mention of Sherpa, or a reply to one of
 * its posts, anywhere the bot is, except a monitored or withheld place:
 * `#introductions`' mentions stay with the responder's invited path.
 *
 * The model writes one bounded line (`replyToMention`); code adds the help
 * text, the fallback and the role sign-off, so no role reaches a prompt. Staff
 * switch it `off`, `shadow` (to `#bot-tests`) or `live`; `off` until set.
 *
 * Nothing is stored: the cooldown is in memory. Logs carry ids, never text or
 * names.
 */
import {
  type GatewayMessageCreateDispatchData,
  MessageType,
  type RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import { type Boundary, type MentionPlace, type Source, mentionRefused } from "../llm/boundary.ts";
import type { Persona } from "../llm/persona.ts";
import type { Entity } from "../sync/catalog.ts";
import type { RoleManifestEntry } from "../sync/ports.ts";
import type { DailyCap } from "./interactions.ts";
import type { Mode } from "./responder-store.ts";
import { INDEX_URL, SHADOW_CHANNEL } from "./responder.ts";
import { WATCH_FORUM } from "./watch.ts";

/** D49-5: one reply per member per 15 seconds. */
export const COOLDOWN_MS = 15_000;
/** The messages before the mention that may go as context (D49-4). */
const CONTEXT_MESSAGES = 10;

export const MENTION_HELP =
  "Here's what I can do:\n" +
  "• `/find`: tell me what you're into, and I'll point you at places to go.\n" +
  "• `/lately`: what's been active around the server.\n" +
  "• `/privacy`: your settings for what I read.\n" +
  `And the Index has everything: <${INDEX_URL}>`;
export const MENTION_OPTED_OUT =
  "You've opted out of Sherpa reading what you write, so I can't reply to that. " +
  "`/privacy opt-in processing` switches it back on.";

// --- the write port ------------------------------------------------------

/**
 * The one write: `shadow` to `#bot-tests` with a jump link, `live` as an inline
 * reply where it was asked. Refuses a monitored or withheld place whatever the
 * caller checked, and pings nobody but the asker.
 */
export const mentionWritePort = (deps: {
  guildId: string;
  mode: () => Mode;
  refused: (place: MentionPlace) => boolean;
  createMessage: (channelId: string, body: RESTPostAPIChannelMessageJSONBody) => Promise<unknown>;
}) => ({
  post: async (place: MentionPlace, replyTo: string, content: string): Promise<void> => {
    if (deps.refused(place)) throw new Error("A mention reply to a monitored or withheld place. Refusing to post.");
    const mode = deps.mode();
    if (mode === "shadow") {
      const link = `https://discord.com/channels/${deps.guildId}/${place.id}/${replyTo}`;
      await deps.createMessage(SHADOW_CHANNEL, {
        content: [
          `Mention reply (shadow) · replying to: ${link}`,
          "Would post:",
          ...content.split("\n").map((l) => `> ${l}`.trimEnd()),
        ].join("\n"),
        allowed_mentions: { parse: [] },
      });
      return;
    }
    if (mode === "live") {
      await deps.createMessage(place.id, {
        content,
        message_reference: { message_id: replyTo },
        allowed_mentions: { parse: [], replied_user: true },
      });
      return;
    }
    throw new Error("Mention replies are off. Nothing is posted.");
  },
});

// --- the handler ---------------------------------------------------------

export type MentionMessage = Pick<
  GatewayMessageCreateDispatchData,
  | "id"
  | "channel_id"
  | "guild_id"
  | "author"
  | "content"
  | "type"
  | "mentions"
  | "mention_roles"
  | "referenced_message"
  | "webhook_id"
  | "member"
>;

/** A message as context: author, whether a bot, text and names. */
type HistoryMessage = Pick<MentionMessage, "author" | "content" | "mentions" | "webhook_id">;

export interface MentionsDeps {
  guildId: string;
  discord: {
    botId: () => Promise<string>;
    /** Sherpa's managed role, which the @ list offers beside the bot itself. */
    botRoleId: () => Promise<string | null>;
    /** A member's server nickname, which a message read over REST does not carry. Null for none or unknown. */
    nickOf: (userId: string) => Promise<string | null>;
    /** A place's parent, for one outside the Catalog. Null when Discord does not have it. */
    parentOf: (channelId: string) => Promise<string | null | undefined>;
    /** The newest messages before `before`, newest first. Throws where history cannot be read. */
    history: (channelId: string, before: string, limit: number) => Promise<HistoryMessage[]>;
    createMessage: (channelId: string, body: RESTPostAPIChannelMessageJSONBody) => Promise<unknown>;
  };
  mode: () => Mode;
  persona: Persona;
  processing: (memberId: string) => boolean;
  roles: () => RoleManifestEntry[];
  session: () => { catalog: Entity[]; monitored: ReadonlySet<string>; boundary: Pick<Boundary, "replyToMention"> };
  cap: DailyCap;
  now: () => number;
  log: (m: string) => void;
}

const isBot = (m: Pick<HistoryMessage, "author" | "webhook_id">) => m.author.bot === true || Boolean(m.webhook_id);
const namesOf = (u: { username: string; global_name?: string | null }, nick?: string | null) =>
  [u.username, u.global_name, nick].filter((n): n is string => typeof n === "string" && n.trim() !== "");
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 160);

export const createMentions = (deps: MentionsDeps) => {
  const last = new Map<string, number>();
  const { log } = deps;

  const onMessage = async (message: MentionMessage): Promise<void> => {
    if (message.guild_id !== deps.guildId || isBot(message)) return;
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;
    const botId = await deps.discord.botId();
    // Looked up only for a message that mentions a role: every guild message reaches here.
    const botRole = message.mention_roles.length
      ? await deps.discord.botRoleId().catch((error: unknown) => {
          log(`[mentions] ${message.id}: Sherpa's role unknown: ${reason(error)}`);
          return null;
        })
      : null;
    const asked =
      message.mentions.some((u) => u.id === botId) ||
      (botRole !== null && message.mention_roles.includes(botRole)) ||
      message.referenced_message?.author.id === botId;
    if (!asked || deps.mode() === "off") return;

    const asker = message.author.id;
    const now = deps.now();
    if (now - (last.get(asker) ?? -Infinity) < COOLDOWN_MS) return log(`[mentions] ${message.id}: cooling down`);
    last.set(asker, now);

    const session = deps.session();
    const byId = new Map(session.catalog.map((e) => [e.id, e]));
    const parentId = byId.has(message.channel_id)
      ? null
      : await deps.discord.parentOf(message.channel_id);
    if (parentId === undefined) return log(`[mentions] ${message.id}: place unknown to Discord`);
    const place: MentionPlace = { id: message.channel_id, parentId };
    const refused = (p: MentionPlace) =>
      mentionRefused(p, byId, session.monitored) || p.id === WATCH_FORUM || p.parentId === WATCH_FORUM ||
      byId.get(p.id)?.parent_id === WATCH_FORUM;
    if (refused(place)) return log(`[mentions] ${message.id}: refused, monitored or withheld`);
    const port = mentionWritePort({ guildId: deps.guildId, mode: deps.mode, refused, createMessage: deps.discord.createMessage });
    const post = async (content: string, kind: string) => {
      await port.post(place, message.id, content);
      log(`[mentions] ${message.id}: answered ${kind}`);
    };

    if (!deps.processing(asker)) return post(MENTION_OPTED_OUT, "opted_out");
    if (!deps.cap.take()) return log(`[mentions] ${message.id}: daily cap reached`);

    let history: HistoryMessage[];
    try {
      history = await deps.discord.history(message.channel_id, message.id, CONTEXT_MESSAGES);
    } catch (error) {
      // History it cannot read is withheld in all but name: nothing goes to the model.
      return log(`[mentions] ${message.id}: history unreadable, refused: ${reason(error)}`);
    }
    // Sherpa by its name, never "@member": an `@` the model copies back is refused.
    const ownMention = new RegExp(`<@!?${botId}>${botRole ? `|<@&${botRole}>` : ""}`, "g");
    const source = (m: HistoryMessage): Source => ({
      authorId: m.author.id,
      authorIsBot: isBot(m),
      content: m.content.replace(ownMention, "Sherpa"),
      origin: message.channel_id,
    });
    // Every person's names, never Sherpa's own: refusing "Sherpa" would refuse every reply that says it.
    // A nickname is what members call each other, and REST messages do not carry it, so each
    // context author's is looked up: at most ten calls. A failed lookup fails the reply, never
    // sends the nickname unredacted.
    const authors = [...new Set(history.filter((m) => !isBot(m)).map((m) => m.author.id))];
    const nicks = await Promise.all(authors.map((id) => deps.discord.nickOf(id)));
    const otherNames = [
      ...nicks.filter((n): n is string => n !== null),
      ...[...history, message].flatMap((m) => [
        ...(m === message || isBot(m) ? [] : namesOf(m.author)),
        ...m.mentions
          .filter((u) => u.id !== botId)
          .flatMap((u) => namesOf(u, (u as { member?: { nick?: string | null } }).member?.nick)),
      ]),
    ];

    let reply: { intent: "chat" | "help"; line: string } | null = null;
    try {
      reply = await session.boundary.replyToMention({
        place,
        sherpaId: botId,
        question: source(message),
        context: [...history].reverse().map(source),
        askerNames: namesOf(message.author, message.member?.nick),
        otherNames,
        voice: deps.persona.voice,
      });
    } catch (error) {
      log(`[mentions] ${message.id}: reply refused or failed, fallback: ${reason(error)}`);
    }
    if (reply?.intent === "help") return post(MENTION_HELP, "help");

    // Role flavour in code (D49-6): the asker's first matching role picks a fixed line.
    const held = new Set(message.member?.roles ?? []);
    const roleNames = new Set(deps.roles().filter((r) => r.ids.some((id) => held.has(id))).map((r) => r.name));
    const signoff = deps.persona.signoffs.find((s) => roleNames.has(s.role))?.line;
    const text = reply?.line ?? deps.persona.fallback;
    return post(signoff ? `${text}\n-# ${signoff}` : text, reply ? "chat" : "fallback");
  };

  return {
    /** `MESSAGE_CREATE` only: an edit never asks (D49-3). A failure is logged, never thrown at the gateway. */
    onMessage: (message: MentionMessage): Promise<void> =>
      onMessage(message).catch((error: unknown) => log(`[mentions] ${message.id}: ${reason(error)}`)),
  };
};
