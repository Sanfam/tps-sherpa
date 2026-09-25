import { describe, expect, it } from "vitest";
import type { Entity } from "../sync/catalog.ts";
import {
  MANDATORY_TOPICS,
  restrictTo,
  consensus,
  consensusKey,
  mergeGroups,
  parseVocabulary,
  stratify,
  type Topic,
  withMandatory,
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

  it("lets a large stratum speak louder than a tiny one, without letting it speak alone", () => {
    // The failure this replaced: a uniform cap gave seven three-Entity
    // Channels more of the sample than one Forum holding 252 Entities, and
    // the vocabulary came back describing the guild's structure rather than
    // its content.
    const { sample, corpus } = stratify(skewedCatalog);
    const share = (s: Entity[]) =>
      s.filter((e) => e.id === "100" || e.parent_id === "100").length / s.length;

    // Louder than the small strata...
    const big = sample.filter((e) => e.id === "100" || e.parent_id === "100").length;
    expect(big).toBeGreaterThan(sample.filter((e) => e.parent_id === "200").length);
    // ...still quieter than its raw share of the corpus...
    expect(share(sample)).toBeLessThan(corpus.largest.share);
    // ...and louder than a uniform cap allowed, which is the whole change.
    expect(share(sample)).toBeGreaterThan(share(stratify(skewedCatalog, { perStratum: 5 }).sample));
  });

  it("takes ceil(sqrt(size)) from each stratum by default", () => {
    // Strata of 41, 5 and 1. No uniform cap produces 7, 3 and 1 — the relative
    // weights above would all pass under a cap of 6, which is the old shape.
    const { sample } = stratify(skewedCatalog);
    const from = (parent: string) =>
      sample.filter((e) => e.id === parent || e.parent_id === parent).length;

    expect([from("100"), from("200"), from("300")]).toEqual([7, 3, 1]);
  });

  it("never drops a stratum entirely, however small", () => {
    const { sample } = stratify(skewedCatalog);

    expect(sample.map((e) => e.id)).toContain("300");
  });

  it("keeps every stratum even when one dwarfs the rest", () => {
    // The invariant stratification actually promises. A cap of zero or a
    // negative would empty a stratum silently, which is why the CLI validates.
    const { sample } = stratify(skewedCatalog, { perStratum: 1 });

    expect(sample.map((e) => e.id).sort()).toEqual(["100", "200", "300"]);
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

describe("mergeGroups", () => {
  const pool = [topic("football"), topic("tennis"), topic("cycling"), topic("music")];

  it("folds members into the canonical and keeps what no group mentions", () => {
    const merged = mergeGroups(pool, [{ canonical: "football", members: ["tennis", "cycling"] }]);

    expect(merged.map((t) => t.slug)).toEqual(["football", "music"]);
  });

  it("lets a broadening group describe what it folded in", () => {
    // Keeping the canonical's own description sends `football ← tennis,
    // cycling` to the ballot as football alone.
    const merged = mergeGroups(pool, [
      { canonical: "football", members: ["tennis", "cycling"], description: "Any sport." },
    ]);

    expect(merged.find((t) => t.slug === "football")?.description).toBe("Any sport.");
  });
});

describe("withMandatory", () => {
  it("puts the mandatory tags in whatever the derivation produced", () => {
    const final = withMandatory([topic("video-games")]);

    expect(final.map((t) => t.slug)).toEqual(
      expect.arrayContaining(MANDATORY_TOPICS.map((t) => t.slug)),
    );
  });

  it("drops a derived tag that a mandatory one absorbs", () => {
    // Two tags covering the same ground is how a classifier ends up splitting
    // one subject at random. `relationships` reached 4/4 on a real derivation.
    const final = withMandatory([topic("relationships"), topic("video-games")]);

    expect(final.map((t) => t.slug)).not.toContain("relationships");
    expect(final.map((t) => t.slug)).toContain("video-games");
  });

  it("leads with the mandatory tags, because they are the decision", () => {
    const final = withMandatory([topic("video-games")]);

    expect(final[0]?.slug).toBe(MANDATORY_TOPICS[0]?.slug);
  });
});

describe("parseVocabulary", () => {
  const frozen = {
    version: 1,
    frozen_at: "2026-09-03",
    status: "frozen",
    topics: [topic("aviation"), ...MANDATORY_TOPICS.map(({ supersedes: _s, ...t }) => t)],
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

  it("refuses a vocabulary frozen without a mandatory tag", () => {
    // The point of the category is that it cannot be lost to a derivation that
    // did not happen to produce it — including by a hand-edit at review time.
    const without = { ...frozen, topics: [topic("aviation")] };

    expect(() => parseVocabulary(JSON.stringify(without))).toThrow(/mandatory/);
  });

  it("refuses a slug that is not the kebab-case key the Catalog will store", () => {
    expect(() =>
      parseVocabulary(
        JSON.stringify({ ...frozen, topics: [...frozen.topics, { ...topic("x"), slug: "Board Games" }] }),
      ),
    ).toThrow(/kebab-case/);
  });
});
