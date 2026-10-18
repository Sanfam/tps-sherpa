/**
 * Papa Sherpa's long-running process: a gateway connection that answers
 * `/find`, `/lately`, `/privacy`, `/monitored` and `/sherpa`, and, with
 * `SHERPA_INTRODUCTIONS=1`, the introductions responder (responder.ts).
 *
 *   node --env-file=.env src/sherpa/run.ts
 *
 * Register the commands first (register.ts; serve.ts does it at startup). The
 * Catalog, the role manifest, activity summaries and privacy settings are read
 * from disk on every command, so a sync or an enrichment
 * run takes effect without a restart.
 *
 * Slash commands arrive regardless of intents, so without the responder
 * `Guilds` is the only one. With it, `GuildMessages` and `MessageContent` too
 * (owner, 2026-10-17): the process then receives every message in the guild,
 * and the responder's first line drops all but `#introductions`', unstored
 * and unlogged. Local runs leave the variable unset and read no messages.
 */
import { resolve } from "node:path";
import { API, Client } from "@discordjs/core";
import { DiscordAPIError, REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { GatewayDispatchEvents, GatewayIntentBits } from "discord-api-types/v10";
import { WATCHED_CHANNEL } from "../llm/boundary.ts";
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
import { MEMBER_ROLE_NAME, canReadHistory, canSend, canView, messageContentUsable } from "../sync/discord-adapter.ts";
import { DURABLE_STORE_PATH, readDeniedPlaces, readMonitored, withDurableStore } from "../sync/durable-store.ts";
import { TIER0_PATH } from "../sync/tier0-store.ts";
import { FIND_TIMEOUT_MS } from "./find.ts";
import { dailyCap, findDailyCap, handleInteraction, memberRoleIds, type Sherpa } from "./interactions.ts";
import { openMonitored } from "./monitored.ts";
import { openPrivacy } from "./privacy.ts";
import { withResponderStore } from "./responder-store.ts";
import { type TallyDeps, computeTally, describeTally, runTally } from "./responder-tally.ts";
import { type ChannelAccess, type Responder, SHADOW_CHANNEL, createResponder } from "./responder.ts";

const token = process.env["DISCORD_BOT_TOKEN"];
const guildId = process.env["DISCORD_GUILD_ID"];
if (!token || !guildId) {
  console.error("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must both be set.");
  process.exit(1);
}

const log = (m: string) => console.log(m);
const limit = findDailyCap(process.env["SHERPA_FIND_DAILY_CAP"]);
const introductions = process.env["SHERPA_INTRODUCTIONS"] === "1";
/** Paid calls a day across the responder's paths (D29). */
const RESPONDER_DAILY_CAP = 60;
const HOUR = 60 * 60 * 1000;

const rest = new REST({ version: "10" }).setToken(token);
const api = new API(rest);
const notFound = (error: unknown) => error instanceof DiscordAPIError && error.status === 404;
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 160);

/** The bot's access to the Channels the responder reads and writes, as the sync computes it. */
const probe = async () => {
  const [app, channels, roles, me] = await Promise.all([
    api.applications.getCurrent(),
    api.guilds.getChannels(guildId),
    api.guilds.getRoles(guildId),
    api.users.getCurrent(),
  ]);
  const { roles: roleIds } = await api.guilds.getMember(guildId, me.id);
  const permissions = new Map(roles.map((r) => [r.id, BigInt(r.permissions)]));
  const holding = (held: string[], memberId: string) => ({
    guildId,
    roleIds: held,
    memberId,
    basePermissions: [guildId, ...held].reduce((p, id) => p | (permissions.get(id) ?? 0n), 0n),
  });
  const ctx = holding(roleIds, me.id);
  const access = (id: string): ChannelAccess | null => {
    const channel = channels.find((c) => c.id === id);
    return channel
      ? { view: canView(channel, ctx), history: canReadHistory(channel, ctx), send: canSend(channel, ctx) }
      : null;
  };
  // A Member as the sync models one: @everyone and the Member role, no member-specific overwrite.
  // With no Member role to test, #bot-tests cannot be shown hidden, so it counts as visible.
  const memberRoles = roles.filter((r) => r.name === MEMBER_ROLE_NAME).map((r) => r.id);
  const shadow = channels.find((c) => c.id === SHADOW_CHANNEL);
  return {
    messageContent: messageContentUsable(app.flags ?? 0),
    watched: access(WATCHED_CHANNEL),
    shadow: access(SHADOW_CHANNEL),
    shadowVisibleToMember: !memberRoles.length || (shadow !== undefined && canView(shadow, holding(memberRoles, ""))),
  };
};

