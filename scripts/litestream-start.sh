#!/bin/sh
# The startup contract for a service's durable SQLite file (ADR-0001, "Startup
# and restore"). Runs before anything opens the file, then runs the service
# under Litestream so the file is replicated for the service's whole lifetime.
#
#   sh scripts/litestream-start.sh <litestream config> <database> <command>
#
#   - File present: use it. Never overwritten from the replica.
#   - File missing: restore it from the replica. A failed restore, unreachable
#     storage or a missing replica refuses to start; never falls back to empty.
#
# Each service's own start.sh calls this: apps/bot/start.sh for bot.db, and
# apps/site/start.sh for EmDash's database. The config names the database
# through a variable the caller exports, so Litestream and the service always
# agree on the file. First initialisation and the restore rehearsals are in
# docs/runbook.md.
set -eu

config="$1"
db="$2"
command="$3"

for name in LITESTREAM_BUCKET LITESTREAM_ENDPOINT LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "[start] $name is not set. Refusing to start: the durable store would not be replicated (ADR-0001)." >&2
    exit 1
  fi
done

if [ -e "$db" ]; then
  echo "[start] Using the durable store at $db."
  # Replicate does not wait for the replica before starting the service, so check
  # it can be reached first. Bad keys or an unreachable endpoint fail, or retry
  # forever, hence the timeout.
  if ! listing=$(timeout 60 litestream ltx -config "$config" -level all "$db"); then
    echo "[start] The replica cannot be reached. Refusing to start: durable writes would not be replicated (ADR-0001)." >&2
    exit 1
  fi
  # One line per replica file after the header; the first column is its level,
  # and level 9 holds snapshots.
  files=$(printf '%s\n' "$listing" | awk 'NR > 1 && NF' | wc -l)
  snapshots=$(printf '%s\n' "$listing" | awk 'NR > 1 && $1 == 9' | wc -l)
  # A young lineage (the service exited before its first snapshot) still starts
  # at transaction 1 and restores from that; only a purged one does not.
  from_start=$(printf '%s\n' "$listing" | awk 'NR > 1 && $2 ~ /^0*1$/' | wc -l)
  if [ "$files" -eq 0 ]; then
    # Resetting on a listing that was wrongly empty would start a second
    # lineage beside the real one, and a restore would pick the older. So an
    # empty answer is asked for again before it is believed.
    sleep "${LITESTREAM_RECHECK_SECONDS:-30}"
    if ! again=$(timeout 60 litestream ltx -config "$config" -level all "$db"); then
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
    echo "[start] THE REPLICA IS EMPTY. Starting a fresh replica from $db. If this is not a first deploy, the bucket was purged: see docs/runbook.md, \"After a long sync outage\"." >&2
    rm -rf "$(dirname "$db")/.$(basename "$db")-litestream"
  elif [ "$snapshots" -eq 0 ] && [ "$from_start" -eq 0 ]; then
    echo "[start] The replica has files but no snapshot and nothing from its first transaction, so it cannot be restored and would not be repaired by replicating onto it. Refusing to start: see docs/runbook.md, \"After a long sync outage\"." >&2
    exit 1
  fi
else
  echo "[start] No durable store at $db. Restoring it from the replica."
  # Restored beside the store and moved into place only once its integrity
  # check has passed: Litestream renames before it checks, so a restore killed
  # mid-check would otherwise leave an unchecked store that the next boot uses.
  restoring="$db.restoring"
  rm -f "$restoring" "$restoring-wal" "$restoring-shm"
  # No -if-replica-exists: a missing replica must fail here, not start empty.
  # Bounded like the reachability check: a timeout refuses like any failure.
  if ! timeout 300 litestream restore -config "$config" -integrity-check full -o "$restoring" "$db"; then
    rm -f "$restoring"
    echo "[start] Restore failed. Refusing to start rather than run on an empty store (ADR-0001)." >&2
    exit 1
  fi
  # A stale WAL beside the store would be replayed over the restored file.
  rm -f "$db-wal" "$db-shm"
  mv "$restoring" "$db"
fi

# The service is Litestream's child: Litestream forwards the stop signal to it,
# and exits when it does, non-zero if the service failed.
exec litestream replicate -config "$config" -exec "$command"
