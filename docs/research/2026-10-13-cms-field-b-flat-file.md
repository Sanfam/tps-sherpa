# CMS field survey, part B: self-hosted flat-file CMSs and Wiki.js

> **Survey brief, not the selection rules.** This survey applied its own brief's criteria, written before or alongside ADR-0001. ADR-0001's CMS criteria (no GitHub accounts for editors, attributed revisions with single-document rollback, storage on the site's volume or Railway Postgres) are applied in `2026-10-13-cms-and-datastore-options.md`, which is authoritative for ADR-0002. A "pass" here is not a pass there.

Research note, 2026-10-13. Facts only, with no recommendation. Scope: self-hosted flat-file CMSs that could act as a back-office editor committing files into the Astro repo, plus Wiki.js. Keystatic, Decap, Sveltia, PagesCMS, CloudCannon and other git-based SaaS or JS CMSs are excluded (part A). Reader gating is not evaluated.

Constraints, as briefed: **H1** coexists with Astro and does not replace delivery; **H2** content lands in our git repo as md, mdx, json or yaml files, committed by the CMS, with no DB as source of truth; **H3** no database *service*, a rebuildable local file is OK; **H4** about 5 editors without GitHub accounts; **H5** whole project under about $30/month, with no seat cap below about 8.

**Sources and conventions**

- Every claim was checked against the linked primary source on 2026-10-13 *(verified 2026-10-13)* unless it is marked *unverified* or *inference*.
- `SD/…` means statamic/docs, branch `6.x`, SHA `65ec7a039fbd3f03b828f46b0df4b28bac5e7284` (2026-10-08). Paths are relative to `content/collections/`. Links use `https://github.com/statamic/docs/blob/65ec7a0/content/collections/…`.
- `SC/…` means statamic/cms at tag `v6.35.1`, SHA `a5330b015b87e3a37e8d0aefa176707e1b666581`.
- `GS/…` means trilbymedia/grav-plugin-git-sync at `4714066` (v3.4.13). `GL/…` means getgrav/grav-learn at `0d68590`.
- `K/…` means getkirby/kirby at tag `5.6.1` (`93e40c1`).
- `TM/…` means typemill/typemill at `v2.27.0` (`dc64495`); `TG/…` means typemill-resources/gitsync at `9b000cc`.
- `W2/…` means requarks/wiki-v2 at `ac6977d` (v2.5.316); `W3/…` means requarks/wiki branch `scarlett` at `c626e28` (3.0.0-beta.661); `WD/…` means requarks/wiki-docs at `a73cfe4`.
- Our layout for H2 comparisons comes from `ASTRO-ARCHITECTURE.md` L248-307: `content/clubs/*.md`, `content/index/data.json`, `content/config/*.json`, `content/landing.md`, `content/privacy.md`.

---

## 1. Summary

| Candidate | On-disk content format | Git commit/push | Editor auth (Discord?) | DB needed | Runtime, footprint | Cost for ~5 editors; licence | Per-editor scoping | Latest release (date) | H1-H5 |
|---|---|---|---|---|---|---|---|---|---|
| **Statamic 6 Pro** | `content/collections/{c}/{slug}.md`: YAML front matter (with `id` UUID) plus body. Bard fields are stored as ProseMirror structure, not markdown. | Built in (Pro only). Auto-commits on save; pushes by default. Can target an external repo by absolute path. | Local file users. Discord via Laravel Socialite + SocialiteProviders/Discord (Pro only). No guild check. | No. Flat files; Stache index lives in Laravel cache. The skeleton still sets `DB_CONNECTION=sqlite`. | PHP 8.3+, Laravel 12-13, Composer, web server | **$349 one-time per site** (1 yr updates), then $99/yr optional. Core is free but limited to 1 user. Proprietary licence. | Per-collection role permissions, plus "own vs other authors' entries" when the blueprint has an `author` field | v6.35.1 (2026-10-06) | H1 ✓ H2 ✓ (caveats) H3 ✓ H4 ✓ H5 ✓ only if the $349 one-time fee is allowed |
| **Grav 2 + Admin2/API + Git Sync** | Folder per page under `pages/`, numeric-prefixed (`01.home/`), file `default.md` (or `<template>.md`): YAML front matter plus markdown | Git Sync plugin: bidirectional, GitHub/GitLab/Bitbucket over SSH or token, webhook pull. Repo root is `user/`, so pages sit at `<repo>/pages/…`. | Local YAML accounts. Discord via login-oauth2 + login-oauth2-extras. No guild check. | No | PHP 8.3.11+, web server; APCu/Redis recommended | Free, MIT (core, Admin2, API, Git Sync is Apache-2.0). Optional Editor Pro $75 one-time. | Per-page Page Groups plus a special `authors` group (Page Authors list), inherited; enforced per page in the API | Grav 2.2.8 (2026-10-13); Git Sync 3.4.13 (2026-09-18) | H1 ✓ H2 ✓ (layout caveat) H3 ✓ H4 ✓ H5 ✓ |
| **Kirby 5 + kirby-git-content** | `{template}.txt`: `Field: value` blocks separated by `----`. Not md/yaml/json. | Plugin commits by default; push is off by default (cron endpoint instead) | Local users (`index.php` + `.htpasswd`). Discord via kirby-oauth + an unmaintained 2022 provider. | No | PHP 8.2-8.5, web server | €99 one-time per site (3 yrs updates; €59 renewal). No seat limit. Proprietary. | Per role only; no per-user or ownership scoping without custom hooks | 5.6.1 (2026-10-06); plugin v5.5.0 (2026-10-04) | H1 ✓ **H2 ✗ (format)** H3 ✓ H4 ✓ H5 ✓ |
| **Typemill 2 + GitSync** | `content/NN-folder/NN-page.md` (no front matter) plus a sidecar `NN-page.yaml` for metadata | GitSync plugin (Business licence): GitHub/GitLab API with a PAT; pull and push; source subfolder supported. **Syncs only `.md` files**, so the YAML sidecars are not committed. Auto-sync runs only on frontend requests. | Local YAML users. No OAuth or Discord; LDAP on Business only. | No | PHP, web server (version not checked) | Core MIT, free. GitSync needs Business: €122 + VAT per year per instance. | `contributor` role edits only its own pages (`meta.owner`) | v2.27.0 (2026-09-20); GitSync v1.0.0 (Aug 2026) | H1 ✓ **H2 partial** H3 ✓ H4 ✓ (no Discord) H5 ✓ |
| **Bludit 3** | `bl-content/pages/<key>/index.txt`; metadata and users in PHP-wrapped JSON (`databases/*.php`) | None | Local only | No | PHP | Free, MIT | `author` role edits only its own pages | 3.22.0 (2026-05-11) | **H2 ✗** |
| **An Otter Wiki** | Markdown files in its own git repo | Native: every save is a commit; remote push and pull configurable | Local accounts or header auth (proxy). No native Discord. | Users and settings in SQLAlchemy SQL; default `sqlite:///:memory:` | Python (Flask) | Free, MIT | None: global READ/WRITE access levels only | v2.25.2 (2026-10-11) | H1 ✓ **H2 ?** (dedicated repo; subfolder unverified) H3 ✓ H4 ✓ (no Discord) H5 ✓ |
| **DokuWiki + gitbacked** | DokuWiki-syntax `.txt` | Plugin commits pages to git and syncs | Local or auth plugins (not checked) | No | PHP | Free, GPL-2.0 | Namespace ACLs (*unverified* today) | gitbacked 2026-09-22 | **H2 ✗ (format)** |
| **Wiki.js 2.x** | DB is the source of truth. Git target writes `{path}.md` with unquoted front matter, `.html` for visual-editor pages, `.json` for JSON pages. | Git storage module: sync (pull --rebase, then push), pull, or push (`--force`) every 5 min. **Repo must be dedicated; no subfolder.** | Local plus many strategies. Discord with **guild restriction** built in. | Yes. Postgres, MySQL, MariaDB, MSSQL or SQLite; SQLite "not recommended for production" and holds users, groups and config. | Node; 1GB RAM, ~70MB process, 2 cores recommended | Free, AGPL-3.0 | Group page rules (Allow/Deny by path START/EXACT/END/REGEX or TAG) | v2.5.316 (2026-10-02) | H1 ✓ **H2 ✗ H3 ✗** H4 ✓ H5 ✓ |
| **Wiki.js 3.0 beta** | DB is the source of truth. Git target writes `.md`/`.adoc`/`.json` with js-yaml front matter. | sync, push (force) or pull. Layout is repo root plus optional site-ID and locale prefixes; no arbitrary subfolder. | Discord with "Restrict to Server" and Discord-role-to-group mapping | **PostgreSQL 16+ required** | Node + Postgres | Free, AGPL-3.0 | Groups (page rules in 3.x not checked) | 3.0.0-beta.661 (2026-10-13), "Not for production use" | H1 ✓ **H2 ✗ H3 ✗** H4 ✓ H5 ✓ |

---

## 2. Candidates

### 2.1 Statamic *(verified 2026-10-13)*

**Release and support**

- Current major is 6. v6.35.1 is GitHub "Latest", 2026-10-06 ([release](https://github.com/statamic/cms/releases/tag/v6.35.1)). v6.0.0 shipped 2026-01-28.
- v5 is still patched: v5.74.6, 2026-10-08.
- Support policy: v5 bug fixes until Mar 2026 and security fixes until Dec 2026; v6 runs on Laravel 12-13 and PHP 8.3-8.5, with bug fixes until Mar 2027 and security fixes until Dec 2027; v7 is due Q1 2027 ([SD/pages/release-schedule-support-policy.md](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/release-schedule-support-policy.md)).

**Licensing and price**

- There is **no Solo edition any more**. The pricing page lists Core (free), Pro and Enterprise ([statamic.com/pricing](https://statamic.com/pricing)).
- Core: free, one (super admin) user account, one form.
- Pro: "$349USD per-site", one year of updates, then "$99 USD per-year for updates after that". Free in development (Trial Mode). 20% non-profit discount. "Unlimited user accounts & roles".
- Enterprise: unpriced.
- Pro-only features include Roles & Permissions, Revisions, the REST/GraphQL APIs, multi-user editing, white label, and **Git integration and automation** ([SD/pages/licensing.md L7-21](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/licensing.md#L7-L21)).
- The docs say "Statamic Core is free and open source", but `statamic/cms` LICENSE.md on 6.x is a proprietary custom licence (one licence per project; do not alter licensing features). GitHub reports it as NOASSERTION ([SC/LICENSE.md](https://github.com/statamic/cms/blob/a5330b0/LICENSE.md)).
- Licence validation phones home hourly while users are logged into the Control Panel. Trial Mode applies on localhost, IPs, non-80/443 ports, dev subdomains and dev TLDs ([SD/pages/licensing.md L93](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/licensing.md#L93)).

**Headless, CP-only use**

- Setting `'enabled' => false` in `config/statamic/routes.php` disables all frontend routes "if you're using Statamic as a headless CMS" ([SD/pages/routing.md L123-131](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/routing.md#L123-L131)).
- Statamic can also be installed into an existing Laravel app ([SD/pages/laravel.md](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/laravel.md)).

**Entry format**

- "Entries are stored as Markdown files inside their collection's respective directory (`content/collections/{collection}/entry.md`)" ([SD/pages/collections.md L44](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/collections.md#L44)). The front matter is YAML and includes an `id` UUID.
- The collection config is `content/collections/{name}.yaml`. The filename is the slug, or the id when slugs are disabled ([L166](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/collections.md#L166)).
- Stache store directories are configurable ([SD/pages/stache.md L133-146](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/stache.md#L133-L146)).
- "Bard stores your data as a ProseMirror document" ([SD/fieldtypes/bard.md L180](https://github.com/statamic/docs/blob/65ec7a0/content/collections/fieldtypes/bard.md#L180)). Bard is the WYSIWYG editor (TipTap). Its content is a structured node tree in front matter, not a markdown body.
- The Markdown fieldtype is a markdown editor with a toolbar and HTML preview ([SD/fieldtypes/markdown.md](https://github.com/statamic/docs/blob/65ec7a0/content/collections/fieldtypes/markdown.md)).

**Git automation** (Pro; front matter `pro: true`, [SD/pages/git-automation.md L6](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/git-automation.md#L6))

- Enabled with `STATAMIC_GIT_ENABLED=true` in `config/statamic/git.php`. By default it commits automatically on content Saved/Deleted events. Other controls: `STATAMIC_GIT_AUTOMATIC`, `php please git:commit` and scheduled commits.
- Push defaults to on: `'push' => env('STATAMIC_GIT_PUSH', true)`. It assumes an upstream remote and SSH auth ([L101](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/git-automation.md#L101)).
- Commits use the authenticated CP user's name and email by default (`use_authenticated`, [L37-40](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/git-automation.md#L37-L40)). Fallbacks: `STATAMIC_GIT_USER_NAME` and `_EMAIL`.
- Default tracked paths include content, **`users`**, blueprints, fieldsets, forms, `storage/forms` and `public/assets` ([L57-62](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/git-automation.md#L57-L62)). With defaults, user YAML files are committed.
- "You may also reference absolute paths to external repositories! … changes will be staged and committed relative to your external repository" ([L71](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/git-automation.md#L71)).
- The queue defaults to `sync`, so the commit runs inside the web request. `STATAMIC_GIT_QUEUE_CONNECTION` and `STATAMIC_GIT_DISPATCH_DELAY` change that.
- The docs show prefixing commit messages with `[BOT]` to skip deploys ([L201-211](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/git-automation.md#L201-L211)).

**Users, roles, OAuth**

- "users are stored in files by default"; database storage is optional ([SD/pages/users.md L113-115](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/users.md#L113-L115)).
- Permissions (Pro): per collection `view/edit/create/delete/publish/reorder {collection} entries`, plus `edit/publish/delete other authors {collection} entries` ([SD/pages/permissions.md L41-43](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/permissions.md#L41-L43)). Author scoping "only has any effect if your entry blueprint has an `author` field" ([L89](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/permissions.md#L89)).
- OAuth (Pro) uses Laravel Socialite, enabled by `STATAMIC_OAUTH_ENABLED`. Options include `create_user`, `merge_user_data`, `unauthorized_redirect`, and `withUser`/`withUserData` callbacks ([SD/pages/oauth.md](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/oauth.md)).
- SocialiteProviders/Discord: not archived, last pushed 2026-02-21, latest tag v2.0.2, scopes `identify` and `email`. It has no guild check ([repo @740a6dc](https://github.com/SocialiteProviders/Discord/tree/740a6dc)).

**Runtime**

- PHP 8.3+ with BCMath, Ctype, Exif, JSON, Mbstring, OpenSSL, PDO, Tokenizer, XML, GD or ImageMagick, and Composer ([SD/pages/requirements.md](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/requirements.md)).
- The skeleton `.env.example` sets `DB_CONNECTION=sqlite`, `SESSION_DRIVER=file`, `CACHE_STORE=file`, `QUEUE_CONNECTION=sync`, `STATAMIC_PRO_ENABLED=false` and `STATAMIC_GIT_ENABLED=false` ([statamic/statamic @83d1acd .env.example](https://github.com/statamic/statamic/blob/83d1acd/.env.example)).
- Full-text search uses the `local` driver by default ([SD/pages/search.md](https://github.com/statamic/docs/blob/65ec7a0/content/collections/pages/search.md)).

**H2 notes**

- Club pages fit as a collection of `.md` files.
- `content/index/data.json` (one JSON file holding the Catalog) and `content/config/*.json` are not Statamic entry formats. Statamic writes YAML for globals and data *(inference from the docs; JSON editing not checked)*.

### 2.2 Grav *(verified 2026-10-13)*

**Release, licence, runtime**

- Grav 2.2.8 was released 2026-10-13 ([release](https://github.com/getgrav/grav/releases/tag/2.2.8), `65d83f7`). MIT; the default branch is `develop`.
- 2.0.0 shipped 2026-06-21. 1.7.53.5 (2026-10-05) shows 1.7 is still maintained.
- Grav 2 needs PHP 8.3.11+ and a web server, with "no database needed". APCu, Memcached or Redis is recommended ([GL/pages/2/01.basics/02.requirements](https://github.com/getgrav/grav-learn/tree/0d68590/pages/2/01.basics/02.requirements)).

**Admin and headless**

- Classic admin: grav-plugin-admin 1.10.60 (2026-09-28).
- Admin2: grav-plugin-admin2 2.1.31 (2026-10-13, `39dbb81`), MIT. It is a SvelteKit SPA that talks only to grav-plugin-api, and uses the `api.*` permission namespace ([repo](https://github.com/getgrav/grav-plugin-admin2/tree/39dbb81)).
- grav-plugin-api 1.0.48 (2026-10-13, `8f5e79e`) is a full headless REST API with API-key, JWT and session auth ([GL/pages/2/07.api](https://github.com/getgrav/grav-learn/tree/0d68590/pages/2/07.api)).
- Editor Pro, a TipTap WYSIWYM editor, costs $75 one-time per site with indefinite updates. YetiSearch Pro costs $75 and Revisions Pro $50 ([getgrav.org/premium](https://getgrav.org/premium)).

**Page format**

- Each page is a folder under `user/pages`, with numeric prefixes for ordering (`01.home`). The file is `<template>.md`, typically `default.md`, in "Markdown with YAML FrontMatter". `_modules` folders are non-routable ([GL/pages/17/02.content/01.content-pages](https://github.com/getgrav/grav-learn/tree/0d68590/pages/17/02.content/01.content-pages)).

**Git Sync** (trilbymedia/grav-plugin-git-sync 3.4.13, 2026-09-18, Apache-2.0)

- It is actively maintained, with recent security fixes, and the CHANGELOG adds Admin2 support ([GS/CHANGELOG.md](https://github.com/trilbymedia/grav-plugin-git-sync/blob/4714066/CHANGELOG.md)).
- It syncs both ways with GitHub, GitLab or Bitbucket over SSH or a token, and pulls via webhooks.
- The committer can be the Git user, a configured name, or the Grav username or full name.
- Config is `folders: [pages]`. "The repository root is `user/` …, and sparse-checkout is what narrows the working tree down to the configured folders" ([GS/classes/GitSync.php L352](https://github.com/trilbymedia/grav-plugin-git-sync/blob/4714066/classes/GitSync.php#L352)). Folders are top-level names only ([L261](https://github.com/trilbymedia/grav-plugin-git-sync/blob/4714066/classes/GitSync.php#L261)). Root folders it does not manage (for example `docs`, `.github`) are left alone.
- The result is that pages land at `<repo>/pages/NN.slug/default.md`, not at `content/clubs/*.md`.

**Accounts, permissions, OAuth**

- Accounts are YAML files in `user/accounts`. Groups are in `user/config/groups.yaml`.
- Page permissions: `admin.pages.*` CRUD, plus per-page Page Groups. The special `authors` group matches "if the user is listed in `Page Authors`". Permissions inherit to child pages ([GL/pages/17/05.admin-panel/03.page/06.permissions](https://github.com/getgrav/grav-learn/tree/0d68590/pages/17/05.admin-panel/03.page/06.permissions)).
- The API PagesController calls `authorizePageAction(...)` per page for read, create, update and delete ([grav-plugin-api @8f5e79e classes/Api/Controllers/PagesController.php L243-1502](https://github.com/getgrav/grav-plugin-api/blob/8f5e79e/classes/Api/Controllers/PagesController.php#L243-L1502)).
- trilbymedia/grav-plugin-login-oauth2 2.2.8 (2026-08-13), MIT, has the options `require_grav_user`, `save_grav_user` and `default_groups` ([repo @5a9bb90](https://github.com/trilbymedia/grav-plugin-login-oauth2/tree/5a9bb90)).
- trilbymedia/grav-plugin-login-oauth2-extras 2.2.3 (2026-09-09, `a4f6b51`) ships a **Discord** provider with scopes `identify` and `email`, plus an `admin:` section. It requires login-oauth2 2.2.8 or later ([repo](https://github.com/trilbymedia/grav-plugin-login-oauth2-extras/tree/a4f6b51)).
- Admin2 OAuth login was fixed in August 2026: admin2#75 closed 2026-06-27, oauth2#52 closed 2026-08-17, and extras v2.2.2 "Fixed … extra providers never showing up on the new admin's login screen".
- There is no guild restriction.

### 2.3 Kirby *(verified 2026-10-13)*

- Release: 5.6.1 on 2026-10-06 (`93e40c1`); 4.9.6 is still patched. The licence is proprietary (NOASSERTION). PHP ~8.2 to 8.5.
- Pricing: Basic is €99 per site (for revenue or funding under €1M) and Enterprise €349. Each includes 3 years of updates; renewal is €59 or €249. There are no seat limits, and non-profits can apply for a free licence or a discount ([getkirby.com/buy](https://getkirby.com/buy)).
- Content format: `Field: value` blocks separated by `----`, in `{intendedTemplate}.txt` ([K/src/Content/PlainTextStorage.php L80-82](https://github.com/getkirby/kirby/blob/93e40c1/src/Content/PlainTextStorage.php#L80-L82)). Roots: `content` under index, and `site/accounts` for users ([K/src/Cms/Core.php L353, L357](https://github.com/getkirby/kirby/blob/93e40c1/src/Cms/Core.php#L353-L357)). Users are stored as `index.php` plus `.htpasswd` ([K/src/Cms/User.php L505, L820](https://github.com/getkirby/kirby/blob/93e40c1/src/Cms/User.php#L505)).
- Permissions are set per role in `site/blueprints/users/*.yml`, plus per-role options in page blueprints. There is no per-user or ownership scoping; that needs custom `before` hooks ([getkirby.com/docs/guide/users/permissions](https://getkirby.com/docs/guide/users/permissions)).
- Headless: KQL 3.0.0 (2025-07-03, MIT) accepts POST `/api/query` and requires authentication ([getkirby/kql](https://github.com/getkirby/kql)).
- thathoff/kirby-git-content v5.5.0 (2026-10-04, `25e746d`), MIT ([repo](https://github.com/thathoff/kirby-git-content/tree/25e746d)):
  - Supports Kirby 3.6-5 and needs git newer than 2.24.
  - `commit` defaults to true and `push` to false; pushing goes through a cron hitting `/git-content/push`.
  - `path` defaults to the content root, and the README recommends keeping `content/` in its own repository.
  - Kirby 5 needs `_changes` in `.gitignore`.
- thathoff/kirby-oauth v3.6.0 (2026-10-04, `af52d95`), MIT ([repo](https://github.com/thathoff/kirby-oauth/tree/af52d95)):
  - Works with any PHP League provider. For Discord that is wohali/oauth2-discord-new 1.2.1 (2022-12-29, last pushed 2024-06-30).
  - Options: `onlyExistingUsers`, `defaultRole`, `domainWhitelist`, `allowEveryone`.

### 2.4 Typemill, Bludit, and other flat-file options *(verified 2026-10-13)*

**Typemill**

- v2.27.0 (2026-09-20), MIT core ([TM](https://github.com/typemill/typemill/tree/dc64495)).
- Content is `content/NN-folder/NN-page.md` plus a sidecar `NN-page.yaml` holding metadata (title, owner). The markdown has no front matter.
- Editing: a visual block editor plus a raw markdown editor.
- Users are `settings/users/{username}.yaml` ([TM/system/typemill/Models/User.php L23-35](https://github.com/typemill/typemill/blob/dc64495/system/typemill/Models/User.php#L23-L35)).
- Roles (`settings/permissions.yaml`): `contributor` has CRUD on `mycontent` only; `author` can read and create `content`; `editor` can update, delete and publish; `manager` sits above. Ownership is `meta.owner` ([TM Models/Meta.php L111-151](https://github.com/typemill/typemill/blob/dc64495/system/typemill/Models/Meta.php#L111-L151)).
- GitSync plugin v1.0.0 (`license: BUSINESS`), announced 2026-08-17 for Typemill 2.26.0 ([TG](https://github.com/typemill-resources/gitsync/tree/9b000cc)):
  - Uses the GitHub or GitLab API with a PAT; pulls and pushes, with "Source Path in Repo" (subfolder) and "Local Folder" settings.
  - Auto-sync runs only during frontend page requests. It does not merge; conflicts block sync.
  - **It syncs only `.md`/`.markdown` files** (`isSyncableFile` [L1148-1150](https://github.com/typemill-resources/gitsync/blob/9b000cc/gitsync.php#L1148-L1150); `scanLocalMdFiles`), so the `.yaml` sidecars stay local.
- Pricing: Business costs €122 + VAT per year, auto-renewing, for one instance; Maker costs €22 per year ([typemill.net/license](https://typemill.net/license)).
- No OAuth or Discord; LDAP is Business-only.

**Bludit**

- 3.22.0 (2026-05-11, `c573a99`), MIT.
- Page content is `bl-content/pages/<key>/index.txt` ([bl-kernel/boot/variables.php L46](https://github.com/bludit/bludit/blob/c573a99/bl-kernel/boot/variables.php#L46)). Page metadata and users live in `databases/pages.php` and `databases/users.php` (`init.php` L65, L70).
- The author role is limited to its own pages (`edit-content.php` L7-20).
- No git sync.

**An Otter Wiki**

- v2.25.2 (2026-10-11, `96a3167`), MIT, Python ([redimp/otterwiki](https://github.com/redimp/otterwiki/tree/96a3167)).
- Pages are markdown in a git repo, with remote push and pull (`GIT_REMOTE_PUSH_ENABLED`, under Settings > Repository Management).
- Users live in SQLAlchemy; the default is `sqlite:///:memory:`.
- Access levels are global (`READ_ACCESS`/`WRITE_ACCESS`), with no per-page rules ([otterwiki/server.py L36-76](https://github.com/redimp/otterwiki/blob/96a3167/otterwiki/server.py#L36-L76)).
- Auth is local or header-based.

**DokuWiki + gitbacked**

- woolfg/dokuwiki-plugin-gitbacked 2026-09-22 (`c6d6bf6`), GPL-2.0. It stores and syncs pages in git.
- Content stays in DokuWiki-syntax `.txt`.

**WonderCMS** was not assessed because its README could not be fetched.

### 2.5 Wiki.js *(verified 2026-10-13)*

**Status**

- 2.x releases moved to requarks/wiki-v2. v2.5.316 shipped 2026-10-02 (`ac6977d`). v2.5.315 (2026-09-21) was "the last 2.x release posted in this repository" (requarks/wiki) and carried security fixes. AGPL-3.0.
- 3.x is at 3.0.0-beta.661 (2026-10-13, `scarlett@c626e28`), labelled "**3.x Beta Release - Not for production use**".
- GitHub has marked betas as non-prerelease since beta.617 (2026-10-02); beta.605 (2026-09-25) was still flagged prerelease.
- The 3.x `config.sample.yml` requires "PostgreSQL 16 or later".

**2.x database**

- Supported engines: postgres, mysql, mariadb, mssql, sqlite ([W2/config.sample.yml L17-21, L49-50](https://github.com/requarks/wiki-v2/blob/ac6977d/config.sample.yml#L17-L21)).
- The docs say the non-Postgres engines "will NOT be supported in the next major version", and "SQLite is **not recommended** for production deployments" ([WD/install/requirements.md L61-63](https://github.com/requarks/wiki-docs/blob/a73cfe4/install/requirements.md#L61-L63)).
- Recommended resources: 1GB RAM (about 70MB process memory), 2 cores.
- The DB holds pages, users, groups and config. Git storage is a mirror target, not the source of truth.

**2.x git storage**

- Props: `authType` (ssh or basic), `repoUrl`, `branch`, SSH key, basic username and password (PAT), default author email and name, `localRepoPath`, `alwaysNamespace`, `gitBinaryPath`. It runs every `PT5M` ([W2/server/modules/storage/git/definition.yml](https://github.com/requarks/wiki-v2/blob/ac6977d/server/modules/storage/git/definition.yml)).
- Modes: sync (pull --rebase, then push), pull, and push with `--force` ([W2/server/modules/storage/git/storage.js L120-138](https://github.com/requarks/wiki-v2/blob/ac6977d/server/modules/storage/git/storage.js#L120-L138)). The filename is `${page.path}.${ext}`.
- Format ([W2/server/helpers/page.js L77-99](https://github.com/requarks/wiki-v2/blob/ac6977d/server/helpers/page.js#L77-L99)):
  - Markdown pages get `---` front matter with `title`, `description`, `published`, `date`, `tags: a, b`, `editor`, `dateCreated`, **written unquoted** by string concatenation.
  - Visual-editor pages are `.html` with an `<!-- … -->` metadata block.
  - JSON pages carry a `_meta` object.
- "A Git repository must be dedicated to Wiki.js. It is not possible to use only a subfolder or submodules at the moment" ([WD/storage/git.md L22](https://github.com/requarks/wiki-docs/blob/a73cfe4/storage/git.md#L22)).

**3.x git storage**

- syncMode is sync, push (force) or pull. An empty `repoUrl` means a local-only repo. There is an `alwaysUseDefaultAuthor` option ([W3/backend/modules/storage/git/definition.yml](https://github.com/requarks/wiki/blob/c626e28/backend/modules/storage/git/definition.yml)).
- Layout: repo root plus an optional site-ID prefix and an optional locale prefix ([W3/backend/models/storage.ts L344-364, L1233-1240](https://github.com/requarks/wiki/blob/c626e28/backend/models/storage.ts#L344-L364)). No arbitrary subfolder.
- Front matter is written with js-yaml; files are `.md`, `.adoc` or `.json` ([W3/backend/helpers/storageFiles.ts](https://github.com/requarks/wiki/blob/c626e28/backend/helpers/storageFiles.ts)).

**Discord auth**

- 2.x: `guildId` ("Server ID – Optional … only members are authorized"), scope `identify email guilds`, with the guild check in [W2/server/modules/authentication/discord/authentication.js L18-22](https://github.com/requarks/wiki-v2/blob/ac6977d/server/modules/authentication/discord/authentication.js#L18-L22).
- 3.x adds "Restrict to Server" (`serverId`); "Map Groups", which turns Discord roles into wiki groups on every login; an optional Bot Token for matching by role name; and "Unassign from groups no longer held on the server" ([W3/backend/modules/authentication/discord/definition.yml](https://github.com/requarks/wiki/blob/c626e28/backend/modules/authentication/discord/definition.yml)).
- The 3.x auth modules are discord, entra, github, google, ldap, local, oidc and saml.

**Permissions (2.x)**

- Groups carry global permissions plus page rules: Allow or Deny, matched by START, EXACT, END, REGEX or TAG. "Rules are applied in order of path specificity" ([WD/groups.md](https://github.com/requarks/wiki-docs/blob/a73cfe4/groups.md); [W2/server/core/auth.js L221-281](https://github.com/requarks/wiki-v2/blob/ac6977d/server/core/auth.js#L221-L281)).

---

## 3. Open or unverifiable

1. **Railway footprint.** No candidate's memory or CPU use was measured. The only vendor figure is Wiki.js 2.x (1GB RAM recommended, ~70MB process).
2. **Statamic in a monorepo.** The docs allow an external repo by absolute path, but whether git automation can be confined to `content/` inside our repo checkout (committing only that subfolder) is untested.
3. **Statamic without a DB.** Statamic content and users are files, but the Laravel skeleton defaults to `DB_CONNECTION=sqlite`. Whether anything writes to it with file sessions, cache and queue is unverified.
4. **Statamic licence on a Railway domain.** Whether a back office reachable only on `*.up.railway.app` counts as Trial Mode is not stated (that domain is not on the docs' list). The docs' "free and open source" claim conflicts with the proprietary LICENSE.md.
5. **Statamic JSON.** Editing a single JSON file such as `content/index/data.json` was not checked; globals and data are YAML.
6. **Discord guild restriction** in Statamic, Grav and Kirby is not built in. It would need custom code (`withUser` callbacks, `require_grav_user`, or `onlyExistingUsers` with pre-provisioned accounts) *(inference)*.
7. **Grav Git Sync layout.** It is unverified whether `local_repository` or nested folder entries can map pages to `content/clubs/` rather than `<repo>/pages/`. The code comment says top-level granularity. Numeric-prefix folders and `default.md` filenames would also need a custom Astro loader *(inference)*.
8. **Grav search.** Full-text search via SimpleSearch or TNTSearch was not verified; YetiSearch Pro ($75) was seen on the premium page only.
9. **Typemill.** Not verified: where drafts are stored, its PHP version, and whether page titles survive when only the `.md` file is synced (titles and owners sit in the unsynced `.yaml` sidecar).
10. **Otter Wiki.** Not verified: subfolder support within a shared repo, and whether its markdown carries front matter.
11. **kirby-git-content** with `path` pointed at a monorepo root: whether it commits only content files was not tested.
12. **Wiki.js 2.x unquoted front matter** is an inference from source: a title containing `: ` would produce invalid YAML for Astro's parser. Not tested.
13. **Wiki.js 3.x page rules** were not checked; only groups and Discord role mapping were.
14. **DokuWiki ACLs and auth plugins** were not checked today.
