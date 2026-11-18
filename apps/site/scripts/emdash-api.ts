/**
 * What the scripts that write to a running site through EmDash's REST API
 * share (import-wiki.ts, enrich-works.ts): the API client signed in with the
 * site's session cookie, the repository check for files that must stay out of
 * git, a guarded fetch for remote images, and the media upload.
 */
import { execFileSync } from "node:child_process";
import { lookup, type LookupAddress } from "node:dns";
import { realpathSync } from "node:fs";
import { get } from "node:https";
import { BlockList, isIP } from "node:net";
import { dirname, sep } from "node:path";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * EmDash's API on `siteArg`, which must be https, or http on a loopback host,
 * since the cookie goes to it. The cookie is sent and never printed.
 */
export function connect(siteArg: string, cookie: string | undefined) {
  const siteUrl = new URL(siteArg);
  const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(siteUrl.hostname);
  if (!(siteUrl.protocol === "https:" || (siteUrl.protocol === "http:" && loopback))) {
    throw new Error("--site must be https, or http on a loopback host");
  }
  const site = siteUrl.origin;

  /** A call to EmDash's API; its `data`, or a thrown error with EmDash's message. */
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${site}/_emdash/api${path}`, {
      method,
      headers: {
        cookie: cookie!,
        "X-EmDash-Request": "1",
        ...(body !== undefined && !(body instanceof FormData) && { "content-type": "application/json" }),
      },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string } } | null;
    if (!res.ok || !json?.data) throw new Error(`${method} ${path}: ${res.status} ${json?.error?.message ?? ""}`);
    return json.data;
  }

  /** Every item of a paged listing, following `nextCursor` to the end. */
  async function all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const joiner = path.includes("?") ? "&" : "?";
      const page = await api<{ items: T[]; nextCursor?: string | null }>(
        "GET",
        cursor ? `${path}${joiner}cursor=${encodeURIComponent(cursor)}` : path,
      );
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }

  /** A call that answers 404 for something absent: its data, or null. */
  async function find<T>(path: string): Promise<T | null> {
    try {
      return await api<T>("GET", path);
    } catch (e) {
      if (/: 404 /.test((e as Error).message)) return null;
      throw e;
    }
  }

  return { api, all, find };
}

/** Whether a path lies inside this checkout, or the main checkout its worktree belongs to. */
export function inRepository(path: string) {
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
  const roots = [git("rev-parse", "--show-toplevel"), dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir"))];
  return roots.some((root) => path.startsWith(realpathSync(root) + sep));
}

// Remote images: https only, never to a loopback, private, link-local or other
// non-public address, checked on the address each connection actually uses.
// The ranges are IANA's special-purpose address registries for IPv4 and IPv6
// that are not globally reachable, plus multicast and the reserved 240/4.
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  // unspecified and loopback; NAT64, global and local-use; discard-only; IETF
  // protocol assignments (Teredo among them); documentation; 6to4, which embeds
  // any IPv4 address; SRv6 SIDs; unique-local; link-local; site-local; multicast.
  ["::", 127], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");
// BlockList checks an IPv4-mapped IPv6 address (::ffff:a.b.c.d) against the
// IPv4 rules, and an IPv4 address against ::ffff:0:0/96, so that subnet is not
// listed: it would block every IPv4 address.
const isBlocked = (address: string) => blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");

/** DNS lookup for https.get that refuses a name resolving to any blocked address. */
function publicLookup(
  host: string,
  options: { all?: boolean },
  done: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
) {
  lookup(host, { ...options, all: true }, (err, addresses) => {
    if (err) return done(err, "");
    const bad = addresses.find((a) => isBlocked(a.address));
    if (bad || !addresses[0]) return done(new Error(`refused address for ${host}`), "");
    if (options.all) done(null, addresses);
    else done(null, addresses[0].address, addresses[0].family);
  });
}

/** A remote image, following up to 5 redirects, each checked as the first. */
export function fetchImage(url: string, hops = 0): Promise<{ bytes: Buffer; type: string }> {
  return new Promise((done, fail) => {
    const u = new URL(url);
    if (u.protocol !== "https:") return fail(new Error("not https"));
    const host = u.hostname.replace(/^\[|\]$/g, "");
    // An address literal skips the lookup.
    if (isIP(host) && isBlocked(host)) return fail(new Error(`refused address ${host}`));
    const req = get(u, { lookup: publicLookup as never, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops >= 5) return fail(new Error("too many redirects"));
        return fetchImage(new URL(res.headers.location, u).href, hops + 1).then(done, fail);
      }
      if (status !== 200) {
        res.resume();
        return fail(new Error(`${status}`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) req.destroy(new Error("over 10 MB"));
        else chunks.push(chunk);
      });
      res.on("end", () => done({ bytes: Buffer.concat(chunks), type: res.headers["content-type"] ?? "" }));
      res.on("error", fail);
    });
    req.on("error", fail);
  });
}

export type Media = { id: string; url: string; width?: number; height?: number; mimeType?: string; filename?: string };
type Api = ReturnType<typeof connect>["api"];

/** A file uploaded to the media library. A remote file's type comes from its
 * response, since cover URLs have no extension; EmDash reads a local file's
 * type from its extension. EmDash deduplicates by content hash. */
export async function uploadMedia(api: Api, bytes: Buffer, name: string, type: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type }));
  form.set("deduplicate", "true");
  const { item } = await api<{ item: Media }>("POST", "/media", form);
  return item;
}

/** A works entry's `cover` image field, from an uploaded file. */
export const coverField = (m: Media, alt: string) => ({
  provider: "local",
  id: m.id,
  src: m.url,
  alt,
  width: m.width,
  height: m.height,
  mimeType: m.mimeType,
  filename: m.filename,
});
