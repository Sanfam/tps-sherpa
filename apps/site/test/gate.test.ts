// The Phase 4 mechanical gate, end to end: the built site against a mock
// Discord, on a fresh session database.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { editedSinceImport } from "../scripts/rewrite-guard.ts";
import { NEVER, concrete, injected } from "./emdash-routes.ts";
import { BOT_TOKEN, GUILD_ID, avatars, displayNames, guild, mock, startMock, usernames } from "./mock-discord.ts";

const SITE_DIR = join(import.meta.dirname, "..");
// A free port from the OS, so suites running at once (two worktrees) never collide.
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
const PORT = await freePort();
const SITE = `http://127.0.0.1:${PORT}`;
const TTL_MS = 1000;

// Fake snowflakes. Member, Ambassador and Flight Sim role IDs match
// fixtures/roles.json. The editor roles are absent from it, as real IDs are.
const MEMBER_ROLE = "300000000000000001";
const STAFF_ROLE = "300000000000000002";
const AMBASSADOR_ROLE = "300000000000000003";
const EVENT_MANAGERS_ROLE = "300000000000000006";
const MEMBER = "900000000000000001";
const JOINED = "900000000000000002"; // in the guild, no Member role yet
const OUTSIDER = "900000000000000003"; // not in the guild
const MOVER = "900000000000000004"; // roles change while signed in
const STAFF = "900000000000000005";
const EVENT_MANAGER = "900000000000000006";
const FLOODER = "900000000000000007"; // any Discord account, not in the guild
const BURSTER = "900000000000000008"; // a signed-in Member firing many requests at once
const DAD = "900000000000000014"; // a Member with a display name and avatar, who signs out
const STRANDED = "900000000000000015"; // signed in when Discord goes down

const tmp = mkdtempSync(join(tmpdir(), "site-gate-"));
const DB = join(tmp, "sessions.db");
let mockServer: Server;
let mockOrigin: string;
let site: ChildProcess;

// The site's configuration, shared with the in-process auth instance below.
const ENV = {
  SITE_SESSION_DB: DB,
  SITE_EMDASH_DIR: tmp,
  ROLES_TTL_MS: String(TTL_MS),
  BETTER_AUTH_URL: SITE,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  DISCORD_CLIENT_ID: "mock-client",
  DISCORD_CLIENT_SECRET: "mock-secret",
  DISCORD_BOT_TOKEN: BOT_TOKEN,
  DISCORD_GUILD_ID: GUILD_ID,
  DISCORD_MEMBER_ROLE_ID: MEMBER_ROLE,
  DISCORD_STAFF_ROLE_ID: STAFF_ROLE,
  DISCORD_EVENT_MANAGERS_ROLE_ID: EVENT_MANAGERS_ROLE,
};

// Vitest's environment, less the import.meta.env values it mirrors into it.
// Inherited, DEV=1 or NODE_ENV=test makes a dev build, in which EmDash skips
// external auth for its own passkey sign-in; and Vitest's TEST=true turns off
// Better Auth's origin check.
const prodEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !["NODE_ENV", "MODE", "DEV", "PROD", "SSR", "BASE_URL", "TEST"].includes(k)),
);

const db = () => new DatabaseSync(DB, { readOnly: true });
const rows = (sql: string, ...params: string[]) => db().prepare(sql).all(...params);
const emdashBytes = () =>
  Buffer.concat([join(tmp, "emdash.db"), join(tmp, "emdash.db-wal"), join(tmp, "emdash.db-shm")]
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path))).toString("utf8");
const usersFor = (id: string) =>
  rows('select u.id from "user" u join account a on a.userId = u.id where a.accountId = ?', id);

// The Catalog snapshot the site serves from, as the bot sends it: one Channel,
// and one Need 4 Read meeting two days out.
const DAY = 86_400_000;
const BOOK_NIGHT = "Book club: zqxnovelnightqz";
const snapshot = (generatedAt: number) => {
  const start = new Date(Date.now() + 2 * DAY).toISOString();
  return JSON.stringify({
    version: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    syncEveryMs: 6 * 60 * 60_000,
    outcome: { complete: true },
    roleManifest: JSON.parse(readFileSync(join(SITE_DIR, "fixtures/roles.json"), "utf8")),
    catalog: [{
      id: "500000000000000001", type: "channel", name: "general", url: `https://discord.com/channels/${GUILD_ID}/500000000000000001`,
      parent_id: null, description_status: "absent", topic: null, applied_tags: [], region: [], topics: [], topics_version: null,
      thread_state: null, last_message_id: null, last_activity_at: null, summary_generated: null, summary_override: null,
    }],
    events: [{
      id: "600000000000000001", name: BOOK_NIGHT, description: null, start, next: start, end: null, status: "scheduled",
      entity_type: "external", channel_id: null, location: "Voice chat", image_url: null, recurrence: null, canceled_starts: [], moved: [],
    }],
  });
};

beforeAll(async () => {
  execFileSync("npx", ["astro", "build"], { cwd: SITE_DIR, stdio: "ignore", env: { ...prodEnv, ...ENV } });
  writeFileSync(join(tmp, "catalog-snapshot.json"), snapshot(Date.now()));
  const started = await startMock();
  mockServer = started.server;
  mockOrigin = started.origin;
  site = await serve(PORT, ENV);
}, 120_000);

