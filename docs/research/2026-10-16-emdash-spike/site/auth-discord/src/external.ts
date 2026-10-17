/**
 * EmDash external-auth module (`auth: { entrypoint }`). EmDash calls
 * authenticate() on every non-public /_emdash request; throwing means 401.
 * With `syncRoles: true` it writes the returned role to the user row each time,
 * so a Discord role change applies on the next request, not the next sign-in.
 */
import { resolveRole } from "./index.ts";
import { memberRoles, verify } from "./site-session.ts";

export interface ExternalConfig {
	guildId: string;
	roleMap: Record<string, number>;
	syncRoles: true;
}

export async function authenticate(request: Request, config: unknown) {
	const { guildId, roleMap } = config as ExternalConfig;
	const id = verify(request.headers.get("cookie"));
	if (!id) throw new Error("no site session");
	// ponytail: one bot-token call per CMS request; cache by roles_fetched_at with a TTL before real traffic.
	const member = await memberRoles(guildId, id);
	if (!member) throw new Error("not in the guild");
	const role = resolveRole(member.roles, roleMap);
	if (role === null) throw new Error("no editor role");
	return {
		// Synthetic: `identify` returns no email, and EmDash keys external users on email.
		email: `${id}@discord.invalid`,
		name: member.user.username,
		role,
		subject: id,
	};
}
