# Build handoff: Papa Squad hub site + Papa Sherpa

**Audience:** an LLM-backed coding agent, or a team of them, working with substantial autonomy.
**Date:** 2026-08-31.
**Supersedes:** the 2026-08-27 revision of this file, and in `PROJECT-STATUS.md` — §3 (architecture), the Storage subsection of §4, §5 (Instatic), §6 (open decisions), and Track 2 of §9.
**Companions:**
- `CONTEXT.md` — the glossary. **Its vocabulary is binding.** Where this document and the glossary disagree about what a word means, the glossary wins.
- `PROJECT-STATUS.md` — history, rejected options, the privacy model, verified Discord API facts, observed data from real transcripts, and the introductions-responder spec in §7. All still current except the sections named above.

---

## How to work this document

Read this section before implementing anything.

### Three kinds of statement, treated differently

**Locked decisions** — implement as written. If you come to believe one is wrong, **stop and say so**. Do not route around it, and do not implement a compromise that partially honours it. Most were reached after evaluating and rejecting specific alternatives.

**Open questions** — genuinely undecided. Do not pick one silently and proceed. Surface options and a recommendation, then wait.

**Estimates** — every number here is an estimate unless marked *(verified)*. At least one figure in an earlier draft was wrong by an order of magnitude before correction. Measure against the real corpus before optimising against any number in here.

### What was verified, and when

Claims marked *(verified 2026-08-30)* or *(verified 2026-08-31)* were checked against primary sources — vendor docs, GitHub APIs, and library source — on those dates. Everything else is inherited belief and should be re-checked before code depends on it. Where a claim turns out to be wrong, **correct this document and note the correction** rather than silently working around it.

Two beliefs in the previous revision were wrong and are corrected below: that EmDash was a community project rather than a Cloudflare one, and that Tina's viability turned on its memory footprint.

### Stop conditions — halt and ask a human

Do not proceed autonomously past any of these:

- A locked decision appears to be wrong, or two of them conflict
- Anything touching child data, member PII, or redaction beyond exactly what is specified
- The first time the bot would post publicly in Discord
- Any credential or OAuth scope beyond those named here
- Any retention window, purge, or deletion of member data
- Adding a database, a migration, or a new vendor
- Projected running cost exceeding roughly $30/month
- A test on the golden set regresses and the fix is not obvious

### Discovery phases produce measurements, not code

Where a phase says "discovery," the deliverable is numbers and a recommendation written back into this document. Implementing during discovery defeats the point.

### Work parallelisation

Three tracks run independently until Phase 4:

| Track | Scope | Depends on |
|---|---|---|
| **A — Bot** | Sync, Tier 0 capture, summaries, tags, slash commands | Nothing |
| **B — Site** | Auth spike, Astro shell, middleware, gating tests | Nothing |
| **C — CMS** | Tina self-hosted spike, club-page trial | Nothing (but see the two-day abort) |

Track A owns the data contract (`content/index/data.json`); Track B consumes it. Agree the schema early and stub it so both can proceed.

---

## The decomposition

The mistake in every earlier iteration was shopping for one system to do three jobs. They separate cleanly:

| Layer | Owner | Replaceable? |
|---|---|---|
| **Delivery** — renders pages, serves readers | Astro (SSR) | No — this is the app |
| **Reader auth** — who may see what | Ours, ~400 lines | No — nothing ships it |
| **Content editing** — how mods change text | A CMS | **Yes, freely** |

Every CMS evaluated — Instatic, Tina, EmDash, Keystatic, Decap, Sveltia, PagesCMS, Directus, Payload, Strapi, Ghost, Wiki.js — authenticates people who *change* content. Gating *readers* on external group membership is a portal feature, and essentially nothing self-hostable ships it in a form that fits this stack *(verified 2026-08-31 — the sole exception is Ghost, which gates published pages on member tiers but requires MySQL 8 and magic-link email identity)*.

So reader gating is ours, and **that is precisely what makes the CMS swappable.** Do not reintroduce reader gating as a CMS selection criterion. It has been tried twice; both times it collapsed the field to one immature candidate.

---

## Locked decisions