/** The built site on `port`, once it answers. */
async function serve(port: number, env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "./test/redirect-discord.mjs", "./dist/server/entry.mjs"], {
    cwd: SITE_DIR,
    stdio: "ignore",
    env: { ...prodEnv, ...env, HOST: "127.0.0.1", PORT: String(port), MOCK_DISCORD: mockOrigin },
  });
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${port}`).then(() => true, () => false)) return child;
    if (i > 100) throw new Error("site did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

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
  // The mock refuses a sign-in without the challenge, and a token exchange without its verifier.
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
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
/** The token of an account's newest session. */
const latestToken = (rw: DatabaseSync, id: string) =>
  (rw.prepare("select s.token from session s join account a on a.userId = s.userId where a.accountId = ? order by s.createdAt desc limit 1")
    .get(id) as { token: string }).token;

const stub = (cookie?: string) =>
  fetch(`${SITE}/members`, { redirect: "manual", headers: cookie ? { cookie } : {} });

test("a guild member with the Member role reaches the stub", async () => {
  guild.set(MEMBER, [MEMBER_ROLE, AMBASSADOR_ROLE]);
  const { location, cookie } = await signIn(MEMBER);
  expect(location).toMatch(/\/members$/);
  const res = await stub(cookie);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Coming up");
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

test("one Discord account's flood of sign-ins stops spending the bot token; a Member still signs in", async () => {
  guild.delete(FLOODER);
  guild.set(MEMBER, [MEMBER_ROLE]);
  mock.memberLookups = 0;
  for (let i = 0; i < 30; i++) expect(await signIn(FLOODER).then((r) => r.location)).toContain("error=");
  // Each sign-in is a guild lookup with the bot token, up to the account's budget of 20.
  expect(mock.memberLookups).toBe(20);
  expect((await signIn(MEMBER)).location).toMatch(/\/members$/);
  expect(mock.memberLookups).toBe(21);
});

test("a burst of requests past the TTL re-checks roles with the bot token once", async () => {
  guild.set(BURSTER, [MEMBER_ROLE]);
  const { cookie } = await signIn(BURSTER);
  await new Promise((r) => setTimeout(r, TTL_MS + 100));
  mock.memberLookups = 0;
  const statuses = await Promise.all(Array.from({ length: 20 }, () => stub(cookie).then((r) => r.status)));
  expect(statuses.every((s) => s === 200)).toBe(true);
  expect(mock.memberLookups).toBe(1);
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
  expect(await res.text()).not.toContain("Coming up");
  expect(roleIds()).toEqual([]);
}, 10_000);

test("leak: no route is prerendered, and neither the stub nor the account page is served without a session", async () => {
  const html = readdirSync(join(SITE_DIR, "dist/client"), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".html"));
  // Every page shows who is signed in, so none is static, the landing page included.
  expect(html).toEqual([]);

  const res = await stub();
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  expect(await res.text()).not.toContain("Coming up");

  const account = await at("/account");
  expect(account.status).toBe(302);
  expect(account.headers.get("location")).toBe("/");
});

test("the landing page shows a signed-in Member their current Discord name and avatar, uncached and without asking Discord; a Viewer sees neither", async () => {
  guild.set(DAD, [MEMBER_ROLE]);
  displayNames.set(DAD, "Fixture Dad");
  avatars.set(DAD, "a1b2c3");
  await signIn(DAD);
  // Renamed in Discord, with a new avatar: the next sign-in brings them.
  displayNames.set(DAD, "Renamed Dad");
  avatars.set(DAD, "d4e5f6");
  const { cookie } = await signIn(DAD);
  // Near its end, where any visit that renews would extend it.
  const rw = new DatabaseSync(DB);
  const token = latestToken(rw, DAD);
  rw.prepare("update session set expiresAt = ? where token = ?").run(new Date(Date.now() + 60_000).toISOString(), token);
  const expiry = () => rw.prepare("select expiresAt from session where token = ?").get(token);
  const before = expiry();
  // Past the roles TTL, a public page still asks Discord nothing, so an outage cannot stall it.
  await new Promise((r) => setTimeout(r, TTL_MS + 100));
  mock.memberLookups = 0;
  const res = await at("/", cookie);
  expect(mock.memberLookups).toBe(0);
  // Nor does it renew the session: a former Member cannot keep one alive on public pages.
  expect(res.headers.getSetCookie().filter((c) => c.startsWith("better-auth.session_token="))).toEqual([]);
  expect(expiry()).toEqual(before);
  rw.close();
  // The page names one Member, so no shared cache may keep it.
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("vary")?.split(/,\s*/)).toContain("Cookie");
  const signedIn = await res.text();
  expect(signedIn).toContain("Renamed Dad");
  expect(signedIn).not.toContain("Fixture Dad");
  expect(signedIn).toContain(`https://cdn.discordapp.com/avatars/${DAD}/d4e5f6.png`);

  const viewer = await at("/");
  expect(viewer.status).toBe(200);
  const body = await viewer.text();
  expect(body).toContain('href="/auth/discord/start"');
  expect(body).not.toContain("Fixture Dad");
  expect(body).not.toContain("Renamed Dad");
  expect(body).not.toContain("cdn.discordapp.com");
  displayNames.delete(DAD);
  avatars.delete(DAD);
});

test("the account page shows a Member who they are signed in as, and their own roles by name", async () => {
  const FLIGHT_SIM_ROLE = "300000000000000004";
  guild.set(DAD, [MEMBER_ROLE, AMBASSADOR_ROLE, FLIGHT_SIM_ROLE]);
  displayNames.set(DAD, "Fixture Dad");
  avatars.set(DAD, "a1b2c3");
  const { cookie } = await signIn(DAD);
  displayNames.delete(DAD);
  avatars.delete(DAD);
  // Near its end: opening the page renews the session, and the page says so.
  const rw = new DatabaseSync(DB);
  rw.prepare("update session set expiresAt = ? where token = ?").run(new Date(Date.now() + 60_000).toISOString(), latestToken(rw, DAD));
  rw.close();
  const res = await at("/account", cookie);
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("Fixture Dad");
  expect(body).toContain(`https://cdn.discordapp.com/avatars/${DAD}/a1b2c3.png`);
  expect(body).toContain(`@fixture-${DAD}`);
  const ends = new Date(body.match(/<time datetime="([^"]+)"/)![1]!);
  expect(ends.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);
  // Their own roles, by name, as Discord shows them (owner, 2026-11-24); never the IDs.
  expect(body).toContain("Ambassador");
  expect(body).toContain("Flight Sim");
  for (const id of [MEMBER_ROLE, AMBASSADOR_ROLE, FLIGHT_SIM_ROLE]) expect(body, id).not.toContain(id);
});

