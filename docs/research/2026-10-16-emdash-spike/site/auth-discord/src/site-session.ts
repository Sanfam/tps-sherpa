/**
 * Stand-in for the site's reader-auth session (Better Auth in the real build):
 * a signed cookie naming a Discord snowflake. The real session is an opaque
 * token with server-side state; this is only enough to drive the spike.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE = "site_session";
const MAX_AGE_S = 7 * 24 * 3600;

const sign = (payload: string) =>
	createHmac("sha256", process.env.SITE_SESSION_SECRET ?? "").update(payload).digest("base64url");

export function issue(discordId: string): string {
	const payload = `${discordId}.${Math.floor(Date.now() / 1000)}`;
	return `${payload}.${sign(payload)}`;
}

/** The snowflake in a valid, unexpired cookie, or null. */
export function verify(cookieHeader: string | null): string | null {
	if (!process.env.SITE_SESSION_SECRET) return null;
	const raw = cookieHeader
		?.split(/;\s*/)
		.find((c) => c.startsWith(`${COOKIE}=`))
		?.slice(COOKIE.length + 1);
	const [id, issued, mac] = raw?.split(".") ?? [];
	if (!id || !issued || !mac) return null;
	const want = Buffer.from(sign(`${id}.${issued}`));
	const got = Buffer.from(mac);
	if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
	if (Date.now() / 1000 - Number(issued) > MAX_AGE_S) return null;
	return id;
}

/** Bot-token membership lookup: the member's roles, or null when not in the guild. */
export async function memberRoles(guildId: string, discordId: string) {
	const res = await fetch(
		`${process.env.DISCORD_API_BASE}/guilds/${guildId}/members/${discordId}`,
		{ headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } },
	);
	// Only Discord's "Unknown Member" means not in the guild. Any other failure
	// (wrong guild id, bot removed, outage) is an error, not a rejection.
	if (res.status === 404) {
		const body = (await res.json().catch(() => ({}))) as { code?: number };
		if (body.code === 10007) return null;
	}
	if (!res.ok) throw new Error(`guild member lookup failed: ${res.status}`);
	return (await res.json()) as { roles: string[]; user: { username: string } };
}
