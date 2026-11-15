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

// Role names from the manifest, as group slugs. In the CMS only `Staff` is
// Admin; `Event Managers` stands in for Club Lead, which is not yet its own
// guild role (owner, 2026-11-14).
const ADMINS = "staff";
const AUTHORS = "event-managers";

export async function authenticate(request: Request) {
  const { roles, user } = await memberRoles(request.headers);
  if (!roles || !user) throw new Error("no Member session");
  const groups = groupsFor(roles);
  const role = groups.includes(ADMINS) ? ADMIN : groups.includes(AUTHORS) ? AUTHOR : null;
  // A refused Member never reaches EmDash's user lookup, so leaves no row.
  if (role === null) throw new Error("no editor role");
  // EmDash matches users by email, the snowflake-derived address, and keeps
  // the name in step with the Discord username.
  return { email: user.email, name: user.name, role };
}
