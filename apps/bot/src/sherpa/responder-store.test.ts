import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDurableStore, withDurableStore } from "../sync/durable-store.ts";
import { openPrivacy } from "./privacy.ts";
import { type ResponderStore, openResponderStore } from "./responder-store.ts";

const MEMBER = "500000000000000001";
const JOINED = "2026-01-01T00:00:00.000000+00:00";
const REJOINED = "2026-09-01T00:00:00.000000+00:00";
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let path: string;
/** Two connections to one file, as two decisions racing would be. */
let a: ResponderStore;
let b: ResponderStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "responder-store-"));
  path = join(dir, "bot.db");
  initDurableStore(path, { exclusionSeed: null, catalog: null, roleManifest: null });
  a = openResponderStore(path);
  b = openResponderStore(path);
});
afterEach(() => {
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

const start = (store: ResponderStore, joinedAt = JOINED, member = MEMBER, at?: Date) =>
  store.startIntroduction(member, { messageId: `intro-${member}`, editedAt: null, joinedAt }, at);
const tombstone = (member = MEMBER) => {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT joined_at FROM tombstone WHERE member_id = ?").get(member);
  db.close();
  return row as { joined_at: string | null } | undefined;
};
const invitation = (member = MEMBER) => {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT exchanges, images_read FROM invitation WHERE member_id = ?").get(member);
  db.close();
  return row as { exchanges: number; images_read: number } | undefined;
};
const setPreference = (setting: "approach" | "processing", allowed: boolean, member = MEMBER) =>
  withDurableStore((s) => s.setPreference(member, setting, allowed), path);

describe("each step is taken once, across two connections", () => {
  it("starts one row", () => {
    expect(start(a)).toBe(true);
    expect(start(b)).toBe(false);
  });

  it("refuses to start a row for a member with either setting off", () => {
    setPreference("approach", false, "1");
    setPreference("processing", false, "2");
    expect(start(a, JOINED, "1")).toBe(false);
    expect(start(a, JOINED, "2")).toBe(false);
    expect(a.introductions()).toEqual([]);
  });

  it("claims the one post once", () => {
    start(a);
    expect(a.claimPost(MEMBER)).toBe(true);
    expect(b.claimPost(MEMBER)).toBe(false);
  });

  it("closes once", () => {
    start(a);
    expect(a.closeIntroduction(MEMBER, "expired", "cap")).toBe(true);
    expect(b.closeIntroduction(MEMBER, "failed", "error")).toBe(false);
    expect(a.introduction(MEMBER)).toMatchObject({ outcome: "expired", reason: "cap" });
  });

  it("claims at most five text extractions as messages arrive, and two more for the reads before the post", () => {
    start(a);
    expect([a, b, a, b, a, b].map((s) => s.claimExtraction(MEMBER))).toEqual([true, true, true, true, true, false]);
    expect([a, b, a].map((s) => s.claimExtraction(MEMBER, true))).toEqual([true, true, false]);
  });

  it("claims a message's images once", () => {
    start(a);
    expect(a.claimImages(MEMBER, `intro-${MEMBER}`, 2)).toBe(true);
    expect(b.claimImages(MEMBER, `intro-${MEMBER}`, 2)).toBe(false);
    expect(a.introduction(MEMBER)).toMatchObject({ imagesRead: 2, messages: [{ imagesRead: true }] });
  });

  it("claims at most three invited exchanges", () => {
    expect(a.openInvitation(MEMBER)).toBe(true);
    expect([a, b, a, b].map((s) => s.claimExchange(MEMBER, 0))).toEqual([0, 0, 0, null]);
  });
});

describe("a restart", () => {
  it("cannot claim a post already claimed, nor feed a watch that is over", () => {
    start(a);
    a.claimPost(MEMBER);
    a.close();
    a = openResponderStore(path);
    expect(a.claimPost(MEMBER)).toBe(false);
    expect(a.claimExtraction(MEMBER)).toBe(false);
    expect(a.recordMessage(MEMBER, "late", null)).toBe(false);
  });
});

describe("the tombstone", () => {
  it("blocks the same joined_at, and admits a rejoin by replacing the closed row", () => {
    start(a);
    a.closeIntroduction(MEMBER, "responded", "recommended");
    expect(start(b)).toBe(false);
    expect(start(b, REJOINED)).toBe(true);
    expect(a.introduction(MEMBER)).toMatchObject({ joinedAt: REJOINED, outcome: null });
    a.closeIntroduction(MEMBER, "expired", "cap");
    expect(tombstone()).toEqual({ joined_at: REJOINED });
  });

  it("lets an open row block across a rejoin: the watch carries on", () => {
    start(a);
    expect(start(b, REJOINED)).toBe(false);
    expect(a.introduction(MEMBER)).toMatchObject({ joinedAt: JOINED, outcome: null });
  });

  it("blocks any joined_at when seeded, and a seeded one is never replaced", () => {
    a.seedTombstones([MEMBER]);
    expect(start(a)).toBe(false);
    expect(start(a, REJOINED)).toBe(false);

    // A row from before a seed reached it: closing and erasing it leave the seed.
    start(a, JOINED, "2");
    a.seedTombstones(["2"]);
    a.closeIntroduction("2", "expired", "cap");
    a.erase("2");
    expect(tombstone("2")).toEqual({ joined_at: null });
  });

  it("is not replaced by a seed", () => {
    start(a);
    a.closeIntroduction(MEMBER, "expired", "cap");
    a.seedTombstones([MEMBER]);
    expect(tombstone()).toEqual({ joined_at: JOINED });
  });
});

describe("erasure", () => {
  it("deletes both rows and writes the tombstone, all in one transaction", () => {
    start(a);
    a.claimPost(MEMBER);
    a.openInvitation(MEMBER);
    // The last of its writes fails: none of them may stand.
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER refuse BEFORE DELETE ON invitation BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(() => a.erase(MEMBER)).toThrow(/refused/);
    expect(a.introduction(MEMBER)).not.toBeNull();
    expect(tombstone()).toBeUndefined();

    db.exec("DROP TRIGGER refuse");
    db.close();
    expect(a.erase(MEMBER)).toEqual({ introduction: true, invitation: true });
    expect([a.introduction(MEMBER), invitation()]).toEqual([null, undefined]);
    expect(tombstone()).toEqual({ joined_at: JOINED });
  });

  it("on a deleted follow-up, erases the introduction row, writes the tombstone, and keeps the invitation row", () => {
    start(a);
    a.recordMessage(MEMBER, "follow-up", null);
    a.claimPost(MEMBER);
    a.openInvitation(MEMBER);
    expect(b.eraseMessage("unrelated")).toBeNull();
    expect(b.eraseMessage("follow-up")).toBe(MEMBER);
    expect(a.introduction(MEMBER)).toBeNull();
    expect(tombstone()).toEqual({ joined_at: JOINED });
    expect(invitation()).toBeDefined();
  });

  for (const [what, act] of [
    ["opt-out approach", (p: ReturnType<typeof openPrivacy>) => p.set(MEMBER, "approach", false)],
    ["opt-out processing", (p: ReturnType<typeof openPrivacy>) => p.set(MEMBER, "processing", false)],
    ["delete-my-data", (p: ReturnType<typeof openPrivacy>) => p.deleteMyData(MEMBER)],
  ] as const)
    it(`by ${what}: rows and memory go at once, stay gone on opting back in, and the tombstone stays`, () => {
      start(a);
      a.claimPost(MEMBER);
      a.openInvitation(MEMBER);
      const dropped: string[] = [];
      const privacy = openPrivacy(
        {
          durable: path,
          tier0: join(dir, "tier0.db"),
          activity: join(dir, "activity.json"),
          policy: join(dir, "privacy-policy.md"),
        },
        (id) => dropped.push(id),
      );
      act(privacy);
      expect(dropped).toEqual([MEMBER]);
      expect([a.introduction(MEMBER), invitation()]).toEqual([null, undefined]);

      privacy.set(MEMBER, "approach", true);
      privacy.set(MEMBER, "processing", true);
      expect([a.introduction(MEMBER), invitation()]).toEqual([null, undefined]);
      expect(tombstone()).toEqual({ joined_at: JOINED });
      expect(start(a)).toBe(false);
    });
});

it("drops the member from memory even when the durable erase fails", () => {
  start(a);
  a.claimPost(MEMBER);
  a.openInvitation(MEMBER);
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER refuse BEFORE DELETE ON invitation BEGIN SELECT RAISE(ABORT, 'refused'); END");
  const dropped: string[] = [];
  const privacy = openPrivacy(
    {
      durable: path,
      tier0: join(dir, "tier0.db"),
      activity: join(dir, "activity.json"),
      policy: join(dir, "privacy-policy.md"),
    },
    (id) => dropped.push(id),
  );
  expect(() => privacy.set(MEMBER, "approach", false)).toThrow(/refused/);
  expect(dropped).toEqual([MEMBER]);
  db.close();
});

describe("the invited path", () => {
  it("is refused only by an open, unposted row: not by a closed one, a tombstone or approach off", () => {
    start(a, JOINED, "watched");
    start(a, JOINED, "posted");
    a.claimPost("posted");
    for (const [member, outcome] of [["expired", "expired"], ["failed", "failed"]] as const) {
      start(a, JOINED, member);
      a.closeIntroduction(member, outcome, "error");
    }
    a.seedTombstones(["seeded"]);
    setPreference("approach", false, "no-approach");

    expect(a.openInvitation("watched")).toBe(false);
    for (const member of ["posted", "expired", "failed", "seeded", "no-approach"])
      expect(a.openInvitation(member)).toBe(true);
    expect(invitation("watched")).toBeUndefined();
  });

  it("with processing off, creates no row", () => {
    setPreference("processing", false);
    expect(a.openInvitation(MEMBER)).toBe(false);
    expect(invitation()).toBeUndefined();
  });

  it("stops images at six, with the introduction row's counted", () => {
    start(a);
    a.recordMessage(MEMBER, "follow-up", null);
    expect(a.claimImages(MEMBER, `intro-${MEMBER}`, 3)).toBe(true);
    a.claimPost(MEMBER);
    a.closeIntroduction(MEMBER, "responded", "question");
    a.openInvitation(MEMBER);
    expect(a.claimExchange(MEMBER, 2)).toBe(2);
    // Over the cap: the exchange is claimed, its images are not.
    expect(a.claimExchange(MEMBER, 2)).toBe(0);
    expect(a.claimExchange(MEMBER, 1)).toBe(1);
    expect(invitation()).toEqual({ exchanges: 3, images_read: 3 });
  });

  it("stops images at six, with the invitation row's counted, after a rejoin", () => {
    a.openInvitation(MEMBER);
    a.claimExchange(MEMBER, 3);
    a.claimExchange(MEMBER, 1);
    expect(start(a, REJOINED)).toBe(true);
    expect(a.claimImages(MEMBER, `intro-${MEMBER}`, 3)).toBe(false);
    expect(a.claimImages(MEMBER, `intro-${MEMBER}`, 2)).toBe(true);
  });
});

describe("age", () => {
  it("deletes introduction rows 30 days from their start, and invitation rows 30 days from their last exchange", () => {
    const now = new Date("2026-10-18T00:00:00Z");
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    start(a, JOINED, "old", ago(31));
    start(a, JOINED, "recent", ago(29));
    // Opened 40 days ago, last exchange 10 days ago: kept.
    a.openInvitation("talking", ago(40));
    a.claimExchange("talking", 0, ago(10));
    a.openInvitation("quiet", ago(31));
    a.claimExchange("quiet", 0, ago(31));

    expect(a.purge(now)).toEqual({ introductions: 1, invitations: 1 });
    expect(a.introductions().map((r) => r.memberId)).toEqual(["recent"]);
    expect([invitation("talking"), invitation("quiet")]).toEqual([{ exchanges: 1, images_read: 0 }, undefined]);
    expect(tombstone("old")).toEqual({ joined_at: JOINED });
  });
});

describe("settings", () => {
  it("is off with no mode set, and on_since moves only on a switch out of off", () => {
    expect(a.mode()).toBe("off");
    const t = (h: number) => new Date(Date.UTC(2026, 9, 18, h));
    a.setMode("shadow", "staff", t(1));
    b.setMode("live", "staff", t(2));
    expect([a.mode(), a.setting("on_since")]).toEqual(["live", t(1).toISOString()]);
    a.setMode("off", "staff", t(3));
    a.setMode("shadow", "staff", t(4));
    expect(a.setting("on_since")).toBe(t(4).toISOString());
  });

  it("writes shadow_first_at on the first shadow only, so a later switch cannot restart the 14 days", () => {
    const t = (h: number) => new Date(Date.UTC(2026, 9, 18, h));
    a.setMode("live", "staff", t(0));
    expect(a.setting("shadow_first_at")).toBeNull();
    a.setMode("shadow", "staff", t(1));
    a.setMode("off", "staff", t(2));
    a.setMode("shadow", "staff", t(3));
    expect(b.setting("shadow_first_at")).toBe(t(1).toISOString());
  });

  it("keeps the first seed_until on a second write", () => {
    expect(a.seedUntil("1428000000000000000", "seed")).toBe("1428000000000000000");
    expect(b.seedUntil("1429000000000000000", "seed")).toBe("1428000000000000000");
  });
});
