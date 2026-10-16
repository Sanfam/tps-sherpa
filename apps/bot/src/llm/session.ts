/**
 * The pieces every LLM command needs: the stored Catalog, the name lookup
 * redaction runs against, and a boundary wired to the configured provider.
 *
 * Shared so the three commands cannot end up with three different ideas of
 * what a name is. A boundary built with an empty `names` map still redacts
 * snowflakes, but it publishes `#unknown-channel` where a real name belonged —
 * a quiet degradation, which is the kind this module exists to prevent.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Entity } from "../sync/catalog.ts";
import { readCurrent, readProcessingOptOuts } from "../sync/durable-store.ts";
import type { NameLookup } from "../sync/normalise.ts";
import type { RoleManifestEntry } from "../sync/ports.ts";
import type { ActivityStore } from "./activity.ts";
import { createBoundary, type Boundary } from "./boundary.ts";
import { openAiWire, wireFromEnv } from "./openai-wire.ts";

export const contentPath = (rel: string): string =>
  resolve(import.meta.dirname, "../../../../content", rel);

export const VOCABULARY_PATH = contentPath("config/topics.json");
export const VOCABULARY_PROPOSAL_PATH = contentPath("config/topics.proposed.json");

/** The bot's volume: never committed, never in the Catalog's snapshot. */
export const DATA_DIR = resolve(import.meta.dirname, "../../.data");
/** Activity summaries. Bot-side only — see activity.ts. */
export const ACTIVITY_PATH = resolve(DATA_DIR, "activity.json");
/** Owner-authorized (2026-10-15) and edited by hand; nothing in the pipeline writes it. */
export const PRIVACY_POLICY_PATH = contentPath("privacy-policy.md");

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

export const readActivity = (path: string = ACTIVITY_PATH): ActivityStore =>
  JSON.parse(readIfPresent(path) ?? "{}") as ActivityStore;

/**
 * Written beside the file and renamed into place: the gateway reads it for
 * `/lately` and edits it for a deletion while a pipeline step may be writing
 * it, and none of them may ever see half a file.
 */
export const writeActivity = (store: ActivityStore, path: string = ACTIVITY_PATH): void => {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(partial, path);
};

/** The current generation, from the bot's durable store (ADR-0001). */
export const loadCatalog = (): Entity[] => readCurrent().catalog;

/** The current generation's role manifest, stored with its Catalog. */
export const loadRoleManifest = (): RoleManifestEntry[] => readCurrent().roleManifest;

/**
 * Every Entity is a `<#id>` target, so the lookup covers the whole Catalog —
 * Posts and Threads included, not just containers.
 */
export const nameLookup = (catalog: Entity[]): NameLookup => {
  const roles = loadRoleManifest();
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
      // Read fresh for every source, not once for the boundary: an enrichment
      // pass runs for minutes, and an opt-out made part-way stops the next
      // call. Every boundary gets it: there is no way to build one that has
      // not heard who opted out.
      // ponytail: one bot.db open per source, ~1ms; a kept read connection if
      // a pass ever sends enough sources for that to show.
      hasOptedOut: (authorId) => readProcessingOptOuts().has(authorId),
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
