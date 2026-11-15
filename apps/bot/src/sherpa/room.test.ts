import type { APIMessage } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { readRooms } from "./room.ts";

const ME = "1";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString();
const own = (id: string, minute: number, channel_id = "c") => ({ id, channel_id, timestamp: at(minute) });
const said = (id: string, author: string, extra: Partial<APIMessage> = {}) =>
  ({ id, channel_id: "c", type: 0, author: { id: author, username: `u${author}` }, content: `m${id}`, ...extra }) as unknown as APIMessage;

describe("readRooms", () => {
  it("reads each burst from its first message, and gives each of the member's what followed until they spoke again", async () => {
    const asked: string[] = [];
    // Newest first, as Discord may send it.
    const channel = [
      said("106", "2"),
      said("105", "3", { author: { id: "3", bot: true } as never }),
      said("107", "2", { type: 6 }),
      said("104", ME),
      said("103", "3"),
      said("102", "2"),
      said("101", ME, { reactions: [{ emoji: { name: "kekw" }, count: 2 }] as never }),
      said("100", ME),
    ];
    const rooms = await readRooms(ME, [own("100", 0), own("101", 1), own("104", 5)], async (_, afterId) => (asked.push(afterId), channel), () => true);
    // One read for the burst, from one below its first message: `after` is exclusive.
    expect(asked).toEqual(["99"]);
    expect(rooms.get("100")!.followedBy).toEqual([]);
    expect(rooms.get("101")!.reactions).toEqual([{ emoji: "kekw", count: 2 }]);
    expect(rooms.get("101")!.followedBy.map((m) => m.id)).toEqual(["102", "103"]);
    // The bot's message and the pin notice (107) are not anyone's words.
    expect(rooms.get("104")!.followedBy.map((m) => m.id)).toEqual(["106"]);
  });

  it("reads again from the first message a busy place's window did not reach", async () => {
    const asked: string[] = [];
    const busy = Array.from({ length: 24 }, (_, i) => said(String(101 + i), "2"));
    const rooms = await readRooms(
      ME,
      [own("100", 0), own("200", 20)],
      async (_, afterId) => (asked.push(afterId), afterId === "99" ? [said("100", ME), ...busy] : [said("200", ME), said("201", "3")]),
      () => true,
    );
    expect(asked).toEqual(["99", "199"]);
    expect(rooms.get("200")!.followedBy.map((m) => m.id)).toEqual(["201"]);
  });

  it("reads the newest burst first, starts one in another place or after a long gap, and keeps going past a place it cannot read", async () => {
    const asked: string[] = [];
    const rooms = await readRooms(
      ME,
      [own("100", 0), own("200", 1, "d"), own("300", 120, "d")],
      async (channel, afterId) => {
        asked.push(`${channel}:${afterId}`);
        if (channel === "c") throw new Error("Missing Access");
        return [said(String(BigInt(afterId) + 1n), ME)];
      },
      () => true,
    );
    expect(asked).toEqual(["d:299", "d:199", "c:99"]);
    expect([...rooms.keys()]).toEqual(["300", "200"]);
  });
});
