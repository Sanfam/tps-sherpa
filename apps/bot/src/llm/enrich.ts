/**
 * The steady-state LLM passes over the Catalog.
 *
 *   node --env-file=.env src/llm/enrich.ts topics    [--limit N] [--dry-run] [--model id]
 *   node --env-file=.env src/llm/enrich.ts summaries [--limit N] [--dry-run] [--model id]
 *   node --env-file=.env src/llm/enrich.ts activity  [--limit N] [--dry-run] [--model id]
 *
 * `activity` reads recent messages from Tier 0 and writes to the bot's volume
 * (`.data/activity.json`), never to the Catalog — see activity.ts.
 * Run a capture first: an Entity is only due once Tier 0's newest message is
 * the Catalog's.
 *
 * `--vocabulary <path>` classifies against a candidate instead of the frozen
 * one, so a reviewer can see what a proposed vocabulary actually does to the
 * corpus before freezing it. It still refuses anything marked `proposed`:
 * freeze a copy, try it, throw the copy away.
 *
 * `topics` and `summaries` read the Catalog from the bot's durable store and
 * write what they produce back into it — no Discord call, so a retag or a
 * reword is a local reprocess. All three are
 * incremental: an Entity
 * whose identity has not changed keeps what the last run produced (the sync
 * drops those fields when it does change), so a scheduled run does nothing and
 * costs nothing.
 *
 * `--limit` exists for the human review checkpoints. Read a sample before
 * spending a model on the whole corpus, and read the sample the corpus
 * produced rather than a sample of a run you have already paid for.
 */
import type { Entity } from "../sync/catalog.ts";
import { DURABLE_STORE_PATH, openDurableStore, readCurrent, readProcessingOptOuts } from "../sync/durable-store.ts";
import { TIER0_PATH, openTier0 } from "../sync/tier0-store.ts";
import {
  ACTIVITY_SYSTEM_PROMPT,
  type ActivityStore,
  checkActivity,
  commitActivity,
  planActivity,
} from "./activity.ts";
import { classifySystemPrompt, needsClassifying, parseTags, reconcile } from "./classify.ts";
import {
  ACTIVITY_PATH,
  VOCABULARY_PATH,
  flag,
  openBoundary,
  readActivity,
  readIfPresent,
  retrying,
  writeActivity,
} from "./session.ts";
import { hasDescribableInput, isEnrichable, subjectText } from "./subject.ts";
import { SUMMARY_SYSTEM_PROMPT, checkSummary, findCollisions } from "./summarise.ts";
import { parseVocabulary } from "./vocabulary.ts";

const job = process.argv[2];
if (job !== "topics" && job !== "summaries" && job !== "activity") {
  console.error("Usage: enrich.ts topics|summaries|activity [--limit N] [--dry-run] [--model id]");
  process.exit(1);
}

const limit = Number(flag("limit") || 0);
const dryRun = flag("dry-run") !== null;
/** Eight at a time. Enough to finish a 1,200-Entity pass, gentle on the provider. */
const CONCURRENCY = 8;

// Which generation this pass read: its results are written back only onto
// that one (`patchEntities`, #31).
const { catalog, generatedAt } = readCurrent();
const byId = new Map(catalog.map((e) => [e.id, e]));
const warn = (m: string) => console.warn(m);

// Classification runs cheap, summaries run strong: the one-time job that sets
// something in stone gets the better model, and steady state does not.
// Activity is volatile and high-volume, so it runs cheap too.
const role = job === "summaries" ? ("strong" as const) : ("cheap" as const);
// Throws, and so exits non-zero before any call, if a monitored channel is
// missing from the Catalog (#33).
const { boundary, models, monitored } = openBoundary(catalog, { [role]: flag("model") ?? undefined });

const vocabularyPath = flag("vocabulary") || VOCABULARY_PATH;
const vocabulary = job === "topics" ? parseVocabulary(readIfPresent(vocabularyPath)) : null;

const tier0 = job === "activity" ? openTier0(TIER0_PATH) : null;
const activityStore: ActivityStore = job === "activity" ? readActivity() : {};

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
const eligible = catalog.filter((e) => isEnrichable(e, byId, monitored));

