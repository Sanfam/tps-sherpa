# CMS field, part C: database-backed (SQLite-capable) and SaaS headless

> **Survey brief, not the selection rules.** This survey applied its own brief's criteria, written before or alongside ADR-0001. ADR-0001's CMS criteria (no GitHub accounts for editors, attributed revisions with single-document rollback, storage on the site's volume or Railway Postgres) are applied in `2026-10-13-cms-and-datastore-options.md`, which is authoritative for ADR-0002. A "pass" here is not a pass there.

Research note, 2026-10-13. Facts only, with no recommendation. Scope: CMSs whose source of truth is a database that can be a SQLite file, plus SaaS headless CMSs, plus Litestream. EmDash is out of scope here because `docs/research/2026-10-05-emdash-1.1-reevaluation.md` already covers it. Reader gating is not evaluated.

**Sources and conventions**

- Every claim was checked against the linked primary source on 2026-10-13 *(verified 2026-10-13)*, unless it is marked *unverified* or *inference*.
- Repo paths use `repo@sha7/path#Lx`. Links go to `https://github.com/<repo>/blob/<sha7>/<path>`. The SHAs are:
  - `strapi/strapi@ca3974d` (tag v5.57.0) and `strapi/documentation@d21afb0` (main).
  - `keystonejs/keystone@1a8f2b7` (main HEAD, 2026-09-14).
  - `directus/directus@4f77933` (tag v12.5.0) and `directus/docs@a684247` (main).
  - `wagtail/wagtail@24e624c` (tag v8.0).
  - `Cockpit-HQ/Cockpit@489c333` (tag 2.14.1).
  - `payloadcms/payload@6254c3b` (tag v3.90.2) and `@9c2ffc3` (tag v4.0.0-beta.1).
  - `withstudiocms/studiocms@02aeed1` (main) and `withstudiocms/docs@7562e57` (main).
  - `pocketbase/pocketbase@6f370ea` (tag v0.40.5).
  - `benbjohnson/litestream@ccd326c` (tag v0.5.17).
- Release dates come from `gh release list` and npm `time`, both run on 2026-10-13.

---

## 0. Constraint update (applied 2026-10-13, from the coordinator)

**What changed**

- **Git is retired as the content store.** Any git-related criterion is dropped. That includes **D3** ("no GitHub account"). Every database-backed candidate here would have passed D3 anyway, so it is no longer scored.
- **The target is now** SQLite on **the site service's** Railway volume, replicated by Litestream to R2 or B2.
- **Cost rule (C).**
  - A candidate is **eliminated** if it needs a one-time licence fee, or a paid edition, for the features we require.
  - Software, subscription and licence costs must total **≤ $10/month**. Hosting is excluded from that ceiling, and R2/B2 storage counts as hosting.

**How the rules were read**

- **"Features we require"** means D1, D2 and the seat count in D4. Preferences, such as Discord sign-in, revisions and full-text search, are not treated as requirements. Where only a paid edition unlocks a preference, the table says that the preference is lost under C. If the coordinator treats a preference as required, that candidate is eliminated (§4).
- **Fitting the site-volume target.** Railway allows "Each service can only have a single volume", and "Replicas cannot be used with volumes" ([docs.railway.com/reference/volumes](https://docs.railway.com/reference/volumes), Caveats) *(verified 2026-10-13)*. A volume is mounted "to a service". Railway documents no way to share a volume across services.
  - Litestream forbids SQLite on network filesystems (§3).
  - So a CMS that runs as a separate service would keep its SQLite file on **its own** volume, with its own Litestream process, not on the site service's volume. That is an *inference* from the two sources.
  - Only in-Astro candidates can meet the target as stated.

---

## 1. Summary table

**Key**

- ✓ means pass, ✗ means fail and **?** means the docs are ambiguous.
- **C** is the cost rule from §0. "C ✗" marks a candidate or path that the cost rule **eliminates**.
- **Site vol** says whether the SQLite file can sit on the site service's volume.

| Candidate | Database: is SQLite production-supported? | Shape | Site vol | Editor auth (Discord?) | Cost for ~5 editors; licence | Per-editor scoping | Revisions | Latest release | D1 / D2 / D4 / C |
|---|---|---|---|---|---|---|---|---|---|
| **Strapi 5** | **Ambiguous.** SQLite 3 is in the supported-DB table, but the docs steer production to MySQL, MariaDB or Postgres. There is no "dev only" statement. | Separate Node service | ✗ (own volume) | <ul><li>Email and password are free.</li><li>Discord has a documented `passport-discord` SSO page.</li><li>SSO needs Enterprise, or Growth plus the SSO add-on.</li></ul> | <ul><li>Community: $0, unlimited seats. MIT outside `ee/`.</li><li>Growth is $45/mo and SSO is +$150/mo, so **C ✗** for those.</li></ul> | **Yes (free).** Custom roles plus "the administrator must be the creator". | Content History only on Growth or Enterprise, **so lost under C**. Community has none. | v5.57.0, 2026-10-07 | ✓ / ? / ✓ / ✓ for Community only. **Discord SSO and revisions are eliminated by C.** |
| **KeystoneJS 6** | **No.** "The `sqlite` provider is not intended to be used in production systems." | Separate service (Next-based admin) | ✗ | <ul><li>Own password auth.</li><li>Custom session strategies. Discord would be custom code.</li></ul> | $0; MIT | Yes: `filter` and `item` access functions | No core feature found (*unverified*) | 2026-08-31 (`@keystone-6/core` 8.1.0) | ✓ / **✗** / ✓ / ✓ |
| **Directus 12** | **Listed.** "supports the LTS versions of … SQLite". No production caveat. | Separate Node service | ✗ (own volume) | <ul><li>Local accounts.</li><li>A generic `oauth2` driver exists, but SSO is not on Core.</li></ul> | <ul><li>Core: $0 with a **hard cap of 3 seats**.</li><li>Team: $499/mo, **C ✗**.</li><li>Open Innovation Grant: a $0 key with no caps, for entities under $5M revenue and under 50 staff.</li><li>MSCL-1.0 licence (**non-OSI**).</li></ul> | Item permissions through filter rules (`user_created = $CURRENT_USER`). Whether Core gates them is *unverified*. | Not re-verified | v12.5.0, 2026-10-07 | ✓ / ✓ / **✗ on Core** / **C ✗ on paid tiers.** Survives only with a free OIG key, and eligibility is *unverified*. |
| **Wagtail 8.0** | **Yes.** "tested on PostgreSQL, SQLite…". It recommends Postgres for production, "however, the choice… depends". | Separate Python/Django service | ✗ (own volume) | <ul><li>Django accounts.</li><li>Discord through django-allauth's Discord provider plus `WAGTAILADMIN_LOGIN_URL`. Wagtail does not document that combination.</li></ul> | $0; BSD-3 | **Yes.** Group permissions attach to a page subtree. | Compare, then "Replace current version" (revert) | 8.0, 2026-08-25 | ✓ (2nd service) / ✓ / ✓ / ✓ |
| **Cockpit 2** | **Default.** SQLite through MongoLite, in WAL mode by default. No production statement either way. | Separate PHP 8.3+ service | ✗ (own volume) | <ul><li>Own accounts.</li><li>OIDC through the Identi core module.</li><li>Discord documents no OIDC, so a bridge would be needed (*inference*).</li></ul> | <ul><li>Core: $0, MIT.</li><li>**Pro: €299 one-time** plus €99/yr, so **C ✗**.</li></ul> | Per-model actions only. No own-item check found. | Core: "revert content to previous versions" | 2.14.1, 2026-08-26 | ✓ (2nd service) / ✓ (no prod caveat) / ✓ / ✓ for Core only. **Pro's full-text search and webhooks are eliminated by C.** |
| **Payload 3** | **Yes.** `@payloadcms/db-sqlite` is documented with no beta tag (only D1 is beta) and has a `wal` option. | **Separate Next.js service.** There is no Astro adapter, and the v4 beta adds TanStack Start only. | ✗ (own volume) | <ul><li>Own auth collection.</li><li>Documented "Custom Strategies". Discord would be custom code.</li></ul> | $0; MIT | Yes: access functions return `Where` constraints | Versions with diff and **restore** (`maxPerDoc` defaults to 100) | v3.90.2, 2026-09-23. v4.0.0-beta.1, 2026-10-13. | ✓ (2nd service) / ✓ / ✓ / ✓ |
| **StudioCMS** | **Option documented.** `CMS_LIBSQL_URL=file:./…db` is documented, with no production statement. It is libSQL, not stock SQLite. | **In-Astro integration** (needs an SSR adapter; examples use Node) | **✓** | <ul><li>Built-in auth.</li><li>**Discord via `@studiocms/oauth`.**</li></ul> | $0; MIT | **No.** Ranks are owner, admin, editor and visitor. Any editor may update any page. | Page diffs with revert (`revertToDiff`) | 0.6.1, 2026-10-01 (pre-1.0) | ✓ / ? (libSQL file) / ✓ / ✓ |
| **Ghost 6** | **No.** "MySQL 8 is the only supported database in production." | — | — | — | MIT (self-hosted) | — | — | v6.70.0, 2026-10-13 | — / **✗** / — / ✓ |
| **PocketBase** | Yes (native SQLite) | Separate Go binary | ✗ (own volume) | <ul><li>Discord OAuth2 is built in for auth collections.</li><li>"OAuth2 is not supported" for `_superusers`.</li></ul> | $0; MIT | Per-record API rules, but superusers bypass them | Not checked | v0.40.5, 2026-10-08 | ✓ / ✓ / ? (no editor-role dashboard; *unverified*) / ✓ |
| **WollyCMS** | **No.** "SQLite (dev) / PostgreSQL (prod)" | Separate service with `@wollycms/astro` | ✗ | — | $0; MIT | — | — | v0.3.1, 2026-09-11 | ✓ / **✗** / — / ✓ |
| **bknd** | SQLite (`node:sqlite` or libSQL) | Embeds in Astro and other frameworks | Likely (*unverified*) | Not checked | $0; Apache-2.0 | Not checked | Not checked | v0.20.0, 2026-01-09 | Not evaluated / — / — / ✓ |
| **Lucid CMS** | Not checked | Not checked | — | Not checked | $0; MIT | Not checked | Not checked | v0.19.0-alpha.0, 2026-09-23 (alpha) | Not evaluated / — / — / ✓ |

**Outcome**

- **Passes D1, D2, D4 and C with free software:**
  - Wagtail, Payload and Cockpit Core, all as separate services.
  - StudioCMS in-Astro, with D2 undocumented for production.
  - Strapi Community, with D2 ambiguous, and without Discord SSO or revisions.
- **Fits the site-volume target as stated:** StudioCMS only. bknd is likely but was not evaluated.
- **Paid paths the cost rule eliminates:**
  - Strapi Growth, SSO add-on and Enterprise.
  - Directus Team and Enterprise.
  - Cockpit Pro (one-time fee).
  - Storyblok, Hygraph, DatoCMS and Prismic. Sanity Growth and Contentful Lite are also out.

**SaaS headless.** All of these fail D2 and the site-volume target by construction: content lives on the vendor's servers.

| SaaS | Free-plan seats | Cheapest plan covering ~5 editors | C (≤ $10/mo) | Astro support |
|---|---|---|---|---|
| **Sanity** | 20 seats, but only the Administrator and Viewer roles | **$0** if all 5 are Administrators. Otherwise Growth at $15/seat, so $75/mo. | ✓ on Free with admin-only roles. **✗ on Growth.** | Vendor package `@sanity/astro` 3.5.1 |
| **Storyblok** | 1 seat (max 2) | Growth: $99/mo ($90.75 billed annually), 5 seats | **✗** | Vendor package `@storyblok/astro` 10.3.2 |
| **Contentful** | 10 users *(unverified)* | Free *(unverified)*; Lite is $300/mo for 20 users *(unverified)* | ✓ on Free *(unverified)*; **✗ on Lite** | Astro docs guide; no `@contentful/astro` on npm |
| **Hygraph** | 3 seats (Hobby) | Growth: from $199/mo, 10 seats | **✗** | Astro docs guide; no vendor package found |
| **DatoCMS** | 1 or 2 (the page contradicts itself); "No overages allowed" | Professional: €149/mo billed annually (€199 monthly), 10 collaborators. Non-profits: 50% off on request. | **✗** | Vendor package `@datocms/astro` 0.6.16 |
| **Prismic** | 1 user | Starter is $10/mo for **3 users**, which is too few. Small is $25/mo for 7 users. | **✗** | Astro docs guide; no `@prismicio/astro` on npm |

---

## 2. Candidates

### 2.1 Strapi 5 *(verified 2026-10-13)*

- **Latest release.** v5.57.0, 2026-10-07 (`strapi/strapi@ca3974d`).
- **SQLite status.**
  - The supported-database table lists SQLite 3 as both recommended and minimum, alongside MySQL, MariaDB and Postgres ([docs.strapi.io/cms/configurations/database](https://docs.strapi.io/cms/configurations/database)).
  - The docs describe SQLite for local work: "SQLite is the default… and recommended database to quickly create an application locally" ([strapi/documentation@d21afb0/docusaurus/docs/cms/configurations/database.md#L689](https://github.com/strapi/documentation/blob/d21afb0/docusaurus/docs/cms/configurations/database.md#L689)).
  - For production they say: "When the application is ready for another environment such as production… deployed with a different database instance, usually `MySQL`, `MariaDB`, or `PostgreSQL`" (L670).
  - No statement says SQLite is dev-only.
  - The FAQ warns about SQLite only on *ephemeral* PaaS filesystems ([faq.md#L72](https://github.com/strapi/documentation/blob/d21afb0/docusaurus/docs/cms/faq.md#L72)).
- **WAL.** Strapi's SQLite dialect sets only `foreign_keys` pragmas and no `journal_mode` ([strapi@ca3974d/packages/core/database/src/dialects/sqlite/index.ts#L45](https://github.com/strapi/strapi/blob/ca3974d/packages/core/database/src/dialects/sqlite/index.ts#L45)). Litestream switches a database to WAL itself (§3).
- **RBAC in the free edition.** RBAC is a "Free feature" ([docs.strapi.io/cms/features/rbac](https://docs.strapi.io/cms/features/rbac)).
  - It has an "Add new role" button.
  - It has two default conditions: "the administrator must be the creator" and "the administrator must have the same role as the creator". Custom conditions can be added in code.
  - The pricing page lists RBAC with unlimited roles on Community ([strapi.io/pricing-self-hosted](https://strapi.io/pricing-self-hosted)).
- **What the free edition lacks.**
  - **Paid only.** SSO needs Enterprise or the Growth add-on. Review Workflows, Audit Logs and Enterprise plugins need Enterprise.
  - **Growth or Enterprise.** Content History and Releases ([rbac page nav badges](https://docs.strapi.io/cms/features/rbac); [content-history](https://docs.strapi.io/cms/features/content-history)).
  - **Content History limits.** It keeps 14 days on Growth and 30 to 90 on Enterprise. It has a **Restore** action. Edits made through the API create no version.
- **Discord admin SSO.**
  - Providers are Passport strategies: "Any valid passport strategy that doesn't need additional custom data should therefore work" ([configure-sso guide](https://docs.strapi.io/cms/configurations/guides/configure-sso)).
  - There is a dedicated Discord page that uses `passport-discord` with scopes `identify` and `email` ([strapi/documentation@d21afb0/docusaurus/docs/cms/configurations/sso-providers/discord.md](https://github.com/strapi/documentation/blob/d21afb0/docusaurus/docs/cms/configurations/sso-providers/discord.md)).
  - It requires "an Enterprise plan or the SSO add-on".
- **Cost rule (C).**
  - Community ($0) survives.
  - Growth ($45/mo) and the SSO add-on (+$150/mo) exceed the $10 ceiling. So Discord admin SSO and Content History are unavailable under C.
- **Licence.** Strapi is MIT except for code under `ee/`, which is under the Enterprise licence ([strapi@ca3974d/LICENSE](https://github.com/strapi/strapi/blob/ca3974d/LICENSE)).
- **Pricing.**
  - Community: free, "Unlimited" seats.
  - Growth: $45/mo including 3 seats, plus $15 per seat. The SSO add-on is "$150 /month (+$50/month/seat)".
  - Enterprise: on request ([strapi.io/pricing-self-hosted](https://strapi.io/pricing-self-hosted)).
- **Bot API.** API Tokens are a "Free feature", with Read-only, Full access and Custom types. Custom tokens are scoped per content type and per action ([docs.strapi.io/cms/features/api-tokens](https://docs.strapi.io/cms/features/api-tokens)).
- **Footprint.** The minimum is 1 core, 2 GB RAM and 8 GB disk; the recommendation is 2+ cores and 4 GB+ ([docs.strapi.io/cms/deployment](https://docs.strapi.io/cms/deployment)). Railway bills memory at $10/GB-month on actual use ([docs.railway.com](https://docs.railway.com/guides/right-size-cpu-memory#do-the-cost-math)).
- **Not checked.** Full-text search and markdown-field behaviour.

### 2.2 KeystoneJS 6 *(verified 2026-10-13)*

- **Maintenance.**
  - Last release 2026-08-31 (`@keystone-6/core` 8.1.0). Last commit 2026-09-14 (`1a8f2b7`); repo pushed 2026-09-28.
  - MIT licence, 9,974 stars and 144 open issues (`gh api repos/keystonejs/keystone`).
  - Releases came 08-11, 08-18, 08-20 and 08-31. Nothing has been released in the six weeks since.
- **SQLite.** "The `sqlite` provider is not intended to be used in production systems, and has certain limitations" ([keystone@1a8f2b7/docs/content/docs/config/config.md#L197](https://github.com/keystonejs/keystone/blob/1a8f2b7/docs/content/docs/config/config.md#L197)). **This fails D2.**
- **Item-level access control.** List access has `operation`, `filter` (returns a GraphQL filter that is combined with every query or mutation) and `item` (mutation-time checks with `session`) ([access-control.md#L29-L203](https://github.com/keystonejs/keystone/blob/1a8f2b7/docs/content/docs/config/access-control.md#L29)).
- **Custom auth.** `SessionStrategy` objects are the extension point.
  - The repo ships examples `custom-session-passport`, `custom-session-jwt`, `custom-session-next-auth`, `auth-magic-link` and `framework-astro` (`examples/` at `1a8f2b7`).
  - `@keystone-6/auth` has `next` as a peer dependency (2026-08-31 release notes).
- **Admin editing.**
  - The document field is `@keystone-6/fields-document` 11.0.5.
  - There is an `examples/usecase-versioning` example (not inspected).
  - Markdown fields were not checked.

### 2.3 Directus 12 *(verified 2026-10-13)*

**Licence and limits.**
- Directus v12.5.0 (2026-10-07) ships under the **Monospace Sustainable Core License 1.0 (MSCL-1.0-GPL)** ([directus@4f77933/license](https://github.com/directus/directus/blob/4f77933/license)). That licence:
  - allows any purpose except a "Competing Use";
  - forbids circumventing "license key functionality";
  - converts to GPL-3.0 four years after each release.
- The licence text has no seat or revenue limit. The limits come from license-key tiers instead.
- **Core tier.** It is $0 and needs no key, with "3 seats" as a "hard limit", 25 collections, 5 Flows, and "SSO is not available on Core" ([directus.com/pricing](https://directus.com/pricing)).
- **Who counts as a seat.** "A seat is consumed by each active Studio user". API-only users and static-token service accounts do not count ([directus.com/docs/licensing/overview](https://directus.com/docs/licensing/overview)).
- **Open Innovation Grant.**
  - It gives "free commercial use… for entities with less than $5M in annual revenue and fewer than 50 employees", with "no caps specific to the grant".
  - It unlocks custom access policies and SSO, with 5 activations per key.
  - It is valid for one year and renewable ([directus.com/docs/licensing/open-innovation-grant](https://directus.com/docs/licensing/open-innovation-grant)).
  - Team is $499/mo billed annually.

**Database and features.**
- **SQLite.** The docs say: "Directus supports the Long-Term Support (LTS) versions of PostgreSQL, MySQL, SQLite, MS SQL Server, MariaDB, CockroachDB, and OracleDB" ([directus/docs@a684247/content/self-hosting/2.requirements.md#L23](https://github.com/directus/docs/blob/a684247/content/self-hosting/2.requirements.md#L23)). There is no dev-only caveat. `DB_CLIENT=sqlite3` and `DB_FILENAME` are documented.
- **Item permissions.** Item permissions with `$CURRENT_USER` filter rules are documented ([access-control.md#L26-L32](https://github.com/directus/docs/blob/a684247/content/guides/03.auth/2.access-control.md#L26)).
- **SSO drivers.** The SSO drivers are `local`, `oauth2`, `openid`, `ldap` and `saml` ([auth-sso.md#L23](https://github.com/directus/docs/blob/a684247/content/configuration/auth-sso.md#L23)).

**Cost rule (C).**
- C eliminates Team ($499/mo) and Enterprise.
- The OIG key is $0, so the OIG path is not eliminated by C.

**Result.** Directus fails D4 on Core (3 seats against about 5 editors). It passes only under an OIG key, and the OIG's fit for an unincorporated Discord community is *unverified*.

### 2.4 Wagtail 8.0 *(verified 2026-10-13)*

- **Latest release.** 8.0, 2026-08-25 (`wagtail/wagtail@24e624c`). Licence BSD-3.
- **SQLite.** "Wagtail is tested on PostgreSQL, SQLite, MySQL and MariaDB… We recommend PostgreSQL for production use, however, the choice of database ultimately depends on… personal preference, team expertise, and specific project requirements" ([wagtail@24e624c/docs/advanced_topics/performance.md#L89-L91](https://github.com/wagtail/wagtail/blob/24e624c/docs/advanced_topics/performance.md#L89-L91)).
- **Full-text search.**
  - The database search backend uses "SQLite FTS5" and "should be good enough to use in production on sites that don't require any Elasticsearch specific features" ([docs/topics/search/backends.md#L58-L59](https://github.com/wagtail/wagtail/blob/24e624c/docs/topics/search/backends.md#L58-L59)).
  - Version 7.4 added SQLite result ranking ([docs/releases/7.4.md#L44](https://github.com/wagtail/wagtail/blob/24e624c/docs/releases/7.4.md#L44)).
- **Page-level permissions.**
  - Permissions "can be attached at any point in the page tree, and propagate down the tree".
  - **Edit** "regardless of ownership". **Add** grants editing of "pages owned by the current user". **Publish** is separate; without it, changes go to moderation ([docs/topics/permissions.md](https://github.com/wagtail/wagtail/blob/24e624c/docs/topics/permissions.md)).
- **Revisions.** Page history offers "Compare with previous version". To revert, choose "Review this version", then "Replace current version" ([guide.wagtail.org manage-pages](https://guide.wagtail.org/en-latest/how-to-guides/manage-pages/)). Snippets get revisions through `RevisionMixin` ([docs/topics/snippets/features.md#L114-L118](https://github.com/wagtail/wagtail/blob/24e624c/docs/topics/snippets/features.md#L114-L118)).
- **Headless and write API.**
  - **v2** is read-only.
  - **v3 (new in 8.0, "preview"; "may change in backwards-incompatible ways in any release until stabilised")** adds authenticated create, edit, publish, revert and revision operations. "Rich text as HTML or Markdown" ([docs/releases/8.0.md#L14-L18](https://github.com/wagtail/wagtail/blob/24e624c/docs/releases/8.0.md#L14-L18)).
  - v3 uses Bearer tokens tied to a user, with that user's permissions. Tokens are created in the admin or with `manage.py api_tokens create` ([docs/advanced_topics/api/v3/authentication.md](https://github.com/wagtail/wagtail/blob/24e624c/docs/advanced_topics/api/v3/authentication.md)).
- **Discord.**
  - django-allauth ships a Discord provider and requires the `identify` scope ([docs.allauth.org discord](https://docs.allauth.org/en/latest/socialaccount/providers/discord.html)).
  - Wagtail's `WAGTAILADMIN_LOGIN_URL` can point admin login at another view ([docs/reference/settings.md#L672-L678](https://github.com/wagtail/wagtail/blob/24e624c/docs/reference/settings.md#L672-L678)).
  - No Wagtail doc describes the allauth plus admin combination (*unverified* as a recipe).
- **Astro.** Wagtail has no guide in the Astro docs CMS list ([docs.astro.build/en/guides/cms](https://docs.astro.build/en/guides/cms/)).
- **Footprint.** No published figure; a separate Python service (*unverified*).

### 2.5 Cockpit, Payload, Ghost and newer SQLite-capable candidates *(verified 2026-10-13)*

**Cockpit 2.14.1** (2026-08-26). It passes D1-D4 as a separate PHP service, so the detail follows.
- **Storage.**
  - Data uses `mongolite://…/storage/data` ([Cockpit@489c333/bootstrap.php#L89](https://github.com/Cockpit-HQ/Cockpit/blob/489c333/bootstrap.php#L89)).
  - MongoLite sets `journal_mode` to `WAL` by default ([lib/MongoLite/Database.php#L113-L114](https://github.com/Cockpit-HQ/Cockpit/blob/489c333/lib/MongoLite/Database.php#L113-L114)).
  - Requirements: "PHP >= 8.3", "PDO with SQLite support or mongodb extension", and "256MB+ memory allocated to PHP (minimum)" ([requirements](https://getcockpit.com/documentation/core/quickstart/requirements)).
  - Storage is several SQLite files under `storage/data`, so Litestream would need directory replication (*inference* from the `mongolite://` directory URL).
- **Licence and pricing.**
  - Core is MIT ([LICENSE](https://github.com/Cockpit-HQ/Cockpit/blob/489c333/LICENSE)).
  - Pro is €299 per project, then €99 a year for updates, with "No per-seat pricing". Non-profits get 50% off ([start-journey](https://getcockpit.com/start-journey); [license](https://getcockpit.com/license)).
- **Cost rule (C).** Pro carries a one-time €299 fee, so the cost rule eliminates it. Core ($0) survives.
- **Pro-only features.** Full-text search (Detektivo, Meilisearch), Webhooks and Layouts ([features](https://getcockpit.com/features)).
- **Core features.** "Revert content to previous versions", "fine-grain permissions for multiple user roles" and content previews.
- **Permissions.** Checks are per model and action (`content/{model}/read|create|update|delete|publish`), with no own-item check in the collection controller ([modules/Content/Controller/Collection.php#L24-L325](https://github.com/Cockpit-HQ/Cockpit/blob/489c333/modules/Content/Controller/Collection.php#L24)).
- **SSO.** The Identi core module provides OIDC "with PKCE" and role mapping ([modules/Identi/README.md](https://github.com/Cockpit-HQ/Cockpit/blob/489c333/modules/Identi/README.md)).
- **Discord and OIDC.** Discord's OAuth2 docs mention no `openid` scope, no `id_token` and no discovery document ([docs.discord.com/developers/topics/oauth2](https://docs.discord.com/developers/topics/oauth2)).

**Payload.** It passes D1-D4 only as a separate Next.js service.
- **Adapters.**
  - At v4.0.0-beta.1 (2026-10-13), the `packages/` framework adapters are only `next` and `tanstack-start`. There is no Astro adapter (`payloadcms/payload@9c2ffc3/packages/`).
  - v4.0.0-beta.0 (2026-10-09) lists "TanStack support" ([release](https://github.com/payloadcms/payload/releases/tag/v4.0.0-beta.0)).
  - The latest stable release is v3.90.2 (2026-09-23).
- **SQLite.**
  - The SQLite adapter carries no beta label; only the D1 adapter is "in beta". There is a `wal` option, and `busyTimeout` defaults to `0` ([payload@6254c3b/docs/database/sqlite.mdx#L55, L287, L342-L367](https://github.com/payloadcms/payload/blob/6254c3b/docs/database/sqlite.mdx#L342)).
  - Push mode is dev-only.
- **Versions.** Admin views for diffs, plus "restore documents back to prior versions". `maxPerDoc` defaults to 100. REST offers `POST /api/{collection}/versions/:id` ([docs/versions/overview.mdx#L14, L58, L106](https://github.com/payloadcms/payload/blob/6254c3b/docs/versions/overview.mdx#L14)).
- **Access and auth.** Access functions may return `Where` queries ([docs/access-control/overview.mdx#L60](https://github.com/payloadcms/payload/blob/6254c3b/docs/access-control/overview.mdx#L60)). "Custom Strategies" are documented ([docs/authentication/custom-strategies.mdx](https://github.com/payloadcms/payload/blob/6254c3b/docs/authentication/custom-strategies.mdx)).
- **Licence.** MIT.

**One line each**
- **Ghost** v6.70.0 (2026-10-13): "MySQL 8 is the only supported database in production" ([docs.ghost.org/faq/supported-databases](https://docs.ghost.org/faq/supported-databases/)). **Fails D2.**
- **StudioCMS** 0.6.1 (2026-10-01; 0.1.0 shipped 2026-01-15; MIT). It runs **inside Astro** and needs an SSR adapter; the examples use `node({ mode: "standalone" })` ([getting-started](https://docs.studiocms.dev/en/start-here/getting-started/)).
  - **Database.** `CMS_LIBSQL_URL` accepts `file:./path/to/your/database.db` ([withstudiocms/docs@7562e57/src/content/docs/en/start-here/environment-variables.mdx#L29-L40](https://github.com/withstudiocms/docs/blob/7562e57/src/content/docs/en/start-here/environment-variables.mdx#L29-L40)).
  - **Discord.** Sign-in comes through `@studiocms/oauth`; `@studiocms/discord` is deprecated in its favour ([studiocms-oauth.mdx](https://github.com/withstudiocms/docs/blob/7562e57/src/content/docs/en/package-catalog/studiocms-plugins/studiocms-oauth.mdx)).
  - **Ranks.** They are `unknown`, `visitor`, `editor`, `admin` and `owner` ([studiocms@02aeed1/packages/@withstudiocms/auth-kit/src/types.ts#L89-L95](https://github.com/withstudiocms/studiocms/blob/02aeed1/packages/@withstudiocms/auth-kit/src/types.ts#L89-L95)).
  - **No ownership check.** A page update checks only `isEditor`; the author and contributors are recorded but not enforced ([…/studiocms_api/_handlers/dashboard/content.ts#L459-L507](https://github.com/withstudiocms/studiocms/blob/02aeed1/packages/studiocms/frontend/pages/studiocms_api/_handlers/dashboard/content.ts#L459-L507)).
  - **Revisions.** Diff tracking offers `revertToDiff`, which prunes later diffs; there is also a `maxDiffs` cap ([…/sdk/src/modules/diffTracking/index.ts#L31-L90](https://github.com/withstudiocms/studiocms/blob/02aeed1/packages/@withstudiocms/sdk/src/modules/diffTracking/index.ts#L31-L90)).
  - **Bot API.** REST API tokens are created per user in the dashboard ([how-it-works/restapi.mdx#L17-L19](https://github.com/withstudiocms/docs/blob/7562e57/src/content/docs/en/how-it-works/restapi.mdx#L17-L19)).
  - **WAL.** No `journal_mode` pragma was found in the repo (code search).
- **PocketBase** v0.40.5 (2026-10-08; MIT; "full backward compatibility is not guaranteed before reaching v1.0.0").
  - It ships a `discord.go` OAuth2 provider ([pocketbase@6f370ea/tools/auth/](https://github.com/pocketbase/pocketbase/tree/6f370ea/tools/auth)).
  - "OAuth2 is not supported as auth method for the `_superusers` collection", and "Superusers can access and modify anything (collection API rules are ignored)" ([pocketbase.io/docs/authentication](https://pocketbase.io/docs/authentication/)).
  - It is a backend, not an editorial CMS.
- **WollyCMS** v0.3.1 (2026-09-11; MIT; repo created 2026-03-20). Its README says "SQLite for dev, PostgreSQL for production" (`WollyCMS/wollycms@7b77e94/README.md#L71`). **Fails D2.**
- **bknd** v0.20.0 (2026-01-09; Apache-2.0). It lists "Astro" as a framework and "SQLite: LibSQL, Node SQLite…" ([bknd-io/bknd README](https://github.com/bknd-io/bknd)). It is pre-1.0 and was not evaluated further.
- **Lucid CMS** v0.19.0-alpha.0 (2026-09-23; MIT; 23 stars) ([buildlucid/lucid-cms](https://github.com/buildlucid/lucid-cms)). It is alpha and was not evaluated.

### 2.6 SaaS headless *(verified 2026-10-13 unless marked)*

Sources for the SaaS table:
- **Sanity:** [sanity.io/pricing](https://www.sanity.io/pricing). The free plan's 20 seats cover only the Admin and Viewer roles; the "Editor role starts on Growth"; Viewers are free on every plan.
- **Storyblok:** [storyblok.com/pricing](https://www.storyblok.com/pricing).
- **Hygraph:** [hygraph.com/pricing](https://hygraph.com/pricing). Hobby has "3 seats"; Growth is "From $199 per month" with "10 seats". The page was fetched with curl.
- **DatoCMS:** [datocms.com/pricing](https://www.datocms.com/pricing).
- **Prismic:** [prismic.io/pricing](https://prismic.io/pricing).
- **Contentful:** [contentful.com/pricing](https://www.contentful.com/pricing/) returned a Vercel bot challenge and HTTP 429, so its figures come from search-index snippets of contentful.com pages and are *unverified*.
- **Astro support:**
  - The Astro docs CMS index lists guides for all six ([docs.astro.build/en/guides/cms](https://docs.astro.build/en/guides/cms/)).
  - Vendor package versions come from `npm view`.
  - No official content-layer loader export was found in `@storyblok/astro` or `@datocms/astro`.

---

## 3. Litestream *(verified 2026-10-13)*

- **Release.**
  - Current release **v0.5.17, published 2026-08-31T21:59Z** (`benbjohnson/litestream@ccd326c`). The repo was last pushed 2026-10-13. Licence Apache-2.0.
  - Officially supported platforms are Linux and macOS; Windows is "NOT an officially supported platform" ([release notes](https://github.com/benbjohnson/litestream/releases/tag/v0.5.17)).
- **WAL and locking.**
  - "Litestream only works with the SQLite WAL journaling mode" and "will automatically set the database mode to `WAL` if it has not already been enabled by the application" ([litestream.io/tips](https://litestream.io/tips/)).
  - Recommended settings are `PRAGMA busy_timeout = 5000` and `PRAGMA wal_autocheckpoint = 0`.
  - "It is _your_ responsibility to ensure you do not have multiple applications replicating concurrently."
- **Single container (`-exec`).**
  - The documented command is `litestream replicate -exec "myapp …"`, or `exec:` in the config. "Litestream will monitor your application's process and automatically shutdown when it closes" ([litestream.io/guides/docker](https://litestream.io/guides/docker/)).
  - The guide also says: "Ensure only one process writes to the database at a time", and "Never place SQLite databases on NFS, SMB, or other network filesystems".
  - The `replicate` reference says: "Litestream will exit when the child process exits"; `-exec` conflicts with `-once` ([litestream.io/reference/replicate](https://litestream.io/reference/replicate/)).
  - Signal forwarding is not documented.
- **Railway.**
  - Railway's docs contain no Litestream page; the docs search for "litestream sqlite volume backup" returned nothing.
  - Railway documents that "services with an attached volume cannot run two deployments at once, so a redeploy of a volume-backed service always has a small window of downtime" ([docs.railway.com rotate-credentials guide](https://docs.railway.com/guides/rotate-credentials-zero-downtime#make-the-redeploy-itself-zero-downtime)). That structurally prevents two replicators during a deploy (*inference*).
  - Community Railway templates bundle PocketBase with Litestream, for example [railway.com/deploy/pocketbase-litestream-hooks](https://railway.com/deploy/pocketbase-litestream-hooks). They are community-authored and *unverified*.
  - Railway also states "Each service can only have a single volume" and "Replicas cannot be used with volumes" ([docs.railway.com/reference/volumes](https://docs.railway.com/reference/volumes)). So the site service runs as a single replica while it holds the volume.
  - Volumes cost $0.15/GB-month ([docs.railway.com](https://docs.railway.com/platform/compare-to-heroku)).
- **R2.**
  - R2 is documented under S3-compatible services: `type: s3`, `endpoint: ${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`, `region: auto`, and an R2 token with "Object Read & Write" permission.
  - Litestream auto-detects `*.r2.cloudflarestorage.com` and applies `concurrency: 2` (since v0.5.8). The EU endpoint is `${ACCOUNT_ID}.eu.r2.cloudflarestorage.com` ([litestream.io/guides/s3-compatible](https://litestream.io/guides/s3-compatible/)).
- **B2.**
  - Backblaze B2 has its own guide: `type: s3`, `endpoint: s3.<region>.backblazeb2.com`, `force-path-style: true`.
  - "Litestream v0.5.0+ automatically detects Backblaze B2 endpoints and configures `force-path-style` and `sign-payload`" ([litestream.io/guides/backblaze](https://litestream.io/guides/backblaze/)).
  - The R2 `DeleteObjects` caveat below is specific to R2. No B2 equivalent was found on the troubleshooting page (*unverified*).
- **Cost.** Litestream is Apache-2.0 and $0, so it adds nothing under the cost rule. R2 or B2 storage is hosting, which the ceiling excludes.
- **Restore.**
  - The command is `litestream restore [-o PATH] [-timestamp TS | -txid TXID] DB_PATH|REPLICA_URL`. The idempotent boot form is `litestream restore -if-db-not-exists -if-replica-exists /var/lib/db`.
  - `replicate` auto-restores a missing database in "quick" mode.
  - Point-in-time restore replays whole LTX files and stops only at file boundaries. `-timestamp` is exclusive. Restore points can be listed with `litestream ltx -level all` and checked with `restore -dry-run`. `-o` will not overwrite a non-empty file without `-force` ([litestream.io/reference/restore](https://litestream.io/reference/restore/)).
- **Retention.**
  - Defaults are `snapshot.interval: 24h`, `snapshot.retention: 24h`, `retention.enabled: true`, `l0-retention: 5m`, and levels 30s, 5m and 1h.
  - Retention is global, not per replica. There is "no way to retain L0 indefinitely".
  - `retention.enabled: false` means Litestream "will not delete old LTX or snapshot files", which leaves cleanup to bucket lifecycle rules ([litestream.io/reference/config](https://litestream.io/reference/config/)).
  - **How long a deleted row survives:** it stays in every snapshot or LTX file written before the delete until retention removes that file. By default that is roughly `snapshot.retention` (24h) after a newer snapshot exists. The exact upper bound is not documented (*inference*).
- **R2 deletion caveats.**
  - R2 `DeleteObjects` "may return HTTP 200 with objects listed as 'Deleted', but the files are not actually removed". The workaround is an R2 lifecycle rule; "Set lifecycle days higher than your Litestream retention".
  - With bucket versioning on, deletions become delete markers ([litestream.io/docs/troubleshooting](https://litestream.io/docs/troubleshooting/)).
  - So in practice, deleted rows may outlive the configured retention on R2.
- **Directory replication.** `dir` plus `pattern` replicates many databases. With `watch`, new databases begin replicating "within seconds" (v0.5.13+) ([reference/config](https://litestream.io/reference/config/)). This is relevant to Cockpit's multi-file storage.

---

## 4. Open or unverifiable

**Not documented, or ambiguous**

- **Strapi on SQLite in production.** The docs neither endorse it nor forbid it (§2.1). Whether Strapi Inc. supports it, for example in support tickets, is *unverified*.
- **Cockpit on SQLite in production.** No statement either way. Its file layout under `storage/data` (how many files, and their names) was not enumerated.
- **StudioCMS on a libSQL `file:` database.** No production statement. Litestream's compatibility with libSQL-written files is *unverified*: libSQL is a SQLite fork, and its encryption option would break compatibility (*inference*). No WAL pragma was found.
- **Wagtail with django-allauth for admin login.** The combination is possible through settings, but Wagtail has no recipe for it.
- **Footprint.** No published RAM figures for Wagtail, Payload (Next.js), StudioCMS or Cockpit. Only Strapi publishes a minimum: 2 GB.

**Questions raised by the 2026-10-13 rules**

- **Which features are required.** §0 reads "features we require" as D1, D2 and the seat count in D4. If Discord sign-in or revisions are required, the cost rule eliminates Strapi: those features need Growth plus the SSO add-on, at $45+/mo. If full-text search is required, it eliminates Cockpit: that needs Pro, a €299 one-time fee. StudioCMS loses nothing under either reading.
- **Separate-service candidates and the site-volume target.** Railway documents no way to share a volume across services, and Litestream forbids network filesystems. So Strapi, Directus, Wagtail, Cockpit, Payload and PocketBase would each need their own volume and their own Litestream process (*inference*).

**Unverified**

- **Free Sanity and Contentful plans and commercial use.** Whether these free plans permit this use was not checked.

- **Directus OIG eligibility for an unincorporated Discord community.** Eligibility is assessed on "legal entities". Whether telemetry is required under the OIG is also *unverified*.
- **Directus custom item permissions on Core.** Whether "custom access policies" (which the OIG unlocks) gate the item-level filter permissions on Core is *unverified*.
- **Contentful pricing.** The page was blocked, so the figures come from search snippets.
- **PocketBase dashboard access.** The docs do not state outright that the dashboard is superuser-only.

**Not checked**

- Full-text search for Strapi, StudioCMS and Payload. Payload has a `plugin-search` package.
- Markdown editing for Strapi, Keystone and Cockpit.
- bknd and Lucid CMS beyond their READMEs.

**Tooling notes**

- The GitHub MCP server failed to connect, so the `gh` CLI was used.
- Playwright failed to navigate, so the Contentful page could not be rendered.
