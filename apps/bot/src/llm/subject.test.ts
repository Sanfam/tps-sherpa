import { describe, expect, it } from "vitest";
import { identityKey, type Entity } from "../sync/catalog.ts";
import { hasDescribableInput, subjectText } from "./subject.ts";

const entity = (over: Partial<Entity> & { id: string; name: string }): Entity => ({
  type: "post",
  url: `https://discord.com/channels/1/${over.id}`,
  parent_id: null,
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

const forum = entity({ id: "900", name: "board-games", type: "forum" });
const wingspan = entity({
  id: "1",
  name: "Wingspan",
  parent_id: forum.id,
  topic: "Engine-building bird game.",
  applied_tags: ["Tabletop"],
  region: ["Minnesota"],
});
const byId = new Map([forum, wingspan].map((e) => [e.id, e]));

describe("subjectText", () => {
  it("renders the parent, the mod tags, the region and the description", () => {
    expect(subjectText(wingspan, byId)).toBe(
      [
        "Name: Wingspan",
        "Kind: post",
        "Inside: board-games",
        "Mod tags: Tabletop",
        "Region: Minnesota",
        "Description: Engine-building bird game.",
      ].join("\n"),
    );
  });

  it("says nothing about a parent it cannot resolve", () => {
    const orphan = entity({ id: "2", name: "Lost", parent_id: "nope" });

    expect(subjectText(orphan, byId)).not.toContain("Inside:");
  });
});

/**
 * The carry-forward contract. `identityKey` licenses keeping a summary and a
 * set of Topic tags across a sync, so it has to move whenever the text that
 * produced them would. These two functions living in different modules is
 * exactly how that drifts, which is what these tests exist to catch.
 */
describe("identityKey covers every input subjectText sends to a model", () => {
  const keyOf = (e: Entity, catalog: Entity[]) =>
    identityKey(e, e.parent_id ? catalog.find((c) => c.id === e.parent_id) : null);

  const before = keyOf(wingspan, [forum, wingspan]);

  it.each<[string, Entity, Entity[]]>([
    ["a rename", { ...wingspan, name: "Wyrmspan" }, [forum]],
    ["a rewritten description", { ...wingspan, topic: "Now a Root night." }, [forum]],
    ["a changed type", { ...wingspan, type: "thread" }, [forum]],
    ["a mod adding a tag", { ...wingspan, applied_tags: ["Tabletop", "PC"] }, [forum]],
    ["a changed region", { ...wingspan, region: [] }, [forum]],
    [
      "a move to another Forum",
      { ...wingspan, parent_id: "901" },
      [entity({ id: "901", name: "video-games", type: "forum" })],
    ],
    [
      "a rename of the parent, which the child's own fields never see",
      wingspan,
      [{ ...forum, name: "tabletop-games" }],
    ],
  ])("invalidates on %s", (_name, changed, catalog) => {
    expect(keyOf(changed, [...catalog, changed])).not.toBe(before);
  });

  it("does not invalidate on activity, which changes nothing about the subject", () => {
    const busier = { ...wingspan, last_message_id: "999", last_activity_at: "2026-09-03" };

    expect(keyOf(busier, [forum, busier])).toBe(before);
  });
});

describe("hasDescribableInput", () => {
  it("accepts a Post with only a name, because its parent supplies the rest", () => {
    const bare = entity({ id: "2", name: "Dune", parent_id: forum.id });

    expect(hasDescribableInput(bare, byId)).toBe(true);
  });

  it("refuses a top-level Channel with no topic set", () => {
    // The fix is a mod typing one sentence in Discord. Inferring what
    // `🖥︱pc-gaming` is about is an elaborate way of not asking.
    const empty = entity({ id: "3", name: "🖥︱pc-gaming", type: "channel" });

    expect(hasDescribableInput(empty, byId)).toBe(false);
  });

  it("never describes a withheld Entity", () => {
    const withheld = entity({
      id: "4",
      name: "private",
      type: "channel",
      description_status: "withheld",
    });

    expect(hasDescribableInput(withheld, byId)).toBe(false);
  });
});
