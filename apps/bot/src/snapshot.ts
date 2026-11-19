/**
 * The bot's private Catalog snapshot (ADR-0001, "Bot → site: one way, pulled").
 * The site polls `GET /snapshot` over Railway's private network; nothing else
 * leaves the bot. The port is deliberately not `PORT`: Railway routes a public
 * domain to `PORT`, and the bot must have no public port.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { EVERY_MS } from "./serve.ts";
import { withDurableStore, type Generation } from "./sync/durable-store.ts";
import { RETAIN_MS, TIER0_PATH, readActivity as readTier0Activity } from "./sync/tier0-store.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Capture reads the newest 100 messages, bots' included, so near that many held
// means a busy place whose week is cut short; its members' rate comes from the span
// capture read, bots' included. ponytail: a 90-message heuristic, low by opted-out
// members' messages, which are never stored; record capture's fetch count if it misleads.
const SATURATED = 90;

/**
 * Members' messages per place in about the last week, for the Index's order:
 * from the Tier 0 cache, which holds `RETAIN_MS` of them, scaled to seven days.
 * Counts only; bots' and opted-out members' messages are never in it. A place
 * the bot does not read has no entry.
 */
export const weeklyMessages = (
  rows: Array<{ entityId: string; held: number; members: number; oldest: string | null; newest: string | null }>,
): Record<string, number> =>
  Object.fromEntries(
    rows
      .filter((r) => r.members > 0)
      .map(({ entityId, held, members, oldest, newest }) => {
        const span = Date.parse(newest ?? "") - Date.parse(oldest ?? "");
        const over = held >= SATURATED && span > 0 && span < RETAIN_MS ? Math.max(span, 60 * 60 * 1000) : RETAIN_MS;
        return [entityId, Math.round((members * WEEK_MS) / over)];
      }),
  );

/** The Tier 0 activity, or none when the cache cannot be read: the snapshot goes out without it. */
const readActivity = (): Record<string, number> => {
  try {
    return weeklyMessages(readTier0Activity(TIER0_PATH));
  } catch (error) {
    const { name, code } = error as { name?: string; code?: string };
    console.error(`[snapshot] Could not read Tier 0 activity: ${name ?? "error"}${code ? ` (${code})` : ""}`);
    return {};
  }
};

export const snapshotEnvelope = (g: Generation, weekly: Record<string, number> = {}) => ({
  version: 1 as const,
  generatedAt: g.generatedAt,
  syncEveryMs: EVERY_MS,
  // Always complete: the durable store only holds a generation a complete sync wrote.
  outcome: { complete: true as const },
  roleManifest: g.roleManifest,
  catalog: g.catalog,
  /** Entity id → members' messages in about the last week (`weeklyMessages`). */
  weeklyMessages: weekly,
});

export const startSnapshotServer = (): Server => {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/snapshot") {
      res.writeHead(404).end();
      return;
    }
    try {
      const generation = withDurableStore((s) => s.current());
      if (!generation) {
        res.writeHead(503, { "Content-Type": "text/plain" }).end("No Catalog yet.");
        return;
      }
      const body = JSON.stringify(snapshotEnvelope(generation, readActivity()));
      // Keyed on the body, not generatedAt: enrichment patches Entities without moving it.
      const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag }).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", ETag: etag }).end(body);
    } catch (error) {
      // Name and code only: a parse error's message can quote a stored row, which may be member text.
      const { name, code } = error as { name?: string; code?: string };
      console.error(`[snapshot] Could not read the durable store: ${name ?? "error"}${code ? ` (${code})` : ""}`);
      res.writeHead(500, { "Content-Type": "text/plain" }).end("Snapshot unavailable.");
    }
  });
  const port = Number(process.env["SNAPSHOT_PORT"] || 8081);
  // A listen failure must not take Sherpa down with it: the site keeps its last snapshot.
  server.on("error", (error) => console.error("[snapshot] SNAPSHOT ENDPOINT DOWN:", error));
  server.listen(port, "::");
  console.error(`[snapshot] Serving the Catalog snapshot on port ${port}.`);
  return server;
};
