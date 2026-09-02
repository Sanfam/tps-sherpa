import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.ts";
import { fixtureDiscord } from "./fixture-discord.ts";

const GUILD_ID = "1055290132250501135";

const withRoles = (roles: Array<{ id: string; name: string; color?: number }>) =>
  buildCatalog({
    discord: fixtureDiscord({
      channels: [],
      roles: roles.map((r) => ({ ...r, color: r.color ?? 0 })),
    }),
    guildId: GUILD_ID,
  });

describe("role manifest", () => {
  it("lists every guild role by name, with the IDs that name maps to", async () => {
    const { roleManifest } = await withRoles([
      { id: "901", name: "Staff" },
      { id: "900", name: "Member" },
    ]);
    expect(roleManifest).toEqual([
      { name: "Member", color: 0, ids: ["900"] },
      { name: "Staff", color: 0, ids: ["901"] },
    ]);
  });

  it("aggregates duplicate-named roles into one gate covering every ID", async () => {
    // Past bot behaviour left 5 names covering 13 roles in the real guild,
    // with identical permissions and no channel overwrites referencing them.
    // They are interchangeable: a gate on the name must match a member
    // holding ANY of them, or it silently misses people.
    const { roleManifest } = await withRoles([
      { id: "903", name: "Mechanics" },
      { id: "901", name: "Mechanics" },
      { id: "902", name: "Mechanics" },
      { id: "900", name: "Member" },
    ]);
    expect(roleManifest).toEqual([
      { name: "Mechanics", color: 0, ids: ["901", "902", "903"] },
      { name: "Member", color: 0, ids: ["900"] },
    ]);
  });

  it("keeps a renamed role's ID, so its gate keeps working", async () => {
    // Editors pick a role by name; gates store IDs. A rename must not break a
    // gate — the same failure that broke the old index on channel renames.
    const before = await withRoles([{ id: "900", name: "Members" }]);
    const after = await withRoles([{ id: "900", name: "Verified Member" }]);

    expect(before.roleManifest[0]?.ids).toEqual(["900"]);
    expect(after.roleManifest[0]?.ids).toEqual(["900"]);
    expect(after.roleManifest[0]?.name).toBe("Verified Member");
  });

  it("drops a deleted role while keeping the survivors, so its gates fail closed", async () => {
    const before = await withRoles([
      { id: "900", name: "Member" },
      { id: "901", name: "Retired Role" },
    ]);
    expect(before.roleManifest.map((r) => r.name)).toEqual([
      "Member",
      "Retired Role",
    ]);

    const after = await withRoles([{ id: "900", name: "Member" }]);

    // Both halves matter: the deleted role is gone AND the survivor remains,
    // so an implementation returning nothing cannot pass.
    expect(after.roleManifest).toEqual([
      { name: "Member", color: 0, ids: ["900"] },
    ]);
  });

  it("drops one ID of a duplicate group without dropping the gate", async () => {
    const after = await withRoles([
      { id: "901", name: "Mechanics" },
      { id: "900", name: "Member" },
    ]);
    expect(after.roleManifest.find((r) => r.name === "Mechanics")?.ids).toEqual([
      "901",
    ]);
  });

  it("never offers @everyone as a gate value", async () => {
    // Its id is the guild id and it never appears in a member's roles array,
    // so a page gated on it would lock out every reader including Members.
    const { roleManifest } = await withRoles([
      { id: GUILD_ID, name: "@everyone" },
      { id: "900", name: "Member" },
    ]);
    expect(roleManifest).toEqual([{ name: "Member", color: 0, ids: ["900"] }]);
  });

  it("orders entries by name so a re-run produces identical output", async () => {
    const { roleManifest } = await withRoles([
      { id: "902", name: "Charlie" },
      { id: "900", name: "Alpha" },
      { id: "901", name: "Bravo" },
    ]);
    expect(roleManifest.map((r) => r.name)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("refuses to aggregate same-named roles of different colours", async () => {
    // The safeguard. Two roles that genuinely differ will almost always differ
    // in colour, and merging them would silently widen an audience.
    const warnings: string[] = [];
    const { roleManifest } = await buildCatalog({
      discord: fixtureDiscord({
        channels: [],
        roles: [
          { id: "900", name: "Mechanics", color: 3447003 },
          { id: "901", name: "Mechanics", color: 15158332 },
        ],
      }),
      guildId: GUILD_ID,
      warn: (m) => warnings.push(m),
    });

    expect(roleManifest).toHaveLength(2);
    expect(roleManifest.every((r) => r.ids.length === 1)).toBe(true);
    expect(warnings.filter((w) => w.includes("NOT"))).toHaveLength(2);
  });

  it("warns that a duplicate group was aggregated, so it can be tidied up", async () => {
    const warnings: string[] = [];
    await buildCatalog({
      discord: fixtureDiscord({
        channels: [],
        roles: [
          { id: "900", name: "Blacksmith", color: 3447003 },
          { id: "901", name: "Blacksmith", color: 3447003 },
          { id: "902", name: "Member", color: 0 },
        ],
      }),
      guildId: GUILD_ID,
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Blacksmith");
    expect(warnings[0]).toContain("900");
    expect(warnings[0]).toContain("901");
  });
});
