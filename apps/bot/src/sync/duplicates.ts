/**
 * Finds threads that announce their own redundancy.
 *
 * No model, no prompt, no vocabulary. When a member creates a thread that
 * already exists, somebody says so — "we have a thread already", "head over
 * to <#...>", "can delete this" — and the thread is then abandoned. That
 * exchange is a high-precision signal available for the cost of a regex.
 *
 * It finds only the subset that announces itself. Semantic duplicates —
 * "Disc Golf" vs "Frolf", "Audiophiles" vs "Audio Enthusiasts" — need meaning
 * rather than phrasing, and belong with the tagging work.
 */
import type { Entity } from "./catalog.ts";

/**
 * Measured 2026-09-02 across the real corpus. The 27 Entities carrying redirect
 * phrasing are cleanly bimodal by message count:
 *
 *   2,2,2,2,2,2,2,2,2,4,4,4,4,6,8,13,13 │ 40,42,81,90,99,118,159,160,168,200
 *
 * Below the gap: abandoned duplicates. Above it: busy threads that merely
 * *mention* a redirect and must not be flagged — Sea of Thieves, Date Night
 * Ideas, "Anybody from Europe in general here?". 20 sits inside the gap.
 */
export const ABANDONED_MESSAGE_CEILING = 20;

/**
 * Phrasing a human uses when pointing someone at the existing thread. Kept
 * deliberately narrow: precision matters far more than recall, because the
 * output is a mod's attention and a false positive spends it for nothing.
 *
 * Bare `dupe` and `duplicate` are deliberately NOT matched — this is a gaming
 * community, and "the dupe glitch still works?", "they duped my loot" and
 * "duplicate spawns" are ordinary chat. The nouns must be thread-shaped.
 */
const REDIRECT_PHRASING =
  /(?:already (?:have|exists|posted)|(?:we|you) (?:already )?have a\b[^.!?]{0,40}?\b(?:thread|channel|forum|post)s?\b|there(?:'s| is) already a|head over to|(?:is|as) a duplicate|duplicate (?:thread|post|of)|(?:delete|remove) this(?:\s+(?:one|thread|post)\b|(?=\s*[.!?,]|$)))/i

const MENTION = /<#(\d+)>/g;

/**
 * Quotes the message around the phrase that triggered the match, so a mod can
 * see the reason at a glance rather than the first 160 unrelated characters.
 *
 * Also neutralises anything that would ping when this is posted to a mod
 * channel. `@everyone`, `@here` and role mentions in quoted member text would
 * otherwise re-notify the guild — the bot shouting someone else's words.
 */
const excerpt = (content: string): string => {
  const flat = content.replace(/\s+/g, " ").trim();
  const at = flat.search(REDIRECT_PHRASING);
  const start = at > 60 ? at - 60 : 0;
  const window = flat.slice(start, start + 200);
  return (start > 0 ? "…" : "") +
    window
      .replace(/@(everyone|here)/gi, "@\u200b$1")
      .replace(/<@&(\d+)>/g, "@role")
      .replace(/<@!?(\d+)>/g, "@member") +
    (start + 200 < flat.length ? "…" : "");
};

export interface CapturedMessage {
  entityId: string;
  content: string;
  authorIsBot: boolean;
}

export interface DuplicateCandidate {
  entity: Entity;
  redirectsTo: Entity;
  messageCount: number;
  /** The message that triggered the match, for a mod to judge in one glance. */
  evidence: string;
}

export const findDuplicateCandidates = (
  messages: CapturedMessage[],
  catalog: Entity[],
  options: { ceiling?: number } = {},
): DuplicateCandidate[] => {
  const ceiling = options.ceiling ?? ABANDONED_MESSAGE_CEILING;
  const byId = new Map(catalog.map((e) => [e.id, e]));

  const humanCount = new Map<string, number>();
  for (const m of messages)
    if (!m.authorIsBot)
      humanCount.set(m.entityId, (humanCount.get(m.entityId) ?? 0) + 1);

  const found = new Map<string, DuplicateCandidate>();
  for (const m of messages) {
    if (m.authorIsBot) continue;
    if (!REDIRECT_PHRASING.test(m.content)) continue;

    const entity = byId.get(m.entityId);
    if (!entity) continue;

    // A busy thread that merely mentions a redirect is not a duplicate. This
    // is the whole reason the ceiling exists.
    const count = humanCount.get(m.entityId) ?? 0;
    if (count > ceiling) continue;

    for (const [, targetId] of m.content.matchAll(MENTION)) {
      // Must point somewhere real, and somewhere else.
      if (!targetId || targetId === m.entityId) continue;
      const target = byId.get(targetId);
      if (!target) continue;
      // First match wins: one candidate per Entity, not one per message.
      if (found.has(m.entityId)) break;
      found.set(m.entityId, {
        entity,
        redirectsTo: target,
        messageCount: count,
        evidence: excerpt(m.content),
      });
      break;
    }
  }

  return [...found.values()].sort((a, b) => a.messageCount - b.messageCount);
};

/** A mod channel post. The action they take happens in Discord anyway. */
export const formatForMods = (candidates: DuplicateCandidate[]): string => {
  if (candidates.length === 0) return "No duplicate candidates found.";
  const lines = [
    `**${candidates.length} possible duplicate thread${candidates.length === 1 ? "" : "s"}** — each looks abandoned and points somewhere else.`,
    "",
  ];
  for (const c of candidates) {
    lines.push(
      `• **${c.entity.name}** (${c.messageCount} msg${c.messageCount === 1 ? "" : "s"}) → <#${c.redirectsTo.id}>`,
      `  ${c.entity.url}`,
      `  > ${c.evidence}`,
    );
  }
  return lines.join("\n");
};
