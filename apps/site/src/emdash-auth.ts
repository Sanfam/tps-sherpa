/**
 * EmDash's external-auth module (ADR-0002). EmDash calls authenticate() on
 * every private /_emdash request and answers 401 when it throws; with
 * `syncRoles` it writes the returned role to the editor's `users` row each
 * time, so a Discord role change applies without a new sign-in.
 *
 * Identity is the site's own Better Auth session, and roles are the ones
 * memberRoles() keeps on the session row. That row is the cache: within the
 * TTL no request reaches Discord, whether it ends in a role or a refusal, and
 * a Member who is no longer one loses the session itself.
 */
import { groupsFor, memberRoles } from "./auth.ts";

// EmDash's role levels.
const ADMIN = 50;
const AUTHOR = 30;

// Role names from the manifest, as group slugs. Staff are holders of `Staff`
// or `Event Managers` (CONTEXT.md).
const STAFF = ["staff", "event-managers"];
// ponytail: the Club Lead guild role does not exist yet (CONTEXT.md); this
// matches nothing until a role with this name is in the manifest.
const CLUB_LEAD = "club-lead";

export async function authenticate(request: Request) {
  const { roles, discordId } = await memberRoles(request.headers);
  if (!roles || !discordId) throw new Error("no Member session");
  const groups = groupsFor(roles);
  const role = groups.some((g) => STAFF.includes(g)) ? ADMIN : groups.includes(CLUB_LEAD) ? AUTHOR : null;
  // A refused Member never reaches EmDash's user lookup, so leaves no row.
  if (role === null) throw new Error("no editor role");
  // EmDash matches users by email. Both are the snowflake, the only identity
  // the site keeps.
  return { email: `${discordId}@discord.local`, name: discordId, role };
}
