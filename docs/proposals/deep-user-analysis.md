# Design: Deep User Analysis (#51)

**Status:** Draft for the owner's decisions, 2026-10-18. Not accepted; build
nothing until the decisions below and [ADR-0003](../adr/0003-staff-member-analysis.md)
are recorded.

"User" is the owner's name for the feature. In this repo's vocabulary the
subject is a **member**, and the person running it is **Staff**.

Claims about Discord or library behaviour are marked *(verified: how)* or
*(unverified)*.

---

## 1. The ask

A Staff-only command. Sherpa reads back through some or all of one member's
messages on the server and writes, for the Staff member who asked:

- a condensed timeline of their history;
- the key events;
- an analysis of their recent messages;
- their sentiment trend;
- notes for Staff, and optional action items.

The owner framed it as moderation, where the usual privacy considerations
"need not be as comprehensively respected". ADR-0003 records what that lifts.

## 2. What exists, and what is new

**Reused:**

- `boundary.ts`: `redact`, `namePattern`, the output validator, and the
  `extractIntroduction` pattern of a separate, fixed-prompt function with its
  own origin (responder §4).
- `session.ts`: `openBoundary`, `readMemberNames`, `usableMemberNames`,
  `retrying`.
- `interactions.ts`: `handleInteraction` (defer, then one follow-up),
  `reply()` (ephemeral, `allowed_mentions: { parse: [] }`), `dailyCap` (a
  persisted UTC-day counter), and the Staff check `isStaff` being built with
  `/sherpa` (responder §7, F5).
- `find.ts`: `isCandidate` and the Catalog's parent lookup, to decide which
  Channels a source may come from. `placeRef` for rendering a place.
- `privacy.ts`: `settings(memberId)` for the opt-out check.
- The member lookup, `GET /guilds/{id}/members/{user_id}`, for the subject's
  names. It needs no Guild Members intent *(verified 2026-09-01,
  `PROJECT-STATUS.md` §8)*.

**New:**

- A search read on the Discord port (§3).
- `analyseMember` in `boundary.ts`, under the `moderation` origin.
- A `/sherpa analyse` subcommand, its renderer, and its own daily cap.

## 3. Reading the history

