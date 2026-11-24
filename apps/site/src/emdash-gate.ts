/**
 * The gate in EmDash's `middleware.outer` hook (ADR-0002, open item 2). It runs
 * before any of EmDash, on every request, and places each EmDash route by
 * who may reach it. A route on no list is refused, so a route an upgrade adds
 * stays shut until it is placed here; test/emdash-gate.test.ts fails until it is.
 *
 * Roles are the live ones on the site session (memberRoles), so a removed role
 * shuts EmDash's public `search` too, where EmDash itself would trust the role
 * it stored last. A request carrying an EmDash API token is held to its
 * holder's live roles instead (tokenRole, below).
 */
import { createHash } from "node:crypto";
import dc from "node:diagnostics_channel";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import type { MiddlewareHandler } from "astro";
import { liveRoles, memberRoles, rolesTtl } from "./auth.ts";
import { ADMIN, editorRole } from "./emdash-auth.ts";
import { dbPath } from "./emdash-erasure.ts";

// Route patterns as EmDash injects them (integration/routes.ts, 1.5.0).

/** Refused to everyone, and checked first: a parameter in an allowed pattern
 * would otherwise match some of these static paths. Credential routes are here,
 * because every credential must come from the site session or an API token
 * the gate holds to its holder's live roles. */
export const REFUSED = [
  // EmDash's OAuth server, device flow, OAuth clients and plugins' MCP.
  "/.well-known/oauth-authorization-server/_emdash",
  "/.well-known/oauth-protected-resource",
  "/_emdash/.well-known/auth",
  "/_emdash/oauth/authorize",
  "/_emdash/api/oauth/device/authorize",
  "/_emdash/api/oauth/device/code",
  "/_emdash/api/oauth/device/token",
  "/_emdash/api/oauth/register",
  "/_emdash/api/oauth/token",
  "/_emdash/api/oauth/token/refresh",
  "/_emdash/api/oauth/token/revoke",
  "/_emdash/api/admin/oauth-clients",
  "/_emdash/api/admin/oauth-clients/[id]",
  "/_emdash/api/admin/plugins/[id]/mcp",
  // Signed URLs that outlive the role, honoured without a session (ADR-0002,
  // item 1; whether editors get preview links is issue #120).
  "/_emdash/api/content/[collection]/[id]/preview-url",
  "/_emdash/api/admin/users/[id]/send-recovery",
  // With R2 it mints a signed upload URL valid for an hour, past a role loss.
  // Refused with 501, the answer on which EmDash's admin uploads through the
  // site instead, behind the live role (owner, 2026-11-15).
  "/_emdash/api/media/upload-url",
  // EmDash's own setup sign-in and dev shortcuts.
  "/_emdash/api/setup/admin",
  "/_emdash/api/setup/admin/verify",
  "/_emdash/api/setup/dev-bypass",
  "/_emdash/api/auth/dev-bypass",
  "/_emdash/api/setup/dev-reset",
  "/_emdash/api/dev/emails",
  "/_emdash/api/dev/scheduled-tasks",
  "/_emdash/api/typegen",
  "/_emdash/api/openapi.json",
  "/_emdash/api/health",
  // Whole-site exports: Litestream is the backup (ADR-0001).
  "/_emdash/api/snapshot",
  "/_emdash/api/settings/backups",
  "/_emdash/api/settings/backups/archives",
  "/_emdash/api/settings/backups/archives/[name]",
  "/_emdash/api/settings/backups/export",
  "/_emdash/api/admin/transfer/[...path]",
  // Code from outside: plugins, themes, updates, importers.
  "/_emdash/api/plugins/[pluginId]/[...path]",
  "/_emdash/api/content/[collection]/[id]/plugin-extensions/[pluginId]/[kind]/[extensionId]",
  "/_emdash/api/admin/plugins",
  "/_emdash/api/admin/plugins/[id]",
  "/_emdash/api/admin/plugins/[id]/disable",
  "/_emdash/api/admin/plugins/[id]/enable",
  "/_emdash/api/admin/plugins/[id]/settings",
  "/_emdash/api/admin/plugins/[id]/uninstall",
  "/_emdash/api/admin/plugins/[id]/update",
  "/_emdash/api/admin/plugins/marketplace",
  "/_emdash/api/admin/plugins/marketplace/[id]",
  "/_emdash/api/admin/plugins/marketplace/[id]/icon",
  "/_emdash/api/admin/plugins/marketplace/[id]/install",
  "/_emdash/api/admin/plugins/registry/[id]/uninstall",
  "/_emdash/api/admin/plugins/registry/[id]/update",
  "/_emdash/api/admin/plugins/registry/artifact",
  "/_emdash/api/admin/plugins/registry/install",
  "/_emdash/api/admin/plugins/registry/publisher-handle",
  "/_emdash/api/admin/plugins/registry/verify",
  "/_emdash/api/admin/plugins/updates",
  "/_emdash/api/admin/hooks/exclusive",
  "/_emdash/api/admin/hooks/exclusive/[hookName]",
  "/_emdash/api/admin/themes/marketplace",
  "/_emdash/api/admin/themes/marketplace/[id]",
  "/_emdash/api/admin/themes/marketplace/[id]/thumbnail",
  "/_emdash/api/themes/preview",
  "/_emdash/api/admin/core-update",
  "/_emdash/api/media/providers",
  "/_emdash/api/media/providers/[providerId]",
  "/_emdash/api/media/providers/[providerId]/[itemId]",
  "/_emdash/api/import/probe",
  "/_emdash/api/import/wordpress-plugin/analyze",
  "/_emdash/api/import/wordpress-plugin/callback",
  "/_emdash/api/import/wordpress-plugin/execute",
  "/_emdash/api/import/wordpress/analyze",
  "/_emdash/api/import/wordpress/execute",
  "/_emdash/api/import/wordpress/media",
  "/_emdash/api/import/wordpress/prepare",
  "/_emdash/api/import/wordpress/rewrite-urls",
  // Not used: public comments, custom domains, email.
  "/_emdash/api/comments/[collection]/[contentId]",
  "/_emdash/api/comments/[collection]/[contentId]/reactions",
  "/_emdash/api/site/domain-proof",
  "/_emdash/api/settings/domain",
  "/_emdash/api/settings/domain/notify",
  "/_emdash/api/settings/email",
];

