import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = new URL("../../../../", import.meta.url).pathname;
const frozen = readFileSync(join(repo, "content/config/topics.json"), "utf8");

/**
 * Runs `scripts/check-content.mjs` against a clean checkout: no Catalog, no
 * role manifest, and whatever vocabulary is given (`null` for none).
 */
let root: string;
const check = (vocabulary: string | null) => {
  root = mkdtempSync(join(tmpdir(), "check-content-"));
  for (const path of ["scripts/check-content.mjs", "apps/bot/src/llm/vocabulary.ts", "apps/bot/src/llm/persona.ts"])
    cpSync(join(repo, path), join(root, path));
  cpSync(join(repo, "content/config"), join(root, "content/config"), { recursive: true });
  const topics = join(root, "content/config/topics.json");
  if (vocabulary === null) rmSync(topics);
  else writeFileSync(topics, vocabulary);
  return spawnSync(process.execPath, [join(root, "scripts/check-content.mjs")], {
    encoding: "utf8",
  });
};
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the content check on a clean checkout", () => {
  it("passes the committed vocabulary", () => {
    const run = check(frozen);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  // CI is the only thing between a broken vocabulary and the next enrichment
  // run, and on a clean checkout there is no Catalog to catch it by proxy.
  it.each([
    ["missing", null],
    ["empty", "{}"],
    ["not frozen", JSON.stringify({ ...JSON.parse(frozen), status: "proposed" })],
  ])("fails a vocabulary that is %s", (_, vocabulary) => {
    const run = check(vocabulary);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("content/config/topics.json");
  });
});
