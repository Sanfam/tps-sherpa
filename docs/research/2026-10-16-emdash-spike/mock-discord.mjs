// A tiny stand-in for Discord's OAuth and REST API. Fixture people only:
// fake snowflakes, no real accounts, tokens or member data.
//
// GET  /oauth2/authorize          -> 302 back with code=<fixture id>, as the person
//                                    chosen by POST /_mock/as
// POST /oauth2/token              -> access token for that code; scope echoed
// GET  /users/@me                 -> fixture profile for the Bearer token
// GET  /guilds/{g}/members/{u}    -> 200 { roles } or 404; needs "Bot <token>"
// POST /_mock/as      { id }      -> who the next authorize signs in as
// POST /_mock/roles   { id, roles|null } -> set a person's roles; null = not in guild
// GET  /_mock/log                 -> every request seen, for scope assertions
import { createHash } from "node:crypto";
import http from "node:http";

export const GUILD_ID = "100000000000000001";
const BOT_TOKEN = "spike-bot-token";

const people = new Map(); // id -> { username }
const roles = new Map(); // id -> string[] (absent = not in the guild)
let signInAs = null;
const challenges = new Map(); // code -> PKCE challenge
const log = [];

export function fixture(id, username, memberRoles) {
	people.set(id, { username });
	if (memberRoles) roles.set(id, memberRoles);
	else roles.delete(id);
}

const json = (res, status, body) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
};
const readBody = async (req) => {
	let s = "";
	for await (const c of req) s += c;
	return s;
};

export function startMock(port) {
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, `http://127.0.0.1:${port}`);
		const body = await readBody(req);
		log.push({ method: req.method, path: url.pathname, query: url.search, body });

		if (url.pathname === "/_mock/as") {
			signInAs = JSON.parse(body).id;
			return json(res, 200, {});
		}
		if (url.pathname === "/_mock/roles") {
			const { id, roles: r } = JSON.parse(body);
			if (r) roles.set(id, r);
			else roles.delete(id);
			return json(res, 200, {});
		}
		if (url.pathname === "/_mock/log") return json(res, 200, log);

		if (url.pathname === "/oauth2/authorize") {
			challenges.set(`code-${signInAs}`, url.searchParams.get("code_challenge"));
			const back = new URL(url.searchParams.get("redirect_uri"));
			back.searchParams.set("code", `code-${signInAs}`);
			back.searchParams.set("state", url.searchParams.get("state"));
			res.writeHead(302, { Location: back.toString() });
			return res.end();
		}
		if (url.pathname === "/oauth2/token" && req.method === "POST") {
			const form = new URLSearchParams(body);
			const id = form.get("code")?.replace(/^code-/, "");
			if (!people.has(id)) return json(res, 400, { error: "invalid_grant" });
			// PKCE, when the authorize request carried a challenge.
			const challenge = challenges.get(form.get("code"));
			const verifier = form.get("code_verifier");
			if (
				challenge &&
				(!verifier || createHash("sha256").update(verifier).digest("base64url") !== challenge)
			) {
				return json(res, 400, { error: "invalid_grant", error_description: "PKCE" });
			}
			return json(res, 200, {
				access_token: `tok-${id}`,
				token_type: "Bearer",
				expires_in: 604800,
				scope: "identify",
			});
		}
		if (url.pathname === "/users/@me") {
			const id = req.headers.authorization?.replace(/^Bearer tok-/, "");
			const p = people.get(id);
			if (!p) return json(res, 401, { message: "401: Unauthorized" });
			return json(res, 200, { id, username: p.username, global_name: null });
		}
		const m = url.pathname.match(/^\/guilds\/(\d+)\/members\/(\d+)$/);
		if (m) {
			if (req.headers.authorization !== `Bot ${BOT_TOKEN}`) {
				return json(res, 401, { message: "401: Unauthorized" });
			}
			if (m[1] !== GUILD_ID || !roles.has(m[2])) {
				return json(res, 404, { message: "Unknown Member", code: 10007 });
			}
			return json(res, 200, { user: { id: m[2], username: people.get(m[2])?.username }, roles: roles.get(m[2]) });
		}
		json(res, 404, { message: "404: Not Found" });
	});
	return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}
