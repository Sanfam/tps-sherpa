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
import { env, memberRoles } from "./auth.ts";

// EmDash's role levels.
export const ADMIN = 50;
const AUTHOR = 30;

// In the CMS only `Staff` is Admin; `Event Managers` stands in for Club Lead,
// which is not yet its own guild role (owner, 2026-11-14). The role IDs come
// from the environment, as the Member role's does: the fixture manifest holds
// test IDs only, and the real manifest is not on the site yet (ADR-0001).
/** The EmDash role a Member's guild roles give, or null for no editor role. */
export function editorRole(roles: string[]) {
  if (roles.includes(env("DISCORD_STAFF_ROLE_ID"))) return ADMIN;
  if (roles.includes(env("DISCORD_EVENT_MANAGERS_ROLE_ID"))) return AUTHOR;
  return null;
}

export async function authenticate(request: Request) {
  const { roles, user } = await memberRoles(request.headers);
  if (!roles || !user) throw new Error("no Member session");
  const role = editorRole(roles);
  // A refused Member never reaches EmDash's user lookup, so leaves no row.
  if (role === null) throw new Error("no editor role");
  // EmDash matches users by email, the snowflake-derived address, and keeps
  // the name in step with the Discord username.
  return { email: user.email, name: user.name, role };
}
