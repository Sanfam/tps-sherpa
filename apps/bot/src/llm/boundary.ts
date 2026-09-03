/**
 * The one place text goes to a model.
 *
 * Everything about this module is containment. Redaction is a function applied
 * before the call, not an instruction inside the prompt — a prompt is a request
 * and a function is a guarantee. Output is validated on the way back, and a
 * violation throws rather than degrading, because a leak that logs a warning
 * and publishes anyway is a leak.
 *
 * Nothing outside this directory may call a model. There is no SDK to import:
 * the wire is `fetch` against the OpenAI chat-completions shape, so swapping
 * DeepSeek for Kimi for a local model is an environment variable.
 */
import type { Entity } from "../sync/catalog.ts";
import { resolveIdentifiers } from "../sync/normalise.ts";
import type { NameLookup } from "../sync/normalise.ts";
import { DEFAULT_MONITORED_CHANNELS, isMonitored } from "../sync/tier0.ts";

/**
 * Strong for one-time work that sets something in stone — deriving the Topic
 * vocabulary, writing identity summaries. Cheap for steady state, which is
 * most of the volume.
 */
export type ModelRole = "strong" | "cheap";

/** The wire. Satisfied by `openAiWire` in production and a fixture in tests. */
export interface ChatPort {
  complete: (request: {
    model: string;
    system: string;
    user: string;
  }) => Promise<string>;
}

/** One member-authored message, as Tier 0 stores it. */
export interface Source {
  authorId: string;
  authorIsBot: boolean;
  content: string;
}

export interface AskRequest<T> {
  role: ModelRole;
  /** The instruction. Must ask for JSON: model prose never reaches a person. */
  system: string;
  /** The Entity being described. Checked against the monitored carve-out. */
  subject: Entity;
  /** Non-member text — a name, a topic, a frozen vocabulary. Redacted anyway. */
  context?: string;
  /** Member-authored text. Bots, opt-outs and identifiers are removed first. */
  sources?: Source[];
  /**
   * Validates the model's JSON and narrows it. Throw to reject: a model that
   * answered the wrong shape has not answered.
   */
  parse: (value: unknown) => T;
}

export interface BoundaryDeps {
  chat: ChatPort;
  models: Record<ModelRole, string>;
  /**
   * The Catalog, so the monitored-channel check can resolve a subject's
   * parent. Required: a Thread inside `👋︱introductions` is monitored
   * conversation, and a check that cannot see the parent silently allows
   * exactly the content the carve-out exists to protect.
   */
  catalog: Entity[];
  /** For resolving `<#id>` and `<@&id>` to names before the call. */
  names: NameLookup;
  /**
   * Display names that must never appear in output.
   *
   * Empty today: nothing fetches the guild's member list yet, so there is no
   * cache to check against. The boundary says so once rather than letting an
   * empty set read as a passing check.
   */
  memberNames?: Iterable<string>;
  /**
   * Whether a member has asked not to be remembered. Defaults to "nobody has",
   * which is true: opt-out has no store until members can set it in Phase 3.
   * It is wired in here now so the check happens BEFORE the call by
   * construction, rather than being retrofitted onto a working pipeline.
   */
  hasOptedOut?: (authorId: string) => boolean;
  /** Overrides the monitored-channel carve-out. Tests only. */
  monitored?: readonly string[];
  warn?: (message: string) => void;
}

/** Any 17–20 digit run is a Discord snowflake. */
const SNOWFLAKE = /\d{17,20}/;

/**
 * A member name, bounded by Unicode letters and digits rather than `\b`.
 *
 * `\b` is ASCII-only, so a display name edged with emoji or punctuation —
 * `Schwagle 👦5 👧2` is a real one in this guild — would slip past the check
 * that exists to catch it. Compiled once at construction so a name that
 * cannot form a pattern fails loudly then, not on the first model call.
 */
const namePattern = (name: string): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
    "iu",
  );

/** Would ping the guild if a template ever rendered it into Discord. */
const MASS_MENTION = /@(everyone|here)\b/i;

/**
 * Discord identifiers out, then any bare snowflake someone pasted as plain
 * text. `resolveIdentifiers` only sees markup; a raw ID in a message body is
 * still an identifier.
 */
export const redact = (text: string, names: NameLookup): string =>
  resolveIdentifiers(text, names).replace(/\d{17,20}/g, "[id]");

