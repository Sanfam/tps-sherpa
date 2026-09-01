# Papa Squad hub site + Papa Sherpa

Glossary for the Catalog, the Index, and the Papa Sherpa bot. Definitions only — decisions and rationale live in `docs/`.

## Language

### Discord structure

**Forum**:
A Discord forum channel (API type 15) whose contents are exclusively Posts. Has a name, mod-authored post guidelines, and a defined tag set. Carries no messages of its own.
_Avoid_: forum channel, category

**Post**:
A thread that lives inside a Forum. Its starter message (the "first post") is the topic body, and its ID equals that message's ID. Carries `applied_tags` from the Forum's tag set.
_Avoid_: forum thread, forum post, topic

**Thread**:
A Discord thread spawned from within a standing text channel — not inside a Forum. Same underlying object as a Post but without a parent Forum or `applied_tags`.
_Avoid_: sub-thread

**Channel**:
A standing Discord text channel that is not a Forum. What a `<#id>` mention
resolves to, and what the bot recommends people go to. May contain Threads.
_Avoid_: text channel, room

### The catalog

**Entity**:
Any catalog record the Index describes. Spans Channels, Forums, Posts, and
Threads. Not a synonym for Post — use the specific term unless a statement is
genuinely true of all four.
_Avoid_: item, record, object

**Catalog**:
The dataset of Entities — names, summaries, tags, activity. What the bot builds
and what the matching prompt reads.
_Avoid_: index, database, corpus

**Index**:
The rendered, searchable page over the Catalog. The artifact a person browses.
One Catalog can have more than one Index; the Catalog is the data, the Index is
the presentation.
_Avoid_: catalog, directory, listing

## Gating and discovery

**Access**:
Whether a person may see a thing at all. Expressed as the guild roles that grant
it. A wall: absent or unrecognised Access means not visible.
_Avoid_: permission, gating, visibility

**Affinity**:
Whether a thing is likely to interest a person, used to order and surface
content. Never restricts. A thing with broad Affinity and narrow Access is
possible, and so is the reverse.
_Avoid_: relevance, interest, recommendation, tag

## People

Roles are Discord-first: guild role membership is the source of truth, and every
other role is derived from it. A person can hold more than one of these at once.

**Staff**:
A person holding the `Staff` or `Event Managers` role in the guild. Administers
the CMS, edits any content, and performs bot management actions.
_Avoid_: mod, moderator, admin

**Club Lead**:
A person who owns a club or interest group and is expected to edit only that
club's pages. The limit is a convention among a small, known group, not a
control the CMS enforces. Held today by people in `Event Managers`; becoming its
own guild role.
_Avoid_: club owner, page owner, group admin

**Member**:
A person holding the `Member` role in the guild. May view member-gated content
on the site and may interact with the bot.
_Avoid_: user, guild member

**User**:
A Member who is signed in to the website through Discord authentication. Names
the authenticated web session, not the person — the same person is a Member in
Discord and a User on the site.
_Avoid_: visitor, account, logged-in member

**Viewer**:
Someone browsing the website who is not a Member of the guild. Sees only public
content.
_Avoid_: reader, guest, anonymous user
