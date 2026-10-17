# Design: the introductions responder

**Status:** Accepted design, 2026-10-17 (implementation needs a separate
go-ahead). The owner answered the open decisions on 2026-10-17. They were
relayed through the coordinating agent and are recorded under *Decisions*
at the end. Several answers raised new questions, listed under *Follow-up
decisions*. Implementation should not start on the parts those questions
touch until they are answered.

**Fixed earlier (owner, 2026-10-16):**

- Shadow output goes to `#bot-tests` (`1544502247587582033`).
- The monitored Channel is `👋︱introductions` (`1084293546183495720`).

**Builds on `main` at `a5d6bf4` (#42):**

- monitored Channels by id, through `readMonitored`;
- the member-name cache (`readMemberNames`, `usableMemberNames`);
- `opted_out_name`;
- `/monitored`.

**Locked statements:** `PROJECT-STATUS.md` §7 and its §4 privacy model;
`ASTRO-ARCHITECTURE.md`'s stop conditions, anti-goals and golden set; and
ADR-0001. Where an owner decision below departs from them, the decision says
so.

Claims about Discord or library behaviour are marked *(verified: how)* or
*(unverified)*.

---

## 1. What Sherpa does

**The autonomous path.** When a member posts an introduction in
`#introductions`, Sherpa makes **exactly one** autonomous post in reply. It is
one of these:

- a welcome with places that fit what the member said;
- a warm welcome with no suggestions, when every match has already been
  named by someone else;
- a welcome with one question, when the member said nothing to match on.

Sherpa's contribution is **additive** (D2): places other members named are
dropped, and Sherpa adds what they missed.

**The invited path.** Later, the member can `@mention` Sherpa, or reply to its
post, to explore further. That conversation is capped at 3 exchanges (D15).

**Modes.** Staff switch between three modes with `/sherpa`:

- `off`;
- `shadow`: the reply Sherpa would have posted goes to `#bot-tests`;
- `live`: the reply goes inline in `#introductions`.

**The cutover is that switch.** By D6 the owner has authorised Staff to make
the bot's first `#introductions` post by setting `live`. No code change is
needed.

---

## 2. Read path: the gateway (D20)

The owner wanted a webhook for the one Channel. Discord has no incoming
webhook that delivers a Channel's messages *(unverified: per Discord's
webhook documentation, not re-read today)*, so the push option is the
gateway.

- **Intents.** `run.ts` adds `GuildMessages` (512) and `MessageContent`
  (32768) to `Guilds` *(verified: bit values in the installed
  `discord-api-types` 0.38)*.
  - Intents are not OAuth scopes. Message Content is already granted to
    this application (`GATEWAY_MESSAGE_CONTENT_LIMITED`, *verified
    2026-09-01, `PROJECT-STATUS.md` §8*).
  - **The owner approved adding both intents on 2026-10-17.** The comment in
    `run.ts` explaining why it asks only for `Guilds` changes with them.
- **The filter is the first line of the handler.**
  - `MESSAGE_CREATE`, `MESSAGE_UPDATE` and `MESSAGE_DELETE` pass only when
    `channel_id` is `1084293546183495720`. Everything else is dropped on the
    spot: never stored, never logged, never passed on.
  - Threads inside `#introductions` have their own `channel_id`, so they are
    dropped too. They are never answered (D27).
  - Messages that mention Sherpa outside `#introductions` are dropped as
    well, until F4 decides otherwise.
- **The process still receives the whole guild's messages** before the
  filter drops them. That is a fact of the intent, and the owner accepted it.
  `@discordjs/ws` parses each payload before the handler sees it *(verified:
  how `run.ts` is wired)*.
