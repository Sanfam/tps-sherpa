// Discord returns only the next occurrence of a recurring Scheduled Event, so
// the site works out the rest from the rule, and decides who sees each event.
import { expect, test } from "vitest";
import type { SnapshotEvent } from "../src/catalog-snapshot.ts";
import { eventsView, occurrenceStarts, upcoming } from "../src/events.ts";

const event = (e: Partial<SnapshotEvent> & Pick<SnapshotEvent, "id" | "name" | "start">): SnapshotEvent => ({
  description: null,
  end: null,
  status: "scheduled",
  entity_type: "external",
  channel_id: null,
  location: null,
  image_url: null,
  recurrence: null,
  canceled_starts: [],
  moved: [],
  next: e.start,
  ...e,
});

test("Book Club meets on Discord's second Thursday in UTC each month, through DST, less the month it was called off", () => {
  // The real rule: monthly, by_n_weekday { n: 2, day: 3 }, Thursday in UTC
  // (0 is Monday) for a Wednesday evening in the US. In November the 1st is a
  // Sunday, so the second Thursday is the 12th, not the Thursday of the
  // month's second week.
  const bookClub = event({
    id: "1",
    name: "Book Club Discussion",
    start: "2026-10-08T01:00:00.000Z",
    location: "Voice Chat",
    recurrence: {
      frequency: "monthly",
      interval: 1,
      by_weekday: null,
      by_n_weekday: [{ n: 2, day: 3 }],
      by_month: null,
      by_month_day: null,
      end: null,
      count: null,
    },
    canceled_starts: ["2026-12-10T01:00:00.000Z"],
  });
  const starts = occurrenceStarts(bookClub, Date.parse("2027-03-31T00:00:00Z")).map((s) => new Date(s).toISOString());
  // The UTC time holds across both US DST changes (Nov 1, Mar 14), as Discord's does.
  expect(starts).toEqual([
    "2026-10-08T01:00:00.000Z",
    "2026-11-12T01:00:00.000Z",
    "2027-01-14T01:00:00.000Z",
    "2027-02-11T01:00:00.000Z",
    "2027-03-11T01:00:00.000Z",
  ]);
});

test("Video Chat Night is fortnightly from its first Sunday, and a series with an end keeps its last night", () => {
  // The real series: weekly, interval 2, Sunday in UTC, first 2025-11-23; Discord
  // reported its next as 2026-11-22. A rule's end is the last moment an
  // occurrence may start, so a night starting exactly then still happens.
  const videoChat = event({
    id: "2",
    name: "Papa Squad Video Chat Night",
    start: "2025-11-23T02:00:00.000Z",
    end: "2025-11-23T04:00:00.000Z",
    status: "completed",
    recurrence: {
      frequency: "weekly",
      interval: 2,
      by_weekday: [6],
      by_n_weekday: null,
      by_month: null,
      by_month_day: null,
      end: "2026-12-20T02:00:00.000Z",
      count: null,
    },
  });
  const starts = occurrenceStarts(videoChat, Date.parse("2027-01-31T00:00:00Z"))
    .map((s) => new Date(s).toISOString())
    .filter((s) => s >= "2026-11");
  expect(starts).toEqual([
    "2026-11-08T02:00:00.000Z",
    "2026-11-22T02:00:00.000Z",
    "2026-12-06T02:00:00.000Z",
    "2026-12-20T02:00:00.000Z",
  ]);
});

test("an occurrence moved one at a time happens at its new time, not the rule's", () => {
  // Weekly on Tuesdays (UTC); the 1 December night moved to Thursday 3 December.
  const night = event({
    id: "5",
    name: "Game night",
    start: "2026-11-24T01:00:00.000Z",
    end: "2026-11-24T03:00:00.000Z",
    recurrence: { frequency: "weekly", interval: 1, by_weekday: [1], by_n_weekday: null, by_month: null, by_month_day: null, end: null, count: null },
    moved: [{ from: "2026-12-01T01:00:00.000Z", start: "2026-12-03T01:00:00.000Z", end: "2026-12-03T03:00:00.000Z" }],
  });
  const starts = eventsView([night], Date.parse("2026-12-09T00:00:00Z")).map((o) => o.start);
  expect(starts).toEqual(["2026-11-24T01:00:00.000Z", "2026-12-03T01:00:00.000Z", "2026-12-08T01:00:00.000Z"]);
});

test("a night its organiser ended early is over, though its scheduled end has not come", () => {
  // Weekly, Tuesdays 01:00-03:00 UTC. Tonight's ended at 01:30; Discord moved on to next week.
  const night = event({
    id: "6",
    name: "Game night",
    start: "2026-11-17T01:00:00.000Z",
    end: "2026-11-17T03:00:00.000Z",
    next: "2026-12-01T01:00:00.000Z",
    recurrence: { frequency: "weekly", interval: 1, by_weekday: [1], by_n_weekday: null, by_month: null, by_month_day: null, end: null, count: null },
  });
  const now = Date.parse("2026-11-24T02:00:00Z");
  const coming = eventsView([night], Date.parse("2026-12-09T00:00:00Z")).filter((o) => upcoming(o, now));
  expect(coming.map((o) => o.start)).toEqual(["2026-12-01T01:00:00.000Z", "2026-12-08T01:00:00.000Z"]);
});

test("a one-off Discord marks completed is over, though its scheduled end has not come", () => {
  const talk = event({
    id: "7",
    name: "AMA",
    start: "2026-11-24T01:00:00.000Z",
    end: "2026-11-24T03:00:00.000Z",
    status: "completed",
  });
  const now = Date.parse("2026-11-24T02:00:00Z");
  expect(eventsView([talk], Date.parse("2026-12-01T00:00:00Z")).filter((o) => upcoming(o, now))).toEqual([]);
});
