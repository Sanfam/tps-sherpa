import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Entity } from "../sync/catalog.ts";

// Before any import reads them: the durable store's path, and a model config.
const { sent } = vi.hoisted(() => {
  process.env["BOT_DB_PATH"] = `${process.env["TMPDIR"] ?? "/tmp"}/session-test-${process.pid}-${Date.now()}.db`;
  process.env["TIER0_PATH"] = `${process.env["BOT_DB_PATH"]}.tier0`;
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

const { DURABLE_STORE_PATH, MONITORED_SEED, initDurableStore, withDurableStore } = await import(
  "../sync/durable-store.ts"
);
const { TIER0_PATH, openTier0 } = await import("../sync/tier0-store.ts");
const { openBoundary, usableMemberNames } = await import("./session.ts");

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
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${DURABLE_STORE_PATH}${suffix}`, { force: true });
      rmSync(`${TIER0_PATH}${suffix}`, { force: true });
    }
  });

  it("refuses to build a boundary while a monitored channel is missing from the Catalog", () => {
    initDurableStore(DURABLE_STORE_PATH, { exclusionSeed: null, catalog: JSON.stringify([subject]), roleManifest: "[]" });
    // The seed's Channel is not in this one-Entity Catalog.
    expect(() => openBoundary([subject])).toThrow(/not in the current Catalog/);
    withDurableStore((s) => MONITORED_SEED.forEach((c) => s.removeMonitored(c.id)));
  });

  it("never sends the words of a member who has turned processing off", async () => {
    withDurableStore((s) => s.setPreference("out", "processing", false));

    const { boundary } = openBoundary([subject]);
    await boundary.ask({
      role: "cheap",
      system: "Answer in JSON.",
      subject,
      sources: [
        { authorId: "in", authorIsBot: false, content: "raid tonight", origin: subject.id },
        { authorId: "out", authorIsBot: false, content: "distinctive-opted-out-text", origin: subject.id },
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
          { authorId: "in", authorIsBot: false, content: "raid tonight", origin: subject.id },
          { authorId: "later", authorIsBot: false, content: "distinctive-later-text", origin: subject.id },
        ],
        parse: (v) => v,
      });
    await ask();
    withDurableStore((s) => s.setPreference("later", "processing", false));
    await ask();
    expect(sent).toEqual(["raid tonight\ndistinctive-later-text", "raid tonight"]);
  });

  it("redacts a cached member name on the way out", async () => {
    sent.length = 0;
    const tier0 = openTier0(TIER0_PATH);
    const message = { entityId: "100", authorIsBot: false, content: "x", createdAt: "", window: "head" as const };
    tier0.record("100", null, [{ ...message, messageId: "m1", authorId: "a1", authorNames: ["Jughfer"] }]);
    tier0.close();
    const { boundary } = openBoundary([subject]);
    await boundary.ask({
      role: "cheap",
      system: "Answer in JSON.",
      subject,
      sources: [{ authorId: "in", authorIsBot: false, content: "thanks jughfer for the carry", origin: subject.id }],
      parse: (v) => v,
    });
    expect(sent).toEqual(["thanks @member for the carry"]);
  });

  it("redacts an opted-out member's kept names from another member's words, until they opt back in", async () => {
    const ask = async () => {
      sent.length = 0;
      await openBoundary([subject]).boundary.ask({
        role: "cheap",
        system: "Answer in JSON.",
        subject,
        sources: [{ authorId: "in", authorIsBot: false, content: "Gonzo Rex said hi", origin: subject.id }],
        parse: (v) => v,
      });
      return sent[0];
    };
    withDurableStore((s) => s.setPreference("quiet", "processing", false, ["gonzo", "Gonzo Rex"]));
    expect(await ask()).toBe("@member said hi");
    withDurableStore((s) => s.setPreference("quiet", "processing", true));
    expect(await ask()).toBe("Gonzo Rex said hi");
  });
});

describe("usableMemberNames", () => {
  const named = (name: string, type: Entity["type"]): Entity => ({ ...subject, id: name, name, type });

  it("leaves out names under three characters and names Staff gave a Channel, a Forum or a Topic", () => {
    const catalog = [named("🎮︱battlefield-2042", "channel"), named("Dads of Minnesota", "forum")];
    expect(
      usableMemberNames(["Al", "battlefield", "minnesota", "Family", "Jughfer", " Jughfer "], catalog, ["Parenting & Family"]),
    ).toEqual(["Jughfer"]);
  });

  it("never lets a member-written Post or Thread title switch redaction of a name off", () => {
    const catalog = [named("Jughfer intro", "thread"), named("Ask Dave Smith anything", "post")];
    expect(usableMemberNames(["Jughfer", "Dave Smith"], catalog, [])).toEqual(["Jughfer", "Dave Smith"]);
  });
});
