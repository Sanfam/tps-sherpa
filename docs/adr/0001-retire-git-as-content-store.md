# ADR-0001: Retire git as the content store

**Status:** Accepted, 2026-10-13
**Supersedes:** the parts of `docs/proposals/project-fundamentals/ASTRO-ARCHITECTURE.md` listed under [Supersession](#supersession)

## Context

"Git is the content bus" arrived on 2026-08-31 in the same commit that dropped Instatic and chose Tina. Tina stores content as files in git, so the bus followed from that choice rather than being weighed on its own. SQLite with Litestream was adopted the same day for bot state, but was never considered as the content store.

The reasons the handoff gives, and where each stands now:

- **No database shared between two services.** Each service can own its own SQLite files instead, and the services exchange data over Railway private networking.
- **Free backup, with one clone holding the whole system.** Once the repository went public, that clone published the whole Catalog (#26).
- **Free audit trail and `git revert`.** This is the one real loss, and the Decision covers it.
- **Content stays portable markdown.** In practice this narrowed the CMS choice to git-backed tools. Tina is the only survivor, and it still has no documented recipe for self-hosting on Astro.

The rule also contradicts the privacy model. The handoff refuses to replicate Tier 0 because a copy "would outlive the member's own deletions". Git history does exactly that for every Catalog field ever committed. Activity summaries were already kept out of the Catalog to work around this (`2986271`).

No site app and no deployed service exist yet, and nothing in the code commits to git (`content/index/data.json` is committed by hand). This is the cheapest moment to change.

## Decision

**By default, each Railway service owns its state in SQLite files on its own volume.** The bot always does; the site may move to Postgres (below). Durable and disposable state live in separate files, because Litestream replicates whole databases, not selected tables. Only the durable files are replicated, by Litestream to S3-compatible object storage: R2 today, with Backblaze B2 as a drop-in. Git holds code, docs, versioned vocabulary, and the one-time exclusion seed (see [Startup and restore](#startup-and-restore)).

**Railway Postgres stays open for the site.** The table below is the default shape. The site's durable state (CMS content, promote flags, Access settings) may move to a Railway Postgres if the chosen CMS prefers it, or if the site needs more than one instance or deploys without a gap. The bot stays on SQLite either way: it is single-instance by nature, and its Tier 0 cache must stay local and unreplicated. The trade-offs are in `docs/research/2026-10-13-cms-and-datastore-options.md` §2; the choice is made with ADR-0002. A Postgres shared by both services is still not the plan: it would only earn its coupling if both services had to write the same data.

| File | Holds | Replicated |
|---|---|---|
| Bot, durable | The Catalog: Entities, identity summaries, facets, summary overrides and their revisions. Also exclusions, and later opt-outs, profiles, recommendation history and intro-responder states. | Yes |
| Bot, cache | Tier 0 raw text, sync bookkeeping, activity summaries | No (unchanged) |
| Site, durable | CMS content: club pages, the landing page, the privacy policy, Access settings. Also Index presentation: promote flags. | Yes |
| Site, cache | The last accepted Catalog snapshot | No; pulled again from the bot |
| Site, sessions | Better Auth sessions | No; disposable (unchanged) |
| Git | Topic vocabulary and region gazetteer | Versioned with the code and tests that read them |
| Git | `content/config/index-flags.json`, the exclusion seed | Read once, at first initialisation; the durable store is authoritative after that |

### Bot → site: one way, pulled

- **The site pulls.** On a timer, the site pulls a snapshot from a private endpoint on the bot, over Railway private networking. The bot has no public port. Each pull has a timeout and runs in the background, so a bot outage never blocks a page request.
- **The snapshot is a small versioned envelope.** It holds the Catalog with today's Entity schema, the role manifest, the generation time and the sync outcome. The bot publishes each generation atomically.
- **A partial sync is never published as complete.** Some enumeration fails partway; for example, archived Threads that return `50001` are skipped. Such a sync is not published as complete, because an Entity missing from an incomplete enumeration has not been confirmed removed. Nor does it replace the bot's durable current Catalog: the bot keeps the previous generation, so neither Sherpa nor the overrides of skipped Entities lose anything. Today the adapter reduces a `50001` to a warning and a shorter list, which `run.ts` writes (#28).
- **The site accepts a snapshot only if it is complete and valid.** It must report a complete sync outcome, and pass schema validation. This takes over the job of the CI gate on content commits. On rejection, the site raises an alert to Staff and keeps the last accepted snapshot; it never merges a rejected snapshot into the accepted one. With no accepted snapshot at all, the Index says it is unavailable rather than showing an empty Catalog.
- **Nothing flows from the site to the bot.**
  - **Exclusions** already govern Catalog membership and which containers have their Threads listed.
  - **Summary overrides** are part of the Catalog. The bot already carries them forward (`catalog.ts`), and Sherpa reads them as well as the Index.

  Both therefore stay with the bot. Staff edit both through bot commands, which are follow-up tickets. Each override change appends a revision recording who made it, when, and the previous value. This replaces "git supplies the audit trail for free".
- **Promote flags are Index presentation only.** Sherpa ignores them, so they live on the site.
- **Exclusion semantics are unchanged.** An exclusion means "not a destination", not "secret": an excluded Channel or Forum's own name still resolves in mentions. (The Posts under an excluded Forum are never enumerated, so a mention of one does not resolve. That bug predates this ADR: #27.) A change takes effect after the next successful sync and the site's next accepted pull.

### Startup and restore

The same contract applies to every durable file. It runs **before** the application opens the database or runs migrations.

- **File present:** use it. Never overwrite it from a replica.
- **File missing, deployment established:** restore from the replica and validate it, then start.
- **First initialisation:** only on an explicit first-run flag. Create the database, then import the exclusion seed from `content/config/index-flags.json` in one transaction, and write an initialisation marker. The marker distinguishes "intentionally empty" from "never seeded". The seed is never re-applied over restored or Staff-edited data.
- **Restore fails, storage is unreachable, or a replica is unexpectedly missing:** refuse to start. Never fall back to empty durable state. The same rule applies inside a run: if the sync can't read the previous Catalog, finds it is not a list of Entities, or finds it missing or empty without the first-run flag, it stops rather than treating it as empty. Treating it as empty would write every override away (`parsePrevious` in `catalog.ts`, fixed alongside this ADR). Its `SYNC_FIRST_RUN=1` is an interim guard for the local file: an environment variable can be left set, so it is not the deployed first-run flag. When the Catalog moves to the bot's database, the initialisation marker above replaces it. Today's parser reads a missing exclusion file as "exclude nothing" (`exclusions.ts`). That stays true of the seed file only; it is never true of the durable store.

Restore is rehearsed, and the command written down, before the first durable write on each service. For the bot, that means before the Catalog's first deployed write, not Phase 3.

For the bot, the contract is `apps/bot/start.sh`, and the commands and the rehearsal are in [`docs/runbook.md`](../runbook.md).

### CMS

The CMS choice reopens, under these criteria:

- Stores content in SQLite on the site's volume, or in Railway Postgres if the site moves to it (see above).
- Coexists with Astro SSR on Node.
- Editors need no GitHub accounts.
- Keeps attributed revisions, and can roll back a single document.
- No one-time licence fee, and no paid edition needed for any criterion here.
- At most $10/month in total for software, subscriptions and licences. Hosting is excluded, and the existing ceiling of about $30/month for everything still applies.

Reader gating is still not a criterion. The CMS selection will be ADR-0002.

## Supersession

**In `ASTRO-ARCHITECTURE.md`, this ADR replaces:**

- **Locked decisions:**
  - "Git is the content bus"
  - "CMS is Tina, self-hosted"
- **Track A/B data contract:** the transport only, from a committed `data.json` to the pulled snapshot. The schema is unchanged.
- **Shape and repo layout:**
  - Railway watch paths for content commits
  - The bot pushing to `main`, and its machine-account credential
  - The CI gate on content commits, and `git revert` as the fix for a bad content commit
- **Access:** the role manifest's git transport. The bot now carries it in the snapshot.
- **Content model:**
  - The `content/` file paths for content
  - "Flags living in git"
  - "Git supplies the audit trail for free"
- **CMS: Tina, self-hosted:** the whole section, including the two-day abort and the TinaCloud fallback.
- **Phases:**
  - The git destination in Phase 1, "Sync engine → git"
  - Phase 6 migrating Wiki.js content "to markdown, commit". It now migrates into the CMS.
  - The bot's CI build-failure alarm now covers code only.
- **"A content database" as an anti-goal, and "What would force a content database later".** A database is now the content store, and Postgres is an open option for the site rather than an anti-goal (see Decision).
- **Bot backup timing.** Durable bot backup now begins with the Catalog's first deployed write, not Phase 3.

**Elsewhere in the repo:**

- `PROJECT-STATUS.md`: §10's backup and bus-factor notes and §12's next actions, where they assume git holds content or that a machine credential is needed.
- `docs/agents/review-process.md`: the exemption for the bot's content commits. The bot no longer commits.
- `docs/agents/credentials.md`: `GITHUB_MACHINE_TOKEN` is retired.

**Unchanged:**

- Discord-derived authorization: Access as guild roles, with Staff and Club Lead defined in Discord.
- Default-deny Access.
- Staff approval of public summaries.
- The Wiki.js read-only cutover, with no dual-running period.
- Every stop condition. This ADR authorises exactly the files above, their initial migrations, and Litestream to R2 or B2. Any further vendor, credential, retention decision or privacy change still stops for a human.

## Consequences

**Gained**

- **No new Catalog data reaches the public repository.**
- **Data changes no longer trigger site rebuilds.**
- **Staff exclusions take effect on the next sync.** No weekly refresh, and no commit, is needed.
- **Removal becomes possible.** A removed row is gone from live queries at once. Full erasure follows the erasure policy under Decided below.
- **No GitHub credential to manage.** The bot no longer needs a GitHub write credential. `GITHUB_MACHINE_TOKEN` can be revoked, and with it goes the Phase 1 deadline for an org-owned machine account.
- **Database-backed CMSs become eligible.**

**Lost or newly required**

- **History.** It is no longer free. Overrides carry revision rows, CMS documents rely on the CMS's own revisions, and Litestream retention is bounded.
- **Restore.** A restore needs object-storage credentials and the rehearsed startup contract above.
- **Validation.** It moves from CI to the moment a snapshot is accepted.
- **Downtime.** A service with a volume can't run two deployments at once, so every redeploy has a short gap. Each service also runs as a single instance. Both are acceptable at this scale; if they stop being acceptable for the site, moving it to Postgres removes both for the site.
- **Private networking.** Internal names resolve to both IPv4 and IPv6 in environments created after 2025-10-16, and to IPv6 only in older ones. The bot's private listener binds `::`, which works in both.

**Decided**

- **`GITHUB_MACHINE_TOKEN` is revoked once confirmed unused** (Staff, 2026-10-14). Checked 2026-10-14: no code, CI workflow or repository secret reads it, and no Railway project for this repo exists. It is held only in the local `apps/bot/.env`. Revocation waits only on a human confirming no other machine holds a copy; it needs no further decision.

- **Erasure policy** (Staff, 2026-10-14). A row leaving live queries is not erasure, so the windows are set here and the privacy policy states them.
  - **Triggers:** an erasure request, and a deletion in Discord (a message, Post, Thread or Channel).
  - **On the site:** gone within one sync and the site's next accepted pull. Because there is no maximum snapshot age (below), a sync that keeps failing must not hold a removal back. The bot meets this by republishing its last complete Catalog with the removal applied, which is complete, only older. This is follow-up work alongside #28.
  - **In backups:** gone within 30 days. Litestream retention and R2 or B2 object-version lifecycle are each capped at 30 days. SQLite runs with `secure_delete` on. Railway's monthly volume backups (89 days) stay off; daily and weekly ones fit. If the site moves to Postgres, its roughly 4-week PITR window fits too.
  - **Revision rows:** pruned after 90 days. An erasure deletes the affected Entity's revision rows at once, so the 90 days never outlast the 30-day promise.
  - **Opt-outs are kept:** they are what honours a request, so erasing one would undo it.
  - **Git history:** Catalog data committed before 2026-10-14 stays public (#26), and the privacy policy says so.
- **There is no maximum snapshot age** (Staff, 2026-10-14). The Index never stops serving its last accepted snapshot because of age. It always shows when the snapshot was generated. Once a scheduled sync has been missed twice, Staff get an alert and the Index marks the snapshot as out of date. Until the next accepted pull, exclusions and removals do not reach the site; the erasure policy has to allow for that.
- **Catalog data already in git history stays public** (#26, Staff, 2026-10-14). The repository stays public and its history is not purged. What is already committed is accepted as public, and the erasure policy must say so. `content/index/data.json` and the role manifest `content/config/roles.json` are untracked and gitignored from 2026-10-14, so no new Catalog or role data reaches the repository. A local sync still writes it, and a deployed bot regenerates it on its first run. CI's content check validates it only where a sync has written one.
