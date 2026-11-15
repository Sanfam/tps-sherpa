import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { fileURLToPath } from "node:url";

// Behind Railway's TLS proxy the request arrives as http. Astro trusts the
// forwarded proto and host only for these domains; without them its origin
// check rejects the https POST to /auth/sign-out. Read at build time.
const site = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL) : undefined;

// EmDash's database and uploads sit beside the session database, on the
// volume mounted at .data. Read at build time.
const data = process.env.SITE_EMDASH_DIR ?? "./.data";

// Everything is server-rendered unless a page opts in with `prerender = true`,
// and only the public landing page may (test/gate.test.ts holds that line).
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [
    react(),
    emdash({
      database: sqlite({ url: `file:${data}/emdash.db` }),
      // ponytail: uploads on the volume, outside Litestream; R2 is step 5 of the trial.
      storage: local({ directory: `${data}/uploads`, baseUrl: "/_emdash/api/media/file" }),
      // External-auth mode: the site's Discord session is the only way in, and
      // EmDash's own sign-in routes are not injected (ADR-0002).
      auth: {
        type: "discord-site-session",
        entrypoint: fileURLToPath(new URL("./src/emdash-auth.ts", import.meta.url)),
        config: { syncRoles: true },
      },
    }),
  ],
  security: {
    allowedDomains: site
      ? [{ hostname: site.hostname, protocol: site.protocol.slice(0, -1), ...(site.port && { port: site.port }) }]
      : [],
  },
});
