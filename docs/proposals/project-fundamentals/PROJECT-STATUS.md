# Papa Squad hub site + Papa Sherpa — project status

**Last updated:** 2026-08-26
**⚠️ Partially superseded — updated 2026-08-31.** `ASTRO-ARCHITECTURE.md` is the current build handoff and wins wherever the two disagree. `CONTEXT.md` is the binding glossary.

**Superseded here:** §3 (architecture), the **Storage** subsection of §4, §5 (Instatic — now dead, not a watching brief), §6 (open decisions — all resolved or moved), Track 2 of §9, and §12 (next actions).

**Still current and referenced by the handoff:** the rest of the §4 decision log, the privacy model, the Discord API facts in §8, the observed data in §8, the recurring risks in §10, and the introductions-responder spec in §7.

**Purpose:** pick-up document. Captures what has been decided, what was rejected and why, what remains open, and what has been learned about the problem domain. A future conversation should be able to read this and resume without re-litigating settled questions.

---

## 1. The problem

Papa Squad (TPS) is a Discord community for dads — **94 Channels and 11 Forums** *(measured 2026-09-01 against the live guild; the earlier "roughly 40 channels" estimate was low by more than 2×)*, plus **1,195 Posts and Threads** *(measured 2026-09-01 — roughly double the "~500–600" estimate)*. **1,259 Entities in total.**

Posts are concentrated: `🎮︱game-talk` alone holds **506**, then `🃏︱lifestyle-hobbies-interests` 251 and `🗳︱suggestions` 154. Of 1,259 Entities, 1,105 have a usable description, 145 do not (**11.5% — closely matching the "~10% render empty" observation in §8**), and 9 are withheld.

The guild returns 127 raw channel objects in total: 93 text, 1 announcement, 15 categories, 6 voice, 1 stage, 11 Forums. Only the 94 text and announcement channels are Channels; the rest are either a different Entity type or not a place to read at all.

Discord's own search and thread discovery are poor. A wiki page at `wiki.papasquad.xyz/papasquad/threads-and-channels` indexed every channel and thread. **A script generated that page; the script has gone offline and is inaccessible.** The page is now stale and decaying.

Separately, the wiki (Wiki.js) hosts dozens of other pages — clubs and interest groups use it as their hub.

The project's governing constraint: the previous version died because it lived on one person's machine. Everything built here must survive its author.

---

## 2. Deliverables

**A. Web index** of channels, forums, and threads with:
- in-page search and filtering
- LLM-derived topic tags
- "what's happening lately" activity summaries
- selective exclusion of private content
- a public recruiting landing page

**B. Papa Sherpa** — a Discord bot that:
- matches members' stated interests against the catalog
- proactively greets and recommends channels to new members in approved channels
- responds to direct mentions anywhere it has access
- offers a user-triggered "audit my history and build a profile" flow

---

## 3. Current architecture

> **⚠️ SUPERSEDED 2026-08-31 — this diagram is historical.** Neither Instatic nor the shared Postgres exists in the current design. See `ASTRO-ARCHITECTURE.md` § Shape.

Two services, one Railway project.

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│  Discord service (Node)     │     │  Instatic (Bun)              │
│  • gateway listener         │     │  • site + club pages         │
│  • scheduled sync           │     │  • index presentation        │
│  • LLM tagging + summaries  │     │  • visitor auth + groups     │
│  • Papa Sherpa interactions │     │  • per-page access control   │
└──────────────┬──────────────┘     └───────────────┬──────────────┘
               │                                    │
               └────────┬───────────────────────────┘
                        │  private networking
              ┌─────────▼──────────┐
              │  Railway Postgres  │
              │  bot.*  — catalog, │
              │           history  │
              │  public.* — Instatic│
              └────────────────────┘

