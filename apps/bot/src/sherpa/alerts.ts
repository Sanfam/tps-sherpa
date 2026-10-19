/**
 * Alerts for Ambassadors and Staff (#50, docs/proposals/ambassador-alerts.md):
 * a template post in `#ambassador-chamber` when a member becomes a Member or
 * introduces themselves, pinging the holders who opted in.
 *
 * Template-only (D50-3): times and a link, no model call, no roles. Nothing is
 * posted while Staff's switch is off, while the checks fail, or about a member
 * with `approach` off (D50-4). One alert per member, per event, per join: the
 * `alert_sent` claim is taken before the post, so a crash costs the alert,
 * never a second one (F12).
 *
 * Joins are seen as the `Member` role being granted (D50-2: the server posts
 * no join message, and the owner granted the Guild Members intent), and only
 * for members who joined after the switch was turned on: otherwise every
 * existing Member's next role or nickname change would alert.
 *
 * Logs carry member and message ids, never text or names.
 */
import {
  type APIChatInputApplicationCommandInteraction,
  type APIGuildMember,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type RESTPostAPIChannelMessageJSONBody,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import { WATCHED_CHANNEL } from "../llm/boundary.ts";
import type { Entity } from "../sync/catalog.ts";
import { DURABLE_STORE_PATH, type Preferences, openDurableDatabase } from "../sync/durable-store.ts";
import { snowflakeTime } from "../sync/purge.ts";
import type { DailyCap } from "./interactions.ts";
import { countsAsIntroduction } from "./responder-decide.ts";
import type { ChannelAccess, WatchedMessage } from "./responder.ts";

/** `#ambassador-chamber`: the alerts' only target (owner, 2026-10-18). */
export const ALERTS_CHANNEL = "1550882422189596672";
/** Discord's ceiling on a message's content. */
const MAX_MESSAGE_CHARS = 2000;

export const EVENTS = ["join", "intro"] as const;
export type AlertEvent = (typeof EVENTS)[number];

// --- the store -----------------------------------------------------------

/** Opens on the durable store's path, through its startup contract. */
export const openAlertsStore = (path: string = DURABLE_STORE_PATH) => {
  const db = openDurableDatabase(path);
  return {
    subscribe: (memberId: string, event: AlertEvent, on: boolean, at: Date = new Date()) => {
      if (on)
        db.prepare("INSERT OR IGNORE INTO alert_subscription (member_id, event, set_at) VALUES (?, ?, ?)").run(
          memberId,
          event,
          at.toISOString(),
        );
      else db.prepare("DELETE FROM alert_subscription WHERE member_id = ? AND event = ?").run(memberId, event);
    },

    subscriptions: (memberId: string): AlertEvent[] =>
      (db.prepare("SELECT event FROM alert_subscription WHERE member_id = ? ORDER BY event").all(memberId) as Array<{
        event: AlertEvent;
      }>).map((r) => r.event),

    subscribers: (event: AlertEvent): string[] =>
      (db.prepare("SELECT member_id FROM alert_subscription WHERE event = ? ORDER BY set_at").all(event) as Array<{
        member_id: string;
      }>).map((r) => r.member_id),

    /**
     * The once-only claim: true for the first event for this member at this
     * `joined_at`, false for any repeat. A rejoin has a new `joined_at` and may
     * alert again; an earlier join's row stays, so a late event for it cannot. An intro is also refused while a tombstone says they posted
     * there before (F2): a seeded one always, the responder's for this join.
     */
    claim: (memberId: string, event: AlertEvent, joinedAt: string, at: Date = new Date()): boolean =>
      db
        .prepare(
          `INSERT INTO alert_sent (member_id, event, joined_at, sent_at)
             SELECT :member, :event, :joined, :at
             WHERE :event != 'intro' OR NOT EXISTS (
               SELECT 1 FROM tombstone WHERE member_id = :member AND (joined_at IS NULL OR joined_at = :joined))
           ON CONFLICT DO NOTHING`,
        )
        .run({ member: memberId, event, joined: joinedAt, at: at.toISOString() }).changes === 1,

    /** `/privacy delete-my-data`: their subscriptions go. `alert_sent` stays (D50-5). */
    forget: (memberId: string) => {
      db.prepare("DELETE FROM alert_subscription WHERE member_id = ?").run(memberId);
    },

    close: () => db.close(),
  };
};

export type AlertsStore = ReturnType<typeof openAlertsStore>;

export const withAlertsStore = <T>(work: (store: AlertsStore) => T, path: string = DURABLE_STORE_PATH): T => {
  const store = openAlertsStore(path);
  try {
    return work(store);
  } finally {
    store.close();
  }
};

// --- /alerts ---------------------------------------------------------------

const toggle = (name: string, description: string) => ({
  name,
  type: ApplicationCommandOptionType.Subcommand as const,
  description,
  options: [
    {
      name: "state",
      type: ApplicationCommandOptionType.String as const,
      description: "On or off.",
      required: true,
      choices: [
        { name: "on", value: "on" },
        { name: "off", value: "off" },
      ],
    },
  ],
});

export const ALERTS_COMMAND: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: "alerts",
  type: ApplicationCommandType.ChatInput,
  description: "Ambassadors and Staff: get pinged in #ambassador-chamber about new members.",
  options: [
    toggle("joins", "When someone becomes a Member."),
    toggle("intros", "When someone posts their introduction."),
    { name: "settings", type: ApplicationCommandOptionType.Subcommand, description: "Show which alerts you get." },
  ],
};

