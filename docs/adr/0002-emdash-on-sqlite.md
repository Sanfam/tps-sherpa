# ADR-0002: EmDash, inside the Astro site, on SQLite

**Status:** Proposed, 2026-10-16; revised 2026-10-17. **The owner chose EmDash for a trial build, 2026-11-14.** The trial builds the open items below. Acceptance stays the owner's decision, including whether the undocumented internals in open item 4 are acceptable; the fallback still applies if an item cannot be met.
**Builds on:** [ADR-0001](0001-retire-git-as-content-store.md), which opened database-backed CMSs and left the site's datastore open.

## Context

ADR-0001 retired git as the content store, which retired Tina. The 2026-10-13 survey (`docs/research/2026-10-13-cms-and-datastore-options.md`) left four candidates that pass every hard rule: EmDash, StudioCMS, Payload and Wagtail. It ranked EmDash first, and asked for a spike before choosing.

Two spikes ran (`docs/research/2026-10-16-emdash-spike.md`), on EmDash 1.1.0 inside Astro 7.4 on the Node adapter, against a mock Discord. No real credentials or member data were used.

- **Discord sign-in as an EmDash provider does not hold.**
  - EmDash's own sign-in stays live beside any provider we add: passkeys, magic links, the OAuth device flow and API tokens.
  - So an editor could keep CMS access without the Discord check, and anyone could create the first Admin before setup (note §2).
- **EmDash's external-auth mode does hold, for the routes tested** (note §3).
  - The site's own Discord session supplies identity, and `authenticate()` re-checks guild roles with the bot token on every private CMS request.
  - Passkey, magic-link, invite and signup routes are not injected.
  - A non-member leaves no row.
  - A Discord role change applies on the next **private** CMS request, with no new sign-in.
  - **It does not apply on EmDash's public API routes.** There, EmDash's own session and the last stored role decide, so a removed Staff member can still search drafts and export the full snapshot (note §3).
  - EmDash still ships its device flow, OAuth server, API tokens, MCP and signed preview URLs. The spike's gate refuses all but `preview-url`.
  - It also makes the first person to authenticate an Admin, whatever their role, whenever the `users` table is empty.
- **Gating.**
  - EmDash's `middleware.outer` hook runs before all of EmDash, and reached every one of its routes.
  - Our own `src/middleware.ts` alone sees only the requests EmDash would serve.
  - The spike's gate in the hook was a deny-list, tested signed in. It fails open on upgrade, and misses one credential route.
  - No route is prerendered.
- **Scoping.** EmDash enforces per-author ownership. Per-club scoping cannot be enforced through a supported seam, by plugin or otherwise (note §7).
  - Plugin hooks can refuse some writes but cannot grant any.
  - A hook-narrowed Editor role leaves several write paths open.
  - Patching EmDash is the unsupported seam the handoff's anti-goals forbid.
- **Cost.** At least 41 MB more memory than a bare Astro app once settled, and 85 MB after a burst: under $1/month on Railway.
- **Storage.** One WAL-mode SQLite file.
  - **`secure_delete`.** EmDash leaves it off. Our own database descriptor, wrapping EmDash's public SQLite dialect, turns it on for EmDash's connection without a patch (note §6). It does not scrub the FTS5 search index, and CLI or deploy migrations bypass it.
  - **Revisions.** EmDash keeps a fixed 50 per entry, with no age option.

## Decision (proposed)

**The CMS is EmDash, running inside the Astro site, on SQLite on the site's volume (ADR-0001's default shape).** The site's durable SQLite file is replicated by Litestream, under the same startup and restore contract as the bot's.

**Editors sign in through the site's own Discord sign-in**, the reader-auth flow, and EmDash runs in **external-auth mode** with `syncRoles: true`:

- scope `identify` only, with PKCE and state bound to the browser;
- membership and roles read with the bot token on each private CMS request, behind a short cache that also holds refusals: "each request" becomes "within the TTL";
- holders of the `Staff` role map to Admin, and Club Leads to Author. Until Club Lead is its own guild role, holders of `Event Managers` stand in for it and map to Author (owner, 2026-11-14; was "Staff, holders of `Staff` or `Event Managers`, map to Admin");
- a Member with no editor role is refused, and gets no row;
- a gate in `middleware.outer`, built as an **allow-list**, decides which `/_emdash` routes Members, editors and Viewers may reach. EmDash's own credential routes (OAuth server, device flow, OAuth clients, `setup/admin`, `preview-url`) are not on it. API tokens and MCP are, held to the live role (below, 2026-11-18). The spike built a deny-list instead; see open item 2.

