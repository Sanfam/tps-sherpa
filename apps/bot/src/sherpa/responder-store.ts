/**
 * The introductions responder's durable state (design §5): the `introduction`
 * row of a member being watched or lately answered, the invited path's
 * `invitation` row, the `tombstone` that keeps it to one autonomous post per
 * membership (a rejoin with a new `joined_at` admits again, F10), and Staff's `sherpa_setting`s. In the durable store, beside the
 * opt-outs every write here is checked against.
 *
 * Every operation is synchronous, and one statement or one transaction, so the
 * runtime calls it after its last `await` and nothing interleaves with it.
 * Every claim is an `UPDATE … WHERE` that changes one row or none: a second
 * attempt — another connection, a redelivered event, a restart — finds the
 * claim taken and gets false. A crash costs a missed post, never a second one
 * (F12).
 *
 * No Discord and no clock here: the runtime decides when, and this records it.
 */
import type { DatabaseSync } from "node:sqlite";
import { DURABLE_STORE_PATH, openDurableDatabase, transaction } from "../sync/durable-store.ts";

/** Text extractions per watch (§3), and invited exchanges per `invitation` row (§9). */
export const MAX_EXTRACTIONS = 3;
export const MAX_EXCHANGES = 3;
/** Images sent to the vision call per member, both rows together (§4). */
export const MAX_IMAGES = 6;
/** `introduction` rows from `started_at`, `invitation` rows from `last_at` (§5, F9). */
export const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

export type Outcome = "responded" | "expired" | "failed";
export type Reason = "recommended" | "welcome_only" | "question" | "cap" | "error" | "off";

export const MODES = ["off", "shadow", "live"] as const;
export type Mode = (typeof MODES)[number];
export type SettingKey =
  | "mode"
  | "clock"
  | "greet_minutes"
  | "recommend_minutes"
  | "ceiling_active_hours"
  | "on_since"
  | "seed_until"
  | "seeded_at"
  | "shadow_first_at"
  | "shadow_notice_at"
  | "alerts"
  | "alerts_on_since"
  | "mentions_mode";

/** A message that fed the watch. `imagesRead`: its images went to the vision call. */
export interface ContributingMessage {
  id: string;
  editedAt: string | null;
  imagesRead: boolean;
}

export interface Introduction {
  memberId: string;
  /** The intro first. */
  messages: ContributingMessage[];
  startedAt: string;
  joinedAt: string;
  extractions: number;
  imagesRead: number;
  postedAt: string | null;
  outcome: Outcome | null;
  reason: Reason | null;
}

interface IntroductionRow {
  member_id: string;
  message_ids: string;
  started_at: string;
  joined_at: string;
  extractions: number;
  images_read: number;
  posted_at: string | null;
  outcome: Outcome | null;
  reason: Reason | null;
}

const toIntroduction = (r: IntroductionRow): Introduction => ({
  memberId: r.member_id,
  messages: (JSON.parse(r.message_ids) as Array<{ id: string; edited_at: string | null; images_read: boolean }>).map(
    (m) => ({ id: m.id, editedAt: m.edited_at, imagesRead: m.images_read }),
  ),
  startedAt: r.started_at,
  joinedAt: r.joined_at,
  extractions: r.extractions,
  imagesRead: r.images_read,
  postedAt: r.posted_at,
  outcome: r.outcome,
  reason: r.reason,
});

/** The watch is open: no post claimed, not closed. */
const WATCHED = "posted_at IS NULL AND outcome IS NULL";

/** The index of `:message` in the row's `message_ids`, or no row. */
const ENTRY = "SELECT key FROM json_each(introduction.message_ids) WHERE value ->> 'id' = :message";

/**
 * The tombstones from the `introduction` rows `where` picks. Each replaces the
 * member's earlier tombstone — a rejoin moves `joined_at` on — except a seeded
 * one, whose NULL `joined_at` blocks for good (§5, F10).
 */
const tombstonesFrom = (where: string) => `
  INSERT INTO tombstone (member_id, joined_at, closed_at)
    SELECT member_id, joined_at, :at FROM introduction WHERE ${where}
  ON CONFLICT (member_id) DO UPDATE SET joined_at = excluded.joined_at, closed_at = excluded.closed_at
    WHERE tombstone.joined_at IS NOT NULL`;
const TOMBSTONE_FROM_ROW = tombstonesFrom("member_id = :member");

