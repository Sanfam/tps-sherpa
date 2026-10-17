// Q1 end to end: Discord sign-in against the mock, on a fresh database.
// Usage: node test-auth.mjs   (from this directory; needs ./site built)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { fixture, startMock } from "./mock-discord.mjs";

const SITE = "http://127.0.0.1:4323";
const MOCK = "http://127.0.0.1:4399";
const DB = "./site/data/site.db";
const STAFF = "200000000000000001";
const CLUB_LEAD = "200000000000000002";
const MEMBER = "200000000000000003"; // a role with no editor mapping

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

// Fixture people. Fake snowflakes only.
const S = "900000000000000001"; // Staff
const L = "900000000000000002"; // Club Lead
const M = "900000000000000003"; // Member, no editor role
const O = "900000000000000004"; // not in the guild
const V = "900000000000000005"; // roles change between sign-ins
fixture(S, "fixture-staff", [MEMBER, STAFF]);
fixture(L, "fixture-lead", [MEMBER, CLUB_LEAD]);
fixture(M, "fixture-member", [MEMBER]);
fixture(O, "fixture-outsider", null);
fixture(V, "fixture-mover", [MEMBER, CLUB_LEAD]);

const mock = await startMock(4399);
const site = spawn("node", ["./dist/server/entry.mjs"], {
	cwd: "./site",
	env: {
		...process.env,
		PORT: "4323",
		HOST: "127.0.0.1",
		DISCORD_API_BASE: MOCK,
		DISCORD_CLIENT_ID: "spike-client",
		DISCORD_CLIENT_SECRET: "spike-secret",
		DISCORD_BOT_TOKEN: "spike-bot-token",
	},
	stdio: ["ignore", "inherit", "inherit"],
});

const db = () => new DatabaseSync(DB, { readOnly: true });
const userFor = (id) =>
	db()
		.prepare(
			"select u.id, u.role from users u join oauth_accounts a on a.user_id = u.id where a.provider = 'discord' and a.provider_account_id = ?",
		)
		.get(id);
const userCount = () => db().prepare("select count(*) n from users").get().n;

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const keep = (jar, res) => {
	for (const c of res.headers.getSetCookie()) {
		const [pair] = c.split(";");
		const i = pair.indexOf("=");
		jar.set(pair.slice(0, i), pair.slice(i + 1));
	}
};

/** One full sign-in. Returns where the callback sent the browser, and the cookie jar. */
async function signIn(id) {
	await fetch(`${MOCK}/_mock/as`, { method: "POST", body: JSON.stringify({ id }) });
	const jar = new Map();
	let res = await fetch(`${SITE}/_emdash/api/auth/discord/login`, { redirect: "manual" });
	keep(jar, res);
	res = await fetch(res.headers.get("location"), { redirect: "manual" }); // the mock's authorize
	res = await fetch(res.headers.get("location"), {
		redirect: "manual",
		headers: { cookie: cookieHeader(jar) },
	});
	keep(jar, res);
	return { location: res.headers.get("location"), jar };
}

const api = (jar, method, path, body) =>
	fetch(`${SITE}/_emdash/api${path}`, {
		method,
		headers: {
			cookie: cookieHeader(jar),
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
		},
		body: body && JSON.stringify(body),
	});