**Postgres is not adopted.** Nothing in either spike calls for it, and on Postgres EmDash loses full-text search.

### Decided by the owner, 2026-11-18: MCP, with EmDash API tokens held to the live role

An Admin may connect a machine client (Claude Code) to EmDash's MCP endpoint with an EmDash API token, without a browser session. A token is a credential that outlives its holder's Discord role (open item 1), so the gate holds every request that carries one to the holder's live roles before EmDash runs:

- **Making and revoking tokens.** `admin/api-tokens` and `admin/api-tokens/[id]` are reachable on the site session by an Admin on the live role, and by no token, so no token mints another. EmDash itself serves them to Admins only.
- **Using one.** A request carrying `Authorization: Bearer …` is held to the token alone, as EmDash holds it, even beside a session cookie. Only an API token (`ec_pat_`) passes; an OAuth access token or anything else gets 401. The gate looks the token up as EmDash does, by the SHA-256 of the whole token, read-only, joins its `users` row, and takes the Discord snowflake from the row's `<snowflake>@discord.local` address. It answers 403 unless that account is still a Member with a live editor role at least the role stored on the row. A token that passes may reach MCP and the routes placed for editors on which EmDash enforces its scopes. It reaches no route EmDash serves without reading a token's scopes: not uploaded files, `search`, `search/suggest` or `auth/mode` (EmDash's public routes, where a token with any scope would read what `media:read` or `content:read` guards), nor setup. MCP is reached by a token only, as EmDash already requires. Expired, revoked and unknown tokens are EmDash's to refuse (401); an unknown one is refused by the gate before any Discord call.
- **No `admin`, transfer or `mcp:tools` scope.** A token holding `admin`, any `transfer:` scope or any `mcp:tools` scope is refused (403). Through MCP, `admin` grants the transfer scopes, and with them `site_export_*` and `site_import_*`, which the gate refuses on EmDash's own routes because Litestream is the backup. `mcp:tools` and `mcp:tools:<plugin>` run the tools of any active plugin EmDash registers on the same endpoint (`mcp/server.ts`), plugin code the gate refuses everywhere else; the site has no plugins today. Refusing `admin` costs only the `media_usage_repair` tool and the `/_emdash/api/admin/*` REST routes for tokens.
- **Discord lookups.** For a token's holder the gate keeps only the live EmDash role level, never the role IDs, per Discord account for the role TTL and dropped at its end, refusals and failed lookups too, and shared while a lookup is in flight (`liveLevel()` in `emdash-gate.ts`). A client's burst spends the bot token once per TTL; a Discord outage refuses the account's tokens for one TTL. Only a token EmDash knows reaches the lookup.
- **One spelling.** EmDash tells its API routes by the path as sent, where Astro routes by the decoded path, so `/%5femdash/api/manifest` reaches an EmDash route without EmDash reading the token or its scopes. A request carrying a token is refused unless its path is already decoded, lowercase and free of repeated or trailing slashes.
- **The site's own middleware** lets a bearer request to an EmDash route through without a session, as the gate has already held it.
- **Erasure.** Anonymising an editor deletes their API tokens.
- **Not covered.** A token cannot co-edit: the room socket's watch reads the session cookie, and drops a socket without one. A demoted Admin whose stored role was synced down by a later browser request keeps a working token at the stored, lower role, as their browser session would.
- **What this relies on in EmDash 1.5.0, re-checked on every upgrade:** EmDash's auth middleware classifying routes by the raw `url.pathname`, case-sensitively; `handleBearerAuth` (`astro/middleware/auth.ts`) takes any `Authorization` header starting `Bearer ` over the session on every route but EmDash's public ones (`PUBLIC_API_PREFIXES`, `PUBLIC_API_EXACT`), where it reads no token and enforces no scope, and resolves `ec_pat_` through `_emdash_api_tokens.token_hash` and acts on the `users` row's stored role; `hashPrefixedToken` is SHA-256 of the whole token, base64url without padding (`@emdash-cms/auth`, `tokens.ts`); `_emdash_api_tokens` keeps `user_id` and `scopes` (migration 016); the MCP route is bearer-only and `enforceTokenScope` leaves its tool policy to `mcp/server.ts`; in `hasScope`, `admin` grants every scope but `mcp:tools`; the transfer tools need a transfer scope or an approval made on the refused `admin/transfer` routes; plugin MCP tools need an `mcp:tools` scope; the core MCP tool list has no other way to a route the gate refuses (1.5.0: none beyond `site_*`; `media_create` only confirms an upload made through the refused `upload-url`).

### Decided by the owner, 2026-11-24: editing on the site's pages, on EmDash's stored role

Open item 1 shut everything that trusts the role EmDash stored, because a Discord role loss leaves that role in place. For visual editing on the site's own pages the owner reverses that: a low-traffic community site does not need it, and editors want to edit where they read.

- **Opened.** `visual-editing/action-token`, `visual-editing/toolbar-labels` and `visual-editing/content/[collection]/[id]/publish` move to the editors' list. Each still needs a live editor role at the gate, so a five-minute action token acts for no one who has lost theirs.
- **Pages.** `[...slug].astro` no longer forces edit mode off, so EmDash's toolbar, drafts and inline editing reach an editor who turns edit mode on. The title and body are editable. The nav (`nav.ts`) stays on published pages only.
- **Accepted.** EmDash decides who is an editor on a page from its stored role, read through its own session cookie. Only a private CMS request brings that role up to date, and the gate refuses those to anyone who has lost the role. So someone demoted who stays a Member keeps the toolbar and sees drafts on the site's pages until an Admin changes their EmDash role. They cannot save or publish. Anyone who leaves the guild loses every page at the site's own gate.
- **Not co-editing.** Edits on a page save the whole field, last save wins; live co-editing stays in the CMS.
- **No heading anchors in edit mode.** EmDash's inline editor renders headings itself, so a wiki `#fragment` link lands only outside edit mode.
- **Still refused.** `preview-url`, whose signed links work without a session and outlive the role: issue #120.

### Decided by the owner, 2026-10-17

- **Editor accounts are kept.** EmDash's user rows belong to Staff and Club Leads acting in a role, so they are not erased when someone loses the role. Edit history is pruned at **90 days by age** (ADR-0001), and **`secure_delete` is on**. Trial step 4 builds this:
  - **An age-based revision prune job.** EmDash keeps 50 revisions per entry, a hard-coded count with no age option. The daily site timer deletes revisions older than 90 days straight from EmDash's `revisions` table, skipping each entry's live and draft revision as EmDash's own pruning does, and removes orphaned `_emdash_revision_prune_queue` rows.
  - **`secure_delete` on EmDash's connections,** through our own database descriptor: `{ ...sqlite({ url }), entrypoint: <ours> }`, whose `createDialect` wraps EmDash's public `emdash/db/sqlite` dialect and runs the pragma on each connection. Runtime auto-migrations use the same dialect; after migrations the descriptor enables FTS5 secure-delete on every discovered search table and runs `VACUUM` when migrations changed the file. CLI or deploy migrations do not.
  - **The privacy policy names CMS accounts before Phase 5:** what an editor row holds (a snowflake-derived address, username and role), how long edit history is kept, and that EmDash's logs carry the snowflake-derived address and role changes.
- **Erasure in the CMS: purge and anonymise.** This keeps ADR-0001's "deletes the affected revision rows at once".
  - **Purge history.** Admins get a "purge history" action. When personal data is removed from a page, it deletes that page's old revisions at once, keeping the revision the page currently points to.
  - **Anonymise on request.** An editor's erasure request strips their name and username from their EmDash `users` row, and re-points their revisions to an anonymous author.
  - **Privacy policy.** It states both before Phase 5.
  - **Built in trial step 4 (2026-11-15):** `/admin/emdash/purge-history` and `/admin/emdash/anonymise` are Admin-only POST actions behind the site's live role check and same-origin CSRF check. Purge deletes all unreferenced revisions for one entry and preserves its live and draft pointers. Anonymise creates or reuses a per-editor anonymous author row, clears the editor's name, marks the EmDash `users.data` row, rewrites revision and entry authorship, and gives each anonymised byline a distinct slug. `authenticate()` returns `Anonymous` for marked snowflake-derived emails, so EmDash's `syncName` cannot restore the Discord username. It also rewrites `revisions.edited_by`, the co-editor ids EmDash 1.5.0 records (migration 096); the code feature-detects the column.
  - **What it touches.** EmDash internals it does not document as extension points:
    - `revisions` (delete rows; update `author_id`);
    - `users` (`name`, and the snowflake-derived `email`, which also identifies the person).
  - **Settled by trial step 4:** entry `author_id` values and bylines are re-pointed to the anonymous row; external auth still matches the snowflake-derived email and supplies a placeholder name for marked rows; startup FTS5 secure-delete covers index copies.
  - **Deleted text lingers until a WAL checkpoint (owner, 2026-11-15).** EmDash's own deletes reach the main file at the next checkpoint, which Litestream runs; until then the text sits on disk, out of any user's reach. The owner accepts this as a reasonable effort; purge, anonymise and the prune checkpoint at once.
  - Both are re-checked on every upgrade, like the prune job.
  - **Both mechanisms rest on things EmDash does not document.** The prune job writes to an internal table. A custom descriptor `entrypoint` is a public type used in an undocumented way. Both are re-checked on every EmDash upgrade, with the pin.
- **Club scoping is EmDash's per-author ownership** *(confirmed 2026-11-14 as the barrier to use: no code of ours; Admins edit everything)*. It was chosen because no plugin can enforce per-club scoping through a documented, supported seam (note §7).
  - An Author edits and publishes only their own entries.
  - Admins reassign each migrated club page to its Club Lead, and again at every handover.
  - Co-leads cannot share a page.
  - The handoff's convention still covers what ownership does not: an Author can create entries in any collection, publish without review, and read all drafts.

**Fallback.** StudioCMS, or Wagtail as a separate service, if any of these holds:

- open item 1, 2 or 4 cannot be met without an undocumented EmDash internal;
- the prune job or the `secure_delete` descriptor stops working on an upgrade, with no replacement;
- Litestream cannot replicate EmDash's file.

## Open items

1. **Built-in auth disabled, via external auth.** Spiked, and it works for the routes tested. Still to settle:
   - **The stale role on EmDash's public API routes.** `authenticate()` runs only on private routes, and throws before `syncRoles` writes, so the row keeps its last role. EmDash's own session then serves `search` with drafts (`content:read_drafts`) and `snapshot?drafts=true` (the full export) on that role. A removed editor can export everything (note §3). *(Closed by the gate, trial step 2: `snapshot` is refused to everyone, and `search` needs a live editor role.)*
   - **The first-user hazard.** EmDash makes the first authenticated user an Admin whenever `users` is empty, not only at first setup. The deploy step must make the first CMS request as an Admin, or seed the first Admin row; so must any later step that empties the table.
   - **A cache for the per-request bot-token call that also holds refusals.** With real reader sessions every Member reaches it, and without negative caching one Member can drain the bot's rate limit.
   - **Re-checking the remaining credential routes, including `preview-url`, and the API-token bearer path (decided 2026-11-18, above), on every EmDash upgrade.** `preview-url` mints signed URLs that need only `content:read_drafts`, check no ownership, take an uncapped expiry, and are honoured on public pages: a long-lived credential that survives role loss.
2. **The production gate must be an allow-list.**
   - **Why.** The spike's gate is a deny-list, so it fails open on an EmDash upgrade, the pattern the note rejects for plugins. It already misses `preview-url`.
   - **Who it must sort.** With the real reader session every Member passes "has a site session". The spike only issued sessions to editors. Without more, Members would reach EmDash's public APIs: search across all collections, regardless of our Access rules; media files; and comments.
   - **To do.** Decide which routes Members, editors and Viewers may reach. Design how the gate tells an editor from a Member before EmDash runs. Test it signed in against every route, on each upgrade.
   - **Built (trial step 2, 2026-11-14), in `apps/site/src/emdash-gate.ts`; visual editing moved to editors 2026-11-24, above.** Every route EmDash injects (1.4.0, re-placed for 1.5.0) is on one of five lists: refused to everyone, Members (uploaded files only, as the site's pages are Member-gated), Admins (setup, which EmDash leaves unauthenticated until done), editors, or left to the site's own middleware (`robots.txt`, sitemaps). Any other path under `/_emdash` or `/.well-known/` is refused. The gate tells editors from Members by the live roles on the site session, the same cache `authenticate()` reads, so a removed role shuts `search` within the TTL. Refused to everyone: the credential routes above, `preview-url`, `snapshot` and backups, plugins, themes, importers, public comments, domains, email and dev routes. `test/emdash-gate.test.ts` reads EmDash's route list and fails on any route no list places, so an upgrade that adds one fails CI until it is placed. A separate test, with its own list of credential and export routes, requests every route as each kind of caller. **Still open for step 5:** `media/upload-url` is an editors' route. With local storage it points back through the gate. With R2 it returns a signed upload URL valid for an hour, which outlives a role loss, and refusing it breaks uploads. The owner decides when uploads move to R2.
3. **OAuth hygiene.**
   - PKCE, browser-bound state, and no state written to the database: done in the spike's site sign-in.
   - Still unverified against the real Discord. Against Better Auth 1.7.14 (the Phase 4 auth spike, 2026-11-12, mock Discord): state is signed and single-use, and Better Auth keeps it in the database, a `verification` row per sign-in start, swept by the site's daily cleanup; but the Discord provider sends no PKCE verifier.
   - **PKCE, 2026-11-14 (owner):** Discord sign-in moved to Better Auth's generic OAuth plugin, which sends an S256 challenge and the verifier, through the same sign-in call and callback path. The mock Discord refuses a sign-in without them (`apps/site/test/gate.test.ts`). Whether the real Discord checks the verifier is still unverified.
4. **Erasure gaps.**
   - **The FTS5 search index — built in trial step 4 (2026-11-15).** The custom database descriptor discovers every EmDash FTS5 virtual table through `sqlite_master` after runtime migrations and sets each table's `secure-delete` option. The focused test plants text, deletes it and scans the database bytes. The table discovery remains an undocumented EmDash internal and is re-checked on upgrade.
   - **Migrations.** CLI and deploy migrations bypass our dialect, and some copy whole content tables (`INSERT … SELECT`).
   - **Both are real. The SQLite mechanisms that close them are documented, but applying the FTS5 one depends on an EmDash internal** *(measured 2026-11-14 on SQLite 3.54.1 as bundled with Node 26, on a synthetic file with a planted string; EmDash itself was not run)*:
     - **FTS5.** With `secure_delete` on, deleting a row from a plain FTS5 table left **2 copies** of the deleted text in the index until an `optimize` merge. With FTS5's own option set first (`INSERT INTO t(t, rank) VALUES('secure-delete', 1)`, SQLite 3.42+), it left **0**, at once. The trial now applies this to every discovered table after migrations.
     - **Migrations.** A copy-and-drop migration on a connection without `secure_delete` left the old copy in freed pages. It **survived a later secure erasure** of the row (1 copy left), and **`VACUUM` removed it** (0). So: run migrations only through our dialect, or `VACUUM` after every migration.
   - **Backups are already bounded:** ADR-0001 caps Litestream retention and R2 object versions at 30 days.

### Refreshed against EmDash 1.5.0 (2026-11-11)

The spike ran on 1.1.0. Since then, 1.2.0, 1.3.0, 1.3.1, 1.4.0 and 1.5.0 (2026-11-11) have shipped. The published tarballs were diffed. None of the open items is resolved, the work for items 1, 2 and 4 and for the prune and anonymise steps has grown, and some areas were not checked (listed below).

- **Item 1, unchanged.**
  - Public search still uses EmDash's own session (`astro/middleware/auth.ts:223`, now also with a trailing slash; the gate's slash stripping already covers it). `snapshot` is still on the public exact-match list (`:122`).
  - `syncRoles` still runs only in the external-auth path (`:615`), so a removed editor keeps their last role on these routes. An `authenticate()` that throws still gets 401 (`:547-553`); a failure after it now gets 503 instead.
  - The first authenticated user still becomes Admin whenever `users` is empty (`:581-582`).
  - `syncName` still writes the returned name (`:609`), which `authenticate()` sets to `Anonymous` for anonymised editors.
  - External auth has no cache option (`auth/types.ts`, unchanged), so we still build the cache and its refusals.
- **`preview-url`, unchanged.** It needs only `content:read_drafts`, checks no ownership, and takes an uncapped `expiresIn`. 1.5.0 only resolves a slug to the entry's id. Still refused.
- **New routes, placed (2026-11-15, on the 1.5.0 upgrade branch).** The route list (`integration/routes.ts`) was diffed between 1.4.0 and 1.5.0: three are new to external auth.
  - `content/[collection]/[id]/revisions/editors`: **editors.** It lists who edited an entry's revisions, on `content:read_drafts`, as the `revisions` route beside it already does.
  - `content/[collection]/[id]/room`: was **refused** while co-editing was off; now **editors**, with co-editing on (below).
- **Co-editing is on (owner, 2026-11-15).** `coEditing: true` in `astro.config.mjs`. Three gaps had to close first; each is closed without patching EmDash:
  - **The socket is outside the gate.** The room route mints a single-use token, valid one minute (`rooms/limits.ts`), for a WebSocket EmDash completes on the Node server's `upgrade` event (`rooms/node/upgrades.ts`), past every middleware. The route is now an editors' route, so the token is minted only on the live role, as other editor routes are. EmDash checks only `content:read_drafts` on its stored role (`api/handlers/rooms.ts`).
  - **The socket outlives a role loss.** EmDash closes a socket older than 15 minutes only at its room's next message or hourly drop (`room.ts`, `#closeOldConnections`), and offers no hook. So the gate module wraps the HTTP server's `emit` (`watchRoomSockets()` in `emdash-gate.ts`): each upgrade under `/_emdash/` has its session cookie re-checked through `memberRoles()`, at once and then every `min(TTL, 30 s)`, and the socket is destroyed once that session has no editor role, or on any error. A demoted editor loses the socket within the TTL plus one check; the admin then retries the room route and the gate refuses it. A Discord outage fails the check, so open sockets drop within 30 s and editors rejoin once it passes. The server is found as EmDash finds it, through `diagnostics_channel` `http.server.response.finish`. `emit` is wrapped rather than an `upgrade` listener added, because EmDash decides which upgrades reach a listener by counting listeners (`attach`, `shouldUpgradeCallback`): one more would leave non-room upgrades hanging. `test/gate.test.ts` holds that a demoted editor's open socket closes and a kept one stays.
  - **Room storage holds entry text.** `_emdash_rooms` and `_emdash_room_updates` (migration 097) keep a room's record and its updates as typed, removed text included, until the room compacts (past 1 MB) or EmDash's hourly cleanup drops state an hour past its last write or closed connection (`ROOM_STATE_LIFETIME_MS`, `expireIdle`): one to two hours. Purge history now deletes the entry's room (`{collection}:{entry ID}`) at once; anonymise deletes every room whose record, read whole across its parts, names the editor's id, which a room would otherwise write into the next revision's author and `edited_by`. A room open in the process finds its claim gone at its next write or renewal (seconds), closes its sockets with `rejoin` and reloads from the entry; co-edits not yet saved, at most a few seconds' worth, are lost. **Residual:** a room that saves in those seconds before it notices can write the anonymised editor's id into one more revision. `secure_delete` covers the deleted bytes. An entry deleted, rather than purged, keeps its room until EmDash's hourly cleanup, one to two hours.
  - **What this relies on, re-checked on every upgrade:** the room path shape and the token's one-minute, single-use life; `upgrades.ts` attaching through `http.server.response.finish`, and Node emitting `upgrade` through the server's own `emit`; the room tables' layout and the room ID format; a room treating a missing claim row as a lost claim (`kysely-store.ts`, `#renewing`).
  - `auth/dev-bypass`: **refused**, like `setup/dev-bypass`. 1.5.0 moved it out of the built-in auth injector, so external auth now gets it; it answers 403 outside `astro dev`.
  - `auth/handover` is still injected only with built-in auth, so external auth leaves it out.
  - `site/domain-proof` and `settings/domain` were already in 1.4.0 and are refused: the site uses none of EmDash's domain features.
- **The `middleware.outer` key is still there** (`integration/runtime.ts:547`), and still registered first, as `order: "pre"` ahead of all of EmDash's middleware (`integration/index.ts:400-416`, unchanged since 1.4.0).
- **Revisions.**
  - The count is still a hard-coded 50 (`cleanup.ts:46`), with no age option. EmDash's own pruning still skips each entry's live and draft revision (`database/repositories/revision.ts:487-488`).
  - `_emdash_revision_prune_queue` (migration 059) is unchanged. The age-based prune job keeps it consistent.
  - Migration 096 adds `revisions.kind` (autosave, recovery) and `revisions.edited_by`, a JSON array of co-editor ids. The anonymise step rewrites `edited_by`, now tested against 1.5.0's migrated schema.
- **Scoping.**
  - There is a new `content:edit_own_drafts` grant, which applies only while an entry is a draft.
  - No new seam for scoping by club was found. The hook list and RBAC were not diffed in full.
- **Storage.**
  - `emdash/db/sqlite` is still exported and its source is unchanged, as are the descriptor adapters (`db/adapters.ts`) and the virtual module that imports the descriptor's `createDialect` from its `entrypoint` (`integration/virtual-modules.ts:135-148`). `secure_delete` is still off.
  - `MIGRATION_NAMES` is still exported from `emdash/db`, and the ledger is still `_emdash_migrations` (`database/migrations/runner.ts:210`, `:303`).
  - Transactions still go through Kysely's `db.transaction()` (`database/transaction.ts:67`, `:77`), so the descriptor's `BEGIN IMMEDIATE` still applies. EmDash issues no raw `BEGIN` outside trigger bodies. Kysely is still 0.29.7.
  - Migrations 092-097 copy no content table: they add columns and tables, rewrite rows in place, and copy plugin key-value rows into `options`.
- **Not re-verified:** support for the Node adapter beyond the site's build and tests.
- **Advisories.** No GitHub security advisories are published for `emdash` or `@emdash-cms/auth`.
- **Requirements and pin.**
  - The peer requirement is still `astro >=6`, and the package now needs Node `>=22.16`.
  - 1.5.0 pins zod 4.6.7 itself, so the root `zod` override is gone.

Also required, as before:

- **Uploads go to S3-compatible storage**, or a directory with its own backup, because Litestream does not cover them.
- **Litestream replication of the site's file is rehearsed** before the first real edit.
- **EmDash is pinned to an exact release**, and each upgrade re-checks the gate and the internals listed here. There is no minimum release age (owner, 2026-11-15).

## Consequences

**Gained**

- No second service for the CMS, and no second stack.
- Editors need no GitHub account. They sign in once, through the site's Discord sign-in, which readers use too.
- Discord stays the source of truth for editor roles, re-checked on private CMS requests within the cache TTL. Public API routes need open item 1 first.
- A Club Lead can edit only entries they own: EmDash enforces it, rather than it resting on trust.
- Revisions record their author.

**Accepted costs**

- **Content is Portable Text, not markdown.** The Phase 6 Wiki.js migration needs a conversion script, since no importer exists.
- **EmDash is young.** 1.0 shipped 2026-09-28 and releases weekly. The exact pin and the per-upgrade re-check are the mitigation.
- **Our code sits on a privacy boundary.** The external-auth module and the gate read guild roles and decide who reaches the CMS. They must be reviewed as such, and re-checked against EmDash's routes on every upgrade.
- **Some of what we rely on is not documented by EmDash.** The revision prune job, the purge and anonymise steps, and the `secure_delete` descriptor are part of every upgrade check.
- **Ownership needs Admin work.** Imported pages and handovers are reassigned by hand, and co-leads cannot share a page.
- **Recovery is the raw database file.** EmDash's JSON exports cannot be restored, so Litestream is the only recovery path.

**Not yet verified:**

- a production allow-list against every route, signed in; EmDash's public API routes after a role loss;
- restoring a revision;
- Litestream run against EmDash's file;
- the external-auth flow with Better Auth and the real Discord;
- production execution of the revision prune job, purge action and anonymise step; their test databases pass, but they remain dependent on the undocumented internals listed above.
