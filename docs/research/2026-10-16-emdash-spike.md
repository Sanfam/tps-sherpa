# EmDash spike: Discord sign-in, middleware gating, resource cost

Research note, 2026-10-16, with a second spike on 2026-10-17 (§3). It feeds ADR-0002, the CMS selection, and answers the three EmDash questions in `2026-10-13-cms-and-datastore-options.md` §5. Discovery only: nothing here is product code. The spike's source is kept beside this note (§10).

**Sources and conventions**

- *(verified 2026-10-16)* or *(verified 2026-10-17)* means checked on that day, and each claim says how. **Asserted** means a test fails if the claim is false. **Printed** means a script showed the value but nothing checks it. Anything else is *unverified*.
- `E/…` means the published `emdash@1.1.0` tarball (`npm pack emdash@1.1.0`), which ships `src/`. `A/…` means `@emdash-cms/auth@1.1.0`, and `P/…` means `@emdash-cms/auth-atproto@0.2.48`.
- **The spike ran on:** Astro 7.4.0, `@astrojs/node` 11.1.8, `@astrojs/react` 7.1.0, React 19.3.1 and Node 26.8.1, on macOS. It served the production build with `node dist/server/entry.mjs`.
- **No real credentials or member data.** A local mock stood in for Discord, with fixture people and fake snowflakes. The only OAuth scope requested was `identify`.

**Outcome.** A review of the first spike (§2) found it wrong on its central claim. An `AuthProviderDescriptor` is **added** to EmDash's built-in sign-in, not a replacement for it, so our Discord check can be bypassed.

The second spike (§3) put EmDash in **external-auth mode**, with identity taken from the site's own Discord session. That closes the bypass routes it tested, and re-syncs the role on every private CMS request. It also found a first-user hazard and a set of credential routes that only our gate keeps closed.

Q2's hook covers every route, but the spike's gate is a deny-list, not the allow-list production needs. On EmDash's public API routes, the role does **not** follow Discord (§3). Q3's cost holds.

- **Per-club scoping cannot be enforced through a supported EmDash seam** (§7), so per-author ownership is chosen.
- **`secure_delete` can be turned on without patching EmDash**, though it does not scrub the search index (§6).
- **The owner's decisions and the remaining open items are in §9.**

---

## 1. Which version *(verified 2026-10-16, `npm view emdash time dist-tags`)*

- **`latest` is 1.3.0 (2026-10-15).** 1.2.0 shipped on 2026-10-06.
- **1.1.0 (2026-10-01) is the newest 1.x at least two weeks old**, so both spikes pin it.
- **`auth-atproto` 0.2.48** depends on `@emdash-cms/auth` 1.3.0. It was read as a model only, not installed as a dependency.

---

## 2. First spike: a Discord `AuthProviderDescriptor` (superseded)

### What was built

The provider `auth-discord/` is shaped like `auth-atproto`:

- **Routes.** It injects login and callback routes, with scope `identify` only.
- **Membership.** It reads membership and roles from the bot-token call `GET /guilds/{guild}/members/{user}`.
- **Rejection before any row.** Every rejection runs before `findOrCreateOAuthUser`, so a rejected person gets no row.
- **Role on sign-in.** After that call, `adapter.updateUser(user.id, { role })` runs at each sign-in.
- **Role map.** Staff map to Admin (50) and Club Leads to Author (30).
- **No lowest role.** A Member without an editor role is rejected, not given the lowest role, so we don't keep a row of member data for everyone who clicks the button.

### Results *(verified 2026-10-16, `test-auth.mjs`, fresh database)*

| Case | Result | |
|---|---|---|
| Staff signs in first | Setup completes; the row is Admin (50) | asserted |
| Not in the guild | `error=not_in_guild`; no row; the user count is unchanged | asserted |
| A Member with no editor role | `error=no_editor_role`; no row | asserted |
| Club Lead, then given Staff | 30, then 50 at the next sign-in | asserted |
| Editor roles removed | Sign-in rejected; the row is set to 10 | asserted |
| The session from before the demotion | Creating content returns 403 | asserted. `/auth/me` returning role 10 was printed only |
| Author edits own entry / Staff's entry | 200 / 403 | asserted |
| Author sends `authorId` set to Staff | The owner is unchanged | asserted. The 200 status was printed only |
| Scope on every authorize request | `identify` only | asserted |
| Revision author | `author_id` is the Club Lead's id | **printed only**, and the check would pass with zero revisions |
| `setup_requires_staff`, `unexpected_scope` | Code paths exist | **never exercised** |

