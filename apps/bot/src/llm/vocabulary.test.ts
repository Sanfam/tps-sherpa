import { describe, expect, it } from "vitest";
import type { Entity } from "../sync/catalog.ts";
import {
  restrictTo,
  consensus,
  consensusKey,
  parseVocabulary,
  stratify,
  type Topic,
} from "./vocabulary.ts";

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

const topic = (slug: string): Topic => ({
  slug,
  label: slug,
  description: `things about ${slug}`,
});

/** A gaming-heavy corpus: one Forum holding most of it, three small ones. */
const skewedCatalog = [
  entity({ id: "100", name: "game-talk", type: "forum" }),
  entity({ id: "200", name: "board-games", type: "forum" }),
  entity({ id: "300", name: "parenting", type: "channel" }),
  ...Array.from({ length: 40 }, (_, i) =>
    entity({ id: `1${String(i).padStart(4, "0")}0`, name: `game ${i}`, parent_id: "100" }),
  ),
  ...Array.from({ length: 4 }, (_, i) =>
    entity({ id: `2${String(i).padStart(4, "0")}0`, name: `board ${i}`, parent_id: "200" }),
  ),
];

describe("stratify", () => {
  it("caps the dominant stratum so it cannot set the vocabulary alone", () => {
    const { sample } = stratify(skewedCatalog, { perStratum: 5 });

    // A Forum shares a stratum with its own Posts, so five means the Forum
    // plus four of its forty Posts.
    expect(sample.filter((e) => e.id === "100" || e.parent_id === "100")).toHaveLength(5);
    expect(sample.filter((e) => e.parent_id === "200")).toHaveLength(4);
  });

  it("always takes the container itself, not only its children", () => {
    // Channels and Forums are the guild's top-level subjects. A vocabulary
    // derived from Posts alone would miss what their parents are called.
    const { sample } = stratify(skewedCatalog, { perStratum: 5 });

    expect(sample.map((e) => e.id)).toEqual(expect.arrayContaining(["100", "200", "300"]));
  });

  it("reports the corpus skew rather than leaving it to be assumed absent", () => {
    const { corpus, sample_skew } = stratify(skewedCatalog, { perStratum: 5 });

    // 41 of 47 Entities are one Forum and its Posts.
    expect(corpus.largest.stratum).toBe("100");
    expect(corpus.largest.share).toBeCloseTo(41 / 47, 3);
    // The cap is only worth having if it actually moves that number.
    expect(sample_skew.largest.share).toBeLessThan(corpus.largest.share);
  });

  it("spreads its picks across a stratum instead of taking the oldest", () => {
    // IDs are chronological, so the first five Posts in a five-year-old Forum
    // are all from its first week and describe what it used to be about.
    const { sample } = stratify(skewedCatalog, { perStratum: 5 });

    const picked = sample.filter((e) => e.parent_id === "100").map((e) => e.id);
    expect(picked).not.toEqual(["100000", "100010", "100020", "100030", "100040"]);
  });

  it("samples the same Entities on a re-run", () => {
    const once = stratify(skewedCatalog, { perStratum: 5 }).sample.map((e) => e.id);
    const twice = stratify([...skewedCatalog].reverse(), { perStratum: 5 }).sample.map(
      (e) => e.id,
    );

    expect(twice).toEqual(once);
  });

  it("excludes what the caller says it must never see", () => {
    const { sample } = stratify(skewedCatalog, {
      perStratum: 5,
      exclude: (e) => e.parent_id === "100",
    });

    expect(sample.some((e) => e.parent_id === "100")).toBe(false);
  });
});

