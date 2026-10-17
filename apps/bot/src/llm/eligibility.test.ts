/**
 * What may reach a model, for either enrichment job.
 *
 * `enrich.ts` is a command rather than a module, so the predicate it applies
 * lives in subject.ts and is asserted here directly. Both rules are
 * privacy rules, and both have already been got wrong once: monitored Threads
 * were nearly captured by matching only the channel's own name, and topic
 * classification shipped a review round sending withheld Entities to a model
 * because it needed no description and so never hit the check that would have
 * stopped it.
 */
import { describe, expect, it } from "vitest";
import type { Entity } from "../sync/catalog.ts";
import { isEnrichable } from "./subject.ts";

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
  thread_state: null,
  last_message_id: null,
  last_activity_at: null,
  summary_generated: null,
  summary_override: null,
  ...over,
});

const intro = entity({ id: "30", name: "👋︱introductions", type: "channel" });
const introThread = entity({ id: "31", name: "Hi, I am new", type: "thread", parent_id: "30" });
const withheld = entity({
  id: "40",
  name: "🔒︱staff-only",
  type: "channel",
  description_status: "withheld",
});
const ordinary = entity({ id: "50", name: "Wingspan", topic: "Bird game." });

const catalog = [intro, introThread, withheld, ordinary];
const byId = new Map(catalog.map((e) => [e.id, e]));
// By id: the store holds ids (#33).
const monitored = new Set([intro.id]);

/** The predicate `enrich.ts` applies before any job sees an Entity. */
const eligible = (e: Entity) => isEnrichable(e, byId, monitored);

describe("what enrichment may send to a model", () => {
  it("passes an ordinary Entity", () => {
    expect(eligible(ordinary)).toBe(true);
  });

  it("excludes a monitored channel", () => {
    expect(eligible(intro)).toBe(false);
  });

  it("excludes a Thread inside a monitored channel", () => {
    // The intro threads are where the actual introductions are.
    expect(eligible(introThread)).toBe(false);
  });

  it("excludes a withheld Entity, whose whole point is that nothing is derived from it", () => {
    // Classification needs no description, so nothing else in that job would
    // have stopped this one: its name, tags and parent would have gone to the
    // provider and a derived Topic would have come back.
    expect(eligible(withheld)).toBe(false);
  });
});
