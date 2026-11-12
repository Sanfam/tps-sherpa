// A small stand-in for Discord's OAuth and REST API, after the 2026-10-16
// EmDash spike's mock. Fixture people only: fake snowflakes, no real
// accounts, tokens or member data.
//
// GET  /oauth2/authorize       -> 302 back with a code for `signInAs`
// POST /oauth2/token           -> an access token for that code
// GET  /users/@me              -> the profile for the Bearer token
// GET  /guilds/{g}/members/{u} -> 200 { roles } or 404; needs "Bot <token>"
import http from "node:http";
import type { AddressInfo } from "node:net";

export const GUILD_ID = "100000000000000001";
export const BOT_TOKEN = "mock-bot-token";

/** Guild roles by snowflake; absent means not in the guild. Tests edit it. */
export const guild = new Map<string, string[]>();
export const mock = { signInAs: "", memberLookups: 0 };

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export async function startMock() {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname.replace(/^\/api(\/v\d+)?/, "");

    if (path === "/oauth2/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", `code-${mock.signInAs}`);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (path === "/oauth2/token" && req.method === "POST") {
      const id = new URLSearchParams(body).get("code")?.replace(/^code-/, "");
      return json(res, 200, { access_token: `tok-${id}`, token_type: "Bearer", expires_in: 604800, scope: "identify" });
    }
    if (path === "/users/@me") {
      const id = req.headers.authorization?.replace(/^Bearer tok-/, "");
      return json(res, 200, { id, username: `fixture-${id}`, global_name: null });
    }
    const m = path.match(/^\/guilds\/(\d+)\/members\/(\d+)$/);
    if (m) {
      mock.memberLookups++;
      if (req.headers.authorization !== `Bot ${BOT_TOKEN}`) return json(res, 401, { message: "401: Unauthorized" });
      const roles = m[1] === GUILD_ID ? guild.get(m[2]!) : undefined;
      if (!roles) return json(res, 404, { message: "Unknown Member", code: 10007 });
      return json(res, 200, { user: { id: m[2] }, roles });
    }
    json(res, 404, { message: "404: Not Found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