const SUBCOMMAND: Record<string, AlertEvent> = { joins: "join", intros: "intro" };
const LABEL: Record<AlertEvent, string> = { join: "new Members", intro: "new introductions" };

/** One `/alerts` interaction, for a holder the dispatcher already checked. Null for a shape it does not know. */
export const answerAlerts = (
  interaction: APIChatInputApplicationCommandInteraction,
  withStore: <T>(work: (store: AlertsStore) => T) => T,
  log: (m: string) => void,
  tag: string,
): string | null => {
  const by = interaction.member?.user.id;
  const sub = interaction.data.options?.[0];
  if (!by || sub?.type !== ApplicationCommandOptionType.Subcommand) return null;
  if (sub.name === "settings") {
    const events = withStore((s) => s.subscriptions(by));
    log(`${tag} settings`);
    return events.length
      ? `You're pinged in <#${ALERTS_CHANNEL}> about ${events.map((e) => LABEL[e]).join(" and ")}.`
      : "You get no alerts. Turn them on with `/alerts joins` or `/alerts intros`.";
  }
  const event = SUBCOMMAND[sub.name];
  const state = sub.options?.find((o) => o.name === "state")?.value;
  if (!event || (state !== "on" && state !== "off")) return null;
  withStore((s) => s.subscribe(by, event, state === "on"));
  log(`${tag} ${event} ${state} by ${by}`);
  return state === "on"
    ? `Done. You'll be pinged in <#${ALERTS_CHANNEL}> about ${LABEL[event]}.`
    : `Done. No more alerts about ${LABEL[event]}.`;
};

// --- the runtime -----------------------------------------------------------

/** What a member lookup gives the alerts. Null when they are not in the guild. */
export interface AlertMember {
  joinedAt: string | null;
  roles: readonly string[];
}

