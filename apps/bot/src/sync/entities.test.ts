import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.ts";
import { fixtureDiscord } from "./fixture-discord.ts";
import { ChannelType } from "./ports.ts";

const GUILD_ID = "1055290132250501135";

const guild = (over: Parameters<typeof fixtureDiscord>[0]) => fixtureDiscord(over);

describe("Forums, Posts and Threads", () => {
  it("puts Forums in the Catalog as their own Entity type", async () => {
    const { catalog } = await buildCatalog({
      discord: guild({
        channels: [
          { id: "10", name: "regional-chat", type: ChannelType.GuildForum, topic: "Talk with other regional dads" },
        ],
      }),
      guildId: GUILD_ID,
    });
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ type: "forum", description_status: "present" });
  });

  it("puts a Post in the Catalog as a Post, carrying its Forum's applied tags", async () => {
    const { catalog } = await buildCatalog({
      discord: guild({
        channels: [
          {
            id: "10",
            name: "regional-chat",
            type: ChannelType.GuildForum,
            availableTags: [{ id: "1091425817852121129", name: "Europe" }],
          },
        ],
        threads: [
          { id: "20", name: "United Kingdom", parentId: "10", appliedTags: ["1091425817852121129"], firstPost: "Dads in the UK, say hello here." },
        ],
      }),
      guildId: GUILD_ID,
    });
    const post = catalog.find((e) => e.id === "20");
    expect(post).toMatchObject({
      type: "post",
      name: "United Kingdom",
      parent_id: "10",
      // The Forum's tag NAME. Discord returns an ID here; publishing that
      // would be the old page's leaked-snowflake defect in a new field.
      applied_tags: ["Europe"],
      description_status: "present",
    });
  });

  it("distinguishes a Thread in a Channel from a Post in a Forum", async () => {
    const { catalog } = await buildCatalog({
      discord: guild({
        channels: [{ id: "11", name: "general", type: ChannelType.GuildText }],
        threads: [{ id: "21", name: "side chat", parentId: "11", appliedTags: [], firstPost: "Splitting this off from general." }],
      }),
      guildId: GUILD_ID,
    });
    expect(catalog.find((e) => e.id === "21")).toMatchObject({ type: "thread", applied_tags: [] });
  });

  it("marks a Post whose first message was image-only as absent, not present", async () => {
    // ~10% of the old index rendered empty for exactly this reason.
    const { catalog } = await buildCatalog({
      discord: guild({
        channels: [{ id: "10", name: "f", type: ChannelType.GuildForum }],
        threads: [{ id: "22", name: "Dad Fits", parentId: "10", appliedTags: [], firstPost: null }],
      }),
      guildId: GUILD_ID,
    });
    expect(catalog.find((e) => e.id === "22")?.description_status).toBe("absent");
  });

  it("never reads Posts inside a Forum whose content is withheld", async () => {
    const { catalog } = await buildCatalog({
      discord: guild({
        channels: [{ id: "12", name: "self-care", type: ChannelType.GuildForum, contentReadable: false }],
        threads: [{ id: "23", name: "leaked", parentId: "12", appliedTags: [], firstPost: "private" }],
      }),
      guildId: GUILD_ID,
    });
    expect(catalog.map((e) => e.id)).toEqual(["12"]);
    expect(catalog[0]?.description_status).toBe("withheld");
  });
});
