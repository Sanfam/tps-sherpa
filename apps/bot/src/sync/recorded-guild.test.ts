import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.ts";
import { fixtureDiscord } from "./fixture-discord.ts";
import { ChannelType, type RawChannel } from "./ports.ts";

/**
 * Recorded from the real guild on 2026-09-01, not hand-written, so these
 * assertions are pinned to shapes Discord actually returns.
 */
const recorded: RawChannel[] = JSON.parse(
  readFileSync(new URL("./__fixtures__/guild-channels.json", import.meta.url), "utf8"),
);

const GUILD_ID = "1055290132250501135";

describe("against the recorded guild", () => {
  it("keeps visible Channels and Forums, and nothing else", async () => {
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({ channels: recorded }),
      guildId: GUILD_ID,
    });

    const kept = new Set(catalog.map((e) => e.id));
    const isContainer = (t: number) =>
      t === ChannelType.GuildText ||
      t === ChannelType.GuildAnnouncement ||
      t === ChannelType.GuildForum;
    const shouldBeAbsent = recorded.filter((c) => !isContainer(c.type));

    // 15 categories, 6 voice, 1 stage and 11 Forums are not Channels. Left in,
    // the categories alone would render as Entities with dead deep links.
    expect(shouldBeAbsent.length).toBeGreaterThan(0);
    expect(shouldBeAbsent.filter((c) => kept.has(c.id))).toEqual([]);
    expect(catalog).toHaveLength(
      recorded.filter((c) => c.visible && isContainer(c.type)).length,
    );
  });

  it("excludes Channels the bot cannot see, and withholds those it cannot read", async () => {
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({ channels: recorded }),
      guildId: GUILD_ID,
    });
    const invisible = new Set(recorded.filter((c) => !c.visible).map((c) => c.id));
    expect(catalog.filter((e) => invisible.has(e.id))).toEqual([]);

    // 9 channels are deliberately listed without content: Papa Sherpa holds
    // VIEW but not READ_MESSAGE_HISTORY. They must read as withheld, never
    // absent — the distinction is a privacy decision, not a data gap.
    const withheld = catalog.filter((e) => e.description_status === "withheld");
    expect(withheld.length).toBe(
      recorded.filter((c) => c.visible && !c.contentReadable && [0, 5, 15].includes(c.type)).length,
    );
    expect(withheld.every((e) => e.topic === null)).toBe(true);
  });

  it("gives every Entity an ID-derived deep link and empty summary slots", async () => {
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({ channels: recorded }),
      guildId: GUILD_ID,
    });

    for (const entity of catalog) {
      expect(["channel", "forum"]).toContain(entity.type);
      expect(["present", "absent", "withheld"]).toContain(entity.description_status);
      expect(entity.url).toBe(
        `https://discord.com/channels/${GUILD_ID}/${entity.id}`,
      );
      expect(entity.summary_generated).toBeNull();
      expect(entity.summary_override).toBeNull();
    }
  });
});
