import { defineMiddleware } from "astro:middleware";
import { groupsFor, memberRoles, sessionUser } from "./auth.ts";
import { ADMIN, editorRole } from "./emdash-auth.ts";
import { bearerToken, place } from "./emdash-gate.ts";
import { startRevisionPruner } from "./emdash-erasure.ts";
import { startSnapshotPuller } from "./catalog-snapshot.ts";

// Default-deny: every server-rendered route is Member-gated except these.
const isPublic = (path: string) => path === "/" || path === "/privacy" || path.startsWith("/auth/");
const isAdminAction = (path: string) => path === "/admin/emdash/purge-history" || path === "/admin/emdash/anonymise";

// Starts when Astro first loads this middleware, at the first server-rendered
// request after a start, not at boot: a site nobody visits since its last
// deploy prunes nothing until someone does (and takes no edits meanwhile).
startRevisionPruner();
// Loads the last accepted Catalog snapshot, then pulls the bot's on a timer (ADR-0001).
startSnapshotPuller();

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  // Prerendered pages are public by construction; this runs for them only at
  // build. The auth routes read the session themselves.
  if (context.isPrerendered || path.startsWith("/auth/")) return next();
  // An EmDash API token's request carries no session. The gate, ahead of all
  // of EmDash, has already held it to its holder's live roles.
  if (place(path) !== "site" && bearerToken(context.request.headers) !== null) return next();
  // A public page shows who is signed in from the session alone: it never
  // waits on Discord, renders for a Viewer when auth is unavailable, gets no
  // roles, and never renews the session. Only a gated page, which checks
  // membership, does those.
  const { roles, setCookie, user } = isPublic(path)
    ? { roles: null, setCookie: [], user: (await sessionUser(context.request.headers).catch(() => undefined))?.user }
    : await memberRoles(context.request.headers);
  context.locals.roles = roles ?? [];
  context.locals.groups = groupsFor(context.locals.roles);
  if (user) {
    context.locals.signedIn = {
      displayName: user.displayName,
      avatar: user.image,
      username: user.name,
      expiresAt: user.expiresAt,
    };
  }
  let res: Response;
  if (isPublic(path) || (roles && (!isAdminAction(path) || editorRole(roles) === ADMIN))) {
    res = await next();
  } else {
    res = context.redirect("/");
  }
  // Better Auth's renewal of the session cookie, when it extended the session.
  for (const cookie of setCookie) res.headers.append("Set-Cookie", cookie);
  // A page may name who is signed in, so no shared cache may keep it.
  if (res.headers.get("content-type")?.startsWith("text/html")) {
    res.headers.set("Cache-Control", "private, no-store");
    res.headers.append("Vary", "Cookie");
  }
  return res;
});
