import { describe, expect, it } from "vitest";
import { fetchStill, imagesOf } from "./responder-images.ts";

const proxy = (name: string) => `https://media.discordapp.net/attachments/1/2/${name}?ex=a&is=b&hm=c`;
const attachment = (name: string, content_type: string, size = {}) =>
  ({ id: name, filename: name, size: 1, url: "x", proxy_url: proxy(name), content_type, ...size }) as never;

describe("imagesOf", () => {
  it("takes image attachments and gifv/image embeds, and nothing else", () => {
    const images = imagesOf({
      attachments: [attachment("a.gif", "image/gif"), attachment("b.pdf", "application/pdf"), attachment("c.mp4", "video/mp4")],
      embeds: [
        { type: "gifv", image: { proxy_url: proxy("img"), url: "u" }, thumbnail: { proxy_url: proxy("thumb"), url: "u" } },
        { type: "image", thumbnail: { proxy_url: proxy("pasted"), url: "u" } },
        { type: "link", thumbnail: { proxy_url: proxy("link"), url: "u" } },
        { type: "rich", image: { proxy_url: proxy("rich"), url: "u" } },
      ],
      // stickers are not on the Pick: they are never read
    } as never);
    expect(images.map((i) => i.proxyUrl)).toEqual([proxy("a.gif"), proxy("img"), proxy("pasted")]);
  });

  it("falls back to the thumbnail when an embed has no image", () => {
    const [image] = imagesOf({
      attachments: [],
      embeds: [{ type: "gifv", thumbnail: { proxy_url: proxy("thumb"), url: "u", width: 320, height: 200 } }],
    } as never);
    expect(image).toEqual({ proxyUrl: proxy("thumb"), width: 320, height: 200 });
  });

  it("caps a message at three", () => {
    const four = ["1", "2", "3", "4"].map((n) => attachment(`${n}.png`, "image/png"));
    expect(imagesOf({ attachments: four, embeds: [] } as never)).toHaveLength(3);
  });
});

const respond = (body: Uint8Array | string, type: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { "content-type": type, ...init.headers } });

/** A fake fetch that records the URLs it was asked for. */
const fake = (make: () => Response) => {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  return { urls, inits, fetch: async (url: string, init: RequestInit) => (urls.push(url), inits.push(init), make()) };
};

describe("fetchStill", () => {
  it("makes no request to another host, to http, or to a port", async () => {
    const f = fake(() => respond("x", "image/jpeg"));
    for (const proxyUrl of [
      "https://evil.example/a.png",
      "http://media.discordapp.net/a.png",
      "https://media.discordapp.net.evil.example/a.png",
      "https://cdn.discordapp.com/a.png",
      "https://images-ext-x.discordapp.net/a.png",
      "https://media.discordapp.net:8443/a.png",
      "not a url",
    ])
      expect(await fetchStill({ proxyUrl }, f.fetch)).toBeNull();
    expect(f.urls).toEqual([]);
  });

  it("asks for a jpeg with bounded dimensions, keeping the aspect ratio and the existing query", async () => {
    const f = fake(() => respond("x", "image/jpeg"));
    await fetchStill({ proxyUrl: "https://images-ext-1.discordapp.net/p?ex=a", width: 4000, height: 2000 }, f.fetch);
    await fetchStill({ proxyUrl: proxy("small"), width: 300, height: 200 }, f.fetch);
    await fetchStill({ proxyUrl: proxy("unknown") }, f.fetch);
    const [big, small, unknown] = f.urls.map((u) => new URL(u).searchParams);
    expect([big!.get("ex"), big!.get("format"), big!.get("width"), big!.get("height")]).toEqual(["a", "jpeg", "1024", "512"]);
    expect([small!.get("format"), small!.get("width"), small!.get("height")]).toEqual(["jpeg", "300", "200"]);
    expect([unknown!.get("format"), unknown!.get("width"), unknown!.get("height")]).toEqual(["jpeg", "1024", "1024"]);
  });

  it("returns a data URL for a still", async () => {
    const f = fake(() => respond(new Uint8Array([1, 2, 3]), "image/jpeg; charset=binary"));
    expect(await fetchStill({ proxyUrl: proxy("a") }, f.fetch)).toBe("data:image/jpeg;base64,AQID");
  });

  it("refuses redirects, so an allowed URL cannot lead to another host", async () => {
    const f = fake(() => respond("x", "image/jpeg"));
    await fetchStill({ proxyUrl: proxy("a") }, f.fetch);
    expect(f.inits).toEqual([{ redirect: "error" }]);
  });

  it("skips a failed download instead of failing the caller", async () => {
    expect(await fetchStill({ proxyUrl: proxy("a") }, async () => Promise.reject(new TypeError("fetch failed")))).toBeNull();
  });

  it("skips anything but a JPEG: a GIF, a PNG or WebP that may be animated, non-images, non-2xx", async () => {
    for (const make of [
      () => respond("x", "image/gif"),
      () => respond("x", "image/png"),
      () => respond("x", "image/webp"),
      () => respond("x", "text/html"),
      () => respond("x", "image/jpeg", { status: 404 }),
    ])
      expect(await fetchStill({ proxyUrl: proxy("a") }, fake(make).fetch)).toBeNull();
  });

  it("skips a body over 4 MB, by header and by actual bytes", async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    expect(
      await fetchStill({ proxyUrl: proxy("a") }, fake(() => respond("x", "image/jpeg", { headers: { "content-length": String(big.length) } })).fetch),
    ).toBeNull();
    // No honest header: the body itself is cut off.
    const lying = () => respond(big, "image/jpeg", { headers: { "content-length": "10" } });
    expect(await fetchStill({ proxyUrl: proxy("a") }, fake(lying).fetch)).toBeNull();
    const exact = new Uint8Array(4 * 1024 * 1024);
    expect(await fetchStill({ proxyUrl: proxy("a") }, fake(() => respond(exact, "image/jpeg")).fetch)).not.toBeNull();
  });
});
