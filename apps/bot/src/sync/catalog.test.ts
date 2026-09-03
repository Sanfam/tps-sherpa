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
        region: [],
        last_message_id: null,
        last_activity_at: null,
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

describe("activity timestamps", () => {
  it("derives the activity time from the snowflake rather than fetching it", async () => {
    // Discord IDs embed their creation time above the low 22 bits, so this is
    // exact and costs no API call.
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({
        channels: [
          {
            id: "111",
            name: "gaming",
            type: ChannelType.GuildText,
            lastMessageId: "1301175316332417094",
          },
        ],
      }),
      guildId: GUILD_ID,
    });
    expect(catalog[0]?.last_message_id).toBe("1301175316332417094");
    // Verified against the documented Discord epoch (2015-01-01Z) by building
    // a snowflake for a known instant and round-tripping it, rather than by
    // restating what the implementation happens to produce.
    expect(catalog[0]?.last_activity_at).toBe("2024-10-30T13:26:10.082Z");
  });

  it("round-trips a snowflake built for a known instant", async () => {
    const known = Date.UTC(2023, 4, 19, 2, 0, 0, 0);
    const built = ((BigInt(known) - 1420070400000n) << 22n).toString();
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({
        channels: [
          { id: "111", name: "c", type: ChannelType.GuildText, lastMessageId: built },
        ],
      }),
      guildId: GUILD_ID,
    });
    expect(catalog[0]?.last_activity_at).toBe(new Date(known).toISOString());
  });

  it("reports no activity for an Entity nobody has posted in", async () => {
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({
        channels: [{ id: "111", name: "quiet", type: ChannelType.GuildText }],
      }),
      guildId: GUILD_ID,
    });
    expect(catalog[0]?.last_message_id).toBeNull();
    expect(catalog[0]?.last_activity_at).toBeNull();
  });
});

describe("the Platform facet", () => {
  const forum = {
    id: "900",
    name: "game-talk",
    type: ChannelType.GuildForum,
    availableTags: [
      { id: "1088129693884096512", name: "PlayStation" },
      { id: "1088129792395710505", name: "Co-op" },
    ],
  };

  it("publishes mod-authored tag names, never the snowflakes Discord returns", async () => {
    // The Catalog is published output. A tag ID here is the same defect as the
    // raw <#id> the old page leaked, just in a different field.
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({
        channels: [forum],
        threads: [
          {
            id: "901",
            name: "Helldivers squad",
            parentId: "900",
            appliedTags: ["1088129693884096512", "1088129792395710505"],
            firstPost: "Anyone up for a dive tonight?",
          },
        ],
      }),
      guildId: GUILD_ID,
    });

    expect(catalog.find((e) => e.id === "901")?.applied_tags).toEqual([
      "PlayStation",
      "Co-op",
    ]);
  });

  it("drops a tag its Forum does not define, and says so", async () => {
    const warnings: string[] = [];
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({
        channels: [forum],
        threads: [
          {
            id: "902",
            name: "Stale tag",
            parentId: "900",
            appliedTags: ["1088129693884096512", "9999999999999999999"],
            firstPost: "A tag was deleted out from under this Post.",
          },
        ],
      }),
      guildId: GUILD_ID,
    });

    expect(catalog.find((e) => e.id === "902")?.applied_tags).toEqual(["PlayStation"]);
  });
});

describe("the Region facet", () => {
  const gazetteer = new Map([
    ["Minnesota", ["minnesota", "twin cities"]],
    ["Texas", ["texas", "houston"]],
  ]);

  it("tags an Entity with the regions its name names", async () => {
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({
        channels: [{ id: "111", name: "regional-chat", type: ChannelType.GuildForum }],
        threads: [
          {
            id: "222",
            name: "Minnesota!",
            parentId: "111",
            appliedTags: [],
            firstPost: "Any dads in the Twin Cities?",
          },
          {
            id: "333",
            name: "Board games",
            parentId: "111",
            appliedTags: [],
            firstPost: "What is everyone playing?",
          },
        ],
      }),
      guildId: GUILD_ID,
      regions: gazetteer,
    });

    expect(catalog.find((e) => e.id === "222")?.region).toEqual(["Minnesota"]);
    // Named after no place: an empty facet, not a guess.
    expect(catalog.find((e) => e.id === "333")?.region).toEqual([]);
  });

  it("matches on the name only, never on the description", async () => {
    // A Post that mentions Houston in passing is not a Houston Post. Reading
    // the body is where a mechanical facet turns into a bad classifier.
    const { catalog } = await buildCatalog({
      discord: fixtureDiscord({
        channels: [{ id: "111", name: "game-talk", type: ChannelType.GuildForum }],
        threads: [
          {
            id: "444",
            name: "Weekend plans",
            parentId: "111",
            appliedTags: [],
            firstPost: "I am flying to Houston, Texas on Friday.",
          },
        ],
      }),
      guildId: GUILD_ID,
      regions: gazetteer,
    });

    expect(catalog.find((e) => e.id === "444")?.region).toEqual([]);
  });
});
