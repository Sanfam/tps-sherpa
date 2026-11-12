/**
 * Which images on an introduction the responder reads, and how one becomes
 * stills. `imagesOf` picks them from a message; `fetchStills` downloads one
 * through Discord's media proxy as base64 data URLs for `readImage`: up to
 * four frames of an animation, else one still, else none. Nothing here is
 * stored, written to disk or logged: a URL or a filename can carry member text
 * (docs/proposals/introductions-responder.md §4, Images and Animated GIFs).
 * The 6-per-member cap lives in the durable store, not here.
 */
import { execFile } from "node:child_process";
import type { APIMessage } from "discord-api-types/v10";

/** At most this many images are read from one message. */
export const IMAGES_PER_MESSAGE = 3;
/** At most this many frames are taken from one animation, evenly spaced. */
export const FRAMES_PER_ANIMATION = 4;
/** The long edge Discord's proxy, and the frame taker, downscale to; smaller sources are not enlarged. */
const LONG_EDGE = 1024;
/** Larger bodies are skipped, by `content-length` and again while reading. */
const MAX_BYTES = 4 * 1024 * 1024;
/** A decoder that has not finished by now is killed, and the image falls back to its still. */
const DECODE_TIMEOUT_MS = 10_000;
/** A download, body included, that has not finished by now is abandoned: a stalled proxy costs one image. */
const DOWNLOAD_TIMEOUT_MS = 15_000;
/**
 * The largest canvas decoded: 4 MB bounds the compressed file, not the frame a
 * decoder must hold, and a small GIF can declare a huge one. 2048 × 2048 keeps
 * one RGBA frame at 16 MB and admits 1080p.
 */
const MAX_PIXELS = 2048 * 2048;

const ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/**
 * Every still URL asks for `format=jpeg`, and only a JPEG is accepted back: PNG
 * and WebP can be animated, so anything else means the proxy ignored the
 * request and the whole animation may be in the body.
 */
const STILL_TYPE = "image/jpeg";
const PROXY_HOST = /^(media|images-ext-\d+)\.discordapp\.net$/;

/** What an animation is downloaded as, and the demuxer forced on it: never probed from the bytes. */
const DEMUXERS = { "image/gif": "gif", "video/mp4": "mp4" } as const;
type AnimationType = keyof typeof DEMUXERS;

/** A message's image, as Discord's media proxy addresses it. */
export interface MessageImage {
  proxyUrl: string;
  width?: number;
  height?: number;
  /** Where its frames come from, when it moves: a GIF attachment itself, or a `gifv` link's MP4. */
  animation?: { proxyUrl: string; type: AnimationType };
}

type Sized = { proxy_url?: string; width?: number | null; height?: number | null };

const imageOf = (source: Sized | undefined): MessageImage | null =>
  source?.proxy_url
    ? { proxyUrl: source.proxy_url, width: source.width ?? undefined, height: source.height ?? undefined }
    : null;

/**
 * The message's images in order, attachments then embeds, at most three.
 * Embeds count only when `gifv` or `image`: the proxy URL of `image`, else of
 * `thumbnail`, since Discord sets either or both. Stickers and anything else
 * are ignored. A GIF attachment animates from itself; a `gifv` from its
 * `video`, which Discord's GIF picker sets to an MP4 (verified 2026-11-12).
 */
export function imagesOf(message: Pick<APIMessage, "attachments" | "embeds">): MessageImage[] {
  const images: MessageImage[] = [];
  for (const attachment of message.attachments ?? []) {
    const image = ATTACHMENT_TYPES.has(attachment.content_type ?? "") ? imageOf(attachment) : null;
    if (!image) continue;
    if (attachment.content_type === "image/gif") image.animation = { proxyUrl: attachment.proxy_url, type: "image/gif" };
    images.push(image);
  }
  for (const embed of message.embeds ?? []) {
    if (embed.type !== "gifv" && embed.type !== "image") continue;
    const image = imageOf(embed.image) ?? imageOf(embed.thumbnail);
    if (!image) continue;
    if (embed.type === "gifv" && embed.video?.proxy_url)
      image.animation = { proxyUrl: embed.video.proxy_url, type: "video/mp4" };
    images.push(image);
  }
  return images.slice(0, IMAGES_PER_MESSAGE);
}

/** The URL if it is on Discord's media proxy over plain https, else null: no member-supplied host is fetched. */
function onProxy(proxyUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return null;
  }
  return url.protocol === "https:" && !url.port && PROXY_HOST.test(url.hostname) ? url : null;
}

