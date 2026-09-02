import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.ts";
import { fixtureDiscord } from "./fixture-discord.ts";
import { ChannelType } from "./ports.ts";

const GUILD_ID = "1088552078709891240";

describe("buildCatalog", () => {
  it("puts every Channel in the guild into the Catalog", async () => {
    const discord = fixtureDiscord({
      channels: [
        { id: "111", name: "gaming", type: ChannelType.GuildText },
        { id: "222", name: "steam-deck-and-handhelds", type: ChannelType.GuildText },
      ],
    });

    const { catalog } = await buildCatalog({ discord, guildId: GUILD_ID });

    expect(catalog.map((e) => e.name)).toEqual([
      "gaming",
      "steam-deck-and-handhelds",
    ]);
  });

  it("keys each Entity on its Discord ID and gives it a working deep link", async () => {
    const discord = fixtureDiscord({ channels: [{ id: "111", name: "gaming", type: ChannelType.GuildText }] });

    const { catalog } = await buildCatalog({ discord, guildId: GUILD_ID });

    expect(catalog[0]).toMatchObject({
      id: "111",
      type: "channel",
      url: `https://discord.com/channels/${GUILD_ID}/111`,
    });
  });

  it("finds a renamed Channel by ID rather than treating it as a new Entity", async () => {
    // The old index broke exactly here: steam-deck-gaming was renamed
    // steam-deck-and-handhelds and the page never noticed.
    const before = await buildCatalog({
      discord: fixtureDiscord({
        channels: [
          { id: "222", name: "steam-deck-gaming", type: ChannelType.GuildText },
        ],
      }),
      guildId: GUILD_ID,
    });
    const corrected = before.catalog.map((e) => ({
      ...e,
      summary_override: "Handhelds, not just Steam Decks.",
    }));

    const after = await buildCatalog({
      discord: fixtureDiscord({
        channels: [
          {
            id: "222",
            name: "steam-deck-and-handhelds",
            type: ChannelType.GuildText,
          },
        ],
      }),
      guildId: GUILD_ID,
      previous: corrected,
    });

    expect(after.catalog).toHaveLength(1);
    expect(after.catalog[0]?.name).toBe("steam-deck-and-handhelds");
    expect(after.catalog[0]?.url).toBe(before.catalog[0]?.url);
    // The correction survives the rename because the merge keys on ID.
    expect(after.catalog[0]?.summary_override).toBe(
      "Handhelds, not just Steam Decks.",
    );
  });

  it("leaves out categories and voice channels, which are not Entities", async () => {
    // A category is a header and a voice channel is not somewhere you read.
    // Both would render as browsable Entities with dead deep links. A Forum
    // IS an Entity, of its own type.
    const discord = fixtureDiscord({
      channels: [
        { id: "111", name: "gaming", type: ChannelType.GuildText },
        { id: "222", name: "Lifestyle & Hobbies", type: ChannelType.GuildCategory },
        { id: "333", name: "General Voice", type: ChannelType.GuildVoice },
        { id: "444", name: "regional", type: ChannelType.GuildForum },
        { id: "555", name: "announcements", type: ChannelType.GuildAnnouncement },
      ],
    });

    const { catalog } = await buildCatalog({ discord, guildId: GUILD_ID });

    expect(catalog.map((e) => e.id)).toEqual(["111", "444", "555"]);
    expect(catalog.find((e) => e.id === "444")?.type).toBe("forum");
  });

  it("carries a human override through a re-sync and never writes one itself", async () => {
    const discord = fixtureDiscord({ channels: [{ id: "111", name: "gaming", type: ChannelType.GuildText }] });
    const previous = [
      {
        id: "111",
        type: "channel" as const,
        name: "gaming",
        url: `https://discord.com/channels/${GUILD_ID}/111`,
        parent_id: null,
        description_status: "present" as const,
        topic: "gaming chat",
        applied_tags: [],
        summary_generated: null,
        summary_override: "Where the Rocket League lot live.",
      },
    ];

    const { catalog } = await buildCatalog({ discord, guildId: GUILD_ID, previous });

    expect(catalog[0]?.summary_override).toBe("Where the Rocket League lot live.");
  });

  it("leaves the override empty for an Entity nobody has corrected", async () => {
    const discord = fixtureDiscord({ channels: [{ id: "111", name: "gaming", type: ChannelType.GuildText }] });

    const { catalog } = await buildCatalog({ discord, guildId: GUILD_ID });

    expect(catalog[0]?.summary_override).toBeNull();
    expect(catalog[0]?.summary_generated).toBeNull();
  });

  it("refuses to run when the Message Content intent is unavailable, and names it", async () => {
    // Without this the sync silently produces empty descriptions and the
    // failure looks like a bug in our code. Fail loudly instead.
    const discord = fixtureDiscord({
      channels: [{ id: "111", name: "gaming", type: ChannelType.GuildText }],
      messageContentIntent: false,
    });

    await expect(buildCatalog({ discord, guildId: GUILD_ID })).rejects.toThrow(
      /Message Content intent/i,
    );
  });
});

describe("description status", () => {
  const at = (overrides: Partial<Parameters<typeof fixtureDiscord>[0]["channels"][0]>) =>
    fixtureDiscord({
      channels: [
        { id: "111", name: "c", type: ChannelType.GuildText, ...overrides },
      ],
    });

  it("marks a Channel with a topic as present", async () => {
    const { catalog } = await buildCatalog({
      discord: at({ topic: "Talk about specific video games!" }),
      guildId: GUILD_ID,
    });
    expect(catalog[0]?.description_status).toBe("present");
    expect(catalog[0]?.topic).toBe("Talk about specific video games!");
  });

  it("marks a readable Channel with nothing to say as absent", async () => {
    const { catalog } = await buildCatalog({ discord: at({ topic: "  " }), guildId: GUILD_ID });
    expect(catalog[0]?.description_status).toBe("absent");
    expect(catalog[0]?.topic).toBeNull();
  });

  it("marks a Channel whose content is off-limits as withheld, never absent", async () => {
    // Deliberate: the bot can see 🩹 Selfing channels exist but gets zero
    // messages. That is a privacy decision, not a missing description.
    const { catalog } = await buildCatalog({
      discord: at({ topic: "a topic that exists", contentReadable: false }),
      guildId: GUILD_ID,
    });
    expect(catalog[0]?.description_status).toBe("withheld");
    expect(catalog[0]?.topic).toBeNull();
  });
});

describe("output stability", () => {
  it("orders Entities by ID so a re-run produces identical output", async () => {
    // Discord does not promise a stable channel order. Without sorting, a
    // scheduled sync would commit a reordered file every run.
    const shuffled = fixtureDiscord({
      channels: [
        { id: "333", name: "c", type: ChannelType.GuildText },
        { id: "111", name: "a", type: ChannelType.GuildText },
        { id: "222", name: "b", type: ChannelType.GuildText },
      ],
    });
    const ordered = fixtureDiscord({
      channels: [
        { id: "111", name: "a", type: ChannelType.GuildText },
        { id: "222", name: "b", type: ChannelType.GuildText },
        { id: "333", name: "c", type: ChannelType.GuildText },
      ],
    });

    const a = await buildCatalog({ discord: shuffled, guildId: GUILD_ID });
    const b = await buildCatalog({ discord: ordered, guildId: GUILD_ID });

    expect(JSON.stringify(a.catalog)).toBe(JSON.stringify(b.catalog));
    expect(a.catalog.map((e) => e.id)).toEqual(["111", "222", "333"]);
  });
});
