# Runbook

What an operator runs by hand. The decisions behind it are in ADR-0001.

## The bot's durable store: replication and restore

The deployed bot starts through `apps/bot/start.sh`, the root `Dockerfile`'s
entrypoint. It runs ADR-0001's startup contract, in
`scripts/litestream-start.sh` (shared with the site), before anything opens
`bot.db`:

- **`bot.db` present:** used as it is. Never overwritten from the replica. The
  replica must still be reachable (`litestream ltx`, 60 seconds), or the bot
  refuses to start rather than take writes it cannot replicate. An empty
  replica, confirmed by a second listing 30 seconds later (one that is empty
  and then not refuses), starts a fresh one; a replica with files but no
  snapshot refuses
  (see [After a long sync outage](#after-a-long-sync-outage)).
- **`bot.db` missing:** restored from the replica beside the store, checked
  with a full integrity check, and only then moved into place. If the restore
  fails, takes over 5 minutes, storage is unreachable, or there is no
  replica, the bot refuses to start. It never starts on an empty store. Any
  stale `bot.db-wal` and `bot.db-shm` are removed first, so they are not
  replayed over the restored file.
- **Replication variables missing:** refuses to start.

Then it runs `node apps/bot/src/serve.ts` as the child of `litestream
replicate`, so `bot.db` is replicated for as long as the bot runs. `serve.ts`
still refuses a store without the initialisation marker. On Railway it also
refuses to start unless `start.sh` started it (`BOT_STARTED_BY_ENTRYPOINT`;
Railway is recognised by `RAILWAY_ENVIRONMENT_ID`),
so a start command that skips the script fails loudly.

Only `bot.db` is replicated. `tier0.db`, `activity.json` and
`find-member-usage.json` on the same volume are not.

The erasure policy says a removed row leaves backups within 30 days. Three
settings hold it, and all three must stay:

- **The bucket's lifecycle rule** deletes every object 30 days after it was
  written, whether or not the bot runs. R2 expires objects typically within a
  day of that, best effort, so the real bound is about 31 days. The owner
  accepted that (2026-10-17) rather than shorten the rule. Daily snapshots mean
  Litestream never needs anything that old. Object versioning stays off.
- **Litestream retention** keeps 7 days of snapshots
  (`apps/bot/litestream.yml`), about 9 days in practice. It is best effort, not
  the guarantee: it only runs while the bot runs, and R2 can answer a delete
  with success without deleting
  (`docs/research/2026-10-13-cms-field-c-database-backed.md`). Treat it as
  unproven until a listing of the bucket shows old snapshots gone.
- **Railway volume backups:** monthly ones (kept 89 days) stay off. Daily and
  weekly ones fit.

Litestream is 0.5.17, pinned with its checksums in the `Dockerfile`.

### Railway settings this depends on

- Variables: `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`
  (`https://<account_id>.r2.cloudflarestorage.com`), `LITESTREAM_ACCESS_KEY_ID`,
  `LITESTREAM_SECRET_ACCESS_KEY`. See `docs/agents/credentials.md`.
- **Start command `sh /app/apps/bot/start.sh`,** set explicitly. A start
  command overrides the image's entrypoint, so any other one skips the restore
  and replication. `serve.ts` refuses to start on Railway without the
  entrypoint's marker, so that mistake shows as a crash loop with
  `Started on Railway without apps/bot/start.sh`.
- The volume stays mounted at `/app/apps/bot/.data`.
- Watch paths include `Dockerfile`, `.dockerignore` and
  `scripts/litestream-start.sh`.

Local development does none of this: run `node apps/bot/src/serve.ts`
directly. It neither restores nor replicates.

### Restore by hand from R2

To inspect the replica, or restore an earlier point in time. **Member data
never lands on a personal machine:** restore only inside the service's
container (`railway ssh -s bot`), to a temporary path, never over the live
`bot.db`, and delete it when done. The container already has the keys.

```sh
URL="s3://$LITESTREAM_BUCKET/bot.db?endpoint=$LITESTREAM_ENDPOINT&region=auto"
litestream ltx "$URL"
litestream restore -integrity-check full -o /tmp/bot-inspect.db "$URL"
# ... inspect with node:sqlite ...
rm -f /tmp/bot-inspect.db /tmp/bot-inspect.db-wal /tmp/bot-inspect.db-shm
```

Add `-timestamp 2026-10-16T00:00:00Z` to restore to a point in time within the
last 7 days.

To make the deployed bot restore itself, stop the service, delete
`bot.db`, `bot.db-wal` and `bot.db-shm` from the volume, and start it. The log
shows `[start] No durable store ... Restoring it from the replica.`, then
`post-restore integrity check passed`.

### First initialisation of a brand-new deployment

Once, ever, per deployment, and never over an existing replica:

An empty volume with an empty replica makes `start.sh` refuse to start, so
there is no running container to `railway ssh` into. Initialise through a
one-off start command instead:

1. Set the four variables, so the first real boot can replicate.
2. Set the service's start command to `node apps/bot/src/sync/init-store.ts`
   and deploy. It writes `bot.db` with its marker and exits; the restart policy
   reruns it, and every rerun refuses because `bot.db` now exists. That
   refusal is harmless.
3. Set the start command back to `sh /app/apps/bot/start.sh` and redeploy.
   `start.sh` finds `bot.db` present and replicates it from then on.

### Rehearsal, 2026-10-16

Run locally from the repo root with Litestream 0.5.17 (darwin-arm64), against
a `file` replica instead of R2. Same `start.sh`, with `LITESTREAM_CONFIG`
pointed at a copy of `litestream.yml` whose replica is
`type: file, path: $REHEARSAL_REPLICA`, and dummy values for the four
variables.

```sh
T=$(mktemp -d)
export BOT_DB_PATH=$T/data/bot.db REHEARSAL_REPLICA=$T/replica LITESTREAM_CONFIG=$T/litestream-file.yml
node apps/bot/src/sync/init-store.ts          # no content/index/data.json: 3 exclusions, no Catalog
litestream replicate -config $LITESTREAM_CONFIG &   # then insert rows with sqlite3; then SIGTERM
rm -f $BOT_DB_PATH $BOT_DB_PATH-wal $BOT_DB_PATH-shm  # Litestream's local meta dir left in place
sh apps/bot/start.sh
```

| Step | Result |
|---|---|
| Missing `LITESTREAM_BUCKET` | `[start] LITESTREAM_BUCKET is not set. Refusing to start`, exit 1, no `bot.db` created |
| Store deleted, replica present | Restored, `post-restore integrity check passed`; counts before and after match (5 exclusions, 1 preference, 3 Entities, 1 marker); `serve.ts` passed its marker check and stopped at the missing Discord token, as expected |
| Store present with a row the replica lacks | `Using the durable store`; the local row kept |
| Replica path empty | `Error: no matching backup files available`, `Restore failed. Refusing to start`, exit 1, no `bot.db` created |
| Replica unreadable | `permission denied`, refused, exit 1, no `bot.db` created |
| Store present, replica unreadable (rerun after review, with the reachability check) | `The replica cannot be reached. Refusing to start`, exit 1 |
| Store deleted, a stale `bot.db-wal` left beside it that deletes every exclusion (2026-10-17) | Restored with all 5 exclusions. With the WAL cleanup removed from `start.sh`, the same run restored 0 exclusions and the marker check still passed |

After the review fixes the restore goes to `bot.db.restoring` and is moved into
place only after its integrity check; the rows above were rerun against that
and passed unchanged. An unreachable S3 endpoint makes `litestream ltx` retry
indefinitely (seen locally), which is why `start.sh` bounds it with `timeout`.

**Against the real R2 bucket, 2026-10-16.** Run by the owner from a laptop
with `railway run -s bot` (so the keys came from the service, never printed),
Discord and model keys removed, replicating under a separate `rehearsal/`
prefix so the real `bot.db` path was untouched:

| Step | Result |
|---|---|
| Keys list the real `bot.db` path | empty listing, exit 0 |
| Replicate a fresh store, then write a row after its snapshot | `snapshot complete`; counts 4 exclusions, 1 marker |
| Delete it; `start.sh` restores from R2 | `post-restore integrity check passed`; counts 4 and 1, so the row written after the snapshot came back too |
| Store present, wrong secret | `The replica cannot be reached. Refusing to start` |

Not yet rehearsed: the built image itself (no Docker locally). Its first
deploy is watched in the logs: `[start] Using the durable store`, then
`snapshot complete`.

### After a long sync outage

Litestream only snapshots a database that has changed. So that the 30-day
lifecycle rule never deletes the only snapshot, the running bot rewrites a
one-row `heartbeat` table hourly, whether or not the pipeline works. While the
bot runs, a fresh snapshot is taken every day.

If the bot is down longer than the rule, or replication fails that long, the
bucket can empty while Litestream's local state on the volume
(`.data/.bot.db-litestream`) still remembers the files it uploaded. Replicating
on top of that state takes a snapshot, then fails every sync after it, so new
writes never reach the replica while the logs look healthy. `start.sh`
checks the replica listing before every start:

- **Empty:** a first deploy, or a purged bucket. It logs `THE REPLICA IS
  EMPTY`, deletes Litestream's local state, and replication starts a fresh
  replica with an immediate snapshot. On anything but a first deploy, find out
  why the bucket emptied.
- **Files but no snapshot, and none from the first transaction:** partly
  purged (the lifecycle rule deletes the oldest files first); it cannot be
  restored or repaired in place, so the bot refuses to start. A replica with
  no snapshot that still starts at transaction 1 is a young one (the bot
  exited before its first snapshot) and restores, so it is used as it is. With `bot.db` still on the volume,
  delete the `bot.db/` prefix in the bucket (the R2 dashboard, or any S3
  client with the bucket's keys) and restart: that is the empty case.
- **Otherwise:** replication continues as before.

`auto-recover` is deliberately off: it races the boot snapshot, and losing that
race leaves every later write unrestorable while the logs report success.

Rehearsed 2026-10-17 with a file replica through `start.sh`:
a normal restart kept replicating and restored all
rows; after deleting the replica's files and all but the newest local L0 file,
start logged `THE REPLICA IS EMPTY` and both rows written after the restart
restored; with the snapshot level and every file from transaction 1 deleted,
start refused; a bot that exited 1.2 s into a fresh replica (transaction 1
uploaded, no snapshot yet) started normally next time and its row restored.
With the local state deletion removed from `start.sh`, both post-restart rows
were lost.

## The Catalog snapshot endpoint

The bot serves `GET /snapshot` on the private network at port 8081
(`SNAPSHOT_PORT`), bound to `::` for Railway's IPv6-only private networking.
It is deliberately not `PORT`: the bot service must never get a public domain.
The site reads it from `BOT_SNAPSHOT_URL`, e.g.
`http://<bot-service>.railway.internal:8081/snapshot`. Before the first sync it
answers 503; an unreadable store is logged as `[snapshot]` and answers 500.

## Erasure in the CMS: purge history and anonymise

Both are Admin actions (holders of `Staff`), checked against the live role, and
refused without a same-origin `Origin` header (ADR-0002, trial step 4). There is
no button for either yet. Run them from the browser's developer console on the
site, signed in, so the request carries your session and the site's origin.

**Purge history**, after removing someone's personal data from a page. This
deletes every old version of that page at once, and keeps the version it
currently shows and any unpublished draft. The entry's ID is the last part of
its URL in the CMS (`/_emdash/admin/content/pages/<id>`).

```js
await fetch("/admin/emdash/purge-history", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ collection: "pages", entryId: "<id>" }),
}).then((r) => r.status); // 200 done, 404 no such entry
```

**Anonymise an editor**, on their request. This clears their name from their CMS
account and moves their pages, versions, media and bylines to an "Anonymous"
author. Their account still exists, and if they still hold an editor role their
next CMS visit keeps them anonymous. Their address is `<Discord ID>@discord.local`.

```js
await fetch("/admin/emdash/anonymise", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "<Discord ID>@discord.local" }),
}).then((r) => r.status); // 200 done, 404 no such editor
```

Neither touches the site's sign-in record. To delete that, see the privacy
policy's "until you ask Staff to delete them": until issue #74, that is by hand.

The 90-day revision prune runs by itself, a minute after the site's first
server-rendered request after a start, then daily. A failure is logged as
`[emdash] Revision prune failed`. Purge, anonymise and the prune then run a
`PASSIVE` WAL checkpoint, which never blocks EmDash's writes; what it can't
fold back yet, Litestream's own checkpoint folds shortly after.

## Changing CMS content: the preferred strategy

How to change content already in the CMS (works, pages, terms), whether it is
one field or a hundred entries. Owner's preferred strategy, 2026-11-18, after
standardising the book club's works. Pick the narrowest step that does the job.

**1. Targeted edits go through EmDash's MCP server.** A field, a label, a few
entries. Claude Code reaches the CMS as `papa-cms` with an EmDash API token
(setup below). Read with `content_get`; write with `content_update`, passing the
`_rev` it returned; then `content_publish` with the `_rev` the update returned,
since an update to a published entry only stages a draft. A `CONFLICT` means
someone saved in between: read again. An `ENTRY_LOCKED` names who has the entry
open: ask before using `overrideLock`. Terms: `taxonomy_update_term`.

**2. Plan bulk changes offline, from a read-only copy of the live data.** Read
what you need straight from the database, read-only, into a scratch file outside
the repository:

```sh
railway ssh -s site -- node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/data/emdash.db", { readOnly: true });
  console.log(JSON.stringify(db.prepare("select id, title, creators from ec_works where deleted_at is null").all()));
' > /path/outside/repo/works.json
```

Then run the repository's own decision code against it, not a new copy of it:
for works, `pickMatch` and `respelled` in `apps/site/scripts/enrichment.ts`.
Write the result in the script's plan format (`enrich-works.ts --plan`), outside
the repository. Plans and dumps hold editors' text, and some titles name members.

**3. Check anything visual or external by eye before it is applied.** Open
Library's main cover for a work can be a foreign edition (Wizard's First Rule's
is German), a film tie-in, an audiobook square or a library scan stamped
"DISCARDED". Render every proposed image as a contact sheet (an HTML grid,
screenshotted with headless Chrome), look at it, and swap a bad one for an
English print edition's cover (`/works/<key>/editions.json`). A matching rule
that passes its tests can still be wrong about a name: "Iain M. Banks" is not a
misspelling of "Iain Banks".

**4. Bulk writes with uploads go through the reviewed scripts, run by the
owner.** Covers and page images need uploading; MCP's `media_upload` takes each
file as base64 through the agent, which is only practical for one or two.
`import-wiki.ts` and `enrich-works.ts` upload properly. `enrich-works.ts --apply`
and `import-wiki.ts --rewrite` guard their content writes with `_rev`; the
import's first run and `enrich-works.ts`'s term relabels do not, so run those
when no one is editing. The owner runs them from `apps/site` with their own session cookie,
`--dry-run` first. The agent prepares and checks the plan file, then verifies the
result afterwards over MCP.

**Never:** write EmDash's tables directly (it skips EmDash's permissions and
revisions); make a session by writing to the session table; read the API token
out of Claude Code's config to hand to a script; put a plan, a dump or a
member-named slug in the repository.

### Setting up the MCP connection

1. In the CMS: Settings → API Tokens (Admins only). Name it for the client.
   Scopes: `content:read`, `content:write`, `media:read`, `schema:read`, and
   `media:write` or `taxonomies:manage` if the work needs them. Never Admin, a
   Transfer scope or MCP Tools: the gate refuses those tokens (ADR-0002). Expiry
   30 days. Copy it; it is shown once.
2. In your own terminal, never a chat: `read -rs EMDASH_MCP_TOKEN && export
   EMDASH_MCP_TOKEN`, then

   ```sh
   claude mcp add --transport http papa-cms https://sherpa.omgod.com/_emdash/api/mcp \
     --header "Authorization: Bearer $EMDASH_MCP_TOKEN"
   ```

   The URL must be exactly that: the gate refuses any other spelling of a
   token request's path.
3. Restart Claude Code. The token works only while its holder is a Member whose
   live Discord role is at least their CMS role. Revoke it on the same page when
   the work is done.

## The site's database: replication and restore

The deployed site starts through `apps/site/start.sh`, `apps/site/Dockerfile`'s
entrypoint, which runs the same `scripts/litestream-start.sh` contract as the
bot over EmDash's database, `$SITE_EMDASH_DIR/emdash.db` (`/data/emdash.db`):
present is used, missing is restored and checked, and every failure refuses to
start. Replica `site/emdash.db` in the site's bucket; retention, lifecycle rule
and versioning exactly as for the bot, above.

- **Not replicated:** the session database (`SITE_SESSION_DB`), disposable by
  ADR-0001; losing it signs everyone out. Uploads go to their own R2 bucket
  (below), which is their only copy. Nor is the last accepted Catalog
  snapshot, `$SITE_EMDASH_DIR/catalog-snapshot.json` (or `SITE_SNAPSHOT_PATH`),
  a cache the site pulls again from `BOT_SNAPSHOT_URL` within a minute of
  starting. Unset, the site does not pull, and says so in its log.
- **Heartbeat:** `apps/site/heartbeat.mjs`, loaded ahead of the server,
  rewrites the file's `user_version` hourly. EmDash's own once-a-minute write
  starts only after a request has started its runtime, so an idle site would
  otherwise stop being snapshotted (see
  [After a long sync outage](#after-a-long-sync-outage)).
- **Start command:** leave it unset, or set `sh /app/apps/site/start.sh`. If
  anything else starts the site on Railway, the gate answers every EmDash route
  with 503 and logs `Started on Railway without apps/site/start.sh`, so no edit
  is taken unreplicated. Public pages still serve.
- **First deploy:** the volume already holds `emdash.db`, so the first boot logs
  `THE REPLICA IS EMPTY` and starts a fresh replica. On a brand-new volume
  (none to restore) the start refuses; create the file once with a one-off
  start command, then set it back:
  `node -e 'new (require("node:sqlite").DatabaseSync)(process.env.SITE_EMDASH_DIR + "/emdash.db").exec("PRAGMA journal_mode = WAL")'`.
  EmDash migrates it on start, and its `users` table is empty: make the first
  CMS request as an Admin (ADR-0002, the first-user hazard).
- **Watch paths:** `apps/site/**` and `scripts/litestream-start.sh`.

### Uploads: R2

With `S3_BUCKET` set at build, EmDash stores uploads in R2 through its `s3()`
adapter (`astro.config.mjs`); the other `S3_*` variables are read at start.
Files are always served through `/_emdash/api/media/file/...`, behind the gate
and Member-only: the bucket stays private, with no `r2.dev` URL or custom
domain. The admin uploads through `media/upload-url`, a signed PUT straight to
R2, valid for an hour, so the bucket needs CORS for the site's origin.

### Restore check

In the site's container (`railway ssh -s site`), with the owner's approval:
member data never lands on a personal machine.

```sh
sh /app/apps/site/restore-check.sh                         # latest
sh /app/apps/site/restore-check.sh 2026-11-15T00:00:00Z    # point in time, last 7 days
```

It restores to a scratch directory, never over the live file, runs a full
integrity check, prints `integrity_check: ok` and each table's row count beside
the live file's, and deletes the copy. To make the site restore itself: stop
the service, delete `emdash.db`, `emdash.db-wal` and `emdash.db-shm` from the
volume, start it, and look for `post-restore integrity check passed`.

### Rehearsal, 2026-11-15

Locally, Litestream 0.5.17 (darwin-arm64) against a `file` replica, the built
site, `apps/site/start.sh` with `LITESTREAM_CONFIG` pointed at a file-replica
copy of `litestream.yml`, and dummy keys:

| Step | Result |
|---|---|
| File present, replica empty | `THE REPLICA IS EMPTY`, `snapshot complete`, site served |
| Restart; heartbeat; a row written to `options` | `user_version` set at start; the row reached the replica within a second |
| `restore-check.sh` while running | `integrity_check: ok`; all 87 tables' counts equal to the live file's |
| File deleted, restart | `post-restore integrity check passed`; the row and all 87 tables back; site served |
| Missing `LITESTREAM_BUCKET` | Refused, exit 1 |
| File missing, replica empty | `no matching backup files available`, refused, no `emdash.db` created |
| `RAILWAY_ENVIRONMENT_ID` set, started without `start.sh` | EmDash route 503 with the log line; landing page 200 |

No public request started EmDash's runtime (no scheduler write in 5 minutes),
which is why the heartbeat is ours. Not yet rehearsed: against R2, uploads to
R2, and the built image.
