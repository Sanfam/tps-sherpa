import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { SchemaRegistry, type Database } from "emdash";
import { runMigrations } from "emdash/db";
import { afterEach, expect, test } from "vitest";
import { createDialect } from "../src/emdash-db.ts";
import { nameForEditor } from "../src/emdash-auth.ts";
import { anonymiseEditor, isAnonymisedEmail, pruneRevisions, purgeHistory } from "../src/emdash-erasure.ts";

const dirs: string[] = [];
const DAY_MS = 24 * 60 * 60_000;
const makeDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "emdash-erasure-"));
  dirs.push(dir);
  process.env.SITE_EMDASH_DIR = dir;
  return dir;
};
const sqliteDate = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
const rawBytes = (path: string) =>
  Buffer.concat(
    [path, `${path}-wal`, `${path}-shm`]
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file)),
  ).toString("utf8");

async function migratedDatabase(dir: string) {
  const path = join(dir, "emdash.db");
  const db = new Kysely<Database>({ dialect: createDialect({ url: `file:${path}` }) });
  await runMigrations(db);
  return { db, path };
}

async function createContentTable(db: Kysely<Database>) {
  await new SchemaRegistry(db).createCollection({
    slug: "testpages",
    label: "Test Pages",
    labelSingular: "Test Page",
    supports: ["drafts", "revisions", "search"],
  });
}