/** Any Member: uploaded files, as the site's other pages are Member-gated. */
export const MEMBER = ["/_emdash/api/media/file/[...key]"];

/** Admins on the live role: EmDash's setup is unauthenticated until done. */
export const ADMINS = ["/_emdash/api/setup", "/_emdash/api/setup/status"];

/** Admins on the live role, through the site session only: their own EmDash
 * API tokens. No token reaches them, so no token mints another (owner, 2026-11-18). */
export const TOKENS = ["/_emdash/api/admin/api-tokens", "/_emdash/api/admin/api-tokens/[id]"];

/** EmDash's MCP endpoint, which EmDash serves to bearer tokens only: here, to
 * an API token whose holder's live role still allows it (owner, 2026-11-18). */
export const MCP = ["/_emdash/api/mcp"];

/** Admins and Authors on the live role; EmDash's own permissions decide the rest. */
export const EDITORS = [
  "/_emdash/admin/[...path]",
  "/_emdash/api/admin/byline-fields",
  "/_emdash/api/admin/byline-fields/[slug]",
  "/_emdash/api/admin/byline-fields/[slug]/usage",
  "/_emdash/api/admin/byline-fields/reorder",
  "/_emdash/api/admin/bylines",
  "/_emdash/api/admin/bylines/[id]",
  "/_emdash/api/admin/bylines/[id]/translations",
  "/_emdash/api/admin/comments",
  "/_emdash/api/admin/comments/[id]",
  "/_emdash/api/admin/comments/[id]/status",
  "/_emdash/api/admin/comments/bulk",
  "/_emdash/api/admin/comments/counts",
  "/_emdash/api/admin/media-usage/activation",
  "/_emdash/api/admin/media-usage/collection-deletions",
  "/_emdash/api/admin/media-usage/collection-deletions/retry",
  "/_emdash/api/admin/media-usage/progress",
  "/_emdash/api/admin/media-usage/repair",
  "/_emdash/api/admin/media-usage/work",
  "/_emdash/api/admin/media-usage/work/retry",
  "/_emdash/api/admin/scheduled-policy-rejections/[collection]/[id]",
  "/_emdash/api/admin/users",
  "/_emdash/api/admin/users/[id]",
  "/_emdash/api/admin/users/[id]/disable",
  "/_emdash/api/admin/users/[id]/enable",
  "/_emdash/api/auth/logout",
  "/_emdash/api/auth/me",
  "/_emdash/api/auth/mode",
  "/_emdash/api/calendar",
  "/_emdash/api/content/[collection]",
  "/_emdash/api/content/[collection]/[id]",
  "/_emdash/api/content/[collection]/[id]/compare",
  "/_emdash/api/content/[collection]/[id]/discard-draft",
  "/_emdash/api/content/[collection]/[id]/duplicate",
  "/_emdash/api/content/[collection]/[id]/lock",
  "/_emdash/api/content/[collection]/[id]/permanent",
  "/_emdash/api/content/[collection]/[id]/publish",
  "/_emdash/api/content/[collection]/[id]/references/[relation]/children",
  "/_emdash/api/content/[collection]/[id]/references/[relation]/parents",
  "/_emdash/api/content/[collection]/[id]/restore",
  "/_emdash/api/content/[collection]/[id]/revisions",
  "/_emdash/api/content/[collection]/[id]/revisions/editors",
  // Joins co-editing: mints a token for the room's WebSocket, which watchRoomSockets()
  // below keeps on the live role.
  "/_emdash/api/content/[collection]/[id]/room",
  "/_emdash/api/content/[collection]/[id]/schedule",
  "/_emdash/api/content/[collection]/[id]/terms/[taxonomy]",
  "/_emdash/api/content/[collection]/[id]/translations",
  "/_emdash/api/content/[collection]/[id]/unpublish",
  "/_emdash/api/content/[collection]/authors",
  "/_emdash/api/content/[collection]/trash",
  "/_emdash/api/dashboard",
  "/_emdash/api/manifest",
  "/_emdash/api/media",
  "/_emdash/api/media/[id]",
  "/_emdash/api/media/[id]/confirm",
  "/_emdash/api/media/[id]/replace",
  "/_emdash/api/media/[id]/upload",
  "/_emdash/api/media/[id]/usage",
  "/_emdash/api/media/asset/[id]/[filename]",
  "/_emdash/api/media/folders",
  "/_emdash/api/media/folders/[id]",
  "/_emdash/api/menus",
  "/_emdash/api/menus/[name]",
  "/_emdash/api/menus/[name]/items",
  "/_emdash/api/menus/[name]/items/[id]",
  "/_emdash/api/menus/[name]/reorder",
  "/_emdash/api/menus/[name]/translations",
  "/_emdash/api/redirects",
  "/_emdash/api/redirects/404s",
  "/_emdash/api/redirects/404s/summary",
  "/_emdash/api/redirects/[id]",
  "/_emdash/api/relations",
  "/_emdash/api/relations/[id]",
  "/_emdash/api/revisions/[revisionId]",
  "/_emdash/api/revisions/[revisionId]/restore",
  "/_emdash/api/schema",
  "/_emdash/api/schema/block-types",
  "/_emdash/api/schema/block-types/[slug]",
  "/_emdash/api/schema/block-types/[slug]/versions/[version]/activate",
  "/_emdash/api/schema/collections",
  "/_emdash/api/schema/collections/[slug]",
  "/_emdash/api/schema/collections/[slug]/fields",
  "/_emdash/api/schema/collections/[slug]/fields/[fieldSlug]",
  "/_emdash/api/schema/collections/[slug]/fields/reorder",
  "/_emdash/api/schema/collections/reorder",
  "/_emdash/api/schema/orphans",
  "/_emdash/api/schema/orphans/[slug]",
  "/_emdash/api/search",
  "/_emdash/api/search/enable",
  "/_emdash/api/search/rebuild",
  "/_emdash/api/search/stats",
  "/_emdash/api/search/suggest",
  "/_emdash/api/sections",
  "/_emdash/api/sections/[slug]",
  "/_emdash/api/settings",
  "/_emdash/api/taxonomies",
  "/_emdash/api/taxonomies/[name]",
  "/_emdash/api/taxonomies/[name]/reorder",
  "/_emdash/api/taxonomies/[name]/terms",
  "/_emdash/api/taxonomies/[name]/terms/[slug]",
  "/_emdash/api/taxonomies/[name]/terms/[slug]/translations",
  "/_emdash/api/taxonomies/[name]/translations",
  "/_emdash/api/taxonomies/bulk-tag",
  // Editing on the site's pages (owner, 2026-11-24). The action token EmDash
  // mints lasts five minutes, but these routes are behind the live role like
  // the rest, so it acts for no one who has lost it.
  "/_emdash/api/visual-editing/action-token",
  "/_emdash/api/visual-editing/content/[collection]/[id]/publish",
  "/_emdash/api/visual-editing/toolbar-labels",
  "/_emdash/api/widget-areas",
  "/_emdash/api/widget-areas/[name]",
  "/_emdash/api/widget-areas/[name]/reorder",
  "/_emdash/api/widget-areas/[name]/widgets",
  "/_emdash/api/widget-areas/[name]/widgets/[id]",
  "/_emdash/api/widget-components",
];

