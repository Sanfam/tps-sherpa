import node from "@astrojs/node";
import { defineConfig, fontProviders } from "astro/config";

// Behind Railway's TLS proxy the request arrives as http. Astro trusts the
// forwarded proto and host only for these domains; without them its origin
// check rejects the https POST to /auth/sign-out. Read at build time.
const site = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL) : undefined;

// Everything is server-rendered unless a page opts in with `prerender = true`,
// and only the public landing page may (test/gate.test.ts holds that line).
export default defineConfig({
  output: "server",
  // Absolute URLs for link-preview cards.
  site: site?.origin,
  adapter: node({ mode: "standalone" }),
  // The Clubhouse theme's two faces, downloaded at build and self-hosted.
  fonts: [
    {
      provider: fontProviders.google(),
      name: "Bricolage Grotesque",
      cssVariable: "--font-display",
      weights: [600, 800],
      fallbacks: ["sans-serif"],
    },
    {
      provider: fontProviders.google(),
      name: "Atkinson Hyperlegible Next",
      cssVariable: "--font-body",
      weights: [400, 700],
      styles: ["normal", "italic"],
      fallbacks: ["sans-serif"],
    },
  ],
  security: {
    allowedDomains: site
      ? [{ hostname: site.hostname, protocol: site.protocol.slice(0, -1), ...(site.port && { port: site.port }) }]
      : [],
  },
});
