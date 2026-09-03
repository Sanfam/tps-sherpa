import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_WITHIN_DAYS,
  activityBucket,
  matchRegions,
  parseGazetteer,
} from "./facets.ts";

/** The committed gazetteer, not a hand-written one: it is the thing that ships. */
const gazetteer = parseGazetteer(
  readFileSync(new URL("../../../../content/config/regions.json", import.meta.url), "utf8"),
);

const daysAgo = (n: number, from = new Date("2026-09-02T00:00:00.000Z")) =>
  new Date(from.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe("activityBucket", () => {
  const now = new Date("2026-09-02T00:00:00.000Z");

  it("buckets by age against the named thresholds", () => {
    expect(activityBucket(daysAgo(1), now)).toBe("active");
    expect(activityBucket(daysAgo(ACTIVE_WITHIN_DAYS), now)).toBe("active");
    expect(activityBucket(daysAgo(ACTIVE_WITHIN_DAYS + 1), now)).toBe("recent");
    expect(activityBucket(daysAgo(120), now)).toBe("quiet");
    expect(activityBucket(daysAgo(500), now)).toBe("dormant");
  });

  it("separates 'never posted' from 'went quiet'", () => {
    // An empty Channel and a Channel that died two years ago are different
    // recommendations, and collapsing them would make the bot suggest a room
    // nobody has ever spoken in as though it merely went quiet.
    expect(activityBucket(null, now)).toBeNull();
    expect(activityBucket("not a date", now)).toBeNull();
  });
});

describe("matchRegions", () => {
  it("matches a region named in an Entity's name", () => {
    expect(matchRegions("Minnesota!", gazetteer)).toEqual(["Minnesota"]);
    expect(matchRegions("Greater Charlotte, NC Area", gazetteer)).toEqual([
      "North Carolina",
    ]);
  });

  it("keeps both when a name genuinely names two regions", () => {
    // Silently picking one is the resolution this facet exists to avoid.
    expect(matchRegions("Northern Alabama/Southern Middle Tennessee", gazetteer)).toEqual([
      "Alabama",
      "Tennessee",
    ]);
    expect(matchRegions("Greater Boston / New England", gazetteer)).toEqual([
      "Massachusetts",
      "New England",
    ]);
  });

  it("lets the longest phrase win its span", () => {
    // "West Virginia" contains "Virginia". Matching both would put a member in
    // Charleston in the wrong state.
    expect(matchRegions("West Virginia", gazetteer)).toEqual(["West Virginia"]);
    expect(matchRegions("British Columbia!", gazetteer)).toEqual(["Canada"]);
  });

  it("ignores emoji and punctuation around the name", () => {
    expect(matchRegions("United Kingdom 🇬🇧", gazetteer)).toEqual(["United Kingdom"]);
    expect(matchRegions("🇫🇷 France 🥖", gazetteer)).toEqual(["France"]);
  });

  it("matches whole words only", () => {
    // Substring matching would tag every "scandinavian design" thread, and a
    // region facet full of noise is worse than one with gaps.
    expect(matchRegions("Cooking with paprika", gazetteer)).toEqual([]);
    expect(matchRegions("My six year old is looking for gaming buddies", gazetteer)).toEqual([]);
  });

  it("is empty rather than wrong when there is no gazetteer", () => {
    expect(matchRegions("Minnesota!", parseGazetteer(null))).toEqual([]);
  });
});
