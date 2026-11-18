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

export const snapshotEnvelope = (g: Generation) => ({
  version: 1 as const,
  generatedAt: g.generatedAt,
  syncEveryMs: EVERY_MS,
  // Always complete: the durable store only holds a generation a complete sync wrote.
  outcome: { complete: true as const },
  roleManifest: g.roleManifest,
  catalog: g.catalog,
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
      const body = JSON.stringify(snapshotEnvelope(generation));
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
