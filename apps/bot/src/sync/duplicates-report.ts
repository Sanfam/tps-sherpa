/**
 * Reports possible duplicate threads for a mod to judge.
 *
 *   node src/sync/duplicates-report.ts
 *
 * Prints the message. It does **not** post to Discord — the bot posting
 * anywhere for the first time is a stop condition in the handoff, and that is
 * a separate, deliberate decision.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Entity } from "./catalog.ts";
import { findDuplicateCandidates, formatForMods, type CapturedMessage } from "./duplicates.ts";

const catalog: Entity[] = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../../content/index/data.json"), "utf8"),
);
const dbPath = process.env["TIER0_PATH"] ?? resolve(import.meta.dirname, "../../.data/tier0.db");
const db = new DatabaseSync(dbPath);
const messages = db
  .prepare("SELECT entity_id, content, author_is_bot FROM message")
  .all() as Array<{ entity_id: string; content: string; author_is_bot: number }>;

// Without the Message Content intent, capture stores empty `content` for every
// message. This report would then print "No duplicate candidates found" beside
// a healthy-looking scanned count — indistinguishable from a genuinely clean
// corpus, which is the exact failure the intent check exists to prevent.
const empty = messages.filter((m) => m.content.trim().length === 0).length;
if (messages.length > 0 && empty / messages.length > 0.9) {
  console.error(
    `${empty} of ${messages.length} stored messages have empty content. That is ` +
      `the signature of a capture run without the Message Content intent, not a ` +
      `quiet corpus. Re-capture with the intent enabled before trusting this report.`,
  );
  process.exit(1);
}

const candidates = findDuplicateCandidates(
  messages.map(
    (m): CapturedMessage => ({
      entityId: m.entity_id,
      content: m.content,
      authorIsBot: m.author_is_bot === 1,
    }),
  ),
  catalog,
);

console.log(formatForMods(candidates));
console.log(`\n(${messages.length.toLocaleString()} messages scanned, no model involved)`);
db.close();
