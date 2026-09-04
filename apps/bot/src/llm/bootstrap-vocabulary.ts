/**
 * Derives a Topic vocabulary, once, and stops at the human review checkpoint.
 *
 *   node --env-file=.env src/llm/bootstrap-vocabulary.ts [--runs 4] [--per-stratum 5]
 *                                                        [--model <id>] [--out <path>]
 *
 * It writes a **proposal**, never the frozen vocabulary. Freezing is a person
 * reading ~20 tags for ten minutes, changing `status` to `frozen`, and
 * committing the file. That is the whole gate, and it is deliberately not
 * something this command can do on its own: everything downstream inherits
 * this vocabulary, and a tag set nobody read is a tag set nobody can defend.
 *
 * Re-running is safe. It overwrites the proposal and never touches
 * `content/config/topics.json`.
 */
import { writeFileSync } from "node:fs";
import type { Entity } from "../sync/catalog.ts";
import { isMonitored, DEFAULT_MONITORED_CHANNELS } from "../sync/tier0.ts";
import { subjectText } from "./subject.ts";
import {
  consensus,
  mergeGroups,
  restrictTo,
  slugify,
  type Topic,
  stratify,
} from "./vocabulary.ts";
import {
  VOCABULARY_PATH,
  VOCABULARY_PROPOSAL_PATH,
  flag,
  loadCatalog,
  openBoundary,
  readIfPresent,
  retrying,
} from "./session.ts";

const TARGET_TOPICS = 20;
/**
 * Three, because with one run every tag is unanimous by definition and the
 * word "consensus" would be describing nothing. The method calls for 3–5
 * independent runs, so the floor is where the method puts it — a `--runs 1`
 * proposal that reads as reviewed-and-agreed is worse than no proposal.
 */
const MIN_RUNS = 3;
// `--out` exists so two candidate models can be derived side by side without
// overwriting each other. It cannot be pointed at the frozen vocabulary.
const outPath = flag("out") || VOCABULARY_PROPOSAL_PATH;
if (outPath === VOCABULARY_PATH)
  throw new Error(
    `This command writes proposals. Freezing ${VOCABULARY_PATH} is a human ` +
      `act, not a --out argument.`,
  );
const runs = Number(flag("runs") || 4);
if (!Number.isInteger(runs) || runs < MIN_RUNS)
  throw new Error(
    `--runs must be an integer of at least ${MIN_RUNS}. Consensus across ` +
      `fewer than that is not consensus; it is one opinion with a quorum of one.`,
  );
const perStratum = Number(flag("per-stratum") || 5);

const catalog = loadCatalog();
const byId = new Map(catalog.map((e) => [e.id, e]));
const monitored = new Set(DEFAULT_MONITORED_CHANNELS);

// Monitored conversation must never reach a model. The boundary would refuse
// it anyway; excluding it here means the command completes rather than dying
// three calls in, and keeps the sample honest about what it covers.
const { sample, corpus, sample_skew } = stratify(catalog, {
  perStratum,
  exclude: (e: Entity) =>
    isMonitored(e, byId, monitored) || e.description_status === "withheld",
});

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
const nameOf = (id: string) => byId.get(id)?.name ?? id;

console.log(`Corpus : ${corpus.entities} Entities in ${corpus.strata} strata`);
console.log(
  `         largest stratum "${nameOf(corpus.largest.stratum)}" holds ` +
    `${corpus.largest.count} (${pct(corpus.largest.share)})`,
);
console.log(`Sample : ${sample.length} Entities, capped at ${perStratum} per stratum`);
console.log(
  `         largest stratum now ${sample_skew.largest.count} ` +
    `(${pct(sample_skew.largest.share)}) — the skew the cap removes`,
);

if (readIfPresent(VOCABULARY_PATH))
  console.warn(
    `\n[vocabulary] A frozen vocabulary already exists at ${VOCABULARY_PATH}. ` +
      `This run does not touch it. Replacing a frozen vocabulary is a ` +
      `deliberate global act: bump its version and retag the whole corpus.`,
  );

/**
 * Seven minutes per call. This is the heaviest prompt in the project and a
 * single derivation was measured at 205s answering properly, so the 180s
 * default was aborting work that was going to succeed.
 */
const BOOTSTRAP_TIMEOUT_MS = 420_000;
const { boundary, models } = openBoundary(
  catalog,
  { strong: flag("model") ?? undefined },
  BOOTSTRAP_TIMEOUT_MS,
);
const corpusText = sample.map((e) => subjectText(e, byId)).join("\n---\n");
/**
 * The same sample as names only, for the rounds that come after derivation.
 *
 * Coverage is judged on what a tag has to describe, and by this point the
 * descriptions have already done their work — they shaped the candidates. Re-
 * sending them costs about 4k tokens per call on the two heaviest prompts in
 * the pipeline, which is what was timing the ballot out at seven minutes.
 */
const corpusNames = sample.map((e) => e.name).join("\n");

