import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchStill, fetchStills, imagesOf, takeFrames } from "./responder-images.ts";

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

  it("animates a GIF attachment from itself and a gifv from its MP4, and nothing else", () => {
    const [gif, png] = imagesOf({ attachments: [attachment("a.gif", "image/gif"), attachment("b.png", "image/png")], embeds: [] } as never);
    const [gifv, pasted] = imagesOf({
      attachments: [],
      embeds: [
        { type: "gifv", thumbnail: { proxy_url: proxy("thumb.webp"), url: "u" }, video: { proxy_url: proxy("v.mp4"), url: "u" } },
        { type: "image", thumbnail: { proxy_url: proxy("pasted"), url: "u" }, video: { proxy_url: proxy("x.mp4"), url: "u" } },
      ],
    } as never);
    expect(gif!.animation).toEqual({ proxyUrl: proxy("a.gif"), type: "image/gif" });
    expect(png!.animation).toBeUndefined();
    expect(gifv).toEqual({ proxyUrl: proxy("thumb.webp"), width: undefined, height: undefined, animation: { proxyUrl: proxy("v.mp4"), type: "video/mp4" } });
    expect(pasted!.animation).toBeUndefined();
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

describe("fetchStills", () => {
  const FRAME = Buffer.from([0xff, 0xd8, 0xff, 1]);
  const gif = { proxyUrl: proxy("a.gif"), animation: { proxyUrl: proxy("a.gif"), type: "image/gif" as const } };

  it("returns the animation's frames, in order, as JPEG data URLs, and only asks the proxy", async () => {
    const f = fake(() => respond("GIF89a", "image/gif"));
    const frames = [Buffer.from([0xff, 0xd8, 0xff, 1]), Buffer.from([0xff, 0xd8, 0xff, 2])];
    expect(await fetchStills(gif, f.fetch, async () => frames)).toEqual([
      "data:image/jpeg;base64,/9j/AQ==",
      "data:image/jpeg;base64,/9j/Ag==",
    ]);
    // The animation itself, unscaled, with redirects refused like a still.
    expect(f.urls).toEqual([proxy("a.gif")]);
    expect(f.inits).toEqual([{ redirect: "error" }]);
  });

  it("never fetches an animation off the proxy, and falls back to the still", async () => {
    const f = fake(() => respond("x", "image/jpeg"));
    let decoded = false;
    const offProxy = { ...gif, animation: { proxyUrl: "https://evil.example/a.gif", type: "image/gif" as const } };
    expect(await fetchStills(offProxy, f.fetch, async () => ((decoded = true), [FRAME]))).toEqual(["data:image/jpeg;base64,eA=="]);
    expect(decoded).toBe(false);
    expect(f.urls.map((u) => new URL(u).searchParams.get("format"))).toEqual(["jpeg"]);
  });

  it("falls back to the still when the animation is the wrong type, over 4 MB, or yields no frames", async () => {
    // Each fake serves its body for the animation, then a JPEG for the still.
    const cases: Array<[Response, Buffer[]]> = [
      [respond("x", "image/png"), [FRAME]],
      [respond(new Uint8Array(4 * 1024 * 1024 + 1), "image/gif"), [FRAME]],
      [respond("GIF89a", "image/gif"), []],
    ];
    for (const [animation, frames] of cases) {
      const served = [animation, respond("x", "image/jpeg")];
      const f = fake(() => served.shift()!);
      expect(await fetchStills(gif, f.fetch, async () => frames)).toEqual(["data:image/jpeg;base64,eA=="]);
      expect(f.urls).toHaveLength(2);
    }
  });

  it("is empty when neither the animation nor the still can be had", async () => {
    expect(await fetchStills(gif, fake(() => respond("x", "text/html")).fetch, async () => [FRAME])).toEqual([]);
  });
});

describe("takeFrames (ffmpeg)", () => {
  const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
  /** A frame's colour: decoded to one pixel and named by its strongest channels. */
  const colour = (jpeg: Buffer) => {
    const [r, g, b] = execFileSync("ffmpeg", ["-v", "error", "-f", "mjpeg", "-i", "pipe:0", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: jpeg });
    return r! > 128 && g! > 128 ? "yellow" : r! > 128 ? "red" : g! > 64 ? "green" : b! > 128 ? "blue" : "?";
  };

  it("takes four evenly spaced frames, in order, from a GIF and from an MP4", async () => {
    // The fixtures run red, green, blue, yellow for two frames each: frames from
    // the wrong places, or out of order, show up as the wrong colours.
    for (const [name, type] of [["four-colours.gif", "image/gif"], ["four-colours.mp4", "video/mp4"]] as const)
      expect((await takeFrames(fixture(name), type)).map(colour)).toEqual(["red", "green", "blue", "yellow"]);
  });

  it("yields nothing for bytes that are not the declared type, including a playlist naming a local file", async () => {
    // The demuxer is forced and the protocols are the pipe only: a playlist
    // cannot make ffmpeg open a file, and an MP4 is not read as a GIF.
    expect(await takeFrames(Buffer.from("#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n"), "image/gif")).toEqual([]);
    expect(await takeFrames(fixture("four-colours.mp4"), "image/gif")).toEqual([]);
  });
});
