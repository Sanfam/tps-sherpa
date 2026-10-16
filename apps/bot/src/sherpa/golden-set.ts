/**
 * The `/find` golden set: the architecture's recommendation-matching cases,
 * rewritten as slash-command queries.
 *
 * Every query is synthetic. The repository is public, so no case quotes a
 * member, names one, or mentions a child; the ids say what each case tests,
 * not whose introduction it came from. The introductions responder's
 * suppression cases ("a human already helped") have no `/find` analogue — a
 * slash command is a member asking — so they are left to that responder.
 *
 * Expectations are Catalog names, resolved when the eval runs: Entity ids
 * would pin the set to one sync. Each entry is any-of, because the Catalog
 * often has more than one honest answer — a Post and a Channel for the same
 * thing — and the case is about the interest being covered, not which of
 * them wins.
 */
import type { Entity } from "../sync/catalog.ts";

export type GoldenCase =
  | { id: string; query: string; mustSurface: string[][] }
  /** No specific interest: fewer than two matches, and the template says so. */
  | { id: string; query: string; expect: "few" }
  /** Nothing typed: no model call at all. */
  | { id: string; query: string; expect: "none" };

export const GOLDEN_SET: GoldenCase[] = [
  {
    // The primary test: matches a person skimming the list would miss.
    id: "long-tail",
    query:
      "I run a small logistics business and I'm always looking to swap notes with other owners. " +
      "Lately I've been working through some doubts about the faith I grew up in, and honestly " +
      "I'm wondering whether to change careers altogether.",
    mustSurface: [["Faith & Religion"], ["Entrepreneurs & Business Owners"], ["Career"]],
  },
  {
    id: "rich-signal",
    query:
      "I'm home full time with the kids while my wife works, and once everyone's in bed I play " +
      "Rocket League most nights.",
    mustSurface: [
      ["Stay at home dads", "🦸‍♂️︱sahd"],
      ["Rocket League!", "Rocket League | The Division 2 | Co-op Madden"],
    ],
  },
  {
    // The signal arrives at the end, after a sentence of nothing.
    id: "late-signal",
    query:
      "Not sure what to put here, I mostly lurk. Based in Minnesota. I fly small planes when the " +
      "weather allows, and when it doesn't I'm in flight sims or building cities in Cities: Skylines.",
    mustSurface: [
      ["Flight Simulators", "Microsoft Flight Simulator 2020"],
      ["Aviation/Flying"],
      ["Cities: Skylines"],
      ["Minnesota!"],
    ],
  },
  { id: "low-signal", query: "hello", expect: "few" },
  { id: "empty", query: "", expect: "none" },
  { id: "whitespace", query: "   \n  ", expect: "none" },
];

/** Case, emoji, separators and punctuation all ignored: "🦸‍♂️︱sahd" is "sahd". */
export const normaliseName = (name: string): string =>
  name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Each expected name, as the Entities that carry it. Throws on a name that
 * resolves to nothing — a renamed Post would otherwise turn a case into one
 * that can never pass, or worse, one that silently expects less.
 */
export const resolveExpected = (names: string[][], candidates: Entity[]): Set<string>[] =>
  names.map(
    (group) =>
      new Set(
        group.flatMap((name) => {
          const ids = candidates.filter((e) => normaliseName(e.name) === normaliseName(name));
          if (ids.length === 0)
            throw new Error(`Golden set: "${name}" is not a /find candidate in this Catalog.`);
          return ids.map((e) => e.id);
        }),
      ),
  );