test("the landing page still renders, signed out, when the session database cannot open", async () => {
  const broken = mkdtempSync(join(tmpdir(), "site-gate-broken-"));
  const port = await freePort();
  // A directory where the session database should be.
  const child = await serve(port, { ...ENV, SITE_SESSION_DB: broken, SITE_EMDASH_DIR: broken });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/auth/discord/start"');
    // A gated page still refuses.
    const gated = await fetch(`http://127.0.0.1:${port}/members`, { redirect: "manual" });
    expect(gated.status).not.toBe(200);
  } finally {
    child.kill();
    rmSync(broken, { recursive: true, force: true });
  }
}, 20_000);

test("sign out ends the session: the old cookie no longer opens a gated page, and another site cannot sign anyone out", async () => {
  guild.set(DAD, [MEMBER_ROLE]);
  const { cookie } = await signIn(DAD);
  expect((await stub(cookie)).status).toBe(200);
  // The session bar's form post, from this site or from another.
  const signOut = (origin: string) =>
    fetch(`${SITE}/auth/sign-out`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
    });

  expect((await signOut("https://elsewhere.example")).status).toBe(403);
  expect((await stub(cookie)).status).toBe(200);
  // Only the form's POST signs out: a link or a prefetch does not.
  for (const method of ["GET", "PUT", "DELETE"]) {
    const res = await fetch(`${SITE}/auth/sign-out`, { method, redirect: "manual", headers: { cookie, origin: SITE } });
    expect(res.status, method).toBe(405);
  }
  expect((await stub(cookie)).status).toBe(200);

  // When the session cannot be deleted, sign-out says so rather than sending
  // the Member home believing a copied cookie is dead.
  const rw = new DatabaseSync(DB);
  const token = latestToken(rw, DAD);
  // Near its end, so checking a sign-out that failed must not extend it either.
  rw.prepare("update session set expiresAt = ? where token = ?").run(new Date(Date.now() + 60_000).toISOString(), token);
  const expiry = () => rw.prepare("select expiresAt from session where token = ?").get(token);
  const before = expiry();
  rw.exec("create trigger keep_sessions before delete on session begin select raise(abort, 'disk full'); end");
  try {
    expect((await signOut(SITE)).status).toBe(500);
    expect(expiry()).toEqual(before);
  } finally {
    rw.exec("drop trigger keep_sessions");
    rw.close();
  }

  const res = await signOut(SITE);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  expect(res.headers.getSetCookie().some((c) => /^better-auth\.session_token=;.*Max-Age=0/i.test(c))).toBe(true);
  // A browser that kept the cookie anyway is a Viewer.
  const after = await stub(cookie);
  expect(after.status).toBe(302);
  expect(after.headers.get("location")).toBe("/");
});

test("the privacy page is public and server-rendered, and shows both policies, bold kept", async () => {
  const res = await fetch(`${SITE}/privacy`, { redirect: "manual" });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("Papa Squad website privacy policy");
  expect(body).toContain("Papa Sherpa privacy policy");
  expect(body).toContain("<strong>we will never sell, rent or trade it.</strong>");
}, 10_000);

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

test("a gated page that cannot confirm membership does not renew the session", async () => {
  guild.set(STRANDED, [MEMBER_ROLE]);
  const { cookie } = await signIn(STRANDED);
  expect((await stub(cookie)).status).toBe(200);
  const rw = new DatabaseSync(DB);
  const token = latestToken(rw, STRANDED);
  rw.prepare("update session set expiresAt = ? where token = ?").run(new Date(Date.now() + 60_000).toISOString(), token);
  const expiry = () => rw.prepare("select expiresAt from session where token = ?").get(token);
  const before = expiry();

  // Discord is down once the stored roles are stale: the page is refused, and
  // the session must not be extended on a check that settled nothing.
  await new Promise((r) => setTimeout(r, TTL_MS + 100));
  mock.down = true;
  try {
    const res = await stub(cookie);
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie().filter((c) => c.startsWith("better-auth.session_token="))).toEqual([]);
    expect(expiry()).toEqual(before);
  } finally {
    mock.down = false;
    rw.close();
  }
});

test("a session that ends while Discord rechecks its roles is refused", async () => {
  guild.set(STRANDED, [MEMBER_ROLE]);
  const { cookie } = await signIn(STRANDED);
  expect((await stub(cookie)).status).toBe(200);
  const rw = new DatabaseSync(DB);
  const token = latestToken(rw, STRANDED);
  await new Promise((r) => setTimeout(r, TTL_MS + 100));
  // Discord confirms the Member, but the session has run out meanwhile.
  mock.onLookup = () =>
    rw.prepare("update session set expiresAt = ? where token = ?").run(new Date(Date.now() - 1000).toISOString(), token);
  try {
    const res = await stub(cookie);
    expect(res.status).toBe(302);
    expect(await res.text()).not.toContain("Coming up");
  } finally {
    mock.onLookup = undefined;
    rw.close();
  }
});

