#!/bin/sh
# The deployed bot's startup contract (ADR-0001, "Startup and restore"). Runs
# before anything opens the durable store, then runs the bot under Litestream
# so the store is replicated for the bot's whole lifetime.
#
#   - Store present: use it. Never overwritten from the replica.
#   - Store missing: restore it from the replica. A failed restore, unreachable
#     storage or a missing replica refuses to start; never falls back to empty.
#   - Then serve.ts checks the initialisation marker, as it always has.
#
# Local development runs `node apps/bot/src/serve.ts` directly, without this
# script and without replication. First initialisation and the restore
# rehearsal are in docs/runbook.md.
set -eu

export BOT_DB_PATH="${BOT_DB_PATH:-/app/apps/bot/.data/bot.db}"
config="${LITESTREAM_CONFIG:-/app/apps/bot/litestream.yml}"

for name in LITESTREAM_BUCKET LITESTREAM_ENDPOINT LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "[start] $name is not set. Refusing to start: the durable store would not be replicated (ADR-0001)." >&2
    exit 1
  fi
done

if [ -e "$BOT_DB_PATH" ]; then
  echo "[start] Using the durable store at $BOT_DB_PATH."
  # Replicate does not wait for the replica before starting the bot, so check
  # it can be reached first. Bad keys or an unreachable endpoint fail, or retry
  # forever, hence the timeout.
  if ! listing=$(timeout 60 litestream ltx -config "$config" -level all "$BOT_DB_PATH"); then
    echo "[start] The replica cannot be reached. Refusing to start: durable writes would not be replicated (ADR-0001)." >&2
    exit 1
  fi
  # One line per replica file after the header; the first column is its level,
  # and level 9 holds snapshots.
  files=$(printf '%s\n' "$listing" | awk 'NR > 1 && NF' | wc -l)
  snapshots=$(printf '%s\n' "$listing" | awk 'NR > 1 && $1 == 9' | wc -l)
  # A young lineage (the bot exited before its first snapshot) still starts
  # at transaction 1 and restores from that; only a purged one does not.
  from_start=$(printf '%s\n' "$listing" | awk 'NR > 1 && $2 ~ /^0*1$/' | wc -l)
  if [ "$files" -eq 0 ]; then
    # Resetting on a listing that was wrongly empty would start a second
    # lineage beside the real one, and a restore would pick the older. So an
    # empty answer is asked for again before it is believed.
    sleep "${LITESTREAM_RECHECK_SECONDS:-30}"
    if ! again=$(timeout 60 litestream ltx -config "$config" -level all "$BOT_DB_PATH"); then
      echo "[start] The replica cannot be reached. Refusing to start: durable writes would not be replicated (ADR-0001)." >&2
      exit 1
    fi
    if [ "$(printf '%s\n' "$again" | awk 'NR > 1 && NF' | wc -l)" -ne 0 ]; then
      echo "[start] The replica listed empty, then not. Refusing to start rather than guess: see docs/runbook.md, \"After a long sync outage\"." >&2
      exit 1
    fi
    # First replication, or the lifecycle rule emptied the bucket. Litestream's
    # local state would still remember the deleted files and build on them,
    # leaving every later write unrestorable; without it, replication starts
    # afresh with an immediate snapshot.
    echo "[start] THE REPLICA IS EMPTY. Starting a fresh replica from $BOT_DB_PATH. If this is not a first deploy, the bucket was purged: see docs/runbook.md, \"After a long sync outage\"." >&2
    rm -rf "$(dirname "$BOT_DB_PATH")/.$(basename "$BOT_DB_PATH")-litestream"
  elif [ "$snapshots" -eq 0 ] && [ "$from_start" -eq 0 ]; then
    echo "[start] The replica has files but no snapshot and nothing from its first transaction, so it cannot be restored and would not be repaired by replicating onto it. Refusing to start: see docs/runbook.md, \"After a long sync outage\"." >&2
    exit 1
  fi
else
  echo "[start] No durable store at $BOT_DB_PATH. Restoring it from the replica."
  # Restored beside the store and moved into place only once its integrity
  # check has passed: Litestream renames before it checks, so a restore killed
  # mid-check would otherwise leave an unchecked store that the next boot uses.
  restoring="$BOT_DB_PATH.restoring"
  rm -f "$restoring" "$restoring-wal" "$restoring-shm"
  # No -if-replica-exists: a missing replica must fail here, not start empty.
  # Bounded like the reachability check: a timeout refuses like any failure.
  if ! timeout 300 litestream restore -config "$config" -integrity-check full -o "$restoring" "$BOT_DB_PATH"; then
    rm -f "$restoring"
    echo "[start] Restore failed. Refusing to start rather than run on an empty store (ADR-0001)." >&2
    exit 1
  fi
  # A stale WAL beside the store would be replayed over the restored file.
  rm -f "$BOT_DB_PATH-wal" "$BOT_DB_PATH-shm"
  mv "$restoring" "$BOT_DB_PATH"
fi

# The bot is Litestream's child: Litestream forwards the stop signal to it, and
# exits when it does, non-zero if the bot failed. Run from /app, as serve.ts
# always has been.
# serve.ts refuses to start on Railway without this, so a start command that
# skips this script fails loudly instead of running unreplicated.
export BOT_STARTED_BY_ENTRYPOINT=1
exec litestream replicate -config "$config" -exec "node apps/bot/src/serve.ts"
