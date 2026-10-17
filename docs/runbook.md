# Bot runbook

What an operator runs by hand. The decisions behind it are in ADR-0001.

## The bot's durable store: replication and restore

The deployed bot starts through `apps/bot/start.sh`, the root `Dockerfile`'s
entrypoint. It runs ADR-0001's startup contract before anything opens
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
`find-usage.json` on the same volume are not.

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
- Watch paths include `Dockerfile` and `.dockerignore`.

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
