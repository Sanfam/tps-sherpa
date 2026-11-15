import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local, s3 } from "emdash/astro";
import { sqlite } from "emdash/db";
import { fileURLToPath } from "node:url";

// Behind Railway's TLS proxy the request arrives as http. Astro trusts the
// forwarded proto and host only for these domains; without them its origin
// check rejects the https POST to /auth/sign-out. Read at build time.
const site = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL) : undefined;

// EmDash's database and uploads go on the volume, beside the session
// database: SITE_EMDASH_DIR on Railway (/data). Read at build time.
const data = process.env.SITE_EMDASH_DIR || "./.data";

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
  integrations: [
    react(),
    emdash({
      // EmDash's setup refuses to run in production without a configured origin.
      siteUrl: site?.origin,
      // Astro's own image endpoint, which reads the theme's images from disk.
      // EmDash's fetches them from the site's public origin instead, and on
      // Railway that fetch fails silently, so the images break.
      // ponytail: EmDash media rendered through <Image> would break with this
      // off; nothing renders it yet. Fix the self-fetch before a page does.
      images: false,
      database: {
        ...sqlite({ url: `file:${data}/emdash.db` }),
        entrypoint: fileURLToPath(new URL("./src/emdash-db.ts", import.meta.url)),
      },
      // Uploads go to R2 when S3_BUCKET is set at build (ADR-0002); the rest of
      // its S3_* variables are read when the server starts, so no key is
      // built into the image. Without it, uploads stay on the volume, outside
      // Litestream: local development and the tests.
      // publicUrl is EmDash's own file route, so every upload is served through
      // the gate, Member-only, even if S3_PUBLIC_URL were set: an explicit value
      // wins over that variable.
      storage: process.env.S3_BUCKET
        ? s3({ publicUrl: "/_emdash/api/media/file" })
        : local({ directory: `${data}/uploads`, baseUrl: "/_emdash/api/media/file" }),
      // External-auth mode: the site's Discord session is the only way in, and
      // EmDash's own sign-in routes are not injected (ADR-0002).
      auth: {
        type: "discord-site-session",
        entrypoint: fileURLToPath(new URL("./src/emdash-auth.ts", import.meta.url)),
        config: { syncRoles: true },
      },
      // The allow-list gate on every EmDash route, ahead of all of EmDash.
      middleware: { outer: fileURLToPath(new URL("./src/emdash-gate.ts", import.meta.url)) },
    }),
  ],
  security: {
    allowedDomains: site
      ? [{ hostname: site.hostname, protocol: site.protocol.slice(0, -1), ...(site.port && { port: site.port }) }]
      : [],
  },
});
