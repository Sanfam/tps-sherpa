/**
 * Which images on an introduction the responder reads, and how one becomes a
 * still. `imagesOf` picks them from a message; `fetchStill` downloads one
 * through Discord's media proxy as a base64 data URL for `readImage`, or
 * returns null to skip it. Nothing here is stored or logged: a URL or a
 * filename can carry member text (docs/proposals/introductions-responder.md
 * §4, Images). The 6-per-member cap lives in the durable store, not here.
 */
import type { APIMessage } from "discord-api-types/v10";

/** At most this many images are read from one message. */
export const IMAGES_PER_MESSAGE = 3;
/** The long edge Discord's proxy downscales to; smaller sources are not enlarged. */
const LONG_EDGE = 1024;
/** Larger bodies are skipped, by `content-length` and again while reading. */
const MAX_BYTES = 4 * 1024 * 1024;

const ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/**
 * Every URL asks for `format=jpeg`, and only a JPEG is accepted back: PNG and
 * WebP can be animated, so anything else means the proxy ignored the request
 * and the whole animation may be in the body.
 */
const STILL_TYPE = "image/jpeg";
const PROXY_HOST = /^(media|images-ext-\d+)\.discordapp\.net$/;

/** A message's image, as Discord's media proxy addresses it. */
export interface MessageImage {
  proxyUrl: string;
  width?: number;
  height?: number;
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
 * are ignored.
 */
export function imagesOf(message: Pick<APIMessage, "attachments" | "embeds">): MessageImage[] {
  const images: MessageImage[] = [];
  for (const attachment of message.attachments ?? []) {
    const image = ATTACHMENT_TYPES.has(attachment.content_type ?? "") ? imageOf(attachment) : null;
    if (image) images.push(image);
  }
  for (const embed of message.embeds ?? []) {
    if (embed.type !== "gifv" && embed.type !== "image") continue;
    const image = imageOf(embed.image) ?? imageOf(embed.thumbnail);
    if (image) images.push(image);
  }
  return images.slice(0, IMAGES_PER_MESSAGE);
}

/** The proxy URL with `format=jpeg` and a bounded size, or null if the host is not Discord's media proxy. */
function stillUrl({ proxyUrl, width, height }: MessageImage): URL | null {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || !PROXY_HOST.test(url.hostname)) return null;
  const known = width && height && width > 0 && height > 0;
  const scale = known ? Math.min(1, LONG_EDGE / Math.max(width, height)) : 1;
  url.searchParams.set("format", "jpeg");
  url.searchParams.set("width", String(known ? Math.max(1, Math.round(width * scale)) : LONG_EDGE));
  url.searchParams.set("height", String(known ? Math.max(1, Math.round(height * scale)) : LONG_EDGE));
  return url;
}

/**
 * One still frame as a `data:image/…;base64,` URL, or null to skip. The URL is
 * checked against the allow-list before any request, so no member-supplied host
 * is ever fetched, and redirects are refused, so none can lead off it. Anything
 * but a JPEG, a non-2xx, a body over 4 MB, or a failed download is skipped.
 */
export async function fetchStill(
  image: MessageImage,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
): Promise<string | null> {
  const url = stillUrl(image);
  if (!url) return null;
  try {
    return await download(await fetchImpl(url.toString(), { redirect: "error" }));
  } catch {
    // An expired link or a dropped connection costs this one image, not the evaluation.
    return null;
  }
}

async function download(response: Response): Promise<string | null> {
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const length = Number(response.headers.get("content-length"));
  if (!response.ok || type !== STILL_TYPE || length > MAX_BYTES || !response.body) {
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
  return `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`;
}
