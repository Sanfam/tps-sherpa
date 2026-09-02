import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.ts";
import { parseExclusions } from "./exclusions.ts";
import { fixtureDiscord } from "./fixture-discord.ts";
import { ChannelType } from "./ports.ts";

const GUILD_ID = "1055290132250501135";

describe("parseExclusions", () => {
  it("treats a missing file as no exclusions", () => {
    expect(parseExclusions(null)).toEqual(new Set());
  });

  it("reads entries keyed on ID, because names are mutable", () => {
    const set = parseExclusions(
      JSON.stringify({
        exclude: [
          { id: "111", name: "verification-chat-1", reason: "not a destination" },
          { id: "222", name: "bot-tests" },
        ],
      }),
    );
    expect(set).toEqual(new Set(["111", "222"]));
  });

  it("fails loudly on a malformed file rather than publishing everything", () => {
    // Fail closed. A corrupt exclusion list silently becoming "exclude
    // nothing" would publish exactly what someone meant to hide.
    expect(() => parseExclusions("{ not json")).toThrow(/exclusion/i);
    expect(() => parseExclusions(JSON.stringify({ exclude: "nope" }))).toThrow(
      /exclusion/i,
    );
    expect(() =>
      parseExclusions(JSON.stringify({ exclude: [{ name: "no id here" }] })),
    ).toThrow(/exclusion/i);
  });

  it("accepts an empty list", () => {
    expect(parseExclusions(JSON.stringify({ exclude: [] }))).toEqual(new Set());
  });
});

describe("exclusions applied to the Catalog", () => {
  const guild = (exclusions?: Set<string>) =>
    buildCatalog({
      discord: fixtureDiscord({
        channels: [
          { id: "111", name: "general", type: ChannelType.GuildText, topic: "Chat here" },
          { id: "222", name: "verification-chat-1", type: ChannelType.GuildText, topic: "Verify here" },
          { id: "333", name: "regional", type: ChannelType.GuildForum, topic: "Regional talk" },
        ],
        threads: [
          { id: "444", name: "UK", parentId: "333", appliedTags: [], firstPost: "Dads in the UK" },
        ],
      }),
      guildId: GUILD_ID,
      exclusions,
    });

  it("keeps everything when nothing is excluded", async () => {
    const { catalog } = await guild();
    expect(catalog.map((e) => e.id)).toEqual(["111", "222", "333", "444"]);
  });

  it("drops an excluded Channel from the Catalog entirely", async () => {
    // verification-chat-1 is readable and visible, and is not a place to send
    // anyone. Permissions cannot express that; a list has to.
    const { catalog } = await guild(new Set(["222"]));
    expect(catalog.map((e) => e.id)).toEqual(["111", "333", "444"]);
  });

  it("drops the Posts of an excluded Forum, not just the Forum", async () => {
    const { catalog } = await guild(new Set(["333"]));
    expect(catalog.map((e) => e.id)).toEqual(["111", "222"]);
  });

  it("excludes an individual Post without touching its Forum", async () => {
    const { catalog } = await guild(new Set(["444"]));
    expect(catalog.map((e) => e.id)).toEqual(["111", "222", "333"]);
  });
});

describe("the Member-versus-bot visibility delta", () => {
  const withVisibility = (
    channels: Array<{ id: string; name: string; visible: boolean; memberVisible: boolean }>,
    warn: (m: string) => void,
  ) =>
    buildCatalog({
      discord: fixtureDiscord({
        channels: channels.map((c) => ({
          ...c,
          type: ChannelType.GuildText,
          topic: "something",
        })),
      }),
      guildId: GUILD_ID,
      warn,
    });

  it("warns about every Entity a Member can see but the bot cannot", async () => {
    // The Catalog is meant to describe what a Member can reach. Anything in
    // this gap is silently missing from it, so it must be visible as an
    // alarm rather than shrinking the Catalog quietly.
    const warnings: string[] = [];
    await withVisibility(
      [
        { id: "111", name: "general", visible: true, memberVisible: true },
        { id: "222", name: "announcements", visible: false, memberVisible: true },
      ],
      (m) => warnings.push(m),
    );
    const delta = warnings.filter((w) => w.includes("[visibility]"));
    expect(delta).toHaveLength(1);
    expect(delta[0]).toContain("announcements");
    expect(delta[0]).toContain("222");
  });

  it("stays quiet when the bot sees everything a Member sees", async () => {
    const warnings: string[] = [];
    await withVisibility(
      [{ id: "111", name: "general", visible: true, memberVisible: true }],
      (m) => warnings.push(m),
    );
    expect(warnings.filter((w) => w.includes("[visibility]"))).toHaveLength(0);
  });

  it("does not warn about things the bot sees but a Member cannot", async () => {
    // Verification plumbing. Not a gap in the Catalog — it should be on the
    // exclusion list, which is a different problem.
    const warnings: string[] = [];
    await withVisibility(
      [{ id: "111", name: "bot-tests", visible: true, memberVisible: false }],
      (m) => warnings.push(m),
    );
    expect(warnings.filter((w) => w.includes("[visibility]"))).toHaveLength(0);
  });
});

describe("exclusion reporting and mention resolution", () => {
  const guild = (exclusions: Set<string>) =>
    buildCatalog({
      discord: fixtureDiscord({
        channels: [
          { id: "111", name: "general", type: ChannelType.GuildText, topic: "Also see <#222>" },
          { id: "222", name: "bot-tests", type: ChannelType.GuildText, topic: "Testing" },
        ],
      }),
      guildId: GUILD_ID,
      exclusions,
    });

  it("still resolves a mention pointing at an excluded Entity", async () => {
    // Excluded means "not a destination", not "secret". Publishing
    // #unknown-channel here would be the defect normalisation exists to kill.
    const { catalog } = await guild(new Set(["222"]));
    expect(catalog.map((e) => e.id)).toEqual(["111"]);
    expect(catalog[0]?.topic).toBe("Also see #bot-tests");
  });

  it("reports which configured exclusions actually matched", async () => {
    // A stale or mistyped ID must not read as a working exclusion.
    const { exclusionsApplied } = await guild(new Set(["222", "999-typo"]));
    expect(exclusionsApplied).toEqual(["222"]);
  });
});
