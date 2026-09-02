import { describe, expect, it } from "vitest";
import { canReadHistory, canView, type Overwrite } from "./discord-adapter.ts";

const GUILD = "1055290132250501135";
const SHERPA = "sherpa-role";
const ow = (id: string, allow: bigint, deny: bigint): Overwrite => ({
  id,
  type: 0,
  allow: allow.toString(),
  deny: deny.toString(),
});
const VIEW = 1n << 10n;
const HIST = 1n << 16n;
// @everyone grants READ_MESSAGE_HISTORY at guild level in this guild.
const BOT = "bot-user";
const ctx = {
  guildId: GUILD,
  roleIds: [SHERPA],
  memberId: BOT,
  basePermissions: VIEW | HIST,
};

describe("canReadHistory", () => {
  it("denies content on a withheld channel: role allowed VIEW but denied HISTORY", () => {
    // The real 🩹 Selfing shape: @everyone -VIEW, Member +VIEW, Sherpa +VIEW -HIST.
    const channel = {
      permission_overwrites: [
        ow(GUILD, 0n, VIEW),
        ow(SHERPA, VIEW, HIST),
      ],
    };
    expect(canReadHistory(channel, ctx)).toBe(false);
  });

  it("allows content where the role is granted both", () => {
    const channel = { permission_overwrites: [ow(SHERPA, VIEW | HIST, 0n)] };
    expect(canReadHistory(channel, ctx)).toBe(true);
  });

  it("denies content on a channel the role cannot even see", () => {
    const channel = { permission_overwrites: [ow(GUILD, 0n, VIEW)] };
    expect(canReadHistory(channel, ctx)).toBe(false);
  });

  it("lets a member-specific overwrite beat the role overwrites", () => {
    // verification-chat-1: @everyone +VIEW, Staff +VIEW, Member -VIEW, and a
    // member overwrite denying VIEW to the bot itself. Roles alone compute
    // readable; Discord returns 403. The member overwrite applies last.
    const channel = {
      permission_overwrites: [
        ow(SHERPA, VIEW | HIST, 0n),
        { id: BOT, type: 1, allow: "0", deny: VIEW.toString() },
      ],
    };
    expect(canReadHistory(channel, ctx)).toBe(false);
    expect(canView(channel, ctx)).toBe(false);
  });

  it("treats ADMINISTRATOR as overriding every overwrite", () => {
    const channel = { permission_overwrites: [ow(GUILD, 0n, VIEW | HIST)] };
    expect(
      canReadHistory(channel, { ...ctx, basePermissions: 1n << 3n }),
    ).toBe(true);
  });
});