- **Astro, SSR mode**, Node adapter. Everything gated is server-rendered.
- **Reader auth is ours**, built on **Better Auth**'s Discord provider. Scope `identify` only; guild membership and roles resolved server-side with the bot token.
- **Git is the content bus.** The bot commits; the CMS commits; Astro reads. No content database.
- **One monorepo** containing bot, site, content, and docs.
- **A small, disposable session database** on the Astro service (Better Auth's requirement). Not shared with the bot, not backed up.
- **Bot state is SQLite, bot-side only — and not all of it is backed up.** *(Refined 2026-09-01.)* Two kinds:
  - **Rebuildable cache** — Tier 0 raw text, sync bookkeeping. Lives on the service's volume with **no replication**. Losing it costs one re-crawl, and replicating raw member-authored message text off-vendor would outlive the member's own deletions, widening the narrow Tier 0 exception in exactly the direction the privacy model resists.
  - **Durable state** — opt-outs, interest profiles, recommendation history, intro-responder terminal states. **This** is what gets Litestream → R2 and a rehearsed restore. None of it exists before Phase 3; the requirement travels with the first ticket that creates it. Losing an opt-out means re-approaching someone who asked not to be.
- **CMS is Tina, self-hosted, backend-only**, and must not require editors to hold GitHub accounts.
- **Sherpa history stays bot-side.** Members query it through the bot, not the site.
- **Bot-first phasing.** Slash commands ship before the website.
- **Access and Affinity are separate mechanisms.** See below.

### Retracted from earlier revisions

- **Shared Railway Postgres is retracted.** Its stated justification was that two services needed one dataset. That premise died with the Instatic architecture: git is the bus, and the site's only database is a disposable session store. `PROJECT-STATUS.md` §4 Storage and §12 action 1 are void. Postgres remains open for *future* evaluation, but nothing in the current design needs it.
- **Instatic is dead.** It is a Bun-only standalone server that ships its own static publisher — it replaces Astro rather than complementing it. Its reader-gating lives in PR #311, which as of 2026-08-31 is open, merge-conflicted, 402 files / +30k lines, with **zero review activity in 32 days**, behind three other workstreams the maintainer named as prerequisites *(verified 2026-08-31)*. Maintaining a fork of that size to obtain a capability our own middleware already provides is cost without benefit.
- **EmDash is dead** — with a correction. It **is** a Cloudflare project: Cloudflare Inc. holds the copyright, it was announced on Cloudflare's blog, its creator and top committer is a Cloudflare employee, and Cloudflare moved its own blog onto it on 2026-08-12 *(verified 2026-08-30)*. The previous revision's dismissal was based on a wrong premise. It is nonetheless ruled out here: content is Portable Text JSON in SQL tables rather than markdown (so the "content stays portable markdown either way" escape hatch is false for it), there is **no git mode and none on the 1.0 roadmap**, JSON backup restoration is "intentionally not exposed" and snapshot generation is currently broken on Postgres, and it is `0.35.0` beta preview with no LTS or stability commitment. **Re-evaluate only when both are true: 1.0 shipped, and a documented git-sync or file-based content story exists.**

---

## Shape

```
┌──────────────────────────────┐
│  Discord service (Node)      │
│  • gateway listener          │
│  • scheduled sync            │
│  • Tier 0 capture            │
│  • LLM tagging + summaries   │
│  • Papa Sherpa               │
│  • build-failure alarm       │
└──────┬────────────────┬──────┘
       │                │
   commits          SQLite (bot-only)
   content          (Tier 0 + sync state: volume, no backup
       │             profiles, history, opt-outs: Litestream
       │             → R2, from Phase 3)
       ▼
┌───────────────┐         ┌──────────────────────┐
│   Git repo    │◀───────▶│  Tina (self-hosted)  │
│ • club pages  │ commits │  • editor auth       │
│ • data.json   │         │  • visual editing    │
│ • roles.json  │         │  • sqlite-level      │
│ • landing     │         │    (rebuildable)     │
└───────┬───────┘         └──────────────────────┘
        │ reads
        ▼
┌──────────────────────────────┐
│  Astro (SSR, Node adapter)   │
│  • /auth/discord/*           │
│  • session middleware        │
│  • gated Index + club pages  │
│  • public landing (static)   │
└──────────────────────────────┘
```

Two Railway services. Cloudflare for DNS, origin proxy, **and R2** (the Litestream target — note this is a wider Cloudflare surface than "DNS and proxy only," which earlier drafts claimed). No content database.

---

## Repository layout

One repo, two deployed services:

```
apps/bot/          Discord service — gateway, sync, LLM pipeline, Sherpa
apps/site/         Astro SSR app + Tina backend route
content/
  index/data.json      Catalog, written by the bot every sync
  clubs/*.md           Club pages, edited in the CMS
  config/roles.json    Guild role manifest (id ↔ name), written by the bot
  config/index-flags.json  Promote/exclude flags
  landing.md           Public landing page
  privacy.md           Privacy policy
docs/              This document and its companions
```

**Railway watch paths per service** so a content commit rebuilds the site and does not redeploy the bot.

**The bot pushes directly to `main`** on content paths, as an **org-owned machine account or GitHub App — never a personal access token**. No PR flow: a PR nobody reviews is theatre, and the real safety net is CI. Build in CI, deploy only on green; a bad content commit fails the build and the live site keeps serving the last good version. `git revert` is the fix.

Two repos were considered and rejected: the content bus becomes a directory rather than a cross-repo push with a token to manage, and one clone is the whole system — which matters for the handoff problem this project exists to solve.

---

## Reader auth

### Flow

1. `GET /auth/discord/start` → redirect with `client_id`, `redirect_uri`, `response_type=code`, `scope=identify`, signed single-use `state`.
2. `GET /auth/discord/callback` → verify state, exchange code, `GET /users/@me` for the snowflake, **discard the user's access token**.
3. `GET /guilds/{GUILD_ID}/members/{user_id}` with `Authorization: Bot <token>`. 404 → not in the guild → reject. 200 → membership plus a `roles` array.
4. **Check the `roles` array for the `Member` role.** A 404 answers "is this person in the guild"; it does not answer "is this person a Member." Someone who has joined but not yet been granted the role must not receive gated content.
5. Map role ids → group slugs from `content/config/roles.json`.
6. Issue a session; store `{ discord_id, role_ids, roles_fetched_at }` **server-side**, with only an opaque token in the cookie.

### Why `identify` + bot token, not `guilds.members.read`

`guilds.members.read` authorizes *your app acting as the user*, so re-checking membership later requires their access token — which expires in about a week, meaning refresh tokens at rest and a refresh flow to maintain.

The bot token has no such dependency. You can re-verify anyone at any time without them present. Since periodic revalidation is a requirement, this is the difference between a working design and a broken one.

### Better Auth mechanics *(verified 2026-08-30)*

Three things were open in the previous revision and are now answered from source:

- **Rejecting a non-member before a user row exists:** override the Discord provider's **`getUserInfo`**. It receives the access token and is awaited in the OAuth callback well before `handleOAuthUserInfo` creates any row; returning `null` rejects the sign-in with nothing persisted. Do the guild lookup there. `databaseHooks.user.create.before` also exists and can abort, but it receives no token and therefore cannot perform the lookup itself.
- **Scope:** `discord: { disableDefaultScope: true, scope: ["identify"] }`. The `scope` option *appends*; `disableDefaultScope` is what removes the default `identify email`.
- **⚠️ A defect the previous revision missed:** the OAuth callback hard-fails with `EMAIL_NOT_FOUND` when the profile carries no email. Scope `identify` returns no email, so **the locked scope decision breaks sign-in unless `mapProfileToUser` synthesises one** — use `<discord_id>@discord.local`. This is the same synthesis trick an earlier Instatic-era design arrived at independently, which is mild evidence it is the right shape.

### Role staleness

Do **not** bake roles in at login and forget them. A promoted member would stay locked out until re-login; a demoted one would keep access. Store `roles_fetched_at` and re-fetch past a TTL — cheap, because the bot token makes it a single call.

### Role data is member data

A member's Discord role list is not a set of neutral labels. Regional roles, life-stage roles, support-group roles and self-assigned interest roles sit in the same array, and some of them are exactly the inference the privacy model works to avoid deriving. Therefore:

- **Store role IDs, never names.** Names change; IDs don't.
- **Server-side only.** The cookie carries an opaque session token, not the array.
- Role data falls under the same retention and opt-out rules as everything else about a member.
- Never render a User's role list back to them or to anyone else, and never put roles in an LLM prompt.

### ⚠️ The prerender footgun

In Astro, `prerender = true` routes are built to static HTML and served by the adapter **without middleware running**. A gated page that is prerendered leaks. SSR everything except the public landing page, and add a test asserting no route with an `access` field is prerendered.

---

## Access and Affinity

These are two mechanisms and must not be merged. Merging them means the only way to make something findable for a group is to make it invisible to everyone else.

| | **Access** | **Affinity** |
|---|---|---|
| Answers | May this person see it? | Is this person likely to care? |
| Effect | A wall | A sort order |
| Set by | Staff, deliberately, rarely | Derived from Catalog tags; cheap and revisable |
| Wrong value costs | A leak or a lockout | A slightly worse ordering |

### Access rules

- **Default-deny.** Content with no `access` field is Member-gated. Public is an explicit opt-in on the handful of pages that want it. The earlier Instatic evaluation found the opposite default — pages tolerant-parsing to public, world-readable until gated — and named it as fail-open. Do not rebuild that.
- **Any-of semantics.** Holding any one listed role grants access. It is what people expect and it cannot accidentally lock everyone out.
- **No deny rules.** Grants only. Grant-plus-deny is where access-control bugs live; add it when there is a real case, which there is not.
- **Unrecognised roles fail closed.** A role deleted in Discord drops out of the manifest, stops matching, and the page becomes Staff-only rather than public.

Frontmatter:

```yaml
access: { level: roles, roles: ["<role_id>", "<role_id>"] }
affinity: { tags: [flight-sim, aviation] }
```

### The role manifest

The bot already syncs the guild; it also emits `content/config/roles.json` (`id` ↔ `name`) and commits it. Tina's Access field is a select sourced from that file: **the editor picks a name, the stored value is the ID, and rendering resolves the ID back to a name.** A renamed role updates the manifest on the next sync and every gate keeps working.

This is the lesson the old index taught the hard way — `steam-deck-gaming` was renamed `steam-deck-and-handhelds` and the page broke. *Key everything on ID; treat names as mutable.*

### Affinity

Affinity is a field on content. Each consumer brings its own profile: the bot matches it against the interest profile it builds from intros; the site matches it against the signed-in User's roles. One field, two consumers, no shared personalization layer.

**On the site, ship Affinity as a filter, not a ranking** — a "matches my interests" toggle over the existing search. A filter is a checkbox someone can reason about and turn off; a ranking is a system that will eventually be accused of hiding things, in a community where being findable is the entire point. Ranking is a later decision a filter does not block.

---

## Content model

| Content | Path | Written by | Edited by |
|---|---|---|---|
| Club pages | `content/clubs/*.md` | Wiki.js migration | Club Leads, in the CMS |
| Catalog | `content/index/data.json` | Bot, per sync | Staff, in the CMS |
| Role manifest | `content/config/roles.json` | Bot, per sync | Nobody |
| Landing page | `content/landing.md` | Bot fills slots | Staff |
| Privacy policy | `content/privacy.md` | Human | Staff |
| Promote/exclude flags | `content/config/index-flags.json` | Staff | Staff, in the CMS |

Flags living in git is what removes the last shared-state requirement: the bot reads them from the repo at sync time rather than from a database the site also writes.

### Override pattern

Each Catalog entity carries:

- `summary_generated` — bot overwrites every sync
- `summary_override` — human-only; the renderer prefers it

The bot never writes the override field, so it structurally cannot clobber a correction. Git supplies the audit trail for free.

This answers the real defects in the current index: the Escape from Tarkov entry's 200-word paste, the Formula 1 entry's full race calendar, and the entries that render empty because the first post was image-only.

---

## CMS: Tina, self-hosted

### Why

Against the stated criteria — free-to-cheap, well-featured, visual editing with a markdown alternative, minimal database, full-text search, coexists with Astro — Tina is the only candidate that clears all of them *(surveyed 2026-08-31)*. Auth.js gives username/password editors; content stays markdown in git; `@tinacms/search` covers full-text; Astro is becoming Tina's default starter with React-free visual editing.

Two candidates were eliminated on hard constraints rather than preference: **Directus** caps its free tier at 3 editor seats under a non-OSI licence (there are ~5 editors), and **Payload requires Next.js**. Keystatic, Decap, Sveltia and PagesCMS are all git-host-OAuth-only — none offers username/password, so relaxing the Discord-auth requirement did not rescue them.

### The database question

Tina requires *a* database, but not a database *service*. Its officially supported adapters are MongoDB and "Vercel KV" — and note that **"Vercel KV" means Upstash's HTTP REST API specifically, so Railway's Redis will not satisfy it** *(verified 2026-08-30)*.

**Use `sqlite-level`**: a SQLite file on the site service's own volume, no separate service. This is safe because Tina's datalayer is, in its own docs, *"an ephemeral cache, since the single source of truth for your content is really your Markdown/JSON files."* Losing it means a rebuild, not data loss.

Known risks, accepted with eyes open *(verified 2026-08-30)*: `sqlite-level` is not on the documented adapter list, a Tina maintainer has an open issue noting it has **no CI coverage as an adapter**, and three community bug-fix PRs have sat unmerged for over a year. It is nonetheless maintained-when-broken — two self-hosted users hit bugs in 2026 and both got fixes.

**Do not write a Postgres adapter.** No `abstract-level` Postgres implementation exists, and building one is writing a database driver to avoid adding a database.

### ⚠️ The spike, and its abort condition

Self-hosted Tina on Astro is supported in principle and **is not a documented recipe** — the backend docs cover Next.js, Vercel Functions and Netlify Functions only, and the official Astro starter is TinaCloud-based *(verified 2026-08-30)*. An ESM/CJS bug breaking `tinacms-authjs` on exactly this configuration was reported 2026-08-16 and fixed in `tinacms-authjs@24.0.3` on 2026-08-24. The path is being walked and repaired, but this is early ground.

**Abort if the self-hosted backend is not serving authenticated edits on Astro by the end of day two.** Two days is enough to hit that class of problem or not; past that you are debugging an undocumented seam on a project whose bot does not exist yet.

**Fallback is TinaCloud, not another CMS.** It keeps the content model, the git bus, the bot's writer and the Astro integration completely unchanged — it swaps only who runs the backend. The price is that editor auth becomes theirs rather than Discord's, plus a bill. That is the cheapest fallback available and it is the reason the decomposition was worth having.

### Editor authorization is binary — accept it

Tina's `isAuthorized(req, res)` receives raw HTTP objects. No collection, no document, no mutation type. The signed-in identity never reaches the document resolvers; `role` is `'user' | 'guest'`, computed from mere presence in the user collection *(verified 2026-08-31)*.

**Therefore Club Leads get full editor access, and per-club scoping is a convention, not a control.** Do not build GraphQL-body inspection inside `isAuthorized` to enforce it: it would need to handle both `updateDocument` and `updatePost` mutation shapes, no upstream doc sanctions it, and a mutation-shape change would silently open the gate rather than close it. A control that fails open is worse than no control, because it looks like one.

The blast radius is a club page, in a community where everyone knows each other, on git, where every edit is attributed and `git revert` is the fix. The Club Lead role still earns its place: it is what gets someone into the CMS at all, and it keeps Discord as the source of truth for every role in the system.

---

## Ingestion and sampling

**Do not build the adaptive sampler up front.** The previous revision specified a four-tier pipeline with a per-entity adaptive budget and a four-step escalation ladder, ahead of the measurement that determines whether most of it is needed. That order is backwards.

### Build this

**Tier 0 capture, and nothing else.** Per entity: `GET /channels/{id}/messages?after={thread_id}&limit=100` for the head, and an unqualified `limit=100` for the tail. Two calls per entity — **~2,400 total against the measured 1,195 Posts and Threads, not the ~1,200 earlier estimated** *(measured 2026-09-01)*. Store verbatim in bot-side SQLite.

**Tier 0 is the load-bearing piece.** A few megabytes of stored text means a re-sweep is a local reprocess rather than 700 Discord API calls. That decouples "regenerate the corpus" from "hit the API" — which matters every time the tagging vocabulary changes, a model is upgraded, or two prompts need A/B-ing against identical input. Without it, every prompt iteration costs a full crawl.

Then start summarization at **first-post-only** and let measurement decide what to add. Once the raw material is on disk, the escalation ladder is a local script you can run five ways in an afternoon rather than an architecture you committed to before knowing the empty-entry rate.

### Two products, two sampling windows

These are different fields with different cadences, models, and source material. Conflating them is the mistake to avoid.

| | **Identity summary** | **Activity summary** |
|---|---|---|
| Answers | "What is this place?" | "What's happening here lately?" |
| Stability | Near-permanent | Volatile |
| Sampled from | First post + early history | Recent history |
| Regenerated | On first discovery; on admin re-sweep | When `last_message_id` moves |
| Model | Strong | Cheap |
| Consumed by | `/find`, catalog prompt, Index cards | "Lately" sections, landing page |

A thread's identity emerges from its opening exchanges, not its title. "Dad Fits" has an empty first post; its first ten replies establish that it is about clothing.

### Selection rules

Applied to whatever window is sampled:

- Drop bot and webhook messages
- Drop messages below a length floor and messages that are only reactions, emoji, or attachments
- Deduplicate near-identical messages — forty variations of "Welcome!" carry the information of one
- Prefer **participant diversity**: ten messages from eight people describe a place better than ten from one person
- Preserve chronological order; drift is signal
- Cap tokens per entity, with a global ceiling as a runaway guard
- **If confidence is still insufficient, emit an explicit "no description available" marker. Do not invent one.** These summaries feed the matching prompt, where a hallucinated topic produces confidently wrong recommendations.

### What "correct" means — testable criteria

A summary passes if it:

1. **Names the topic without reference to the title.** If it only restates the name, it adds nothing to matching.
2. **Distinguishes the entity from its siblings in the same Forum.** Double duty: if "United Kingdom" and "United Kingdom 🇬🇧" produce identical summaries, either the summary is too generic or the threads are genuine duplicates. Both outcomes are useful — the second feeds the merge queue.
3. **Would let a member decide whether to join.** The operative test.
4. **Contains no member identifiers** and no re-identifying specifics.
5. **Fits the token budget** — roughly 12 words for the catalog form.

Criteria 1, 2 and 5 are mechanically checkable. Criterion 4 is enforced by pre-redaction and post-validation. Criterion 3 needs human review.

### Measured 2026-09-02 (first full Tier 0 capture)

| | |
|---|---|
| Entities captured | 1,192 (Posts and Threads; Channels and Forums use their topic) |
| API calls | 2,384 — exactly 2 per Entity, 24% of the 10,000-per-10-minutes ceiling |
| Wall time, first run | **~30 minutes.** Paced by Discord's per-route rate limits, not the global ceiling |
| Wall time, later runs | **0 calls.** An Entity whose newest message has not moved is skipped |
| Messages stored | 92,248 |
| Message text | **7.67 MB** (bytes, not characters) |
| SQLite on disk | **23 MB** — the figure the volume must hold |

**Corpus facts worth keeping:** 31 of 1,102 Posts (2.8%) have had their starter message deleted in Discord — they carry `description_status: absent` and have no first post to sample. 1,847 of the captured messages are from bots and must be dropped at selection time; 1,349 distinct authors appear across the corpus, which is the raw material for the participant-diversity rule.

### Discovery results — measured 2026-09-02 against the real corpus

Run before implementing any of Phase 2, as this section demands.

**1. Whole-catalog prompt size — the anti-goal's premise, corrected.**

| Form | Tokens *(est. 4 chars/token)* |
|---|---|
| Raw descriptions, 120 chars each | **~43,000** |
| 12-word generated summaries | **~25,000** |
| What the docs assumed | ~15,000 |

**The "no vector store" anti-goal survives**, but on a thinner margin than
claimed: 1.7–2.9× the original estimate. Still comfortably inside a modern
context window, so retrieval remains the wrong trade. Re-check if the corpus
grows another 2×, and note that generated summaries nearly halve it — an
argument for summarising *before* matching, not only for quality.

**2. Description length distribution** *(n=1,098)*: p50 **34** tokens, p75 69,
p90 123, p95 125, max 125. Mean is 47 and misleading, which is why this is
percentiles. **The 500-character cap binds on roughly 10%** of descriptions —
worth revisiting if truncation is losing signal.

**3. Does early history help? Yes, but less than the raw number suggests.**

Of 129 `absent` Posts and Threads, **103 (80%) have at least two usable
messages** in the head window. But sampling shows most of that text is
mid-conversation reply, not description: *"Amazing! I'm a huge fan of retro
games"*, *"sorry, i somehow misread your name"*. The honest read: head history
is **worth sampling and will not rescue everything**. The escalation ladder's
refusal path stays load-bearing, and "no description available" remains the
right outcome for a meaningful share.

**4. Corpus shape:** 92,248 messages, **2.0% from bots** (the drop-bots rule
matters but is not dominant), **mean 8.5 distinct human authors per Entity** —
enough for participant-diversity sampling to have material to work with.

**5. Unplanned finding: near-duplicate detection has a free lexical signal.**

Phase 2 assumes duplicate detection needs LLM work. It partly does not. **27
Entities contain a message that both matches redirect phrasing** (*"we have a
thread already"*, *"head over to"*, *"can delete this"*) **and mentions another
Entity by `<#id>`.** Filtering to those with ≤10 messages isolates near-certain
abandoned duplicates:

> Factorio Channel (8 msgs), Pokemon Channel (2), Overwatch Channel (2),
> Escape from Tarkov channel (2), War Thunder Channel (2), MSFS 2020 Channel
> (2), DOTA 2 channel? (2) — **all redirected to `🎮︱game-talk`**

A clear pattern: members asked for a dedicated channel for a game, were pointed
at the forum, and the request thread was abandoned. Message count cleanly
separates these from active threads that merely mention a redirect (Sea of
Thieves, 200 messages; Date Night Ideas, 99).

**Build this before the LLM pass.** It is a regex over Tier 0, it costs
nothing, its output is a mod-channel post, and it finds the exact class of
duplicate the merge queue exists for.

### Discovery: what to measure

1. **Actual token distribution** across the real corpus — percentiles, not a mean. The mean is dominated by the Formula 1 entry and tells you nothing.
2. **Does early history actually help?** Compare first-post-only against first-post-plus-head on the entries currently rendering empty. If it does not help, the sampling model stays simple permanently.
3. **What proportion of entities reach the refusal path?**
4. **Tier 0 storage footprint** against the volume. Not a backup budget — Tier 0 is not replicated.
5. **Golden-set match quality** — see test fixtures.
6. **Position sensitivity** — shuffle catalog order across runs. If results move, attention is the bottleneck and no amount of token reduction fixes it.

**Contingency if whole-catalog matching degrades:** hierarchical matching. Pass one over ~20 category summaries selects two or three categories; pass two runs over only the entities inside them. Cuts tokens roughly 10× *and* improves attention. This is the planned branch — not compression, which degrades exactly the subtle inference the feature exists for.

### Privacy note

Retaining raw first posts and sampled replies sits against the "store derived data, not transcripts" posture elsewhere. The distinction is defensible but must stay explicit: thread first posts are **deliberately authored topic descriptions, already published to a public wiki**. `#introductions` chatter is ephemeral conversation nobody expected to be archived. Different artifacts, different rules. **Tier 0 covers indexed thread content only and must not quietly expand to monitored-channel conversation**, which remains extract-and-discard.

---

## Tagging

### One derived axis, three mechanical ones

Most of the proposed taxonomy is not a classification problem:

| Axis | Source |
|---|---|
| **Topic** | LLM-derived. The only axis that needs a model. |
| **Platform** | Native Forum `applied_tags`. Mod-authored ground truth. |
| **Activity** | Derived from `last_message_id` recency. |
| **Format** | The entity type. |
| **Region** | A small gazetteer over names; LLM only as fallback. |

**Native `applied_tags` win wherever a Post has them.** LLM tags are additive. A contradiction between the two is logged for a mod to look at, never used to overwrite mod intent.

### Bootstrap, then freeze

**Bootstrap once.** Derive the Topic vocabulary from the full 400–600 entity corpus: consensus across 3–5 independent runs keeping only tags stable across all of them, a critique pass, then ~10 minutes of Staff review. Run it on a **stratified** sample, not the raw corpus — an unguided sweep of a gaming-heavy corpus yields fifteen gaming tags and one called "hobbies," and that skew bakes in before a human ever sees it.

**Then freeze and version-number the vocabulary.** Steady state classifies each new Entity *against* the frozen vocabulary with a cheap model, and never re-derives — re-deriving on the fly means the tag set drifts under the Index silently. There is no automated re-derivation; a clean-slate reset is a deliberate global act.

**When the vocabulary version bumps, retag the whole corpus from Tier 0**, not from the API. That is what Tier 0 is for.

---

## Models and privacy

- **Pseudonymize in code before any model call**, not in the prompt. Validate output against the member-name cache and snowflake patterns. Use the prompt only for suppressing *re-identifying detail*, which regex cannot catch — in a readership of dozens who know each other, "a member who flies for a living" identifies one person.
- **Best-effort, and acknowledged as such.** No model, local or hosted, should be piped fully identifying information. This cannot be guaranteed; it can be designed for.
- **Split by job.** The bootstrap runs once and sets the vocabulary everything downstream inherits — run it on the strongest model available and eat the cost. Steady-state classification and activity summaries run cheap, off-peak.
- **Write to the OpenAI wire format** so a local model is a config change if the answer ever needs to be "nothing leaves the box."
- Redaction applies to the **Index render path too**, not just LLM output. The old script leaked raw `<@732682426853359667>` and `<#1088552078709891242>` into the published page.

---

## Public tier

What an unauthenticated Viewer sees:

1. **The recruiting landing page**, indexed by search engines. Two of six substantive intros arrived from Google and Reddit, so there is real inbound traffic currently landing on nothing.
2. **A Staff-curated summary** of the community — written by humans, changed when they want.
3. **A monthly "what's going on" overview**, LLM-drafted and **Staff-approved before publication**.

Everything else is `noindex` and gated.

### The rotating summary is the highest-risk output in the project

It is LLM-generated, public, indexed, and about a private community. The summarizer was already identified as a worse prompt-injection surface than the intro bot.

- **Generated from derived data**, not raw messages — build it from identity and activity summaries that already passed redaction, so the public page sits two removes from member-authored text.
- **Never auto-published.** The bot drafts on schedule and posts the draft to a Staff channel; publishing is a human action. If nobody approves it, last month's copy keeps serving — a safe failure.
- **Monthly, not fortnightly.** A Staff approval every two weeks is a chore someone will start rubber-stamping.
- No entity names, deep links, or counts. High level only.

---

## Development phasing

Bot-first. The evidence supports it: the topics page is already linked in the `#introductions` channel description and no member in either transcript used it — every one was hand-directed by another human. `/find` automates what is actually happening, and reaches members where they already are.

### Phase 1 — Sync engine → git

discord.js REST, emits `content/index/data.json` and `content/config/roles.json` and commits. Mention resolution, markdown escaping, truncation. Tier 0 capture lands here too.

**Mechanical gate:** the coverage fixture passes, all four defect fixtures pass, and the run emits a count of entities the old script missed. Coverage is the gate; layout is a free variable — do not spend time on presentation here.

**Note:** the Message Content intent is required and gates content over REST as well as the gateway. **It is enabled and working** *(verified 2026-09-01)*. Check **both** `GATEWAY_MESSAGE_CONTENT` (1 << 18) and `GATEWAY_MESSAGE_CONTENT_LIMITED` (1 << 19) — a self-toggled bot under 100 guilds only ever gets the second one, and testing bit 18 alone rejects a correctly configured bot.

**Measured 2026-09-01:** the guild returns 127 raw channel objects — 93 text, 1 announcement, 15 categories, 6 voice, 1 stage, 11 Forums. **94 are Channels**, not the ~40 estimated. Roughly a quarter of what the API returns is not a Catalog Entity of any kind, so the type filter is load-bearing rather than tidying.

### Phase 2 — Summaries + tags

Begins with a **measurement pass, not an implementation**. See Ingestion and sampling.

Then: bootstrap the Topic vocabulary, freeze it, classify. Near-duplicate detection posts candidate pairs to a **mod Discord channel** — build no queue UI. The action a mod takes (merging or renaming threads) happens in Discord regardless, so a queue anywhere else is a second place to look that cannot perform the action.

### Phase 3 — Sherpa slash commands ⭐ first member-facing value

`/find`, `/lately`, `/privacy`, history queries. Whole-catalog prompt, no vector store.

**Mechanical gate:** the golden set passes, including the suppression cases. Position-sensitivity check shows stable results across shuffled catalog orderings.

**Needs no site, no auth, no CMS.** This delivers the *function* of the Index — finding where to go — before the site delivers the *artifact*.

**Shadow mode starts here.** The introductions responder runs silently to a mod channel from this point, accumulating the two-plus weeks of observation it needs regardless. Going live in Phase 6 becomes a config flip rather than a new build.

### Phase 4 — Auth + gated site

**Auth spike first, timeboxed to 1–2 days.** Better Auth with the Discord provider, the `getUserInfo` guild-membership rejection, `Member` role check, role manifest mapping, middleware gating a stub page. This is smaller than the previous revision budgeted for, because the rejection path is now a known API rather than an open risk.

Then: Astro reads the JSON, renders the Index behind the gate, MiniSearch client-side, public landing page prerendered, Access honoured, redaction on the render path.

**Mechanical gate:** a guild member with the `Member` role reaches the stub; a guild member *without* it is rejected; a non-member is rejected *and no user row is created for them*; a role change is reflected within the TTL; the leak test passes.

### Phase 5 — CMS

Stand up Tina (two-day abort condition above), migrate one club page, hand it to a real Club Lead with no instructions. Learn here rather than after migrating everything. Override pattern goes live.

If the visual editing turns out to be insufficient for real editors, that is a real signal worth reopening the CMS choice on. A canvas editor was ranked a **preference**, below "coexists with Astro" and "no database service."

### Phase 6 — Wiki.js migration + introductions responder live

**All** wiki content migrates — it is not expansive and none of it should be lost. Export via Wiki.js's GraphQL API to markdown, commit, cut over once. **Wiki.js goes read-only at cutover; no dual-running period** — two writable sources for the same page is exactly the failure this architecture is shaped to avoid. Leave the old wiki up read-only as an archive for as long as it is free.

Flip shadow mode off after ≥2 weeks of reviewed output. Full spec in `PROJECT-STATUS.md` §7.

### Cross-cutting

**Build-failure alarm.** The bot watches CI and posts to a dedicated mod channel on failure — another reason the bot comes early.

---

## Anti-goals — do not build these

| Do not build | Why |
|---|---|
| Vector store, embeddings, RAG | The catalog fits in one prompt. Retrieval is less accurate here and adds a refresh pipeline. Contingency is hierarchical matching, not vectors. **⚠️ Re-check the premise: the corpus measured 1,259 Entities on 2026-09-01, roughly double the ~600 this estimate assumed, so "~15k tokens" is closer to ~31k. Still promptable, but position sensitivity is now more likely and the hierarchical-matching branch is nearer than planned.** |
| A second OAuth provider | Design the seam; implement Discord only. |
| Syntactic prompt compression | Degrades the subtle inference the recommender exists for. |
| A message-content archive beyond Tier 0 indexed thread content | Monitored-channel conversation is extract-and-discard. |
| Auto-created groups or tags | Unknown slugs are skipped and logged, never created. |
| Proactive celebration or anniversary triggers | A predicted future event the bot cannot verify will eventually land badly. Match on life stage; never schedule on it. |
| Model prose emitted directly to Discord or the site | Structured output only; the app renders from a template. This is the prompt-injection containment. |
| Prerendered routes carrying an `access` field | Astro middleware does not run for them. This leaks gated content. |
| Reader gating as a CMS selection criterion | Nothing self-hostable ships it in a form that fits. It collapses the field to one immature candidate, twice now. |
| Per-document authorization inside Tina's `isAuthorized` | Requires parsing GraphQL bodies on an unsupported seam, and fails *open* on an upstream change. |
| A Postgres `abstract-level` adapter | Writing a database driver to avoid adding a database. |
| A duplicate-merge queue UI | The action happens in Discord. A mod channel post is the whole feature. |
| **A trolling classifier** | The confidence gate already suppresses signal-free intros, and structured output means no input can make the bot say anything. A naive classifier flags this server's affection as abuse and does more harm than none. Revisit only if shadow mode produces a real failure. |
| Affinity as a ranking | Ship it as a filter. A ranking will be accused of hiding things in a community where findability is the point. |
| Deny rules in Access | Grant-plus-deny is where access-control bugs live. |
| Auto-ageing of stored parenting stage | Reintroduces the derived precision the privacy model removes. Expire instead. |
| Admin UI for anything env config already handles | Out of scope until someone asks. |
| A content database | See "what would force one" below. |

---

## Human checkpoints

These cannot be automated. Reaching one means producing the artifact and waiting. **None of these currently has a named owner — see Open questions.**

| Checkpoint | Phase | What the human does |
|---|---|---|
| Tag vocabulary review | 2 | ~10 minutes reviewing ~20 proposed Topic tags before the vocabulary freezes |
| Golden-set judgement | 2 | Confirms whether summaries would actually help a member decide to join |
| Club Lead usability trial | 5 | One real Club Lead uses the CMS with no instructions |
| Shadow-mode review | 3–6 | ≥2 weeks of suppressed intro-responder output, read by mods |
| Go-live approval | 6 | Explicit sign-off before the bot posts to `#introductions` |
| Monthly public summary | Ongoing | Staff approval before each publication |
| Privacy policy | Before any member data is stored | Written and published by a human, not generated |

---

## Test fixtures to build first

Create these before the code they test. They are drawn from real transcripts and are the project's regression suite.

**Golden set — recommendation matching:**

| Case | Must surface | Notes |
|---|---|---|
| HammerFoe | Faith & Religion, Entrepreneurs & Business Owners, Career | The long-tail matches humans missed. The primary test. |
| Rat. | Stay at home dads, Rocket League | Rich signal, thin human help |
| Mark Weigl | Flight Simulators, Aviation/Flying, Cities: Skylines, Minnesota | Signal arrived 8 hours late in a reply |
| ConnorDavidSmith | *suppress* | Generic preferences; humans already named the good matches |
| xEMPTYCANx | *suppress* | Human named Battlefield within 28 minutes |
| Zifei | greet + one question | "hello" — no signal, no human help |
| Schwagle | no evaluation | Empty message; must not crash or invent |

**Coverage fixture — index sync.** The old page (gist in `PROJECT-STATUS.md` §11) is the completeness baseline. Every entity in it must appear in the output with a resolved name, working deep link, and either a description or an explicit marker. Also emit a count of entities the old script *missed*.

**Defect fixtures — rendering.** These specific failures must not reproduce: raw mention IDs (`<@732682426853359667>`), raw emoji IDs, Discord markdown colliding with the output format (`~~QUEST~~`), untruncated entries (the Formula 1 race calendar), and silently empty entries.

**Leak test — gating.** Assert no route carrying an `access` field is prerendered; that an unauthenticated request to a gated route redirects rather than returning content; and that a guild member *without* the `Member` role is treated as a Viewer.

---

## What would force a content database later

A disposable session database already exists (Better Auth), and Tina's datalayer is a rebuildable cache. These would force a real, backed-up one. None are v1, and each is additive — git content stays valid.

- Members viewing Sherpa history **on the site** (currently bot-first by decision)
- Staff flags needing instant effect (weekly refresh means no)
- Activity charts over time
- Per-member state beyond sessions — saved items, read markers

If two or more land, go to Postgres and stop optimizing.

---

## Open questions

1. **Ownership mechanics.** Which GitHub org; which humans hold owner on GitHub, Railway, Cloudflare and the Discord application; where secrets live besides Railway's env; who takes a handoff. Deferred as organizational rather than technical — **but it has one hard deadline: the machine account credential in Phase 1.** If that is minted against a personal account, the organizational problem becomes a code problem the first time someone else needs to rotate it. Every human checkpoint above is also unassigned, and an unassigned checkpoint belongs to whoever wrote the plan.
2. **Wiki.js inventory.** Page count, nesting depth, and whether there are assets beyond markdown. Needed to scope the Phase 6 migration. Nobody has counted.
3. **Tier 0 storage footprint** against the volume — a Phase 2 measurement, not a decision. Tier 0 is a rebuildable cache and is not replicated.
