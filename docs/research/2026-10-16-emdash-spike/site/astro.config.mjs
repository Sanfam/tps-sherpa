import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

import { discord } from "@spike/auth-discord";

import { GUILD_ID, ROLE_MAP } from "./src/roles.ts";

// SPIKE_AUTH=external builds the second spike into dist-ext: EmDash in
// external-auth mode, identity from the site session. Otherwise the first
// spike: our AuthProviderDescriptor alongside EmDash's built-in sign-in.
const external = process.env.SPIKE_AUTH === "external";

export default defineConfig({
	output: "server",
	outDir: external ? "./dist-ext" : "./dist",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			// The second spike swaps in a dialect that turns secure_delete on;
			// SPIKE_SECURE_DELETE=0 builds without it, to show the check bites.
			database:
				external && process.env.SPIKE_SECURE_DELETE !== "0"
					? { ...sqlite({ url: "file:./data/site.db" }), entrypoint: "@spike/auth-discord/secure-sqlite" }
					: sqlite({ url: "file:./data/site.db" }),
			storage: local({ directory: "./data/uploads", baseUrl: "/_emdash/api/media/file" }),
			...(external
				? {
						auth: {
							type: "discord-site-session",
							entrypoint: "@spike/auth-discord/external",
							config: { guildId: GUILD_ID, roleMap: ROLE_MAP, syncRoles: true },
						},
						middleware: { outer: "./src/outer-ext.ts" },
					}
				: {
						authProviders: [discord({ guildId: GUILD_ID, roleMap: ROLE_MAP })],
						middleware: { outer: "./src/outer.ts" },
					}),
		}),
	],
});