const DERIVE = `You are deriving the Topic vocabulary for a Discord community's catalog.
You are given a stratified sample of catalog entries: channels, forums, posts and threads.

Propose exactly ${TARGET_TOPICS} topic tags that between them cover the sample.

Rules:
- A tag names a SUBJECT a member would filter on. Not a format, not a place, not an activity level.
- Tags must be comparable in breadth. "gaming" and "helldivers-2" cannot both be tags.
- No catch-alls. "misc", "other", "general", "hobbies", "community" and anything named "general-<x>" are forbidden: a tag that could hold anything sorts nothing.
- No tag may cover more than about a third of the sample. Split it instead.
- Slugs are kebab-case and singular where that reads naturally.

Reply with JSON: {"topics": [{"slug": string, "label": string, "description": string}]}
The description says what belongs under the tag and what does not, in one sentence.`;

const MERGE = `You are tidying a list of candidate topic tags before they are voted on.

${runs} independent derivations of the same corpus produced these tags. Many of them are the same idea under different names.

Group the candidates that mean the same thing. For each group, name the clearest slug as canonical.

Rules:
- Use only slugs from the list, copied exactly.
- Group only true synonyms and near-synonyms. "board-game" and "tabletop-rpg" are different things; "books-and-comic" and "books-and-reading" are not.
- Leave a tag out entirely if nothing else means the same thing.

Reply with JSON: {"groups": [{"canonical": slug, "members": [slug, ...]}]}`;

const BALLOT = `You are choosing the Topic vocabulary for a Discord community's catalog.

You are given every tag that ${runs} independent derivations of the same corpus proposed, and the corpus sample itself.

Choose the ${TARGET_TOPICS} that best cover the sample.

Rules:
- Choose ONLY from the candidate list. Copy each slug exactly.
- Where two candidates mean the same thing, choose the better-named one and leave the other.
- Prefer coverage: ${TARGET_TOPICS} tags that between them describe most of the sample beat ${TARGET_TOPICS} good tags that describe a third of it.
- Reject catch-alls. A tag that could hold anything sorts nothing.

Reply with JSON: {"topics": [slug, ...]} — slugs only, copied exactly. You are choosing from a list, not rewriting it.`;

const CRITIQUE = `You are critiquing a candidate Topic vocabulary for a Discord community's catalog.

These tags survived consensus: every one of ${runs} independent voting rounds chose them. You are given them along with the sample they came from.

You may:
- drop a tag that is a catch-all, redundant with another, or too narrow to earn a slot
- merge two tags: keep one slug, fold the other's meaning into its description
- reword any label or description

You may NOT introduce a slug that is not in the candidate list. A tag the rounds did not agree on has no consensus behind it.

Reply with JSON: {"topics": [{"slug": string, "label": string, "description": string}], "notes": [string]}
"notes" is for the human reviewer: what you dropped and why, and any gap in the sample the vocabulary cannot cover.`;

/** A ballot answers with slugs. Everything else about a tag is already known. */
const parseSlugs = (value: unknown): string[] => {
  const topics = (value as { topics?: unknown }).topics;
  if (!Array.isArray(topics) || topics.length === 0)
    throw new Error(`No topics in ${JSON.stringify(value).slice(0, 200)}`);
  return topics.map((t) =>
    slugify(typeof t === "string" ? t : ((t as Partial<Topic>)?.slug ?? "")),
  );
};

const parseTopics = (value: unknown): Topic[] => {
  const topics = (value as { topics?: unknown }).topics;
  if (!Array.isArray(topics) || topics.length === 0)
    throw new Error(`No topics in ${JSON.stringify(value).slice(0, 200)}`);
  return topics.map((t) => {
    const { slug, label, description } = t as Partial<Topic>;
    if (!label || !description)
      throw new Error(`Topic missing label or description: ${JSON.stringify(t)}`);
    return { slug: slugify(slug || label), label, description };
  });
};

console.log(`\nDeriving: ${runs} independent runs on ${models.strong}`);
// One at a time. Running them together was quicker when the provider was idle
// and unreliable when it was not: four concurrent requests for a 2,000-token
// completion queue behind one another, and `Promise.all` then fails the whole
// derivation because one of them ran out of time. This job runs once. Wall
// clock is the cheapest thing it has to spend.
const started = Date.now();
const proposals: Topic[][] = [];
for (let run = 1; run <= runs; run++) {
  const each = Date.now();
  const topics = await retrying(
    () =>
      boundary.ask({
        role: "strong",
        system: DERIVE,
        subject: sample,
        context: corpusText,
        parse: parseTopics,
      }),
    (m) => console.warn(m),
  );
  proposals.push(topics);
  console.log(`  run ${run}: ${topics.length} tags (${Date.now() - each}ms)`);
}
console.log(`  ${runs} runs in ${Date.now() - started}ms`);

