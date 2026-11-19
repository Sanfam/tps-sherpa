// The routes EmDash injects in external-auth mode, read from its source, and
// the ones that must never be reached, written here independently of the gate.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The workspace installs EmDash at the repo root. Every injector runs except
// the built-in sign-in and auth-provider ones (integration/index.ts).
const source = readFileSync(join(import.meta.dirname, "../../../node_modules/emdash/src/astro/integration/routes.ts"), "utf8");
const injectors = source
  .split(/^export function /m)
  .slice(1) // the preamble: imports and the InjectRoute type
  .filter((fn) => !/^(injectBuiltinAuthRoutes|injectAuthProviderRoutes)\b/.test(fn));
export const injected = injectors.flatMap((fn) => [...fn.matchAll(/pattern:\s*"([^"]+)"/g)].map((m) => m[1]!));
/** `pattern:` keys the parse could not read: a pattern built some other way. */
export const unread = injectors.reduce((n, fn) => n + (fn.match(/pattern:/g)?.length ?? 0), 0) - injected.length;

/** A path for a pattern, with every parameter filled. */
export const concrete = (pattern: string) => pattern.replace(/\[\.\.\.[^\]]+\]/g, "a/b").replace(/\[[^\]]+\]/g, "x1");

/** Credentials, whole-site exports, and code from outside: refused to everyone.
 * Not API tokens and MCP: an Admin's session reaches the one, a token on its
 * holder's live role the other (owner, 2026-11-18); gate.test.ts holds both. */
export const NEVER =
  /oauth|well-known|preview-url|visual-editing|send-recovery|upload-url|setup\/admin|\/dev-|snapshot|backups|transfer|plugin|import\/|\/dev\/|typegen|themes|core-update/;
