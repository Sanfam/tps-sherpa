import { describe, expect, it } from "vitest";
import type { Entity } from "../sync/catalog.ts";
import { nativeTopics, needsClassifying, parseTags, reconcile } from "./classify.ts";
import type { Vocabulary } from "./vocabulary.ts";

const entity = (over: Partial<Entity> & { id: string; name: string }): Entity => ({
  type: "post",
  url: `https://discord.com/channels/1/${over.id}`,
  parent_id: null,
  description_status: "present",
  topic: null,
  applied_tags: [],
  region: [],
  topics: [],
  topics_version: null,
  last_message_id: null,
  last_activity_at: null,
  summary_generated: null,
  summary_override: null,
  ...over,
});

const vocabulary: Vocabulary = {
  version: 3,
  frozen_at: "2026-09-03",
  status: "frozen",
  topics: [
    { slug: "pc-gaming", label: "PC Gaming", description: "Games on a PC." },
    { slug: "board-games", label: "Board Games", description: "Tabletop games." },
    { slug: "aviation", label: "Aviation", description: "Flying, real and simulated." },
  ],
};

describe("needsClassifying", () => {
  it("takes anything not tagged under the current version", () => {
    expect(needsClassifying(entity({ id: "1", name: "x" }), vocabulary)).toBe(true);
  });

  it("leaves an Entity already tagged under the current version alone", () => {
    const done = entity({ id: "1", name: "x", topics: ["aviation"], topics_version: 3 });

    expect(needsClassifying(done, vocabulary)).toBe(false);
  });

  it("makes a version bump a full retag rather than a silent drift", () => {
    const old = entity({ id: "1", name: "x", topics: ["aviation"], topics_version: 2 });

    expect(needsClassifying(old, vocabulary)).toBe(true);
  });
});

describe("parseTags", () => {
  it("skips a tag outside the vocabulary and logs it, never creating one", () => {
    const warnings: string[] = [];

    const tags = parseTags({ topics: ["aviation", "cozy-games"] }, vocabulary, (m) =>
      warnings.push(m),
    );

    expect(tags).toEqual(["aviation"]);
    expect(warnings[0]).toContain("cozy-games");
  });

  it("refuses an answer that is not a list of tags at all", () => {
    expect(() => parseTags({ summary: "nope" }, vocabulary)).toThrow(/No topics array/);
  });

  it("deduplicates and sorts, so a re-run produces no diff", () => {
    expect(parseTags({ topics: ["board-games", "aviation", "Board Games"] }, vocabulary)).toEqual([
      "aviation",
      "board-games",
    ]);
  });
});

describe("nativeTopics", () => {
  it("reads a Topic out of a mod's own Forum tag that names it", () => {
    const post = entity({ id: "1", name: "Wingspan", applied_tags: ["Board Game"] });

    expect(nativeTopics(post, vocabulary.topics)).toEqual(["board-games"]);
  });

  it("does not read a Topic out of one word of its slug", () => {
    // #22: `sports` claimed `sports-and-outdoors` for a politics Post, and
    // `home` claimed `home-and-diy` for a movie night. A tag naming part of a
    // Topic says nothing about the rest of it.
    const post = entity({ id: "1", name: "Politics", applied_tags: ["sports", "PC", "gaming"] });

    expect(nativeTopics(post, vocabulary.topics)).toEqual([]);
  });

  it("invents no correspondence where the two facets do not overlap", () => {
    // Platform is a separate axis and stays in applied_tags. A mod tag that
    // maps to no Topic is not a gap to be filled by guessing.
    const post = entity({ id: "1", name: "Halo", applied_tags: ["Xbox"] });

    expect(nativeTopics(post, vocabulary.topics)).toEqual([]);
  });
});

describe("reconcile", () => {
  it("keeps the mod's tag when the model contradicts it, and logs the disagreement", () => {
    const warnings: string[] = [];
    const post = entity({ id: "1", name: "Microsoft Flight Simulator", applied_tags: ["Aviation"] });

    const tags = reconcile(post, ["pc-gaming"], vocabulary, (m) => warnings.push(m));

    expect(tags).toEqual(["aviation", "pc-gaming"]);
    expect(warnings[0]).toContain("aviation");
    expect(warnings[0]).toContain("Keeping the mod's tag");
  });

  it("says nothing when the model and the mod agree", () => {
    const warnings: string[] = [];
    const post = entity({ id: "1", name: "Microsoft Flight Simulator", applied_tags: ["Aviation"] });

    reconcile(post, ["aviation"], vocabulary, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
  });

  it("adds a coarse core tag wherever a tag it covers is present", () => {
    const withUmbrella: Vocabulary = {
      ...vocabulary,
      topics: [
        ...vocabulary.topics,
        { slug: "music", label: "Music", description: "Music." },
        { slug: "entertainment", label: "Entertainment", description: "Media." },
      ],
    };
    const post = entity({ id: "1", name: "Album of the week" });

    expect(reconcile(post, ["music"], withUmbrella)).toEqual(["entertainment", "music"]);
    expect(reconcile(post, ["aviation"], withUmbrella)).toEqual(["aviation"]);
    // Not conjured into a vocabulary that does not carry it.
    const without = { ...withUmbrella, topics: withUmbrella.topics.filter((t) => t.slug !== "entertainment") };
    expect(reconcile(post, ["music"], without)).toEqual(["music"]);
  });

  it("keeps model tags the mod said nothing about, because they are additive", () => {
    const post = entity({ id: "1", name: "Wingspan", applied_tags: [] });

    expect(reconcile(post, ["board-games"], vocabulary)).toEqual(["board-games"]);
  });
});
