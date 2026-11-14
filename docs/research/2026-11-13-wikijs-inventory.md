# Wiki.js inventory

Research note, 2026-11-13. It answers open question 2 of
`docs/proposals/project-fundamentals/ASTRO-ARCHITECTURE.md` ("Wiki.js
inventory"), which scopes the Phase 6 migration.

**How it was taken.** The source was `wiki.papasquad.xyz`, through Wiki.js's
public GraphQL API (page list and asset list) and its rendered pages, as a
guest. Nothing was edited. Page titles are not listed here, since some
name members.

- **The wiki's TLS certificate has expired** *(verified 2026-11-13)*. HTTPS
  fails the handshake and plain HTTP redirects to HTTPS, so the wiki is
  broken for everyone. The inventory was read with certificate checks off,
  as the owner authorised.
- **Guests can list pages and assets and read rendered pages, but not
  the Markdown source:** `pages.single` answers "You are not authorized".
  Every published page's content was rebuilt from what guests can read.
  Only the exact Markdown source and the one unpublished draft need a
  signed-in session or an API key.

## The corpus *(verified 2026-11-13)*

| | |
|---|---|
| Pages | 24: 23 published, 1 unpublished draft. All English, none private |
| Depth | at most 3 path segments (2 at depth 1, 12 at 2, 10 at 3) |
| Sections | `parenting` 10, `entertainment` 6, `papasquad` 6, 2 at the root |
| Words, rendered | 35,302 in all, **28,411 of them on one page**: `papasquad/threads-and-channels` |
| Words, the rest | about 6,900 over 22 pages, the largest about 960 |
| Last edit | 2026-08-07. Nearly every page dates from 2025-06-30 |
| Tags | on 10 pages |
| Markup in use | lists, `h2`/`h3`, blockquotes, one table, one code block. No diagrams or embeds |

**`papasquad/threads-and-channels` is the script-generated channel index**
that PROJECT-STATUS.md calls stale, and the hub site's Catalog replaces it.
It is kept in the export like every other page, since the handoff says all
content migrates and none is lost. Whether it is published again is the
owner's call. Without it, the rest is 22 short pages.

## Images and assets

- **Assets:** 65 files, 16.7 MB. 31 at the root, and the rest in
  `book_club_covers` (22) and `book_of_marvin` (12). Two empty folders.
  All are images but one file with no extension (60 KB, kind `BINARY`).
- **Embedded:** 112 images. 94 are the wiki's own assets. 18 are hotlinked:
  14 book covers from `cdn.thestorygraph.com`, 2 from Amazon, and **2 from
  `cdn.discordapp.com`, whose signed links expire.** They are likely gone
  already, and should be checked before migrating.
- **Outbound links:** mostly StoryGraph (35) and `discord.com` (22) message
  and channel links, which stay valid only as long as their targets do.

## Reconstituted *(2026-11-14, owner: "what matters is the content")*

All 23 published pages, the stale index included, were rebuilt as Markdown
from the rendered pages,
with front matter: title, path, tags, dates, and the source URL. All 66
downloadable assets were saved, and image links point at the local copies.
The export is kept **out of git** in `.wiki-export/` (excluded locally,
ADR-0001), with a README listing what was left out and the rough edges:

- the unpublished draft is not in it: it needs a signed-in read;
- one asset with no extension would not download;
- one dead Discord-CDN image;
- the book club's cover grid came out flattened.

## What this means for Phase 6

- The volume is small. Moving 22 pages and about 100 images is a day's
  work or less by any route, including by hand.
- ADR-0002 notes "no importer exists" for EmDash's Portable Text. At this
  size, a converter is optional.
- The open question is not migration effort. It is whether Club Leads will
  keep editing, which is what the CMS (and ADR-0002's open items) is for.
