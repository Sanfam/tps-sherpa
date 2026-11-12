// The Phase 4 mechanical gate, end to end: the built site against a mock
// Discord, on a fresh session database.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { BOT_TOKEN, GUILD_ID, guild, mock, startMock } from "./mock-discord.ts";

const SITE_DIR = join(import.meta.dirname, "..");
const PORT = 4329;
const SITE = `http://127.0.0.1:${PORT}`;
const TTL_MS = 1000;

// Fake snowflakes. Role IDs match fixtures/roles.json.
const MEMBER_ROLE = "300000000000000001";
const STAFF_ROLE = "300000000000000002";
const AMBASSADOR_ROLE = "300000000000000003";
const MEMBER = "900000000000000001";
const JOINED = "900000000000000002"; // in the guild, no Member role yet
const OUTSIDER = "900000000000000003"; // not in the guild
const MOVER = "900000000000000004"; // roles change while signed in

const tmp = mkdtempSync(join(tmpdir(), "site-gate-"));
const DB = join(tmp, "sessions.db");
let mockServer: Server;
let mockOrigin: string;
let site: ChildProcess;

// The site's configuration, shared with the in-process auth instance below.
const ENV = {
  SITE_SESSION_DB: DB,
  ROLES_TTL_MS: String(TTL_MS),
  BETTER_AUTH_URL: SITE,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  DISCORD_CLIENT_ID: "mock-client",
  DISCORD_CLIENT_SECRET: "mock-secret",
  DISCORD_BOT_TOKEN: BOT_TOKEN,
  DISCORD_GUILD_ID: GUILD_ID,
  DISCORD_MEMBER_ROLE_ID: MEMBER_ROLE,
};

const db = () => new DatabaseSync(DB, { readOnly: true });
const rows = (sql: string, ...params: string[]) => db().prepare(sql).all(...params);
const usersFor = (id: string) =>
  rows('select u.id from "user" u join account a on a.userId = u.id where a.accountId = ?', id);

