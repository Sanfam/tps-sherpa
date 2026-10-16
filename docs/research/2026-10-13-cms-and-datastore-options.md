# CMS candidates, and SQLite versus Railway Postgres

Research note, 2026-10-13. It feeds ADR-0002, the CMS selection. It consolidates three surveys made today:

- git-backed editors (`2026-10-13-cms-field-a-git-backed.md`);
- flat-file CMSs and Wiki.js (`2026-10-13-cms-field-b-flat-file.md`);
- database-backed and SaaS CMSs (`2026-10-13-cms-field-c-database-backed.md`).

It also draws on the EmDash 1.1 re-evaluation (`2026-10-05-emdash-1.1-reevaluation.md`). Primary sources are cited in those notes. Parts A and B were briefed while git was still the content store, so their "commits to our repo" criteria no longer apply; their facts still do. This note cites only facts that are new here.

**What this note assumes**

- **Git is retired as the content store** (ADR-0001).
- **Both services run on Railway.**
- **Postgres is open.** Railway Postgres has not been ruled out. This note weighs it against per-service SQLite with Litestream rather than treating either as settled.
- **Cost rule.** A candidate is eliminated if it needs a one-time licence fee, or a paid edition, for anything we require. Software, subscriptions and licences together must cost at most $10/month. Hosting is excluded from that figure; this includes Railway compute, volumes, Postgres, and R2 or B2 storage. The overall ceiling of about $30/month still applies.
- **CMS criteria** (ADR-0001):
  - Runs alongside Astro SSR on Node.
  - Editors need no GitHub accounts.
  - Attributed revisions, with rollback of a single document.
  - About 5 editors, with no seat cap below about 8.
- **Not criteria:**
  - Reader gating (anti-goal).
  - Discord sign-in for editors, per-Club-Lead scoping, full-text search and visual editing. All four are preferences.

---

## 1. Bottom line

1. **Four candidates survive every hard rule:** EmDash, StudioCMS, Payload and Wagtail.
   - EmDash and StudioCMS run inside the Astro app, and work on SQLite or Postgres.
   - Payload and Wagtail each run as a second service. ADR-0001 puts CMS content on the site's volume or in the site's Railway Postgres, so either one survives only if the site moves to Postgres (shape B, §2.3).
   - Cockpit Core meets the cost rule and has revisions, but fails the storage rule: it is a separate service with no Postgres support, so it would need a third volume that ADR-0001 does not authorise.
   - Strapi Community and KeystoneJS also meet the cost rule, but neither has revisions in the free edition, so both fail the revision criterion.
2. **EmDash is the strongest fit.**
   - It runs inside our Astro app.
   - It is MIT-licensed, with no paid tier.
   - It is semver-stable since 1.0.
   - It has attributed revisions with restore.
   - It is the only in-Astro candidate with **own-entry scoping**, which makes "Club Leads edit their own club page" a control rather than a convention.
   - Its costs: Discord sign-in is code we write, content is Portable Text rather than markdown, and the project is young.
   - Its public auth API can re-sync an editor's role on every sign-in, so keeping roles in step with Discord needs no unsupported seam (§3.6).
3. **StudioCMS is the in-Astro fallback.**
   - Discord sign-in is built in, but it checks neither guild membership nor roles, and it asks for the `email` scope, which the handoff's scope lock does not allow. The guild and role check is our code on either candidate (§3.6).
   - It is pre-1.0 and has no per-editor scoping.
   - Its SQLite path is libSQL, and whether Litestream can replicate a libSQL file is unverified.
4. **Wagtail is the strongest separate-service option.**
   - Subtree permissions fit club pages.
   - It has revisions with revert.
   - Its full-text search works on SQLite and Postgres.
   - Its costs: a Python service, and no Astro integration.
5. **The database question is mostly downstream of the CMS.**
   - For an in-Astro CMS on one site instance, SQLite with Litestream is cheaper and simpler.
   - Postgres pays off in two cases: we want the site to run more than one instance or to deploy without downtime, or we choose a separate-service CMS.
   - Postgres costs EmDash its full-text search, which works only on SQLite and D1.
6. **Suggested order:**
   1. Spike EmDash on SQLite.
   2. Decide the database for the **site** after the spike.
   3. Keep the **bot** on SQLite whichever way the site goes (§2.4).

