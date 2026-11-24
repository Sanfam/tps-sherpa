// A small stand-in for Discord's OAuth and REST API, after the 2026-10-16
// EmDash spike's mock. Fixture people only: fake snowflakes, no real
// accounts, tokens or member data.
//
// GET  /oauth2/authorize       -> 302 back with a code for `signInAs`; needs a
//                                 PKCE S256 challenge
// POST /oauth2/token           -> an access token for that code; needs the
//                                 challenge's verifier
// GET  /users/@me              -> the profile for the Bearer token
// GET  /guilds/{g}/members/{u} -> 200 { roles } or 404; needs "Bot <token>"
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export const GUILD_ID = "100000000000000001";
export const BOT_TOKEN = "mock-bot-token";

/** Guild roles by snowflake; absent means not in the guild. Tests edit it. */
export const guild = new Map<string, string[]>();
// `down` makes every guild member lookup fail, as in a Discord outage;
// `onLookup` runs while one is being answered.
export const mock: { signInAs: string; memberLookups: number; down: boolean; onLookup?: () => void } = {
  signInAs: "",
  memberLookups: 0,
  down: false,
};
// Discord usernames by snowflake, for a rename; `fixture-<id>` otherwise.
export const usernames = new Map<string, string>();
// Display names and avatar hashes by snowflake. Discord sends null for either
// when the person has not set one.
export const displayNames = new Map<string, string>();
export const avatars = new Map<string, string>();

/** PKCE challenge by issued code. */
const challenges = new Map<string, string>();

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
      const challenge = url.searchParams.get("code_challenge");
      if (!challenge || url.searchParams.get("code_challenge_method") !== "S256") {
        back.searchParams.set("error", "invalid_request");
      } else {
        const code = `code-${mock.signInAs}-${challenges.size}`;
        challenges.set(code, challenge);
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (path === "/oauth2/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      const expected = challenges.get(code);
      if (!expected || createHash("sha256").update(verifier).digest("base64url") !== expected) {
        return json(res, 400, { error: "invalid_grant" });
      }
      const id = code.split("-")[1];
      return json(res, 200, { access_token: `tok-${id}`, token_type: "Bearer", expires_in: 604800, scope: "identify" });
    }
    if (path === "/users/@me") {
      const id = req.headers.authorization?.replace(/^Bearer tok-/, "") ?? "";
      return json(res, 200, {
        id,
        username: usernames.get(id) ?? `fixture-${id}`,
        global_name: displayNames.get(id) ?? null,
        avatar: avatars.get(id) ?? null,
      });
    }
    const m = path.match(/^\/guilds\/(\d+)\/members\/(\d+)$/);
    if (m) {
      mock.memberLookups++;
      mock.onLookup?.();
      if (mock.down) return json(res, 500, { message: "500: Internal Server Error" });
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