- **The role check bites.** `auth-discord/check-resolve-role.ts` asserts that `resolveRole` picks the highest match, and returns `null` when none matches. Flipping the comparison makes it fail (`AssertionError: highest match wins, in any order`). Restoring it makes it pass.

### Why the first design does not hold *(verified 2026-10-16, source; review finding)*

- **EmDash's own sign-in stays live.** `authProviders` are additive. The built-in routes are injected whenever external auth is off (`E/src/astro/integration/index.ts`, "Inject passkey/oauth/magic-link routes unless transparent external auth is active").
  - The first build's manifest lists passkey, magic-link, invite, signup and built-in OAuth routes, plus the OAuth device flow, API tokens and `setup/admin`.
  - So a signed-in Club Lead can register a passkey and later sign in without our callback. They can also approve a device code and hold a long-lived refresh token. Neither path re-runs the Discord check.
  - Before setup, anyone who reaches `/_emdash/api/setup/admin` can create the first Admin.
- **What that falsifies.** "Re-synced on every sign-in", "keeps Author until their session ends" and "only Staff may complete setup" were each true only for our own route.
- **Defects in the provider itself.**
  - The OAuth state is not bound to the browser (login CSRF), and there is no PKCE.
  - Unused state rows are never purged, and they are written to the replicated database by anonymous GET requests.
  - The callback crashes if the provider config is missing, and lets fetch errors escape.
  - It treats any 404 as "not in the guild", so a wrong guild id or a removed bot looks like a rejection.
- **What was correct:** a rejected person gets no row, and own-entry scoping works.
- **A correction to the 2026-10-13 note.** `auth-atproto` 0.2.48's callback calls `updateUser` only to change the **name** (`P/src/routes/callback.ts`), not the role.

---

## 3. Second spike: EmDash in external-auth mode *(verified 2026-10-17)*

### The seam

- **`auth: { type, entrypoint, config }` puts EmDash in external mode** (`E/src/auth/mode.ts`). The module's `authenticate(request, config)` runs on every non-public `/_emdash` request. When it throws, the request gets a 401.
- **How users are matched and synced.** EmDash finds the user by email and creates one when missing (`autoProvision`, on by default). With `syncRoles: true` it writes the returned role to the row on every private request on which `authenticate()` succeeds (`E/src/astro/middleware/auth.ts:579`).
- **No session fallback on private routes.** In production, EmDash's own session is not consulted on private routes; `authenticate()` decides each time. In `astro dev` it falls back to passkey; the spike ran production builds only.

### What was built

The build is the same tree with `SPIKE_AUTH=external`, output to `dist-ext`.

- **The site's own Discord sign-in, a stand-in for Better Auth.** `/auth/discord/start` and `/auth/discord/callback` are site routes, not EmDash routes.
  - **State and PKCE.** State and the PKCE verifier live in a short-lived httpOnly cookie, so a callback is accepted only in the browser that started it. Nothing is written to the database.
  - **Membership.** The callback checks membership with the bot token. Only Discord's "Unknown Member" (404 with code 10007) counts as "not in the guild"; any other failure is an error. Only a Member with an editor role gets a session.
  - **The session.** It is a signed cookie naming the snowflake. The real one would be Better Auth's opaque token, with server-side state.
- **`authenticate()`** (`auth-discord/src/external.ts`):
  - verifies the cookie;
  - calls `GET /guilds/{g}/members/{id}` with the bot token on **every** CMS request;
  - maps the roles to an EmDash role, and throws if there is none;
  - returns a synthetic email `<snowflake>@discord.invalid`, the username, and the role.
- **The gate in `middleware.outer`** (`src/outer-ext.ts`):
  - **A deny-list, refused with 404:** EmDash's OAuth server and device flow, API tokens, OAuth clients, MCP, `setup/admin`, `setup/dev-*` and the `.well-known` OAuth documents (`src/outer-ext.ts:15-25`). It does **not** list `POST /_emdash/api/content/{c}/{id}/preview-url`, which mints signed preview URLs (§4).
  - **Setup:** allowed only for a Staff member, checked with the bot token.
  - **Everything else under `/_emdash`:** needs a valid site session. Without one, admin pages redirect to `/auth/discord/start` and API calls get a 401.
  - **Open:** only `/_emdash/api/health`.

### Results *(verified 2026-10-17, `test-ext.mjs`, fresh database; two consecutive runs passed)*

