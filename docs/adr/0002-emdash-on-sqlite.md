# ADR-0002: EmDash, inside the Astro site, on SQLite

**Status:** Proposed, 2026-10-16; revised 2026-10-17. Awaiting the owner's acceptance.
**Not ready for acceptance until the open items below are resolved.**
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
- Staff map to Admin, and Club Leads to Author;
- a Member with no editor role is refused, and gets no row;
- a gate in `middleware.outer`, built as an **allow-list**, decides which `/_emdash` routes Members, editors and Viewers may reach. EmDash's own credential routes (OAuth server, device flow, API tokens, OAuth clients, MCP, `setup/admin`, `preview-url`) are not on it. The spike built a deny-list instead; see open item 2.

**Postgres is not adopted.** Nothing in either spike calls for it, and on Postgres EmDash loses full-text search.

### Decided by the owner, 2026-10-17

- **Editor accounts are kept.** EmDash's user rows belong to Staff and Club Leads acting in a role, so they are not erased when someone loses the role. Edit history is pruned at **90 days by age** (ADR-0001), and **`secure_delete` is on**. This needs building:
  - **An age-based revision prune job.** EmDash keeps 50 revisions per entry, a hard-coded count with no age option. The job deletes revisions older than 90 days straight from EmDash's `revisions` table, skipping each entry's live and draft revision as EmDash's own pruning does.
  - **`secure_delete` on EmDash's connections,** through our own database descriptor: `{ ...sqlite({ url }), entrypoint: <ours> }`, whose `createDialect` wraps EmDash's public `emdash/db/sqlite` dialect and runs the pragma on each connection. The spike verified it on EmDash's connection, and runtime auto-migrations use the same dialect. CLI or deploy migrations do not, and the FTS5 index is not scrubbed (open item 4).
  - **The privacy policy names CMS accounts before Phase 5:** what an editor row holds (a snowflake-derived address, username and role), how long edit history is kept, and that EmDash's logs carry the snowflake-derived address and role changes.
- **Erasure in the CMS: purge and anonymise.** This keeps ADR-0001's "deletes the affected revision rows at once".
  - **Purge history.** Staff get a "purge history" action. When personal data is removed from a page, it deletes that page's old revisions at once, keeping the revision the page currently points to.
  - **Anonymise on request.** An editor's erasure request strips their name and username from their EmDash `users` row, and re-points their revisions to an anonymous author.
  - **Privacy policy.** It states both before Phase 5.
  - **What it needs built:** the purge action, the anonymise step, and an anonymous-author row in `users`.
  - **What it touches.** EmDash internals it does not document as extension points:
    - `revisions` (delete rows; update `author_id`);
    - `users` (`name`, and the snowflake-derived `email`, which also identifies the person).
  - **To settle:**
    - whether entries' `author_id` and bylines must also be re-pointed;
    - how a stripped row interacts with external auth, which matches users by email;
    - the FTS5 index (open item 4).
  - Both are re-checked on every upgrade, like the prune job.
  - **Both mechanisms rest on things EmDash does not document.** The prune job writes to an internal table. A custom descriptor `entrypoint` is a public type used in an undocumented way. Both are re-checked on every EmDash upgrade, with the pin.
- **Club scoping is EmDash's per-author ownership.** It was chosen because no plugin can enforce per-club scoping through a documented, supported seam (note §7).
  - An Author edits and publishes only their own entries.
  - Staff reassign each migrated club page to its Club Lead, and again at every handover.
  - Co-leads cannot share a page.
  - The handoff's convention still covers what ownership does not: an Author can create entries in any collection, publish without review, and read all drafts.

**Fallback.** StudioCMS, or Wagtail as a separate service, if any of these holds:

- open item 1, 2 or 4 cannot be met without an undocumented EmDash internal;
- the prune job or the `secure_delete` descriptor stops working on an upgrade, with no replacement;
- Litestream cannot replicate EmDash's file.

## Open items

