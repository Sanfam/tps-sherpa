import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Entity } from "./catalog.ts";
import { compareCoverage, parseOldIndex } from "./coverage.ts";

const entity = (id: string, name = "x"): Entity => ({
  id,
  type: "channel",
  name,
  url: `https://discord.com/channels/1/${id}`,
  parent_id: null,
  description_status: "present",
  topic: "something",
  applied_tags: [],
  region: [],
  last_message_id: null,
  last_activity_at: null,
  summary_generated: null,
  summary_override: null,
});

describe("parseOldIndex", () => {
  it("takes Entity IDs from the deep links, never the names", () => {
    // The names on that page are two years stale; the IDs are not.
    const md = `- [general](https://discord.com/channels/1055/111) General chat
-   [steam-deck-gaming](https://discord.com/channels/1055/222) Old name here`;
    expect(parseOldIndex(md)).toEqual([
      { id: "111", name: "general", hasDescription: true },
      { id: "222", name: "steam-deck-gaming", hasDescription: true },
    ]);
  });

  it("records an entry with no description, which the old page had plenty of", () => {
    const md = `- [All Things Food](https://discord.com/channels/1055/333)`;
    expect(parseOldIndex(md)[0]?.hasDescription).toBe(false);
  });

  it("collapses the old page's own duplicate listings by ID", () => {
    const md = `- [UK](https://discord.com/channels/1055/444) one
- [United Kingdom](https://discord.com/channels/1055/444) same thread, listed twice`;
    expect(parseOldIndex(md)).toHaveLength(1);
  });

  it("ignores links that are not Discord deep links", () => {
    const md = `- [the wiki](https://wiki.papasquad.xyz/) not an Entity`;
    expect(parseOldIndex(md)).toEqual([]);
  });

  it("parses the archived old index page", () => {
    // Reference material, not a gate: the page is two years stale and its
    // contents must never fail a build. This only checks the parser works.
    const real = readFileSync(
      new URL("../../../../docs/reference/old-index.md", import.meta.url),
      "utf8",
    );
    const parsed = parseOldIndex(real);
    expect(parsed.length).toBeGreaterThan(400);
    expect(parsed.every((e) => /^\d{17,20}$/.test(e.id))).toBe(true);
  });
});

describe("compareCoverage", () => {
  const ctx = { excluded: new Set<string>(), invisible: new Set<string>() };

  it("reports what the old page missed, which is the point of the exercise", () => {
    const report = compareCoverage(
      [{ id: "111", name: "general", hasDescription: true }],
      [entity("111"), entity("222"), entity("333")],
      ctx,
    );
    expect(report.covered).toEqual(["111"]);
    expect(report.added).toEqual(["222", "333"]);
  });

  it("attributes an absence to the exclusion list when that explains it", () => {
    const report = compareCoverage(
      [{ id: "111", name: "bot-tests", hasDescription: false }],
      [],
      { excluded: new Set(["111"]), invisible: new Set() },
    );
    expect(report.missing).toEqual([
      { id: "111", name: "bot-tests", reason: "excluded" },
    ]);
  });

  it("attributes an absence to permissions when the bot cannot see it", () => {
    const report = compareCoverage(
      [{ id: "111", name: "self-care", hasDescription: true }],
      [],
      { excluded: new Set(), invisible: new Set(["111"]) },
    );
    expect(report.missing[0]?.reason).toBe("not-visible");
  });

  it("flags an absence it cannot explain, which is the one worth attention", () => {
    const report = compareCoverage(
      [{ id: "111", name: "Disc Golf", hasDescription: true }],
      [],
      ctx,
    );
    expect(report.missing[0]?.reason).toBe("unexplained");
  });
});

describe("parseOldIndex — the bare-entry trap", () => {
  it("parses a name containing escaped brackets", () => {
    // `[^\]]+` stopped at the `]` of `\]`, dropping 7 real entries.
    const md = `- [Gris \\[Video Game Boom Club\\]](https://discord.com/channels/1055/111) About grief`;
    expect(parseOldIndex(md)[0]).toEqual({
      id: "111",
      name: "Gris [Video Game Boom Club]",
      hasDescription: true,
    });
  });

  it("does not let a bare entry swallow the next line as its description", () => {
    // `\s*` matches newlines. Using it here lost 17 real entries and marked
    // 16 undescribed ones as described.
    const md = `- [All Things Food](https://discord.com/channels/1055/111)
- [Bluey](https://discord.com/channels/1055/222) The best cartoon?`;
    const parsed = parseOldIndex(md);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ id: "111", name: "All Things Food", hasDescription: false });
    expect(parsed[1]?.hasDescription).toBe(true);
  });

  it("finds the bare entries on the archived page that the bug hid", () => {
    const real = readFileSync(
      new URL("../../../../docs/reference/old-index.md", import.meta.url),
      "utf8",
    );
    const parsed = parseOldIndex(real);
    expect(parsed.length).toBe(746);
    expect(parsed.filter((e) => !e.hasDescription).length).toBe(11);
  });
});
