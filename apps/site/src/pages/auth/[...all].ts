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
  if (url.pathname !== "/auth/sign-out") return a.handler(request);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  // Sign-out is the session bar's form post. Better Auth takes only JSON
  // bodies, and the form sends no fields, so it gets the request without one;
  // its origin check still refuses a post from any other site. Its JSON answer
  // becomes a redirect home, keeping the cookie's expiry.
  const res = await a.handler(new Request(request.url, { method: "POST", headers: request.headers }));
  if (!res.ok) return res;
  // Better Auth clears the cookie and answers success even when deleting the
  // session failed, which would leave a copied cookie working. The check must
  // not extend the session it failed to end.
  if (await a.api.getSession({ headers: request.headers, query: { disableRefresh: true } }))
    return new Response("Sign-out failed. Try again.", { status: 500 });
  const headers = new Headers({ Location: "/" });
  for (const cookie of res.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
};
