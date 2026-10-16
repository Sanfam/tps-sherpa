/**
 * `/privacy`: the policy, a member's own two settings, and deletion of what
 * Sherpa holds from them (Staff, 2026-10-15).
 *
 * Open to everyone in the guild, not only Members: opting out must never wait
 * on a role. Every member starts with both settings allowed and can turn
 * either off at any time. A setting lives in the durable store and survives a
 * deletion request, because it is what honours one (ADR-0001).
 *
 * Replies say what happened in counts, never in content: nothing a member
 * wrote is echoed back, and nothing here reaches a log but counts.
 */
import { readFileSync } from "node:fs";
import {
  type APIApplicationCommandStringOption,
  type APIChatInputApplicationCommandInteraction,
  type APIEmbed,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import { readActivity, writeActivity } from "../llm/session.ts";
import { SETTINGS, type Preferences, type Setting, withDurableStore } from "../sync/durable-store.ts";
import { openTier0 } from "../sync/tier0-store.ts";

/** Discord's ceiling on an embed's description. */
export const MAX_EMBED_DESCRIPTION = 4096;

const settingOption: APIApplicationCommandStringOption = {
  name: "setting",
  type: ApplicationCommandOptionType.String,
  description: "Which one.",
  required: true,
  choices: [
    { name: "approach — Sherpa reaching out to you", value: "approach" },
    { name: "processing — Sherpa reading what you write", value: "processing" },
  ],
};

export const PRIVACY_COMMAND: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: "privacy",
  type: ApplicationCommandType.ChatInput,
  description: "Your Sherpa privacy settings, the policy, and deleting your data.",
  options: [
    { name: "policy", type: ApplicationCommandOptionType.Subcommand, description: "Read how Sherpa handles what you share." },
    { name: "settings", type: ApplicationCommandOptionType.Subcommand, description: "See your Sherpa settings." },
    { name: "opt-out", type: ApplicationCommandOptionType.Subcommand, description: "Turn something off.", options: [settingOption] },
    { name: "opt-in", type: ApplicationCommandOptionType.Subcommand, description: "Turn something back on.", options: [settingOption] },
    {
      name: "delete-my-data",
      type: ApplicationCommandOptionType.Subcommand,
      description: "Delete what Sherpa holds from your messages.",
      options: [
        {
          name: "confirm",
          type: ApplicationCommandOptionType.Boolean,
          description: "True to delete. It can't be undone.",
          required: true,
        },
      ],
    },
  ],
};

export interface Deleted {
  messages: number;
  places: number;
  summaries: number;
  /** False when another reader held Tier 0's log: the next purge finishes the erasure. */
  checkpointed: boolean;
}

/** What `/privacy` reads and changes. Real stores on temp paths in tests. */
export interface Privacy {
  policy: () => string;
  settings: (memberId: string) => Preferences;
  set: (memberId: string, setting: Setting, allowed: boolean) => void;
  deleteMyData: (memberId: string) => Deleted;
}

/** Each opened per call, like the Catalog: the pipeline writes them while the bot runs. */
export const openPrivacy = (paths: {
  durable: string;
  tier0: string;
  activity: string;
  policy: string;
}): Privacy => ({
  policy: () => readFileSync(paths.policy, "utf8"),
  settings: (memberId) => withDurableStore((s) => s.preferences(memberId), paths.durable),
  set: (memberId, setting, allowed) =>
    withDurableStore((s) => s.setPreference(memberId, setting, allowed), paths.durable),

  /**
   * In an order that a failure part-way can only leave safer, and a retry can
   * finish:
   *
   * 1. Processing off, first and durably. Capture drops their messages from
   *    here on, so nothing deleted below is stored again behind the deletion.
   * 2. Their messages, checkpointed so the zeroed pages reach the file —
   *    before anything parses activity.json, so a corrupt file there cannot
   *    hold the erasure back. Where they wrote is noted first.
   * 3. The activity summaries their messages fed, cleared, so they regenerate
   *    without them: those for the places noted, and those recording them as
   *    an author. A retry after this step fails finds the second kind.
   *
   * Their opt-out itself is kept: it is what honours the request.
   */
  deleteMyData: (memberId) => {
    withDurableStore((s) => s.setPreference(memberId, "processing", false), paths.durable);
    const tier0 = openTier0(paths.tier0);
    let places: string[], messages: number, checkpointed: boolean;
    try {
      places = tier0.authoredIn(memberId);
      messages = tier0.deleteAuthor(memberId);
      checkpointed = tier0.checkpoint();
    } finally {
      tier0.close();
    }
    const activity = readActivity(paths.activity);
    const fed = Object.keys(activity).filter(
      (id) => places.includes(id) || activity[id]!.authors?.includes(memberId),
    );
    for (const id of fed) delete activity[id];
    if (fed.length) writeActivity(activity, paths.activity);
    return { messages, places: places.length, summaries: fed.length, checkpointed };
  },
});