Cloudflare: DNS + origin proxy. Nothing else.
```

**Why this shape:** the Discord gateway needs a persistent connection, which rules out serverless for the bot. Instatic is a Bun process that serves its own pages. Neither can absorb the other, so they coexist — and two services needing one dataset is what makes a shared Postgres the right answer over a per-service embedded database.

---

## 4. Decision log

Settled decisions with their reasoning. Reopen only with new information.

### Platform and hosting

| Decision | Reasoning |
|---|---|
| **Railway** for both services | Gateway needs an always-on process. Persistent volumes, git deploys, ~$5–10/mo. |
| **Cloudflare for DNS + proxy only** | Everything else was evaluated and rejected. See below. |
| **Not Cloudflare Workers** | Free tier caps subrequests at 50/invocation against ~700 needed. Paid tier fits the sync comfortably (15 min CPU, 10k subrequests) but cannot hold a gateway connection. Discord's own Workers tutorial covers interactions endpoints only. |
| **Not Cloudflare Access** | Priced per authenticated user: 50 free, then $7/user/month. At 500 members that's $3,500/mo, and members 51+ are *blocked*, not degraded. |
| **Not Cloudflare Apps** | Deprecated product; no new installs since January 2024. |
| **Not D1** | Viable on capacity but its supported path is a Worker binding. From a non-Worker process it's an HTTP API with a 100-bound-parameter cap and no cross-request transactions. |
| **Not Neon** | Sound option; branching is genuinely useful. Rejected on failure mode — free tier hard-suspends at 100 CU-hours rather than throttling, and a persistent Node process holding a pool prevents scale-to-zero (730h × 0.25 CU = 182 CU-hours, exhausted around day 16). |
| **Not Supabase / Prisma Postgres** | Both fine. Rejected to avoid a third vendor; metering was never a real constraint. |

### Storage

> **⚠️ RETRACTED 2026-08-31. Do not provision Postgres.** This decision rested on one premise — two services needing one dataset — and that premise died with the Instatic architecture. Git is the content bus, the site's only database is a disposable Better Auth session store, and Tina's datalayer is a rebuildable SQLite cache on the site's own volume. **Bot state reverts to SQLite + Litestream → R2.** Postgres stays open for future evaluation; nothing in the current design needs it. Kept below for the reasoning, which is still sound for the architecture it was written against.

**Shared Postgres, one instance, both services connecting.** *(Decided 2026-08-26, superseding SQLite + Litestream → R2. Retracted 2026-08-31.)*

Two services needing one dataset is the case a real database exists for. Cost moves from near-free to a few dollars a month, which is acceptable.

- **Railway Postgres** is the pick: both services sit in one Railway project and reach the database over **private networking** — no public exposure, no egress, one bill, PITR available. Supabase and Neon would both require connecting out over the public internet.
- **Neon is ruled out for this topology.** Instatic holds a connection pool continuously as a web server, so the compute never idles — roughly 182 CU-hours against a 100-hour free allowance, and on paid you buy compute that never sleeps, which removes the reason to choose it.
- **Backups replace Litestream:** enable **PITR on day one** (the restore window starts at the first post-enable base backup — enabling it later does not cover earlier data), plus a scheduled `pg_dump` to a private repo or R2. The durable data is kilobytes; a dump in git gives version history, off-vendor survival, and restorability by anyone who can clone it.
- **Shared database ≠ shared tables.** The bot gets **its own Postgres schema** (`bot.*`). Instatic never sees it, migrations cannot collide, ownership is unambiguous.
- Both app volumes become disposable — all state lives in Postgres.

**Superseded reasoning (kept for context):** SQLite on a Railway volume with Litestream replicating to R2 was the plan while this was a single service. It resolved off-vendor durability at near-zero cost. It fails here because two Railway services cannot share a volume.

### Auth

**In-app Discord OAuth. Not Wiki.js's (stale, being replaced). Not Cloudflare Access (seat pricing).**

- Scope `identify` **only**. Verify guild membership server-side with the bot token via `GET /guilds/{id}/members/{user_id}` — works without the Guild Members privileged intent and returns roles.
- Never request `email` (invasive consent, unverified) or `guilds` (hands over the user's full server list).
- Sessions short-lived with silent re-verification, because membership can be revoked.
- **Public tier:** the recruiting one-pager, indexed by search engines. Everything else `noindex` and gated.

### Retrieval and LLM

| Decision | Reasoning |
|---|---|
| **No vector store, no RAG** | The full catalog compresses to ~15k tokens (`name \| 12-word summary \| tags` × 600). It fits in one prompt. More accurate than top-k retrieval, and deletes embeddings, chunking, and refresh pipelines. |
| **Client-side search (MiniSearch)** | 600 records. No search API to build, secure, or rate-limit. |
| **Model is a config value** | Write to the OpenAI wire format. Whole workload is single-digit dollars/month — select on instruction-following under the redaction constraint, not price. |
| **Schedule outside peak windows** | If using DeepSeek, off-peak is 50% cheaper for zero effort. |

### Privacy

- **Redaction in code, not prompts.** Pseudonymize before the model sees anything; validate output against member-name cache and snowflake patterns; use the prompt only for suppressing *re-identifying detail*, which regex cannot catch. In a readership of dozens who know each other, "a member who flies for a living" identifies one person.
- Applies to the **index render path too**, not just LLM output. The old script leaked raw `<@732682426853359667>` and `<#1088552078709891242>` into the published page.
- **Allowlist forums, denylist individual threads.** Thread-level denylists fail open on new content, and members create threads constantly. Layer on a `No Index` forum tag for mod-controlled opt-out.
- **⚠️ The visibility baseline is the `Member` role, NOT `@everyone`** *(corrected 2026-09-01 from live measurement)*. Of 105 Channels and Forums, `@everyone` can see **11** — verification plumbing only. `Member` sees **68**. Filtering on `@everyone` visibility would yield an almost empty Catalog. Same correction as reader auth: the `Member` role is the line, not bare guild presence.
- **Three visibility outcomes, not two** *(2026-09-01)*: not visible to the bot → excluded from the Catalog; visible but `READ_MESSAGE_HISTORY` denied → **withheld**, listed without content and never sampled; visible and readable → describable. The 9 withheld Channels are the 🩹 Selfing support space plus `mod-support`. This is a stronger posture than the bot choosing not to look — it cannot look.
- **Discord returns 200 with an empty array, not 403, when history is denied.** "No messages" is indistinguishable from "no permission" at the message endpoint, so readability must be decided from permissions before capture, never inferred from an empty response.
- **Child data — store coarse, never schedule on it.** Members volunteer this constantly ("20 month old and second due in October"; one display name is `Schwagle 👦5 👧2`), and it is genuinely useful for matching (Camping with Kids, Bedtime books for kids, Games for Kids).
  - **Store:** `parenting_stage` (multi-valued: `expecting`, `infant`, `toddler`, `young_children`, `school_age`, `teens`, `adult_children`), `children_count` bucketed to `one` / `multiple`, and `observed_at`.
  - **Never store:** exact ages, birthdates, due dates, names, genders. Exact counts beyond one/multiple add identifiability without adding matching signal.
  - **Never echo any of it back publicly.** A bot saying "since you have a 20-month-old" repeats a child's details to an audience.
  - **Never use it as a proactive trigger.** A due date is a prediction and the bot has no channel through which to learn it was wrong. Across hundreds of members over years, miscarriage, stillbirth, and adoptions falling through are statistically certain; a scheduled congratulation will eventually land on someone in the worst week of their life. Child birthdays carry the same risk through custody change and bereavement. Match on it, don't schedule on it. If life-event celebration is wanted later, make it **member-initiated opt-in**, where the member remains the source of truth about their own situation.
  - **Expire, never auto-age.** This data goes stale faster than anything else in a profile and nobody tells you. Incrementing `infant` → `toddler` on a timer reintroduces the derived precision we are avoiding. Let `expecting` decay to nothing after ~a year rather than resolving to `infant`, precisely because the outcome is unknown; give other stages a longer horizon and re-confirm on new mentions.