beforeAll(async () => {
  execFileSync("npx", ["astro", "build"], { cwd: SITE_DIR, stdio: "ignore", env: { ...process.env, ...ENV } });
  const started = await startMock();
  mockServer = started.server;
  mockOrigin = started.origin;
  site = spawn(process.execPath, ["--import", "./test/redirect-discord.mjs", "./dist/server/entry.mjs"], {
    cwd: SITE_DIR,
    stdio: "ignore",
    env: { ...process.env, ...ENV, HOST: "127.0.0.1", PORT: String(PORT), MOCK_DISCORD: started.origin },
  });
  for (let i = 0; ; i++) {
    if (await fetch(SITE).then(() => true, () => false)) break;
    if (i > 100) throw new Error("site did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}, 120_000);

afterAll(() => {
  site?.kill();
  mockServer?.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Every Set-Cookie the site sent in this file's flows, for the cookie test. */
const setCookies: string[] = [];

/** A browser: a cookie jar that records what it is sent. */
function browser() {
  const jar = new Map<string, string>();
  return {
    keep(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        setCookies.push(c);
        const [pair = ""] = c.split(";");
        const i = pair.indexOf("=");
        jar.set(pair.slice(0, i), pair.slice(i + 1));
      }
    },
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
  };
}

/** Sign-in up to Discord's redirect back: the callback URL, and the browser holding its state cookie. */
async function startSignIn(id: string) {
  mock.signInAs = id;
  const b = browser();
  let res = await fetch(`${SITE}/auth/discord/start`, { redirect: "manual" });
  b.keep(res);
  const authorize = new URL(res.headers.get("location")!);
  expect(authorize.origin).toBe("https://discord.com");
  expect(authorize.searchParams.get("scope")).toBe("identify");
  // The browser's leg to Discord, pointed at the mock.
  res = await fetch(`${mockOrigin}${authorize.pathname}${authorize.search}`, { redirect: "manual" });
  return { b, callback: res.headers.get("location")! };
}

async function callback(b: ReturnType<typeof browser>, url: string, cookie = b.cookie()) {
  const res = await fetch(url, { redirect: "manual", headers: { cookie } });
  b.keep(res);
  return res.headers.get("location") ?? "";
}

/** One full sign-in. Returns where the callback sent the browser, and the cookies it holds. */
async function signIn(id: string) {
  const { b, callback: url } = await startSignIn(id);
  const location = await callback(b, url);
  return { location, cookie: b.cookie() };
}

const sessionCount = () => rows("select id from session").length;

const stub = (cookie?: string) =>
  fetch(`${SITE}/members`, { redirect: "manual", headers: cookie ? { cookie } : {} });

test("a guild member with the Member role reaches the stub", async () => {
  guild.set(MEMBER, [MEMBER_ROLE, AMBASSADOR_ROLE]);
  const { location, cookie } = await signIn(MEMBER);
  expect(location).toMatch(/\/members$/);
  const res = await stub(cookie);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Members only");
  // The user's tokens are not kept.
  expect(rows("select accessToken, refreshToken from account where accountId = ?", MEMBER)).toEqual([
    { accessToken: null, refreshToken: null },
  ]);
});

test("a guild member without the Member role is rejected", async () => {
  guild.set(JOINED, [AMBASSADOR_ROLE]);
  const { location, cookie } = await signIn(JOINED);
  expect(location).toContain("error=");
  expect((await stub(cookie)).status).toBe(302);
  expect(usersFor(JOINED)).toEqual([]);
});

test("a non-member is rejected, and no user row is created", async () => {
  guild.delete(OUTSIDER);
  const before = rows('select id from "user"').length;
  const { location, cookie } = await signIn(OUTSIDER);
  expect(rows('select id from "user"').length).toBe(before);
  expect(rows("select id from account where accountId = ?", OUTSIDER)).toEqual([]);
  expect(location).toContain("error=");
  expect((await stub(cookie)).status).toBe(302);
});

test("a role change in Discord is reflected once the TTL passes", async () => {
  guild.set(MOVER, [MEMBER_ROLE]);
  const { cookie } = await signIn(MOVER);
  expect((await stub(cookie)).status).toBe(200);
  const roleIds = () => rows("select s.roleIds from session s join account a on a.userId = s.userId where a.accountId = ?", MOVER);

  guild.set(MOVER, [MEMBER_ROLE, STAFF_ROLE]);
  await new Promise((r) => setTimeout(r, TTL_MS + 100));
  expect((await stub(cookie)).status).toBe(200);
  expect(roleIds()).toEqual([{ roleIds: JSON.stringify([MEMBER_ROLE, STAFF_ROLE]) }]);

  guild.set(MOVER, [STAFF_ROLE]); // demoted: no longer a Member
  await new Promise((r) => setTimeout(r, TTL_MS + 100));
  const res = await stub(cookie);
  expect(res.status).toBe(302);
  expect(await res.text()).not.toContain("Members only");
  expect(roleIds()).toEqual([]);
}, 10_000);

test("leak: no gated route is prerendered, and the stub is not served without a session", async () => {
  const html = readdirSync(join(SITE_DIR, "dist/client"), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".html"));
  // The public landing page is the only prerendered page.
  expect(html).toEqual(["index.html"]);

  const res = await stub();
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  expect(await res.text()).not.toContain("Members only");
});

test("cookies: the session cookie carries only the opaque token; nothing else is set", async () => {
  setCookies.length = 0;
  guild.set(MEMBER, [MEMBER_ROLE]);
  const { cookie } = await signIn(MEMBER);
  browser().keep(await stub(cookie));

  const set = setCookies
    .map((c) => c.split(";")[0]!)
    .map((pair) => [pair.slice(0, pair.indexOf("=")), decodeURIComponent(pair.slice(pair.indexOf("=") + 1))] as const)
    .filter(([, value]) => value !== ""); // an emptied cookie is an expiry
  expect([...new Set(set.map(([name]) => name))].sort()).toEqual(["better-auth.session_token", "better-auth.state"]);

  // The signed cookie is `<token>.<signature>`; the token is the session row's.
  const [, value] = set.find(([name]) => name === "better-auth.session_token")!;
  const tokens = rows("select s.token from session s join account a on a.userId = s.userId where a.accountId = ?", MEMBER)
    .map((r) => r["token"]);
  expect(tokens).toContain(value.slice(0, value.lastIndexOf(".")));
});

test("no reachable endpoint offers more scope or returns role IDs", async () => {
  guild.set(MEMBER, [MEMBER_ROLE]);
  const { cookie } = await signIn(MEMBER);
  for (const path of ["sign-in/social", "link-social"]) {
    const res = await fetch(`${SITE}/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: SITE, cookie },
      body: JSON.stringify({ provider: "discord", callbackURL: "/members", scopes: ["guilds.members.read"] }),
    });
    expect(res.status, path).toBe(404);
    expect(await res.text(), path).not.toContain("guilds.members.read");
  }
  for (const path of ["get-session", "list-sessions"]) {
    const res = await fetch(`${SITE}/auth/${path}`, { headers: { cookie } });
    expect(res.status, path).toBe(404);
    expect(await res.text(), path).not.toContain(MEMBER_ROLE);
  }
});

test("state: another browser's state is rejected, and a callback cannot be replayed", async () => {
  guild.set(MEMBER, [MEMBER_ROLE]);
  // Login CSRF: an attacker's valid callback, opened in the victim's browser.
  const attacker = await startSignIn(MEMBER);
  const victim = await startSignIn(MEMBER);
  let before = sessionCount();
  expect(await callback(victim.b, attacker.callback)).toContain("error=");
  expect(sessionCount()).toBe(before);

  // Replay: the same callback, with the same cookies, a second time.
  const { b, callback: url } = await startSignIn(MEMBER);
  const stateCookie = b.cookie();
  expect(await callback(b, url, stateCookie)).toMatch(/[/]members$/);
  before = sessionCount();
  expect(await callback(b, url, stateCookie)).toContain("error=");
  expect(sessionCount()).toBe(before);
});

test("Better Auth's own session API never returns the role fields", async () => {
  guild.set(MEMBER, [MEMBER_ROLE]);
  const { cookie } = await signIn(MEMBER);
  expect((await stub(cookie)).status).toBe(200); // the role fields are now stored
  // Straight to Better Auth, past the route allow-list, on the same database.
  Object.assign(process.env, ENV);
  const { auth } = await import("../src/auth.ts");
  const { auth: a, ready } = auth();
  await ready;
  const headers = new Headers({ cookie });
  const found = await a.api.getSession({ headers });
  const listed = await a.api.listSessions({ headers });
  expect(found).not.toBeNull();
  expect(listed.length).toBeGreaterThan(0);
  for (const session of [found!.session, ...listed]) {
    expect(session).not.toHaveProperty("roleIds");
    expect(session).not.toHaveProperty("rolesFetchedAt");
  }
});

test("within the TTL, gated requests use the stored roles", async () => {
  guild.set(MEMBER, [MEMBER_ROLE]);
  const { cookie } = await signIn(MEMBER);
  mock.memberLookups = 0;
  expect((await stub(cookie)).status).toBe(200);
  expect((await stub(cookie)).status).toBe(200);
  expect(mock.memberLookups).toBe(1);
});

test("a gated response carries Better Auth's renewal of the session cookie", async () => {
  guild.set(MEMBER, [MEMBER_ROLE]);
  const { cookie } = await signIn(MEMBER);
  // Bring the session near expiry, so Better Auth extends it on the next request.
  const rw = new DatabaseSync(DB);
  const { token, expiresAt } = rw
    .prepare("select s.token, s.expiresAt from session s join account a on a.userId = s.userId where a.accountId = ? order by s.createdAt desc limit 1")
    .get(MEMBER) as { token: string; expiresAt: number | string };
  const soon = Date.now() + 60_000;
  rw.prepare("update session set expiresAt = ? where token = ?")
    .run(typeof expiresAt === "number" ? soon : new Date(soon).toISOString(), token);
  rw.close();

  const res = await stub(cookie);
  expect(res.status).toBe(200);
  expect(res.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token="))).toBe(true);
});

test("the site stores no username, IP address or user agent", async () => {
  guild.set(MEMBER, [MEMBER_ROLE]);
  const { b, callback: url } = await startSignIn(MEMBER);
  // The session is created in the callback, from the request that carries these.
  const res = await fetch(url, {
    redirect: "manual",
    headers: { cookie: b.cookie(), "x-forwarded-for": "203.0.113.7", "user-agent": "gate-test-agent" },
  });
  expect(res.headers.get("location")).toMatch(/[/]members$/);
  b.keep(res);
  expect((await stub(b.cookie())).status).toBe(200);

  const stored = JSON.stringify([
    rows('select u.* from "user" u join account a on a.userId = u.id where a.accountId = ?', MEMBER),
    rows("select * from account where accountId = ?", MEMBER),
    rows("select s.* from session s join account a on a.userId = s.userId where a.accountId = ?", MEMBER),
  ]);
  expect(stored, "username").not.toContain(`fixture-${MEMBER}`);
  expect(stored, "IP address").not.toContain("203.0.113.7");
  expect(stored, "user agent").not.toContain("gate-test-agent");
});

test("a repeat sign-in stores no tokens", async () => {
  guild.set(MEMBER, [MEMBER_ROLE]);
  await signIn(MEMBER);
  await signIn(MEMBER);
  expect(JSON.stringify(rows("select * from account where accountId = ?", MEMBER))).not.toContain("tok-");
});

test("the sweep deletes expired sessions and sign-in states, and keeps live ones", async () => {
  guild.set(MEMBER, [MEMBER_ROLE]);
  await signIn(MEMBER);
  await signIn(MEMBER);
  await startSignIn(MEMBER);
  await startSignIn(MEMBER);
  const rw = new DatabaseSync(DB);
  const past = new Date(Date.now() - 60_000).toISOString();
  const pick = (table: string) =>
    (rw.prepare(`select id from ${table} where expiresAt > ? order by id limit 2`).all(new Date().toISOString()) as { id: string }[])
      .map((r) => r.id);
  const [expiredSession, liveSession] = pick("session");
  const [expiredState, liveState] = pick("verification");
  rw.prepare("update session set expiresAt = ? where id = ?").run(past, expiredSession!);
  rw.prepare("update verification set expiresAt = ? where id = ?").run(past, expiredState!);

  const { sweep } = await import("../src/auth.ts");
  sweep(rw);
  const ids = (table: string) => (rw.prepare(`select id from ${table}`).all() as { id: string }[]).map((r) => r.id);
  expect(ids("session")).not.toContain(expiredSession);
  expect(ids("session")).toContain(liveSession);
  expect(ids("verification")).not.toContain(expiredState);
  expect(ids("verification")).toContain(liveState);
  rw.close();
});
