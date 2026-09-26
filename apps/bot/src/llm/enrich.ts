/**
 * The two steady-state LLM passes over the Catalog.
 *
 *   node --env-file=.env src/llm/enrich.ts topics    [--limit N] [--dry-run] [--model id]
 *   node --env-file=.env src/llm/enrich.ts summaries [--limit N] [--dry-run] [--model id]
 *
 * `--vocabulary <path>` classifies against a candidate instead of the frozen
 * one, so a reviewer can see what a proposed vocabulary actually does to the
 * corpus before freezing it. It still refuses anything marked `proposed`:
 * freeze a copy, try it, throw the copy away.
 *
 * Both read the committed Catalog and write back into it — no Discord call, so
 * a retag or a reword is a local reprocess. Both are incremental: an Entity
 * whose identity has not changed keeps what the last run produced (the sync
 * drops those fields when it does change), so a scheduled run does nothing and
 * costs nothing.
 *
 * `--limit` exists for the human review checkpoints. Read a sample before
 * spending a model on the whole corpus, and read the sample the corpus
 * produced rather than a sample of a run you have already paid for.
 */
import { writeFileSync } from "node:fs";
import type { Entity } from "../sync/catalog.ts";
import { DEFAULT_MONITORED_CHANNELS, isMonitored } from "../sync/tier0.ts";
import { classifySystemPrompt, needsClassifying, parseTags, reconcile } from "./classify.ts";
import {
  CATALOG_PATH,
  VOCABULARY_PATH,
  flag,
  loadCatalog,
  openBoundary,
  readIfPresent,
  retrying,
} from "./session.ts";
import { hasDescribableInput, subjectText } from "./subject.ts";
import { SUMMARY_SYSTEM_PROMPT, checkSummary, findCollisions } from "./summarise.ts";
import { parseVocabulary } from "./vocabulary.ts";

const job = process.argv[2];
if (job !== "topics" && job !== "summaries") {
  console.error("Usage: enrich.ts topics|summaries [--limit N] [--dry-run] [--model id]");
  process.exit(1);
}

const limit = Number(flag("limit") || 0);
const dryRun = flag("dry-run") !== null;
/** Eight at a time. Enough to finish a 1,200-Entity pass, gentle on the provider. */
const CONCURRENCY = 8;

const catalog = loadCatalog();
const byId = new Map(catalog.map((e) => [e.id, e]));
const monitored = new Set(DEFAULT_MONITORED_CHANNELS);
const warn = (m: string) => console.warn(m);

// Classification runs cheap, summaries run strong: the one-time job that sets
// something in stone gets the better model, and steady state does not.
const role = job === "topics" ? ("cheap" as const) : ("strong" as const);
const { boundary, models } = openBoundary(catalog, { [role]: flag("model") ?? undefined });

const vocabularyPath = flag("vocabulary") || VOCABULARY_PATH;
const vocabulary = job === "topics" ? parseVocabulary(readIfPresent(vocabularyPath)) : null;

/**
 * What may reach a model at all, for either job.
 *
 * Monitored conversation is extract-and-discard — the boundary refuses it too,
 * and filtering here is what makes the run finish rather than abort on the
 * first intro thread.
 *
 * `withheld` means deliberately listed without content and **never sampled**.
 * It is excluded for both jobs, not just summarisation: classification would
 * otherwise send a withheld Entity's name, tags and parent to the provider and
 * write a derived Topic back — content derived from an Entity whose whole
 * point is that no content is derived from it. Summarising already excluded
 * them by needing an input; tagging does not need one, which is exactly why
 * the rule has to live here rather than in each job.
 */
const eligible = catalog.filter(
  (e) => !isMonitored(e, byId, monitored) && e.description_status !== "withheld",
);

const due = eligible.filter((e) =>
  vocabulary ? needsClassifying(e, vocabulary) : !e.summary_generated,
);

// Split before the limit, not after, so `--limit` samples work rather than
// spending its budget on Entities that were only ever going to be skipped.
const [describable, insufficient] =
  job === "summaries"
    ? [
        due.filter((e) => hasDescribableInput(e, byId)),
        due.filter((e) => !hasDescribableInput(e, byId)),
      ]
    : [due, []];