Each result is asserted unless the row says printed, or from the route list.

| # | Check | Result |
|---|---|---|
| B1 | Built-in passkey, passkey registration, magic link, signup, invite, built-in OAuth, allowed-domains | **404: not injected** in external mode (and not refused by the gate) |
| B2 | Device code and authorize, OAuth token and register, `/_emdash/oauth/authorize`, API tokens, OAuth clients, MCP, `setup/admin`, `setup/dev-bypass`, both `.well-known` OAuth documents | **Refused by the gate, even for Staff** (asserted). That they are **still present** in EmDash comes from the built route list (`routes-ext.txt`), not from the test |
| B3 | `POST /_emdash/api/setup` | 403 for a Club Lead (gate). It succeeds for Staff and creates **no** user row |
| B4 | Not in the guild; a Member with no editor role; a forged cookie | No session cookie, CMS 401, **zero user rows** |
| B5 | The first external user after setup was a Club Lead | **Provisioned as Admin (50) for that request**, then 30 on the next via `syncRoles`. A hazard, below |
| B6 | Same session, no re-sign-in, Discord roles changed | 30 → 50 → 30 on successive requests. Editor role removed, or the person left the guild: **401**. Probed on **private** routes only (`/auth/me`, content create); EmDash's public API routes were not probed (below) |
| B7 | What EmDash keeps per editor | One `users` row per editor. Asserted: the email is `<snowflake>@discord.invalid`, the name is the username, there are no `oauth_accounts` rows, and the user count is 3. Printed only: `email_verified=1`, no avatar, no data |
| B8 | Own-entry scoping | Author edits own (200), not Staff's (403). Revisions exist and all name the Club Lead |
| B9 | Mock request log | Every authorize request asked for `identify` only, with PKCE S256. Every token exchange sent a verifier |
| B10 | Callback replayed in a browser that did not start the flow | `invalid_state`, no session |
| — | No session at all | Admin redirects to the site sign-in; public `search` 401; `health` 200 |
| B11 | `PRAGMA secure_delete` on EmDash's database, read through `getDb()` from `emdash/runtime` | **1**, with the wrapped dialect described in §6 |

