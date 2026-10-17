// node auth-discord/check-resolve-role.ts — fails if role mapping breaks.
import assert from "node:assert/strict";

import { resolveRole } from "./src/index.ts";

const map = { staff: 50, lead: 30 };
assert.equal(resolveRole(["member", "lead", "staff"], map), 50, "highest match wins, in any order");
assert.equal(resolveRole(["staff", "lead"], map), 50);
assert.equal(resolveRole(["lead"], map), 30);
assert.equal(resolveRole(["member"], map), null, "no editor role means null, not a default");
assert.equal(resolveRole([], map), null);
console.log("resolveRole ok");
