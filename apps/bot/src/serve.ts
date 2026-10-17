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
 * The Tier 0 purge comes first, ahead of the sync, so neither a failing sync
 * nor anything after it can hold back the seven-day limit (purge.ts). If the
 * purge itself fails, nothing is captured that cycle: capture only runs
 * behind a purge that worked.
 *
 * At startup the guild's commands are registered again (register.ts), so a
 * deploy that changes them needs no separate step. That runs beside the
 * gateway: a failure is logged loudly and the commands already registered keep
 * working.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openDurableStore, withDurableStore } from "./sync/durable-store.ts";

// ponytail: a fixed cadence; a config knob when someone needs another one.
export const EVERY_MS = 6 * 60 * 60 * 1000;
export const STEPS = [
  ["sync/purge.ts"],
  ["sync/run.ts"],
  ["sync/capture.ts"],
  ["llm/enrich.ts", "topics"],
  ["llm/enrich.ts", "summaries"],
  ["llm/enrich.ts", "activity"],
];

/** One cycle: each step in turn, stopping at the first that does not exit 0. */
export const runCycle = async (
  run: (step: string[]) => Promise<number | null>,
  log: (m: string) => void,
): Promise<void> => {
  for (const step of STEPS) {
    const code = await run(step);
    if (code !== 0) {
      log(`[pipeline] ${step.join(" ")} exited ${code}; the rest of this cycle is skipped.`);
      return;
    }
  }
};

/**
 * On Railway the bot must start through apps/bot/start.sh, which restores the
 * durable store and runs the bot under replication. A Railway start command
 * replaces that script without any error, so its absence is caught here: the
 * reason to refuse, or null to start.
 */
export const entrypointRefusal = (env: NodeJS.ProcessEnv): string | null =>
  env["RAILWAY_ENVIRONMENT_ID"] && env["BOT_STARTED_BY_ENTRYPOINT"] !== "1"
    ? "Started on Railway without apps/bot/start.sh, so the durable store is not replicated. " +
      "Refusing to start. Set the service's start command to `sh /app/apps/bot/start.sh` (docs/runbook.md)."
    : null;

if (import.meta.main) {
  const refusal = entrypointRefusal(process.env);
  if (refusal) {
    console.error(`[serve] ${refusal}`);
    process.exit(1);
  }

  // The startup contract: a missing or uninitialised store stops the bot here.
  openDurableStore().close();

  // Hourly, whether or not the pipeline works: a store that never changes is
  // never snapshotted, and the bucket's lifecycle rule would then delete the
  // only snapshot a restore needs (durable-store.ts, `heartbeat`).
  const beat = () => {
    try {
      withDurableStore((store) => store.beat());
    } catch (error) {
      console.error("[serve] Heartbeat write failed:", error);
    }
  };
  beat();
  setInterval(beat, 60 * 60 * 1000);

  const run = ([script, ...args]: string[]) =>
    new Promise<number | null>((done) =>
      spawn(process.execPath, [resolve(import.meta.dirname, script!), ...args], { stdio: "inherit" })
        .on("error", () => done(null))
        .on("exit", done),
    );

  void run(["sherpa/register.ts"]).then((code) => {
    if (code !== 0)
      console.error(
        `[sherpa] COMMAND REGISTRATION FAILED (exit ${code}). The gateway is up, but new or ` +
          "changed commands are not registered. Run sherpa/register.ts by hand.",
      );
  });

  await import("./sherpa/run.ts");

  for (;;) {
    // Six-hourly from each cycle's start, so a long enrichment does not push every later sync back.
    const next = Date.now() + EVERY_MS;
    await runCycle(run, (m) => console.error(m));
    await sleep(Math.max(0, next - Date.now()));
  }
}
