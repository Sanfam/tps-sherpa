import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Entity } from "../sync/catalog.ts";

// Before any import reads them: the durable store's path, and a model config.
const { sent } = vi.hoisted(() => {
  process.env["BOT_DB_PATH"] = `${process.env["TMPDIR"] ?? "/tmp"}/session-test-${process.pid}-${Date.now()}.db`;
  process.env["LLM_API_KEY"] = "test-key";
  process.env["LLM_MODEL_STRONG"] = "strong";
  process.env["LLM_MODEL_CHEAP"] = "cheap";
  return { sent: [] as string[] };
});

// The wire itself is checked against the real API (openai-wire.ts); here only
// what reaches it matters.
vi.mock("./openai-wire.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openai-wire.ts")>()),
  openAiWire: () => ({
    complete: async ({ user }: { user: string }) => (sent.push(user), '{"ok":true}'),
  }),
}));

const { DURABLE_STORE_PATH, initDurableStore, withDurableStore } = await import("../sync/durable-store.ts");
const { openBoundary } = await import("./session.ts");

const subject: Entity = {
  id: "100",
  type: "post",
  name: "Elden Ring",
  url: "",
  parent_id: null,
  description_status: "present",
  topic: null,
  applied_tags: [],
  region: [],
  topics: [],
  topics_version: null,
  thread_state: "open",
  last_message_id: null,
  last_activity_at: null,
  summary_generated: null,
  summary_override: null,
};

describe("openBoundary", () => {
  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DURABLE_STORE_PATH}${suffix}`, { force: true });
  });

  it("never sends the words of a member who has turned processing off", async () => {
    initDurableStore(DURABLE_STORE_PATH, { exclusionSeed: null, catalog: JSON.stringify([subject]), roleManifest: "[]" });
    withDurableStore((s) => s.setPreference("out", "processing", false));

    const { boundary } = openBoundary([subject]);
    await boundary.ask({
      role: "cheap",
      system: "Answer in JSON.",
      subject,
      sources: [
        { authorId: "in", authorIsBot: false, content: "raid tonight" },
        { authorId: "out", authorIsBot: false, content: "distinctive-opted-out-text" },
      ],
      parse: (v) => v,
    });

    expect(sent).toEqual(["raid tonight"]);
  });

  it("hears an opt-out made after it was built, from the next call on", async () => {
    sent.length = 0;
    const { boundary } = openBoundary([subject]);
    const ask = () =>
      boundary.ask({
        role: "cheap",
        system: "Answer in JSON.",
        subject,
        sources: [
          { authorId: "in", authorIsBot: false, content: "raid tonight" },
          { authorId: "later", authorIsBot: false, content: "distinctive-later-text" },
        ],
        parse: (v) => v,
      });
    await ask();
    withDurableStore((s) => s.setPreference("later", "processing", false));
    await ask();
    expect(sent).toEqual(["raid tonight\ndistinctive-later-text", "raid tonight"]);
  });
});
