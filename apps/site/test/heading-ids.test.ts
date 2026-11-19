// Links migrated from Wiki.js keep `#fragment`s made by the wiki's own slug
// rule, so a heading must get the id the wiki gave it or the link lands at the
// top of the page.
import { expect, test } from "vitest";
import { slugify, withHeadingAnchors } from "../src/heading-ids.ts";

const heading = (style: string, text: string) => ({ _type: "block", style, children: [{ _type: "span", text }] });
const anchors = (...texts: string[]) =>
  withHeadingAnchors(texts.map((t) => heading("h2", t))).map((b) => (b as { anchor?: string }).anchor);

test("headings get the id Wiki.js gave them: lowercase, hyphens, no punctuation or emoji", () => {
  expect(slugify("Finding Channels and Threads")).toBe("finding-channels-and-threads");
  expect(slugify("🤰 Expecting")).toBe("expecting");
  // Checked against the rendered wiki's own ids: a run of spaces and hyphens is one hyphen.
  expect(slugify("🐣 Newborn *(0 - 8 weeks)*")).toBe("newborn-0-8-weeks");
  expect(slugify("So, what's Habitica?")).toBe("so-whats-habitica");
  expect(slugify("Hill Climb Racing  ")).toBe("hill-climb-racing");
  expect(slugify("Crème brûlée")).toBe("crème-brûlée");
});

test("a repeated heading takes -1, -2 in page order, and a heading's marks do not split its text", () => {
  expect(anchors("FAQ", "Background", "FAQ", "FAQ")).toEqual(["faq", "background", "faq-1", "faq-2"]);
  const marked = { ...heading("h3", "So, what's "), children: [{ text: "So, what's " }, { text: "Habitica" }, { text: "?" }] };
  expect(withHeadingAnchors([marked])[0]).toMatchObject({ anchor: "so-whats-habitica" });
});
