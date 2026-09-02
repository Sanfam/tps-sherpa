/**
 * SQLite storage for Tier 0, on the service's own volume.
 *
 * Uses Node's built-in `node:sqlite` — no dependency. Nothing here is backed
 * up: the volume is disposable and the rebuild path is a re-run of the capture.
 */
import { DatabaseSync } from "node:sqlite";

export interface StoredMessage {
  entityId: string;
  messageId: string;
  /**
   * The message author. Kept because bot messages must be dropped and because
   * sampling prefers participant diversity; both need it at selection time and
   * neither can be recomputed later. Bot-side only, never replicated, never
   * published, never sent to a model.
   */
  authorId: string;
  authorIsBot: boolean;
  content: string;
  createdAt: string;
  /** Which window it came from, so sampling can tell opening from recent. */
  window: "head" | "tail";
}

export const openTier0 = (path: string) => {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS captured_entity (
      entity_id       TEXT PRIMARY KEY,
      last_message_id TEXT,
      captured_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message (
      entity_id     TEXT NOT NULL,
      message_id    TEXT NOT NULL,
      author_id     TEXT NOT NULL,
      author_is_bot INTEGER NOT NULL,
      content       TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      window        TEXT NOT NULL,
      PRIMARY KEY (entity_id, message_id)
    );
  `);

  return {
    /** What a previous run already stored, for the incremental decision. */
    state: () => {
      const rows = db
        .prepare("SELECT entity_id, last_message_id FROM captured_entity")
        .all() as Array<{ entity_id: string; last_message_id: string | null }>;
      return new Map(
        rows.map((r) => [r.entity_id, { lastMessageId: r.last_message_id }]),
      );
    },

    record: (
    entityId: string,
    lastMessageId: string | null | undefined,
    messages: StoredMessage[],
  ) => {
      const insertMessage = db.prepare(
        `INSERT OR REPLACE INTO message
           (entity_id, message_id, author_id, author_is_bot, content, created_at, window)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      // Replacing the Entity's rows rather than merging is what lets a
      // deletion propagate: a message removed in Discord disappears here on
      // the next capture of that Entity. Without it, raw member text would
      // outlive the member's own deletion, which is precisely the posture the
      // header claims and would otherwise be false.
      const clearEntity = db.prepare("DELETE FROM message WHERE entity_id = ?");
      const markCaptured = db.prepare(
        `INSERT OR REPLACE INTO captured_entity (entity_id, last_message_id, captured_at)
         VALUES (?, ?, ?)`,
      );
      // One transaction per Entity: a crash mid-run leaves complete Entities
      // captured and the rest simply uncaptured, which the next run picks up.
      db.exec("BEGIN");
      try {
        clearEntity.run(entityId);
        for (const m of messages)
          insertMessage.run(
            m.entityId,
            m.messageId,
            m.authorId,
            m.authorIsBot ? 1 : 0,
            m.content,
            m.createdAt,
            m.window,
          );
        // node:sqlite rejects undefined; a Catalog written before this field
        // existed has no value at all.
        markCaptured.run(entityId, lastMessageId ?? null, new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    stats: () => {
      // CAST AS BLOB: LENGTH() on text counts characters, and this figure is
      // reported as a volume footprint. Emoji-heavy content undercounts ~4x.
      const m = db.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS bytes FROM message",
      ).get() as {
        n: number;
        bytes: number;
      };
      const e = db.prepare("SELECT COUNT(*) AS n FROM captured_entity").get() as { n: number };
      return { messages: m.n, contentBytes: m.bytes, entities: e.n };
    },

    close: () => db.close(),
  };
};
