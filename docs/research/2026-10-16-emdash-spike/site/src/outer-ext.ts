// The site gate for external-auth mode, in EmDash's `middleware.outer` hook.
// It runs before any EmDash code, so it decides from the request alone:
//  - EmDash's own credential machinery (OAuth server, device flow, API tokens,
//    MCP) is refused outright: every credential must come from the site session.
//  - Setup is allowed only for a Staff member, checked with the bot token.
//  - Everything else under /_emdash needs a valid site session; EmDash's
//    authenticate() then re-checks guild roles on each request.
import { defineMiddleware } from "astro:middleware";

import { resolveRole } from "@spike/auth-discord";
import { memberRoles, verify } from "@spike/auth-discord/site-session";

import { GUILD_ID, ROLE_MAP } from "./roles.ts";

const REFUSED = [
	"/_emdash/api/oauth/",
	"/_emdash/oauth/",
	"/_emdash/api/admin/api-tokens",
	"/_emdash/api/admin/oauth-clients",
	"/_emdash/api/mcp",
	"/_emdash/.well-known/",
	"/.well-known/oauth-",
	"/_emdash/api/setup/admin",
	"/_emdash/api/setup/dev-",
];
const SETUP = ["/_emdash/api/setup", "/_emdash/admin/setup"];
const OPEN = new Set(["/_emdash/api/health"]);

const refuse = (status: number) =>
	new Response(null, { status, headers: { "x-outer-mw": "deny" } });

export const onRequest = defineMiddleware(async (context, next) => {
	const path = context.url.pathname;
	if (REFUSED.some((p) => path.startsWith(p))) return refuse(404);
	if (!path.startsWith("/_emdash") || OPEN.has(path)) return next();

	const id = verify(context.request.headers.get("cookie"));
	if (!id) {
		return path.startsWith("/_emdash/admin")
			? context.redirect("/auth/discord/start")
			: refuse(401);
	}
	if (SETUP.some((p) => path.startsWith(p))) {
		const member = await memberRoles(GUILD_ID, id).catch(() => null);
		if (!member || resolveRole(member.roles, ROLE_MAP) !== 50) return refuse(403);
	}
	return next();
});
