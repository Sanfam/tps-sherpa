import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads its whole module graph as the deployed bot does, before reading the environment", () => {
  // Vitest loads modules in another order, so an import cycle read at load time passes every other test.
  const env = { ...process.env };
  delete env["DISCORD_BOT_TOKEN"];
  delete env["DISCORD_GUILD_ID"];
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./run.ts", import.meta.url))], { env, encoding: "utf8" });
  expect(run.stderr).toContain("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must both be set.");
});
