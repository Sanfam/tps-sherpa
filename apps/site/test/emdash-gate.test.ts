// The gate's placement of every EmDash route. Over HTTP, gate.test.ts checks
// that the hook is wired and each kind of caller gets the right answer.
import { expect, test } from "vitest";
import { ADMINS, EDITORS, MEMBER, REFUSED, SITE, place } from "../src/emdash-gate.ts";
import { NEVER, concrete, injected, unread } from "./emdash-routes.ts";

const lists = { refused: REFUSED, member: MEMBER, admin: ADMINS, editor: EDITORS, site: SITE } as const;
const listed = Object.entries(lists).flatMap(([need, patterns]) => patterns.map((p) => [p, need] as const));

test("EmDash's routes were read, all of them", () => {
  expect(unread).toBe(0);
  expect(injected.length).toBeGreaterThan(150);
  expect(injected).toContain("/_emdash/api/content/[collection]/[id]/preview-url");
});

test("every EmDash route is placed, once", () => {
  const unplaced = injected.filter((p) => !listed.some(([q]) => q === p));
  expect(unplaced, "add each to a list in src/emdash-gate.ts").toEqual([]);
  const seen = listed.map(([p]) => p);
  expect(seen.filter((p, i) => seen.indexOf(p) !== i)).toEqual([]);
});

test("each route resolves to its own list, not one a parameter elsewhere matches", () => {
  for (const [pattern, need] of listed) {
    expect(place(concrete(pattern)), pattern).toBe(need === "refused" ? null : need);
  }
});

test("credentials, whole-site exports and outside code are refused, whatever the lists say", () => {
  const never = injected.filter((p) => NEVER.test(p));
  expect(never).toContain("/_emdash/api/content/[collection]/[id]/preview-url");
  for (const pattern of never) expect(place(concrete(pattern)), pattern).toBeNull();
});

test("routes EmDash does not inject today are refused", () => {
  for (const path of [
    "/_emdash/api/auth/handover", // built-in auth only
    "/_emdash/api/content/pages/x1/room", // 1.5.0
    "/_emdash/api/content/x1/revisions/editors", // 1.5.0
    "/_emdash/api/unknown",
    "/_emdash",
    "/.well-known/anything",
  ]) {
    expect(place(path), path).toBeNull();
  }
});

test("other spellings of a refused route are refused", () => {
  for (const path of [
    "/_emdash/api/content/pages/x1/preview-url/",
    "/_EMDASH/api/content/pages/x1/preview-url",
    "/_emdash/api/content/pages/x1%2Fpreview-url",
    "/_emdash//api/content/pages/x1/preview-url",
    "/_emdash/api/%6Dcp",
    "/_emdash/api/content/%E0%A4%A",
  ]) {
    expect(place(path), path).toBeNull();
  }
});

test("the site's own pages are left to the site", () => {
  for (const path of ["/", "/members", "/auth/callback/discord", "/_emdashx"]) expect(place(path), path).toBe("site");
});
