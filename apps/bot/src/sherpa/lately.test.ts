import { describe, expect, it } from "vitest";
import type { Entity } from "../sync/catalog.ts";
import { MAX_LATELY, MAX_MESSAGE_CHARS, renderLately } from "./lately.ts";

const place = (n: number, summary = "x".repeat(400)): Entity => ({
  id: `1000000000000000${String(n).padStart(3, "0")}`,
  type: "post",
  name: `Place ${n}`,
  url: `https://discord.com/channels/1/1000000000000000${String(n).padStart(3, "0")}`,
  parent_id: null,
  description_status: "present",
  topic: null,
  applied_tags: [],
  region: [],
  topics: [],
  topics_version: null,
  thread_state: "open",
  last_message_id: "1",
  last_activity_at: "2026-10-14T12:00:00.000Z",
  summary_generated: summary,
  summary_override: null,
});

const T = Date.parse("2026-10-14T12:00:00.000Z") / 1000;

describe("renderLately with activity summaries", () => {
  it("shows a place's activity summary beneath its identity summary, and nothing for a null one", () => {
    const reply = renderLately([place(1, "Car football."), place(2, "Sims.")], null, {
      [place(1).id]: { summary: "Planning a Saturday tournament.", as_of: "1" },
      [place(2).id]: { summary: null, as_of: "1" },
    });
    expect(reply).toBe(
      "Active lately:\n" +
        `• **Place 1** ([open](${place(1).url})) <t:${T}:R> — Car football.\n` +
        "   ↳ Lately: Planning a Saturday tournament.\n" +
        `• **Place 2** ([open](${place(2).url})) <t:${T}:R> — Sims.`,
    );
  });

  it("stays inside one Discord message when every summary is at full length", () => {
    const places = Array.from({ length: MAX_LATELY }, (_, i) => place(i));
    const activity = Object.fromEntries(places.map((p) => [p.id, { summary: "y".repeat(400), as_of: "1" }]));
    const reply = renderLately(places, null, activity);
    expect(reply.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    // Whole places are left off the end, not cut in half: four of eight fit.
    expect(reply.endsWith("…")).toBe(true);
    expect(reply.match(/^• /gm)).toHaveLength(4);
  });
});
