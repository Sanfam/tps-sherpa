/**
 * `/sherpa introductions`: Staff's controls for the introductions responder —
 * its mode, its clock and its thresholds (§7). Staff-only: the dispatcher
 * checks `isStaff` before this runs (interactions.ts). Every reply is
 * ephemeral, like every other.
 *
 * Setting `live` is what lets Sherpa post in `#introductions` (D6), so it is
 * logged loudly, with who did it.
 */
import {
  type APIApplicationCommandIntegerOption,
  type APIChatInputApplicationCommandInteraction,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import type { ClockMode, TimingSettings } from "./responder-decide.ts";
import { MODES, type Mode, type ResponderStore, type SettingKey } from "./responder-store.ts";

const CLOCKS: readonly ClockMode[] = ["wall", "active"];

/** Each threshold's key, its bounds, and its value with no row (§3). Recommend is also at least greet. */
const TIMING = {
  greet: { key: "greet_minutes", min: 1, max: 120, default: 10, unit: "minutes" },
  recommend: { key: "recommend_minutes", min: 1, max: 360, default: 20, unit: "minutes" },
  ceiling: { key: "ceiling_active_hours", min: 1, max: 24, default: 6, unit: "active hours" },
} as const satisfies Record<string, { key: SettingKey; min: number; max: number; default: number; unit: string }>;
type TimingName = keyof typeof TIMING;
const TIMING_NAMES = Object.keys(TIMING) as TimingName[];

const timingOption = (name: TimingName, description: string): APIApplicationCommandIntegerOption => ({
  name,
  type: ApplicationCommandOptionType.Integer,
  description,
  required: false,
  min_value: TIMING[name].min,
  max_value: TIMING[name].max,
});

export const SHERPA_COMMAND: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: "sherpa",
  type: ApplicationCommandType.ChatInput,
  description: "Staff: Sherpa's controls.",
  options: [
    {
      name: "introductions",
      type: ApplicationCommandOptionType.SubcommandGroup,
      description: "Sherpa's replies to #introductions.",
      options: [
        {
          name: "mode",
          type: ApplicationCommandOptionType.Subcommand,
          description: "Off, shadow (replies go to #bot-tests), or live (replies go in #introductions).",
          options: [
            {
              name: "mode",
              type: ApplicationCommandOptionType.String,
              description: "Which mode.",
              required: true,
              choices: MODES.map((m) => ({ name: m, value: m })),
            },
          ],
        },
        {
          name: "clock",
          type: ApplicationCommandOptionType.Subcommand,
          description: "Count minutes on the wall clock, or only minutes when others are talking.",
          options: [
            {
              name: "clock",
              type: ApplicationCommandOptionType.String,
              description: "Which clock.",
              required: true,
              choices: CLOCKS.map((c) => ({ name: c, value: c })),
            },
          ],
        },
        {
          name: "timing",
          type: ApplicationCommandOptionType.Subcommand,
          description: "When Sherpa greets, recommends, and gives up. Set any of them.",
          options: [
            timingOption("greet", "Minutes before a welcome and one question, 1–120."),
            timingOption("recommend", "Minutes before recommending places, at least greet and at most 360."),
            timingOption("ceiling", "Active hours before a plain welcome, 1–24."),
          ],
        },
        { name: "status", type: ApplicationCommandOptionType.Subcommand, description: "Show the current settings." },
      ],
    },
  ],
};

/** What `/sherpa` reads and changes, on one connection per command. A real store on a temp path in tests. */
export type Settings = Pick<ResponderStore, "mode" | "setMode" | "setting" | "setSetting">;
export type WithSettings = <T>(work: (settings: Settings) => T) => T;

/** A stored threshold, or its default with no row or one it cannot read. */
const timing = (settings: Pick<Settings, "setting">, name: TimingName): number => {
  const stored = Number(settings.setting(TIMING[name].key) ?? Number.NaN);
  return Number.isSafeInteger(stored) ? stored : TIMING[name].default;
};

/** The clock Staff set, or `wall` until they set one (owner, 2026-10-18). */
const clockOf = (settings: Pick<Settings, "setting">): ClockMode =>
  CLOCKS.find((c) => c === settings.setting("clock")) ?? "wall";