- **Retention:** separate inputs from outputs. Store a *derived interest profile*, not transcripts. Recommendations kept long (avoid repeats, allow review); raw text 7 days max. Cap on both axes — 30 interactions **or** 12 months. Departure-based expiry tied to the sync.
- **Opt-out is three toggles** (don't approach me / don't remember me / delete what you have). Check opt-out **before** the LLM call. Opt-out state is exempt from purges.
- Policy lives in one markdown doc, rendered on the site and returned by `/privacy`; the pinned message links to it rather than duplicating.

---

## 5. The Instatic decision

> **⚠️ DEAD 2026-08-31.** Instatic is not the CMS and the fork is abandoned. Two reasons, the first decisive: it is a **Bun-only standalone server that ships its own static publisher, so it replaces Astro rather than complementing it** — adopting it means unwinding the delivery layer, the middleware gating, and the reader-auth design together. Second, the capability it was chosen for still does not exist: PR #311 is open, merge-conflicted, 402 files / +30k lines, with **zero review activity in 32 days**, behind three other workstreams the maintainer named as prerequisites *(verified 2026-08-31)*. Maintaining a divergence that size to obtain reader gating our own Astro middleware already provides is cost without benefit. **The OAuth contribution below is not being built.** Section kept for the evaluation record.

**Status: forked, committed to in principle, dependent on unmerged upstream work. *(Superseded — see the notice above.)***

