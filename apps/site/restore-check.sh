#!/bin/sh
# Restores EmDash's database from its replica into a scratch directory, runs
# SQLite's integrity check, and prints each table's row count beside the live
# file's, then deletes the copy. Never writes the live file. Run it inside the
# site's container (docs/runbook.md, "The site's database"):
#
#   sh /app/apps/site/restore-check.sh [timestamp, e.g. 2026-11-15T00:00:00Z]
set -eu
cd "$(dirname "$0")"

export SITE_EMDASH_DB="${SITE_EMDASH_DIR:-$PWD/.data}/emdash.db"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

litestream restore -config "${LITESTREAM_CONFIG:-$PWD/litestream.yml}" -integrity-check full \
  ${1:+-timestamp "$1"} -o "$scratch/emdash.db" "$SITE_EMDASH_DB"

node -e '
const { DatabaseSync } = require("node:sqlite");
const { existsSync } = require("node:fs");
const [copyPath, livePath] = process.argv.slice(1);
const copy = new DatabaseSync(copyPath, { readOnly: true });
const live = existsSync(livePath) ? new DatabaseSync(livePath, { readOnly: true }) : null;
console.log("integrity_check:", copy.prepare("PRAGMA integrity_check").get().integrity_check);
const count = (db, t) => {
  try { return db.prepare(`select count(*) n from "${t}"`).get().n; } catch { return "-"; }
};
console.log("table\trestored\tlive");
for (const { name } of copy.prepare("select name from sqlite_master where type = ? order by name").all("table"))
  console.log(`${name}\t${count(copy, name)}\t${count(live, name)}`);
' "$scratch/emdash.db" "$SITE_EMDASH_DB"
