/**
 * GET /_emdash/api/auth/discord/callback
 *
 * Order matters, as in auth-atproto's callback: every check that can reject
 * runs before findOrCreateOAuthUser, so a rejected person never gets a row.
 *
 * 1. Consume the single-use state.
 * 2. Exchange the code, read /users/@me for the snowflake, drop the token.
 * 3. Bot-token GET /guilds/{guild}/members/{id}: 404 means not in the guild.
 * 4. Map Discord roles to an EmDash role. No editor role means rejection; an
 *    existing row is demoted to Subscriber so a stale session keeps nothing.
 * 5. findOrCreateOAuthUser, then re-sync the role with updateUser on every
 *    sign-in, promotion and demotion alike.
 */

import type { APIRoute } from "astro";
import { Role, findOrCreateOAuthUser, type RoleLevel } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import {
	finalizeSetup,
	getAuthProviderStorage,
	getPublicOrigin,
	OptionsRepository,
} from "emdash/api/route-utils";

import { resolveRole, type DiscordAuthConfig } from "../index.ts";

export const prerender = false;

const API = () => process.env.DISCORD_API_BASE ?? "https://discord.com/api/v10";

export const GET: APIRoute = async ({ request, locals, session, redirect }) => {
	const { emdash } = locals;
	const fail = (code: string) => redirect(`/_emdash/admin/login?error=${code}`);
	if (!emdash?.db || !session) return fail("server_error");

	const url = new URL(request.url);
	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	const states = getAuthProviderStorage(emdash.db, "discord", { states: { indexes: [] } }).states;
	const saved = state ? ((await states.get(state)) as { expiresAt: number } | null) : null;
	// delete() is the single-use gate: only the request that removes the row proceeds.
	if (!state || !code || !saved || !(await states.delete(state)) || saved.expiresAt < Date.now()) {
		return fail("invalid_state");
	}

	const provider = (emdash.config as { authProviders?: { id: string; config?: unknown }[] })
		.authProviders?.find((p) => p.id === "discord");
	const config = provider?.config as DiscordAuthConfig;

	const origin = getPublicOrigin(url, emdash.config);
	const tokenRes = await fetch(`${API()}/oauth2/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: `${origin}/_emdash/api/auth/discord/callback`,
			client_id: process.env.DISCORD_CLIENT_ID ?? "",
			client_secret: process.env.DISCORD_CLIENT_SECRET ?? "",
		}),
	});
	if (!tokenRes.ok) return fail("token_exchange_failed");
	const { access_token: accessToken, scope } = (await tokenRes.json()) as {
		access_token: string;
		scope: string;
	};
	if (scope !== "identify") return fail("unexpected_scope");

	const meRes = await fetch(`${API()}/users/@me`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!meRes.ok) return fail("profile_failed");
	const me = (await meRes.json()) as { id: string; username: string; global_name: string | null };
	// The member's token is not used again and is not stored.

	const memberRes = await fetch(`${API()}/guilds/${config.guildId}/members/${me.id}`, {
		headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
	});
	if (memberRes.status !== 404 && !memberRes.ok) return fail("guild_lookup_failed");
	const memberRoles = memberRes.ok ? ((await memberRes.json()) as { roles: string[] }).roles : [];
	const level = resolveRole(memberRoles, config.roleMap) as RoleLevel | null;

	const adapter = createKyselyAdapter(emdash.db as never);
	const options = new OptionsRepository(emdash.db);
	const setupComplete = await options.get("emdash:setup_complete");
	const isFirstUser = setupComplete !== true && setupComplete !== "true";

	if (level === null) {
		const linked = await adapter.getOAuthAccount("discord", me.id);
		if (linked) await adapter.updateUser(linked.userId, { role: Role.SUBSCRIBER });
		return fail(memberRes.status === 404 ? "not_in_guild" : "no_editor_role");
	}
	// Setup completes through Discord: only a Staff member can create the first admin.
	if (isFirstUser && level < Role.ADMIN) return fail("setup_requires_staff");

	let user = await findOrCreateOAuthUser(
		adapter,
		"discord",
		{
			id: me.id,
			// Synthetic, as auth-atproto does: `identify` returns no email.
			email: `${me.id}@discord.invalid`,
			name: me.global_name ?? me.username,
			avatarUrl: null,
			emailVerified: false,
		},
		async () => ({ allowed: true, role: level }),
	);
	if (isFirstUser) await finalizeSetup(emdash.db);

	if (user.role !== level) {
		await adapter.updateUser(user.id, { role: level });
		user = { ...user, role: level };
	}
	if (user.disabled) return fail("account_disabled");

	session.set("user", { id: user.id });
	return redirect("/_emdash/admin");
};