test("the site stores the username, and no IP address or user agent", async () => {
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
  expect(stored, "username").toContain(`fixture-${MEMBER}`);
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

// EmDash in external-auth mode (ADR-0002), on the site's session.
const editors = (id: string) =>
  new DatabaseSync(join(tmp, "emdash.db"), { readOnly: true })
    .prepare("select role, name from users where email = ?")
    .all(`${id}@discord.local`);
const cms = (cookie: string) => fetch(`${SITE}/_emdash/api/auth/me`, { headers: { cookie } });
const at = (path: string, cookie = "", method = "GET") =>
  fetch(`${SITE}${path}`, { method, redirect: "manual", headers: { cookie } });

// First among the EmDash tests: EmDash makes whoever it provisions first an
// Admin, whatever their role (step 3 of the trial seeds a Staff row instead).
test("EmDash: Staff land as Admin and Event Managers as Author, named by username", async () => {
  for (const [id, role, level] of [
    [STAFF, STAFF_ROLE, 50],
    [EVENT_MANAGER, EVENT_MANAGERS_ROLE, 30],
  ] as const) {
    guild.set(id, [MEMBER_ROLE, role]);
    const { cookie } = await signIn(id);
    expect((await cms(cookie)).status, id).toBe(200);
    expect(editors(id), id).toEqual([{ role: level, name: `fixture-${id}` }]);
  }
});

test("EmDash: a Member with no editor role is refused and leaves no users row", async () => {
  guild.set(MEMBER, [MEMBER_ROLE, AMBASSADOR_ROLE]);
  const { cookie } = await signIn(MEMBER);
  expect((await stub(cookie)).status).toBe(200); // a Member on the site
  expect((await cms(cookie)).status).toBe(404); // the gate, ahead of EmDash
  expect(editors(MEMBER)).toEqual([]);
});

test("EmDash: a role change applies on private routes within the TTL, without a new sign-in", async () => {
  guild.set(MOVER, [MEMBER_ROLE, STAFF_ROLE]);
  const { cookie } = await signIn(MOVER);
  expect((await cms(cookie)).status).toBe(200);
  expect(editors(MOVER)).toEqual([{ role: 50, name: `fixture-${MOVER}` }]);

  guild.set(MOVER, [MEMBER_ROLE, EVENT_MANAGERS_ROLE]);
  await new Promise((r) => setTimeout(r, TTL_MS + 100));
  expect((await cms(cookie)).status).toBe(200);
  expect(editors(MOVER)).toEqual([{ role: 30, name: `fixture-${MOVER}` }]);

  guild.set(MOVER, [MEMBER_ROLE]);
  await new Promise((r) => setTimeout(r, TTL_MS + 100));
  expect((await cms(cookie)).status).toBe(404);
  // EmDash's public search would still serve drafts on the stored role.
  expect((await at("/_emdash/api/search?q=x", cookie)).status).toBe(404);
  expect(editors(MOVER)).toEqual([{ role: 30, name: `fixture-${MOVER}` }]);
}, 10_000);

test("EmDash: a renamed Discord account is renamed on its next sign-in", async () => {
  guild.set(EVENT_MANAGER, [MEMBER_ROLE, EVENT_MANAGERS_ROLE]);
  expect((await cms((await signIn(EVENT_MANAGER)).cookie)).status).toBe(200);
  usernames.set(EVENT_MANAGER, "renamed");
  try {
    const { cookie } = await signIn(EVENT_MANAGER);
    expect((await cms(cookie)).status).toBe(200);
    expect(editors(EVENT_MANAGER)).toEqual([{ role: 30, name: "renamed" }]);
    expect(rows('select u.name from "user" u join account a on a.userId = u.id where a.accountId = ?', EVENT_MANAGER))
      .toEqual([{ name: "renamed" }]);
  } finally {
    usernames.delete(EVENT_MANAGER);
  }
});

test("EmDash: within the TTL, CMS requests and refusals use the stored roles", async () => {
  guild.set(MEMBER, [MEMBER_ROLE]);
  const { cookie } = await signIn(MEMBER);
  expect((await stub(cookie)).status).toBe(200); // roles now stored on the session
  mock.memberLookups = 0;
  for (let i = 0; i < 3; i++) expect((await cms(cookie)).status).toBe(404);
  expect(mock.memberLookups).toBe(0);
});

// The gate (src/emdash-gate.ts) over HTTP; emdash-gate.test.ts places every route.
test("gate: each kind of caller reaches only the routes placed for it", async () => {
  guild.set(MEMBER, [MEMBER_ROLE]);
  guild.set(EVENT_MANAGER, [MEMBER_ROLE, EVENT_MANAGERS_ROLE]);
  guild.set(STAFF, [MEMBER_ROLE, STAFF_ROLE]);
  mkdirSync(join(tmp, "uploads"), { recursive: true });
  writeFileSync(join(tmp, "uploads", "gate-test.txt"), "uploaded");
  const callers = {
    viewer: "",
    member: (await signIn(MEMBER)).cookie,
    author: (await signIn(EVENT_MANAGER)).cookie,
    admin: (await signIn(STAFF)).cookie,
  };
  // [method, path, the callers who get through]. EmDash answers each of these
  // with something other than 404 for whoever reaches it.
  const cases: [string, string, (keyof typeof callers)[]][] = [
    ["GET", "/_emdash/api/media/file/gate-test.txt", ["member", "author", "admin"]],
    ["GET", "/_emdash/api/auth/me", ["author", "admin"]],
    ["GET", "/_emdash/api/search?q=x", ["author", "admin"]],
    ["GET", "/_emdash/api/setup/status", ["admin"]],
    ["GET", "/_emdash/api/snapshot", []],
    ["GET", "/_emdash/api/admin/api-tokens", ["admin"]],
    ["POST", "/_emdash/api/content/pages/x1/preview-url", []],
    ["POST", "/_emdash/api/mcp", []],
    ["GET", "/.well-known/oauth-protected-resource", []],
    ["GET", "/_emdash/api/health", []],
    ["GET", "/_emdash/api/no-such-route", []],
  ];
  for (const [method, path, allowed] of cases) {
    for (const [who, cookie] of Object.entries(callers)) {
      const { status } = await at(path, cookie, method);
      const through = allowed.includes(who as keyof typeof callers);
      expect(status === 404, `${who} ${method} ${path}: ${status}`).toBe(!through);
    }
  }
  // Every route EmDash injects, against expectations that do not come from the
  // gate's lists: a caller without an editor role reaches nothing but uploaded
  // files (a Viewer not even those), and no one reaches a credential or export.
  for (const pattern of injected) {
    const path = concrete(pattern);
    if (!path.startsWith("/_emdash") && !path.startsWith("/.well-known")) continue; // robots.txt, sitemaps: the site's
    // Astro answers 404 for a method a route lacks, so both are sent. A POST
    // without EmDash's CSRF header changes nothing even where it gets through.
    for (const method of ["GET", "POST"]) {
      for (const [who, cookie] of Object.entries(callers)) {
        const uploads = who === "member" && pattern === "/_emdash/api/media/file/[...key]";
        if (!NEVER.test(pattern) && (who === "author" || who === "admin" || uploads)) continue;
        const res = await at(path, cookie, method);
        // 501 is upload-url's refusal: the admin's cue to upload through the site.
        const refused = res.status === 404 || res.status === 501 || (res.status === 302 && res.headers.get("location") === "/");
        expect(refused, `${who} ${method} ${path}: ${res.status}`).toBe(true);
      }
    }
  }
  // EmDash's admin uploads through the site only when upload-url answers 501;
  // any other refusal breaks uploads.
  for (const who of ["author", "admin"] as const) {
    expect((await at("/_emdash/api/media/upload-url", callers[who], "POST")).status, who).toBe(501);
  }
  // The admin pages send a caller without an editor role home.
  for (const [who, cookie] of Object.entries(callers)) {
    const res = await at("/_emdash/admin", cookie);
    const home = res.status === 302 && res.headers.get("location") === "/";
    expect(home, `${who}: ${res.status} ${res.headers.get("location")}`).toBe(who === "viewer" || who === "member");
  }
}, 20_000);

// An Admin connects a machine client (Claude Code) to EmDash's MCP with an API
// token made in the CMS (owner, 2026-11-18). EmDash acts on the role stored on
// the token's holder, which a Discord role loss does not touch.
const TOKEN_ADMIN = "900000000000000011";
async function apiToken(cookie: string, scopes: string[]) {
  const res = await fetch(`${SITE}/_emdash/api/admin/api-tokens`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "X-EmDash-Request": "1", Origin: SITE },
    body: JSON.stringify({ name: "claude-code", scopes }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { token: string } }).data.token;
}
const mcp = (token: string, cookie = "") =>
  fetch(`${SITE}/_emdash/api/mcp`, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Bearer ${token}`,
      cookie,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

test("MCP: an Admin's API token works while they hold Staff, and stops within the TTL once it is removed", async () => {
  guild.set(TOKEN_ADMIN, [MEMBER_ROLE, STAFF_ROLE]);
  const token = await apiToken((await signIn(TOKEN_ADMIN)).cookie, ["content:read"]);

  // A client's burst spends the bot token once.
  mock.memberLookups = 0;
  const burst = await Promise.all(Array.from({ length: 10 }, () => mcp(token)));
  expect(burst.map((r) => r.status)).toEqual(Array(10).fill(200));
  expect(await burst[0]!.text()).toContain("content_list");
  expect(mock.memberLookups).toBe(1);

  guild.set(TOKEN_ADMIN, [MEMBER_ROLE]);
  await new Promise((r) => setTimeout(r, TTL_MS + 100));
  expect((await mcp(token)).status).toBe(403);
  // EmDash takes the token over a session, so another Admin's cookie beside it changes nothing.
  guild.set(STAFF, [MEMBER_ROLE, STAFF_ROLE]);
  expect((await mcp(token, (await signIn(STAFF)).cookie)).status).toBe(403);
}, 10_000);

test("MCP: an OAuth access token, or an API token with a scope past the gate's refusals, is refused", async () => {
  // Another Admin: the one above is refused, and cached so, for a TTL.
  const ADMIN_TWO = "900000000000000012";
  guild.set(ADMIN_TWO, [MEMBER_ROLE, STAFF_ROLE]);
  const cookie = (await signIn(ADMIN_TWO)).cookie;
  expect((await mcp(await apiToken(cookie, ["content:read"]))).status).toBe(200);
  // Whole-site exports over MCP: `transfer:export` itself, and `admin`, which
  // grants it. Plugins' MCP tools: `mcp:tools`.
  for (const scope of ["transfer:export", "admin", "mcp:tools"]) {
    expect((await mcp(await apiToken(cookie, [scope]))).status, scope).toBe(403);
  }

  // An access token as EmDash's OAuth server would have issued one, planted
  // because that server is refused: EmDash itself would accept it.
  const raw = "ec_oat_zqxplantedaccesstokenqz";
  const rw = new DatabaseSync(join(tmp, "emdash.db"));
  const { id } = rw.prepare("select id from users where email = ?").get(`${ADMIN_TWO}@discord.local`) as { id: string };
  rw.prepare("insert into _emdash_oauth_tokens (token_hash, token_type, user_id, scopes, expires_at) values (?, 'access', ?, ?, ?)").run(
    createHash("sha256").update(raw).digest("base64url"),
    id,
    JSON.stringify(["content:read"]),
    new Date(Date.now() + 3_600_000).toISOString(),
  );
  rw.close();
  expect((await mcp(raw)).status).toBe(401);
});

// On uploaded files and search EmDash reads no token and checks no scope, so
// a token made for settings alone would read Member-only files and content.
test("API tokens: a token reaches no route EmDash serves without checking its scopes", async () => {
  const ADMIN_THREE = "900000000000000013";
  guild.set(ADMIN_THREE, [MEMBER_ROLE, STAFF_ROLE]);
  const token = await apiToken((await signIn(ADMIN_THREE)).cookie, ["settings:read"]);
  mkdirSync(join(tmp, "uploads"), { recursive: true });
  writeFileSync(join(tmp, "uploads", "token-test.txt"), "zqxuploadqz");
  const get = (path: string) => fetch(`${SITE}${path}`, { redirect: "manual", headers: { authorization: `Bearer ${token}` } });
  expect((await get("/_emdash/api/settings")).status).toBe(200); // the token works where EmDash checks its scope
  // EmDash tells its API routes by exact, case-sensitive prefixes; a spelling
  // Astro still routes could reach its admin manifest past the token's scopes.
  expect((await get("/_emdash/api/manifest")).status).toBe(403); // EmDash: the scope is missing
  for (const path of [
    "/_emdash/api/media/file/token-test.txt",
    "/_emdash/api/search?q=live",
    "/_emdash/api/search/suggest?q=li",
    "/%5femdash/api/manifest",
    "/_EMDASH/api/manifest",
    "/_emdash//api/manifest",
  ]) {
    const res = await get(path);
    expect(res.status, path).toBe(404);
    expect(await res.text(), path).not.toContain("zqxuploadqz");
  }
});

test("EmDash permanently deletes content through the site's configured SQLite dialect", async () => {
  guild.set(STAFF, [MEMBER_ROLE, STAFF_ROLE]);
  const { cookie } = await signIn(STAFF);
  const token = "zqxrestsentinelqz";
  const headers = {
    cookie,
    "content-type": "application/json",
    "X-EmDash-Request": "1",
    Origin: SITE,
  };
  const created = await fetch(`${SITE}/_emdash/api/content/pages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data: { title: token, content: [] } }),
  });
  expect(created.status).toBe(201);
  const payload = (await created.json()) as { success: boolean; data: { item: { id: string } } };
  const id = payload.data.item.id;
  const trashed = await fetch(`${SITE}/_emdash/api/content/pages/${id}`, {
    method: "DELETE",
    headers: { cookie, "X-EmDash-Request": "1", Origin: SITE },
  });
  expect(trashed.status).toBe(200);
  const deleted = await fetch(`${SITE}/_emdash/api/content/pages/${id}/permanent`, {
    method: "DELETE",
    headers: { cookie, "X-EmDash-Request": "1", Origin: SITE },
  });
  expect(deleted.status).toBe(200);
  // Deleted text reaches the main file at the next WAL checkpoint, which
  // Litestream runs in production; until then it lingers on disk, out of any
  // user's reach, which the owner accepts (2026-11-15). Checkpoint as Litestream
  // would, then scan: without secure_delete on EmDash's own connection, the
  // freed pages would still hold the text.
  const db = new DatabaseSync(join(tmp, "emdash.db"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  expect(emdashBytes()).not.toContain(token);
});

