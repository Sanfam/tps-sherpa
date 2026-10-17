/**
 * Registers `/find`, `/lately`, `/privacy` and `/monitored` in the guild — guild-scoped, so a
 * change is live at once and the commands exist nowhere else. serve.ts runs
 * this at every startup.
 *
 *   node --env-file=.env src/sherpa/register.ts --dry-run   print, touch nothing
 *   node --env-file=.env src/sherpa/register.ts             overwrite the guild's commands
 *
 * A bulk overwrite: the guild's command list becomes exactly these four.
 * Re-run after a vocabulary change, since `/lately`'s Topic choices are baked
 * into the definition.
 */
import { API } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { VOCABULARY_PATH, flag, readIfPresent } from "../llm/session.ts";
import { parseVocabulary } from "../llm/vocabulary.ts";
import { commandDefinitions } from "./interactions.ts";

const commands = commandDefinitions(parseVocabulary(readIfPresent(VOCABULARY_PATH)));

if (flag("dry-run") !== null) {
  console.log(JSON.stringify(commands, null, 2));
  process.exit(0);
}

const token = process.env["DISCORD_BOT_TOKEN"];
const guildId = process.env["DISCORD_GUILD_ID"];
if (!token || !guildId) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must both be set.");
  process.exit(1);
}

const api = new API(new REST({ version: "10" }).setToken(token));
const application = await api.applications.getCurrent();
const registered = await api.applicationCommands.bulkOverwriteGuildCommands(
  application.id,
  guildId,
  commands,
);
console.log(`Registered in the guild: ${registered.map((c) => `/${c.name}`).join(", ")}`);
