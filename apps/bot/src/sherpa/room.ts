/**
 * The room around a member's messages (ADR-0003 O6, amended 2026-11-14): what
 * others in the same place wrote next, and the reactions the member's words
 * drew. A member who baits is legible by the reaction more than by the bait:
 * each message alone is harmless, and the replies are where people say so.
 *
 * Read by burst: the member's consecutive messages in one place, read forward
 * from the first, so a window holds the burst with its reactions and whatever
 * followed; in a busy place, again from the first message no window reached.
 * Others' words go to the boundary as context, under
 * the same rules as a replied-to message: names redacted, bots and opted-out
 * authors dropped there.
 */
import { type APIMessage, MessageType } from "discord-api-types/v10";

/** Messages read per burst: the burst itself and what followed it. */
const WINDOW = 25;
/** Others' messages kept after each of the member's, until the member speaks again. */
export const FOLLOWED_BY = 5;
/** Reads per run, newest bursts first. */
const MAX_READS = 200;
/** A gap longer than this in one place starts a new burst. */
const BURST_GAP_MS = 30 * 60 * 1000;

export interface Room {
  reactions: Array<{ emoji: string; count: number }>;
  followedBy: APIMessage[];
}

type Read = { id: string; channel_id: string; timestamp: string };

/** Someone's username and display name, for the boundary to redact. */
export const namesOf = (user: { username: string; global_name?: string | null }): string[] =>
  [user.username, user.global_name].filter((n): n is string => typeof n === "string" && n.trim() !== "");

/** What a person wrote: not a pin notice, a Thread's start or another system line. */
const said = (m: APIMessage) => m.type === MessageType.Default || m.type === MessageType.Reply;

/**
 * `messages`: the member's, oldest first. Returns each one's room, by id; one
 * outside every window read, or in one that could not be read, is left out.
 * Stops reading when `inTime` says so.
 */
export const readRooms = async (
  memberId: string,
  messages: readonly Read[],
  after: (channelId: string, afterId: string, limit: number) => Promise<APIMessage[]>,
  inTime: () => boolean,
): Promise<Map<string, Room>> => {
  const bursts: Read[][] = [];
  for (const m of messages) {
    const burst = bursts.at(-1);
    const previous = burst?.at(-1);
    if (burst && previous!.channel_id === m.channel_id && Date.parse(m.timestamp) - Date.parse(previous!.timestamp) <= BURST_GAP_MS)
      burst.push(m);
    else bursts.push([m]);
  }
  const rooms = new Map<string, Room>();
  let reads = 0;
  // Newest first: the reduce reads the newest messages, so they are the last to go without.
  for (const burst of bursts.reverse()) {
    let pending = burst;
    while (pending.length && reads < MAX_READS && inTime()) {
      reads++;
      const first = pending[0]!;
      // From the first message no window reached: `after` is exclusive, so one id below it.
      // Context only: a place it cannot read (lost access, say) leaves that burst without, never the review.
      const read = await after(first.channel_id, (BigInt(first.id) - 1n).toString(), WINDOW).catch(() => null);
      if (!read) break;
      const window = read.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      let current: Room | null = null;
      for (const m of window) {
        if (m.author.id === memberId) {
          current = { reactions: (m.reactions ?? []).map((r) => ({ emoji: r.emoji.name ?? "?", count: r.count })), followedBy: [] };
          rooms.set(m.id, current);
        } else if (current && said(m) && !m.author.bot && !m.webhook_id && current.followedBy.length < FOLLOWED_BY) current.followedBy.push(m);
      }
      // The first always counts as read, so a message gone since search cannot hold the loop.
      pending = pending.filter((m) => m !== first && !rooms.has(m.id));
    }
  }
  return rooms;
};
