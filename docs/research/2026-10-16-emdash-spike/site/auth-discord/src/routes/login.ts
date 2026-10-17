/**
 * GET /_emdash/api/auth/discord/login
 *
 * Stores a single-use state and redirects to Discord's authorize page with
 * scope `identify` only.
 */

import type { APIRoute } from "astro";
import { getAuthProviderStorage, getPublicOrigin } from "emdash/api/route-utils";

export const prerender = false;

const STATE_TTL_MS = 10 * 60 * 1000;

export const GET: APIRoute = async ({ request, locals, redirect }) => {
	const { emdash } = locals;
	if (!emdash?.db) return new Response("EmDash not initialised", { status: 500 });

	const states = getAuthProviderStorage(emdash.db, "discord", { states: { indexes: [] } }).states;
	const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
	await states.put(state, { expiresAt: Date.now() + STATE_TTL_MS });

	const origin = getPublicOrigin(new URL(request.url), emdash.config);
	const authorize = new URL(`${process.env.DISCORD_API_BASE}/oauth2/authorize`);
	authorize.search = new URLSearchParams({
		client_id: process.env.DISCORD_CLIENT_ID ?? "",
		redirect_uri: `${origin}/_emdash/api/auth/discord/callback`,
		response_type: "code",
		scope: "identify",
		state,
		prompt: "none",
	}).toString();
	return redirect(authorize.toString());
};
