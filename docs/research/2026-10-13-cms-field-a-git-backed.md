# CMS field, part A: git-backed editors without git-host accounts

> **Survey brief, not the selection rules.** This survey applied its own brief's criteria, written before or alongside ADR-0001. ADR-0001's CMS criteria (no GitHub accounts for editors, attributed revisions with single-document rollback, storage on the site's volume or Railway Postgres) are applied in `2026-10-13-cms-and-datastore-options.md`, which is authoritative for ADR-0002. A "pass" here is not a pass there.

Research note, 2026-10-13. Facts only, no recommendation. Reader gating is not evaluated.

## Sources and conventions

- **Repo clones.** Each path below is relative to its clone root and pinned to a SHA:
  - `K/` = Thinkmill/keystatic @ `b8ec9650622c11e1d38e73fca3b64c17ec278d18`
  - `D/` = decaporg/decap-cms @ `1d5868347d3d8648d7d5f7f59fc1b46595881b29` (2026-09-22)
  - `P/` = pages-cms/pages-cms @ `6f4e860a35d934406580287e7042e5e111e207a1` (2026-06-08)
- **Tag references.**
  - Forgejo uses tag `v16.0.6`.
  - Gitea uses tag `v28.1.0`.
  - Both are cited as `services/auth/source/oauth2/providers_simple.go`.
- **Other evidence.** Releases, licences and commit dates come from the GitHub API through `gh`. npm dates come from `npm view <pkg> time`.
- *(verified 2026-10-13)* means I fetched or read the source today.
- **"Unverified"** means only a secondary source exists, or the claim is my own inference. Each such claim is marked inline.
- **Hard constraints**, as defined in the brief:

  | Code | Constraint |
  |---|---|
  | H1 | Coexists with the Astro app |
  | H2 | Content is committed to our repo as files |
  | H3 | No database service |
  | H4 | About 5 editors, none of whom needs a git-host account |
  | H5 | Under about $30/month in total, with no seat cap below about 8 |

- **The 08-31 label.** `ASTRO-ARCHITECTURE.md` L280 calls Keystatic, Decap, Sveltia and PagesCMS "git-host-OAuth-only". That label is checked per candidate below.

## 1. Summary table

| Candidate | Content storage | Editor auth (git-host acct needed?) | Shape | DB needed (by us) | Cost ~5 editors + licence | Per-editor scoping | Latest release + date | H1-H5 |
|---|---|---|---|---|---|---|---|---|
| **Keystatic Cloud** | Our GitHub repo; files committed through the `api.keystatic.cloud` GitHub proxy | **No.** Email+password, passkey, or GitHub | Back-office admin route in the Astro app (`@keystatic/astro`) + SaaS auth/proxy | No | Free ≤3 users/team. Pro $10/mo + $5/user beyond 3: **$20/mo at 5, $35/mo at 8**. MIT (client); Cloud is proprietary SaaS | None. Access is per team, and every team member sees every project | `@keystatic/core` 0.6.9 (2026-08-26); `@keystatic/astro` 6.0.0 (2026-08-18) | **Pass at 5.** H5 is over budget at 8 ($35/mo) but there is no seat cap. New vendor |
| **Decap + DecapBridge (hosted)** | Our GitHub/GitLab repo; files committed by the DecapBridge gateway using **our** PAT | **No.** Google, Microsoft, or email+password | Decap admin page (static, can sit in the Astro app) + SaaS auth/gateway | No | Free: 3 sites, **10 collaborators per site**. Pro $9/mo for unlimited. Decap is MIT; DecapBridge is source-available (custom licence) | None. Admin vs collaborator only (admin needs Pro) | Decap 3.16.3 (2026-09-22); decapbridge-gateway last commit 2026-08-26 | **Pass.** New vendor |
| **Decap + our own git-gateway-compatible endpoint** | Our repo, through our endpoint using the bot PAT | **No.** Whatever our JWT issuer does (Discord is possible) | Decap admin page + Astro API routes | No (inference) | $0 beyond hosting. MIT | Whatever we enforce in the proxy | n/a (to build) | **Passes on paper.** Untested, and it is code we would own |
| **Decap + self-hosted netlify/git-gateway** | Our repo, through git-gateway using a PAT | **No.** Any JWT issuer | Extra Go service + Decap admin | SQLite file (`gorm.db`) | Hosting only. MIT | Roles from JWT `app_metadata.roles` | No releases; last commit 2024-05-14 | **Passes on paper.** Stale upstream. Still needs a JWT issuer (GoTrue needs MySQL, so it fails H3) |
| **Netlify Identity + Git Gateway** | Repo connected to a Netlify site | No (Identity users) | Netlify-hosted | No | Identity is free on credit plans | Roles | Git Gateway is deprecated | **Fail in practice.** Deprecated, and it needs a Netlify site with a connected repo |
| **Sveltia (GitHub/GitLab)** | Our repo | **Yes.** OAuth or a token for the git host | Static admin page | No | Free. MIT | None | v0.237.0 (2026-10-13) | **Fail H4** |
| **PagesCMS (hosted app.pagescms.org)** | Our GitHub repo; written with the GitHub App installation token | **No** for collaborators (email OTP). The inviter needs GitHub | SaaS back-office | No | **Free.** MIT | Per repo only; "granular access control" is marked "Soon" | 2.1.8 (2026-06-08) | **Pass.** New vendor; the terms are "as is" |
| **PagesCMS (self-hosted)** | Same | Same | Self-hosted Next.js app | **PostgreSQL** | Hosting. MIT | Per repo | 2.1.8 | **Fail H3** |
| **Gitea/Forgejo reframe + Sveltia or Decap** | Our Gitea/Forgejo repo, push-mirrored to GitHub | No GitHub account needed. Editors get a local Gitea/Forgejo account, with **Discord OAuth2 login** built in | Extra self-hosted git server + static CMS admin | SQLite (built-in) | Hosting only. MIT (Gitea); GPL-3.0+ (Forgejo, unverified) | Repo-level write; branch protection | Gitea v28.1.0 (2026-10-06); Forgejo v16.0.6 (2026-10-12) | **Passes on paper.** The force-push mirror conflicts with bot commits to GitHub (inference) |
| **CloudCannon** | Our repo (GitHub/GitLab/Bitbucket sync) | No (CloudCannon accounts) | SaaS | No | Standard $55/mo ($49 yearly) for 3 users + $10/user: **$75/mo**. Proprietary | Default roles on Standard | n/a (SaaS) | **Fail H5** |
| **Spinal** | Our GitHub repo | No (Spinal accounts) | SaaS | No | $39/mo, 5 members + $4/member. Proprietary | Per content type (create/edit/publish) | n/a (SaaS) | **Fail H5** |
| **Netlify Visual Editor (Create/Stackbit)** | Repo | No | SaaS | No | n/a | n/a | Closed to new teams | **Fail.** Unavailable |
| **Contentrain Studio** | Our repo (`.contentrain/` JSON/MD) | No (Supabase-style auth) | Self-host Nuxt app or SaaS | **PostgreSQL** (self-host) | SaaS: Starter $9 (3 seats), Pro $49 (25 seats). AGPL-3.0 + proprietary `ee/` | Role-based | v0.4.8 (2026-10-08) | **Fail.** Self-host fails H3; SaaS Starter fails the seat cap; Pro fails H5 |
| **Outstatic PRO (hosted)** | Our GitHub repo | No (magic link, Google) | SaaS / Next.js | No | $9.99/user/mo: **~$50/mo**. Licence NOASSERTION | Team roles | v2.2.4 (2026-08-20) | **Fail H5** |
| **Outstatic (self-host)** | Our repo | **Yes** (GitHub login) | Next.js app | No | Free | — | v2.2.4 | **Fail H4** (and H1: a separate Next.js app) |
| **Nuxt Studio** | Repo | GitHub, GitLab, Google, or custom | Nuxt module | No | Free. MIT | Moderator email list | v1.7.0 (2026-04-28) | **Fail H1.** Nuxt Content only |
| **Mattrbld** | Repo | **Yes** | PWA | No | Free. AGPL | — | v1.5 (announced 2026-02-27) | **Fail H4** |
| **Front Matter CMS** | Local repo | **Yes** (VS Code + git push) | VS Code extension | No | Free. MIT | — | v10.13.0 (2026-10-12) | **Fail H4** (inference) |
| **Sitepins (cloud)** | Our GitHub/GitLab repo | No (email+password or Google) | SaaS | No | Team $29/mo, **capped at 5 users/org**; Agency $49, also 5 users. Proprietary SaaS / AGPL core | Owner, Admin, Editor; no per-file scoping | No GitHub releases; repo created 2026-07-15 | **Fail H5** (seat cap 5 < 8) |
| **Sitepins (self-host)** | Same | Same | Express app | **MongoDB replica set** | Free. AGPL-3.0 | Same | Same | **Fail H3** |
| **Zero (zerocms.io)** | Our GitHub repo (md/mdx/yaml/json) | No | SaaS, Astro-only | No | **No public pricing** (14-day trial). Licence unknown | Unknown | Private beta since late 2025; changelog latest 2026-09-14 | **Unverifiable.** Cost unknown |
| **GitCMS (gitcms.dev)** | Our repo, "no database needed" | No (invited editors can use Google login) | SaaS | No | $79/site one-time + $9 per extra teammate one-time. Included teammates not stated. Licence unknown | "Scoped access" (alpha 04) | v1.3.0 (2026-06-04) | **Likely pass,** pending details. New vendor |
| **StudioCMS** | Database | — | Astro integration | **libSQL, MySQL or PostgreSQL** | Free. MIT | — | — | **Fail H2/H3** |
| **Vault CMS** | Local Obsidian vault + git | **Yes** (git push) | Obsidian plugin set | No | Free. MIT | — | v1.3.9 (2026-06-04) | **Fail H4** (inference) |

## 2. Per-candidate notes

### 2.1 Keystatic Cloud

**The 08-31 label is wrong here.**

**Sign-in** *(verified 2026-10-13)*
- The `keystatic.cloud/signin` page offers "GitHub", "Passkey", and "Email" + "Password", with a "Forgot password?" link.
- `K/docs/src/content/pages/cloud.mdoc` L17 says Cloud lets "team members … edit content without needing a GitHub account."

**Access** *(verified 2026-10-13)*
- `K/…/cloud.mdoc` L21-23: teams contain projects, and each project is connected to a GitHub repo.
- The same lines say "User access is set at the team level, so every user in team will have access to all projects within that team." There is no per-path or per-collection scoping.

**Pricing** *(verified 2026-10-13)*
- `K/…/cloud.mdoc` L27-33:
  - The free tier allows up to 3 users per team.
  - "Keystatic Cloud Pro starts at $10/month. Adding beyond 3 users to a team costs $5/month per user."
  - Pro adds Cloud Images and experimental multiplayer editing (`wss://live.keystatic.cloud`).
- `keystatic.cloud/pricing` returned 404 and the root returned 500 today. The pricing figures therefore come only from the docs source.

**Data path** *(verified 2026-10-13)*
- Every repo read and write is proxied through Keystatic Cloud. Content stays as files in GitHub. Source locations:
  - `K/packages/keystatic/src/app/provider.tsx` L43: `${KEYSTATIC_CLOUD_API_URL}/v1/github/graphql`
  - `K/…/useItemData.ts` L352: `/v1/github/blob/${oid}`
  - `K/…/utils.ts` L182: `https://api.keystatic.cloud`
  - OAuth uses `/oauth/authorize` and `/oauth/token` (`cloud-auth-callback.tsx`).
- The admin UI runs inside our Astro app through `@keystatic/astro`.

**Releases and licence** *(verified 2026-10-13)*
- `@keystatic/core` 0.6.9 was published on npm on 2026-08-26.
- `@keystatic/astro` 6.0.0 was published on 2026-08-18.
- The repo is MIT, and its last commit was on 2026-10-01.

**Unverified**
- Whether the Keystatic GitHub App installs cleanly on a repo owned by a machine user (`tps-papabot`) or by the pending org.
- What commit author editors' commits get.

### 2.2 Decap via git-gateway

**The 08-31 label is wrong for Decap.** Decap's git-gateway backend takes any JWT identity.

**DecapBridge (hosted)**
- **Sign-in and roadmap** (`decapbridge.com`, `/docs/introduction`) *(verified 2026-10-13)*:
  - Editors are invited by email and "can choose to login with Google, Microsoft or set a password".
  - Discord login is listed under "Integrate Login with Apple, Okta, Auth0, Github, Gitlab and Discord", which is a **roadmap** item and not shipped.
- **Pricing** (homepage; `/pricing` returned 404) *(verified 2026-10-13)*:

  | Plan | Price | What it includes |
  |---|---|---|
  | Free | "Free forever" | "3 sites", "10 collaborators per site" |
  | Professional | $9/mo | Unlimited sites and collaborators, admin role, branding |
  | Lifetime Pro | $199 one-time | Includes a "White-label Self-Hosting Commercial License" |

- **Setup** (`/docs/getting-started`) *(verified 2026-10-13)*:
  - Supported git hosts: "Github, or Gitlab, which are the 2 git providers we support at the moment".
  - We supply a PAT with Contents read/write, plus Pull requests if we use the editorial workflow. "Both fine-grained and classic tokens work."
  - Auth types are "Classic" (password) or "PKCE". PKCE is needed for Google/Microsoft and requires Decap > 3.8.3.
  - Profile names appear on commits only "if you configure it so".
- **Architecture** (`/docs/architecture`) *(verified 2026-10-13)*:
  - decapbridge-web is the UI.
  - decapbridge-api runs at auth.decapbridge.com.
  - decapbridge-gateway runs at gateway.decapbridge.com and is a fork of netlify/git-gateway.
  - The operator is millisecond.studio (site footer).
- **Self-host** (`/docs/self-hosting`) *(verified 2026-10-13)*:
  - It runs a `postgres:16` container with `POSTGRES_DB=directus` plus 3 more containers on 3 subdomains, so **it fails H3**.
  - `DECAPBRIDGE_LICENSE_KEY` is required "in a commercial setting".
  - Open-source and non-profit projects can ask for a free key.
- **Licence and repos** *(verified 2026-10-13)*:
  - `/docs/source-available` describes a "custom source-available license": you may view and fork the code but may not rebrand it.
  - The three repos report licence NOASSERTION.
  - Last commits: gateway `51eda1f` and web `af4c780`, both on 2026-08-26.

**Our own gateway, built from the Decap source** *(verified 2026-10-13; the recipe is inference)*

`D/packages/decap-cms-backend-git-gateway/src/implementation.ts` shows what the backend expects:

| Lines | Behaviour |
|---|---|
| L179-180 | `identity_url` and `gateway_url` are configurable |
| L296-334 | Unless `gateway_url` ends in `/github`, `/gitlab` or `/bitbucket`, Decap GETs `${gateway_url}/settings` with a Bearer token and expects `{github_enabled, gitlab_enabled, bitbucket_enabled, roles}` |
| L338-343 | Roles are checked against the JWT's `app_metadata.roles` |
| L353 | `apiRoot = ${gatewayUrl}/${backendType}` |

- The commit author is the user's name and email.
- **PKCE sign-in:**
  - `auth_type: pkce` takes `base_url`, `app_id`, `auth_endpoint` and `auth_token_endpoint`, plus the claim names `email_claim`, `full_name_claim` and `avatar_url_claim` (`D/packages/decap-cms-ui-auth/src/PKCEAuthenticationPage.js` L92-118).
  - It uses S256 (`D/packages/decap-cms-lib-auth/src/pkce-oauth.js` L119-122).
- **Docs** (`decapcms.org/docs/git-gateway-backend/`) *(verified 2026-10-13)*:
  - "You can use Git Gateway without Netlify by setting up your own Git Gateway server … with any other identity service that can issue JSON Web Tokens (JWT)."
  - `status_endpoint` overrides the Netlify status check.
- **Inference, not tested.** Astro API routes could implement all of the following:
  - a PKCE authorize/token pair that sits on top of Discord OAuth and issues our own JWT;
  - `/settings`;
  - a `/github/*` proxy, limited to one repo and authenticated with the bot PAT.
- The surface to proxy is listed in the netlify/git-gateway README: `/repos/:owner/:name/{git,contents,pulls,branches,merges,statuses,compare,commits,issues/<n>/labels}`.

**netlify/git-gateway** *(verified 2026-10-13)*
- Written in Go, MIT, not archived. There are no releases, and the last commit is `740284b` (2024-05-14).
- `example.env` includes:
  - `GITGATEWAY_DB_DRIVER=sqlite3` with `DATABASE_URL=gorm.db`
  - `GITGATEWAY_GITHUB_ACCESS_TOKEN`
  - `GITGATEWAY_GITHUB_REPO`
  - `GITGATEWAY_ROLES`
  - `GITGATEWAY_JWT_SECRET`

**netlify/gotrue** *(verified 2026-10-13)*
- MIT. Last commit `aac5b57` (2026-05-28).
- The database "Must be `mysql`".
- External providers are bitbucket, github, gitlab and google. There is no Discord provider.

**Netlify Identity and Git Gateway** *(verified 2026-10-13)*
- **Identity is supported again.** The deprecation was reversed:
  - `netlify.com/blog/auth0-extension-identity-changes/`: "Update, February 19, 2026: Netlify Identity will continue as a supported authentication option on Netlify."
  - The Identity plans page lists unlimited active users on credit plans.
  - Identity's external providers are Google, GitHub, GitLab and Bitbucket. There is no Discord provider.
  - External JWT providers are Enterprise-only.
- **Git Gateway is deprecated.** `docs.netlify.com/manage/security/secure-access-to-sites/git-gateway/` says "Git Gateway is deprecated … new Git Gateway configurations are not recommended … will no longer fix bugs".
  - It requires Identity and a GitHub.com or GitLab.com repo connected to the Netlify site.

**Decap releases** *(verified 2026-10-13)*
- decap-cms@3.16.3 is marked Latest (2026-09-22).
- 3.17.0-beta.1 was released on 2026-09-14.
- MIT.

### 2.3 Sveltia CMS

**The 08-31 label is correct for GitHub and GitLab.**

**Backends** (`sveltiacms.app/en/docs/backends`) *(verified 2026-10-13)*
- Supported: GitHub, GitLab, Gitea/Forgejo, and Test.
- Git Gateway is **not** supported: "For performance reasons… Git Gateway has officially been deprecated by Netlify". Azure DevOps and Bitbucket are not supported either.
- `CMS.registerBackend` is a no-op.
- Editors sign in with OAuth or an access token for the git host.

**Roadmap** (`/docs/roadmap`) *(verified 2026-10-13)*
- v1.0 is "Expected in late 2026".
- The non-goals include "Enterprise features" and "Support for non-Git backends".

**Gitea/Forgejo backend** (`/docs/backends/gitea-forgejo`) *(verified 2026-10-13)*
- Sign-in uses a PKCE OAuth app ("Uncheck the Confidential option") or an access token.
- OAuth scopes: `read:repository`, `write:repository` and `read:user`.
- Requires "Gitea 1.24, Forgejo 12.0 or later". Self-hosted instances are configured with `base_url` and `api_root`.

**Releases** *(verified 2026-10-13)*

| Version | Date | Change |
|---|---|---|
| v0.231.0 | 2026-10-07 | Editorial workflow on Gitea/Forgejo |
| v0.233.0 | 2026-10-08 | `root_dir` monorepo support |
| v0.235.0 | 2026-10-11 | Gitea deploy previews |
| v0.237.0 | 2026-10-13 | Latest release |

- The licence is MIT.

### 2.4 PagesCMS (hosted)

**The 08-31 label is wrong here.**

**Hosted pricing** (`pagescms.org`) *(verified 2026-10-13)*
- "Pages CMS is 100% free, whether you want to use the online version…".
- "Invite users via email, no other account needed."
- "Granular access control" is marked "Soon".
- GitHub is the only supported git host.

**Collaborators** (`pagescms.org/docs/configuration/collaborators/`) *(verified 2026-10-13)*
- Collaborators are invited by email and need no GitHub account. Access is granted per repo.
- Collaborators cannot manage other collaborators or edit `.pages.yml`. Those actions are "limited to GitHub users with repository access".
- "Collaborators live in the database." That is PagesCMS's own hosted database, not ours.
- "Collaborator writes use the GitHub App installation token". Commits are attributed to the app by default, or to the editor with `settings.commit.identity: user`.

**Sign-in for collaborators** *(verified 2026-10-13)*
- Release 2.1.7 (2026-06-04) "Simplified collaborator invite sign-in with OTP verification".
- Release 2.1.8 (2026-06-08), the latest, is "Fix collaborator access…".

**Inviting needs a GitHub user** *(verified 2026-10-13)*
- `P/lib/actions/collaborator.ts` L41-51 calls `getInstallations(token,[owner])` through `listInstallationsForAuthenticatedUser`.
- The inviter therefore has to be a GitHub user who can see the app installation on the repo owner.

**Auth order** (`/docs/development/authentication/`) *(verified 2026-10-13)*
- The user token is tried first, then the collaborator record (matched on email + owner + repo), then the installation token.

**Terms** (`pagescms.org/terms`) *(verified 2026-10-13)*
- The service is provided "AS IS" and "AS AVAILABLE".
- Access can be terminated "for any reason whatsoever".
- Liability is capped at 100 USD, under Singapore law.
- The terms state no quotas.

**Self-host** *(verified 2026-10-13)*
- The README requires PostgreSQL and a GitHub App, so **self-hosting fails H3**.

**Repo** *(verified 2026-10-13)*
- MIT, 4,087 stars. The last commit is `6f4e860` (2026-06-08).

**Unverified:** an install on a repo owned by a machine user or an org, tested end to end.

### 2.5 Self-hosted Gitea or Forgejo

This reframe gives editors accounts on our own git host instead of GitHub.

**Discord login is built in** *(verified 2026-10-13)*
- Both Gitea and Forgejo register `discord` in `services/auth/source/oauth2/providers_simple.go`:
  - Forgejo, tag `v16.0.6`: L12 and L85, with scopes `identify` and `email`.
  - Gitea, tag `v28.1.0`: L85.
- `docs.gitea.com/usage/authentication` lists Discord among the built-in providers.
- `[oauth2_client] ENABLE_AUTO_REGISTRATION` auto-creates accounts on first login.
- **Unverified (inference):** restricting the Discord source to a guild or role is not documented. The documented "Required Claim" and group-claim options apply to OIDC sources.

**Push mirrors** *(verified 2026-10-13)*
- Gitea (`docs.gitea.com/usage/repo-mirror`):
  - The mirror authenticates with a PAT used as the password.
  - "Sync when new commits are pushed" is available from 1.18.
  - The docs warn "This will force push to the remote repository. This will overwrite any changes in the remote repository!"
- Forgejo (`forgejo.org/docs/latest/user/repo-mirror/`):
  - Mirrors use `git push --mirror` with no branch filter.
  - SSH mirrors use an Ed25519 key.
- **Inference:** `tps-papabot` currently commits straight to GitHub. A force-push mirror from Gitea/Forgejo would overwrite those commits, unless the bot commits to Gitea/Forgejo instead.

**Database** *(verified 2026-10-13)*
- Gitea lists "SQLite (builtin)" and warns "SQLite does not scale" (`docs.gitea.com/installation/database-prep`).
- Forgejo uses SQLite by default and calls it "good enough for at least 10 users" (`/docs/latest/admin/installation/binary/`).

**Footprint** *(verified 2026-10-13)*
- Gitea's system requirements say "2 CPU cores and 1GB RAM is typically sufficient for small teams/projects", and "A Raspberry Pi 3 is powerful enough… small workloads".
- Forgejo publishes no equivalent figures.

**Forgejo as an OAuth2 provider** *(verified 2026-10-13)*
- PKCE public clients are supported.
- "OAuth2 scopes are not yet implemented", so tokens carry the user's full rights.

**Releases** *(verified 2026-10-13)*
- Gitea v28.1.0 (2026-10-06), MIT.
- Forgejo v16.0.6 and v15.0.10, both 2026-10-12. The Forgejo licence was not re-checked today (*unverified*).

### 2.6 Commercial and other candidates

**CloudCannon** (`cloudcannon.com/pricing/`) *(verified 2026-10-13)*
- Plans:

  | Plan | Price | Users |
  |---|---|---|
  | Standard | $55/mo ($49/mo billed yearly) | 3, then +$10/user |
  | Team | $350/mo | 15 |
  | Lite | $10/mo | Agency partners only |

- Editors use CloudCannon accounts. "Client Sharing" can instead put a site behind a password.
- Astro support left beta in the changelog on 2023-03-16.
- It cannot be self-hosted.

**Spinal** *(verified 2026-10-13)*
- **Pricing** (`spinalcms.com/pricing/`): Pro only, at "$39 month" with "5 members included. Additional member: $4/month".
- An older "$29 Team" snippet in search results conflicts with the live pricing page and has been ignored.
- **Astro** (`/cms-for-astro/`): supported.
- **Collaboration** (`/features/collaborate-on-static-site/`):
  - Editors need no GitHub account.
  - Permissions (create, edit, publish) are set per content type.

**Netlify Visual Editor** *(verified 2026-10-13)*
- Source: `docs.netlify.com/manage/visual-editor/overview/`, updated 2026-09-11.
- It is "only available for teams that already have it enabled… no way to enable visual editing for a new project or team".

**Contentrain Studio** *(verified 2026-10-13)*
- **Source:** the `github.com/Contentrain/studio` repo.
- **Licence and stack:** AGPL-3.0 plus a proprietary `ee/` directory. It is a Nuxt 4 app, currently at v0.4.8 (2026-10-08).
- **Database:** it requires PostgreSQL, either Supabase or plain PostgreSQL.
- **Git access:** through a GitHub App.
- **Pricing** (`contentrain.io/pricing`): Starter $9 (3 seats), Pro $49 (25 seats). Seats are "fixed per plan".
- **Astro support is via a search excerpt** of the primary pages, which I did not open:
  - the `contentrainLoader` content-layer loader in `github.com/Contentrain/ai` (PR #505);
  - an Astro starter in `docs.contentrain.io/guide/quickstart`.

**Outstatic** (`outstatic.com/pricing`) *(verified 2026-10-13)*
- **Self-host:** free, but sign-in is GitHub-only.
- **PRO:** "$9.99/user/mo". It adds "Email magic link + Google login" and "Team roles and permissions".
  - Commits from non-GitHub users are made as "the Outstatic Bot".
- **Repo** `avitorio/outstatic`: v2.2.4 (2026-08-20), licence NOASSERTION.
- **Unverified:** whether invited clients count as billed users.

**Nuxt Studio** *(verified 2026-10-13)*
- Positioning (`nuxt.studio`):
  - "Free forever under MIT".
  - "Self-hosted CMS for Nuxt Content websites".
  - It is a Nuxt module only.
- **Sign-in:** GitHub, GitLab, Google (with a moderator email list), or a custom `setStudioUserSession`.
- **Commits:** Google and custom users commit through `NUXT_STUDIO_GIT_GITHUB_TOKEN`.
- **Repo** `nuxt-content/studio`: MIT, v1.7.0 (2026-04-28).

**Mattrbld** (`mattrbld.com`, docs `/limitations/`) *(verified 2026-10-13)*
- The docs say "All project members need an account at that Git provider, e.g. a GitHub account".
- AGPL. v1.5 was announced on 2026-02-27.

**Front Matter CMS** *(verified 2026-10-13)*
- It is a VS Code extension that "runs on your machine" (`frontmatter.codes/docs`). It supports Astro.
- The repo `estruyf/vscode-front-matter` is MIT, at v10.13.0 (2026-10-12).

### 2.7 New entrants from the Astro CMS list

The list at `docs.astro.build/en/guides/cms/` names GitCMS, JekyllPad, Sitepins, StudioCMS, Vault CMS, Zero and HackMD.

**Sitepins** *(verified 2026-10-13)*
- **Repo** `sitepins/sitepins`: AGPL-3.0, created 2026-07-15, 188 stars, no releases.
- **Self-host:** an "Express + MongoDB backend" that needs a MongoDB replica set. There is "no member limit".
- **Cloud pricing** (`sitepins.com/pricing`):

  | Plan | Price | User limit |
  |---|---|---|
  | Pro | $12/mo | 3 users/org |
  | Team | $29/mo | "5 Users per organization" |
  | Agency | $49/mo | 5 users/org |

- Invited editors "never need a GitHub or GitLab account". Commits go "through the project's connection".
- Sign-in options are email+password, Google or GitHub (docs `/account/profile-and-security`).
- Roles are Owner, Admin and Editor (docs `/collaboration/team-and-roles`).

**Zero** (`zerocms.io`) *(verified 2026-10-13)*
- Supports Astro only: "any Astro v4-v7 site that uses content collections".
- Works through a GitHub App, on GitHub only. "Nobody needs a GitHub account".
- The changelog says it "launched in private beta in late 2025". The latest entry is 2026-09-14, and there is no GA.
- There is no public pricing, only a 14-day trial. The licence is unknown.

**GitCMS** (`gitcms.dev`; `gitcms.blog` redirects to it with a 301) *(verified 2026-10-13)*
- **Pricing:**
  - "$79 per site, one-time", plus "$9 per extra teammate, one-time".
  - Monthly plans, marked "Coming soon": Solo $15/site/mo and Team $29/site/mo.
- **Storage:** "no database needed"; "everything stays in your site's repository". Astro is listed.
- **Changelog:**

  | Version | Date | Change |
  |---|---|---|
  | v0.0.1 | 2025-02-17 | First release |
  | Alpha 04 | 2026-03-20 | "Invitations, member management, and scoped access" |
  | v1.0 | 2026-04-01 | — |
  | v1.3.0 | 2026-06-04 | "Adds Google login for invited editors" |

- `/pricing` returned 404; the prices above were read from the site.
- The repo `waishnav/gitcms-web-app` returns 404 from the API, so it is private or gone. The licence is unknown.

**StudioCMS** (`docs.studiocms.dev` getting-started) *(verified 2026-10-13)*
- It requires "A database connection (libSQL, MySQL, or PostgreSQL)". MIT.

**Vault CMS** (`davidvkimball/vault-cms`) *(verified 2026-10-13)*
- It combines Obsidian with the Git plugin. MIT, v1.3.9 (2026-06-04).

## 3. Open or unverifiable

### Not tested

- **Keystatic Cloud:**
  - installing it on a repo owned by `tps-papabot` or by the future org;
  - how commits from editors without GitHub accounts are attributed.
- **PagesCMS hosted:** inviting a collaborator when the repo owner is a machine user or an org (the inviter must see the installation, per `P/lib/actions/collaborator.ts` L41-51).
- **DecapBridge:**
  - whether a **classic** PAT from `tps-papabot` works across the pending org move;
  - its behaviour with a private repo under an org.
- **Our own git-gateway-compatible endpoint:** the whole recipe in §2.2 is inferred from `D/` source and the Decap docs. No proof of concept exists.
- **Gitea/Forgejo:**
  - limiting Discord logins to a guild or role;
  - how the force-push mirror interacts with the bot committing to GitHub.

### Unverified

- **Keystatic Cloud pricing** comes from the docs source only, because the pricing page returned 404 today.
- **Zero:** pricing and licence.
- **GitCMS:** how many teammates are included, its licence, the operator's identity, and whether "scoped access" means per-editor path scoping.
- **Outstatic PRO:** whether invited editors count toward per-user billing.
- **Contentrain:** Astro support (search excerpt only).
- **Forgejo:** the licence was not re-checked today.
- **Not checked at all:** JekyllPad and HackMD (both on the Astro CMS list).

### Tooling notes

- The GitHub MCP failed to connect, so the `gh` CLI was used instead. The Cloudflare MCPs needed OAuth and were not used.
- These pages returned 404 or 500 today:
  - `keystatic.cloud` (root returned 500; `/pricing` returned 404)
  - `decapbridge.com/pricing` and `/docs` (`/docs/*` subpages worked)
  - `gitcms.dev/pricing`
  - `pagescms.org/docs/guides/collaborators` (the correct path is `/docs/configuration/collaborators/`)
- The clones live under `/private/tmp` (`ks`, `decap`, `pc`) and are outside the repo. No repo file was modified.
