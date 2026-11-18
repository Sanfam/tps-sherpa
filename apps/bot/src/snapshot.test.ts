// The snapshot endpoint as the site meets it (ADR-0001): nothing before the
// first complete sync, then the generation with an ETag the site's next poll
// can match, and nothing of a member's own Discord denies.
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

let dir: string;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

test("the site gets nothing before the first sync, then the generation, then a cheap 304 until it changes", async () => {
  dir = mkdtempSync(join(tmpdir(), "snapshot-"));
  const path = join(dir, "bot.db");
  // The store's default path is read when its module loads.
  vi.stubEnv("BOT_DB_PATH", path);
  vi.stubEnv("SNAPSHOT_PORT", "0");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  const { initDurableStore, openDurableStore } = await import("./sync/durable-store.ts");
  const { startSnapshotServer } = await import("./snapshot.ts");

  initDurableStore(path, { exclusionSeed: null, catalog: null, roleManifest: null });
  const server = startSnapshotServer();
  try {
    await once(server, "listening");
    const url = `http://[::1]:${(server.address() as AddressInfo).port}/snapshot`;

    expect((await fetch(url)).status).toBe(503);

    const channel = {
      id: "1100000000000000001", type: "channel", name: "general", url: "https://discord.com/channels/1/1100000000000000001",
      parent_id: null, description_status: "present", topic: null, applied_tags: [], region: [], topics: [],
      topics_version: null, thread_state: null, last_message_id: null, last_activity_at: null,
      summary_generated: null, summary_override: null, allow_roles: [], view_roles: ["300000000000000001"], deny_roles: [],
    } as const;
    const sync = (name: string) => {
      const store = openDurableStore(path);
      store.replaceCatalog({
        catalog: [{ ...channel, name, applied_tags: [], region: [], topics: [], allow_roles: [], view_roles: [...channel.view_roles], deny_roles: [] }],
        roleManifest: [],
        outcome: { complete: true },
        // A member whose own overwrite hides the channel: bot-side member data.
        memberDenies: [{ placeId: channel.id, memberId: "900000000000000042" }],
      });
      store.close();
    };

    sync("general");
    const first = await fetch(url);
    const body = await first.text();
    const etag = first.headers.get("ETag")!;
    expect(first.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ version: 1, outcome: { complete: true }, catalog: [{ name: "general" }] });
    expect(body).not.toContain("900000000000000042");

    expect((await fetch(url, { headers: { "If-None-Match": etag } })).status).toBe(304);

    sync("general-chat");
    const changed = await fetch(url, { headers: { "If-None-Match": etag } });
    expect(changed.status).toBe(200);
    expect(JSON.parse(await changed.text()).catalog[0].name).toBe("general-chat");
  } finally {
    server.close();
  }
});