---

## 2. Datastore: SQLite with Litestream, or Railway Postgres

### 2.1 What each option is on Railway *(verified 2026-10-13 against docs.railway.com)*

**SQLite with Litestream**

- **Where the data lives.** A database file on the service's own volume.
- **Replication.** Litestream runs alongside the application and streams the WAL to S3-compatible storage: R2 or B2 today. Railway Storage Buckets also qualify, at $0.015/GB-month with free egress.
- **Restore.** Our startup script restores a missing file from the replica (ADR-0001, "Startup and restore").
- **What Railway adds.** Railway volume backups apply to any volume, "such as an SQLite database". They run daily (kept 6 days), weekly (kept 27 days) or monthly (kept 89 days), and are restored by remounting a snapshot volume ([volumes/backups](https://docs.railway.com/volumes/backups)).

**Railway Postgres**

- **What it is.** A Railway-maintained template: a Postgres image on its own volume, reached over private networking.
- **What Railway manages.** Provisioning, networking and image security patches. Backups, PITR, HA and pooling are user-enabled through the dashboard or CLI. Schema and data are always ours ([databases](https://docs.railway.com/databases#what-railway-manages)).
- **PITR.**
  - pgBackRest archives every WAL segment to a Railway bucket.
  - It takes a full base backup weekly and a differential daily, and keeps the last 4 fulls, so the restore window is roughly 4 weeks.
  - A restore creates a **new sibling service** at the chosen timestamp; cutover is manual.
  - There is no PITR fee. It is billed as bucket storage plus upload egress ([point-in-time-recovery](https://docs.railway.com/volumes/point-in-time-recovery)).
- **HA.** Patroni with 2–7 streaming replicas, plus etcd and HAProxy services ([postgresql-ha](https://docs.railway.com/databases/postgresql-ha)). That is several services to pay for, not a toggle.

### 2.2 Pros and cons

| | SQLite with Litestream (per service) | Railway Postgres |
|---|---|---|
| **Running cost** | About the cost of the volume (pennies at our size), plus R2 or B2 storage. No extra process to keep warm. | An extra always-on service. Railway bills memory at $10/GB-month on use. An idle small Postgres is probably $1–3/month (*estimate, not measured*). PITR adds bucket storage and egress. All of this is hosting, so it is outside the $10 rule but inside the ~$30 ceiling. |
| **Backup and restore** | Continuous replication to a **separate vendor** (R2 or B2), so it survives losing the Railway account. We own the startup and restore contract and must rehearse it. Point-in-time restore exists (`-timestamp`) but has coarse granularity. Retention defaults are short (24h snapshots) and need setting deliberately. | One-click PITR, about 4 weeks, managed by Railway. A restore forks a new service and leaves the source untouched. The archive bucket is **on Railway**, so it does not survive losing the account, and the bucket credential is read-write even for a restore. Taking a `pg_dump` to R2 or B2 would be a job we add. |
| **Deploys and instances** | A service with a volume runs **one instance** and has a short gap on every redeploy. Both services carry this. | **The application services become stateless.** The site can run several instances and deploy with no gap. Postgres itself sits on a volume, so it is one instance with a redeploy gap unless HA is bought. |
| **Coupling** | Each service owns its data, and data moves one way by an explicit snapshot (ADR-0001). | One database tempts both services into sharing tables. The 2026-08-26 design kept them apart with a `bot.*` schema. Doing that again is a discipline, not a structural guarantee. |
| **Latency and failure modes** | In-process reads with no network hop. A bad disk or volume is the main failure mode. | A network hop on every query, plus a connection pool to manage. A Postgres outage takes down every service that depends on it. |
| **CMS support** | EmDash, Payload, Wagtail, Cockpit and PocketBase support SQLite in production. Directus lists it with no caveat; Strapi is ambiguous. StudioCMS uses libSQL. | **Wider.** Payload, Strapi, Directus and Wagtail all prefer or recommend Postgres. KeystoneJS, WollyCMS and Wiki.js 3 require it. EmDash and StudioCMS support it. |
| **CMS features** | EmDash full-text search works on SQLite and D1 only. Wagtail's SQLite FTS5 backend is "good enough to use in production". | EmDash **loses full-text search**. Wagtail recommends Postgres for production. |
| **Ad hoc access** | A shell into the container, or a restored copy elsewhere. | `psql` over the TCP proxy or private network. Easier for one-off fixes and reporting. |
| **Erasure** (ADR-0001 policy: removals leave backups within 30 days) | Deleted bytes can survive in free pages (`secure_delete`), in Litestream retention and in R2 object versions. | Deleted bytes survive in WAL archives and base backups for the ~4-week PITR window. They can also survive in dead tuples until `VACUUM`. |
| **Where the docs stand** | ADR-0001 and the handoff are written for this. | It needs a re-scoped ADR-0001: the site's durable file becomes a Postgres database. The bot side is unchanged if the bot stays on SQLite. |

### 2.3 Hybrid shapes

| Shape | When it fits | Comments |
|---|---|---|
| **A. SQLite everywhere** (ADR-0001 as written) | An in-Astro CMS, and one site instance is enough | Cheapest and fewest moving parts. Two Litestream configurations. |
| **B. Bot on SQLite; site and CMS on Postgres** | We want site scaling or zero-downtime deploys, or the CMS prefers Postgres | Keeps the one-way snapshot. The bot's Tier 0 cache and Catalog stay local. Postgres holds CMS content, promote flags and Access settings. If the site runs more than one instance it must hold sessions too: Railway replicas have no sticky sessions, so a per-instance session file would sign members out at random. |
| **C. Both services on one Postgres, separate schemas** | Both services need to write the same data | The 2026-08-26 design. It only earns its coupling if bidirectional data appears. Nothing in the current design needs it. |
| **D. SQLite on the site; a separate-service CMS on its own SQLite volume** | We choose Wagtail, Payload or Cockpit but want no Postgres | Three Litestream setups (bot, site and CMS). Not allowed by ADR-0001 as written: it needs an amendment for a third volume. By this point, Postgres for the CMS is usually simpler. |

### 2.4 Why the bot stays on SQLite in any shape

- **It is one instance by nature.** The bot holds the Discord gateway connection, so it is single-instance regardless of storage. Postgres would buy it no scaling.
- **Its cache is deliberately unreplicated.** The bot's Tier 0 cache must never be replicated (the privacy model). A local disposable file is the natural home for it.
- **Its data stays private.** Today the bot is the only writer of the Catalog, and the site reads it only through the snapshot. Putting the Catalog in a shared Postgres would make "the site never reads the bot's tables" a convention, not a property.

### 2.5 What should decide it

- **Does the site need more than one instance, or zero-downtime deploys?** At this scale, probably not yet. A short gap on redeploy is acceptable per ADR-0001.
- **Which CMS wins?**
  - EmDash on Postgres loses search.
  - Wagtail and Payload are at home on either database.
  - KeystoneJS becomes eligible only on Postgres, but fails the revision criterion anyway.
- **Do we want backups to sit outside Railway?** Litestream gives that by default. With Postgres it is an extra `pg_dump` job.
- **Do we want Railway to run backups for us?** PITR is a managed button, and Litestream is a contract we maintain.

If the answer to the first question is "not yet" and EmDash wins, shape A stands. Moving later from A to B means one data migration on the site only. EmDash supports both databases, and its site-package export moves content and schema, though not users or tokens.

---

## 3. CMS candidates that survive the hard rules (and Cockpit, the near miss)

All are $0 under the cost rule unless stated.

| Candidate | Shape | SQLite | Postgres | Editor sign-in | Per-editor scoping | Revisions and rollback | Maturity |
|---|---|---|---|---|---|---|---|
| **EmDash 1.1** | Inside Astro | ✓ (WAL; full-text search) | ✓ (no full-text search) | Passkeys, GitHub, Google, Microsoft. Discord means writing a provider. | **Own entries** (Author role) | ✓ Full snapshots with `author_id`, and an ownership-checked restore | 1.1.0, semver since 1.0. Released 2026-09-28. |
| **StudioCMS** | Inside Astro | libSQL `file:` (Litestream compatibility unverified) | ✓ | Discord sign-in built in (`@studiocms/oauth`), with no guild or role check. That check means writing a provider. | None. Any editor can edit any page. | ✓ Diffs, with `revertToDiff` | 0.6.1, pre-1.0 |
| **Payload 3** | Separate Next.js service | ✓ | ✓ | Its own auth. Discord means writing a custom strategy. | ✓ Access functions return query constraints | ✓ Versions with diff and restore | 3.90 stable; 4.0 is in beta |
| **Wagtail 8** | Separate Django service | ✓ (FTS5 search) | ✓ (recommended) | Django accounts. Discord through django-allauth, an undocumented combination. | ✓ **Permissions on a page subtree** | ✓ Compare, then replace the current version | 8.0, a mature project |
| **Cockpit Core 2** | Separate PHP service | ✓ (several files) | ✗ (MongoDB only) | Its own accounts. OIDC is available, but Discord does not speak OIDC. | Per model only | ✓ Revert | 2.14 |

### 3.1 EmDash 1.1 (MIT, Cloudflare-backed)

**Pros**
- **Inside our Astro app.** Astro keeps routing, rendering and the adapter. It needs no second service and fits the site volume as ADR-0001 is written.
- **Own-entry scoping that the project ships.** An Author creates, edits and publishes only their own entries, and only an Editor can reassign `authorId`. That makes per-club scoping a real control without touching an unsupported seam, which the handoff's anti-goal forbids.
- **Revisions meet the criterion** *(verified at `emdash@1.1.0` source)*:
  - The `revisions` table stores a full JSON snapshot with `author_id` and `created_at`.
  - `POST /_emdash/api/revisions/{id}/restore` checks ownership before restoring.
- **A real bot write API.** Scoped personal access tokens, a REST API, a CLI and an MCP server. The client converts Markdown to Portable Text on write.
- **Either database.** It runs on SQLite or Postgres, so it keeps both datastore shapes open.
- **No paid tier.**

**Cons**
- **No Discord sign-in.** We would write an `AuthProviderDescriptor` modelled on `auth-atproto`. The shared helper sets a role only when it creates the user, but the provider's own callback can re-sync the role on every sign-in through the public `updateUser` (§3.6). Keeping roles in step with Discord is still our code. `emdash-better-auth` does not help, because it runs on Workers only (EmDash note, §7).
- **Content is Portable Text, not markdown.** Custom blocks have no Markdown form, and there is no Markdown or Wiki.js importer. The Phase 6 migration from Wiki.js would be a script.
- **Young.** 1.0 shipped on 2026-09-28, with eight releases in five weeks. No LTS or support window is stated, and plugins are still on 0.x.
- **Recovery is the raw database file.** JSON backups cannot be restored, so Litestream or PITR is the only recovery path.
- **It adds surface to the site.** It injects six "pre" middlewares and public `/_emdash/api/*` routes. Whether our middleware can gate those is untested.
- **Untested costs.** Memory and CPU inside the site process have not been measured. A React integration and an Astro session driver are both required.

### 3.2 StudioCMS (MIT)

**Pros**
- **Inside Astro**, using the Node adapter.
- **Discord sign-in ships** via `@studiocms/oauth`, the only surviving candidate where it does. It is sign-in only: it imposes no guild or role restriction, maps no roles, and asks for `email` as well as `identify` (Cons, and §3.6).
- **Diff-based revisions** with revert.
- **Supports Postgres** as well as libSQL and MySQL.

**Cons**
- **Pre-1.0** (0.6.1). Version 0.1 shipped only in January 2026.
- **No ownership enforcement.** A page update checks only `isEditor`. Per-club scoping would be a convention again, the outcome the Tina design had to accept.
- **Its SQLite path is libSQL.** It has no production statement, and no WAL pragma appears in the repo. Whether Litestream replicates a libSQL-written file is unverified. On Postgres, this concern goes away.
- **Reverting prunes later diffs.** A revert discards the diffs that came after it, and `maxDiffs` caps how many are kept.
- **Its Discord sign-in does not know about the guild.** The provider imposes no guild or role restriction, and a new account becomes a `visitor`. Promotion is by hand, and later sign-ins never refresh the rank. Mapping Discord roles to ranks means writing our own provider (§3.6).

### 3.3 Payload 3 (MIT)

**Pros**
- **Mature editing features.** Versions with diff and restore (100 per document by default), drafts and access functions that return query constraints. Per-editor scoping is first-class.
- **SQLite or Postgres in production.** Only the D1 adapter is beta.
- **A strong API** for the bot.

**Cons**
- **A separate Next.js service.** It has no Astro adapter, and 4.0 adds TanStack Start, not Astro. That means a second application to deploy and patch, with its own volume or a Postgres.
- **Discord sign-in is custom code.**
- **Memory.** A Next.js admin is heavier than an in-process integration. No published figures exist.

### 3.4 Wagtail 8 (BSD-3)

**Pros**
- **Subtree permissions fit club pages.** Permissions attach to a page subtree and inherit downwards. Publishing is a separate permission, and an editor without it sends changes to moderation.
- **Revisions** with compare, then "Replace current version".
- **Search on either database.** Full-text search works on both SQLite (FTS5) and Postgres.
- **The most mature project in the field.**

**Cons**
- **A Python/Django service** in a TypeScript repository. That adds a new stack to patch and debug.
- **No Astro guide.** The v3 write API is a "preview" and may break in any release. The v2 API is read-only.
- **Discord sign-in is unproven.** It needs django-allauth wired to `WAGTAILADMIN_LOGIN_URL`. That is possible in principle, but no recipe exists.

### 3.5 Cockpit Core 2 (MIT): fails the storage rule, kept for comparison

**Pros**
- **Free core features.** Revert, role permissions and previews.
- **SQLite by default**, in WAL mode.

**Cons**
- **No Postgres.** Its only alternative to SQLite is MongoDB. As a separate service it needs its own volume, which fails ADR-0001's storage rule (§1).
- **Permissions are per model only.** There is no check on who owns an entry.
- **Full-text search and webhooks need Pro**, a one-time €299 fee, which the cost rule eliminates.
- **A PHP service** that keeps several SQLite files. Litestream would replicate the directory.
- **Discord needs an OIDC bridge**, because Discord does not speak OIDC.

### 3.6 Discord sign-in and roles, checked at source *(verified 2026-10-15)*

The question was whether either in-Astro candidate can limit sign-in to guild members and keep editor roles in step with Discord roles. Neither does it out of the box. EmDash can do it through its public API. StudioCMS has the pieces, a provider hook and a rank update, but whether they compose is unverified. StudioCMS's built-in Discord sign-in saves the OAuth handshake, not the check, and it cannot be used as shipped (scope, below).

**StudioCMS** (`withstudiocms/studiocms` at `02aeed1c`):
- **No guild or role check.**
  - `@studiocms/oauth`'s Discord provider asks for the scopes `identify` and `email`, and reads only `/users/@me` (`packages/@studiocms/oauth/src/discord/impl.ts`).
  - The callback handler checks only that auth, OAuth and the provider are enabled (`packages/studiocms/frontend/pages/studiocms_api/_handlers/auth/oauth.ts`).
  - The registration switch, `allowUserRegistration`, sits under `usernameAndPasswordConfig`, so it does not govern OAuth sign-up (`packages/studiocms/src/schemas/config/auth.ts`).
- **New accounts are `visitor`s**, and nothing refreshes the rank.
  - A first sign-in creates the user as `visitor` (`packages/studiocms/src/virtuals/auth/core.ts`, line 48).
  - A later sign-in only creates a session (`handleExistingOAuthAccount` in `packages/@studiocms/oauth/src/shared.ts`).
- **The way in is a plugin.**
  - A plugin can register its own OAuth provider through the `studiocms:auth` hook (`setAuthService`).
  - The SDK can update a user's rank (`permissions` in `packages/@withstudiocms/sdk/src/modules/update/index.ts`).
  - **Unverified:** whether a plugin provider's callback can update the rank, with the authority to do so, on first and later sign-ins. So is how much code it takes.
- **The stock provider breaks the scope lock.** It asks for `email` as well as `identify`. The handoff names only `identify`, PROJECT-STATUS says never to request `email`, and any further scope is a stop condition. Enabling it as shipped needs a human's approval; otherwise our own provider asks for `identify` only.
- **Unverified:** the provider's response schema declares `avatar`, `global_name` and `email` as plain strings. Discord returns `null` for each when unset. Whether that rejects such accounts was not tested.

**EmDash** (`emdash-cms/emdash` at tag `emdash@1.1.0`):
- **Re-sync is supported.** The shared helper `findOrCreateOAuthUser` sets a role only when it creates the user (`packages/auth/src/oauth/consumer.ts`, line 353). After it, a provider's callback can call the public `adapter.updateUser(user.id, { role })` (`UpdateUser` in `packages/auth/src/types.ts`, lines 94 to 102; Kysely adapter at `packages/auth/src/adapters/kysely.ts`, line 163).
- **The pattern already exists in the repo.**
  - `auth-atproto`'s callback runs its allowlist check before `findOrCreateOAuthUser`, then calls `adapter.updateUser` (`packages/auth-atproto/src/routes/callback.ts`).
  - A Discord provider would put the guild and role check in the same place.
- **External auth re-syncs roles natively.** External auth such as Cloudflare Access has a `syncRoles` option that re-applies the mapped role on every sign-in (`packages/core/src/auth/types.ts`; `packages/core/src/astro/middleware/auth.ts`, lines 578 to 581). Discord is not an external-auth provider, so this is the model to follow, not a switch to flip.

---

## 4. Eliminated, and why

| Candidate | Rule that eliminates it | Would Postgres rescue it? |
|---|---|---|
| **Strapi 5 Community** | No revisions in the free edition. Content History needs Growth at $45/month, and Discord SSO needs a $150/month add-on. It also needs 2 GB of RAM at minimum. | No. The revision gap is about licence, not storage. |
| **KeystoneJS 6** | No revisions in core. Its SQLite provider is "not intended" for production. | Only partly. Postgres fixes storage, but revisions remain ours to build. |
| **Directus 12** | The free Core tier is hard-capped at 3 seats, and Team costs $499/month. The Open Innovation Grant might give a free key, but whether an unincorporated community qualifies is unverified. The licence is not OSI-approved. | No. The problem is seats, not storage. |
| **Ghost 6** | MySQL 8 is its only production database. | No. |
| **PocketBase** | A backend, not an editorial CMS. Superusers bypass every rule. | Not applicable; it is SQLite only. |
| **WollyCMS** | v0.3, created in March 2026. | Its production database is Postgres, so technically yes. It is too immature. |
| **Wiki.js 2 or 3** | It is the wiki we are leaving, not a CMS for Astro. Version 3 is a beta labelled "not for production". | Version 3 requires Postgres, but that does not change its role. |
| **bknd, Lucid CMS** | Pre-1.0 or alpha, and not evaluated. | — |
| **Tina, Keystatic, Decap, Sveltia, PagesCMS, other git-backed editors** | Their storage is a git repository, which ADR-0001 retired. | Not applicable. |
| **Statamic Pro, Kirby, Grav Pro add-ons, Typemill GitSync** | One-time or annual licence fees: $349, €99, $50–75 and €122/year. | No. |
| **Grav (free), Bludit** | Flat files on a volume. Litestream cannot replicate them, and the free editions have no revisions. | No. |
| **SaaS: Sanity, Storyblok, Contentful, Hygraph, DatoCMS, Prismic** | Content lives with the vendor. Every paid plan covering about 5 editors exceeds $10/month. Sanity Free works only if every editor is an Administrator. | No. |

---

## 5. Open questions for the decision

- **EmDash Discord provider.** It needs a spike. The spike should establish three things:
  - That an `AuthProviderDescriptor` runs the guild and role check and re-syncs the role on every sign-in. The source says it can (§3.6); the spike builds it.
  - Whether our middleware can gate `/_emdash/api/*`.
  - The memory cost of EmDash inside the Railway site process.
- **StudioCMS Discord provider**, if StudioCMS is chosen. A spike would establish whether a plugin provider asks for `identify` only, rejects non-members, sets the rank on first sign-in, and promotes or demotes it on later ones. Trying it against real members' roles touches member data, so that part needs a human's approval.
- **StudioCMS on libSQL.** Can Litestream replicate a libSQL-written file? If not, StudioCMS means Postgres.
- **Site scaling.** Does anything planned need more than one site instance, or zero-downtime deploys? If not, shape A holds.
- **Backups outside Railway.** If the site goes to Postgres, do we also want an off-Railway `pg_dump` to R2 or B2? Any such copy is bound by ADR-0001's erasure policy: removals leave every backup within 30 days.
- **Markdown portability.** Is losing it acceptable for club pages? EmDash and Payload store structured rich text, Wagtail uses its own rich text or StreamField, and StudioCMS stores Markdown or HTML.
