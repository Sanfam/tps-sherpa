/**
 * The deployed bot: Sherpa's gateway, and the scheduled pipeline that keeps
 * its Catalog current. One process, because one Railway service owns the
 * volume (ADR-0001).
 *
 *   node apps/bot/src/serve.ts
 *
 * The pipeline's steps run one at a time, each as its own process, and a cycle
 * never overlaps the next: sync and enrichment both write the durable store,
 * and this loop is what keeps them apart (#31). A failed step ends its cycle,
 * so an incomplete sync is never enriched; Sherpa keeps serving the last
 * complete generation.
 *
 * Capture and `enrich.ts activity` are not scheduled. They store members'
 * recent messages and what is derived from them, which waits on a Tier 0
 * purge and the privacy policy.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openDurableStore } from "./sync/durable-store.ts";

// ponytail: a fixed cadence; a config knob when someone needs another one.
const EVERY_MS = 6 * 60 * 60 * 1000;
const STEPS = [["sync/run.ts"], ["llm/enrich.ts", "topics"], ["llm/enrich.ts", "summaries"]];

// The startup contract: a missing or uninitialised store stops the bot here.
openDurableStore().close();

const run = ([script, ...args]: string[]) =>
  new Promise<number | null>((done) =>
    spawn(process.execPath, [resolve(import.meta.dirname, script!), ...args], { stdio: "inherit" })
      .on("error", () => done(null))
      .on("exit", done),
  );

await import("./sherpa/run.ts");

for (;;) {
  // Six-hourly from each cycle's start, so a long enrichment does not push every later sync back.
  const next = Date.now() + EVERY_MS;
  for (const step of STEPS) {
    const code = await run(step);
    if (code !== 0) {
      console.error(`[pipeline] ${step.join(" ")} exited ${code}; the rest of this cycle is skipped.`);
      break;
    }
  }
  await sleep(Math.max(0, next - Date.now()));
}
