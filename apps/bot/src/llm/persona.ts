/**
 * `content/config/persona.json`: Sherpa's voice for its replies to @mentions
 * (#49, ADR-0004). No imports, so the content check can run it on a clean
 * checkout, as it does the vocabulary's parser.
 */

/** The voice, reviewed like the vocabulary (D49-7). */
export interface Persona {
  voice: string;
  fallback: string;
  /** In order: the asker's first matching role, by name, picks the line. */
  signoffs: Array<{ role: string; line: string }>;
}

/** Throws on a malformed file: a persona that half-loads would speak in no voice at all. */
export const parsePersona = (raw: string): Persona => {
  const p = JSON.parse(raw) as Record<string, unknown>;
  const lines = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim());
  const signoffs = p["signoffs"];
  if (
    !lines(p["voice"]) ||
    typeof p["fallback"] !== "string" ||
    !p["fallback"].trim() ||
    !Array.isArray(signoffs) ||
    !signoffs.every((s) => lines([(s as Record<string, unknown>)?.["role"], (s as Record<string, unknown>)?.["line"]]))
  )
    throw new Error("The persona file is not the persona shape.");
  return {
    voice: (p["voice"] as string[]).join("\n"),
    fallback: p["fallback"],
    signoffs: signoffs as Persona["signoffs"],
  };
};
