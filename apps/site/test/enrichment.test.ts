// The decisions behind scripts/enrich-works.ts, on Open Library search hits
// shaped as it returns them. A wrong pick writes another book's year, cover
// and blurb into a club's works and publishes them; a wrong "empty" overwrites
// an editor's text or publishes their unfinished draft.
import { expect, test } from "vitest";
import { fillable, firstParagraph, pickMatch, replaceable, respelled, type Doc, type Entry } from "../scripts/enrichment.ts";

// What search.json returned for "the hobbit" (2026-11-17), the graphic-novel
// adaptation moved first: it shares the title and credits Tolkien too.
const HOBBIT: Doc[] = [
  { key: "/works/OL219602W", title: "The Hobbit", author_name: ["Charles Dixon", "Sean Deming", "J.R.R. Tolkien"], edition_count: 10, first_publish_year: 1990 },
  { key: "/works/OL27482W", title: "The Hobbit", author_name: ["J.R.R. Tolkien"], edition_count: 482, first_publish_year: 1937, cover_i: 14627509 },
  { key: "/works/OL14926019W", title: "The Hobbit & The Lord of the Rings [collection/set]", author_name: ["J.R.R. Tolkien"], edition_count: 27 },
  { key: "/works/OL14933471W", title: "Poems from The hobbit", author_name: ["J.R.R. Tolkien"], edition_count: 3 },
];

test("the book itself is chosen over an adaptation with the same title, however the author is spelled", () => {
  for (const creators of ["J. R. R. Tolkien", "JRR Tolkien"]) {
    const m = pickMatch("The Hobbit", creators, HOBBIT);
    expect(m).toEqual({ doc: HOBBIT[1], confidence: "high" });
  }
});

test("a subtitled adaptation or a surname alone is only suggested, never applied", () => {
  const novel: Doc = { key: "/works/OL1W", title: "The Hobbit", subtitle: "Graphic Novel", author_name: ["J.R.R. Tolkien"], edition_count: 900 };
  expect(pickMatch("The Hobbit", "J.R.R. Tolkien", [novel])).toEqual({ doc: novel, confidence: "low" });
  expect(pickMatch("The Hobbit", "J.R.R. Tolkien", [novel, HOBBIT[1]!])).toEqual({ doc: HOBBIT[1], confidence: "high" });
  const albert: Doc = { key: "/works/OL2W", title: "It", author_name: ["Albert King"], edition_count: 5 };
  expect(pickMatch("It", "King, Stephen", [albert])).toEqual({ doc: albert, confidence: "low" });
  expect(pickMatch("The Hobbit", "Tolkien", HOBBIT)).toEqual({ doc: HOBBIT[1], confidence: "low" });
});

test("a surname written as one word or two, and accents, still name the same author", () => {
  const docs: Doc[] = [
    { key: "/works/OL59863W", title: "The Left Hand of Darkness", author_name: ["Ursula K. Le Guin"], edition_count: 92 },
    { key: "/works/OL274505W", title: "Cien años de soledad", author_name: ["Gabriel García Márquez"], edition_count: 300 },
  ];
  expect(pickMatch("The Left Hand of Darkness", "Ursula K. LeGuin", docs)).toEqual({ doc: docs[0], confidence: "high" });
  expect(pickMatch("Cien Anos de Soledad", "Gabriel Garcia Marquez", docs)).toEqual({ doc: docs[1], confidence: "high" });
});

test("the same title by another author is no match, so another book's details are never written", () => {
  const london: Doc = { key: "/works/OL74505W", title: "The Road", author_name: ["Jack London"], edition_count: 120 };
  const mccarthy: Doc = { key: "/works/OL5735363W", title: "The Road", author_name: ["Cormac McCarthy"], edition_count: 95 };
  expect(pickMatch("The Road", "Cormac McCarthy", [london, mccarthy])).toEqual({ doc: mccarthy, confidence: "high" });
  expect(pickMatch("The Road", "Cormac McCarthy", [london])).toEqual({ reason: "title found, but by Jack London" });
});

