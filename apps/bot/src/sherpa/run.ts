/**
 * Papa Sherpa's long-running process: a gateway connection that answers
 * `/find`, `/lately` and `/privacy`.
 *
 *   node --env-file=.env src/sherpa/run.ts
 *
 * Register the commands first (register.ts; serve.ts does it at startup). The
 * Catalog, the role manifest, activity summaries and privacy settings are read
 * from disk on every command, so a sync or an enrichment
 * run takes effect without a restart.
 *
 * `Guilds` is the only intent. Slash commands arrive regardless of intents,
 * and Sherpa reads no messages over the gateway — no GuildMessages, no
 * MessageContent.
 */
import { resolve } from "node:path";
import { Client } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { GatewayDispatchEvents, GatewayIntentBits } from "discord-api-types/v10";
import {
  ACTIVITY_PATH,
  DATA_DIR,
  PRIVACY_POLICY_PATH,
  VOCABULARY_PATH,
  loadCatalog,
  loadRoleManifest,
  openBoundary,
  readActivity,
  readIfPresent,
  retrying,
} from "../llm/session.ts";
import { parseVocabulary } from "../llm/vocabulary.ts";
import { DURABLE_STORE_PATH } from "../sync/durable-store.ts";
import { TIER0_PATH } from "../sync/tier0-store.ts";
import { FIND_TIMEOUT_MS } from "./find.ts";
import { dailyCap, findDailyCap, handleInteraction, type Sherpa } from "./interactions.ts";
import { openPrivacy } from "./privacy.ts";

const token = process.env["DISCORD_BOT_TOKEN"];
const guildId = process.env["DISCORD_GUILD_ID"];
if (!token || !guildId) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must both be set.");
  process.exit(1);
}

const log = (m: string) => console.log(m);
const limit = findDailyCap(process.env["SHERPA_FIND_DAILY_CAP"]);

const sherpa: Sherpa = {
  guildId,
  loadCatalog,
  loadRoleManifest,
  loadVocabulary: () => parseVocabulary(readIfPresent(VOCABULARY_PATH)),
  loadActivity: () => readActivity(),
  privacy: openPrivacy({
    durable: DURABLE_STORE_PATH,
    tier0: TIER0_PATH,
    activity: ACTIVITY_PATH,
    policy: PRIVACY_POLICY_PATH,
  }),
  askFor: (catalog) => openBoundary(catalog, {}, FIND_TIMEOUT_MS).boundary.ask,
  retrying: (work) => retrying(work, log),
  cap: dailyCap(resolve(DATA_DIR, "find-usage.json"), limit, log),
  log,
};

const rest = new REST({ version: "10" }).setToken(token);
const gateway = new WebSocketManager({ token, intents: GatewayIntentBits.Guilds, rest });
const client = new Client({ rest, gateway });

client.on(GatewayDispatchEvents.InteractionCreate, ({ data: interaction, api }) => {
  handleInteraction(interaction, sherpa, {
    defer: (body) => api.interactions.defer(interaction.id, interaction.token, body),
    followUp: (body) => api.interactions.followUp(interaction.application_id, interaction.token, body),
  }).catch((error: Error) =>
    // Defer or follow-up itself failed — Discord, not Sherpa. Nothing to send.
    log(`[sherpa] interaction ${interaction.id} undelivered: ${error.message.slice(0, 160)}`),
  );
});

client.once(GatewayDispatchEvents.Ready, ({ data }) =>
  log(`[sherpa] ready as ${data.user.username}; /find cap ${limit}/day`),
);

await gateway.connect();