/** EmDash routes outside the gate's prefixes: the site's own middleware gates them. */
export const SITE = ["/robots.txt", "/sitemap.xml", "/sitemap-[collection].xml"];

// `[...rest]` matches zero or more segments, `[name]` one or part of one, as in Astro.
const toRegExp = (pattern: string) => {
  const segments = pattern
    .split("/")
    .map((seg) => (seg.startsWith("[...") ? "\0" : seg.replace(/[.]/g, "\\.").replace(/\[[^\]]+\]/g, "[^/]+")));
  return new RegExp(`^${segments.join("/").replace("/\0", "(?:/.+)?")}$`);
};
const matcher = (patterns: string[]) => {
  const res = patterns.map(toRegExp);
  return (path: string) => res.some((re) => re.test(path));
};
const isRefused = matcher(REFUSED);
const isMember = matcher(MEMBER);
const isAdmin = matcher(ADMINS);
const isTokens = matcher(TOKENS);
const isMcp = matcher(MCP);
const isEditor = matcher(EDITORS);

const normalise = (rawPath: string) => {
  try {
    return decodeURIComponent(rawPath).toLowerCase().replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
  } catch {
    return null;
  }
};

/**
 * Who may reach a path: "site" for a path the gate leaves to the site, or the
 * least role a route needs, or null when it is refused. The path is decoded,
 * lowercased, and stripped of repeated and trailing slashes first, so a variant
 * spelling of a refused route cannot slip past its pattern; a spelling that is
 * not a route at all is refused.
 */
