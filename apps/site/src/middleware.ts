import { defineMiddleware } from "astro:middleware";
import { groupsFor, memberRoles } from "./auth.ts";
import { ADMIN, editorRole } from "./emdash-auth.ts";
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
  // Prerendered pages are public by construction; this runs for them only at build.
  if (context.isPrerendered || isPublic(context.url.pathname)) return next();
  const { roles, setCookie } = await memberRoles(context.request.headers);
  let res: Response;
  if (roles && (!isAdminAction(context.url.pathname) || editorRole(roles) === ADMIN)) {
    context.locals.groups = groupsFor(roles);
    context.locals.roles = roles;
    res = await next();
  } else {
    res = context.redirect("/");
  }
  // Better Auth's renewal of the session cookie, when it extended the session.
  for (const cookie of setCookie) res.headers.append("Set-Cookie", cookie);
  return res;
});
