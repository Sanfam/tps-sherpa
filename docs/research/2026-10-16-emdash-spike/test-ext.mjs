// Part B: EmDash in external-auth mode, identity and role from the site's own
// Discord session, re-checked with the bot token on every CMS request.
// Usage: node test-ext.mjs   (needs site/dist-ext from SPIKE_AUTH=external astro build)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { fixture, startMock } from "./mock-discord.mjs";

const SITE = "http://127.0.0.1:4326";
const MOCK = "http://127.0.0.1:4399";
const DB = "./site/data/site.db";
const STAFF = "200000000000000001";
const CLUB_LEAD = "200000000000000002";
const MEMBER = "200000000000000003";

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

const S = "900000000000000001"; // Staff
const L = "900000000000000002"; // Club Lead
const M = "900000000000000003"; // Member, no editor role
const O = "900000000000000004"; // not in the guild
const V = "900000000000000005"; // roles change while signed in
fixture(S, "fixture-staff", [MEMBER, STAFF]);
fixture(L, "fixture-lead", [MEMBER, CLUB_LEAD]);
fixture(M, "fixture-member", [MEMBER]);
fixture(O, "fixture-outsider", null);
fixture(V, "fixture-mover", [MEMBER, CLUB_LEAD]);
const setRoles = (id, roles) =>
	fetch(`${MOCK}/_mock/roles`, { method: "POST", body: JSON.stringify({ id, roles }) });

const mock = await startMock(4399);
const site = spawn("node", ["./dist-ext/server/entry.mjs"], {
	cwd: "./site",
	env: {
		...process.env,
		PORT: "4326",
		HOST: "127.0.0.1",
		DISCORD_API_BASE: MOCK,
		DISCORD_CLIENT_ID: "spike-client",
		DISCORD_CLIENT_SECRET: "spike-secret",
		DISCORD_BOT_TOKEN: "spike-bot-token",
		SITE_SESSION_SECRET: "spike-only-not-a-real-secret",
		EMDASH_SITE_URL: SITE,
	},
	stdio: ["ignore", "ignore", "inherit"],
});

const db = () => new DatabaseSync(DB, { readOnly: true });
const userByDiscord = (id) =>
	db().prepare("select * from users where email = ?").get(`${id}@discord.invalid`);
const count = (table) => db().prepare(`select count(*) n from ${table}`).get().n;

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const keep = (jar, res) => {
	for (const c of res.headers.getSetCookie()) {
		const [pair] = c.split(";");
		const i = pair.indexOf("=");
		const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
		if (v === "" || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) jar.delete(k);
		else jar.set(k, v);
	}
};

/** The site's Discord sign-in. Returns where the callback sent the browser, and the jar. */
async function signIn(id) {
	await fetch(`${MOCK}/_mock/as`, { method: "POST", body: JSON.stringify({ id }) });
	const jar = new Map();
	let res = await fetch(`${SITE}/auth/discord/start`, { redirect: "manual" });
	keep(jar, res);
	res = await fetch(res.headers.get("location"), { redirect: "manual" });
	const callback = res.headers.get("location");
	res = await fetch(callback, { redirect: "manual", headers: { cookie: cookieHeader(jar) } });
	keep(jar, res);
	return { location: res.headers.get("location"), jar, callback };
}

const req = (jar, method, path, body) =>
	fetch(`${SITE}${path}`, {
		method,
		redirect: "manual",
		headers: {
			cookie: cookieHeader(jar),
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
			Origin: SITE,
		},
		body: body && JSON.stringify(body),
	});
const role = async (jar) => {
	const res = await req(jar, "GET", "/_emdash/api/auth/me");
	return res.ok ? (await res.json()).data.role : res.status;
};

const results = [];
const check = (name, fn) => results.push([name, fn]);