export const POLICY_INTRO = "How Sherpa handles what you share. See your own settings with `/privacy settings`.";
export const NOTHING_DELETED =
  "Nothing was deleted. To delete what Sherpa holds from your messages, run " +
  "`/privacy delete-my-data` with `confirm` set to True.";

/** What a setting means in its current state, and how to flip it. */
export const settingLine = (setting: Setting, allowed: boolean): string =>
  ({
    approach: allowed
      ? "**Reaching out to you: on.** Sherpa may message you without being asked — nothing does yet. " +
        "To turn it off: `/privacy opt-out approach`"
      : "**Reaching out to you: off.** Sherpa won't message you unless you ask it something. " +
        "To turn it back on: `/privacy opt-in approach`",
    processing: allowed
      ? "**Reading what you write: on.** Sherpa may keep your recent messages for up to 7 days to " +
        "describe what's happening around the server, and send your words — what you type into " +
        "`/find` too — to the AI model it uses. To turn it off: `/privacy opt-out processing`"
      : "**Reading what you write: off.** Sherpa doesn't keep your messages or send your words to " +
        "its AI model, so `/find` can't read your requests. The opening message of a Post you " +
        "started still describes that Post — see `/privacy policy`. To turn it back on: " +
        "`/privacy opt-in processing`",
  })[setting];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const renderDeleted = (d: Deleted): string =>
  [
    (d.messages === 0
      ? "Done. Sherpa had none of your messages stored"
      : `Done. Sherpa deleted ${plural(d.messages, "message")} of yours from ${plural(d.places, "place")}`) +
      (d.summaries
        ? `, and cleared ${plural(d.summaries, "activity summary", "activity summaries")} ` +
          "they fed into — those are rewritten without you."
        : d.messages === 0
          ? ", so there was nothing to delete."
          : "."),
    ...(d.checkpointed
      ? []
      : ["Sherpa no longer uses them; the file they were in is wiped at its next cleanup, within six hours."]),
    "Copies in Sherpa's backups age out within 30 days.",
    settingLine("processing", false),
  ].join("\n");

const setting = (value: unknown): Setting | null =>
  SETTINGS.includes(value as Setting) ? (value as Setting) : null;

export type Answer = string | { content: string; embeds: APIEmbed[] };

/**
 * One `/privacy` interaction. Whoever asks is the person whose settings and
 * data these are: Discord vouches for the id, and nothing here touches anyone
 * else's.
 */
export const answerPrivacy = (
  interaction: APIChatInputApplicationCommandInteraction,
  privacy: Privacy,
  log: (m: string) => void,
  tag: string,
): Answer | null => {
  const memberId = interaction.member?.user.id ?? interaction.user?.id;
  const sub = interaction.data.options?.[0];
  if (!memberId || sub?.type !== ApplicationCommandOptionType.Subcommand) return null;
  const option = (name: string) => sub.options?.find((o) => o.name === name)?.value;

  switch (sub.name) {
    case "policy": {
      const text = privacy.policy();
      // Refused rather than cut: half a policy is a wrong one.
      if (text.length > MAX_EMBED_DESCRIPTION)
        throw new Error(`The privacy policy is ${text.length} characters; an embed holds ${MAX_EMBED_DESCRIPTION}.`);
      log(`${tag} policy`);
      return { content: POLICY_INTRO, embeds: [{ description: text }] };
    }
    case "settings": {
      const current = privacy.settings(memberId);
      log(`${tag} settings`);
      return ["Your Sherpa settings:", ...SETTINGS.map((s) => `• ${settingLine(s, current[s])}`)].join("\n");
    }
    case "opt-out":
    case "opt-in": {
      const which = setting(option("setting"));
      if (!which) return null;
      const allowed = sub.name === "opt-in";
      privacy.set(memberId, which, allowed);
      log(`${tag} ${sub.name} ${which}`);
      return `Done. ${settingLine(which, allowed)}` +
        (which === "processing" && !allowed
          ? "\nMessages Sherpa already kept are cleared within 7 days, or right now with `/privacy delete-my-data`."
          : "");
    }
    case "delete-my-data": {
      if (option("confirm") !== true) {
        log(`${tag} delete-my-data not confirmed`);
        return NOTHING_DELETED;
      }
      const deleted = privacy.deleteMyData(memberId);
      log(`${tag} delete-my-data messages=${deleted.messages} places=${deleted.places} summaries=${deleted.summaries}`);
      if (!deleted.checkpointed) log(`${tag} checkpoint busy; the next purge completes it`);
      return renderDeleted(deleted);
    }
  }
  return null;
};