export function place(rawPath: string): "site" | "member" | "editor" | "admin" | "tokens" | "mcp" | null {
  const path = normalise(rawPath);
  if (path === null) return null;
  if (!(path === "/_emdash" || path.startsWith("/_emdash/") || path.startsWith("/.well-known/"))) return "site";
  if (isRefused(path)) return null;
  if (isMember(path)) return "member";
  if (isAdmin(path)) return "admin";
  if (isTokens(path)) return "tokens";
  if (isMcp(path)) return "mcp";
  if (isEditor(path)) return "editor";
  return null;
}

// Editors' routes EmDash serves without reading a token's scopes (PUBLIC_API_EXACT,
// astro/middleware/auth.ts), so no token reaches them; nor uploaded files, for
// the same reason.
const isPublicToEmDash = matcher(["/_emdash/api/search", "/_emdash/api/search/suggest", "/_emdash/api/auth/mode"]);

const isUploadUrl = (path: string) => path.toLowerCase().replace(/\/+$/, "") === "/_emdash/api/media/upload-url";

// The live EmDash role of a token holder's Discord account, kept for the role
// TTL and dropped at its end, refusals and failed lookups too, and shared by
// requests while a lookup is in flight: a client's burst spends the bot token
// once per TTL. Only the role level is kept, never the account's role IDs. A
// Discord outage refuses the account's tokens for a TTL.
const holders = new Map<string, Promise<number | null>>();
function liveLevel(discordId: string) {
  let level = holders.get(discordId);
  if (!level) {
    const entry = (level = liveRoles(discordId).then((roles) => roles && editorRole(roles)).catch(() => null));
    holders.set(discordId, entry);
    setTimeout(() => holders.get(discordId) === entry && holders.delete(discordId), rolesTtl()).unref();
  }
  return level;
}

