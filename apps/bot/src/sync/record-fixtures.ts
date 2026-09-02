/**
 * Reads the live guild once and writes the raw response to disk as a fixture.
 *
 * Fixtures are recorded rather than hand-written so tests are pinned to shapes
 * Discord actually returns. Run with:
 *
 *   node --env-file=.env src/sync/record-fixtures.ts
 */
import { writeFile } from "node:fs/promises";
import { discordRest } from "./discord-adapter.ts";

const token = process.env["DISCORD_BOT_TOKEN"];
const guildId = process.env["DISCORD_GUILD_ID"];

if (!token || !guildId) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must both be set.");
  process.exit(1);
}

const discord = discordRest({ token, guildId });

const intent = await discord.hasMessageContentIntent();
const channels = await discord.listChannels();

const byType = new Map<number, number>();
for (const c of channels) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);

console.log(`Message Content intent: ${intent ? "enabled" : "NOT ENABLED"}`);
console.log(`Raw channel objects returned: ${channels.length}`);
console.log(
  "By Discord type:",
  [...byType.entries()].sort((a, b) => a[0] - b[0]),
);

await writeFile(
  new URL("./__fixtures__/guild-channels.json", import.meta.url),
  JSON.stringify(channels, null, 2) + "\n",
);
console.log("Recorded fixture: __fixtures__/guild-channels.json");
