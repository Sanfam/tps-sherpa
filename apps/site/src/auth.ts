/**
 * Reader auth: Better Auth's Discord provider, scope `identify` only, with
 * guild membership and roles resolved server-side with the bot token
 * (ASTRO-ARCHITECTURE.md, Reader auth).
 *
 * The session database holds Better Auth's own tables and is disposable. A
 * session carries the Member's role IDs, never names, and when they were
 * fetched; the cookie carries only Better Auth's opaque token.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import type { DiscordProfile } from "better-auth/social-providers";
// Spike stand-in for the role manifest the Catalog snapshot will carry
// (ADR-0001); same shape as the bot's `content/config/roles.json`.
import manifest from "../fixtures/roles.json";

const DISCORD_API = "https://discord.com/api/v10";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

/**
 * A guild member's role IDs, or null when they are not in the guild (404).
 * Any other failure throws: it says nothing about membership.
 */
async function guildRoles(discordId: string): Promise<string[] | null> {
  const res = await fetch(`${DISCORD_API}/guilds/${env("DISCORD_GUILD_ID")}/members/${discordId}`, {
    headers: { Authorization: `Bot ${env("DISCORD_BOT_TOKEN")}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Guild member lookup failed: ${res.status}`);
  return ((await res.json()) as { roles: string[] }).roles;
}

// A guild member without the `Member` role has joined but is not yet a Member.
const isMember = (roles: string[] | null): roles is string[] =>
  roles?.includes(env("DISCORD_MEMBER_ROLE_ID")) ?? false;

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const groupOf = new Map(manifest.flatMap((r) => r.ids.map((id) => [id, slug(r.name)] as const)));

/** Group slugs for a set of role IDs. A role absent from the manifest matches nothing. */
export const groupsFor = (roleIds: string[]) =>
  [...new Set(roleIds.flatMap((id) => groupOf.get(id) ?? []))];

// The user's tokens are used once, in getUserInfo, and never stored.
const withoutTokens = async <T extends object>(account: T) => ({
  data: { ...account, accessToken: null, refreshToken: null, idToken: null },
});

// A session records nothing about the browser. Better Auth has an option for
// the IP address but none for the user agent.
const withoutClient = async <T extends object>(session: T) => ({
  data: { ...session, ipAddress: null, userAgent: null },
});

function createAuth(database: DatabaseSync) {
  return betterAuth({
    baseURL: env("BETTER_AUTH_URL"),
    basePath: "/auth",
    secret: env("BETTER_AUTH_SECRET"),
    database,
    socialProviders: {
      discord: {
        clientId: env("DISCORD_CLIENT_ID"),
        clientSecret: env("DISCORD_CLIENT_SECRET"),
        disableDefaultScope: true,
        scope: ["identify"],
        // Awaited in the OAuth callback before any user row exists, so
        // returning null rejects the sign-in with nothing persisted.
        async getUserInfo(tokens) {
          const me = await fetch(`${DISCORD_API}/users/@me`, {
            headers: { Authorization: `Bearer ${tokens.accessToken}` },
          });
          if (!me.ok) return null;
          const profile = (await me.json()) as DiscordProfile;
          const roles = await guildRoles(profile.id).catch(() => null);
          if (!isMember(roles)) return null;
          return {
            // The override bypasses the provider's `mapProfileToUser`, so the
            // email that `identify` lacks is synthesised here; without one
            // the callback fails with EMAIL_NOT_FOUND. The site keeps only
            // the snowflake: no username, no avatar.
            user: {
              name: profile.id,
              email: `${profile.id}@discord.local`,
              emailVerified: false,
            },
            data: profile,
          };
        },
      },
    },
    session: {
      additionalFields: {
        // JSON array of role IDs. Empty and 0 until the first gated request
        // fetches them.
        // Never in an API response: role data is member data.
        roleIds: { type: "string", input: false, returned: false, defaultValue: "[]" },
        rolesFetchedAt: { type: "number", input: false, returned: false, defaultValue: 0 },
      },
      // Session data stays in the database; the cookie holds only the token.
      cookieCache: { enabled: false },
    },
    // ponytail: with no IP, Better Auth's rate limiter has nothing to key on and
    // does not run. A flood of callbacks spends the bot token's Discord rate
    // limit, and a flood of unauthenticated /auth/discord/start requests
    // inserts a verification row each (swept daily, so bounded by a day's
    // flood). Add a limiter keyed on something other than IP before the site
    // is opened to members.
    advanced: { ipAddress: { disableIpTracking: true } },
    // A repeat sign-in would otherwise write the fresh tokens back; the update
    // hook below is the backstop.
    account: { updateAccountOnSignIn: false },
    databaseHooks: {
      account: {
        create: { before: withoutTokens },
        update: { before: withoutTokens },
      },
      session: {
        create: { before: withoutClient },
        update: { before: withoutClient },
      },
    },
  });
}

/**
 * Deletes expired sessions and sign-in states (owner's decision, 2026-11-12).
 * Users and accounts are kept. Better Auth stores dates as ISO strings, which
 * compare in time order.
 */
export function sweep(db: DatabaseSync) {
  const now = new Date().toISOString();
  db.prepare("delete from session where expiresAt < ?").run(now);
  db.prepare("delete from verification where expiresAt < ?").run(now);
}

let instance:
  | { auth: ReturnType<typeof createAuth>; db: DatabaseSync; ready: Promise<void> }
  | undefined;

/** The auth instance, created on first use so a build opens no database. */
export function auth() {
  if (!instance) {
    const path = process.env["SITE_SESSION_DB"] ?? ".data/sessions.db";
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    const auth = createAuth(db);
    const ready = getMigrations(auth.options)
      .then((m) => m.runMigrations())
      .then(() => {
        sweep(db);
        setInterval(() => sweep(db), 24 * 60 * 60_000).unref();
      });
    instance = { auth, db, ready };
  }
  return instance;
}

/**
 * The signed-in Member's role IDs, or null for anyone else. Roles older than
 * the TTL are fetched again with the bot token, so a promotion or demotion
 * takes effect without a new sign-in; someone who is no longer a Member loses
 * their session.
 */
export async function memberRoles(
  headers: Headers,
): Promise<{ roles: string[] | null; setCookie: string[] }> {
  const { auth: a, ready } = auth();
  await ready;
  // `setCookie` carries Better Auth's sliding renewal of the session cookie.
  const { headers: out, response: found } = await a.api.getSession({ headers, returnHeaders: true });
  const setCookie = out.getSetCookie();
  return { roles: found ? await rolesFor(found.session) : null, setCookie };
}

async function rolesFor(session: { token: string; userId: string }): Promise<string[] | null> {
  const { auth: a, db } = auth();
  // Every Better Auth read, its internal adapter included, filters out the
  // `returned: false` fields, so they are read from the row directly.
  const row = db.prepare("select roleIds, rolesFetchedAt from session where token = ?").get(session.token) as
    | { roleIds: string; rolesFetchedAt: number }
    | undefined;
  if (!row) return null;
  const ttl = Number(process.env["ROLES_TTL_MS"] ?? 5 * 60_000);
  if (Date.now() - row.rolesFetchedAt <= ttl) return JSON.parse(row.roleIds) as string[];

  const ctx = await a.$context;
  const [account] = await ctx.internalAdapter.findAccounts(session.userId);
  // ponytail: a Discord outage denies this request but keeps the session; no retry or grace period.
  const roles = account ? await guildRoles(account.accountId).catch(() => undefined) : null;
  if (roles === undefined) return null;
  if (!isMember(roles)) {
    await ctx.internalAdapter.deleteSession(session.token);
    return null;
  }
  await ctx.internalAdapter.updateSession(session.token, {
    roleIds: JSON.stringify(roles),
    rolesFetchedAt: Date.now(),
  });
  return roles;
}
