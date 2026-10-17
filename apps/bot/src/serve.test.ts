import { describe, expect, it } from "vitest";
import { RETAIN_MS } from "./sync/tier0-store.ts";
import { EVERY_MS, STEPS, entrypointRefusal, runCycle } from "./serve.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("the pipeline cycle", () => {
  it("purges first, and captures only after a sync", () => {
    expect(STEPS.map((s) => s.join(" "))).toEqual([
      "sync/purge.ts",
      "sync/run.ts",
      "sync/capture.ts",
      "llm/enrich.ts topics",
      "llm/enrich.ts summaries",
      "llm/enrich.ts activity",
    ]);
  });

  it("stops at a failed purge, so nothing is captured behind it", async () => {
    const ran: string[] = [];
    const logs: string[] = [];
    await runCycle(
      async (step) => {
        ran.push(step[0]!);
        return step[0] === "sync/purge.ts" ? 1 : 0;
      },
      (m) => logs.push(m),
    );
    expect(ran).toEqual(["sync/purge.ts"]);
    expect(logs).toEqual([expect.stringContaining("sync/purge.ts exited 1")]);
  });

  it("runs every step when each succeeds", async () => {
    const ran: string[][] = [];
    await runCycle(async (step) => (ran.push(step), 0), () => {});
    expect(ran).toEqual(STEPS);
  });

  it("keeps raw text under seven days: retention plus one cycle's wait", () => {
    expect(RETAIN_MS + EVERY_MS).toBeLessThan(7 * DAY_MS);
  });
});

describe("the entrypoint guard", () => {
  it("refuses on Railway unless start.sh started it", () => {
    expect(entrypointRefusal({ RAILWAY_ENVIRONMENT_ID: "env-id" })).toMatch(/start\.sh/);
    expect(entrypointRefusal({ RAILWAY_ENVIRONMENT_ID: "env-id", BOT_STARTED_BY_ENTRYPOINT: "1" })).toBeNull();
  });

  it("leaves local development alone", () => {
    expect(entrypointRefusal({})).toBeNull();
  });
});
