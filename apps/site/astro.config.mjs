import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// Behind Railway's TLS proxy the request arrives as http. Astro trusts the
// forwarded proto and host only for these domains; without them its origin
// check rejects the https POST to /auth/sign-out. Read at build time.
const site = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL) : undefined;

// Everything is server-rendered unless a page opts in with `prerender = true`,
// and only the public landing page may (test/gate.test.ts holds that line).
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  security: {
    allowedDomains: site
      ? [{ hostname: site.hostname, protocol: site.protocol.slice(0, -1), ...(site.port && { port: site.port }) }]
      : [],
  },
});
