// Checks state against this browser's cookie, exchanges the code with the PKCE
// verifier, reads the snowflake, drops the member's token, and checks guild
// membership with the bot token. Only a member with an editor role gets a site
// session; EmDash never hears about anyone else.
import type { APIRoute } from "astro";
import { timingSafeEqual } from "node:crypto";

import { resolveRole } from "@spike/auth-discord";
import { COOKIE, issue, memberRoles } from "@spike/auth-discord/site-session";

import { GUILD_ID, ROLE_MAP } from "../../../roles.ts";

export const prerender = false;

const same = (a: string, b: string) =>
	a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
	const fail = (code: string) => redirect(`/?signin=${code}`);
	const [state, verifier] = cookies.get("oauth_tx")?.value.split(".") ?? [];
	cookies.delete("oauth_tx", { path: "/auth/discord" });
	const code = url.searchParams.get("code");
	if (!state || !verifier || !code || !same(state, url.searchParams.get("state") ?? "")) {
		return fail("invalid_state");
	}
	try {
		const tokenRes = await fetch(`${process.env.DISCORD_API_BASE}/oauth2/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				redirect_uri: `${url.origin}/auth/discord/callback`,
				client_id: process.env.DISCORD_CLIENT_ID ?? "",
				client_secret: process.env.DISCORD_CLIENT_SECRET ?? "",
			}),
		});
		if (!tokenRes.ok) return fail("token_exchange_failed");
		const { access_token: accessToken, scope } = await tokenRes.json();
		if (scope !== "identify") return fail("unexpected_scope");
		const meRes = await fetch(`${process.env.DISCORD_API_BASE}/users/@me`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!meRes.ok) return fail("profile_failed");
		const { id } = await meRes.json();
		const member = await memberRoles(GUILD_ID, id);
		if (!member) return fail("not_in_guild");
		if (resolveRole(member.roles, ROLE_MAP) === null) return fail("no_editor_role");
		cookies.set(COOKIE, issue(id), { httpOnly: true, sameSite: "lax", path: "/" });
		return redirect("/_emdash/admin");
	} catch {
		return fail("discord_unavailable");
	}
};