const work = limit > 0 ? describable.slice(0, limit) : describable;

console.log(`Job      : ${job} on ${models[role]}${dryRun ? " (dry run — nothing is written)" : ""}`);
if (vocabulary)
  console.log(`Vocab    : v${vocabulary.version}, ${vocabulary.topics.length} tags (${vocabularyPath})`);
console.log(`Catalog  : ${catalog.length} Entities, ${eligible.length} eligible`);
console.log(`Due      : ${due.length}`);
if (insufficient.length)
  console.log(
    `  no input: ${insufficient.length} left with an explicit marker rather than an invented summary`,
  );
console.log(`This run : ${work.length}${limit > 0 ? ` (--limit ${limit})` : ""}`);

const results = new Map<string, { topics?: string[]; summary?: string }>();
const rejected: Array<{ entity: Entity; reason: string }> = [];
let done = 0;

const classifyOne = async (entity: Entity) => {
  const tags = await retrying(
    () =>
      boundary.ask({
        role,
        system: classifySystemPrompt(vocabulary!),
        subject: entity,
        context: subjectText(entity, byId),
        parse: (value) => parseTags(value, vocabulary!, warn),
      }),
    warn,
  );
  results.set(entity.id, { topics: reconcile(entity, tags, vocabulary!, warn) });
};

const summariseOne = async (entity: Entity) => {
  const summary = await retrying(
    () =>
      boundary.ask({
        role,
        system: SUMMARY_SYSTEM_PROMPT,
        subject: entity,
        context: subjectText(entity, byId),
        parse: (value) => {
          const s = (value as { summary?: unknown }).summary;
          if (typeof s !== "string") throw new Error(`No summary in ${JSON.stringify(value)}`);
          return s;
        },
      }),
    warn,
  );
  const problem = checkSummary(summary, entity);
  if (problem) {
    // Not retried with a nudge, and not patched up. A summary that restates
    // the name or overruns the budget is left absent, which is a state the
    // Catalog already models honestly — inventing one to fill the field is the
    // failure mode the explicit marker exists to prevent.
    rejected.push({ entity, reason: `${problem.reason}: ${summary}` });
    return;
  }
  results.set(entity.id, { summary: summary.trim() });
};

const queue = [...work];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let entity = queue.shift(); entity; entity = queue.shift()) {
      try {
        await (job === "topics" ? classifyOne(entity) : summariseOne(entity));
      } catch (error) {
        // One Entity failing must not abort the pass. The unrecorded ones are
        // simply due again next run, which is what incremental means.
        rejected.push({ entity, reason: (error as Error).message.slice(0, 160) });
      }
      if (++done % 100 === 0) console.log(`  … ${done}/${work.length}`);
    }
  }),
);

const updated = catalog.map((e) => {
  const result = results.get(e.id);
  if (!result) return e;
  return job === "topics"
    ? { ...e, topics: result.topics!, topics_version: vocabulary!.version }
    : { ...e, summary_generated: result.summary! };
});

console.log(`\nProduced : ${results.size} of ${work.length}`);
if (rejected.length) {
  console.warn(`Rejected : ${rejected.length}`);
  for (const r of rejected.slice(0, 20)) console.warn(`    ${r.entity.name} — ${r.reason}`);
  if (rejected.length > 20) console.warn(`    … and ${rejected.length - 20} more`);
}

if (job === "summaries") {
  const collisions = findCollisions(updated);
  if (collisions.length) {
    console.warn(
      `\nIdentical summaries among siblings: ${collisions.length} group(s). Either the ` +
        `summary is too generic or those Entities are duplicates — both are worth acting on.`,
    );
    for (const c of collisions.slice(0, 10))
      console.warn(`    "${c.summary}"  ←  ${c.entities.map((e) => e.name).join(" | ")}`);
  }
  // The sample a human reads before any of this goes near the Index.
  for (const e of updated.filter((x) => results.has(x.id)).slice(0, 15))
    console.log(`    ${e.name}\n      ${e.summary_generated}`);
}

if (dryRun) {
  console.log(`\nDry run — ${CATALOG_PATH} untouched.`);
} else {
  writeFileSync(CATALOG_PATH, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`\nWrote ${CATALOG_PATH}`);
}
