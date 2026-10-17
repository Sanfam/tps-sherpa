// Fake snowflakes. The mock Discord in ../mock-discord.mjs uses the same ids.
export const GUILD_ID = "100000000000000001";
export const ROLE_STAFF = "200000000000000001";
export const ROLE_CLUB_LEAD = "200000000000000002";
// Staff administer the CMS; a Club Lead edits only their own entries.
export const ROLE_MAP: Record<string, number> = { [ROLE_STAFF]: 50, [ROLE_CLUB_LEAD]: 30 };