1. **Built-in auth disabled, via external auth.** Spiked, and it works for the routes tested. Still to settle:
   - **The stale role on EmDash's public API routes.** `authenticate()` runs only on private routes, and throws before `syncRoles` writes, so the row keeps its last role. EmDash's own session then serves `search` with drafts (`content:read_drafts`) and `snapshot?drafts=true` (the full export) on that role. A removed Staff member can export everything (note §3).
   - **The first-user hazard.** EmDash makes the first authenticated user an Admin whenever `users` is empty, not only at first setup. The deploy step must make the first CMS request as Staff, or seed the first Staff row; so must any later step that empties the table.
   - **A cache for the per-request bot-token call that also holds refusals.** With real reader sessions every Member reaches it, and without negative caching one Member can drain the bot's rate limit.
   - **Re-checking the remaining credential routes, including `preview-url`, on every EmDash upgrade.** `preview-url` mints signed URLs that need only `content:read_drafts`, check no ownership, take an uncapped expiry, and are honoured on public pages: a long-lived credential that survives role loss.
2. **The production gate must be an allow-list.**
   - **Why.** The spike's gate is a deny-list, so it fails open on an EmDash upgrade, the pattern the note rejects for plugins. It already misses `preview-url`.
   - **Who it must sort.** With the real reader session every Member passes "has a site session". The spike only issued sessions to editors. Without more, Members would reach EmDash's public APIs: search across all collections, regardless of our Access rules; media files; and comments.
   - **To do.** Decide which routes Members, editors and Viewers may reach. Design how the gate tells an editor from a Member before EmDash runs. Test it signed in against every route, on each upgrade.
3. **OAuth hygiene.**
   - PKCE, browser-bound state, and no state written to the database: done in the spike's site sign-in.
   - Still unverified against the real Discord and Better Auth.
4. **Erasure gaps.**
   - **The FTS5 search index.** EmDash's search tables are contentful FTS5 tables with their own copy of the text. `secure_delete` does not scrub their segments, so deleted text stays in the live `%_data` rows until a merge. Candidates are FTS5's `secure-delete` option or a rebuild after deletions; untested.
   - **Migrations.** CLI and deploy migrations bypass our dialect, and some copy whole content tables (`INSERT … SELECT`).

Also required, as before:

- **Uploads go to S3-compatible storage**, or a directory with its own backup, because Litestream does not cover them.
- **Litestream replication of the site's file is rehearsed** before the first real edit.
- **EmDash is pinned to a release at least two weeks old.** 1.2 and 1.3 shipped within 15 days of 1.1.

## Consequences

**Gained**

- No second service for the CMS, and no second stack.
- Editors need no GitHub account. They sign in once, through the site's Discord sign-in, which readers use too.
- Discord stays the source of truth for editor roles, re-checked on private CMS requests within the cache TTL. Public API routes need open item 1 first.
- A Club Lead can edit only entries they own: EmDash enforces it, rather than it resting on trust.
- Revisions record their author.

**Accepted costs**

- **Content is Portable Text, not markdown.** The Phase 6 Wiki.js migration needs a conversion script, since no importer exists.
- **EmDash is young.** 1.0 shipped 2026-09-28 and releases weekly. The two-week pin is the mitigation.
- **Our code sits on a privacy boundary.** The external-auth module and the gate read guild roles and decide who reaches the CMS. They must be reviewed as such, and re-checked against EmDash's routes on every upgrade.
- **Some of what we rely on is not documented by EmDash.** The revision prune job, the purge and anonymise steps, and the `secure_delete` descriptor are part of every upgrade check.
- **Ownership needs Staff work.** Imported pages and handovers are reassigned by hand, and co-leads cannot share a page.
- **Recovery is the raw database file.** EmDash's JSON exports cannot be restored, so Litestream is the only recovery path.

**Not yet verified:**

- a production allow-list against every route, signed in; EmDash's public API routes after a role loss;
- restoring a revision;
- Litestream run against EmDash's file;
- the external-auth flow with Better Auth and the real Discord;
- the revision prune job and the purge and anonymise steps, which are not built.
