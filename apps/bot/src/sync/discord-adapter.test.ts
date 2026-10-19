import { describe, expect, it } from "vitest";
import { type Entity, visibleTo } from "./catalog.ts";
import { discordRest } from "./discord-adapter.ts";

/** Answers the three routes listThreads calls, from canned Discord payloads. */
const fakeRest = (payload: { active: unknown[]; archived: unknown[] }) => ({
  get: async (route: string) => {
    if (route.includes("/threads/active")) return { threads: payload.active };
    if (route.includes("/threads/archived/public"))
      return { threads: payload.archived, has_more: false };
    return { content: "starter" };
  },
});

const listThreads = (payload: { active: unknown[]; archived: unknown[] }, warn?: (m: string) => void) =>
  discordRest({
    token: "unused",
    guildId: "1",
    warn,
    rest: fakeRest(payload) as never,
  })
    .listThreads(["100"])
    .then((r) => r.threads);

describe("captureWindows", () => {
  it("marks a webhook's message as not a member's, even without the bot flag", async () => {
    const page = [
      { id: "2", author: { id: "w1" }, webhook_id: "w1", content: "Free game!" },
      { id: "1", author: { id: "m1", bot: false }, content: "nice" },
    ];
    const port = discordRest({
      token: "unused",
      guildId: "1",
      rest: { get: async () => page } as never,
    });

    const messages = await port.captureWindows("500");

    expect(Object.fromEntries(messages.map((m) => [m.id, m.authorIsBot]))).toEqual({ "1": false, "2": true });
  });
});

describe("listThreads", () => {
  it("reads archived from the endpoint that answered and locked from the metadata", async () => {
    const threads = await listThreads({
      active: [
        { id: "201", name: "open", parent_id: "100", type: 11, thread_metadata: { archived: false, locked: false } },
        { id: "202", name: "locked open", parent_id: "100", type: 11, thread_metadata: { archived: false, locked: true } },
      ],
      archived: [
        // Metadata saying otherwise does not outrank the endpoint.
        { id: "203", name: "closed", parent_id: "100", type: 11, thread_metadata: { archived: false } },
      ],
    });

    expect(
      Object.fromEntries(threads.map((t) => [t.id, { archived: t.archived, locked: t.locked }])),
    ).toEqual({
      "201": { archived: false, locked: false },
      "202": { archived: false, locked: true },
      "203": { archived: true, locked: false },
    });
  });

  it("drops private Threads, which a Member cannot browse to", async () => {
    const threads = await listThreads({
      active: [
        { id: "201", name: "public", parent_id: "100", type: 11, thread_metadata: { locked: false } },
        { id: "299", name: "private", parent_id: "100", type: 12, thread_metadata: { locked: false } },
      ],
      archived: [],
    });

    expect(threads.map((t) => t.id)).toEqual(["201"]);
  });

  it("says so when a Thread arrives without metadata, rather than guessing quietly", async () => {
    const warnings: string[] = [];
    const threads = await listThreads(
      {
        active: [
          { id: "201", name: "bare", parent_id: "100", type: 11 },
          { id: "202", name: "partial", parent_id: "100", type: 11, thread_metadata: {} },
        ],
        archived: [],
      },
      (m) => warnings.push(m),
    );

    expect(threads[0]).toMatchObject({ archived: false, locked: false });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("without thread_metadata.locked");
  });

  it("reports a container whose archived Threads Discord denies, rather than a shorter list", async () => {
    // #28: reduced to a warning, the Posts behind a 50001 read as removed.
    const port = discordRest({
      token: "unused",
      guildId: "1",
      rest: {
        get: async (route: string) => {
          if (route.includes("/threads/active")) return { threads: [] };
          if (route.includes("/channels/200/threads/archived"))
            throw Object.assign(new Error("Missing Access"), { code: 50001 });
          if (route.includes("/threads/archived/public"))
            return { threads: [{ id: "101", name: "kept", parent_id: "100", type: 11 }], has_more: false };
          return { content: "starter" };
        },
      } as never,
    });

    const { threads, failed } = await port.listThreads(["100", "200"]);

    expect(threads.map((t) => t.id)).toEqual(["101"]);
    expect(failed).toEqual([{ id: "200", reason: expect.stringContaining("50001") }]);
  });

  it("reports a container whose archived pages promise more without a cursor", async () => {
    const port = discordRest({
      token: "unused",
      guildId: "1",
      rest: {
        get: async (route: string) => {
          if (route.includes("/threads/active")) return { threads: [] };
          if (route.includes("/threads/archived/public"))
            return { threads: [{ id: "101", name: "no metadata", parent_id: "100", type: 11 }], has_more: true };
          return { content: "starter" };
        },
      } as never,
    });

    const { failed } = await port.listThreads(["100"]);

    expect(failed).toEqual([{ id: "100", reason: expect.stringContaining("no cursor") }]);
  });
});