- **Edits and deletes arrive as events.** `GuildMessages` covers update and
  delete *(unverified: Discord's intents list, not re-read today)*, which
  replaces the per-tick re-fetch the polling design needed.
- **Startup catch-up.** On connect, one REST read of `#introductions` runs
  from whichever is older: the oldest open row's intro, or now minus 24
  hours. It uses `limit=100`, paginates forward, and sorts by id. This
  covers messages posted while the process was down. Gateway resume covers
  short disconnects *(unverified)*.
- **Checks at startup and hourly.** If any fails, the responder pauses and
  logs loudly. The erasure loop (§6) and slash commands keep running.
  - Message Content is present.
  - `#introductions` is visible and `contentReadable`, because a denied
    history returns `200 []` *(verified 2026-09-01, §4)*.
  - In `#bot-tests`, the bot can view and send, and can read history (for
    the tally in §8).
  - The bot can send in `#introductions`. This one is checked only in
    `live`.
  - No delete permission is checked (D5).

---

## 3. Who is evaluated, and when

### Eligibility

**Any introduction, at any time, is eligible** (D12, D24). There is no cutoff
and no join window. A message starts an evaluation when all of these hold:

- it is in `#introductions`;
- it is from a non-bot author;
- the author has `approach` and `processing` on;
- the author has no row and no tombstone (§5);
- the message counts as an introduction (F2).

The `Member` role is **not** required (D25). The risk: a member who has not
yet been given the role may be pointed at places they cannot see. The reply
names them anyway, and the template does not say they are Member-only.

The member lookup (`GET /guilds/{id}/members/{user_id}`, which needs no
Guild Members intent, *verified 2026-09-01*) is still made, once per new
author. It supplies their names for redaction (§4) and their `joined_at` for
the tombstone (§5).

**What counts as an introduction (F2).** With no join window, a long-standing
member who writes "Welcome!" under a newcomer's intro would otherwise count
as an introduction of their own. The proposal: a message counts only if
**it is not a reply, mentions no other member, and its author has never
posted in `#introductions` before**. "Never before" comes from tombstones,
seeded once from the Channel's history when the responder first starts
(F2).

### Watching, in plain terms (D13)

**Watching** is the time between a member's introduction and Sherpa's one
autonomous post. While watching, Sherpa:

- holds what it extracted from the member's words and images, **in memory
  only**;
- reads the member's own follow-ups, re-extracting each time, up to 3
  extractions;
- notes, mechanically, whether other members welcomed the member, asked
  them a question, or named places;
- counts the minutes in which other members were active.

**Watching ends** in one of three ways:

- Sherpa posts;
- the ceiling passes (6 active hours) or the 24-hour hard stop passes;
- the member deletes their intro or opts out.

The extraction is then dropped.

**The clock mode** is set by Staff (D1): `wall` (minutes since the intro) or
`active`. An active minute is one in which at least one non-bot message **from
someone other than the member, and not from a member with processing off**,
was posted in the Channel (D10).

The defaults, all changeable by Staff at runtime (§7):

- greet at 10 minutes;
- recommend at 20 minutes;
- a ceiling of 6 active hours;
- a hard stop at 24 wall-clock hours.

| When | If | Sherpa's one post |
|---|---|---|
| Greet threshold | No signal (a greeting, or nothing extractable) **and** no other member has asked the member a question | Welcome and one question (**Zifei**) |
| Recommend threshold, counted from the member's latest message carrying signal | Signal | Welcome and the places that survive novelty. If none survive: a warm welcome with no suggestions |
| Ceiling or hard stop | Nothing posted yet | A warm welcome with no suggestions |

**This is how "exactly one autonomous greeting" (D15) and the two configurable
thresholds (D1) are reconciled. It is an interpretation, so it is F1.** A
human's question holds back Sherpa's own question (D3). Sherpa then waits for
late signal: **Mark Weigl**'s case.

### Golden cases, under the decisions

| Case | Expected |
|---|---|
| HammerFoe | Recommends the long tail. The places humans named are dropped by novelty |
| Rat. | With `active`: silent until humans are active. With `wall`: posts at 10 or 20 minutes overnight |
| Mark Weigl | No early question (a human asked). Recommends after his late reply |
| ConnorDavidSmith, xEMPTYCANx | A warm welcome with no suggestions, if novelty removes everything. Confirm live (§9) |
| Zifei | Welcome and one question; no match call |
| Schwagle (empty) | Not an evaluation: no row, no call, no post. His next message is evaluated normally |

**Empty and image-only.** An empty or sticker-only message starts nothing and
closes nothing. **An image-only intro is evaluated** through its images (§4,
D14).

---

## 4. The model calls

### Extraction: `extractIntroduction`

This is the only path through which monitored content reaches a model.

- **Where it lives.** In `boundary.ts`. It shares `ask()`'s internals, but is
  not an option on `ask()`.
- **Its sources.** Each one is built by the read port from the gateway or
  REST message itself: `authorId` from `author.id`, and origin set to the
  watched Channel. It refuses a source by any other author, or from any
  other origin.
- **Fixed by construction:**
  - **Prompt and parser:** a constant prompt and a fixed parser.
  - **Model:** `cheap` for text, `vision` when images are present.
  - **Catalog:** none is sent.
  - **Text length:** cut at 2,000 code points, on a whitespace boundary.
- **Names.** `memberNames` is the cache together with the member's own
  username, global name and nickname from the member lookup. The member's own
  names are otherwise absent, because the monitored Channel is never
  captured. All of them pass `usableMemberNames`.
  - **The ceiling:** a name under 3 characters, or one that matches a
    Channel, Forum or Topic name, goes out unredacted, as #42 accepts.
- **Opt-out, redaction and output validation are as `ask()`.**

The output schema (structured output only):

```
{ "signal": "none" | "some",
  "interests": string[]   // ≤ 5, ≤ 40 chars each
  "topics": slug[]        // ≤ 3, frozen vocabulary
  "life_stage": enum[] }  // §4 enum (expecting … adult_children) — D8
```

`life_stage` is held in memory and used only as match input (D8). It never
counts as signal on its own, is never stored, is never scheduled on, and is
never aged. Free-text interests can also carry child details ("newborn")
into the match query.

### Images (D14)

The owner decided this on the child-data stop condition, explicitly: **intro
images are read, and the owner accepts that photos, including photos of
children, are sent to the model provider.** They are never stored, never
shown and never logged.

- **Which images:** image attachments on the member's own messages in the
  watch, and on their invited-path messages.
  - Only `image/png`, `image/jpeg` and `image/webp`.
  - At most **3 per message** and **6 per member**.
  - Each is downloaded from the attachment's `proxy_url` with
    `?width=1024&height=1024`, so Discord does the downscaling *(unverified:
    the media proxy's resize parameters; if they are ignored, any file over
    4 MB is skipped)*. No image library is added.
  - Each is sent as a base64 data URL, so the provider never fetches from
    Discord. It is held in memory for the call only.
- **The model:** a new `vision` role, `LLM_MODEL_VISION`, proposed as
  `deepseek/deepseek-v4.1-flash-1017`. It is the dated vision build of the
  family already in use. OpenRouter lists it with text and image input,
  priced at about $0.08–0.30 per million input tokens across more than 9
  zero-data-retention endpoints *(verified 2026-10-17 against
  `openrouter.ai/api/v1/models` and `/endpoints/zdr`)*.
  - The configured `deepseek-v4-flash-0731` is text-only *(verified, same
    source)*.
  - Routing is unchanged: `data_collection: "deny"` and `zdr: true` are
    forced by `openai-wire.ts` *(verified: `main`)*.
  - Whether every one of its ZDR endpoints accepts images is unverified. A
    paid live check (§9) settles it before `shadow` (F7).
- **Wire change.** `openai-wire.ts` sends `content` as a string today. For
  vision calls it sends the OpenAI multipart form (`text` and `image_url`
  parts). The OpenRouter host check and the forced routing are unchanged.
- **Containment.** An image cannot be redacted: a name written in a photo
  leaves as it is. Output validation still applies, and nothing the model
  writes reaches Discord.
- **Cost:** about 1–1.5k input tokens per downscaled image *(unverified,
  model-dependent)*, so under $0.002 per image-carrying intro.

### Matching

Matching uses `findPlaces`, with one change: the source origin is passed in by
the caller. The responder passes `{ derivedFromIntroduction: memberId }`. The
query is `life_stage`, then Topics, then interests, with whole items dropped
until it fits 300 characters.

**Boundary changes** (D22, which closes #40):

- `Source` gains a required `origin`;
- `ask()` refuses any source whose `entityId` is monitored or missing from the
  Catalog;
- `extractIntroduction` is the only path where that refusal is lifted.

### Novelty

Drop any match that another member has named since the intro, as `<#id>` or
as a `discord.com/channels/…` link. Messages from members with processing off
are ignored (D10). Whatever survives goes in Sherpa's post. With nothing left,
the post is a warm welcome (D2). Every id must be a current `isCandidate`.
Age-stage Channels are allowed (D9).

---

## 5. What is kept (D7, D21)

**No profile** (D21). It may be revisited later, if keeping one would help
members.

| Data | Where | How long |
|---|---|---|
| Intro and follow-up text, and images | Memory, for the extraction call | The call |
| Extraction output | Memory | The watch |
| Others' messages | Read mechanically, never sent to a model. Opted-out members' messages are ignored entirely | The event |
| `introduction` row | `bot.db` | 30 days, or until erased |
| `tombstone` | `bot.db` | **Indefinite (F3)**, kept through erasure |
| `sherpa_setting` (mode, clock, thresholds) | `bot.db` | Until changed |

```
introduction(
  member_id      TEXT PRIMARY KEY,
  message_ids    TEXT NOT NULL,     -- [{id, edited_at}] that fed an extraction, intro first
  started_at     TEXT NOT NULL,
  extractions    INTEGER NOT NULL DEFAULT 0,
  posted_at      TEXT,              -- claimed before the one autonomous post
  outcome        TEXT CHECK (outcome IN ('responded','expired','failed')),
  reason         TEXT,              -- 'recommended','welcome_only','question','cap','error','off'
  invited        INTEGER NOT NULL DEFAULT 0  -- invited-path exchanges, ≤ 3
)
tombstone(member_id TEXT PRIMARY KEY, joined_at TEXT, closed_at TEXT NOT NULL)
sherpa_setting(key TEXT PRIMARY KEY, value TEXT NOT NULL, set_by TEXT NOT NULL, set_at TEXT NOT NULL)
```

**Atomicity, carried over from the reviewed design:**

- **A row is created by one conditional `INSERT … SELECT … WHERE NOT EXISTS`**
  against the tombstone and the opt-outs, after the last `await`.
- **Every action is claimed** with `UPDATE … WHERE <field> IS NULL`, and a
  change count of 1 is required before any slow or visible step:
  - `posted_at` before the one post;
  - `outcome` before closing;
  - `extractions < 3` before each extraction call;
  - `invited < 3` before each invited reply.
- **Before every post and every model call,** the member's settings, the
  row's existence and the mode are read again.

The result: a crash costs a missed post, never a duplicate.

**The tombstone (D4, F3).**

- **Written** when a row closes, and on every erasure of a row.
- **What it does:** a tombstone for the member's *current* `joined_at` blocks
  any new evaluation. A different `joined_at` means the member left and
  rejoined. They are treated as new, which is the rejoin lapse the owner
  accepted.
- **Retention:** with no join window, a 30-day tombstone would let anyone be
  welcomed again a month later. So it is kept indefinitely, as opt-outs are.
  That is a retention decision, so it is F3.

---

## 6. Erasure

**Sherpa never deletes its own posts**, in `#bot-tests` or in
`#introductions`. Staff handle every deletion (owner, 2026-10-17; F6 confirms
that this covers live posts). There is therefore no post-deletion queue, no
reconciliation and no nonce.

**What the owner accepted:** `delete-my-data` and deleting the intro do not
remove shadow or live posts. Those posts still tie the member, through the
jump link or the reply, to places, possibly age-stage Channels.

**What erasure does cover: the durable row, and memory.**

- **`/privacy delete-my-data`, `opt-out approach` and `opt-out processing`**
  delete the row and write the tombstone, synchronously in the handler. The
  responder drops the member's in-memory extraction at its next settings
  check, which runs before any call or post.
- **A deleted contributing message.** A `MESSAGE_DELETE` for any id in
  `message_ids` erases the row, writes the tombstone and drops the
  extraction. As a backstop, the **erasure loop** re-fetches those ids
  hourly, to catch deletions made while the process was down.
- **Age.** Rows older than 30 days are deleted.

**The erasure loop runs in any mode,** including `off`, and whether or not
the responder's checks pass. It stops once no rows remain.

**Timing:**

- **The row:** gone at once on a `/privacy` erasure.
- **A deletion in Discord:** handled at once while the process runs, and
  within about an hour otherwise.
- **Backups:** within about 31 days: the bucket's 30-day lifecycle rule plus
  R2's best-effort expiry, the bound the owner accepted (`docs/runbook.md`).
- **Railway logs:** they carry member and message ids (D26), and their
  retention is Railway's, **outside the erasure policy**.

---

## 7. Staff controls: `/sherpa` (D1, D16, D17, D18)

**Staff** here means holders of a role **named `Staff`**, resolved by name
from the role manifest, as `isMember` resolves `Member` (owner, D16).

- **The rename ceiling.** Renaming the role locks everyone out of `/sherpa`.
  It fails closed.
- **A glossary difference (F5).** `CONTEXT.md` defines Staff as `Staff` *or*
  `Event Managers`. This command uses `Staff` only.
- **Visibility.** Discord cannot hide a command by role at registration
  without an OAuth bearer token *(unverified)*. So `/sherpa` is visible to
  everyone, refuses non-Staff on use, and every reply is ephemeral.

The subcommands:

- `/sherpa introductions mode off|shadow|live`
  - Setting `live` is logged loudly, with who did it.
  - **`live` is never a default.** With no setting row, the mode is `off`.
  - The process also needs `SHERPA_INTRODUCTIONS=1` in its environment, so
    local runs never start the responder.
- `/sherpa introductions clock wall|active`
- `/sherpa introductions timing greet:<min> recommend:<min> ceiling:<active-hours>`
  - Bounded: greet 1–120 minutes; recommend at least greet, and at most 360;
    ceiling 1–24 active hours.
  - The 24-hour hard stop is fixed.
- `/sherpa introductions status` shows the current settings and the shadow
  tally (§8).

Settings live in `sherpa_setting` and are read before every decision, so a
change applies at once. Any other threshold stays an env value, applied on
restart (D17). The watched Channel stays a constant, asserted to be monitored
(D18).

**The guard between the modes.**

- **One write port.** Its only write is `post(kind, body)`. It resolves the
  target from the mode at call time:
  - `shadow` posts to the constant `#bot-tests` id;
  - `live` posts an inline reply to the intro in the constant
    `#introductions` id.

  It takes no channel argument.
- **Live-mode post shape.** A live post sets
  `allowed_mentions: { parse: [], replied_user: true }`, which keeps §7's
  reply ping. The first live post is that setting's first real test
  *(unverified)*.
- **Assertions.** The shadow target is excluded and not monitored. The live
  target is monitored.
- **A test.** It records every write in each mode, and fails on any write to
  any other id, or to `#introductions` while in `shadow`.

---

## 8. Shadow review and go-live (D28)

- **The shadow post:**

  ```
  Intro responder (shadow) · would POST <kind> · intro: <jump link>
  Timeline: clock active · acknowledged +2m · active minutes 20 · extractions 1 · novelty dropped 1 · images 1
  Would post:
  > <the exact live reply>
  ```

  It shows no intro text, no member name and no extracted fields (D23).
  Invited-path replies in shadow use the same format (F4).
- **Review.** Staff react to each post: ✅ right, ❌ wrong, ⚠️ harmful.
- **The tally.** A daily pass lists Sherpa's own posts in `#bot-tests`, reads
  each one's `reactions` counts and its kind from the header, and computes
  the go-live bar:
  - at least 14 days since `shadow` was first set;
  - at least 30 autonomous posts;
  - zero ⚠️;
  - at least 80% ✅ across the posts.

  A post Staff delete drops out of the tally.
- **When the bar is reached,** Sherpa posts one comment in `#bot-tests`
  saying so, with the counts. It is posted once, recorded in
  `sherpa_setting`. **Going live stays a manual Staff switch.**
- **In `live`,** the reply goes only to `#introductions`, with no
  `#bot-tests` copy.

---

## 9. The invited path (D15, F4)

- **Trigger:** a message in `#introductions` that mentions Sherpa, or replies
  to Sherpa's post. It counts as invited only after the member's one
  autonomous post, or after no row exists for them.
- **Flow (§7's invited path):**
  1. Extract from the new message, together with the member's earlier
     contributing messages, re-fetched by id while the row lives.
  2. If there is signal, match with `findPlaces`. **Novelty is not applied
     here: the member asked.**
  3. Otherwise, ask one fixed targeted question.

  Each exchange is claimed (`invited < 3`). After the third, Sherpa posts the
  widest doors and the Index link. **Structured output and templates only.**
- **Opt-outs.**
  - `approach` off: does not apply, because the member asked.
  - `processing` off: Sherpa replies with the fixed `/find` opt-out text.
- **The same daily cap, the same mode** (shadow means `#bot-tests`), and the
  same Member-role rule (none).
- **Where (F4):** `#introductions` only, for now. `PROJECT-STATUS.md` §2 also
  lists "responds to direct mentions anywhere it has access". Answering
  elsewhere means public posts in other Channels, and member text from
  unmonitored Channels reaching a model under a new `mention` origin. It is
  proposed as a later step, with its own toggle.

---

## 10. Tests

**Offline, in `npm test`:**

- `decide(timeline, settings, now)` for the golden cases above, in both
  clock modes.
- The gateway filter drops every event not from `#introductions`.
- Opted-out members' messages count for nothing: not activity, not
  acknowledgement, not novelty.
- The boundary:
  - origin checks, including a Thread under a monitored Channel and an
    unknown id;
  - `extractIntroduction` refuses a mixed author or a foreign origin;
  - it truncates long text, and caps the image count.
- The wire builds multipart content only for the `vision` role.
- Atomicity: row creation, and each claim under two concurrent decisions.
- Restart: a row with `posted_at` set gets no second post.
- Erasure: a `/privacy` opt-out followed by an opt-in leaves the row erased
  and the tombstone kept; a `MESSAGE_DELETE` on a follow-up erases the row;
  the erasure loop runs in `off`.
- The write-port test in each mode.
- The tombstone: the same `joined_at` blocks; a new one admits.

**Each guard test is shown to fail** against a broken guard before it is
kept.

**By hand, and paid:**

- Synthetic intros, including synthetic images with no real people, go
  through extraction and then matching.
- The ConnorDavidSmith and xEMPTYCANx shapes are confirmed to come out as
  welcome-only.
- One vision call is checked against `deepseek-v4.1-flash-1017` with the
  forced routing (F7).

**Never locally:** the responder runs only where `SHERPA_INTRODUCTIONS=1`
and a mode is set, which means in deployment. `record-fixtures.ts` records
Channel objects only. No real intro or image goes into fixtures, tests or
docs.

---

## 11. Cost and rate

| Per introduction | Calls | Cost |
|---|---|---|
| Extraction, text | ≤ 3 | well under 1¢ |
| Extraction with images (≤ 3, downscaled) | within the same ≤ 3 | under 0.2¢ more |
| Match (`findPlaces`, ~50k tokens) | ≤ 1, plus a retry | ~$0.003 each (`f6e7d9d`) |
| Invited path | ≤ 3 exchanges × (extraction + match) | ≤ ~$0.01 |

That is about $0.02 per member at worst, or about $2 a month at 3 a day. The
daily cap stays at 60 paid calls (D29) and covers both paths. Far inside the
~$30/month ceiling. Prices are as listed on 2026-10-17 and in `f6e7d9d`.

---

## Decisions (owner, 2026-10-17)

Relayed through the coordinating agent. Numbers match the previous decision
list.

1. **Greeting clock:** both, as a Staff toggle (`wall` or `active`). The
   clock and thresholds are set at runtime through `/sherpa` and stored
   durably; for these values this supersedes 17. Active minutes count only
   other members' messages.
2. **Named places:** B. Sherpa's contribution is additive, and when novelty
   leaves nothing, it posts a warm welcome with no suggestions.
3. **A human question:** B. It holds back only Sherpa's own question.
4. **Erasure against permanence:** A, a tombstone. The rejoin lapse is
   accepted.
5. **First post:** Sherpa may post in `#bot-tests`. No canary, no
   delete-permission check; Staff handle deletes.
6. **Live path:** built now. A Staff `shadow`/`live` toggle does the cutover.
   **The owner thereby authorises Staff to make the bot's first
   `#introductions` post by setting `live`.**
7. **New tables:** yes.
8. **Child data:** A. A coarse `life_stage`, in memory, for matching only.
9. **Age-stage Channels:** A. Allowed in shadow and live.
10. **Opted-out members' messages:** A. Ignored entirely, and they count as
    inactive.
11. **Privacy policy:** no change ("not a business"). The owner accepts the
    policy as it stands. It does not mention any of the following, and the
    owner accepted each one:
    - introductions being matched to places;
    - images going to the model;
    - the tombstone kept through erasure;
    - shadow and live posts surviving `delete-my-data`;
    - ids in Railway logs.
12. **Join window:** superseded by 24. Any introduction at any time is
    eligible, still with one autonomous post per member.
13. **Watching:** explained in §3. The 6 active hours and the 24-hour hard
    stop are kept.
14. **Images:** read through an OpenRouter vision model, never stored or
    shown. **The owner explicitly accepts, on the child-data stop condition,
    that photos, including photos of children, go to the model provider.**
    Image-only intros are no longer terminal.
15. **One response:** exactly one autonomous post. An `@mention` that asks
    for more is answered through the invited path.
16. **The `/sherpa` command:** yes. Staff are holders of the role named
    `Staff`, by name.
17. **Other thresholds:** env values, applied on restart.
18. **The watched Channel:** a constant for now; it may be made configurable
    later.
19. **The greeting points to `/find`:** agreed.
20. **Read path:** the gateway, with `GuildMessages` and `MessageContent`,
    approved by the owner. Every event outside `#introductions` is dropped.
21. **No profile, for now.** It may be revisited.
22. **The boundary as proposed:** agreed.
23. **Shadow post contents:** agreed.
24. **Cutoff:** none (see 12).
25. **No Member-role requirement.** The risk is noted in §3.
26. **Logs include member and message ids.** Railway's retention is outside
    the erasure policy.
27. **Threads in `#introductions` are never answered:** agreed.
28. **Go-live** is a manual Staff switch. Sherpa posts in `#bot-tests` when
    the bar is reached.
29. **Daily cap of 60:** agreed.
30. **Deletes (shadow-post cleanup):** Staff handle all of them. Sherpa never
    deletes its posts, including on `delete-my-data` or when an intro is
    deleted. The owner accepts that `delete-my-data` does not remove shadow
    posts.

## Follow-up decisions

- **F1. The one-post timing (from 1 and 15).** Sherpa makes one autonomous
  post. It goes at the greet threshold when there is no signal and nobody has
  asked a question; otherwise at the recommend threshold, counted from the
  latest message carrying signal; otherwise at the ceiling, as a warm
  welcome. Accept, or define it differently?
- **F2. What counts as an introduction (from 12).** The proposal: a message
  that is not a reply, mentions no other member, and comes from someone who
  has never posted in `#introductions`. Behind that, a one-time seed: read
  the Channel's full history at first start, and store tombstones holding
  author ids only. Without the seed, every regular who posts there gets
  welcomed once. Accept both?
- **F3. Tombstone retention (from 4 and 12):** indefinite, keyed by member
  and `joined_at`, and kept through erasure as opt-outs are. Yes?
- **F4. The invited path's scope (from 15):** `#introductions` only for now,
  with "anywhere" later behind its own toggle? And in `shadow`, should
  invited replies also go only to `#bot-tests`? If so, a member who asks
  sees no answer until `live`.
- **F5. Staff (from 16):** `CONTEXT.md`, which is binding, says `Staff` or
  `Event Managers`. Update the glossary, or keep `/sherpa` on `Staff` alone
  as a recorded exception?
- **F6. Live posts (from 30):** Sherpa never deletes its live replies in
  `#introductions` either, even when the intro is deleted. Confirm?
- **F7. The vision model (from 14):** `deepseek/deepseek-v4.1-flash-1017`,
  pending one paid check that its ZDR routing accepts images. And should
  images on invited-path messages be read too? The proposal is yes, within
  the same limits.

The cross-model review of this decided version (GPT-5.6 Sol, 2026-10-17)
found gaps that touch member data or retention, so they are owner decisions,
not author fixes. Resolve them before implementing the parts they touch:

- **F8. Erasure of memory.** A `/privacy` erasure deletes the row at once,
  but extraction output in memory is only dropped at the loop's next settings
  check, which may never come if nothing else happens for that member. Should
  the handler also clear that member's in-memory watch at once (an in-process
  call), so erasure is immediate everywhere?
- **F9. Invited-path state.** Invited exchanges are counted on the
  `introduction` row, but the trigger admits members with no row, a tombstone
  blocks recreating one, and an `expired` or `failed` row blocks the
  invitation for up to 30 days. Should the invited path keep its own small
  counter (member id, count, time), separate from the autonomous row? And
  should an expired or failed row ever block an explicit @mention?
- **F10. Tombstone identity.** Eligibility says "no tombstone", but §5 says a
  tombstone with a different `joined_at` admits a rejoined member. The open
  row does not store the `joined_at` read when evaluation starts, and F2's
  seeded tombstones have none. Decide: store `joined_at` on the row; make
  seeded tombstones block permanently (accepting no rejoin lapse for
  historical members) or not.
- **F11. `off` mode.** What happens to an intro that arrives while the mode
  is `off`? It could be ignored entirely (no row, no tombstone, no later
  catch-up), recorded and processed when the mode is switched back on, or
  closed with a tombstone. Each choice keeps different member data, and the
  proposal is "ignored entirely".
- **F12. "Exactly one" against the crash contract.** `posted_at` is claimed
  before the POST, so a crash between the claim and Discord accepting the
  post leaves the member with no post, ever. The invariant is "at most one".
  Accept "at most one", or add a retry that checks Discord for the post
  before re-sending?
