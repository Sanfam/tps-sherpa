#!/bin/sh
# The deployed site's startup contract (ADR-0001, "Startup and restore";
# ADR-0002), through scripts/litestream-start.sh: EmDash's database is restored
# if missing, then the site runs under Litestream.
#
# Only EmDash's database is replicated. The session database is disposable
# (ADR-0001), and uploads go to R2 (astro.config.mjs).
#
# Local development and the tests run the site without this script and
# without replication.
set -eu
cd "$(dirname "$0")"

# The same directory the build was given (astro.config.mjs).
export SITE_EMDASH_DB="${SITE_EMDASH_DIR:-$PWD/.data}/emdash.db"
# The gate refuses EmDash's routes on Railway without this, so a start command
# that skips this script cannot take unreplicated edits (emdash-gate.ts).
export SITE_STARTED_BY_ENTRYPOINT=1
exec sh ../../scripts/litestream-start.sh \
  "${LITESTREAM_CONFIG:-$PWD/litestream.yml}" "$SITE_EMDASH_DB" "node --import ./heartbeat.mjs ./dist/server/entry.mjs"
