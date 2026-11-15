#!/bin/sh
# The deployed bot's startup contract (ADR-0001, "Startup and restore"), through
# scripts/litestream-start.sh: bot.db is restored if missing, then the bot runs
# under Litestream. Then serve.ts checks the initialisation marker, as it
# always has.
#
# Local development runs `node apps/bot/src/serve.ts` directly, without this
# script and without replication.
set -eu

export BOT_DB_PATH="${BOT_DB_PATH:-/app/apps/bot/.data/bot.db}"
# serve.ts refuses to start on Railway without this, so a start command that
# skips this script fails loudly instead of running unreplicated.
export BOT_STARTED_BY_ENTRYPOINT=1
# Run from /app, as serve.ts always has been.
exec sh "$(dirname "$0")/../../scripts/litestream-start.sh" \
  "${LITESTREAM_CONFIG:-/app/apps/bot/litestream.yml}" "$BOT_DB_PATH" "node apps/bot/src/serve.ts"