// Consensus runs over ballots, not over the derivations themselves. Four
// free-form derivations of this corpus agreed on 3 slugs out of 55 — they
// agreed on the concepts and disagreed on the words, which is a measurement of
// naming variance rather than of stability. Pooling first turns the second
// round into a choice from one list, where agreement means what it says.
const { pool: raw } = consensus(proposals);
console.log(`\nPooled: ${raw.length} distinct candidate tags`);

// Merge naming variants before anything votes on them, or the ballot splits
// across `books-and-comic` and `books-and-reading` and unanimity drops books
// from a corpus with a books Forum in it.
const merges = await retrying(
  () =>
    boundary.ask({
      role: "strong",
      system: MERGE,
      subject: sample,
      context: raw.map((t) => `${t.slug}: ${t.description}`).join("\n"),
      parse: (value) => {
        const groups = (value as { groups?: unknown }).groups;
        if (!Array.isArray(groups)) throw new Error(`No groups in ${JSON.stringify(value).slice(0, 200)}`);
        return groups as Array<{ canonical: string; members?: string[] }>;
      },
    }),
  (m) => console.warn(m),
);
const pool = mergeGroups(raw, merges, (m) => console.warn(m));
const ballotText = pool.map((t) => `${t.slug}: ${t.label} — ${t.description}`).join("\n");
console.log(`Merged: ${raw.length} candidates folded into ${pool.length} concepts`);

console.log(`Voting: ${runs} independent rounds over that one list`);
const votingStarted = Date.now();
const ballots: Topic[][] = [];
for (let round = 1; round <= runs; round++) {
  const picked = await retrying(
    () =>
      boundary.ask({
        role: "strong",
        system: BALLOT,
        subject: sample,
        context: [`Candidates:`, ballotText, "", "Entries to cover:", corpusNames].join("\n"),
        parse: parseSlugs,
      }),
    (m) => console.warn(m),
  );
  // Slugs back into the pool's own topics: a ballot chooses, it does not
  // author, so the label and description stay exactly as the pool has them.
  ballots.push(
    restrictTo(
      pool,
      picked.map((slug) => ({ slug, label: "", description: "" })),
      (m) => console.warn(m),
    ),
  );
}
console.log(
  `  ${ballots.map((b) => `${b.length} picks`).join(", ")} (${Date.now() - votingStarted}ms)`,
);

const { topics: agreed, agreement } = consensus(ballots);
console.log(`\nConsensus: ${agreed.length} of ${agreement.length} candidates were chosen by all ${runs} rounds`);
for (const a of agreement)
  console.log(`  ${a.runs}/${runs}  ${a.key}${a.runs === runs ? "" : "   (discarded)"}`);

if (agreed.length === 0)
  throw new Error(
    "No tag survived consensus. That is a finding, not a failure to work " +
      "around: the rounds disagree, and freezing any one of them would freeze " +
      "an accident.",
  );

const critique = await boundary.ask({
  role: "strong",
  system: CRITIQUE,
  subject: sample,
  context: [
    "Candidate vocabulary:",
    ...agreed.map((t) => `${t.slug}: ${t.label} — ${t.description}`),
    "",
    "Entries to cover:",
    corpusNames,
  ].join("\n"),
  parse: (value) => ({
    topics: parseTopics(value),
    notes: ((value as { notes?: unknown }).notes ?? []) as string[],
  }),
});

const final = restrictTo(agreed, critique.topics, (m) => console.warn(m));
console.log(`\nAfter critique: ${final.length} tags`);

const proposal = {
  version: 1,
  frozen_at: null,
  status: "proposed",
  topics: final,
  // Everything a reviewer needs to challenge the result, in the file itself.
  // A derivation whose provenance lives only in a terminal scrollback cannot
  // be argued with six months from now.
  review: {
    derived_at: new Date().toISOString(),
    model: models.strong,
    runs,
    per_stratum: perStratum,
    corpus: { ...corpus, largest: { ...corpus.largest, stratum: nameOf(corpus.largest.stratum) } },
    sample: {
      ...sample_skew,
      largest: { ...sample_skew.largest, stratum: nameOf(sample_skew.largest.stratum) },
    },
    pooled: raw.length,
    merged_to: pool.length,
    // What the single merge call folded together, spelled out. It runs once,
    // so a wrong merge removes a concept before any ballot can rescue it —
    // and this is the review checkpoint that catches it.
    merges: merges
      .filter((g) => (g.members ?? []).length > 0)
      .map((g) => `${g.canonical} ← ${(g.members ?? []).join(", ")}`),
    agreement,
    dropped_by_critique: agreed
      .filter((t) => !final.some((f) => f.slug === t.slug))
      .map((t) => t.slug),
    critique_notes: critique.notes,
  },
};

writeFileSync(outPath, `${JSON.stringify(proposal, null, 2)}\n`);
console.log(`\nProposal: ${outPath}`);
console.log(
  `\nHuman checkpoint. Read the ${final.length} tags, then to freeze:\n` +
    `  set "status": "frozen" and "frozen_at", move it to ${VOCABULARY_PATH}, commit.\n` +
    `Nothing classifies until you do — a proposal is refused by the parser.`,
);