/** Opens on the durable store's path, through its startup contract: the same pragmas, `secure_delete` with them. */
export const openResponderStore = (path: string = DURABLE_STORE_PATH) => {
  const db = openDurableDatabase(path);
  const changedOne = (sql: string, params: Record<string, string | number | null>) =>
    db.prepare(sql).run(params).changes === 1;

  return {
    introduction: (memberId: string): Introduction | null => {
      const row = db.prepare("SELECT * FROM introduction WHERE member_id = ?").get(memberId) as
        | IntroductionRow
        | undefined;
      return row ? toIntroduction(row) : null;
    },

    /** Every row, open and closed, oldest first: for the startup catch-up and the erasure loop. */
    introductions: (): Introduction[] =>
      (db.prepare("SELECT * FROM introduction ORDER BY started_at").all() as unknown as IntroductionRow[]).map(
        toIntroduction,
      ),

    /**
     * Starts a watch. False, and nothing written, if the member has a row, a
     * tombstone blocking `joinedAt` (the same one, or a seeded one), or either
     * setting off.
     *
     * A closed row from before a rejoin (another `joinedAt`) is deleted first,
     * in the same transaction, so the 30-day row does not hold off the rejoin
     * lapse (F10). An open row always blocks, rejoin or not: the watch carries
     * on as it was.
     */
    startIntroduction: (
      memberId: string,
      intro: { messageId: string; editedAt: string | null; joinedAt: string },
      at: Date = new Date(),
    ): boolean =>
      transaction(
        db,
        () => {
          db.prepare(
            "DELETE FROM introduction WHERE member_id = ? AND outcome IS NOT NULL AND joined_at != ?",
          ).run(memberId, intro.joinedAt);
          return changedOne(
            `INSERT INTO introduction (member_id, message_ids, started_at, joined_at)
               SELECT :member, :messages, :at, :joined
               WHERE NOT EXISTS (SELECT 1 FROM introduction WHERE member_id = :member)
                 AND NOT EXISTS (SELECT 1 FROM tombstone WHERE member_id = :member
                                   AND (joined_at IS NULL OR joined_at = :joined))
                 AND NOT EXISTS (SELECT 1 FROM preference WHERE member_id = :member AND allowed = 0)`,
            {
              member: memberId,
              messages: JSON.stringify([{ id: intro.messageId, edited_at: intro.editedAt, images_read: false }]),
              at: at.toISOString(),
              joined: intro.joinedAt,
            },
          );
        },
        "IMMEDIATE",
      ),

    /** Adds a follow-up that feeds the watch, or moves a listed one's `edited_at`. False once the watch is over. */
    recordMessage: (memberId: string, messageId: string, editedAt: string | null): boolean =>
      changedOne(
        `UPDATE introduction SET message_ids = CASE
           WHEN EXISTS (${ENTRY})
             THEN json_set(message_ids, '$[' || (${ENTRY}) || '].edited_at', :edited)
           ELSE json_insert(message_ids, '$[#]',
                  json_object('id', :message, 'edited_at', :edited, 'images_read', json('false')))
         END
         WHERE member_id = :member AND ${WATCHED}`,
        { member: memberId, message: messageId, edited: editedAt },
      ),

    /**
     * Before a rebuild's extraction after a restart: at most `MAX_EXTRACTIONS`
     * per watch, apart from the text allowance, so a crash loop cannot spend
     * the daily cap on one row.
     */
    claimRebuild: (memberId: string): boolean =>
      changedOne(
        `UPDATE introduction SET rebuilds = rebuilds + 1
         WHERE member_id = :member AND rebuilds < ${MAX_EXTRACTIONS} AND ${WATCHED}`,
        { member: memberId },
      ),

    /** Before each text extraction call: at most `MAX_EXTRACTIONS` per watch. */
    claimExtraction: (memberId: string): boolean =>
      changedOne(
        `UPDATE introduction SET extractions = extractions + 1
         WHERE member_id = :member AND extractions < ${MAX_EXTRACTIONS} AND ${WATCHED}`,
        { member: memberId },
      ),

    /**
     * Before a message's vision call: claims its `count` images, all or none.
     * False if that message's images were already claimed — a second event
     * for it sends nothing — or if they would take the member past
     * `MAX_IMAGES`, counting their `invitation` row too.
     */
    claimImages: (memberId: string, messageId: string, count: number): boolean =>
      changedOne(
        `UPDATE introduction
         SET message_ids = json_set(message_ids, '$[' || (${ENTRY}) || '].images_read', json('true')),
             images_read = images_read + :count
         WHERE member_id = :member AND ${WATCHED}
           AND EXISTS (SELECT 1 FROM json_each(introduction.message_ids)
                       WHERE value ->> 'id' = :message AND NOT (value ->> 'images_read'))
           AND images_read + :count
               + COALESCE((SELECT images_read FROM invitation WHERE member_id = :member), 0) <= ${MAX_IMAGES}`,
        { member: memberId, message: messageId, count },
      ),

    /** Before the one autonomous post. False after it was claimed once, restarts included. */
    claimPost: (memberId: string, at: Date = new Date()): boolean =>
      changedOne(`UPDATE introduction SET posted_at = :at WHERE member_id = :member AND ${WATCHED}`, {
        member: memberId,
        at: at.toISOString(),
      }),

    /** Ends the watch, and writes the tombstone with it. False if it was already closed. */
    closeIntroduction: (memberId: string, outcome: Outcome, reason: Reason, at: Date = new Date()): boolean =>
      transaction(
        db,
        () => {
          const closed = changedOne(
            "UPDATE introduction SET outcome = :outcome, reason = :reason WHERE member_id = :member AND outcome IS NULL",
            { member: memberId, outcome, reason },
          );
          if (closed) db.prepare(TOMBSTONE_FROM_ROW).run({ member: memberId, at: at.toISOString() });
          return closed;
        },
        "IMMEDIATE",
      ),

    /**
     * Before an invited exchange: whether the member may be answered on the
     * invited path, creating their `invitation` row if they have none. Only
     * `processing` and an open, unposted `introduction` row refuse: a closed
     * row, a tombstone and `approach` do not, because the member asked (§9,
     * F9). Refused, nothing is written — an erasure is not undone by the
     * member's next mention.
     */
    openInvitation: (memberId: string, at: Date = new Date()): boolean =>
      transaction(
        db,
        () => {
          const { admitted } = db
            .prepare(
              `SELECT NOT EXISTS (SELECT 1 FROM preference
                                  WHERE member_id = :member AND setting = 'processing' AND allowed = 0)
                  AND NOT EXISTS (SELECT 1 FROM introduction WHERE member_id = :member AND ${WATCHED})
                  AS admitted`,
            )
            .get({ member: memberId }) as { admitted: number };
          if (!admitted) return false;
          db.prepare("INSERT OR IGNORE INTO invitation (member_id, last_at) VALUES (?, ?)").run(
            memberId,
            at.toISOString(),
          );
          return true;
        },
        "IMMEDIATE",
      ),

    /** The member's `invitation` row: how many exchanges are used, for the third's reply (§9). */
    invitation: (memberId: string): { exchanges: number; imagesRead: number; lastAt: string } | null => {
      const row = db.prepare("SELECT exchanges, images_read, last_at FROM invitation WHERE member_id = ?").get(memberId) as
        | { exchanges: number; images_read: number; last_at: string }
        | undefined;
      return row ? { exchanges: row.exchanges, imagesRead: row.images_read, lastAt: row.last_at } : null;
    },

    /**
     * Claims one invited exchange, and with it the triggering message's
     * `images`, all or none, under `MAX_IMAGES` across both rows. Returns how
     * many images it may send, or null once `MAX_EXCHANGES` are used (or
     * there is no row), and then nothing is recorded. `last_at` moves only on
     * a claimed exchange, so the 30 days run from the last real one.
     */
    claimExchange: (memberId: string, images: number, at: Date = new Date()): number | null =>
      transaction(
        db,
        () => {
          const before = db.prepare("SELECT images_read FROM invitation WHERE member_id = ?").get(memberId) as
            | { images_read: number }
            | undefined;
          if (!before) return null;
          const after = db
            .prepare(
              `UPDATE invitation SET exchanges = exchanges + 1, last_at = :at,
                 images_read = images_read + CASE
                   WHEN images_read + :images
                        + COALESCE((SELECT images_read FROM introduction WHERE member_id = :member), 0) <= ${MAX_IMAGES}
                   THEN :images ELSE 0 END
               WHERE member_id = :member AND exchanges < ${MAX_EXCHANGES}
               RETURNING images_read`,
            )
            .get({ member: memberId, images, at: at.toISOString() }) as { images_read: number } | undefined;
          return after ? after.images_read - before.images_read : null;
        },
        "IMMEDIATE",
      ),

    /**
     * The seed (F2): an author-only tombstone for everyone who posted in the
     * Channel before the first deploy. Blocks for good, and never replaces a
     * tombstone already written.
     */
    seedTombstones: (memberIds: Iterable<string>, at: Date = new Date()) => {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO tombstone (member_id, joined_at, closed_at) VALUES (?, NULL, ?)",
      );
      transaction(db, () => {
        for (const id of memberIds) insert.run(id, at.toISOString());
      });
    },

    /**
     * A `/privacy` erasure (§6): both rows deleted, and the tombstone written
     * from the `introduction` row if there was one, in one transaction. An
     * existing tombstone is kept either way (F3). Says which rows there were.
     */
    erase: (memberId: string, at: Date = new Date()): { introduction: boolean; invitation: boolean } =>
      transaction(
        db,
        () => {
          db.prepare(TOMBSTONE_FROM_ROW).run({ member: memberId, at: at.toISOString() });
          return {
            introduction: db.prepare("DELETE FROM introduction WHERE member_id = ?").run(memberId).changes === 1,
            invitation: db.prepare("DELETE FROM invitation WHERE member_id = ?").run(memberId).changes === 1,
          };
        },
        "IMMEDIATE",
      ),

    /**
     * A deleted message that fed a watch, intro or follow-up (§6): its
     * `introduction` row goes, and the tombstone is written. The `invitation`
     * row holds no content and stays. Returns whose row it was, or null.
     */
    eraseMessage: (messageId: string, at: Date = new Date()): string | null =>
      transaction(
        db,
        () => {
          const row = db
            .prepare(`SELECT member_id FROM introduction WHERE EXISTS (${ENTRY})`)
            .get({ message: messageId }) as { member_id: string } | undefined;
          if (!row) return null;
          db.prepare(TOMBSTONE_FROM_ROW).run({ member: row.member_id, at: at.toISOString() });
          db.prepare("DELETE FROM introduction WHERE member_id = ?").run(row.member_id);
          return row.member_id;
        },
        "IMMEDIATE",
      ),

    /**
     * Age (§6): `introduction` rows 30 days after `started_at`, with their
     * tombstones written as on any erasure, and `invitation` rows 30 days
     * after their last exchange, which resets the cap (F9).
     */
    purge: (now: Date = new Date()): { introductions: number; invitations: number } =>
      transaction(
        db,
        () => {
          const cutoff = new Date(now.getTime() - RETAIN_MS).toISOString();
          const at = now.toISOString();
          db.prepare(tombstonesFrom("started_at < :cutoff")).run({ at, cutoff });
          return {
            introductions: Number(db.prepare("DELETE FROM introduction WHERE started_at < ?").run(cutoff).changes),
            invitations: Number(db.prepare("DELETE FROM invitation WHERE last_at < ?").run(cutoff).changes),
          };
        },
        "IMMEDIATE",
      ),

    setting: (key: SettingKey): string | null =>
      (db.prepare("SELECT value FROM sherpa_setting WHERE key = ?").get(key) as { value: string } | undefined)
        ?.value ?? null,

    setSetting: (key: SettingKey, value: string, by: string, at: Date = new Date()) => {
      writeSetting(db, key, value, by, at);
    },

    /** `off` with no row, or one it cannot read: `live` is never a default (§7). */
    mode: (): Mode => readMode(db),

    /**
     * Sets the mode. `on_since` moves only on a switch out of `off`, so a
     * `shadow` → `live` switch leaves it, and the catch-up's floor, where it
     * was (§2). `shadow_first_at` is written the first time the mode is
     * `shadow` and never moved: the go-live bar's 14 days run from it (§8).
     */
    setMode: (mode: Mode, by: string, at: Date = new Date()) => {
      transaction(
        db,
        () => {
          if (readMode(db) === "off" && mode !== "off") writeSetting(db, "on_since", at.toISOString(), by, at);
          writeSetting(db, "mode", mode, by, at);
          if (mode === "shadow" && !db.prepare("SELECT 1 FROM sherpa_setting WHERE key = 'shadow_first_at'").get())
            writeSetting(db, "shadow_first_at", at.toISOString(), by, at);
        },
        "IMMEDIATE",
      );
    },

    /**
     * The seed's boundary, written only if absent, so a restart mid-seed
     * resumes against the first one rather than moving it on (§3). Returns
     * the boundary as stored.
     */
    seedUntil: (snowflake: string, by: string, at: Date = new Date()): string => {
      db.prepare(
        "INSERT OR IGNORE INTO sherpa_setting (key, value, set_by, set_at) VALUES ('seed_until', ?, ?, ?)",
      ).run(snowflake, by, at.toISOString());
      return (db.prepare("SELECT value FROM sherpa_setting WHERE key = 'seed_until'").get() as { value: string })
        .value;
    },

    close: () => db.close(),
  };
};

export type ResponderStore = ReturnType<typeof openResponderStore>;

/** Opens the store for one piece of work and closes it again, whatever happens. */
export const withResponderStore = <T>(work: (store: ResponderStore) => T, path: string = DURABLE_STORE_PATH): T => {
  const store = openResponderStore(path);
  try {
    return work(store);
  } finally {
    store.close();
  }
};

const readMode = (db: DatabaseSync): Mode => {
  const row = db.prepare("SELECT value FROM sherpa_setting WHERE key = 'mode'").get() as { value: string } | undefined;
  return MODES.find((m) => m === row?.value) ?? "off";
};

const writeSetting = (db: DatabaseSync, key: SettingKey, value: string, by: string, at: Date) => {
  db.prepare(
    `INSERT INTO sherpa_setting (key, value, set_by, set_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at`,
  ).run(key, value, by, at.toISOString());
};