try {
	for (let i = 0; ; i++) {
		try {
			if ((await fetch(`${SITE}/_emdash/api/health`)).ok) break;
		} catch {}
		if (i > 100) throw new Error("site did not start");
		await new Promise((r) => setTimeout(r, 200));
	}

	// Setup: the first sign-in must be Staff, and becomes Admin.
	const staff = await signIn(S);
	assert.equal(staff.location, "/_emdash/admin");
	assert.equal(userFor(S).role, 50);
	console.log("ok  Staff signs in first, completes setup, gets Admin (50)");

	// 1. A person not in the guild: rejected, and no row.
	const before = userCount();
	const outsider = await signIn(O);
	assert.match(outsider.location, /error=not_in_guild/);
	assert.equal(userFor(O), undefined);
	assert.equal(userCount(), before);
	console.log("ok  not in the guild: rejected, no user row");

	// 2. A Member without an editor role: rejected, and no row.
	const member = await signIn(M);
	assert.match(member.location, /error=no_editor_role/);
	assert.equal(userFor(M), undefined);
	assert.equal(userCount(), before);
	console.log("ok  Member without an editor role: rejected, no user row");

	// 3. Role changes between sign-ins: Author -> Admin -> demoted.
	assert.equal((await signIn(V)).location, "/_emdash/admin");
	assert.equal(userFor(V).role, 30);
	await fetch(`${MOCK}/_mock/roles`, { method: "POST", body: JSON.stringify({ id: V, roles: [MEMBER, STAFF] }) });
	const promoted = await signIn(V);
	assert.equal(promoted.location, "/_emdash/admin");
	assert.equal(userFor(V).role, 50);
	console.log("ok  promotion: Club Lead (30) -> Staff (50) on the next sign-in");
	await fetch(`${MOCK}/_mock/roles`, { method: "POST", body: JSON.stringify({ id: V, roles: [MEMBER] }) });
	const demoted = await signIn(V);
	assert.match(demoted.location, /error=no_editor_role/);
	assert.equal(userFor(V).role, 10);
	console.log("ok  demotion: editor role removed -> sign-in rejected, row set to Subscriber (10)");
	// The session from the promoted sign-in now carries the demoted role.
	const me = await (await api(promoted.jar, "GET", "/auth/me")).json();
	console.log(`    the earlier session's /auth/me now reports role ${JSON.stringify(me.data?.role ?? me)}`);
	const staleWrite = await api(promoted.jar, "POST", "/content/posts", { data: { title: "stale" } });
	assert.equal(staleWrite.status, 403);
	console.log("ok  that earlier session can no longer create content (403)");

	// 4. An Author edits only their own entries.
	const staffPost = await api(staff.jar, "POST", "/content/posts", { data: { title: "Staff post" } });
	assert.equal(staffPost.status, 201, await staffPost.clone().text());
	const staffId = (await staffPost.json()).data.item.id;
	const lead = await signIn(L);
	assert.equal(userFor(L).role, 30);
	const leadPost = await api(lead.jar, "POST", "/content/posts", { data: { title: "Club page" } });
	assert.equal(leadPost.status, 201, await leadPost.clone().text());
	const leadId = (await leadPost.json()).data.item.id;
	const ownEdit = await api(lead.jar, "PUT", `/content/posts/${leadId}`, { data: { title: "Club page, edited" } });
	assert.equal(ownEdit.status, 200, await ownEdit.clone().text());
	const otherEdit = await api(lead.jar, "PUT", `/content/posts/${staffId}`, { data: { title: "hijack" } });
	assert.equal(otherEdit.status, 403);
	const steal = await api(lead.jar, "PUT", `/content/posts/${leadId}`, { authorId: userFor(S).id });
	const stolenOwner = db().prepare("select author_id from ec_posts where id = ?").get(leadId).author_id;
	assert.equal(stolenOwner, userFor(L).id);
	console.log(`ok  Author edits own entry (200), not Staff's (403); authorId change ignored (status ${steal.status}, owner unchanged)`);

	// Scope: every authorize request asked for `identify` and nothing else.
	const log = await (await fetch(`${MOCK}/_mock/log`)).json();
	const scopes = new Set(log.filter((r) => r.path === "/oauth2/authorize").map((r) => new URLSearchParams(r.query).get("scope")));
	assert.deepEqual([...scopes], ["identify"]);
	console.log(`ok  every authorize request asked for scope "identify" only (${log.filter((r) => r.path === "/oauth2/authorize").length} requests)`);

	// Revisions: who wrote them.
	const revs = db().prepare("select entry_id, author_id from revisions where entry_id = ?").all(leadId);
	console.log(`    revisions of the Club Lead's entry: ${revs.length}, authors ${JSON.stringify([...new Set(revs.map((r) => r.author_id === userFor(L).id ? "Club Lead" : r.author_id))])}`);
	console.log("ALL PASSED");
} finally {
	site.kill();
	mock.close();
}