// One read of Tier 0 per Entity decides both whether it is due and what it is
// summarised from — see planActivity.
const activityPlan = new Map(
  job === "activity"
    ? planActivity(eligible, (id) => tier0!.messagesFor(id), activityStore, readProcessingOptOuts()).map(
        (p) => [p.entity.id, p.sources] as const,
      )
    : [],
);
const due = eligible.filter((e) =>
  job === "activity"
    ? activityPlan.has(e.id)
    : vocabulary
      ? needsClassifying(e, vocabulary)
      : !e.summary_generated,
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

const results = new Map<string, { topics?: string[]; summary?: string; activity?: string | null }>();
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

const activityOne = async (entity: Entity) => {
  const sources = activityPlan.get(entity.id) ?? [];
  // Nothing human left to read is an answer, not a failure: recorded as null
  // so the Entity is not retried until its activity moves.
  if (sources.length === 0) {
    results.set(entity.id, { activity: null });
    return;
  }
  const summary = await retrying(
    () =>
      boundary.ask({
        role,
        // Opt-outs are only known inside the boundary. If every source was
        // dropped there, nothing is sent and the answer is null, rather than
        // an empty prompt the model would answer by inventing a subject.
        orNothing: null,
        system: ACTIVITY_SYSTEM_PROMPT,
        subject: entity,
        sources: sources.map((m) => ({ ...m, origin: m.entityId })),
        parse: (value) => {
          const s = (value as { summary?: unknown }).summary;
          // The shape only, never the value: a malformed answer is still
          // conversation-derived text, and this message reaches a log.
          if (s !== null && typeof s !== "string")
            throw new Error(`Activity answer has no string-or-null summary (got ${typeof s}).`);
          return s?.trim() || null;
        },
      }),
    warn,
  );
  const problem = summary === null ? null : checkActivity(summary);
  if (problem) {
    // Left unrecorded, so it is due again next run rather than stored wrong.
    // The reason only: activity text never goes to a log.
    rejected.push({ entity, reason: problem.reason });
    return;
  }
  results.set(entity.id, { activity: summary });
};

const queue = [...work];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let entity = queue.shift(); entity; entity = queue.shift()) {
      try {
        await (job === "topics"
          ? classifyOne(entity)
          : job === "activity"
            ? activityOne(entity)
            : summariseOne(entity));
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
  // Activity never touches the Catalog: it goes to the bot's volume below.
  if (!result || job === "activity") return e;
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

if (job === "activity") {
  console.log(`  nothing to summarise: ${[...results.values()].filter((r) => r.activity === null).length}`);
  if (dryRun) console.log(`\nDry run — ${ACTIVITY_PATH} untouched.`);
  else {
    // Never the copy this run read at its start: /privacy may have deleted or
    // opted out while it ran (commitActivity).
    const { withheld } = commitActivity(
      [...results].map(([id, r]) => ({
        entity: byId.get(id)!,
        sources: activityPlan.get(id) ?? [],
        summary: r.activity ?? null,
      })),
      {
        optedOut: () => readProcessingOptOuts(),
        stored: (id) => tier0!.messagesFor(id),
        read: () => readActivity(),
        write: (store) => writeActivity(store),
      },
    );
    if (withheld) console.log(`  left out, a source opted out or was deleted mid-run: ${withheld}`);
    console.log(`\nWrote ${ACTIVITY_PATH} (bot-side; never committed)`);
  }
  tier0!.close();
} else if (dryRun) {
  console.log(`\nDry run — ${DURABLE_STORE_PATH} untouched.`);
} else {
  // Only the fields this job owns, so a Staff override is never written over.
  // A sync that replaced the Catalog while this ran makes this throw
  // (`GenerationChanged`), so the process exits non-zero and `serve.ts` ends
  // the cycle; the next one starts from the new generation.
  const store = openDurableStore();
  try {
    store.patchEntities(
      generatedAt,
      updated
        .filter((e) => results.has(e.id))
        .map(({ id, topics, topics_version, summary_generated }) =>
          job === "topics" ? { id, topics, topics_version } : { id, summary_generated },
        ),
    );
  } finally {
    store.close();
  }
  console.log(`\nWrote ${results.size} Entities to ${DURABLE_STORE_PATH}`);
}