[Instatic](https://instatic.com) (`CoreBunch/Instatic`, ~8.3k stars) is a self-hosted visual CMS — Bun, SQLite or Postgres, page-tree → static HTML publisher, plugin system with a QuickJS sandbox.

**Gap:** its auth is admin-only. Published pages cannot be gated on a reader's identity.

**Filled by PR #311** (`dazzakiller`, issue #289): a visitor auth layer — separate `instatic_visitor_session` cookie, separate `visitor_*` tables, member groups, **per-page access control**, per-visitor data framework, `no-store` treatment of per-visitor content so 95%+ of pages stay static on disk.

**PR status as of 2026-08-26:** open since July 29. No reviewers, no assignees, no labels, one participant. ~10,700 lines across 47 new files, disclosed as AI-assisted, in a queue of 54 open PRs. Treat merge as unlikely on any useful timeline.

**Our position:** forked it. Not blocked on merge — blocked on willingness to maintain a fork.

### What Instatic absorbs

- Club/group pages (replaces Wiki.js)
- Index presentation
- Visitor auth, sessions, member groups
- Per-page gating — configuration rather than code
- The public one-pager as an ungated page

### What it does not absorb

- Discord gateway listener
- Scheduled sync and Discord API work
- LLM tagging and summarization
- Papa Sherpa interaction handling

### Known costs

- **Fork tracking.** Visitor migrations have already been renumbered twice (`021–026 → 022–027`, then `022–027 → 024–029`). Every upstream migration forces another renumber. Renumbering against production data is dangerous — hence the zero-schema constraint on our OAuth work.
- **Two runtimes.** Instatic is Bun; the bot is Node/discord.js.
- **Page access defaults to public.** `027_page_access` tolerant-parses to public, so a new club page is world-readable until gated. That is fail-open, the opposite of our Discord-side posture. Needs a convention or a check.

### Our OAuth contribution

Specified in **`OAUTH-HANDOFF.md`** (companion artifact). Summary:

- **Part A:** generic OAuth provider layer in core. Interface + registry, fixture provider, signed single-use state, `/auth/:provider/*` routes, visitor upsert, group reconciliation, revalidation mechanics. **No Discord anywhere.**
- **Part B:** Discord provider. Delivery decision — in-tree under `providers/`, or as an **Instatic plugin**. Plugin is preferred (zero core files touched); outbound network availability in the QuickJS sandbox is the only disqualifying answer.
- **Zero schema changes.** Synthesize `<discord_id>@discord.local` as the email and store an unusable Argon2id hash. The existing partial unique index on `email_normalized` then enforces one visitor per Discord account for free — no `visitor_identities` table needed.
- `visitor_login_attempts.result` has a CHECK constraint with no OAuth-shaped value. Map onto the existing vocabulary; do not extend it.

---

## 6. Open decisions

> **⚠️ ALL RESOLVED OR VOID as of 2026-08-31.** Do not work from this section.
>
> - **6.1** (Instatic rendering catalog data) — **void.** Instatic is dead; Astro reads `content/index/data.json` from git.
> - **6.2** (gated static assets) — **void.** Astro middleware gates routes; the search index is served by the app.
> - **6.3** (tagging axes) — **resolved.** One LLM-derived axis (Topic), three mechanical ones. Bootstrap once, then freeze and version. See the handoff's Tagging section.
> - **6.4** (Instatic migration scope) — **resolved.** All Wiki.js content migrates to Tina in Phase 6, one-time cut, read-only afterwards.
> - **6.5** (trolling deflection) — **resolved: build nothing.** Now an anti-goal. The confidence gate suppresses signal-free intros and structured output means no input can make the bot say anything.
> - **6.6** (prompt injection posture) — **resolved,** and carried into the handoff intact. The highest-exposure surface is the public monthly summary, which is now Staff-approved before publication.

### 6.1 How Instatic renders catalog data it does not own ⚠️ highest priority

**Resolved:** connectivity. Shared Postgres, bot owns the `bot.*` schema. See §4 Storage.

**Still open:** Instatic's page rendering reads from `data_rows` via loops — it cannot read arbitrary tables. Three paths:

| Option | Trade-off |
|---|---|
| **Custom loop source** reading `bot.*` | Idiomatic — `base.loop` has pluggable sources, and PR #311 established the pattern by adding `visitor.current` / `visitor.owned-rows`. No API round-trip, no bot writes into CMS tables. A second small contribution in the same shape as the OAuth work. **Verify against `docs/features/loops.md`.** |
| **Bot writes `data_rows` via the CMS API** | Validated and publishable, but the bot holds an Instatic admin credential with `content.manage`, and it's API-coupled. |
| **Bot writes `data_rows` directly** | Possible now that the DB is shared. Bypasses validation and couples to a schema that renumbers on rebase. Not advised. |

Preference: custom loop source, falling back to the CMS API if loop sources can't reach outside `data_rows`.

### 6.2 Gated static assets

Instatic's page access gates *Page objects*. The client-side search index is a JSON asset. Can a non-page asset be gated? If not, the index must be embedded in the page (~2–4MB of HTML for 600 entities) or served by a custom endpoint. **Unverified.**

### 6.3 Tagging axes

Blocks the classifier prompt. Proposed facets rather than a flat list: Topic (~20 values, universal), Platform (games only — native forum tags are ground truth), Region, Activity (derived from recency, not LLM), Format.

Bootstrap approach: **consensus across 3–5 independent runs**, keeping only tags stable across all of them, plus a critique pass, plus ten minutes of mod review. Watch for corpus skew — an unguided sweep of a gaming-heavy corpus yields fifteen gaming tags and one called "hobbies."

### 6.4 Instatic migration scope and timing

Does Wiki.js content migrate now, later, or never? Instatic has a Super Import for static sites; Wiki.js content is markdown in a database. Needs an export step.

### 6.5 Trolling deflection

Started, unfinished. Genuinely hard here: the server's normal register looks like trolling out of context. "WE'RE YOUR FRIENDS NOW." "Do you want to have sex with me?" directed at a new arrival. A naive classifier will flag affection as abuse and produce worse outcomes than no classifier.

### 6.6 Prompt injection posture

Framing settled: **assume injection succeeds; make the blast radius zero.** Model returns structured output (`{channel_ids, angle}`); the app renders from a template. Never emit model prose directly. Validate IDs against the allowlist after generation. One member's profile per call. No tools in the loop.

Highest-exposure surfaces are *not* the intro bot: the summarizer publishes to a public web page, and thread first-posts feeding the ~15k-token catalog are **persistent injection** — a crafted first post could bias recommendations for everyone. Compressing entries to LLM-generated blurbs puts a boundary between raw member text and the matching prompt; do that deliberately.

---

## 7. Papa Sherpa: introductions flow (locked)

State machine: `UNSEEN → WATCHING → EVALUATED → (RESPONDED | SUPPRESSED | EXPIRED)`. Terminal states permanent per member.

### Gates, cheap → expensive

1. **Channel** — monitored channel, config-driven, mod-editable
2. **Author** — not a bot; `joined_at` ≥ **cutoff date**; not opted out (checked before any LLM call); no terminal state
3. **Content prefilter** — no LLM; non-empty, above a length floor, more than a greeting
4. **Extraction** — cheap model, merged into a running profile, **text discarded immediately**
5. **Confidence** — does the profile support ≥2 specific matches?
6. **Timing** — see below
7. **Match** — full catalog in one prompt, ranked matches with IDs
8. **Novelty** — parse `<#id>` mentions posted by *other* members since their intro; drop any match already named. Machine-readable, and errs toward suppression
9. **Output safety** — no child details, no other members named, verify every channel ID exists and is not excluded

### Two independent clocks

- **Greeting: ~10 min wall clock**, zero response of any kind. Low cost when wrong — a redundant welcome is invisible in a channel where "Welcome!" appears four times per intro. Carries **no channel picks**, just a welcome, an index link, the mention offer, and one question if signal is thin.
- **Recommending: ~20 min of active-channel time** (minutes in which ≥1 message occurred — needs a precise definition in code). Higher cost when wrong, because it preempts a better human answer.
- **Ceiling: ~6 hours active time**, act regardless of state.
- **All parameterized and runtime-configurable.** Shadow mode is worth much less if changing a threshold means a redeploy.

Active-time measurement self-adjusts for timezone and quiet periods with no timezone logic, and structurally prevents the bot beating an awake human to the greeting. Validated against real data: Rat. posted at 3:23 AM and was welcomed at 8:04 AM — a wall clock would have fired into an empty room at 4:23 AM.

### Acknowledged vs. helped

Two independent flags, two behaviours. "Welcome sir!" is acknowledgment that helps nobody.

| | Acknowledged | Helped |
|---|---|---|
| Test | any message directed at them | a `<#channel>` mention **or** a question |
| If missing | bot greets | bot recommends |

Human engagement at any stage suppresses whatever the bot hadn't done yet.

### Reply placement: inline, not threaded

No human in either sample used a thread. The two most valuable exchanges observed were inline follow-ups. Threads would also fragment the novelty gate. Use native `<#id>` mentions (survive renames), keep the reply ping on, and cap any follow-up conversation at 2–3 exchanges.

### Invited path

`@Sherpa help me out` and replies to the bot's own recommendation share **one code path** with the unattended path: assess profile → recommend if sufficient, else ask one targeted question → merge → reassess, hard-capped at three exchanges → exit with the widest doors plus the index link. The invited version affords more turns.

### Rollout

Shadow mode ≥2 weeks — output to a mod channel with the suppression reason attached. Kill switch in both slash command and web UI, effective without redeploy. One response per member ever. Global daily ceiling as a runaway guard. Prefer silence on any error.

---

## 8. Domain facts (verified — do not re-derive)

### Discord API

- **Message Content intent is required.** It gates content across REST *and* gateway, per Discord's docs. Thread descriptions are member-authored first posts, so this is a day-one requirement, not a Phase 3 concern. Self-toggle under 100 servers. **Enabled and working on the current application** *(verified 2026-09-01)*.

**⚠️ Checking the wrong bit is an easy and costly mistake.** A self-toggled bot under 100 guilds gets `GATEWAY_MESSAGE_CONTENT_LIMITED` (bit 1 << 19), **not** `GATEWAY_MESSAGE_CONTENT` (bit 1 << 18). This application's flags are `565248` — bit 18 clear, bit 19 set — and message content is returned normally over REST. Code that tests bit 18 alone rejects every correctly configured small bot. An earlier revision of this document asserted the opposite; it was wrong.
- A Post's ID **is** its starter message's ID → `GET /channels/{thread_id}/messages/{thread_id}` fetches the first post directly, no pagination. **Verified 2026-09-01** against two real Posts in `🗳︱suggestions`, cross-checked against the oldest message via `after=0`. This is what keeps ingestion at ~1 call per Post.
- `GET /guilds/{id}/members/{user_id}` works **without** the Guild Members privileged intent.
- **No "get messages by author" endpoint exists.** This is a hard wall for the user-triggered profile audit. v1: user names ≤5 channels. v2: gateway listener maintains a message *pointer* index (locations, no content).
- Forum channels are type 15, media type 16. Threads carry `applied_tags`.
- Global invalid-request limit: 10,000 per 10 minutes.
- Full backfill is **~700 calls / minutes**, not hours — the page needs first posts, not message history.

### Instatic visitor schema (from migrations 024–029)

- `visitor_users`: `email`, `email_normalized`, `password_hash` all **NOT NULL**; partial unique index on `email_normalized where deleted_at is null`
- `visitor_roles`: seeded `member` / `admin` — leave alone; Discord roles map to **groups**
- `visitor_groups` (`slug` indexed) / `visitor_user_groups (unique(user_id, group_id))`; `visitor_users.primary_group_id` nullable
- `visitor_sessions` has `revoked_at` — use for revocation
- `visitor_login_attempts.result` CHECK: `success, bad_password, no_user, locked, rate_limited, account_disabled` — no OAuth value, do not extend
- `visitor_auth_config.registration_open` closes password signup; `protected_prefixes_json` was dropped in 027
- Page access lives in `cells_json` as `{level:'groups', groups:[...]}`, tolerant-parsed, **default public**
- Upstream already has `021_mcp_oauth` — may contain reusable token-exchange/state/PKCE conventions

### Observed from real data

Two `#introductions` transcripts (~15 intros over ~5 days) and the old index page:

- **Humans respond fast when awake:** 0, 2, 8, 12, 16, 23, 28 minutes. Overnight posts wait hours.
- **Humans miss the long tail.** HammerFoe named a logistics business and a church struggle; got Charlotte, board-games, BGA. Nobody mentioned Faith & Religion, Entrepreneurs & Business Owners, or Career. **This is the bot's entire value proposition.** Use it as the development test case.
- **Signal arrives late.** Mark Weigl's intro had nothing matchable; specifics came 8 hours later after a human asked.
- **~20–30% of intros carry no text signal** (empty, image-only, "hello").
- **The old index is already stale.** Party Game Night, Friendslop Funsies, and Battlefield appear in chat but not the page; `steam-deck-gaming` was renamed `steam-deck-and-handhelds`. **Key everything on channel ID; treat names as mutable.**
- **The linked topics page is not used.** It's in the channel description, and every new member got hand-directed instead. Search and filtering are what make an index function — not a nice-to-have.
- **External discovery is real:** two of six substantive intros arrived from Google and Reddit. The recruiting one-pager has existing inbound traffic landing on nothing.
- **Real duplicate threads exist** — "United Kingdom" ×2, "Dad Fits" ×2, Barguments/Newer Barguments, Philadelphia area/Greater Philadelphia, Disc Golf/Frolf, Audio Enthusiasts/Audiophiles. These are live threads splitting audiences. **Near-duplicate detection → a mod merge queue** is a real feature, not cleanup.
- **Old script defects to fix** (they are the quality bar): raw mention/emoji IDs; Discord markdown colliding with wiki markdown (`~~QUEST~~`); no truncation (one entry dumps an entire F1 calendar); empty entries where the first post was image-only; alphabetical with no recency or tags.

---

## 9. Roadmap

Two tracks. **Track 1 has no external dependencies and should not wait on Track 2.**

### Track 1 — Discord service

1. **Sync + render.** discord.js REST, emits `data.json` + markdown. Fix mention resolution, markdown escaping, truncation. **Acceptance gate:** every entity from the old page present with a resolved name, working deep link, and either a description or an explicit marker — *plus a count of what the old script missed*. Coverage as the gate; layout is a free variable.
2. **Denylist/allowlist config + privacy layer.** Ship redaction on the render path here, not later.
3. **Tags + summaries.** Delta-driven off `last_message_id`. Duplicate detection → mod queue.
4. **Papa Sherpa slash commands.** `/find`, `/lately`. Whole-catalog prompt.
5. **Introductions responder.** Shadow mode, then live.

### Track 2 — Instatic ⚠️ VOID

**Do not execute.** Instatic is dead and the OAuth contribution is not being built. Replaced by Tracks B (site + reader auth) and C (Tina) in `ASTRO-ARCHITECTURE.md`. One item survived the change of direction: *hand a migrated club page to a real club editor with no instructions* — it is now the Phase 5 human checkpoint.

### Convergence

Track 1 ships its own minimal rendering first, then re-targets output to Instatic once Track 2 reaches step 5. The renderer is a small share of the work; the sync, tagging, and summarization are portable.

---

## 10. Recurring risks

- **Backup verification.** *(Updated 2026-09-01.)* Back up only what cannot be rebuilt. Tier 0 raw text and sync bookkeeping are a **cache** — one re-crawl restores them, and replicating raw member text off-vendor would outlive the member's own deletions. Opt-outs, profiles, recommendation history and intro-responder terminal states are **durable**: Litestream → R2 from the moment they first exist (Phase 3), and **one rehearsed restore with the command written down**. An untested restore procedure is the same failure that killed the original project, wearing a different hat. Note what does *not* need backing up and say so out loud, because it is most of the system: the Better Auth session store (losing it logs everyone out), Tina's `sqlite-level` datalayer (rebuilt from git on the next build), and both service volumes. Git holds the content; R2 holds the bot's derived state.
- **Content is the backup.** All durable content lives in the monorepo, so every clone is an off-vendor copy with version history, restorable by anyone with access. This is the single biggest improvement over the architecture that died.
- **Bus factor.** The failure this project exists to fix. Repo in a community-owned org, config as code, scheduled DB dump to a private repo, documented restore procedure. Cloudflare and Railway accounts must not be one person's.
- **Scale is small and known.** ~600 entities, a few dozen readers. Cost scales with *channels*, not users. Resist architecture sized for traffic that will not arrive.

---

## 11. Companion artifacts

- **`ASTRO-ARCHITECTURE.md`** — the current build handoff.
- **`CONTEXT.md`** — the binding glossary.
- Old index page (gist): `https://gist.github.com/Sanfam/6b96410eaf58434f966eeae5156e791d` — the coverage baseline.

**No longer applicable.** `OAUTH-HANDOFF.md` and `ALT-ARCH-TINA-ASTRO.md` were referenced by earlier revisions and **do not exist in this repo**; both were Instatic-era and are not being written. Instatic PR #311 / issue #289 and the `dazzakiller/Instatic` fork are abandoned.

---

## 12. Immediate next actions

> **⚠️ SUPERSEDED 2026-08-31.** The original list is void — it opened with "provision Railway Postgres," which is now explicitly retracted, and three of its six items were Instatic work. Current list below.

1. **Create the community GitHub org and push the initial commit into it.** Free today, a migration later, and it is the first concrete step of the ownership problem in §10. Everything else assumes the repo lives there.
2. **Scaffold the monorepo** — `apps/bot`, `apps/site`, `content/`, `docs/` — with Railway watch paths per service.
3. **Mint the bot's git credential as an org-owned machine account or GitHub App.** Not a personal access token. This is the deadline the deferred ownership question actually has.
4. **Start Phase 1.** Sync engine → `content/index/data.json` + `content/config/roles.json`, plus Tier 0 capture. No dependencies, and it replaces the thing that actually died.
5. **Confirm the Message Content intent is enabled** before assuming empty `content` fields are a bug in your code.
6. **Count the Wiki.js corpus** — pages, nesting, non-markdown assets. Blocks scoping the Phase 6 migration and nobody has done it.

Deliberately *not* on this list: provisioning any database, standing up the CMS, and the auth spike. All three come later, and two of them have abort conditions attached.
