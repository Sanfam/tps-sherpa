// The Index decides who sees which Entity, and which model text is shown, by
// rules the bot defines first. The site's image carries none of the bot's
// source, so it holds copies; these tests keep the copies honest and keep a
// Staff-only place off a Member's page and out of its search data.
import { expect, test } from "vitest";
import { linkOrMarkup as botLinkOrMarkup } from "../../bot/src/llm/boundary.ts";
import { type Entity, visibleTo as botVisibleTo } from "../../bot/src/sync/catalog.ts";
import type { CatalogEntity } from "../src/catalog-snapshot.ts";
import { indexView, linkOrMarkup, visibleTo } from "../src/index-view.ts";

const MEMBER = "300000000000000001";
const STAFF = "300000000000000002";
const HOBBY = "300000000000000003";
const ADMIN = "300000000000000004";

test("the site decides who sees an Entity, and which summaries are shown, as the bot does", () => {
  // Shaped like the overwrites the bot's Discord adapter records.
  const access = [
    { allow_roles: [HOBBY, ADMIN], view_roles: [HOBBY, ADMIN], deny_roles: [] },
    { allow_roles: [ADMIN], view_roles: [HOBBY, STAFF, ADMIN], deny_roles: [MEMBER] },
    { allow_roles: [HOBBY, ADMIN], view_roles: [HOBBY, STAFF, ADMIN], deny_roles: [MEMBER, ADMIN] },
    { allow_roles: [], view_roles: [MEMBER], deny_roles: [STAFF] },
    { allow_roles: [STAFF, ADMIN], view_roles: [STAFF, ADMIN], deny_roles: [] },
    { allow_roles: [], view_roles: [], deny_roles: [] },
    {},
    { allow_roles: [MEMBER], view_roles: [MEMBER] },
  ];
  const holdings = [[], [MEMBER], [MEMBER, HOBBY], [MEMBER, STAFF], [MEMBER, ADMIN], [HOBBY], [STAFF], [ADMIN]];
  for (const a of access) {
    for (const roles of holdings) {
      expect(visibleTo(a, roles), JSON.stringify({ a, roles })).toBe(botVisibleTo(a as Entity, roles));
    }
  }

  const summaries = [
    "A place for dads who fly sims to swap setups.",
    "Grab the patch at https://example.com before Friday.",
    "Everything lives on example.com/files now.",
    "Join us at discord.gg/abc",
    "Check www.example.com",
    "Ping @everyone when the raid starts.",
    "Carries on in <#123456789012345678>.",
    "The ending is ||he was the dad all along||.",
    "See [the guide](https://example.com).",
    "See [the guide](/guide).",
    "Mirror at https:\\/\\/example.com",
    "Rates are 3.5% this year, e.g. for a 30-year loan.",
    "Fishing, boats, and the one that got away.",
  ];
  for (const s of summaries) expect(linkOrMarkup(s), s).toBe(botLinkOrMarkup(s));
});

const entity = (e: Partial<CatalogEntity> & Pick<CatalogEntity, "id" | "type" | "name">): CatalogEntity => ({
  url: `https://discord.com/channels/100000000000000000/${e.id}`,
  parent_id: null,
  description_status: "present",
  topic: null,
  applied_tags: [],
  region: [],
  topics: [],
  topics_version: 2,
  thread_state: null,
  last_message_id: null,
  last_activity_at: "2026-11-01T12:00:00.000Z",
  summary_generated: null,
  summary_override: null,
  ...e,
});

test("a Member's Index, and its search data, carry nothing from a Staff-only Forum", () => {
  const everyone = { allow_roles: [], view_roles: [MEMBER, STAFF], deny_roles: [] };
  const staffOnly = { allow_roles: [STAFF], view_roles: [STAFF], deny_roles: [] };
  const catalog = [
    entity({ id: "500000000000000001", type: "channel", name: "general", topic: "Say hello.", ...everyone }),
    entity({ id: "500000000000000002", type: "forum", name: "fishing", summary_generated: "Boats and bait.", ...everyone }),
    entity({
      id: "500000000000000003",
      type: "post",
      name: "Best spinning reel?",
      parent_id: "500000000000000002",
      thread_state: "open",
      ...everyone,
    }),
    entity({
      id: "500000000000000004",
      type: "forum",
      name: "staff-casework",
      summary_override: "Where Staff weigh reports about members.",
      topics: ["discussion"],
      ...staffOnly,
    }),
    // A Post carries its Forum's access.
    entity({
      id: "500000000000000005",
      type: "post",
      name: "Report: harassment in voice",
      parent_id: "500000000000000004",
      topic: "Two members reported the same account on Friday.",
      applied_tags: ["Open case"],
      thread_state: "open",
      ...staffOnly,
    }),
  ];
  const vocabulary = [{ slug: "discussion", label: "Discussion" }];

  const seen = JSON.stringify(indexView(catalog, [MEMBER], vocabulary));
  for (const secret of [
    "500000000000000004",
    "500000000000000005",
    "staff-casework",
    "Where Staff weigh reports",
    "Report: harassment",
    "Two members reported",
    "Open case",
  ]) {
    expect(seen).not.toContain(secret);
  }
  // The Member's own places are there, so the absence above is not an empty page.
  for (const shown of ["general", "fishing", "Best spinning reel?"]) expect(seen).toContain(shown);
  // Staff's Index has it, so the Member's lacks it because of who they are.
  expect(JSON.stringify(indexView(catalog, [MEMBER, STAFF], vocabulary))).toContain("Report: harassment");
});
