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

describe("renderLately layout", () => {
  it("anchors each place with a mention, and shows the activity summary as subtext, or the identity one without it", () => {
    const reply = renderLately([place(1, "Car football."), place(2, "Sims.")], null, {
      [place(1).id]: { summary: "Planning a Saturday tournament.", as_of: "1" },
      [place(2).id]: { summary: null, as_of: "1" },
    });
    expect(reply).toBe(
      "**Active lately**\n\n" +
        `<#${place(1).id}> · <t:${T}:R>\n` +
        "-# Planning a Saturday tournament.\n" +
        `<#${place(2).id}> · <t:${T}:R>\n` +
        "-# Sims.",
    );
  });

  it("names an archived Post, which a client may not have loaded, by its name and a link", () => {
    for (const thread_state of ["closed", "locked"] as const)
      expect(renderLately([{ ...place(1, "About it."), thread_state }], null)).toBe(
        `**Active lately**\n\n**Place 1** ([open](${place(1).url})) · <t:${T}:R>\n-# About it.`,
      );
  });

  it("keeps a summary with line breaks inside its subtext", () => {
    const reply = renderLately([place(1)], null, {
      [place(1).id]: { summary: `Raid night.\n<#${place(9).id}> · <t:1:R>\n# Big`, as_of: "1" },
    });
    expect(reply.split("\n")).toHaveLength(4);
  });

  it(`fits a full list of ${MAX_LATELY} open places with every summary at full length`, () => {
    const places = Array.from({ length: MAX_LATELY }, (_, i) => place(i));
    const activity = Object.fromEntries(places.map((p) => [p.id, { summary: "y".repeat(400), as_of: "1" }]));
    const reply = renderLately(places, null, activity);
    expect(reply.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(reply.match(/^<#/gm)).toHaveLength(MAX_LATELY);
  });

  it("leaves whole places off the end rather than pass Discord's limit", () => {
    const long = (i: number) => ({ ...place(i), thread_state: "closed" as const, name: "*".repeat(100) });
    const reply = renderLately(Array.from({ length: MAX_LATELY }, (_, i) => long(i)), null);
    expect(reply.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(reply.endsWith("…")).toBe(true);
  });
});

describe("renderLately spoiler tags", () => {
  const withTopic = (topics: string[], summary: string) => {
    const p = { ...place(1), topics };
    return renderLately([p], null, { [p.id]: { summary, as_of: "1" } });
  };

  it("hides the activity summary of the spoiler-prone Topics only, inside the subtext", () => {
    for (const t of ["movies-and-tv", "anime-and-manga", "books-and-reading"])
      expect(withTopic([t], "Season finale.")).toContain("\n-# ||Season finale.||");
    expect(withTopic(["music"], "New album.")).toContain("\n-# New album.");
  });

  it("cannot be broken out of by pipes or a trailing backslash, and stays within the clip", () => {
    const line = withTopic(["movies-and-tv"], "a || b ||| " + "z".repeat(300)).split("-# ")[1]!;
    expect(line).toMatch(/^\|\|[^|]*\|\|$/);
    expect(withTopic(["movies-and-tv"], "ending in C:\\")).toContain("-# ||ending in C:||");
    expect(line.length).toBeLessThanOrEqual(150);
  });
});