`PROJECT-STATUS.md` §8 records that "no 'get messages by author' endpoint
exists". That is no longer clear. **Discord documents Search Guild Messages,
`GET /guilds/{guild.id}/messages/search`, with an `author_id` filter** *(verified:
typed in the installed `discord-api-types` 0.38.54, `RESTGetAPIGuildMessagesSearchQuery`,
citing Discord's docs; not called)*. Its documented terms:

- 25 results a page, an `offset` of at most 9,975, and `max_id` / `min_id`
  for going further back;
- `channel_id` (up to 500) and `author_type` filters, and `include_nsfw`;
- requires Read Message History, and is "restricted according to whether the
  `MESSAGE_CONTENT` Privileged Intent is enabled", which it is
  (`GATEWAY_MESSAGE_CONTENT_LIMITED`, *verified 2026-09-01*);
- may answer **202 "index not yet available"**, with no results.

*(Unverified)*: that a **bot** token may call it, and its rate limit. The first
packet checks both with one real call before anything else is built. If bots
cannot use it, the fallback is paging every Catalog Channel's history, which is
thousands of requests per run, and the feature should be re-scoped to Tier 0's
six days.

**What is read:**

- The subject's messages, newest first, from Catalog Entities and their
  Threads and Posts only, never from withheld ones (ADR-0003). The search
  result's `channel_id` is checked against the Catalog in code, so a
  Staff-only Channel the bot can read is dropped even if search returns it.
- Monitored Channels' messages only if the owner chooses so (ADR-0003 O4).
- With the replied-to message as context, if ADR-0003 O6 allows it. It comes
  from the search result's `referenced_message` when present
  *(unverified that search includes it)*; otherwise no extra fetch.
- **Depth:** at most **1,000** messages per run, or back to a date Staff
  choose, whichever is less (D51-3).

Nothing read is written to disk. Tier 0 is not used: it holds six days and
excludes exactly the monitored and opted-out text this tool may need, and a
second source would be a second set of rules.

## 4. The model calls

**`analyseMember`, in `boundary.ts`:**

- Takes the subject's id, their names, the sources, and the Catalog. Refuses
  any source not authored by the subject (except the context O6 admits), from
  a Channel outside the Catalog, or from a withheld one.
- **Opt-out check first,** per the owner's answer to ADR-0003 O3.
- Redacts as `ask()` does, with the subject's own names becoming "the member".
- Model role: `cheap` (`deepseek-v4-flash-0731`), the model every other text
  call uses.

**Two passes,** because 1,000 messages do not belong in one prompt:

1. **Chunk:** up to 200 messages per call, oldest to newest, each line
   `[index] YYYY-MM-DD <place name>: <text, cut at 500 characters>`. It
   returns:
   ```
   { "events": [{ "at": index, "kind": "conflict" | "rule_concern" | "support_need"
                    | "wellness" | "activity_change" | "contribution" | "other",
                  "note": string ≤ 160 }],          // ≤ 8
     "tone": [{ "month": "YYYY-MM", "tone": "positive" | "neutral" | "mixed" | "negative" }] }
   ```
2. **Reduce:** one call over the chunk results (derived text only), plus the
   newest 100 messages raw for the recent analysis. It returns:
   ```
   { "timeline": [{ "month": "YYYY-MM", "line": string ≤ 160 }],   // ≤ 12
     "key_events": [index],                                       // ≤ 8, from the events
     "recent": string ≤ 600,
     "trend": "improving" | "stable" | "declining" | "unclear",
     "notes": string ≤ 600,
     "actions": [string ≤ 160] }                                  // ≤ 3
   ```

Every index must be one that was sent; code turns it into a jump link. A
string over its cap, an unknown index, or a validation failure is a failed
call, retried once (`retrying`), then the run reports failure. Nothing partial
is shown as complete.

## 5. What Staff see

`/sherpa analyse member:<member> [since:<YYYY-MM-DD>]`

- Deferred ephemerally at once. The deferred reply is edited with progress
  ("Read 400 of up to 1,000 messages"), then with the report.
- **The interaction token lasts 15 minutes** *(stated in `find.ts`; unverified
  today)*. So a run is capped at **12 minutes** of reading and calls; past
  that it reports on what it read, and says so.
- The report is embeds, built from a template: a header with `<@subject>`,
  the range read and the message count; the timeline; the key events, each
  with its kind label and a jump link; the recent analysis; the trend; notes;
  action items. Every string is the model's, inside fields the template
  owns. `allowed_mentions: { parse: [] }`, so nobody is pinged.
- A footer says what was left out: opted-out (if O3 A), monitored (if O4 is
  no), withheld, and messages past the depth.

## 6. What is kept

| Data | Where | How long |
|---|---|---|
| The subject's messages | Memory, for the run | The run |
| Chunk results | Memory | The run |
| The report | The ephemeral Discord reply only | Until the Staff member dismisses it, as Discord keeps ephemeral messages |
| Who ran it, on whom, when, how many messages | Railway logs, ids and counts only (D26) | Railway's retention |
| The cap counter | `.data/analyse-usage.json` (`dailyCap`) | One UTC day |

**Erasure** has nothing of Sherpa's to remove: no row holds the report or the
messages. A durable audit row is an owner decision (D51-5).

## 7. Permissions, intents and cost

- **No new intent, scope or permission.** Search needs Read Message History,
  which the bot holds wherever it reads today.
- **Discord:** about 40 search pages for 1,000 messages *(unverified rate
  limit)*.
- **Model:** about 30,000 input tokens for 1,000 messages, in at most 6
  calls. At the measured ~$0.003 per ~50,000-token `/find` call (`f6e7d9d`),
  a run is under 1¢.
- **Caps:** 10 runs a day across all Staff (`SHERPA_ANALYSE_DAILY_CAP`), one
  run at a time, and a cooldown of one run per subject per hour. A run counts
  every model call against the cap, as `/find` does.

## 8. Failure

- Search unavailable, 202, or rate-limited past the 12 minutes: the reply
  says the history could not be read, and reports nothing.
- A model call failing twice: the reply says the analysis failed. No partial
  report.
- Subject not in the guild: search by id still works; their names come from
  the search results' author objects for redaction.

## 9. Owner decisions needed

ADR-0003's O1–O7 apply here: people as subjects, bounded model text, opted-out
members, monitored conversation, child data, others' messages, and who counts
as Staff. Specific to this tool:

1. **D51-1. Build it on the search endpoint, if the first packet shows a bot
   can use it.** Recommended. Alternative: Tier 0's six days only, which is
   cheap but is "recent", not "deep".
2. **D51-2. The report is ephemeral and never stored.** Recommended.
   Alternatives: also post it to the member's Post in `📊︱user-monitoring`
   (it then outlives erasure, and #52's Forum permissions come first); or
   store it in `bot.db` (new member data with its own retention).
3. **D51-3. Depth: 1,000 messages, or a `since` date.** Recommended.
   Alternative: all history, with no cap other than search's own limits,
   which makes cost and time per run unbounded.
4. **D51-4. Caps: 10 runs a day, one per subject per hour.** Recommended.
5. **D51-5. Audit: log lines only.** Recommended, as D26 does for the
   responder. Alternative: a durable row (who, whom, when), kept 90 days as
   the policy keeps Staff edit history, which then needs a line in the
   policy and an erasure rule.
6. **D51-6. Staff members and bots as subjects.** Recommended: any member;
   refuse bots. Alternative: refuse Staff as subjects.

## 10. Packets

In order, per `docs/agents/delegation-model.md`. Nothing starts before the
owner's decisions and ADR-0003 is accepted.

1. **Discovery: search for bots.** One authenticated call with the bot token
   against a Staff member's own id, recording status, headers and page shape.
   No content is kept or committed. *Opus implementer, Medium, or the main
   thread.* Its result decides D51-1.
2. **The search read port.** `searchByAuthor(memberId, { maxId, channelIds })`
   in `discord-adapter.ts`, paginated, with 202 and 429 handling. *Sonnet,
   High.* Depends on 1.
3. **`analyseMember` in the boundary,** with the origin checks, opt-out per
   O3, the subject's names, and index-only citations. *Opus implementer,
   High: a privacy contract.* Parallel with 2.
4. **The command:** `/sherpa analyse`, chunk and reduce, the renderer, the
   cap, progress edits, the 12-minute ceiling. *Opus implementer, High, or
   Luna Max.* Depends on 2 and 3, and on `/sherpa` and `isStaff` from the
   responder.

Then the final review (GPT-5.6 Sol), as always.

## 11. Tests

Only where a failure would be invisible or easy to get almost right:

- **The boundary:** a source from another author, from a withheld Channel,
  from a Thread under a withheld or (if O4 is no) monitored Channel, or from a
  Channel outside the Catalog, is refused. An opted-out subject is refused
  under O3 A. The subject's names never leave, in any case.
- **Citations:** an index that was not sent fails the call; every rendered
  link points at a message that was sent.
- **Output validation:** a snowflake, a mass mention or a member name in any
  field, keys included, fails the call (the existing validator, on the new
  schema).
- **The renderer:** no reply pings anyone.
- **The cap:** counts every model call, and a corrupt counter means a spent
  day (`dailyCap`'s existing test covers the counter; the new test covers
  that each chunk call takes from it).

Each is shown to fail against a broken guard before it is kept. No real
member's messages go into fixtures, tests or docs.

## Owner decisions (2026-10-18)

D51-1, D51-2 and D51-4 to D51-6 are accepted as recommended.

- **D51-3:** the depth is **everything since the member joined**. Runs should
  be deliberate and infrequent, and the caps (D51-4) keep them so. The depth
  can be revisited later.
- ADR-0003 is decided; see its owner decisions. Staff here means **holders of
  the role named `Staff` alone** (O7).
