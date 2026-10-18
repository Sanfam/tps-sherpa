/**
 * The Phase 3 gate: the golden set, live, and the position-sensitivity check.
 *
 *   node --env-file=.env src/sherpa/eval.ts [--orderings N] [--model id]
 *
 * Each case runs once against the Catalog in its stored order, then again
 * under N-1 seeded shuffles of it. A case passes an ordering when every
 * must-surface interest is among the matches (or, for the no-signal cases,
 * when the answer stays under the confidence gate). It is stable when it
 * passes every ordering: a prompt this long can favour whatever sits near its
 * start or end, and a result that moves with the order is luck, not matching.
 *
 * Reads the local Catalog; no Discord call. Costs about one `/find` per case
 * per ordering. The cap does not apply — this is a person choosing to spend.
 */
import {
  VOCABULARY_PATH,
  flag,
  loadCatalog,
  loadRoleManifest,
  openBoundary,
  readIfPresent,
  retrying,
} from "../llm/session.ts";
import { parseVocabulary } from "../llm/vocabulary.ts";
import type { Entity } from "../sync/catalog.ts";
import { FIND_TIMEOUT_MS, MIN_CONFIDENT, candidatesOf, findPlaces } from "./find.ts";
import { GOLDEN_SET, type GoldenCase, resolveExpected } from "./golden-set.ts";
import { memberRoleIds } from "./interactions.ts";

// The stored order plus at least one shuffle, or there is no position check.
const orderings = Number(flag("orderings") || 4);
if (!Number.isSafeInteger(orderings) || orderings < 2) {
  console.error(`--orderings must be an integer of at least 2. Got: ${flag("orderings")}`);
  process.exit(1);
}
const catalog = loadCatalog();
const vocabulary = parseVocabulary(readIfPresent(VOCABULARY_PATH));
const { boundary, models, monitored } = openBoundary(catalog, { cheap: flag("model") ?? undefined }, FIND_TIMEOUT_MS);
const byId = new Map(catalog.map((e) => [e.id, e]));
// A Member's view, which is what a golden-set query stands for.
const roles = memberRoleIds(loadRoleManifest());
const candidates = candidatesOf(catalog, monitored, roles);

/** Deterministic, so a failing ordering can be rerun. mulberry32. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const shuffled = (list: Entity[], seed: number): Entity[] => {
  const random = seeded(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

const orders = Array.from({ length: orderings }, (_, i) => (i === 0 ? catalog : shuffled(catalog, i)));

// Resolve every expectation before spending anything: a renamed Post fails here.
const expected = new Map(
  GOLDEN_SET.flatMap((c) => ("mustSurface" in c ? [[c.id, resolveExpected(c.mustSurface, candidates)] as const] : [])),
);

interface Run {
  passed: boolean;
  matches: Entity[];
  calls: number;
  ms: number;
  error?: string;
}

const runOne = async (c: GoldenCase, order: Entity[]): Promise<Run> => {
  let calls = 0;
  const started = Date.now();
  try {
    const found = await retrying(
      () =>
        findPlaces({
          query: c.query,
          invokerId: "0",
          catalog: order,
          monitored,
          roles,
          vocabulary,
          ask: (request) => {
            calls++;
            return boundary.ask(request);
          },
          origin: { command: "find" },
        }),
      (m) => console.warn(`  ${c.id}: ${m}`),
    );
    const ids = new Set(found.matches.map((e) => e.id));
    const passed =
      "mustSurface" in c
        ? expected.get(c.id)!.every((group) => [...group].some((id) => ids.has(id)))
        : c.expect === "few"
          ? found.matches.length < MIN_CONFIDENT
          : found.matches.length === 0 && calls === 0;
    return { passed, matches: found.matches, calls, ms: Date.now() - started };
  } catch (error) {
    return { passed: false, matches: [], calls, ms: Date.now() - started, error: (error as Error).message };
  }
};

console.log(`Model     : ${models.cheap}`);
console.log(`Catalog   : ${catalog.length} Entities, ${candidates.length} candidates`);
console.log(`Orderings : ${orderings} (stored order, then seeds 1..${orderings - 1})\n`);

const results = await Promise.all(
  GOLDEN_SET.map(async (c) => ({ c, runs: await Promise.all(orders.map((o) => runOne(c, o))) })),
);

let failed = 0;
for (const { c, runs } of results) {
  const passes = runs.filter((r) => r.passed).length;
  const stable = passes === runs.length;
  if (!stable) failed++;
  const distinct = new Set(runs.map((r) => r.matches.map((e) => e.id).sort().join(","))).size;
  console.log(
    `${stable ? "PASS" : "FAIL"}  ${c.id.padEnd(12)} ${passes}/${runs.length} orderings  ` +
      `${distinct} distinct match set(s)  calls ${runs.reduce((n, r) => n + r.calls, 0)}  ` +
      `slowest ${(Math.max(...runs.map((r) => r.ms)) / 1000).toFixed(1)}s`,
  );
  runs.forEach((r, i) => {
    const what = r.error
      ? `error: ${r.error.slice(0, 160)}`
      : r.matches.map((e) => `${e.name}${e.parent_id ? ` (${byId.get(e.parent_id)?.name})` : ""}`).join(" | ") ||
        "(no matches)";
    console.log(`      ${i === 0 ? "stored" : `seed ${i}`.padEnd(6)} ${r.passed ? "ok  " : "MISS"} ${what}`);
  });
}

console.log(`\n${failed === 0 ? "Golden set passes, stable across orderings." : `${failed} case(s) failed or unstable.`}`);
process.exit(failed === 0 ? 0 : 1);
