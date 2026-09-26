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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import type { Entity } from "../sync/catalog.ts";
import { isMonitored, DEFAULT_MONITORED_CHANNELS } from "../sync/tier0.ts";
import { subjectText } from "./subject.ts";
import {
  MANDATORY_TOPICS,
  consensus,
  consensusKey,
  mergeGroups,
  restrictTo,
  slugify,
  type Topic,
  stratify,
  withMandatory,
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
 * Handed to every round. A model that does not know a subject is already
 * covered spends slots re-proposing it, and the ballot then splits between the
 * fixed tag and its accidental twin.
 */
const FIXED = [
  "These tags are already fixed and will be in the final vocabulary:",
  ...MANDATORY_TOPICS.map((t) => `${t.slug}: ${t.description}`),
  "Propose tags that COMPLEMENT these. Do not propose a tag that covers the same ground.",
].join("\n");
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
// Undefined means the square-root allocation, which is the default and what
// this normally wants. Passing a number forces a uniform cap instead — an
// experiment, and the one that produced a vocabulary describing the guild's
// structure rather than its content.
const perStratumFlag = flag("per-stratum");
// Presence, not truthiness. `--per-stratum 0` and `--per-stratum abc` are both
// falsy, and treating them as absent would silently run the square-root
// allocation while the operator believed they had forced a uniform cap. A
// negative reaches Array.from with a negative length and empties the stratum,
// defeating the one invariant stratification actually promises.
const perStratum = perStratumFlag === null ? undefined : Number(perStratumFlag);
if (perStratum !== undefined && (!Number.isInteger(perStratum) || perStratum < 1))
  throw new Error(
    `--per-stratum must be a positive integer. Got ${JSON.stringify(perStratumFlag)}.`,
  );

/**
 * Where interrupted runs leave their finished stages.
 *
 * This pipeline makes ten model calls and takes half an hour, and the
 * provider's latency on the heavy prompts is a lottery: five consecutive runs
 * died at a different stage each time — a derivation, a ballot, the critique,
 * the merge — and each took every completed stage down with it. Resuming turns
 * an all-or-nothing half hour into incremental progress.
 *
 * Disposable, like Tier 0. Deleted on success, so a *completed* run never
 * serves yesterday's answer to someone asking for a fresh derivation; only an
 * interrupted one resumes. `--fresh` ignores it entirely.
 */
const CACHE_DIR = resolvePath(import.meta.dirname, "../../.data/vocab-bootstrap");
const fresh = flag("fresh") !== null;

const catalog = loadCatalog();
const byId = new Map(catalog.map((e) => [e.id, e]));
const monitored = new Set(DEFAULT_MONITORED_CHANNELS);

// Monitored conversation must never reach a model. The boundary would refuse
// it anyway; excluding it here means the command completes rather than dying
// three calls in, and keeps the sample honest about what it covers.
const { sample, corpus, sample_skew } = stratify(catalog, {
  ...(perStratum ? { perStratum } : {}),
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
console.log(
  `Sample : ${sample.length} Entities, ` +
    (perStratum ? `uniform cap ${perStratum} per stratum` : `sqrt(size) per stratum`),
);
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
/**
 * A stage resumes only if what it would send is byte-identical to what the
 * cached answer was produced from: the model, the prompt and the context.
 * Anything coarser splices two runs together and calls the result consensus —
 * the same sample size over reworded descriptions, or an edited prompt, would
 * both have matched a signature of counts. Keying on the inputs also chains the
 * stages: a fresh derivation changes the pooled list, which changes the merge's
 * input, which invalidates every stage after it without any bookkeeping.
 */
const checkpoint = async <T>(
  name: string,
  inputs: string[],
  work: () => Promise<T>,
): Promise<T> => {
  const path = join(CACHE_DIR, `${name}.json`);
  const signature = createHash("sha256")
    .update(JSON.stringify([models.strong, ...inputs]))
    .digest("hex");
  const cached = readIfPresent(path);
  if (cached) {
    const held = JSON.parse(cached) as { signature: string; value: T };
    if (held.signature === signature) {
      console.log(`  ${name}: resumed from cache`);
      return held.value;
    }
  }
  const value = await work();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify({ signature, value }));
  return value;
};
// `--fresh` discards the cache up front rather than skipping reads, so an
// interrupted fresh run leaves only its own stages behind to resume from.
if (fresh) rmSync(CACHE_DIR, { recursive: true, force: true });

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

${FIXED}

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
- Group synonyms and near-synonyms: "books-and-comic" and "books-and-reading" are one tag.
- **Group to comparable breadth.** Where one subject arrives as several narrow candidates ("board-game", "tabletop-rpg", "card-games") and its neighbours arrive as one broad candidate each ("video-games"), the narrow ones belong together — otherwise the subject is split across several ballot lines and loses a vote it should have won.
- When a group is broader than its canonical slug's description, give the group a "description" that covers every member. Otherwise the members' subjects disappear before anyone votes on them.
- Leave a tag out entirely if nothing else means the same thing.

Reply with JSON: {"groups": [{"canonical": slug, "members": [slug, ...], "description"?: string}]}`;

const BALLOT = `You are choosing the Topic vocabulary for a Discord community's catalog.

You are given every tag that ${runs} independent derivations of the same corpus proposed, and the corpus sample itself.

${FIXED}

Choose the ${TARGET_TOPICS} that best cover what those fixed tags do not.

Rules:
- Choose ONLY from the candidate list. Copy each slug exactly.
- Where two candidates mean the same thing, choose the better-named one and leave the other.
- Prefer coverage: ${TARGET_TOPICS} tags that between them describe most of the sample beat ${TARGET_TOPICS} good tags that describe a third of it.
- Reject catch-alls. A tag that could hold anything sorts nothing.

Reply with JSON: {"topics": [slug, ...]} — slugs only, copied exactly. You are choosing from a list, not rewriting it.`;

const CRITIQUE = `You are critiquing a candidate Topic vocabulary for a Discord community's catalog.

These tags survived consensus: every one of ${runs} independent voting rounds chose them.

${FIXED}
They are NOT in the list below and are added after you answer, so never report them as gaps.

Return only what you would CHANGE. Most tags should need nothing.

You may:
- drop a tag that is a catch-all, redundant with another, or too narrow to earn a slot
- reword a label or description for clarity, or to mark a boundary with a neighbouring tag

You may NOT add a tag. A tag the rounds did not agree on has no consensus behind it.

Reply with JSON:
{"drop": [slug, ...], "reword": [{"slug": string, "label": string, "description": string}], "notes": [string]}
Use empty arrays where you would change nothing. "notes" is for the human reviewer: what you dropped and why, and any gap the vocabulary cannot cover.`;

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
    // Type-checked, not truthiness-checked: an object label passes `!label`
    // and then reaches the proposal as "[object Object]".
    if (typeof label !== "string" || !label || typeof description !== "string" || !description)
      throw new Error(`Topic missing label or description: ${JSON.stringify(t)}`);
    if (slug !== undefined && typeof slug !== "string")
      throw new Error(`Topic slug is not a string: ${JSON.stringify(t)}`);
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
  const topics = await checkpoint(`derive-${run}`, [DERIVE, corpusText], () =>
    retrying(
      () =>
        boundary.ask({
          role: "strong",
          system: DERIVE,
          subject: sample,
          context: corpusText,
          parse: parseTopics,
        }),
      (m) => console.warn(m),
    ),
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
const mergeContext = raw.map((t) => `${t.slug}: ${t.description}`).join("\n");
const merges = await checkpoint("merge", [MERGE, mergeContext], () =>
  retrying(
    () =>
      boundary.ask({
        role: "strong",
        system: MERGE,
        subject: sample,
        context: mergeContext,
        parse: (value) => {
          const groups = (value as { groups?: unknown }).groups;
          if (!Array.isArray(groups))
            throw new Error(`No groups in ${JSON.stringify(value).slice(0, 200)}`);
          return groups as Array<{ canonical: string; members?: string[]; description?: string }>;
        },
      }),
    (m) => console.warn(m),
  ),
);
const pool = mergeGroups(raw, merges, (m) => console.warn(m));
const ballotText = pool.map((t) => `${t.slug}: ${t.label} — ${t.description}`).join("\n");
const ballotContext = [`Candidates:`, ballotText, "", "Entries to cover:", corpusNames].join("\n");
console.log(`Merged: ${raw.length} candidates folded into ${pool.length} concepts`);

console.log(`Voting: ${runs} independent rounds over that one list`);
const votingStarted = Date.now();
const ballots: Topic[][] = [];
for (let round = 1; round <= runs; round++) {
  const picked = await checkpoint(`ballot-${round}`, [BALLOT, ballotContext], () =>
    retrying(
      () =>
        boundary.ask({
          role: "strong",
          system: BALLOT,
          subject: sample,
          context: ballotContext,
          parse: parseSlugs,
        }),
      (m) => console.warn(m),
    ),
  );
  // Slugs back into the pool's own topics: a ballot chooses, it does not
  // author, so the label and description stay exactly as the pool has them.
  ballots.push(
    restrictTo(
      pool,
      picked.map((slug: string) => ({ slug, label: "", description: "" })),
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

interface Critique {
  drop: string[];
  reword: Topic[];
  notes: string[];
}

/**
 * The critique is the last call in a run that takes half an hour, and it is
 * advisory: consensus has already chosen the tags. Losing the whole derivation
 * because the final polish timed out is the most expensive possible way to
 * fail. It degrades to "no changes", says so loudly, and records it in the
 * proposal so the reviewer knows the polish did not happen.
 */
const critiqueContext = [
  "Candidate vocabulary:",
  ...agreed.map((t) => `${t.slug}: ${t.label} — ${t.description}`),
  "",
  "Entries to cover:",
  corpusNames,
].join("\n");
let critique: Critique = { drop: [], reword: [], notes: [] };
let critiqueStatus: "applied" | "failed" = "applied";
try {
  critique = await checkpoint("critique", [CRITIQUE, critiqueContext], () =>
    retrying(
      () =>
        boundary.ask({
          role: "strong",
          system: CRITIQUE,
          subject: sample,
          context: critiqueContext,
          // Strict. Coercing a missing field to an empty array turns "the model
          // answered the wrong schema" into "the critique found nothing to
          // change" — the exact reading that lets someone freeze a vocabulary
          // believing a review ran. A wrong shape must reach the retry, and
          // then the recorded failure.
          parse: (value): Critique => {
            const v = value as Record<string, unknown>;
            for (const field of ["drop", "reword", "notes"] as const)
              if (!Array.isArray(v[field]))
                throw new Error(
                  `Critique is missing "${field}" as an array: ${JSON.stringify(value).slice(0, 160)}`,
                );
            return {
              drop: (v["drop"] as unknown[]).map((d) => {
                if (typeof d !== "string")
                  throw new Error(`Critique drop entry is not a slug: ${JSON.stringify(d)}`);
                return slugify(d);
              }),
              reword: (v["reword"] as unknown[]).length
                ? parseTopics({ topics: v["reword"] })
                : [],
              notes: (v["notes"] as unknown[]).map((n) => {
                if (typeof n !== "string")
                  throw new Error(`Critique note is not a string: ${JSON.stringify(n)}`);
                return n;
              }),
            };
          },
        }),
      (m) => console.warn(m),
    ),
  );
} catch (error) {
  console.warn(
    `[vocabulary] critique pass failed (${(error as Error).message.slice(0, 120)}). ` +
      `Keeping the consensus set unchanged and recording that it was not critiqued.`,
  );
  critiqueStatus = "failed";
  critique = {
    drop: [],
    reword: [],
    notes: ["CRITIQUE PASS FAILED — this set was not reviewed by it."],
  };
}

// Drops and rewords only — a diff cannot add a tag, which is the invariant the
// previous shape had to be policed for.
//
// Resolved through `consensusKey` like everything else in this pipeline. An
// exact-slug match would silently ignore a critique asking to drop `movie`
// when the candidate is `movies`, and then still record it as dropped, which
// is worse than ignoring it: the proposal would describe a before/after state
// that never happened.
const canonical = new Map(agreed.map((t) => [consensusKey(t.slug), t.slug]));
const resolve = (slug: string, what: string): string | null => {
  const found = canonical.get(consensusKey(slug));
  if (!found)
    console.warn(
      `[vocabulary] critique tried to ${what} "${slug}", which is not one of ` +
        `the ${agreed.length} tags it was given. Ignored.`,
    );
  return found ?? null;
};
const dropped = new Set(
  critique.drop.map((d) => resolve(d, "drop")).filter((d): d is string => d !== null),
);
const reworded = new Map(
  critique.reword.flatMap((t) => {
    const slug = resolve(t.slug, "reword");
    return slug ? [[slug, { ...t, slug }] as const] : [];
  }),
);

const critiqued = restrictTo(
  agreed,
  agreed.filter((t) => !dropped.has(t.slug)).map((t) => reworded.get(t.slug) ?? t),
  (m) => console.warn(m),
);
// Mandatory tags go in last and unconditionally: they are a decision about
// what this community is, not a finding about what the sample contains.
const final = withMandatory(critiqued);
console.log(
  `\nAfter critique: ${critiqued.length} derived + ${MANDATORY_TOPICS.length} mandatory = ${final.length} tags`,
);

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
    allocation: perStratum ? `uniform cap ${perStratum}` : "sqrt(size)",
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
    mandatory: MANDATORY_TOPICS.map((t) => t.slug),
    superseded_by_mandatory: critiqued
      .filter((t) => !final.some((f) => f.slug === t.slug))
      .map((t) => t.slug),
    critique_status: critiqueStatus,
    // Derived from what actually changed, not from what was asked for.
    dropped_by_critique: agreed
      .filter((t) => !critiqued.some((c) => c.slug === t.slug))
      .map((t) => t.slug),
    reworded_by_critique: critiqued
      .filter((c) => {
        const before = agreed.find((t) => t.slug === c.slug);
        return before && (before.label !== c.label || before.description !== c.description);
      })
      .map((c) => c.slug),
    critique_notes: critique.notes,
  },
};

writeFileSync(outPath, `${JSON.stringify(proposal, null, 2)}\n`);
// A completed run leaves no cache: the next invocation is a genuine fresh
// derivation, not a replay of this one.
rmSync(CACHE_DIR, { recursive: true, force: true });
console.log(`\nProposal: ${outPath}`);
console.log(
  `\nHuman checkpoint. Read the ${final.length} tags, then to freeze:\n` +
    `  set "status": "frozen" and "frozen_at", move it to ${VOCABULARY_PATH}, commit.\n` +
    `Nothing classifies until you do — a proposal is refused by the parser.`,
);
