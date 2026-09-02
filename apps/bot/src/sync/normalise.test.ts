import { describe, expect, it } from "vitest";
import { normaliseDescription } from "./normalise.ts";

const names = {
  channels: new Map([["1088552078709891242", "💬︱general"]]),
  roles: new Map([["1130012157099135027", "Member"]]),
};
const n = (raw: string | null) => normaliseDescription(raw, names);

/**
 * Each case below is a defect the script this project replaces actually
 * shipped to a published page. They are the quality bar.
 */
describe("defect fixtures — the old script's failures must not reproduce", () => {
  it("never emits a raw member mention, and never substitutes a member's name", () => {
    // The old page published `<@732682426853359667>` verbatim. Resolving it to
    // a display name would be a different failure: the privacy model says
    // member identifiers are never echoed. Neutral placeholder instead.
    const out = n("Ask <@732682426853359667> about the server");
    expect(out).not.toContain("732682426853359667");
    expect(out).not.toContain("<@");
    expect(out).toBe("Ask @member about the server");
  });

  it("resolves a channel mention to its name, which survives renames", () => {
    expect(n("Head to <#1088552078709891242> for that")).toBe(
      "Head to #💬︱general for that",
    );
  });

  it("leaves no raw ID behind for a channel it cannot resolve", () => {
    const out = n("See <#999999999999999999>");
    expect(out).not.toContain("999999999999999999");
    expect(out).toBe("See #unknown-channel");
  });

  it("resolves a role mention by name, since roles are not member identifiers", () => {
    expect(n("<@&1130012157099135027> only")).toBe("@Member only");
  });

  it("never emits a raw custom emoji ID", () => {
    // `<:quest:12345>` leaked as an ID on the old page.
    const out = n("Time for <:quest:123456789012345678> lads <a:dance:987654321098765432>");
    expect(out).not.toMatch(/\d{17,}/);
    expect(out).toBe("Time for :quest: lads :dance:");
  });

  it("strips Discord markdown so it cannot collide with the output format", () => {
    // `~~QUEST~~` rendered as struck-through wiki markup on the old page.
    expect(n("~~QUEST~~ is **done** and __over__")).toBe("QUEST is done and over");
    expect(n("||spoiler|| and `code`")).toBe("spoiler and code");
  });

  it("truncates a runaway entry at a word boundary", () => {
    // One old entry dumped an entire Formula 1 race calendar.
    const long = "Round ".repeat(400);
    const out = n(long)!;
    expect(out.length).toBeLessThanOrEqual(501);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("Roun…");
  });

  it("returns null rather than an empty description", () => {
    // Old page entries rendered blank when the first post was image-only.
    expect(n("")).toBeNull();
    expect(n("   \n\t  ")).toBeNull();
    expect(n(null)).toBeNull();
  });

  it("returns null for a description that is only a mention or emoji", () => {
    expect(n("<:wave:123456789012345678>")).toBeNull();
    expect(n("<@732682426853359667>")).toBeNull();
  });

  it("returns null for a bare URL, which describes nothing", () => {
    // The 📚︱wiki channel's topic is exactly this.
    expect(n("https://wiki.papasquad.xyz/")).toBeNull();
  });

  it("collapses runaway horizontal whitespace and strips zero-width characters", () => {
    expect(n("Lots   of    space\u200B\u200B here")).toBe("Lots of space here");
  });

  it("separates lines rather than running them together", () => {
    expect(n("A\n\n\n\nB   C")).toBe("A; B C");
  });

  it("keeps ordinary prose untouched", () => {
    const topic = "(0-8 weeks)  How fun is it to not sleep anymore?";
    expect(n(topic)).toBe("(0-8 weeks) How fun is it to not sleep anymore?");
  });
});

/**
 * These were not caught by the fixtures above — real descriptions in this
 * guild exposed them. Each is the same defect class the module exists to kill.
 */
describe("defects found only against real guild data", () => {
  it("resolves a mention of a Post or Thread, not just a Channel", () => {
    // Discord uses `<#id>` for threads and posts too. Building the lookup from
    // containers alone published `#unknown-channel` for 7 real mentions.
    const withThread = {
      channels: new Map([["1224884635650232403", "Dad Fits"]]),
      roles: new Map<string, string>(),
    };
    expect(normaliseDescription("See <#1224884635650232403>", withThread)).toBe(
      "See #Dad Fits",
    );
  });

  it("converts Discord timestamp markup to a readable date", () => {
    // `Raid Night <t:1684461600:F>` shipped verbatim.
    expect(n("Raid Night <t:1684461600:F> be there")).toBe(
      "Raid Night 2023-05-19 be there",
    );
    expect(n("Starts <t:1717794000> sharp")).toBe("Starts 2024-06-07 sharp");
  });

  it("strips single-marker emphasis", () => {
    expect(n("Delve Into the *Dungeons of Dredmor*!")).toBe(
      "Delve Into the Dungeons of Dredmor!",
    );
    expect(n("A _really_ good one")).toBe("A really good one");
  });

  it("never strips markdown markers out of a URL", () => {
    // Real links here contain `__`; stripping inside them ships a dead link.
    const out = n("Grab it https://store.steampowered.com/app/1?snr=1_4_4__118 now")!;
    expect(out).toContain("snr=1_4_4__118");
    const parkour = n(
      "Play https://example.com/Rooftops__Alleys_The_Parkour_Game today",
    )!;
    expect(parkour).toContain("Rooftops__Alleys_The_Parkour_Game");
  });

  it("keeps a bulleted topic readable instead of run-on with stray dashes", () => {
    expect(
      n("Have an idea?\n- We'll look at all ideas\n- Please explain why"),
    ).toBe("Have an idea?; We'll look at all ideas; Please explain why");
  });

  it("leaves a legitimate long number inside a URL alone", () => {
    // TikTok video ids, Tenor gif ids and OAuth client_ids all look like
    // snowflakes and are none of our business.
    const out = n(
      "Clip: https://www.tiktok.com/@x/video/7154284659700944130 watch it",
    )!;
    expect(out).toContain("7154284659700944130");
  });
});
