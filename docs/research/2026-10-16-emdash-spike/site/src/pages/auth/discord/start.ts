// The site's own Discord sign-in (stand-in for Better Auth). State and the PKCE
// verifier live in a short-lived httpOnly cookie, so the callback only accepts
// a code that this browser started: no login CSRF, and nothing written to the
// database by an anonymous request.
import type { APIRoute } from "astro";
import { createHash, randomBytes } from "node:crypto";

export const prerender = false;

export const GET: APIRoute = ({ url, cookies, redirect }) => {
	const state = randomBytes(32).toString("base64url");
	const verifier = randomBytes(32).toString("base64url");
	cookies.set("oauth_tx", `${state}.${verifier}`, {
		httpOnly: true,
		sameSite: "lax",
		path: "/auth/discord",
		maxAge: 600,
	});
	const authorize = new URL(`${process.env.DISCORD_API_BASE}/oauth2/authorize`);
	authorize.search = new URLSearchParams({
		client_id: process.env.DISCORD_CLIENT_ID ?? "",
		redirect_uri: `${url.origin}/auth/discord/callback`,
		response_type: "code",
		scope: "identify",
		state,
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
	}).toString();
	return redirect(authorize.toString());
};