- **The test bites.** With `syncRoles: false`, B5's second assertion fails (`actual: 50, expected: 30`). Built without the wrapped dialect (`SPIKE_SECURE_DELETE=0`), B11 fails (`secure_delete on EmDash's connection is 0`). Restoring each and rebuilding makes the run pass again.
- **Not exercised by the test:** PKCE against the real Discord, and whether Discord supports it *(unverified)*. Also Better Auth itself.

### What the second spike finds

- **The bypass routes it tested are closed.**
  - Passkey, magic link, invite and signup are not injected (B1).
  - The device flow and API tokens are present but refused by our gate (B2). Those refusals are our deny-list, not EmDash's.
  - With the gate removed they would be reachable by any signed-in editor. That was not tested, but external mode leaves the routes in place.
- **The role follows Discord on every *private* CMS request** (B6), not only at sign-in. **It does not on EmDash's public API routes** *(verified 2026-10-17, source; review finding; not run)*:
  - `authenticate()` runs only on private routes. When it throws, it does so before `syncRoles` writes (`E/src/astro/middleware/auth.ts:579`), so the user row keeps its last role.
  - Each successful external sign-in also sets EmDash's own Astro session (`auth.ts:621-623`).
  - EmDash's public API routes resolve the user from that session and the stored role:
    - **`/_emdash/api/search`** serves draft results to anyone holding `content:read_drafts` (`E/src/astro/routes/api/search/index.ts:40-44`).
    - **`/_emdash/api/snapshot?drafts=true`** exports all content, drafts included, to any session user with `content:read` and `schema:read` (`E/src/astro/routes/api/snapshot.ts:28-46`, `:87-99`).
  - So a Staff member removed in Discord keeps their stored role on those routes for as long as EmDash's session lasts, and can export everything. B6 did not probe these routes.
- **The first-user hazard.** In external mode EmDash makes the first person to authenticate an Admin, whatever their role (`E/src/astro/middleware/auth.ts:544-545`). The check is "the `users` table is empty", so the hazard **recurs whenever that table is empty**, not only at first setup.
  - Our gate limits setup to Staff, but not who sends the first CMS request after it. A Club Lead held Admin for one request (B5).
  - **Mitigation, not built:** the deploy step that completes setup also makes the first private request as Staff, or seeds the first Staff row.
- **A bot-token call per CMS request.** It needs a short-TTL cache, keyed as reader auth's `roles_fetched_at` is, before real traffic. Not built.
  - Once cached, "re-checked on every request" becomes "re-checked within the TTL".
  - With the real reader session, every Member reaches `authenticate()`, not only editors, so the cache must also hold refusals. Otherwise one Member can drain the bot's rate limit.
- **EmDash logs member identifiers.** It logs the provisioned `<snowflake>@discord.invalid` address and role, and every name or role change (`E/src/astro/middleware/auth.ts:564`, `:594-597`).

---

## 4. Q2: gating `/_emdash/*`

### Ordering *(verified 2026-10-16, source)*

- **EmDash registers these middlewares, all `order: "pre"`:**
  1. `middleware.outer`;
  2. runtime;
  3. redirect;
  4. setup;
  5. auth;
  6. media-usage-write-fence;
  7. request-context.
- **They run before the site's `src/middleware.ts`.**
- **`middleware.outer` runs before EmDash initialises**, so it cannot see `locals.emdash` or EmDash's user (`E/src/astro/integration/runtime.ts`). It decides from the request alone: our session cookie, and a bot-token lookup if it needs one.

### Coverage probe *(verified 2026-10-16, `probe-gate.mjs`, first build)*

The probe sent GET and POST to each of the 208 `/_emdash` routes in the manifest, anonymously.

- **`middleware.outer` refusing everything:** refused 416 of 416.
- **`src/middleware.ts` refusing everything:** refused 78. EmDash answered the other 338 first: 336 with 401 and 2 with a redirect to login.
- **No prerendered routes.** All 216 manifest routes were `"prerender": false`, so the anti-goal holds.

**What that proves, and what it doesn't.** The 416 of 416 shows the hook's **coverage**, not a deployable gate: it refused the sign-in routes and setup as well. The spike's gate in §3 is a **deny-list**, tested signed in by B2, B3 and the no-session line.

### Still open

- **The spike's gate is a deny-list, so it fails open on an EmDash upgrade** (`src/outer-ext.ts:15-25`).
  - Any credential route EmDash adds is reachable until someone adds it to the list. That is the pattern §7 rejects for plugins.
  - It already misses one route: `POST /_emdash/api/content/{c}/{id}/preview-url`. That route needs only `content:read_drafts`, checks no ownership, and takes an uncapped `expiresIn` (`E/src/astro/routes/api/content/[collection]/[id]/preview-url.ts:46-49`, `:95`; `E/src/api/schemas/content.ts:310-315`). The signed URL it returns is honoured on public pages (`E/src/request-context.ts:263-277`), so a long-lived credential survives role loss.
  - **The production gate must be an allow-list:** named routes only, everything else refused.
  - The second build still has 196 routes; its credential-bearing ones are listed in `routes-ext.txt`.
- **"Needs a site session" does not mean "editor" once the real reader session is used.**
  - The spike issued sessions only to editors (`site/src/pages/auth/discord/callback.ts:49-50`). With Better Auth, every Member holds a site session and passes this gate.
  - Members would then reach EmDash's public APIs: `search` across all collections, regardless of our Access rules; `media/file`; and `comments`.
  - Which of these Members, editors and Viewers may reach is a design decision. So is how the gate tells an editor from a Member before EmDash runs.

---

## 5. Q3: resource cost *(verified 2026-10-16, `measure.mjs`)*

**Method.** `measure.mjs` started each built server and sampled `ps -o rss,%cpu`:

- after at least 60 s with no requests;
- straight after 50 sequential requests;
- after ~30 s of idle.

Which requests:

- **EmDash:** `/`, `/_emdash/api/health`, `/_emdash/admin`, `/_emdash/admin/login` and `/_emdash/api/search?q=club`, anonymous, 10 each.
- **Bare app:** Astro 7.4.0 and `@astrojs/node` 11.1.8, with one page and one endpoint, 25 requests each.

| | Bare Astro SSR | Astro + EmDash | Difference |
|---|---|---|---|
| RSS, before any request | 46.5 MB | 64.6 MB | +18 MB, **before EmDash had migrated or loaded its runtime** |
| RSS, just after 50 requests | 76.5 MB | 161.2 MB | +85 MB |
| RSS, idle again after the burst | 47.1 MB | 88.5 MB | **+41 MB: the settled cost** |
| %CPU at idle, before and after | 0.0 / 0.3 | 0.0 / 0.0 | none seen |

- **What the difference includes.** The EmDash app also loads `@astrojs/react`, and the bare app does not. EmDash requires React, so the difference is the cost of adopting EmDash, not of EmDash alone.
- **The real cost is at least 41 MB.** The first EmDash request runs the migrations and loads the runtime. After that, memory settles at about +41 MB and peaks at about +85 MB. The +18 MB figure is not representative.
- **Caveats.**
  - These are macOS figures on Node 26, and Railway's Linux RSS will differ.
  - The OS throttled background timers, so each wait ran several minutes longer than its label.
  - macOS `%cpu` is a decaying average, so the post-burst readings (79.5% and 26.9%) reflect the burst itself.
  - The workload was anonymous traffic, not signed-in editing. Memory was not sampled during the signed-in test runs.
- **What it costs** *(estimate)*. At Railway's $10/GB-month, 41 to 85 MB costs about $0.40 to $0.85 a month, well inside the ~$30 ceiling.
- **Build.** Rebuilds take about 6 s; the bare app builds in under 1 s. One first build stalled for about 10 minutes before Astro's first log line, for reasons not found, and the stall did not recur.

---

## 6. SQLite, erasure, and what is on disk

- **The database is a WAL-mode SQLite file** *(verified 2026-10-16)*.
  - EmDash opens it with Node's built-in `node:sqlite` and sets `journal_mode = WAL` (`E/src/db/node-sqlite-compat.ts`).
  - On disk: `site.db`, `-wal` and `-shm`. Litestream was not run (*unverified*).
- **`secure_delete` is off as shipped.** EmDash never sets it: there is no `secure_delete` anywhere in `E/src`, and its pragmas are `busy_timeout`, `foreign_keys`, `cache_size` and `journal_mode` (`E/src/db/node-sqlite-compat.ts:43-48`). Node's built-in SQLite 3.53.4 defaults to `secure_delete = 0` *(verified 2026-10-17)*.
- **The least-invasive seam to turn it on is a database descriptor of our own** *(verified 2026-10-17, B11)*.
  - **What EmDash offers.** `sqlite({ url })` is public, returns a `DatabaseDescriptor`, and takes only a URL (`E/src/db/adapters.ts:119-124`, `:148-158`), so there is no pragma option.
  - **The contract.** The descriptor's `entrypoint` only has to export `createDialect(config)` (`E/src/astro/integration/virtual-modules.ts:133-145`), the contract every built-in adapter meets.
  - **What we built.** Our entrypoint (`auth-discord/src/secure-sqlite.ts`, about 40 lines) calls EmDash's own public `createDialect` from `emdash/db/sqlite`. It wraps the Kysely driver to run `PRAGMA secure_delete = ON` once on each connection. The descriptor is `{ ...sqlite({ url }), entrypoint: <ours> }`, so EmDash's own migration settings are kept.
  - **The limits.**
    - The `DatabaseDescriptor` type is public, but a custom `entrypoint` is not documented: `deployment/database.mdx` at 1.1.0 names only the built-in adapters. It is a supported type used in an undocumented way, so it must be re-checked on every upgrade.
    - **Migrations, both ways** *(source; review finding)*. Runtime auto-migrations open their database through the configured dialect, which is ours (`E/src/emdash-runtime.ts:2311-2315`, `E/src/astro/middleware.ts:220`), so they run with `secure_delete` on. Migrations run from the CLI or a deploy step use EmDash's own `sqlite-migrations` entrypoint, and bypass it. Migrations can copy member content, not only schema: `019_i18n.ts:338` copies every row of a content table with `INSERT … SELECT`.
    - **FTS5 search index.** EmDash's search tables are contentful FTS5 tables holding their own copy of the indexed text (`E/src/search/fts-manager.ts:101-114`). `secure_delete` does not scrub FTS5 index segments, so deleted text stays in the live `%_data` rows until FTS5 merges them. Closing that needs FTS5's `secure-delete` option or a rebuild after deletions. Not tested.
    - Deleted pages also persist in WAL frames until a checkpoint overwrites them, and in Litestream's WAL retention, which ADR-0001 caps at 30 days.
  - **No patch to EmDash** is needed.
- **Revisions are pruned by count, not by age, and the count is fixed** *(verified 2026-10-17, source)*.
  - EmDash keeps the newest 50 revisions per entry, a hard-coded constant (`E/src/cleanup.ts:42`; `E/src/emdash-runtime.ts:3862`), through `pruneOldRevisions(…, keepCount)` (`E/src/database/repositories/revision.ts:278-293`). There is no setting and no age option.
  - **ADR-0001's 90-day age** therefore needs our own scheduled job that deletes from EmDash's `revisions` table directly. It must skip the revision each entry points at (`live_revision_id`, `draft_revision_id`), as EmDash's own pruning does (`revision.ts:314-315`).
  - That writes to an internal table, so the job is tied to EmDash's schema and must be re-checked on every upgrade.
- **Editor rows outlive the editor role.**
  - In the first spike, a demoted or departed editor's row (snowflake and display name) is kept.
  - In external mode, the row keeps its last role and is never removed (B6, B7).
  - Neither is in `content/privacy-policy.md`.
- **Other state on disk.**
  - **Uploads** go to the `local()` directory, which Litestream does not cover, so they need S3-compatible storage or their own backup.
  - **Astro sessions:** the Node adapter keeps filesystem sessions, which are disposable.
  - **OAuth state:** the first spike's states sit in `_plugin_storage`. In the second spike there is none, because state is cookie-bound.

---


## 7. Club scoping: can a plugin, or a change to EmDash, scope a Club Lead to their club? *(verified 2026-10-17, source and docs at 1.1.0)*

**The owner's question.** Can EmDash enforce "a Club Lead may edit entries whose `club` field matches a club they lead"? The owner asked for this through a plugin or other change, and through a **documented, supported** seam. The handoff's anti-goals forbid "per-document authorization built on an unsupported CMS seam".

**Answer: no, not soundly.**

- A plugin can only refuse an action, and only on some of the paths that change an entry.
- Getting club-wide editing that way would mean giving Club Leads the Editor role and narrowing it with a hook. That leaves several write paths open: it fails open.
- A patch to EmDash is the unsupported seam the anti-goal names, and would have to be carried through every upgrade.
- **Per-author ownership is therefore chosen**, with Admin reassignment.

### What the plugin API exposes

- **The hooks.** These are the complete list (`E/src/plugins/hooks.ts:76-105`):
  - plugin lifecycle;
  - `content:beforeSave`, `afterSave`, `beforeDelete`, `afterDelete`;
  - `content:beforePublish`, `beforeSchedule`, `beforeUnpublish`;
  - `content:after*` notifications;
  - `media:beforeUpload` and `afterUpload`;
  - `cron`, email, comment and byline hooks;
  - `page:metadata` and `page:fragments`.
- **What is missing.** There is no permission, capability or authorization hook. There is no hook on reads. There are no field-level or per-collection roles: the five roles and their permissions are fixed (`A/src/rbac.ts:13-59`).
- **`content:beforeSave`.** It receives the acting user as `actor: { id, role, source? }` (`E/src/plugins/types.ts:1391-1395`, `:1419-1423`). It can reject by throwing `ContentSaveRejectedError`, and any other exception also cancels the save (`E/src/plugins/save-rejection.ts:1-10`; `E/src/emdash-runtime.ts:541-565`). So it fails closed, unlike Tina's `isAuthorized`.
  - The docs present it for "validate, transform, or enrich content" (EmDash repo at tag `emdash@1.1.0`, `docs/src/content/docs/reference/hooks.mdx:53`), not for authorization.
  - The actor is optional: "Internal writes without an authenticated user omit it" (`hooks.mdx:99`).
- **`content:beforePublish`, `beforeSchedule` and `beforeUnpublish`** receive `actor` and can cancel (`E/src/plugins/types.ts:1476-1479`, `:1534-1547`).
- **`content:beforeDelete`** receives only `id`, `collection` and `permanent`, with **no actor** (`E/src/plugins/types.ts:1445-1450`; `E/src/plugins/hooks.ts:673-676`). Permanent deletion bypasses it (`hooks.mdx:200`).

### Why a plugin cannot enforce club scoping

1. **Hooks cannot grant.** EmDash checks permission in the route, before any hook runs: `requireOwnerPerm(user, authorId, "content:edit_own", "content:edit_any")` (`E/src/astro/routes/api/content/[collection]/[id].ts:103`).
   - An Author is refused another person's entry before a plugin is ever consulted, so a plugin cannot let a co-lead edit their club's page.
   - Club-wide editing needs the Editor role (`content:edit_any`, `A/src/rbac.ts:21`), narrowed by the plugin.
2. **Narrowing Editor leaves gaps, so it fails open.**
   - **Updates without `data`.** On an update, `beforeSave` runs only when the request carries `data` (`E/src/emdash-runtime.ts:3612-3613`). Changes to slug, bylines, SEO, taxonomies or `authorId` on another club's entry never reach it.
   - **Revision restore.** Restoring a revision runs no hook (`E/src/api/handlers/revision.ts:102-142`).
   - **Deletion.** Trashing has no actor to check, and permanent deletion skips the hook.
   - **Site-wide powers.** Editor also brings `taxonomies:manage`, `menus:manage`, `bylines:manage`, `comments:moderate` and `media:edit_any` (`A/src/rbac.ts:35-59`). These are site-wide, and no hook scopes them.
   - Every write path EmDash adds later starts unscoped. That is the "fails open on upstream change" pattern the anti-goal names.
3. **The plugin would need Discord roles it is not given.**
   - The actor carries only an EmDash user id and role level (`types.ts:1391-1395`), and external auth stores no extra data on the user (`E/src/astro/middleware/auth.ts:548-559` writes only id, email, name and role).
   - The plugin would have to map the user back to a snowflake through the synthetic email, and call the bot API itself.
4. **What a plugin can soundly do** is narrow an **Author** further. For example, it can refuse a create or `data` update whose `club` field is not one of the actor's clubs. Ownership is then still enforced by EmDash.
   - That adds little: it does not let co-leads share a page.
   - It still relies on `beforeSave` being reached, and an update without `data` skips it.
   - **Not built.**

### Patching or forking EmDash

- **What it would take.** The ownership decision is `canActOnOwn(user, ownerId, …)` (`E/src/api/authorize.ts:59-72`). It receives only the owner's id, not the entry. Club scoping would mean passing the entry, or its `club` field, through every call site: about 85 references across 19 route files plus the MCP server (`E/src/mcp/server.ts`).
- **What it would cost.** That is a security-relevant patch to carry through each EmDash bump, with weekly releases and a two-week pin. It is, by definition, an unsupported seam. Not recommended.

### What per-author ownership means *(verified 2026-10-16, B8 and `A/src/rbac.ts`)*

- **What EmDash enforces.** An Author edits and publishes only **their own** entries. Only Editor and above can reassign `authorId` (`[id].ts:127-132`).
- **What it does not enforce.**
  - **Collections.** An Author can create entries in any collection (`content:create` needs Contributor, `rbac.ts:19`).
  - **Review.** An Author publishes their own entries without review (`publish_own`, `:28`).
  - **Drafts.** An Author can read all drafts (`read_drafts` needs Contributor, `:18`).
- **What Staff must do.**
  - **Imported pages.** An Admin reassigns each migrated club page to its Club Lead. The importer owns it until then, and the Club Lead gets 403.
  - **Handovers.** An Admin reassigns pages when a club changes hands.
  - **Co-leads.** There is one `authorId` per entry, so co-leads cannot share a page; one of them owns it.
- **The handoff.** The handoff locked club scoping as a convention. Per-author ownership is the "enforced per-entry scope … where the chosen CMS offers one" that its CMS section asks to prefer. It is not per-club scoping, and the convention still covers what ownership cannot (above).

---

## 8. Pass or fail

| Question | Result |
|---|---|
| Q1. Discord sign-in, guild and role check, role kept in step | **First spike: fail.** EmDash's own sign-in bypasses it. **Second spike (external mode): pass on private routes only.** No row for a non-member; role re-synced per private request; built-in sign-in not injected. **Fails on EmDash's public API routes:** search and snapshot use the stored role through EmDash's own session (§3). It depends on our gate for credential routes, and has the first-user hazard. |
| Q2. Gating of `/_emdash/*` | **Coverage: pass.** `middleware.outer` covers all 416 requests. **The spike's gate is a deny-list**, which fails open on an upgrade, misses `preview-url`, and lets every Member through once reader sessions are real. A production allow-list is open. |
| Q3. Resource cost | **Pass.** At least +41 MB settled, +85 MB after a burst, including `@astrojs/react`. Under $1/month. |
| Storage and erasure | **WAL file: pass.** **`secure_delete` on EmDash's connection: pass**, through our own database descriptor (B11), on an undocumented use of a public type. **Erasure is not complete:** the FTS5 index keeps deleted text, and CLI or deploy migrations bypass the pragma. **90-day revision age: needs our own job** against an internal table. |
| Per-club scoping | **Not achievable through a supported seam.** Per-author ownership is chosen (§7). |

## 9. Owner decisions and open items

**Decided (owner, 2026-10-17)**

- **Editor accounts are kept.** Their holders are Staff and Club Leads acting in a role. Edit history is pruned at 90 days by age (ADR-0001), and `secure_delete` is on. This needs:
  - **an age-based revision prune job.** EmDash's own pruning keeps 50 per entry and has no age option, so the job deletes from the `revisions` table directly, skipping each entry's live and draft revision (§6). It is tied to EmDash's schema, so it is re-checked on each upgrade.
  - **`secure_delete` on EmDash's connection,** through the wrapped-dialect database descriptor (§6, B11). It too is re-checked on each upgrade.
  - **the privacy policy to name CMS accounts before Phase 5:** what an editor row holds (snowflake-derived email, username, role), how long edit history is kept, and that EmDash's logs carry the snowflake-derived address and role changes (§3).
- **Club scoping is per-author ownership,** because no plugin can enforce per-club scoping through a supported seam (§7). Staff reassign imported pages and handovers. The handoff's convention covers what ownership cannot.
- **Erasure in the CMS: purge and anonymise.** This keeps ADR-0001's "deletes the affected revision rows at once".
  - **Purge history.** Staff get a "purge history" action. When personal data is removed from a page, it deletes that page's old revisions at once, keeping the revision the page currently points to.
  - **Anonymise on request.** An editor's erasure request strips their name and username from their EmDash `users` row, and re-points their revisions to an anonymous author.
  - **Privacy policy.** It states both before Phase 5.
  - **What it touches.** Both write to EmDash internals that it does not document as extension points:
    - `revisions` (delete; update `author_id`);
    - `users` (`name`, and the snowflake-derived `email`, which also identifies the person);
    - an anonymous-author row that must exist.
  - **To settle** *(unverified)*:
    - whether entries' `author_id` and bylines must also be re-pointed;
    - how a stripped row interacts with external auth, which matches users by email;
    - FTS5 rows (above).
  - Both are re-checked on every upgrade, like the prune job.

**Open**

- **(a) Built-in auth disabled, via external auth.**
  - Spiked here (§3): it works for the tested routes.
  - Still to settle:
    - **the stale role on EmDash's public API routes:** search drafts and the full snapshot export, through EmDash's own session (§3);
    - the first-user hazard, which recurs whenever `users` is empty;
    - a cache for the per-request bot call that also holds refusals, and the TTL it adds to "per request";
    - re-checking credential routes, including `preview-url`, on each EmDash upgrade.
- **(b) The production gate must be an allow-list.**
  - The spike's gate is a deny-list, and fails open on upgrade.
  - Decide which EmDash routes Members, editors and Viewers may reach. Every Member holds a site session.
  - Design how the gate tells an editor from a Member before EmDash runs.
  - Test it signed in against every route, and repeat that on each upgrade.
- **(f) Erasure gaps.** FTS5 index segments keep deleted text, and CLI or deploy migrations bypass `secure_delete` (§6).
- **(e) OAuth hygiene.**
  - PKCE and browser-bound state: done in the second spike's site sign-in.
  - Unverified against the real Discord and with Better Auth.

## 10. Rerunning the spike

The spike's source is kept beside this note, in `docs/research/2026-10-16-emdash-spike/`, without its dependencies, build output or databases. It is spike code, not the site: copy it out of the workspace and `npm install` there before running it.

- **`site/`:** Astro with EmDash.
  - Build the first spike with `npx astro build`, into `dist/`.
  - Build the second with `SPIKE_AUTH=external npx astro build`, into `dist-ext/`.
  - The provider and the external-auth module are under `site/auth-discord/`. The second spike's site sign-in is `site/src/pages/auth/discord/`, and its gate is `site/src/outer-ext.ts`.
  - The `secure_delete` dialect is `site/auth-discord/src/secure-sqlite.ts`, and `site/src/pages/api/spike-pragma.ts` reads the pragma back for B11. `SPIKE_SECURE_DELETE=0` builds without the dialect.
- **`bare/`:** the bare comparison app.
- **`mock-discord.mjs`:** the Discord stand-in, with PKCE.
- **`test-auth.mjs`:** the first spike. **`test-ext.mjs`:** the second. Each resets `site/data/site.db`.
- **`probe-gate.mjs`**, with `routes.txt`: Q2. **`routes-ext.txt`:** the second build's routes.
- **`measure.mjs <app-dir> <port> <idle-seconds> <paths…>`:** Q3.
- **`site/auth-discord/check-resolve-role.ts`:** the role-mapping check.

Each script starts and stops its own servers.