// The site's CMS pages (src/pages/[...slug].astro) show Members published
// content. Edit mode is EmDash's, on the role it stored (ADR-0002, 2026-11-24):
// a Member who was never an editor and sets its cookie must read no draft. An
// editor demoted in Discord keeps the stored role and its drafts: accepted.
test("CMS pages: drafts and inline editing reach an editor in edit mode, not a Member who sets its cookie", async () => {
  guild.set(STAFF, [MEMBER_ROLE, STAFF_ROLE]);
  const staff = (await signIn(STAFF)).cookie;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${SITE}/_emdash/api${path}`, {
      method,
      headers: { cookie: staff, "content-type": "application/json", "X-EmDash-Request": "1", Origin: SITE },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(res.ok, `${method} ${path}: ${res.status}`).toBe(true);
    return ((await res.json()) as { data: { item: { id: string } } }).data;
  };
  const text = (t: string) => [
    { _type: "block", _key: "b", style: "normal", markDefs: [], children: [{ _type: "span", _key: "s", text: t, marks: [] }] },
  ];
  await api("POST", "/content/pages", { slug: "club/unwritten", data: { title: "zqxdrafttitleqz", content: text("zqxstubdraftqz") } });
  const { item } = await api("POST", "/content/pages", { slug: "club/live", data: { title: "Live", content: text("zqxlivetextqz") } });
  await api("POST", `/content/pages/${item.id}/publish`);
  await api("PUT", `/content/pages/${item.id}`, { data: { title: "Live", content: text("zqxpendingeditqz") } });
  // The club's section page, its title being renamed in a draft: the nav on
  // every Member page titles it.
  const { item: section } = await api("POST", "/content/pages", { slug: "club/home", data: { title: "zqxsectionqz", content: [] } });
  await api("POST", `/content/pages/${section.id}/publish`);
  await api("PUT", `/content/pages/${section.id}`, { data: { title: "zqxpendingtitleqz", content: [] } });

  // Staff, signed in to the CMS once (EmDash's own session cookie), with edit mode on.
  const editorSession = browser();
  editorSession.keep(await fetch(`${SITE}/_emdash/api/auth/me`, { headers: { cookie: staff } }));
  const editor = [staff, editorSession.cookie(), "emdash-edit-mode=true"].filter(Boolean).join("; ");
  // A Member who sets the edit-mode cookie by hand.
  guild.set(MEMBER, [MEMBER_ROLE]);
  const member = [(await signIn(MEMBER)).cookie, "emdash-edit-mode=true"].join("; ");

  const draft = await at("/club/unwritten", member);
  expect(draft.status).toBe(404);
  expect(await draft.text()).not.toContain("zqxstubdraftqz");
  const live = await (await at("/club/live", member)).text();
  expect(live).toContain("zqxlivetextqz");
  expect(live).not.toContain("zqxpendingeditqz");

  // The editor gets the draft, in EmDash's inline editor (it needs the content
  // as EmDash returned it, marker and all), and an editable title.
  expect(await (await at("/club/unwritten", editor)).text()).toContain("zqxstubdraftqz");
  const editing = await (await at("/club/live", editor)).text();
  expect(editing).toContain("zqxpendingeditqz");
  expect(editing).toContain('component-export="InlinePortableTextEditor"');
  expect(editing).toMatch(/<h1 data-emdash-ref="[^"]*&quot;field&quot;:&quot;title&quot;/);

  // Navigation names only published pages, by their published titles, for both.
  for (const [who, c, paths] of [
    ["member", member, ["/club/live", "/club/home", "/members"]],
    ["editor", editor, ["/members"]],
  ] as const) {
    for (const path of paths) {
      const page = await (await at(path, c)).text();
      expect(page, `${who} ${path}`).toContain("zqxsectionqz");
      expect(page, `${who} ${path}`).not.toContain("zqxpendingtitleqz");
      expect(page, `${who} ${path}`).not.toContain("zqxdrafttitleqz");
    }
  }
  expect(await (await at("/club/home", member)).text()).toContain('href="/club/live"');
}, 15_000);

// EmDash completes a room's WebSocket on the raw HTTP server, past every
// middleware, and keeps it until it closes; the gate's watch must close it.
test("co-editing: an editor demoted in Discord loses their open room socket within the TTL", async () => {
  const COEDITOR = "900000000000000010";
  guild.set(COEDITOR, [MEMBER_ROLE, STAFF_ROLE]);
  const { cookie } = await signIn(COEDITOR);
  const headers = { cookie, "content-type": "application/json", "X-EmDash-Request": "1", Origin: SITE };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${SITE}/_emdash/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(res.ok, `${method} ${path}: ${res.status}`).toBe(true);
    return ((await res.json()) as { data: any }).data;
  };
  const { version, commit, hash } = await api("GET", "/manifest");
  const { item } = await api("POST", "/content/pages", { data: { title: "Co-edited", content: [] } });
  const joined = await api("POST", `/content/pages/${item.id}/room`, { fingerprint: { version, commit, hash } });
  expect(joined.mode).toBe("room");

  // A browser sends the site's cookies with the upgrade.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${joined.url}?token=${joined.token}`, { headers: { cookie } } as never);
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
  await new Promise((resolve, reject) => {
    ws.addEventListener("message", resolve, { once: true });
    ws.addEventListener("close", reject, { once: true });
  });
  // An editor who keeps the role keeps the socket past several re-checks.
  await new Promise((r) => setTimeout(r, 3 * TTL_MS));
  expect(ws.readyState).toBe(WebSocket.OPEN);

  guild.set(COEDITOR, [MEMBER_ROLE]);
  const dropped = await Promise.race([closed.then(() => true), new Promise((r) => setTimeout(() => r(false), 3 * TTL_MS))]);
  ws.close();
  expect(dropped).toBe(true);
}, 20_000);

