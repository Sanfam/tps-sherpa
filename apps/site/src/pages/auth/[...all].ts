import type { APIRoute } from "astro";
import { auth } from "../../auth.ts";

// Only the Better Auth endpoints the flow needs. The rest stay unreachable:
// sign-in and link-social accept caller-chosen scopes, and the session
// endpoints answer with session data. Sign-in starts at /auth/discord/start.
const ALLOWED = new Set(["/auth/callback/discord", "/auth/sign-out"]);

export const ALL: APIRoute = async ({ request, url }) => {
  if (!ALLOWED.has(url.pathname)) return new Response(null, { status: 404 });
  const { auth: a, ready } = auth();
  await ready;
  return a.handler(request);
};