try {
	for (let i = 0; ; i++) {
		try {
			if ((await fetch(`${SITE}/_emdash/api/health`)).ok) break;
		} catch {}
		if (i > 100) throw new Error("site did not start");
		await new Promise((r) => setTimeout(r, 200));
	}

	// B4. Rejections at the site's own sign-in: no session cookie, so EmDash never sees them.
	const outsider = await signIn(O);
	assert.match(outsider.location, /signin=not_in_guild/);
	assert.equal(outsider.jar.has("site_session"), false);
	const member = await signIn(M);
	assert.match(member.location, /signin=no_editor_role/);
	assert.equal(member.jar.has("site_session"), false);
	const forged = new Map([["site_session", `${O}.${Math.floor(Date.now() / 1000)}.forged`]]);
	assert.equal(await role(forged), 401);
	assert.equal(count("users"), 0);
	console.log("ok  B4 not in guild / no editor role / forged cookie: no session, 401, zero user rows");

	// B10. Login CSRF: a callback URL replayed in a browser that did not start the flow.
	const stolen = await signIn(S);
	const replay = await fetch(stolen.callback, { redirect: "manual" });
	assert.match(replay.headers.get("location"), /signin=invalid_state/);
	assert.equal(replay.headers.getSetCookie().some((c) => c.startsWith("site_session=")), false);
	console.log("ok  B10 callback replayed without the browser's state cookie: rejected, no session");

	// B9. Scope and PKCE, from the mock's log.
	const log = await (await fetch(`${MOCK}/_mock/log`)).json();
	const authz = log.filter((r) => r.path === "/oauth2/authorize").map((r) => new URLSearchParams(r.query));
	assert.ok(authz.length >= 3);
	assert.ok(authz.every((q) => q.get("scope") === "identify" && q.get("code_challenge_method") === "S256"));
	assert.ok(log.filter((r) => r.path === "/oauth2/token").every((r) => new URLSearchParams(r.body).get("code_verifier")));
	console.log(`ok  B9 ${authz.length} authorize requests: scope "identify" only, PKCE S256; every token exchange sent a verifier`);

	const staff = await signIn(S);
	const lead = await signIn(L);
	assert.equal(staff.location, "/_emdash/admin");
	assert.equal(lead.location, "/_emdash/admin");

	// B3. Setup: refused to a Club Lead by the gate; a Staff member completes it.
	const leadSetup = await req(lead.jar, "POST", "/_emdash/api/setup", { title: "x", includeContent: false });
	assert.equal(leadSetup.status, 403);
	assert.equal(leadSetup.headers.get("x-outer-mw"), "deny");
	const staffSetup = await req(staff.jar, "POST", "/_emdash/api/setup", { title: "Spike", includeContent: false });
	assert.ok(staffSetup.ok, `setup ${staffSetup.status} ${await staffSetup.clone().text()}`);
	assert.equal(count("users"), 0, "setup in external mode creates no user");
	console.log("ok  B3 setup: Club Lead refused by the gate (403); Staff completes it; no user row yet");

	// B5. EmDash makes the first external user Admin, whatever their role.
	assert.equal(await role(lead.jar), 50, "first user is provisioned as Admin");
	assert.equal(await role(lead.jar), 30, "syncRoles corrects it on the next request");
	console.log("ok  B5 HAZARD: first external user (a Club Lead) got Admin for one request, then 30 via syncRoles");
	assert.equal(await role(staff.jar), 50);

	// B1. Built-in sign-in routes are not injected in external mode.
	for (const [m, p] of [
		["POST", "/_emdash/api/auth/passkey/options"],
		["POST", "/_emdash/api/auth/passkey/register/options"],
		["POST", "/_emdash/api/auth/magic-link/send"],
		["POST", "/_emdash/api/auth/signup/request"],
		["POST", "/_emdash/api/auth/invite"],
		["GET", "/_emdash/api/auth/oauth/github"],
		["GET", "/_emdash/api/admin/allowed-domains"],
	]) {
		const res = await req(lead.jar, m, p, m === "POST" ? {} : undefined);
		assert.equal(res.status, 404, `${m} ${p} -> ${res.status}`);
		assert.notEqual(res.headers.get("x-outer-mw"), "deny", `${p} should be absent, not refused`);
	}
	console.log("ok  B1 passkey, magic-link, signup, invite, built-in OAuth, allowed-domains: 404, not injected");

	// B2. Credential routes EmDash still has, refused by the gate even for Staff.
	for (const [m, p] of [
		["POST", "/_emdash/api/oauth/device/code"],
		["POST", "/_emdash/api/oauth/device/authorize"],
		["POST", "/_emdash/api/oauth/token"],
		["POST", "/_emdash/api/oauth/register"],
		["GET", "/_emdash/oauth/authorize"],
		["POST", "/_emdash/api/admin/api-tokens"],
		["POST", "/_emdash/api/admin/oauth-clients"],
		["POST", "/_emdash/api/mcp"],
		["POST", "/_emdash/api/setup/admin"],
		["POST", "/_emdash/api/setup/dev-bypass"],
		["GET", "/.well-known/oauth-protected-resource"],
		["GET", "/.well-known/oauth-authorization-server/_emdash"],
	]) {
		const res = await req(staff.jar, m, p, m === "POST" ? {} : undefined);
		assert.equal(res.status, 404, `${m} ${p} -> ${res.status}`);
		assert.equal(res.headers.get("x-outer-mw"), "deny", `${p} should be refused by the gate`);
	}
	console.log("ok  B2 device flow, OAuth server, API tokens, OAuth clients, MCP, setup/admin: refused by the gate for Staff");

	// B6. Role re-synced per request after a Discord change, with no new sign-in.
	const mover = await signIn(V);
	assert.equal(await role(mover.jar), 30);
	await setRoles(V, [MEMBER, STAFF]);
	assert.equal(await role(mover.jar), 50);
	await setRoles(V, [MEMBER, CLUB_LEAD]);
	assert.equal(await role(mover.jar), 30);
	assert.equal(userByDiscord(V).role, 30);
	await setRoles(V, [MEMBER]);
	assert.equal(await role(mover.jar), 401);
	const create = await req(mover.jar, "POST", "/_emdash/api/content/posts", { data: { title: "stale" } });
	assert.equal(create.status, 401);
	const staleRow = userByDiscord(V).role;
	await setRoles(V, null);
	assert.equal(await role(mover.jar), 401);
	console.log(`ok  B6 same session: 30 -> 50 -> 30 as Discord roles change; editor role removed or left guild -> 401 (row keeps role ${staleRow}, unused)`);

	// B7. What EmDash keeps for an editor.
	const row = userByDiscord(L);
	assert.equal(row.email, `${L}@discord.invalid`);
	assert.equal(row.name, "fixture-lead");
	assert.equal(count("oauth_accounts"), 0);
	assert.equal(count("users"), 3);
	console.log(`ok  B7 user row: ${JSON.stringify(row)}; oauth_accounts rows: 0; users: 3 (Staff, Club Lead, mover)`);

	// B8. Own-entry scoping still applies.
	const staffPost = await req(staff.jar, "POST", "/_emdash/api/content/posts", { data: { title: "Staff post" } });
	assert.equal(staffPost.status, 201);
	const staffId = (await staffPost.json()).data.item.id;
	const leadPost = await req(lead.jar, "POST", "/_emdash/api/content/posts", { data: { title: "Club page" } });
	assert.equal(leadPost.status, 201);
	const leadId = (await leadPost.json()).data.item.id;
	assert.equal((await req(lead.jar, "PUT", `/_emdash/api/content/posts/${leadId}`, { data: { title: "edited" } })).status, 200);
	assert.equal((await req(lead.jar, "PUT", `/_emdash/api/content/posts/${staffId}`, { data: { title: "x" } })).status, 403);
	const revs = db().prepare("select author_id from revisions where entry_id = ?").all(leadId);
	assert.ok(revs.length > 0);
	assert.ok(revs.every((r) => r.author_id === userByDiscord(L).id));
	console.log(`ok  B8 Author edits own (200), not Staff's (403); ${revs.length} revision(s), all authored by the Club Lead`);

	// No session at all: admin redirects to the site sign-in, API is 401, health stays open.
	const anon = new Map();
	assert.equal((await req(anon, "GET", "/_emdash/admin")).headers.get("location"), "/auth/discord/start");
	assert.equal((await req(anon, "GET", "/_emdash/api/search?q=x")).status, 401);
	assert.equal((await req(anon, "GET", "/_emdash/api/health")).status, 200);
	console.log("ok  no session: admin -> /auth/discord/start, public search 401, health 200");

	// B11. secure_delete on EmDash's own connection, through the wrapped dialect.
	const pragma = await (await fetch(`${SITE}/api/spike-pragma`)).json();
	assert.equal(pragma.secure_delete, 1, `secure_delete on EmDash's connection is ${pragma.secure_delete}`);
	console.log("ok  B11 PRAGMA secure_delete = 1 on EmDash's own connection");

	console.log("ALL PASSED");
} finally {
	site.kill();
	mock.close();
}