// `import-wiki.ts --rewrite` replaces an imported page's content only if no one
// has touched it since. That rests on EmDash's revisions: an import (create,
// then publish) leaves one, an editor's save adds one, an unpublish drafts it.
/** EmDash's REST API as a signed-in Staff member, as the import scripts call it. */
async function staffApi() {
  guild.set(STAFF, [MEMBER_ROLE, STAFF_ROLE]);
  const staff = (await signIn(STAFF)).cookie;
  return async <T,>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${SITE}/_emdash/api${path}`, {
      method,
      headers: { cookie: staff, "content-type": "application/json", "X-EmDash-Request": "1", Origin: SITE },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(res.ok, `${method} ${path}: ${res.status}`).toBe(true);
    return ((await res.json()) as { data: T }).data;
  };
}
const text = (t: string, key = "b") => [
  { _type: "block", _key: key, style: "normal", markDefs: [], children: [{ _type: "span", _key: "s", text: t, marks: [] }] },
];

test("wiki rewrite: an untouched import may be rewritten; an edited or unpublished page may not", async () => {
  const api = await staffApi();
  const imported = async (slug: string) => {
    const { item } = await api<{ item: { id: string } }>("POST", "/content/pages", {
      slug,
      createdAt: "2025-01-01T00:00:00.000Z",
      data: { title: "Imported", content: text("as imported") },
    });
    await api("POST", `/content/pages/${item.id}/publish`, { publishedAt: "2025-01-01T00:00:00.000Z" });
    return item.id;
  };
  const verdict = async (id: string) => {
    const { item } = await api<{ item: { status: string } }>("GET", `/content/pages/${id}`);
    const { total } = await api<{ total: number }>("GET", `/content/pages/${id}/revisions?limit=1`);
    return editedSinceImport({ revisions: total, status: item.status, supportsRevisions: true });
  };

  const untouched = await imported("wiki/untouched");
  expect(await verdict(untouched)).toBeNull();

  const edited = await imported("wiki/edited");
  await api("PUT", `/content/pages/${edited}`, { data: { content: text("an editor's words") } });
  expect(await verdict(edited)).not.toBeNull();

  const unpublished = await imported("wiki/unpublished");
  await api("POST", `/content/pages/${unpublished}/unpublish`);
  expect(await verdict(unpublished)).not.toBeNull();
}, 15_000);

// `--rewrite --stage` fills the draft stubs the import made for pages the wiki
// linked but never had. A stub an editor has since written in is theirs.
test("wiki stage: an untouched stub may be filled; a stub an editor wrote in may not", async () => {
  const api = await staffApi();
  // As import-wiki.ts makes a stub: created, never published.
  const stub = async (slug: string) => {
    const { item } = await api<{ item: { id: string } }>("POST", "/content/pages", {
      data: { title: "Stub", content: text("This page is still to be written.", "stub") },
      slug,
    });
    return item.id;
  };
  const verdict = async (id: string) => {
    const { item } = await api<{ item: { status: string; data?: { content?: unknown } } }>("GET", `/content/pages/${id}`);
    const { total } = await api<{ total: number }>("GET", `/content/pages/${id}/revisions?limit=1`);
    return editedSinceImport({ revisions: total, status: item.status, supportsRevisions: true, stage: true, content: item.data?.content });
  };

  expect(await verdict(await stub("wiki/stub-untouched"))).toBeNull();

  const written = await stub("wiki/stub-written");
  await api("PUT", `/content/pages/${written}`, { data: { content: text("an editor's words") } });
  expect(await verdict(written)).not.toBeNull();

  // An editor who saves the stub text back unchanged still made a revision.
  const resaved = await stub("wiki/stub-resaved");
  await api("PUT", `/content/pages/${resaved}`, { data: { content: text("This page is still to be written.", "stub") } });
  expect(await verdict(resaved)).not.toBeNull();
}, 15_000);

// Community drafts go in with `import-wiki.ts --stage` for Staff to review: a
// page that is live must stay exactly as it is until Staff publish the draft.
test("wiki stage: the importer publishes no page, leaves the live one as it was, and kinds its works", async () => {
  const api = await staffApi();
  const cookie = (await signIn(STAFF)).cookie;
  await fetch(`${SITE}/_emdash/api/auth/me`, { headers: { cookie } }); // a first CMS visit makes the editor
  type Item = { id: string; status: string; liveRevisionId: string | null; draftRevisionId: string | null };
  const page = async (id: string) => (await api<{ item: Item }>("GET", `/content/pages/${id}`)).item;

  const { item: live } = await api<{ item: { id: string } }>("POST", "/content/pages", {
    slug: "staged/live",
    data: { title: "Live", content: text("what members read today") },
  });
  await api("POST", `/content/pages/${live.id}/publish`);
  const before = await page(live.id);
  const { item: stub } = await api<{ item: { id: string } }>("POST", "/content/pages", {
    slug: "staged/stub",
    data: { title: "Stub", content: text("This page is still to be written.", "stub") },
  });

  const dir = mkdtempSync(join(tmpdir(), "staged-export-"));
  const write = (path: string, kind: string, body: string) => {
    mkdirSync(join(dir, "pages", path, ".."), { recursive: true });
    const head = [`title: "${path}"`, `path: "${path}"`, `created: "2026-11-18T00:00:00.000Z"`, `kind: "${kind}"`].join("\n");
    writeFileSync(join(dir, "pages", `${path}.md`), `---\n${head}\n---\n\n# ${path}\n\n${body}\n`);
  };
  const films = "| Film |\n|---|\n| Galaxy Quest by Dean Parisot |\n";
  write("staged/live", "movie", `A community draft.\n\n${films}`);
  write("staged/stub", "movie", "A filled stub.");
  write("staged/new", "movie", films);
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, ["scripts/import-wiki.ts", "--site", SITE, "--export", dir, "--stage", "--allow-missing-draft", ...args], {
      cwd: SITE_DIR,
      env: { ...prodEnv, SITE_COOKIE: cookie },
    });
  try {
    await run();
    await run("--rewrite", "staged/live", "--rewrite", "staged/stub");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const after = await page(live.id);
  expect(after.status).toBe("published");
  expect(after.liveRevisionId).toBe(before.liveRevisionId);
  expect(after.draftRevisionId).not.toBeNull(); // the draft waits for Staff
  expect(after.draftRevisionId).not.toBe(after.liveRevisionId);
  const filled = await page(stub.id);
  expect(filled.status).toBe("draft");
  expect(filled.draftRevisionId).not.toBeNull();
  const { items } = await api<{ items: { slug: string; status: string }[] }>("GET", "/content/pages?limit=100");
  expect(items.find((p) => p.slug === "staged/new")?.status).toBe("draft");

  const { items: works } = await api<{ items: { id: string; data: { title: string } }[] }>("GET", "/content/works?limit=100");
  const film = works.find((w) => w.data.title === "Galaxy Quest")!;
  const { terms } = await api<{ terms: { label: string }[] }>("GET", `/content/works/${film.id}/terms/work_kind`);
  expect(terms.map((t) => t.label)).toEqual(["Movie"]);
}, 60_000);

