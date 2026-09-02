import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.ts";
import { fixtureDiscord } from "./fixture-discord.ts";

const GUILD_ID = "1055290132250501135";

const withRoles = (roles: Array<{ id: string; name: string }>) =>
  buildCatalog({
    discord: fixtureDiscord({ channels: [], roles }),
    guildId: GUILD_ID,
  });

describe("role manifest", () => {
  it("lists every guild role as an ID and a name", async () => {
    const { roleManifest } = await withRoles([
      { id: "900", name: "Member" },
      { id: "901", name: "Staff" },
    ]);
    expect(roleManifest).toEqual([
      { id: "900", name: "Member" },
      { id: "901", name: "Staff" },
    ]);
  });

  it("keeps a renamed role as the same entry rather than a delete plus an add", async () => {
    // Editors pick a role by name; gates store the ID. A rename must not
    // break a gate — the same failure that broke the old index on channel
    // renames.
    const before = await withRoles([{ id: "900", name: "Members" }]);
    const after = await withRoles([{ id: "900", name: "Verified Member" }]);

    expect(after.roleManifest.map((r) => r.id)).toEqual(
      before.roleManifest.map((r) => r.id),
    );
    expect(after.roleManifest[0]?.name).toBe("Verified Member");
  });

  it("drops a deleted role while keeping the survivors, so its gates fail closed", async () => {
    const before = await withRoles([
      { id: "900", name: "Member" },
      { id: "901", name: "Retired Role" },
    ]);
    expect(before.roleManifest.map((r) => r.id)).toEqual(["900", "901"]);

    const after = await withRoles([{ id: "900", name: "Member" }]);

    // Both halves matter: the deleted role is gone AND the survivor remains,
    // so an implementation returning nothing cannot pass.
    expect(after.roleManifest.map((r) => r.id)).toEqual(["900"]);
  });

  it("never offers @everyone as a gate value", async () => {
    // Its id is the guild id and it never appears in a member's roles array,
    // so a page gated on it would lock out every reader including Members.
    const { roleManifest } = await withRoles([
      { id: GUILD_ID, name: "@everyone" },
      { id: "900", name: "Member" },
    ]);
    expect(roleManifest.map((r) => r.id)).toEqual(["900"]);
  });

  it("warns when two roles share a name, because a picker cannot tell them apart", async () => {
    const warnings: string[] = [];
    await buildCatalog({
      discord: fixtureDiscord({
        channels: [],
        roles: [
          { id: "900", name: "Blacksmith" },
          { id: "901", name: "Blacksmith" },
          { id: "902", name: "Member" },
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

  it("orders roles by ID so a re-run produces identical output", async () => {
    const shuffled = await withRoles([
      { id: "902", name: "c" },
      { id: "900", name: "a" },
      { id: "901", name: "b" },
    ]);
    expect(shuffled.roleManifest.map((r) => r.id)).toEqual(["900", "901", "902"]);
  });
});