/**
 * The live EmDash role of an API token's holder, or null when they may not use
 * it now; undefined for a bearer EmDash would not take as an API token (an
 * OAuth token, say) or one it does not know.
 *
 * EmDash resolves a token to its `users` row and acts on the role stored there
 * (astro/middleware/auth.ts, handleBearerAuth), which only a session request
 * brings up to date. So the token is looked up as EmDash looks it up, by the
 * SHA-256 of the whole token (auth/api-tokens.ts), read-only, and its holder's
 * Discord account, the snowflake in their address, must still be a Member with
 * a live editor role at least the stored one. Expiry and revocation are
 * EmDash's to refuse.
 *
 * A token with the `admin` scope, a transfer scope or an `mcp:tools` scope is
 * refused. Through MCP the first two start whole-site exports and imports,
 * which the gate refuses on EmDash's own routes (Litestream is the backup), and
 * the last runs plugins' tools, plugin code the gate refuses everywhere else.
 */
async function tokenRole(token: string) {
  if (!token.startsWith("ec_pat_")) return undefined;
  let holder: { email: string; role: number; scopes: string[] } | undefined;
  try {
    const db = new DatabaseSync(dbPath(), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT u.email, u.role, t.scopes FROM _emdash_api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?")
        .get(createHash("sha256").update(token).digest("base64url")) as { email: string; role: number; scopes: string } | undefined;
      holder = row && { ...row, scopes: JSON.parse(row.scopes) as string[] };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
  if (!holder) return undefined;
  if (holder.scopes.some((scope) => scope === "admin" || scope.startsWith("transfer:") || scope.startsWith("mcp:tools"))) return null;
  const discordId = /^(\d+)@discord\.local$/.exec(holder.email)?.[1];
  const role = discordId ? await liveLevel(discordId) : null;
  return role !== null && role >= holder.role ? role : null;
}

/** The bearer token a request carries, read as EmDash reads it; EmDash takes
 * one over the session whenever it is sent (handleBearerAuth), so the gate
 * holds such a request to the token alone. */
export function bearerToken(headers: Headers) {
  const header = headers.get("Authorization");
  return header?.startsWith("Bearer ") && header.length > 7 ? header.slice(7) : null;
}

export const onRequest: MiddlewareHandler = async (context, next) => {
  const need = place(context.url.pathname);
  if (need === "site") return next();
  const refuse = () =>
    context.url.pathname.toLowerCase().startsWith("/_emdash/admin")
      ? context.redirect("/")
      : new Response(null, { status: isUploadUrl(context.url.pathname) ? 501 : 404 });
  if (need === null) return refuse();
  // On Railway the site must start through apps/site/start.sh, which replicates
  // EmDash's database. A start command replaces it without an error, so EmDash
  // is shut instead of taking edits no backup holds (docs/runbook.md).
  if (process.env["RAILWAY_ENVIRONMENT_ID"] && process.env["SITE_STARTED_BY_ENTRYPOINT"] !== "1") {
    console.error("[gate] Started on Railway without apps/site/start.sh: EmDash's database is not replicated. Refusing EmDash's routes.");
    return new Response(null, { status: 503 });
  }

  const token = bearerToken(context.request.headers);
  if (token !== null) {
    // MCP and the editors' routes on which EmDash enforces the token's scopes,
    // only. EmDash tells its API routes by exact, case-sensitive prefixes, so a
    // spelling Astro still routes (`/_EMDASH/api/...`) would reach an EmDash
    // route without its reading the token. A token's path, as sent, must
    // already be in its one spelling.
    const path = new URL(context.request.url).pathname;
    if (!(need === "mcp" || need === "editor") || normalise(path) !== path || isPublicToEmDash(path)) return refuse();
    const role = await tokenRole(token);
    if (role === undefined) return new Response(null, { status: 401 });
    return role !== null ? next() : new Response(null, { status: 403 });
  }
  if (need === "mcp") return refuse();

  const { roles, setCookie } = await memberRoles(context.request.headers);
  const role = roles && editorRole(roles);
  const allowed =
    roles !== null &&
    (need === "member" || (need === "editor" && role !== null) || ((need === "admin" || need === "tokens") && role === ADMIN));
  const res = allowed ? await next() : refuse();
  // Better Auth's renewal of the session cookie, as the site's middleware does.
  for (const cookie of setCookie) res.headers.append("Set-Cookie", cookie);
  return res;
};

/**
 * Co-editing sockets. EmDash completes a room's WebSocket on the HTTP server's
 * `upgrade` event (rooms/node/upgrades.ts), outside every middleware, and the
 * room keeps a socket until it closes. The token it opens with is minted only
 * through the gate above, on the live role; this keeps the socket on it. The
 * session each upgrade under /_emdash/ carries is re-checked as a request's
 * would be, and the socket is destroyed once it has no editor role: a demotion,
 * a sign-out or a lost Membership drops it within the role TTL and one check.
 *
 * The server is found as EmDash finds it, through a response it sends. Its
 * `emit` is wrapped rather than an `upgrade` listener added, because EmDash
 * decides which upgrades reach a listener by counting them.
 */
function watchRoomSockets() {
  const servers = new WeakSet<Server>();
  dc.subscribe("http.server.response.finish", (message) => {
    const { server } = message as { server?: Server };
    if (!server || servers.has(server)) return;
    servers.add(server);
    const emit = server.emit;
    server.emit = function (this: Server, event: string | symbol, ...args: unknown[]) {
      if (event === "upgrade") watch(args[0] as IncomingMessage, args[1] as Duplex);
      return emit.call(this, event, ...args);
    };
  });

  function watch(request: IncomingMessage, socket: Duplex) {
    if (!request.url?.includes("/_emdash/")) return;
    const headers = new Headers({ cookie: request.headers.cookie ?? "" });
    // Fails closed: an error reading the session drops the socket.
    const check = async () => {
      const { roles } = await memberRoles(headers).catch(() => ({ roles: null }));
      if (!roles || editorRole(roles) === null) socket.destroy();
    };
    void check();
    const timer = setInterval(check, Math.min(rolesTtl(), 30_000));
    timer.unref();
    socket.once("close", () => clearInterval(timer));
  }
}
watchRoomSockets();
