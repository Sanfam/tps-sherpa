/**
 * The pieces every LLM command needs: the committed Catalog, the name lookup
 * redaction runs against, and a boundary wired to the configured provider.
 *
 * Shared so the three commands cannot end up with three different ideas of
 * what a name is. A boundary built with an empty `names` map still redacts
 * snowflakes, but it publishes `#unknown-channel` where a real name belonged —
 * a quiet degradation, which is the kind this module exists to prevent.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Entity } from "../sync/catalog.ts";
import type { NameLookup } from "../sync/normalise.ts";
import { createBoundary, type Boundary } from "./boundary.ts";
import { openAiWire, wireFromEnv } from "./openai-wire.ts";

export const contentPath = (rel: string): string =>
  resolve(import.meta.dirname, "../../../../content", rel);

export const CATALOG_PATH = contentPath("index/data.json");
export const VOCABULARY_PATH = contentPath("config/topics.json");
export const VOCABULARY_PROPOSAL_PATH = contentPath("config/topics.proposed.json");

export const readIfPresent = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    // Only a missing file is an absence. Anything else — a permissions error,
    // a truncated read — must not be quietly treated as "there is nothing
    // here", which is how a fail-closed check fails open.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const loadCatalog = (): Entity[] =>
  JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Entity[];

/**
 * Every Entity is a `<#id>` target, so the lookup covers the whole Catalog —
 * Posts and Threads included, not just containers.
 */
export const nameLookup = (catalog: Entity[]): NameLookup => {
  const roles = JSON.parse(
    readIfPresent(contentPath("config/roles.json")) ?? "[]",
  ) as Array<{ name: string; ids: string[] }>;
  return {
    channels: new Map(catalog.map((e) => [e.id, e.name])),
    roles: new Map(roles.flatMap((r) => r.ids.map((id) => [id, r.name] as const))),
  };
};

export const openBoundary = (
  catalog: Entity[],
  /**
   * Overrides the configured model for a role. Which model is strong and which
   * is cheap is an experiment, so every command that spends money on one can
   * be pointed at a candidate without editing config.
   */
  override: Partial<Record<"strong" | "cheap", string>> = {},
  /**
   * A job that legitimately needs longer than the default. Sized where the
   * requirement is, not globally: the per-Entity passes answer in seconds and
   * want a short leash, while one derivation over a hundred entries was
   * measured at 205s doing real work. One number cannot serve both, and
   * raising the global default to suit the slow job leaves the 1,200-call
   * passes waiting minutes on anything that hangs.
   */
  timeoutMs?: number,
): { boundary: Boundary; models: Record<"strong" | "cheap", string>; baseUrl: string } => {
  const { wire, models: configured } = wireFromEnv();
  const models = { ...configured, ...Object.fromEntries(Object.entries(override).filter(([, v]) => v)) };
  return {
    boundary: createBoundary({
      // An explicit LLM_TIMEOUT_MS still wins: it is the operator's override.
      chat: openAiWire(timeoutMs && !process.env["LLM_TIMEOUT_MS"] ? { ...wire, timeoutMs } : wire),
      models,
      catalog,
      names: nameLookup(catalog),
      warn: (m) => console.warn(m),
    }),
    models,
    baseUrl: wire.baseUrl,
  };
};

/**
 * One retry, then give up.
 *
 * A model that returns `{}` once will usually return the right shape on the
 * next attempt, and a job of two thousand calls that dies on the first bad one
 * has thrown away every call before it. Two attempts, because a model that
 * fails twice is answering the wrong question rather than having a bad moment,
 * and looping past that turns a prompt bug into a bill.
 */
export const retrying = async <T>(work: () => Promise<T>, warn?: (m: string) => void): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    warn?.(`[llm] retrying after: ${(error as Error).message.slice(0, 160)}`);
    return work();
  }
};

/** `--flag value` and `--flag`, which is all any of these commands needs. */
export const flag = (name: string, argv: string[] = process.argv.slice(2)): string | null => {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return null;
  const next = argv[at + 1];
  return next && !next.startsWith("--") ? next : "";
};
