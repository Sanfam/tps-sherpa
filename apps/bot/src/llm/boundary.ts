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
import { isMonitored } from "../sync/tier0.ts";

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
  /**
   * The Entity or Entities being described. Every one is checked against the
   * monitored carve-out — the vocabulary bootstrap reasons over a whole sample
   * at once, and a list that skipped the check for all but the first would be
   * the carve-out failing exactly where the most text goes out.
   */
  subject: Entity | Entity[];
  /** Non-member text — a name, a topic, a frozen vocabulary. Redacted anyway. */
  context?: string;
  /** Member-authored text. Bots, opt-outs and identifiers are removed first. */
  sources?: Source[];
  /**
   * Returned without a model call when `sources` were given and filtering
   * removed every one, whatever `context` holds. When absent, that case is
   * an error.
   */
  orNothing?: T;
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
   * Member names: replaced on the way out, refused on the way back.
   * `openBoundary` passes the member-name cache (`tier0-store.ts`). When it is
   * empty the boundary says so once, rather than letting an empty set read as
   * a passing check.
   */
  memberNames?: Iterable<string>;
  /**
   * Whether a member has turned processing off (`/privacy`). `openBoundary`
   * wires it to the durable store for every boundary the bot builds; the
   * default of "nobody has" is for tests. The check happens BEFORE the call
   * by construction.
   */
  hasOptedOut?: (authorId: string) => boolean;
  /**
   * The monitored channels' ids (`readMonitored`). Required, as the Catalog
   * is: a boundary that has not been told what is monitored must not exist,
   * because an empty default would carve out nothing.
   */
  monitored: ReadonlySet<string>;
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
export const namePattern = (name: string): RegExp =>
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
  const { monitored } = deps;
  const hasOptedOut = deps.hasOptedOut ?? (() => false);
  // Longest first, so "Dave Smith" is replaced whole before "Dave" can leave
  // "@member Smith" behind.
  const memberNames = [...(deps.memberNames ?? [])]
    .filter((n) => n.trim().length > 0)
    .sort((a, b) => b.length - a.length);
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
   *
   * The message names the category, never the offending text: these errors
   * are retried and logged, and quoting the snowflake, the name or the line
   * around a mass mention would copy exactly what was refused into a log.
   */
  const validate = (value: unknown, checkNames = true): void => {
    for (const text of strings(value)) {
      if (SNOWFLAKE.test(text))
        throw new Error(
          `Model output contains a Discord identifier. ` +
            `Refusing it — this is a containment failure, not a formatting one.`,
        );
      if (MASS_MENTION.test(text)) throw new Error(`Model output contains a mass mention.`);
      if (checkNames && namePatterns.some((pattern) => pattern.test(text)))
        throw new Error(`Model output names a member.`);
    }
  };

  return {
    ask: async <T>(request: AskRequest<T>): Promise<T> => {
      // Fail closed. `isMonitored` answers false for a parent it cannot see,
      // so a Thread whose parent is missing from the Catalog would read as
      // unmonitored — and the intro *threads* are where the actual
      // introductions are, which is precisely the content the carve-out
      // protects. An unresolvable parent is a broken input, not a permission.
      const subjects = Array.isArray(request.subject) ? request.subject : [request.subject];
      if (subjects.length === 0)
        throw new Error("ask() was given no subject, so no carve-out check can be made.");
      for (const subject of subjects) {
        if (subject.parent_id && !byId.has(subject.parent_id))
          throw new Error(
            `"${subject.name}" has parent ${subject.parent_id}, which is not in ` +
              `the Catalog, so the monitored-channel check cannot be made. ` +
              `Refusing rather than assuming it is safe.`,
          );
        // Withheld means nothing is derived from it, so nothing about it is
        // sent. Callers filter too; this is here so one that forgets cannot
        // leak, which is the reason the monitored check lives here as well.
        if (subject.description_status === "withheld")
          throw new Error(
            `"${subject.name}" is withheld: listed without content, never sampled. ` +
              `It must never reach a model.`,
          );
        if (isMonitored(subject, byId, monitored))
          throw new Error(
            `"${subject.name}" is monitored conversation, which is ` +
              `extract-and-discard. It must never reach a model.`,
          );
      }

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
      // for. Anything member-shaped in there is a bug in the caller. Not
      // against member names, though: the prompt is fixed text, and a member
      // whose name is an ordinary word in it ("games", "work") would otherwise
      // stop every call.
      validate(request.system, false);

      const sourceParts = usable.map((s) => redactOutbound(s.content)).filter((p) => p.trim());
      const parts = [request.context ? redactOutbound(request.context) : "", ...sourceParts].filter(
        (p) => p.trim().length > 0,
      );

      // Member sources were the point of the call and filtering removed every
      // one — all bots, all opted out. Asked about nothing but context, a
      // model answers anyway, and that answer is invention.
      if ((request.sources?.length ?? 0) > 0 && sourceParts.length === 0) {
        if ("orNothing" in request) return request.orNothing as T;
        throw new Error("Every source was filtered out before the call; refusing an empty prompt.");
      }

      const raw = await deps.chat.complete({
        model: deps.models[request.role],
        system: request.system,
        user: parts.join("\n"),
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // The length, never the text. A model that answered with prose may
        // have echoed member messages back, and redaction cannot remove a
        // plain-text name it was never told about — an exception message is a
        // place logs keep things.
        throw new Error(`Model did not return JSON (${raw.length} characters).`);
      }
      validate(parsed);
      return request.parse(parsed);
    },
  };
};

export type Boundary = ReturnType<typeof createBoundary>;