/** What `decide` runs on, read fresh before every decision (§7). The one home of the defaults. */
export const timingSettings = (settings: Pick<Settings, "setting">): TimingSettings => ({
  clock: clockOf(settings),
  greetMinutes: timing(settings, "greet"),
  recommendMinutes: timing(settings, "recommend"),
  ceilingActiveHours: timing(settings, "ceiling"),
});

const status = (settings: Settings): string => {
  return [
    `Mode: **${settings.mode()}**`,
    `Clock: **${clockOf(settings)}**`,
    ...TIMING_NAMES.map((n) => `${n[0]!.toUpperCase()}${n.slice(1)}: **${timing(settings, n)}** ${TIMING[n].unit}`),
  ].join("\n");
};

/**
 * The shadow tally as text, for `status` (§8). Throws when Discord cannot be
 * read; status then says so and still shows the settings.
 */
export type TallyText = () => Promise<string>;

/** One `/sherpa` interaction. Logs ids and setting values only. Null for a shape it does not know. */
export const answerSherpa = async (
  interaction: APIChatInputApplicationCommandInteraction,
  withSettings: WithSettings,
  log: (m: string) => void,
  tag: string,
  tally?: TallyText,
): Promise<string | null> => {
  const by = interaction.member?.user.id;
  const group = interaction.data.options?.[0];
  if (!by || group?.type !== ApplicationCommandOptionType.SubcommandGroup || group.name !== "introductions")
    return null;
  const sub = group.options[0];
  if (!sub) return null;
  const value = (name: string) => sub.options?.find((o) => o.name === name)?.value;

  switch (sub.name) {
    case "mode": {
      const mode = MODES.find((m) => m === value("mode"));
      if (!mode) return null;
      withSettings((s) => s.setMode(mode, by));
      if (mode === "live")
        log(`${tag} INTRODUCTIONS MODE SET TO LIVE by ${by}: Sherpa's replies now post in #introductions.`);
      else log(`${tag} mode ${mode} by ${by}`);
      return `Done. Introductions mode is **${mode}**.` + (mode === "live" ? " Sherpa's replies now post in #introductions." : "");
    }
    case "clock": {
      const clock = CLOCKS.find((c) => c === value("clock"));
      if (!clock) return null;
      withSettings((s) => s.setSetting("clock", clock, by));
      log(`${tag} clock ${clock} by ${by}`);
      return `Done. The clock is **${clock}**.`;
    }
    case "timing": {
      const given = TIMING_NAMES.filter((n) => value(n) !== undefined);
      if (!given.length) return "Give at least one of `greet`, `recommend` or `ceiling`.";
      return withSettings((s) => {
        // The combination is checked against what is stored, so a lone greet cannot pass recommend.
        const next = Object.fromEntries(
          TIMING_NAMES.map((n) => [n, given.includes(n) ? value(n) : timing(s, n)]),
        ) as Record<TimingName, unknown>;
        for (const n of TIMING_NAMES) {
          const v = next[n];
          if (!Number.isSafeInteger(v) || (v as number) < TIMING[n].min || (v as number) > TIMING[n].max) {
            log(`${tag} timing refused: ${n} out of bounds`);
            return `Nothing changed: ${n} must be a whole number from ${TIMING[n].min} to ${TIMING[n].max} ${TIMING[n].unit}.`;
          }
        }
        if ((next.recommend as number) < (next.greet as number)) {
          log(`${tag} timing refused: recommend below greet`);
          return `Nothing changed: recommend (${next.recommend} minutes) must be at least greet (${next.greet} minutes).`;
        }
        for (const n of given) s.setSetting(TIMING[n].key, String(next[n]), by);
        log(`${tag} timing ${given.map((n) => `${n}=${next[n]}`).join(" ")} by ${by}`);
        return `Done.\n${status(s)}`;
      });
    }
    case "status": {
      log(`${tag} status`);
      const settings = withSettings(status);
      try {
        if (!tally) throw new Error("no tally port");
        return `${settings}\n${await tally()}`;
      } catch (error) {
        log(`${tag} tally unavailable: ${(error as Error).message.slice(0, 160)}`);
        return `${settings}\nShadow tally: unavailable right now.`;
      }
    }
  }
  return null;
};