export interface AlertsDeps {
  guildId: string;
  discord: {
    member: (userId: string) => Promise<AlertMember | null>;
    /** The bot's access to `#ambassador-chamber`. Null when it cannot see it. */
    access: () => Promise<ChannelAccess | null>;
    /** The raw send. Only the write port calls it. */
    createMessage: (channelId: string, body: RESTPostAPIChannelMessageJSONBody) => Promise<unknown>;
  };
  store: <T>(work: (store: AlertsStore) => T) => T;
  /** Staff's switch, and when it was last turned on (`/sherpa alerts`). */
  switch: () => { on: boolean; since: string | null };
  /** The responder's seed is complete: tombstones cover the Channel's history (F2). */
  seeded: () => boolean;
  /** The member's intro, while the responder's row for this join holds it. */
  introOf: (memberId: string, joinedAt: string) => string | null;
  preferences: (memberId: string) => Preferences;
  loadCatalog: () => Entity[];
  /** The ids of the roles named `Member`, and of those that make a holder (Ambassador or Staff). */
  roles: () => { member: ReadonlySet<string>; holder: ReadonlySet<string> };
  cap: Pick<DailyCap, "take">;
  now: () => number;
  log: (message: string) => void;
}

/**
 * The one write port: its only target is `#ambassador-chamber`, it refuses
 * while the switch is off, and it pings the holders given and nobody else.
 */
export const alertPort = (deps: Pick<AlertsDeps, "switch"> & Pick<AlertsDeps["discord"], "createMessage">) => ({
  post: async (content: string, holders: readonly string[]): Promise<void> => {
    if (!deps.switch().on) throw new Error("Alerts are switched off. Nothing is posted.");
    await deps.createMessage(ALERTS_CHANNEL, {
      content,
      allowed_mentions: { parse: [], users: [...holders] },
    });
  },
});

const relative = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

