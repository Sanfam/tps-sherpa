/**
 * Discord sign-in for EmDash editors (spike).
 *
 * Shaped like @emdash-cms/auth-atproto: a descriptor naming two injected
 * routes. Scope `identify` only. Guild membership and roles come from the
 * bot-token call GET /guilds/{guild}/members/{user}, never from the member's
 * own token, so no `guilds.members.read` and no `email`.
 *
 * Secrets (client secret, bot token) are read from env at request time, not
 * put in this config, because the config is serialised into a virtual module.
 */

import type { AuthProviderDescriptor } from "emdash";

export interface DiscordAuthConfig {
	guildId: string;
	/** Discord role id -> EmDash role level. A member gets the highest match. */
	roleMap: Record<string, number>;
}

/**
 * The EmDash role a member's Discord roles map to: the highest match, or null
 * when none of their roles is an editor role.
 */
export function resolveRole(memberRoles: string[], roleMap: Record<string, number>): number | null {
	let best: number | null = null;
	for (const id of memberRoles) {
		const level = roleMap[id];
		if (level !== undefined && (best === null || level > best)) best = level;
	}
	return best;
}

export function discord(config: DiscordAuthConfig): AuthProviderDescriptor {
	return {
		id: "discord",
		label: "Discord",
		config,
		adminEntry: "@spike/auth-discord/admin",
		routes: [
			{
				pattern: "/_emdash/api/auth/discord/login",
				entrypoint: "@spike/auth-discord/routes/login.ts",
			},
			{
				pattern: "/_emdash/api/auth/discord/callback",
				entrypoint: "@spike/auth-discord/routes/callback.ts",
			},
		],
		publicRoutes: ["/_emdash/api/auth/discord/"],
		storage: { states: { indexes: [] } },
	};
}