/**
 * Every string anywhere in a parsed JSON value — **keys included**.
 *
 * A model is perfectly capable of answering `{"732682426853359667": "..."}`,
 * and a validator that only walks values would wave it through.
 */
const strings = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, nested]) => [key, ...strings(nested)]);
  return [];
};

export const createBoundary = (deps: BoundaryDeps) => {
  const monitored = new Set(deps.monitored ?? DEFAULT_MONITORED_CHANNELS);
  const hasOptedOut = deps.hasOptedOut ?? (() => false);
  const memberNames = [...(deps.memberNames ?? [])].filter((n) => n.trim().length > 0);
  const namePatterns = memberNames.map(namePattern);
  const byId = new Map(deps.catalog.map((e) => [e.id, e]));
  let warnedAboutNames = false;

  /**
   * Everything that leaves, leaves through here: Discord markup resolved, bare
   * snowflakes stripped, known member names replaced.
   *
   * Names are redacted on the way OUT as well as validated on the way BACK.
   * Validating only the response would mean a name the model never repeated
   * was still handed to the provider, which is the disclosure the redaction
   * boundary exists to prevent.
   */
  const redactOutbound = (text: string): string =>
    namePatterns.reduce(
      (acc, pattern) => acc.replace(new RegExp(pattern.source, "giu"), "@member"),
      redact(text, deps.names),
    );

  /**
   * Throws on anything the model should never have been able to say. Loud on
   * purpose: the alternative is a quiet strip, which turns a containment
   * failure into a cosmetic one and hides that the prompt is wrong.
   */
  const validate = (value: unknown): void => {
    for (const text of strings(value)) {
      const snowflake = SNOWFLAKE.exec(text);
      if (snowflake)
        throw new Error(
          `Model output contains a Discord identifier (${snowflake[0]}). ` +
            `Refusing it — this is a containment failure, not a formatting one.`,
        );
      if (MASS_MENTION.test(text))
        throw new Error(`Model output contains a mass mention: ${text.slice(0, 80)}`);
      for (const [index, pattern] of namePatterns.entries())
        if (pattern.test(text))
          throw new Error(`Model output names a member: ${memberNames[index]}`);
    }
  };

  return {
    ask: async <T>(request: AskRequest<T>): Promise<T> => {
      // Fail closed. `isMonitored` answers false for a parent it cannot see,
      // so a Thread whose parent is missing from the Catalog would read as
      // unmonitored — and the intro *threads* are where the actual
      // introductions are, which is precisely the content the carve-out
      // protects. An unresolvable parent is a broken input, not a permission.
      const subject = request.subject;
      if (subject.parent_id && !byId.has(subject.parent_id))
        throw new Error(
          `"${subject.name}" has parent ${subject.parent_id}, which is not in ` +
            `the Catalog, so the monitored-channel check cannot be made. ` +
            `Refusing rather than assuming it is safe.`,
        );
      if (isMonitored(subject, byId, monitored))
        throw new Error(
          `"${request.subject.name}" is monitored conversation, which is ` +
            `extract-and-discard. It must never reach a model.`,
        );

      if (memberNames.length === 0 && !warnedAboutNames) {
        warnedAboutNames = true;
        deps.warn?.(
          `[llm] No member-name cache configured, so output is validated ` +
            `against snowflakes and mass mentions only. Names would pass.`,
        );
      }

      // Opt-out first: a member who asked not to be remembered must not have
      // their words sent anywhere, and "we redacted it" is not the same
      // promise. Bots go too — a webhook's output is not a member's words.
      const usable = (request.sources ?? []).filter(
        (s) => !s.authorIsBot && !hasOptedOut(s.authorId),
      );

      // The system prompt is our own text, so it is validated rather than
      // redacted: rewriting an instruction can silently change what was asked
      // for. Anything member-shaped in there is a bug in the caller.
      validate(request.system);

      const parts = [
        request.context ? redactOutbound(request.context) : null,
        ...usable.map((s) => redactOutbound(s.content)),
      ].filter((p): p is string => p !== null && p.trim().length > 0);

      const raw = await deps.chat.complete({
        model: deps.models[request.role],
        system: request.system,
        user: parts.join("\n"),
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Redacted before it goes anywhere a log can keep it. A model that
        // answered with prose may well have echoed its input back.
        throw new Error(`Model did not return JSON: ${redactOutbound(raw).slice(0, 200)}`);
      }
      validate(parsed);
      return request.parse(parsed);
    },
  };
};

export type Boundary = ReturnType<typeof createBoundary>;