afterEach(() => {
  delete process.env.SITE_EMDASH_DIR;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("EmDash's own connection enables secure_delete and scrubs FTS5 text", async () => {
  const dir = makeDir();
  const { db, path } = await migratedDatabase(dir);
  await sql`CREATE VIRTUAL TABLE _emdash_fts_pages USING fts5(id UNINDEXED, body)`.execute(db);
  await sql`INSERT INTO _emdash_fts_pages (id, body) VALUES ('p1', 'zqxsentinelqz')`.execute(db);
  await db.destroy();

  const held = new DatabaseSync(path);
  const writer = new Kysely<Database>({ dialect: createDialect({ url: `file:${path}` }) });
  expect((await sql<{ secure_delete: number }>`PRAGMA secure_delete`.execute(writer)).rows[0]?.secure_delete).toBe(1);
  await sql`DELETE FROM _emdash_fts_pages WHERE id = 'p1'`.execute(writer);
  await writer.destroy();
  expect(rawBytes(path)).not.toContain("zqxsentinelqz");
  held.close();
});

test("the age prune keeps a recent revision and protected live and draft revisions, and scrubs old bytes", async () => {
  const dir = makeDir();
  const { db, path } = await migratedDatabase(dir);
  await createContentTable(db);
  const old = sqliteDate(Date.now() - 91 * DAY_MS);
  const recent = sqliteDate(Date.now() - (90 * DAY_MS - DAY_MS / 24));
  await sql`
    INSERT INTO revisions (id, collection, entry_id, data, created_at) VALUES
      ('old', 'testpages', 'p1', 'prune-erasure-sentinel', ${old}),
      ('recent', 'testpages', 'p1', 'recent-erasure-sentinel', ${recent}),
      ('live', 'testpages', 'p1', 'live-sentinel', ${old}),
      ('draft', 'testpages', 'p1', 'draft-sentinel', ${old})
  `.execute(db);
  await sql`INSERT INTO ec_testpages (id, live_revision_id, draft_revision_id) VALUES ('p1', 'live', 'draft')`.execute(db);
  await sql`INSERT INTO _emdash_revision_prune_queue (collection, entry_id, revision_id) VALUES ('testpages', 'p1', 'old')`.execute(db);
  await db.destroy();

  const held = new DatabaseSync(path);
  pruneRevisions();
  expect(held.prepare("SELECT id FROM revisions ORDER BY id").all()).toEqual([
    { id: "draft" },
    { id: "live" },
    { id: "recent" },
  ]);
  expect(held.prepare("SELECT * FROM _emdash_revision_prune_queue").all()).toEqual([]);
  expect(rawBytes(path)).not.toContain("prune-erasure-sentinel");
  expect(rawBytes(path)).toContain("recent-erasure-sentinel");
  held.close();
});

test("purge history deletes one entry's old revisions without deleting its live or draft revision", async () => {
  const dir = makeDir();
  const { db, path } = await migratedDatabase(dir);
  await createContentTable(db);
  await sql`
    INSERT INTO revisions (id, collection, entry_id, data) VALUES
      ('old', 'testpages', 'p1', 'purge-history-sentinel'),
      ('live', 'testpages', 'p1', 'live-sentinel'),
      ('draft', 'testpages', 'p1', 'draft-sentinel')
  `.execute(db);
  await sql`INSERT INTO ec_testpages (id, live_revision_id, draft_revision_id) VALUES ('p1', 'live', 'draft')`.execute(db);
  await sql`INSERT INTO _emdash_revision_prune_queue (collection, entry_id, revision_id) VALUES ('testpages', 'p1', 'old')`.execute(db);
  await db.destroy();

  const held = new DatabaseSync(path);
  purgeHistory("testpages", "p1");
  expect(held.prepare("SELECT id FROM revisions ORDER BY id").all()).toEqual([
    { id: "draft" },
    { id: "live" },
  ]);
  expect(held.prepare("SELECT * FROM _emdash_revision_prune_queue").all()).toEqual([]);
  expect(rawBytes(path)).not.toContain("purge-history-sentinel");
  held.close();
});

// A co-editing room stores edits as typed, so text an editor removed from the
// entry stays in its stored updates for an hour after the last edit.
test("purge history erases the entry's co-editing room, and only that room", async () => {
  const dir = makeDir();
  const { db, path } = await migratedDatabase(dir);
  await createContentTable(db);
  await sql`INSERT INTO ec_testpages (id) VALUES ('p1'), ('p2')`.execute(db);
  for (const [id, text] of [["testpages:p1", "zqxroomtypedqz"], ["testpages:p2", "zqxotherroomqz"]] as const) {
    await sql`INSERT INTO _emdash_rooms (room_id, part, record, updated_at) VALUES (${id}, 0, '{}', '2026-11-15T00:00:00.000Z')`.execute(db);
    await sql`INSERT INTO _emdash_room_updates (room_id, seq, part, data) VALUES (${id}, 0, 0, ${Buffer.from(text)})`.execute(db);
  }
  await db.destroy();

  const held = new DatabaseSync(path);
  purgeHistory("testpages", "p1");
  expect(rawBytes(path)).not.toContain("zqxroomtypedqz");
  // Another entry's room may be open with edits not yet saved.
  expect(held.prepare("SELECT room_id FROM _emdash_room_updates").all()).toEqual([{ room_id: "testpages:p2" }]);
  held.close();
});

test("anonymisation erases rooms whose record names the editor, even across the record's parts", async () => {
  const dir = makeDir();
  const { db, path } = await migratedDatabase(dir);
  await sql`INSERT INTO users (id, email, name, role, email_verified) VALUES ('01EDITORONE', '123@discord.local', 'luna', 30, 1)`.execute(db);
  const rooms: [string, string[]][] = [
    ["pages:a", ['{"editors":["01EDITORONE"],"authorId":null}']],
    // Past 1 MB, EmDash splits the record wherever the limit falls.
    ["pages:b", ['{"editors":["01EDITO', 'RONE"],"authorId":null}']],
    ["pages:c", ['{"editors":["01SOMEONEELSE"],"authorId":null}']],
  ];
  for (const [id, parts] of rooms) {
    for (const [part, record] of parts.entries()) {
      await sql`INSERT INTO _emdash_rooms (room_id, part, record, updated_at) VALUES (${id}, ${part}, ${record}, '2026-11-15T00:00:00.000Z')`.execute(db);
    }
    await sql`INSERT INTO _emdash_room_updates (room_id, seq, part, data) VALUES (${id}, 0, 0, ${Buffer.from(`zqx${id}qz`)})`.execute(db);
  }
  await db.destroy();

  const held = new DatabaseSync(path);
  anonymiseEditor("123@discord.local");
  expect(held.prepare("SELECT DISTINCT room_id FROM _emdash_rooms").all()).toEqual([{ room_id: "pages:c" }]);
  expect(held.prepare("SELECT room_id FROM _emdash_room_updates").all()).toEqual([{ room_id: "pages:c" }]);
  expect(rawBytes(path)).not.toContain("zqxpages:aqz");
  expect(rawBytes(path)).not.toContain("zqxpages:bqz");
  held.close();
});

test("anonymisation gives two same-locale editors separate anonymous authors and stays anonymous on sign-in", async () => {
  const dir = makeDir();
  const { db, path } = await migratedDatabase(dir);
  await createContentTable(db);
  await sql`
    INSERT INTO users (id, email, name, role, email_verified, data) VALUES
      ('editor-one', '123@discord.local', 'luna-original', 30, 1, NULL),
      ('editor-two', '456@discord.local', 'nova-original', 30, 1, NULL)
  `.execute(db);
  await sql`
    INSERT INTO revisions (id, collection, entry_id, data, author_id, edited_by) VALUES
      ('r1', 'testpages', 'p1', '{}', 'editor-one', NULL),
      ('r2', 'testpages', 'p2', '{}', 'editor-two', '["editor-two","editor-one"]')
  `.execute(db);
  await sql`
    INSERT INTO ec_testpages (id, author_id, live_revision_id) VALUES
      ('p1', 'editor-one', 'r1'),
      ('p2', 'editor-two', 'r2')
  `.execute(db);
  await sql`
    INSERT INTO _emdash_bylines (id, slug, display_name, user_id, locale, translation_group) VALUES
      ('b1', 'luna-original', 'luna-original', 'editor-one', 'en', 'b1'),
      ('b2', 'nova-original', 'nova-original', 'editor-two', 'en', 'b2')
  `.execute(db);
  await db.destroy();

  const held = new DatabaseSync(path);
  anonymiseEditor("123@discord.local");
  anonymiseEditor("456@discord.local");

  const anonymous = held
    .prepare("SELECT id, email FROM users WHERE data LIKE '%\"anonymous\":true%' ORDER BY email")
    .all() as { id: string; email: string }[];
  expect(anonymous).toHaveLength(2);
  expect(new Set(anonymous.map((row) => row.id)).size).toBe(2);
  expect(held.prepare("SELECT name, data FROM users WHERE email IN ('123@discord.local', '456@discord.local')").all()).toEqual([
    { name: null, data: '{"anonymised":true}' },
    { name: null, data: '{"anonymised":true}' },
  ]);
  expect(held.prepare("SELECT author_id FROM revisions ORDER BY id").all()).toEqual(
    anonymous.map(({ id }) => ({ author_id: id })),
  );
  // EmDash 1.5.0 credits every co-editor of a revision by id, and its revision
  // history names each credited account.
  expect(held.prepare("SELECT edited_by FROM revisions WHERE id = 'r2'").get()).toEqual({
    edited_by: JSON.stringify([anonymous[1]?.id, anonymous[0]?.id]),
  });
  expect(held.prepare("SELECT author_id FROM ec_testpages ORDER BY id").all()).toEqual(
    anonymous.map(({ id }) => ({ author_id: id })),
  );
  const bylines = held.prepare("SELECT user_id, display_name, slug, locale FROM _emdash_bylines ORDER BY id").all();
  expect(bylines).toEqual([
    { user_id: anonymous[0]?.id, display_name: "Anonymous", slug: "anonymous-editor-one", locale: "en" },
    { user_id: anonymous[1]?.id, display_name: "Anonymous", slug: "anonymous-editor-two", locale: "en" },
  ]);
  expect(isAnonymisedEmail("123@discord.local")).toBe(true);
  expect(isAnonymisedEmail("456@discord.local")).toBe(true);
  expect(nameForEditor("123@discord.local", "luna-original")).toBe("Anonymous");
  expect(nameForEditor("456@discord.local", "nova-original")).toBe("Anonymous");
  expect(rawBytes(path)).not.toContain("luna-original");
  expect(rawBytes(path)).not.toContain("nova-original");
  held.close();
});

test("a transaction that reads then writes keeps the write lock against another process, as Litestream writes", async () => {
  const dir = makeDir();
  const path = join(dir, "race.db");
  const setup = new DatabaseSync(path);
  setup.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x TEXT)");
  setup.close();
  const db = new Kysely<{ t: { x: string } }>({ dialect: createDialect({ url: `file:${path}` }) });
  let other = "";
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom("t").selectAll().execute();
    // Another process tries to write mid-transaction. Under a deferred begin it
    // succeeds and leaves this transaction's snapshot stale, so the insert
    // below fails with "database is locked". Under BEGIN IMMEDIATE this
    // transaction already holds the write lock, so it is the other writer that
    // is refused.
    other = spawnSync(process.execPath, [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       try { new DatabaseSync(${JSON.stringify(path)}).exec("INSERT INTO t VALUES ('other')"); console.log("wrote"); }
       catch (e) { console.log(e.message); }`,
    ], { encoding: "utf8" }).stdout.trim();
    await trx.insertInto("t").values({ x: "mine" }).execute();
  });
  expect(other).toBe("database is locked");
  expect((await db.selectFrom("t").select("x").execute()).map((r) => r.x)).toEqual(["mine"]);
  await db.destroy();
});