/** The proxy URL with `format=jpeg` and a bounded size, or null if the host is not Discord's media proxy. */
function stillUrl({ proxyUrl, width, height }: MessageImage): URL | null {
  const url = onProxy(proxyUrl);
  if (!url) return null;
  const known = width && height && width > 0 && height > 0;
  const scale = known ? Math.min(1, LONG_EDGE / Math.max(width, height)) : 1;
  url.searchParams.set("format", "jpeg");
  url.searchParams.set("width", String(known ? Math.max(1, Math.round(width * scale)) : LONG_EDGE));
  url.searchParams.set("height", String(known ? Math.max(1, Math.round(height * scale)) : LONG_EDGE));
  return url;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The body of an allow-listed URL, if it is a 2xx of exactly `type` and at
 * most 4 MB, else null. Redirects are refused, so none can lead off the
 * allow-list. An expired link or a dropped connection costs this one image.
 */
async function download(url: URL, type: string, fetchImpl: Fetch): Promise<Buffer | null> {
  try {
    const response = await fetchImpl(url.toString(), { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    const got = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const length = Number(response.headers.get("content-length"));
    if (!response.ok || got !== type || length > MAX_BYTES || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

const jpegUrl = (bytes: Buffer) => `data:${STILL_TYPE};base64,${bytes.toString("base64")}`;

/**
 * One still frame as a `data:image/jpeg;base64,` URL, or null to skip. The URL
 * is checked against the allow-list before any request. Anything but a JPEG, a
 * non-2xx, a body over 4 MB, or a failed download is skipped.
 */
export async function fetchStill(image: MessageImage, fetchImpl: Fetch): Promise<string | null> {
  const url = stillUrl(image);
  const body = url && (await download(url, STILL_TYPE, fetchImpl));
  return body ? jpegUrl(body) : null;
}

/** Runs a decoder on `input` over stdin; its stdout, or null on any failure, a timeout, or no such binary. */
const run = (command: string, args: string[], input: Buffer): Promise<Buffer | null> =>
  new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { encoding: "buffer", timeout: DECODE_TIMEOUT_MS, maxBuffer: MAX_BYTES * 4 },
      (error, stdout) => resolve(error ? null : stdout),
    );
    // A decoder that exits early closes its stdin; the write error is that, not ours.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });

const SOI = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * One decode at a time, process-wide, so members posting together cannot
 * stack decoders' memory. A decode is bounded by its timeout, so the queue
 * always drains.
 */
let decoding: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(job: () => Promise<T>): Promise<T> => {
  const turn = decoding.then(job, job);
  decoding = turn.catch(() => {});
  return turn;
};

/** `count` frame indices out of `total`, evenly spaced from the first frame to the last, in order. */
export const spread = (total: number, count: number): number[] => {
  const n = Math.min(count, total);
  return Array.from({ length: n }, (_, i) => (n === 1 ? 0 : Math.round((i * (total - 1)) / (n - 1))));
};

/**
 * Up to four frames of an animation, evenly spaced from first to last, in
 * order, as JPEG bytes, or none. `ffmpeg` reads from a pipe and writes to one:
 * nothing touches disk. Its demuxer is forced from the type already checked,
 * never probed, so the bytes cannot pick a format that opens a file or a URL.
 * `-protocol_whitelist pipe` is a second wall behind that, untested on its
 * own: with the demuxer forced, no input reaches it. A canvas over
 * `MAX_PIXELS` is refused before anything is decoded, decoding is
 * single-threaded, and one decode runs at a time. A file whose index sits at
 * its end (an MP4 not built for streaming) cannot be read from a pipe and
 * yields none.
 */
export const takeFrames = (bytes: Buffer, type: AnimationType): Promise<Buffer[]> =>
  oneAtATime(async () => {
    const input = ["-v", "error", "-threads", "1", "-protocol_whitelist", "pipe", "-f", DEMUXERS[type], "-i", "pipe:0"];
    // Packets are counted, not decoded: nothing is decoded until the canvas is known.
    const probed = await run(
      "ffprobe",
      [...input, "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,nb_read_packets", "-of", "csv=p=0"],
      bytes,
    );
    const [width, height, total] = (probed?.toString().trim().split(",") ?? []).map(Number);
    if (![width, height, total].every((n) => Number.isSafeInteger(n) && n! > 0)) return [];
    if (width! * height! > MAX_PIXELS) return [];
    const picks = spread(total!, FRAMES_PER_ANIMATION);
    const out = await run(
      "ffmpeg",
      [
        ...input,
        "-an",
        "-vf",
        `select=${picks.map((n) => `eq(n\\,${n})`).join("+")},` +
          `scale='min(${LONG_EDGE},iw)':'min(${LONG_EDGE},ih)':force_original_aspect_ratio=decrease`,
        "-fps_mode", "vfr",
        "-frames:v", String(picks.length),
        "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "pipe:1",
      ],
      bytes,
    );
    if (!out?.length) return [];
    // An MJPEG stream is JPEGs back to back. FF D8 FF cannot occur inside one:
    // its entropy-coded data stuffs every FF with 00.
    const frames: Buffer[] = [];
    for (let at = out.indexOf(SOI); at !== -1; ) {
      const next = out.indexOf(SOI, at + SOI.length);
      frames.push(out.subarray(at, next === -1 ? undefined : next));
      at = next;
    }
    return frames.slice(0, FRAMES_PER_ANIMATION);
  });

/**
 * The image as stills for `readImage`: up to four frames, in order, when it is
 * an animation; otherwise, or when its frames cannot be had, its one still;
 * empty to skip it. The animation is downloaded under the still's rules, and
 * only its JPEG frames ever leave: never the animation itself.
 */
export async function fetchStills(
  image: MessageImage,
  fetchImpl: Fetch,
  frames: typeof takeFrames = takeFrames,
): Promise<string[]> {
  if (image.animation) {
    const url = onProxy(image.animation.proxyUrl);
    const body = url && (await download(url, image.animation.type, fetchImpl));
    const taken = body ? await frames(body, image.animation.type) : [];
    if (taken.length) return taken.map(jpegUrl);
  }
  const still = await fetchStill(image, fetchImpl);
  return still ? [still] : [];
}
