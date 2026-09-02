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
  it("keeps only standing text Channels", async () => {
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({ channels: recorded }),
      guildId: GUILD_ID,
    });

    const kept = new Set(catalog.map((e) => e.id));
    const shouldBeAbsent = recorded.filter(
      (c) =>
        c.type !== ChannelType.GuildText &&
        c.type !== ChannelType.GuildAnnouncement,
    );

    // 15 categories, 6 voice, 1 stage and 11 Forums are not Channels. Left in,
    // the categories alone would render as Entities with dead deep links.
    expect(shouldBeAbsent.length).toBeGreaterThan(0);
    expect(shouldBeAbsent.filter((c) => kept.has(c.id))).toEqual([]);
    expect(catalog).toHaveLength(
      recorded.filter(
        (c) =>
          c.type === ChannelType.GuildText ||
          c.type === ChannelType.GuildAnnouncement,
      ).length,
    );
  });

  it("gives every Entity an ID-derived deep link and empty summary slots", async () => {
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({ channels: recorded }),
      guildId: GUILD_ID,
    });

    for (const entity of catalog) {
      expect(entity.type).toBe("channel");
      expect(entity.url).toBe(
        `https://discord.com/channels/${GUILD_ID}/${entity.id}`,
      );
      expect(entity.summary_generated).toBeNull();
      expect(entity.summary_override).toBeNull();
    }
  });
});