test("a sequel or a title with no creators to check is only suggested, never applied", () => {
  const messiah: Doc = { key: "/works/OL893502W", title: "Dune Messiah", author_name: ["Frank Herbert"], edition_count: 101 };
  const dune: Doc = { key: "/works/OL893415W", title: "Dune", author_name: ["Frank Herbert"], edition_count: 155 };
  expect(pickMatch("Dune", "Frank Herbert", [messiah])).toEqual({ doc: messiah, confidence: "low" });
  expect(pickMatch("Dune", undefined, [messiah, dune])).toEqual({ doc: dune, confidence: "low" });
});

const published: Entry = { status: "published", data: {}, liveRevisionId: "r2", draftRevisionId: "r2" };
const proposed = { year: 1937, link: "https://openlibrary.org/works/OL27482W", description: "A tale.", cover: "https://covers.openlibrary.org/b/id/1-L.jpg" };

test("only fields still empty are filled; what an editor set is kept", () => {
  const data = { year: null, link: "", description: "The club's own blurb.", cover: { provider: "local", id: "m1", src: "/x.jpg" } };
  expect(fillable({ ...published, data }, proposed)).toEqual({ fill: ["year", "link"] });
});

test("a published entry is filled, but one with an editor's unpublished changes is left alone", () => {
  // After a publish EmDash may leave the draft pointer on the live revision: nothing is pending.
  expect(fillable(published, proposed)).toEqual({ fill: ["year", "link", "description", "cover"] });
  expect(fillable({ ...published, draftRevisionId: "r3" }, proposed)).toEqual({ skip: "entry has unpublished changes" });
  expect(fillable({ ...published, status: "draft", liveRevisionId: null, draftRevisionId: null }, proposed)).toEqual({
    skip: "entry is draft, not published",
  });
});

test("an Open Library description gives its first paragraph, without the source credit or link list", () => {
  const description = {
    type: "/type/text",
    value:
      "A reluctant [hobbit](https://example.org/h) joins a quest for dragon-guarded gold. ([source][1])\r\n\r\nMore about the book.\r\n\r\n----------\r\n[1]: https://example.org/source",
  };
  expect(firstParagraph(description)).toBe("A reluctant hobbit joins a quest for dragon-guarded gold.");
});

// A standardize plan replaces set values, so a wrong "differs" writes someone
// else's name into a club's creators, or churns them over punctuation.
test("creators are respelled only where a name's letters differ from Open Library's", () => {
  expect(respelled("Steven King", ["Stephen King"])).toBe("Stephen King");
  expect(respelled("J. R. R. Tolkien", ["J.R.R. Tolkien"])).toBeUndefined();
  expect(respelled("Gabriel Garcia Marquez", ["Gabriel García Márquez"])).toBeUndefined();
  expect(respelled("Iain M. Banks", ["Iain Banks"])).toBeUndefined(); // the name he wrote SF under
  // "King, Stephen" reads as two people, and only one is an author: no safe respelling.
  expect(respelled("King, Stephen", ["Stephen King"])).toBeUndefined();
});

test("co-authors keep the entry's order and separators, and Open Library's extra credits are not added", () => {
  const authors = ["Terry Pratchett", "Neil Gaiman"];
  expect(respelled("Niel Gaiman and Terry Pratchett", authors)).toBe("Neil Gaiman and Terry Pratchett");
  expect(respelled("Neil Gaiman & Terry Pratchett", authors)).toBeUndefined();
  expect(respelled("Homer", ["Homer", "Robert Fagles"])).toBeUndefined();
});

test("a planned replacement is dropped once an editor has changed the field since the plan", () => {
  const cover = { provider: "local", id: "m1", src: "/_emdash/api/media/file/m1.jpg" };
  const entry: Entry = { ...published, data: { creators: "Steven King", cover } };
  const replace = {
    creators: { from: "Steven King", to: "Stephen King" },
    cover: { from: { id: "m1", src: cover.src }, to: "https://covers.openlibrary.org/b/id/1-L.jpg" },
  };
  expect(replaceable(entry, replace)).toEqual(["creators", "cover"]);
  const edited: Entry = { ...entry, data: { creators: "Stephen King", cover: { ...cover, id: "m2", src: "/_emdash/api/media/file/m2.jpg" } } };
  expect(replaceable(edited, replace)).toEqual([]);
});