describe("listChannels: who can see each place, by role (#53)", () => {
  const VIEW = (1n << 10n).toString();
  const ADMINISTRATOR = (1n << 3n).toString();
  const [GUILD, MEMBER, HOBBY, STAFF, ADMIN, BOT_ROLE] = ["1", "2", "3", "4", "5", "9"] as const;
  const DENIED_MEMBER = "77";
  const ow = (id: string, allow: string, deny: string, type = 0) => ({ id, type, allow, deny });
  const channels = [
    // The guild's verification shape: @everyone allowed, `Member` denied.
    { id: "10", name: "verification", type: 0, permission_overwrites: [ow(GUILD, VIEW, "0"), ow(MEMBER, "0", VIEW)] },
    { id: "11", name: "fishing", type: 0, permission_overwrites: [ow(GUILD, "0", VIEW), ow(HOBBY, VIEW, "0")] },
    {
      id: "12",
      name: "staff-room",
      type: 0,
      parent_id: "88",
      permission_overwrites: [ow(GUILD, "0", VIEW), ow(STAFF, VIEW, "0"), ow(BOT_ROLE, VIEW, "0")],
    },
    {
      id: "13",
      name: "hobby-room",
      type: 0,
      permission_overwrites: [
        ow(MEMBER, "0", VIEW),
        ow(HOBBY, VIEW, "0"),
        ow(ADMIN, "0", VIEW),
        ow(DENIED_MEMBER, "0", VIEW, 1),
      ],
    },
  ];
  const roles = [GUILD, MEMBER, HOBBY, STAFF, ADMIN, BOT_ROLE].map((id) => ({
    id,
    name: id === MEMBER ? "Member" : id,
    permissions: id === GUILD ? VIEW : id === ADMIN ? ADMINISTRATOR : "0",
    color: 0,
  }));
  const port = discordRest({
    token: "unused",
    guildId: GUILD,
    rest: {
      get: async (route: string) => {
        if (route === `/guilds/${GUILD}/channels`) return channels;
        if (route === `/guilds/${GUILD}/roles`) return roles;
        if (route === "/users/%40me") return { id: "99" };
        if (route === `/guilds/${GUILD}/members/99`) return { roles: [BOT_ROLE] };
        throw new Error(`unexpected route ${route}`);
      },
    } as never,
  });

  it("carries each place's category, which the sync's Staff-category exclusion reads", async () => {
    const byName = new Map((await port.listChannels()).map((c) => [c.name, c.categoryId]));
    expect([byName.get("staff-room"), byName.get("fishing")]).toEqual(["88", null]);
  });

  it("honours a role's own deny and @everyone's allow, and grants a Member no place only Staff see", async () => {
    const access = Object.fromEntries(
      (await port.listChannels()).map((c) => [
        c.name,
        { allow: c.allowRoles, view: c.viewRoles, deny: c.denyRoles, members: c.deniedMembers },
      ]),
    );
    expect(access).toEqual({
      verification: { allow: [ADMIN], view: [HOBBY, STAFF, ADMIN, BOT_ROLE], deny: [MEMBER], members: [] },
      fishing: { allow: [HOBBY, ADMIN], view: [HOBBY, ADMIN], deny: [], members: [] },
      "staff-room": { allow: [STAFF, ADMIN, BOT_ROLE], view: [STAFF, ADMIN, BOT_ROLE], deny: [], members: [] },
      "hobby-room": {
        allow: [HOBBY, ADMIN],
        view: [HOBBY, STAFF, ADMIN, BOT_ROLE],
        deny: [MEMBER, ADMIN],
        members: [DENIED_MEMBER],
      },
    });
  });

  // Discord: @everyone's overwrite, then every held role's deny, then every
  // held role's allow. ADMINISTRATOR skips overwrites altogether.
  it("lets one held role's allow beat another's deny, and ADMINISTRATOR beat any deny, as Discord does", async () => {
    const byName = new Map((await port.listChannels()).map((c) => [c.name, c]));
    const sees = (name: string, roles: string[]) => {
      const c = byName.get(name)!;
      return visibleTo({ allow_roles: c.allowRoles, view_roles: c.viewRoles, deny_roles: c.denyRoles } as Entity, roles);
    };
    expect(sees("hobby-room", [MEMBER, HOBBY])).toBe(true);
    expect(sees("hobby-room", [MEMBER])).toBe(false);
    expect(sees("hobby-room", [MEMBER, STAFF])).toBe(false);
    expect(sees("hobby-room", [MEMBER, ADMIN])).toBe(true);
    // A role seeing it only through @everyone does not outweigh a deny.
    expect(sees("verification", [MEMBER, HOBBY])).toBe(false);
    expect(sees("verification", [HOBBY])).toBe(true);
  });
});
