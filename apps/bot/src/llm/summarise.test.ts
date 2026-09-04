import { describe, expect, it } from "vitest";
import type { Entity } from "../sync/catalog.ts";
import { checkSummary, findCollisions, MAX_WORDS } from "./summarise.ts";

const entity = (over: Partial<Entity> & { id: string; name: string }): Entity => ({
  type: "post",
  url: `https://discord.com/channels/1/${over.id}`,
  parent_id: "900",
  description_status: "present",
  topic: null,
  applied_tags: [],
  region: [],
  topics: [],
  topics_version: null,
  last_message_id: null,
  last_activity_at: null,
  summary_generated: null,
  summary_override: null,
  ...over,
});

const wingspan = entity({ id: "1", name: "Wingspan" });

describe("checkSummary", () => {
  it("accepts one that says what the name does not", () => {
    expect(
      checkSummary("Engine-building bird game, weekly sessions for two to five players.", wingspan),
    ).toBeNull();
  });

  it("rejects a summary that only restates the title", () => {
    // The whole point of a summary is to add what a name search would not find.
    const result = checkSummary("A thread about the game Wingspan.", wingspan);

    expect(result?.reason).toBe("restates-the-name");
  });

  it("rejects one over the budget the whole-catalog prompt depends on", () => {
    const long = Array.from({ length: MAX_WORDS + 1 }, (_, i) => `word${i}`).join(" ");

    expect(checkSummary(long, wingspan)).toEqual({ reason: "too-long", words: MAX_WORDS + 1 });
  });

  it("treats an empty answer as a refusal, not a summary", () => {
    // The model is told to answer with an empty string rather than guess, so
    // this is the path an Entity with nothing to describe takes.
    expect(checkSummary("   ", wingspan)?.reason).toBe("empty");
  });

  it("does not count filler words as content", () => {
    const filler = checkSummary("This is a thread about the Wingspan channel.", wingspan);

    expect(filler?.reason).toBe("restates-the-name");
  });

  it("accepts a summary that adds something to a name which is already a list", () => {
    // A real rejection from the 2026-09-03 run, under the ratio rule this
    // replaced. Names here are often lists of their own subject, and against
    // those a true summary repeats most of the name and is still worth having.
    const listy = entity({ id: "2", name: "Miniature Painting/Printing/Gaming" });

    expect(
      checkSummary("Wargaming and D&D miniature painting, printing, tabletop nights.", listy),
    ).toBeNull();
  });

  it("still rejects one that only re-lists the name", () => {
    const listy = entity({ id: "3", name: "Northern Alabama/Southern Middle Tennessee" });

    expect(
      checkSummary("Chat for northern Alabama and southern middle Tennessee.", listy)?.reason,
    ).toBe("restates-the-name");
  });
});

describe("findCollisions", () => {
  const summarised = (id: string, name: string, summary: string, parent = "900") =>
    entity({ id, name, parent_id: parent, summary_generated: summary });

  it("finds siblings that ended up with the same summary", () => {
    // Either the summary is too generic or the two are duplicates. Both are
    // findings a human acts on, which is why this reports rather than repairs.
    const collisions = findCollisions([
      summarised("1", "United Kingdom", "Members based in the United Kingdom."),
      summarised("2", "United Kingdom 🇬🇧", "Members based in the United Kingdom."),
      summarised("3", "Minnesota", "Cold, and proud of it."),
    ]);

    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.entities.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("does not call two entries in different places duplicates", () => {
    const collisions = findCollisions([
      summarised("1", "Wingspan", "Engine-building bird game night.", "900"),
      summarised("2", "Wingspan", "Engine-building bird game night.", "901"),
    ]);

    expect(collisions).toEqual([]);
  });

  it("ignores Entities that have no summary yet", () => {
    expect(findCollisions([entity({ id: "1", name: "x" }), entity({ id: "2", name: "y" })])).toEqual(
      [],
    );
  });
});
