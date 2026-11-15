// Loaded ahead of the server by start.sh. Litestream snapshots only a database
// that changed, and the bucket's 30-day lifecycle rule would then delete the
// only snapshot a restore needs (docs/runbook.md, "After a long sync outage").
// EmDash writes every minute only once a request has started its runtime, so
// an idle site would not; this rewrites SQLite's user_version hourly instead,
// a header field EmDash does not use, so no table of ours goes in its file.
import { DatabaseSync } from "node:sqlite";

const beat = () => {
  try {
    const db = new DatabaseSync(process.env.SITE_EMDASH_DB, { timeout: 5000 });
    db.exec(`PRAGMA user_version = ${Math.floor(Date.now() / 1000) % 2 ** 31}`);
    db.close();
  } catch (error) {
    console.error("[heartbeat] Write to EmDash's database failed:", error);
  }
};
beat();
setInterval(beat, 60 * 60 * 1000).unref();
