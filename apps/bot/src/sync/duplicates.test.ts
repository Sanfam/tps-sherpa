import { describe, expect, it } from "vitest";
import type { Entity } from "./catalog.ts";
import {
  findDuplicateCandidates,
  formatForMods,
  type CapturedMessage,
} from "./duplicates.ts";

const entity = (id: string, name: string): Entity => ({
  id,
  type: "post",
  name,
  url: `https://discord.com/channels/1055/${id}`,
  parent_id: "900",
  description_status: "absent",
  topic: null,
  applied_tags: [],
  last_message_id: null,
  last_activity_at: null,
  summary_generated: null,
  summary_override: null,
});

const GAME_TALK = entity("700", "🎮︱game-talk");
const FACTORIO = entity("101", "Factorio Channel");
const SEA_OF_THIEVES = entity("102", "Sea of Thieves");

const msg = (entityId: string, content: string, authorIsBot = false): CapturedMessage => ({
  entityId,
  content,
  authorIsBot,
});

const filler = (entityId: string, n: number) =>
  Array.from({ length: n }, (_, i) => msg(entityId, `ordinary chatter ${i}`));

describe("findDuplicateCandidates", () => {
  it("flags an abandoned thread that was redirected elsewhere", () => {
    // The real Factorio Channel case: 8 messages, pointed at game-talk.
    const found = findDuplicateCandidates(
      [
        ...filler("101", 6),
        msg("101", "We have a thread already! Head over to <#700>"),
        msg("101", "Damn.....ill delete this one then"),
      ],
      [FACTORIO, GAME_TALK],
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.entity.name).toBe("Factorio Channel");
    expect(found[0]?.redirectsTo.name).toBe("🎮︱game-talk");
    expect(found[0]?.messageCount).toBe(8);
    expect(found[0]?.evidence).toContain("We have a thread already");
  });

  it("does NOT flag a busy thread that merely mentions a redirect", () => {
    // Sea of Thieves has 200 messages and mentions a redirect in passing.
    // Flagging it would spend a mod's attention on a false positive, which is
    // how a signal gets ignored.
    const found = findDuplicateCandidates(
      [
        ...filler("102", 200),
        msg("102", "for events head over to <#700> as well"),
      ],
      [SEA_OF_THIEVES, GAME_TALK],
    );
    expect(found).toEqual([]);
  });

  it("ignores redirect phrasing with no thread mentioned", () => {
    const found = findDuplicateCandidates(
      [msg("101", "I think we have a thread already somewhere")],
      [FACTORIO, GAME_TALK],
    );
    expect(found).toEqual([]);
  });

  it("ignores a mention of an Entity that is not in the Catalog", () => {
    // Excluded or deleted. Pointing a mod at nothing wastes their time.
    const found = findDuplicateCandidates(
      [msg("101", "head over to <#999999999999999999>")],
      [FACTORIO, GAME_TALK],
    );
    expect(found).toEqual([]);
  });

  it("ignores a thread that points at itself", () => {
    const found = findDuplicateCandidates(
      [msg("101", "we have a thread already, it is <#101>")],
      [FACTORIO, GAME_TALK],
    );
    expect(found).toEqual([]);
  });

  it("ignores bot messages", () => {
    const found = findDuplicateCandidates(
      [msg("101", "duplicate detected, see <#700>", true)],
      [FACTORIO, GAME_TALK],
    );
    expect(found).toEqual([]);
  });

  it("reports one candidate per thread, not one per matching message", () => {
    const found = findDuplicateCandidates(
      [
        msg("101", "we have a thread already <#700>"),
        msg("101", "yeah head over to <#700>"),
        msg("101", "can delete this, see <#700>"),
      ],
      [FACTORIO, GAME_TALK],
    );
    expect(found).toHaveLength(1);
  });

  it("orders the most obviously abandoned first", () => {
    const quiet = entity("103", "Pokemon Channel");
    const busier = entity("104", "MMORPG Channel");
    const found = findDuplicateCandidates(
      [
        msg("103", "head over to <#700>"),
        ...filler("104", 12),
        msg("104", "head over to <#700>"),
      ],
      [quiet, busier, GAME_TALK],
    );
    expect(found.map((c) => c.entity.name)).toEqual([
      "Pokemon Channel",
      "MMORPG Channel",
    ]);
  });
});

describe("formatForMods", () => {
  it("says so plainly when there is nothing to report", () => {
    expect(formatForMods([])).toBe("No duplicate candidates found.");
  });

  it("gives a mod the thread, the target, the count and the quote", () => {
    const found = findDuplicateCandidates(
      [msg("101", "we have a thread already, head over to <#700>")],
      [FACTORIO, GAME_TALK],
    );
    const out = formatForMods(found);
    expect(out).toContain("Factorio Channel");
    expect(out).toContain("<#700>");
    expect(out).toContain("(1 msg)");
    expect(out).toContain("we have a thread already");
  });
});

describe("evidence is safe to post and useful to read", () => {
  it("never lets quoted member text ping the guild", () => {
    // The output goes to a Discord channel. Quoting a message containing
    // @everyone verbatim would make the bot shout someone else's words.
    const found = findDuplicateCandidates(
      [msg("101", "@everyone we have a thread already, head over to <#700>, ask <@123456789012345678> or <@&987654321098765432>")],
      [FACTORIO, GAME_TALK],
    );
    const evidence = found[0]!.evidence;
    expect(evidence).not.toMatch(/@everyone(?!​)/);
    expect(evidence).not.toContain("<@123456789012345678>");
    expect(evidence).not.toContain("<@&987654321098765432>");
    expect(evidence).toContain("@member");
    expect(evidence).toContain("@role");
  });

  it("quotes around the trigger phrase, not the first 160 characters", () => {
    const preamble = "x".repeat(300);
    const found = findDuplicateCandidates(
      [msg("101", `${preamble} we have a thread already, head over to <#700>`)],
      [FACTORIO, GAME_TALK],
    );
    expect(found[0]?.evidence).toContain("we have a thread already");
  });

  it("does not match gaming chat about duplication glitches", () => {
    // This is a gaming community. "dupe" and "duplicate" are ordinary words
    // here, and matching them would spend a mod's attention on nothing.
    const noise = [
      "the dupe glitch still works? ask in <#700>",
      "they duped my loot lol <#700>",
      "duplicate spawns are back <#700>",
      "please remove this image mods <#700>",
    ].map((c) => msg("101", c));
    expect(findDuplicateCandidates(noise, [FACTORIO, GAME_TALK])).toEqual([]);
  });
});