const responder: Responder | null = introductions
  ? createResponder({
      guildId,
      discord: {
        member: async (userId) => {
          try {
            const member = await api.guilds.getMember(guildId, userId);
            return {
              joinedAt: member.joined_at ?? null,
              names: [member.user.username, member.user.global_name, member.nick].filter(
                (n): n is string => typeof n === "string" && n.trim() !== "",
              ),
            };
          } catch (error) {
            if (notFound(error)) return null;
            throw error;
          }
        },
        messages: (query) => api.channels.getMessages(WATCHED_CHANNEL, { ...query, limit: 100 }),
        message: async (id) => {
          try {
            return await api.channels.getMessage(WATCHED_CHANNEL, id);
          } catch (error) {
            if (notFound(error)) return null;
            throw error;
          }
        },
        probe,
        botId: async () => (await api.users.getCurrent()).id,
        createMessage: (channelId, body) => api.channels.createMessage(channelId, body),
      },
      store: (work) => withResponderStore(work, DURABLE_STORE_PATH),
      preferences: (memberId) => withDurableStore((s) => s.preferences(memberId)),
      monitored: () => readMonitored(loadCatalog()),
      excluded: () => withDurableStore((s) => s.exclusions()),
      session: () => {
        const catalog = loadCatalog();
        const { boundary, monitored } = openBoundary(catalog, {}, FIND_TIMEOUT_MS);
        const memberRoles = memberRoleIds(loadRoleManifest());
        return {
          catalog,
          monitored,
          vocabulary: parseVocabulary(readIfPresent(VOCABULARY_PATH)),
          boundary,
          memberRoles,
          denied: (memberId) => readDeniedPlaces(memberId),
        };
      },
      fetchImage: (url, init) => fetch(url, init),
      cap: dailyCap(resolve(DATA_DIR, "responder-usage.json"), RESPONDER_DAILY_CAP, log),
      now: () => Date.now(),
      log,
    })
  : null;

/** The shadow tally's reads and its one notice (§8), only where the responder runs. */
let botId: string | undefined;
const tallyDeps = async (): Promise<TallyDeps> => ({
  messages: (channelId, before) => api.channels.getMessages(channelId, { limit: 100, ...(before ? { before } : {}) }),
  botId: (botId ??= (await api.users.getCurrent()).id),
  now: () => Date.now(),
  store: (work) => withResponderStore(work, DURABLE_STORE_PATH),
  monitored: () => readMonitored(loadCatalog()),
  createMessage: (channelId, body) => api.channels.createMessage(channelId, body),
  log,
});

const sherpa: Sherpa = {
  guildId,
  loadCatalog,
  loadRoleManifest,
  loadVocabulary: () => parseVocabulary(readIfPresent(VOCABULARY_PATH)),
  loadActivity: () => readActivity(),
  privacy: openPrivacy(
    {
      durable: DURABLE_STORE_PATH,
      tier0: TIER0_PATH,
      activity: ACTIVITY_PATH,
      policy: PRIVACY_POLICY_PATH,
    },
    // F8: the rows are erased in the handler, and the memory with them, at once.
    (memberId) => responder?.forget(memberId),
  ),
  monitored: openMonitored(DURABLE_STORE_PATH),
  settings: (work) => withResponderStore(work, DURABLE_STORE_PATH),
  ...(responder ? { tally: async () => describeTally(await computeTally(await tallyDeps())) } : {}),
  loadMonitored: (catalog) => readMonitored(catalog),
  loadDenied: (memberId) => readDeniedPlaces(memberId),
  askFor: (catalog) => openBoundary(catalog, {}, FIND_TIMEOUT_MS).boundary.ask,
  retrying: (work) => retrying(work, log),
  cap: dailyCap(resolve(DATA_DIR, "find-usage.json"), limit, log),
  log,
};

const intents = introductions
  ? GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent
  : GatewayIntentBits.Guilds;
const gateway = new WebSocketManager({ token, intents, rest });
const client = new Client({ rest, gateway });

if (responder) {
  client.on(GatewayDispatchEvents.MessageCreate, ({ data }) => void responder.onMessage(data));
  client.on(GatewayDispatchEvents.MessageUpdate, ({ data }) => void responder.onMessage(data, true));
  client.on(GatewayDispatchEvents.MessageDelete, ({ data }) =>
    responder.onDelete({ channel_id: data.channel_id, ids: [data.id] }),
  );
  client.on(GatewayDispatchEvents.MessageDeleteBulk, ({ data }) => responder.onDelete(data));
}

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

if (responder) {
  const logged = (what: string) => (error: unknown) => log(`[responder] ${what} failed: ${failure(error)}`);
  // The checks pause only the responder's evaluation: the erasure loop runs whatever they say (§6).
  void responder
    .start()
    .catch(logged("startup"))
    .finally(() => {
      setInterval(() => void responder.tick().catch(logged("tick")), 60_000);
      setInterval(() => {
        void responder.eraseLoop().catch(logged("erasure loop"));
        void responder.check().catch(logged("checks"));
      }, HOUR);
      // The daily tally, and the go-live notice once the bar is reached (§8). Also at
      // startup, so a bot restarted more often than daily still tallies; the notice is
      // recorded once, so running it again posts nothing more.
      const tally = () => void tallyDeps().then(runTally).catch(logged("tally"));
      tally();
      setInterval(tally, 24 * HOUR);
    });
}
