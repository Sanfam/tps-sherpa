import { defineMiddleware } from "astro:middleware";
import { groupsFor, memberRoles } from "./auth.ts";

// Default-deny: every server-rendered route is Member-gated except these.
const isPublic = (path: string) => path === "/" || path.startsWith("/auth/");

export const onRequest = defineMiddleware(async (context, next) => {
  // Prerendered pages are public by construction; this runs for them only at build.
  if (context.isPrerendered || isPublic(context.url.pathname)) return next();
  const { roles, setCookie } = await memberRoles(context.request.headers);
  let res: Response;
  if (roles) {
    context.locals.groups = groupsFor(roles);
    res = await next();
  } else {
    res = context.redirect("/");
  }
  // Better Auth's renewal of the session cookie, when it extended the session.
  for (const cookie of setCookie) res.headers.append("Set-Cookie", cookie);
  return res;
});