describe("consensus", () => {
  it("keeps only what every independent run proposed", () => {
    const { topics } = consensus([
      [topic("board-games"), topic("aviation"), topic("faith")],
      [topic("board-games"), topic("aviation")],
      [topic("board-games"), topic("aviation"), topic("cooking")],
    ]);

    expect(topics.map((t) => t.slug)).toEqual(["aviation", "board-games"]);
  });

  it("does not lose a tag to plural drift between runs", () => {
    const { topics } = consensus([[topic("board-game")], [topic("board-games")]]);

    expect(topics).toHaveLength(1);
  });

  it("keeps `fitness` out of the de-pluralising", () => {
    expect(consensusKey("fitness")).toBe("fitness");
  });

  it("pools every distinct candidate, which is the ballot the votes run over", () => {
    // Free-form derivations disagree on naming far more than on concepts, so
    // the pool exists to turn the second round into a choice from one list.
    const { pool } = consensus([[topic("aviation"), topic("faith")], [topic("aviations")]]);

    expect(pool.map((t) => t.slug)).toEqual(["aviation", "faith"]);
  });

  it("reports the near-misses, which are what a reviewer argues about", () => {
    const { agreement } = consensus([
      [topic("aviation"), topic("faith")],
      [topic("aviation"), topic("faith")],
      [topic("aviation")],
    ]);

    expect(agreement).toContainEqual({ key: "faith", label: "faith", runs: 2 });
  });
});

describe("restrictTo", () => {
  it("refuses a tag the critique invented", () => {
    const warnings: string[] = [];

    const final = restrictTo(
      [topic("aviation"), topic("faith")],
      [topic("aviation"), topic("cryptocurrency")],
      (m) => warnings.push(m),
    );

    expect(final.map((t) => t.slug)).toEqual(["aviation"]);
    expect(warnings[0]).toContain("cryptocurrency");
  });

  it("treats a near-miss slug as a choice, not a rename", () => {
    const final = restrictTo([topic("board-games")], [topic("board-game")]);

    expect(final.map((t) => t.slug)).toEqual(["board-games"]);
  });

  it("lets the critique reword what consensus produced", () => {
    const final = restrictTo(
      [topic("aviation")],
      [{ slug: "aviation", label: "Aviation & Flying", description: "Pilots and planes." }],
    );

    expect(final[0]).toEqual({
      slug: "aviation",
      label: "Aviation & Flying",
      description: "Pilots and planes.",
    });
  });
});

describe("parseVocabulary", () => {
  const frozen = {
    version: 1,
    frozen_at: "2026-09-03",
    status: "frozen",
    topics: [topic("aviation")],
  };

  it("accepts a frozen, versioned vocabulary", () => {
    expect(parseVocabulary(JSON.stringify(frozen)).version).toBe(1);
  });

  it("refuses a vocabulary that has not passed human review", () => {
    expect(() =>
      parseVocabulary(JSON.stringify({ ...frozen, status: "proposed" })),
    ).toThrow(/not "frozen"/);
  });

  it.each([
    ["no status at all", { status: undefined }],
    ["a null status", { status: null }],
    ["a misspelled status", { status: "freeze" }],
    ["a status nobody has defined", { status: "reviewed" }],
  ])("refuses %s rather than reading it as reviewed", (_name, override) => {
    // A gate that opens for everything it does not recognise is not a gate.
    expect(() => parseVocabulary(JSON.stringify({ ...frozen, ...override }))).toThrow(
      /not "frozen"/,
    );
  });

  it.each([
    ["no date", { frozen_at: undefined }],
    ["a null date", { frozen_at: null }],
    ["something that is not a date", { frozen_at: "soon" }],
  ])("refuses a vocabulary marked frozen with %s", (_name, override) => {
    // A freeze is an event. Without a date there is no telling a reviewed
    // vocabulary from a file someone typed the word "frozen" into.
    const { frozen_at, ...rest } = frozen;
    expect(() => parseVocabulary(JSON.stringify({ ...rest, ...override }))).toThrow(
      /frozen_at/,
    );
  });

  it("refuses an absent vocabulary rather than deriving one on the fly", () => {
    expect(() => parseVocabulary(null)).toThrow(/never derive one on the fly/);
  });

  it("refuses one with no version, because a retag depends on it", () => {
    const { version, ...unversioned } = frozen;
    expect(() => parseVocabulary(JSON.stringify(unversioned))).toThrow(/version/);
  });

  it("refuses a slug that is not the kebab-case key the Catalog will store", () => {
    expect(() =>
      parseVocabulary(
        JSON.stringify({ ...frozen, topics: [{ ...topic("x"), slug: "Board Games" }] }),
      ),
    ).toThrow(/kebab-case/);
  });
});