// `/` is public, so the middleware never rechecks membership there: a signed-in
// former Member reaches it with a live session, as a Viewer does without one.
test("the landing page shows no members-only content to a Viewer or to a signed-in former Member", async () => {
  const FORMER = "900000000000000016";
  const api = await staffApi();
  const { item } = await api<{ item: { id: string } }>("POST", "/content/pages", { slug: "zqxguides/home", data: { title: "zqxguidesectionqz", content: [] } });
  await api("POST", `/content/pages/${item.id}/publish`);
  guild.set(FORMER, [MEMBER_ROLE]);
  displayNames.set(FORMER, "Former Dad");
  const { cookie } = await signIn(FORMER);
  displayNames.delete(FORMER);
  // While a Member, their home has both.
  const home = await (await at("/members", cookie)).text();
  expect(home).toContain(BOOK_NIGHT);
  expect(home).toContain("zqxguidesectionqz");

  guild.set(FORMER, []);
  await new Promise((r) => setTimeout(r, TTL_MS + 100));
  for (const [who, c] of [["former Member", cookie], ["Viewer", ""]]) {
    const res = await at("/", c);
    expect(res.status, who).toBe(200);
    const body = await res.text();
    expect(body, who).not.toContain(BOOK_NIGHT);
    expect(body, who).not.toContain("zqxguidesectionqz");
    // Signed in all the same: the page names them.
    expect(body.includes("Former Dad"), who).toBe(who === "former Member");
  }
});

test("a Member's home shows what's coming up from the snapshot, and none of it once the snapshot is stale", async () => {
  guild.set(MEMBER, [MEMBER_ROLE]);
  const { cookie } = await signIn(MEMBER);
  expect(await (await at("/members", cookie)).text()).toContain(BOOK_NIGHT);

  // The same snapshot, two scheduled syncs and more behind: an event its
  // organiser withdrew since could still be in it.
  const stale = mkdtempSync(join(tmpdir(), "site-gate-stale-"));
  writeFileSync(join(stale, "catalog-snapshot.json"), snapshot(Date.now() - 2 * DAY));
  const port = await freePort();
  const child = await serve(port, { ...ENV, SITE_SNAPSHOT_PATH: join(stale, "catalog-snapshot.json") });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/members`, { redirect: "manual", headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    // The snapshot was accepted, as stale: not merely missing.
    expect(body).toContain("Events are hidden for now");
    expect(body).not.toContain(BOOK_NIGHT);
  } finally {
    child.kill();
    rmSync(stale, { recursive: true, force: true });
  }
}, 20_000);