export const createAlerts = (deps: AlertsDeps) => {
  const { log } = deps;
  const post = alertPort({ switch: deps.switch, createMessage: deps.discord.createMessage }).post;
  /** The checks passed. Nothing is posted before they do. */
  let ready = false;
  let capLoggedOn: string | null = null;
  const queues = new Map<string, Promise<void>>();

  /**
   * One member's events at a time, in arrival order, so of two quick
   * messages the first is the one claimed as their introduction.
   */
  const serial = (memberId: string, work: () => Promise<void>): Promise<void> => {
    const next = (queues.get(memberId) ?? Promise.resolve()).then(work);
    const settled = next.catch(() => {});
    queues.set(memberId, settled);
    void settled.then(() => {
      if (queues.get(memberId) === settled) queues.delete(memberId);
    });
    return next;
  };

  /** Subscribers who still hold Ambassador or Staff and are still here, the subject never among them. */
  const holders = async (event: AlertEvent, subject: string): Promise<string[]> => {
    const { holder } = deps.roles();
    const kept: string[] = [];
    for (const id of deps.store((s) => s.subscribers(event))) {
      if (id === subject) continue;
      const member = await deps.discord.member(id);
      if (member?.roles.some((r) => holder.has(r))) kept.push(id);
    }
    // Read again after the lookups: a holder who opted out meanwhile is not pinged.
    const still = new Set(deps.store((s) => s.subscribers(event)));
    return kept.filter((id) => still.has(id));
  };

  /**
   * Whether an alert about this member may still go: the checks passing, the
   * switch on, `approach` on, and a join still after the switch's floor.
   * Checked at the start and again after the last await, so an opt-out or a
   * switch made during the lookups wins.
   */
  const allowed = (memberId: string, joinedAt: string, event: AlertEvent): boolean => {
    if (!ready || !deps.preferences(memberId).approach) return false;
    const { on, since } = deps.switch();
    return on && (event === "intro" || (since !== null && Date.parse(joinedAt) >= Date.parse(since)));
  };

  /** Everything after the event is known to be one: the claim, the holders, the re-check, the cap, the post. */
  const send = async (event: AlertEvent, memberId: string, joinedAt: string, line: string) => {
    if (!allowed(memberId, joinedAt, event)) return;
    if (!deps.store((s) => s.claim(memberId, event, joinedAt, new Date(deps.now())))) return;
    const pinged = await holders(event, memberId);
    if (!pinged.length || !allowed(memberId, joinedAt, event)) return;
    if (!deps.cap.take()) {
      const day = new Date(deps.now()).toISOString().slice(0, 10);
      if (capLoggedOn !== day) log(`[alerts] the daily cap is reached; no more alerts today`);
      capLoggedOn = day;
      return;
    }
    // Holders past what one message holds are left off, oldest subscriptions first in.
    const content = (ids: readonly string[]) => `${line}\nFor: ${ids.map((id) => `<@${id}>`).join(" ")}`;
    const shown = [...pinged];
    while (content(shown).length > MAX_MESSAGE_CHARS) shown.pop();
    if (shown.length < pinged.length) log(`[alerts] ${pinged.length - shown.length} holders did not fit and were not pinged`);
    await post(content(shown), shown);
    log(`[alerts] ${event} for member ${memberId}: pinged ${shown.length}`);
  };

  const header = (what: string, memberId: string, joinedAt: string) =>
    `${what}: <@${memberId}> · joined ${relative(Date.parse(joinedAt))} · account made ${relative(snowflakeTime(memberId))}`;

  const link = (messageId: string) => `https://discord.com/channels/${deps.guildId}/${WATCHED_CHANNEL}/${messageId}`;

  return {
    /** `MESSAGE_CREATE` in `#introductions`, in any responder mode (the responder's own mode is not read). */
    onMessage: async (message: WatchedMessage): Promise<void> => {
      if (message.channel_id !== WATCHED_CHANNEL || !ready || !deps.switch().on) return;
      // Nothing about the message is kept: the claim holds the author's id and `joined_at` only.
      if (!deps.seeded() || !countsAsIntroduction(message, false)) return;
      await serial(message.author.id, async () => {
        const member = await deps.discord.member(message.author.id);
        if (!member?.joinedAt) return;
        // The responder saw an earlier first post this join: this one is a follow-up.
        const seen = deps.introOf(message.author.id, member.joinedAt);
        if (seen !== null && seen !== message.id) return;
        await send(
          "intro",
          message.author.id,
          member.joinedAt,
          `${header("New introduction", message.author.id, member.joinedAt)}\n${link(message.id)}`,
        );
      });
    },

    /** `GUILD_MEMBER_ADD` and `GUILD_MEMBER_UPDATE`: an alert once they hold `Member`. */
    onMember: async (member: Pick<APIGuildMember, "roles" | "joined_at"> & { user: { id: string; bot?: boolean } }) => {
      if (member.user.bot || !member.joined_at || !allowed(member.user.id, member.joined_at, "join")) return;
      const { member: memberRoles } = deps.roles();
      if (!member.roles.some((r) => memberRoles.has(r))) return;
      const intro = deps.introOf(member.user.id, member.joined_at);
      await send(
        "join",
        member.user.id,
        member.joined_at,
        `${header("New Member", member.user.id, member.joined_at)}\n${intro ? link(intro) : "No introduction yet."}`,
      );
    },

    /**
     * At startup and hourly. The alerts pause, loudly, while the Channel is in
     * the Catalog (its conversation would be captured and summarised) or the
     * bot cannot view and send there.
     */
    check: async (): Promise<boolean> => {
      const failures: string[] = [];
      try {
        if (deps.loadCatalog().some((e) => e.id === ALERTS_CHANNEL)) {
          failures.push("#ambassador-chamber is in the Catalog; exclude it");
          // At once, not after the await below: nothing posts in the meantime.
          ready = false;
        }
        const access = await deps.discord.access();
        if (!access?.view || !access.send) failures.push("#ambassador-chamber cannot be viewed and sent to");
      } catch (error) {
        failures.push(`the checks could not be made: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
      }
      ready = failures.length === 0;
      if (!ready) log(`[alerts] CHECKS FAILED, ALERTS PAUSED: ${failures.join("; ")}.`);
      return ready;
    },
  };
};

export type Alerts = ReturnType<typeof createAlerts>;
