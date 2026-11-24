import type { APIRoute } from "astro";
import { auth, memberRoles, signInStarts } from "../../../auth.ts";

// A plain link starts sign-in. Better Auth's own endpoint is a POST that
// answers with JSON, so this turns its answer into the redirect to Discord,
// keeping the state cookie it sets. The body is fixed: nothing from the
// request can add a scope.
export const GET: APIRoute = async ({ request }) => {
  // A signed-in Member who follows a sign-in link anyway, from a page opened
  // before they signed in, goes straight to /members, keeping Better Auth's
  // session renewal.
  const member = await memberRoles(request.headers);
  if (member.roles) {
    const headers = new Headers({ Location: "/members" });
    for (const cookie of member.setCookie) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 302, headers });
  }
  if (!signInStarts()) return new Response("Too many sign-ins right now. Try again in a minute.", { status: 429 });
  const { auth: a, ready } = auth();
  await ready;
  const res = await a.api.signInSocial({
    body: { provider: "discord", callbackURL: "/members", errorCallbackURL: "/" },
    headers: request.headers,
    asResponse: true,
  });
  const { url } = (await res.json()) as { url: string };
  const headers = new Headers({ Location: url });
  for (const cookie of res.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
};
