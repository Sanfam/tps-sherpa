# Design: the introductions responder

**Status:** Accepted design, 2026-10-17 (implementation needs a separate
go-ahead). The owner answered the open decisions on 2026-10-17. They were
relayed through the coordinating agent and are recorded under *Decisions*
at the end. Several answers raised new questions, F1–F12. The owner answered
those on 2026-10-17 as well, and they are recorded under *Follow-up decisions*.

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
`#introductions`, Sherpa makes **one** autonomous post in reply, and never a
second. A crash at the wrong moment can mean no post at all (F12). It is one
of these:

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
    well (F4).
- **The process still receives the whole guild's messages** before the
  filter drops them. That is a fact of the intent, and the owner accepted it.
  `@discordjs/ws` parses each payload before the handler sees it *(verified:
  how `run.ts` is wired)*.
- **Edits and deletes arrive as events.** `GuildMessages` covers update and
  delete *(unverified: Discord's intents list, not re-read today)*, which
  replaces the per-tick re-fetch the polling design needed.
- **Startup catch-up.** On connect, one REST read of `#introductions` runs
  from whichever is older: the oldest open row's intro, or the later of now
  minus 24 hours and `on_since`. It uses `limit=100`, paginates forward, and
  sorts by id. This covers messages posted while the process was down.
  Gateway resume covers short disconnects *(unverified)*.
  - **The ceiling:** with no open row, an outage longer than 24 hours loses
    the intros from its start. They get no evaluation and no tombstone, so
    that member's next qualifying message is taken as their intro.
  - `on_since` is its own `sherpa_setting` key, written only on a switch
    from `off` (a `shadow` → `live` switch does not move it). **A message
    older than `on_since` never starts an evaluation**; it can only feed a
    row that is already open. So intros posted while `off` are not caught up
    later (F11), and a watch opened before an `off` period is still rebuilt.
    In `off` the catch-up does not run.
  - It feeds the autonomous path only. The invited path is gateway-only: a
    mention made while the process is down is not answered (§9).
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
- the mode is `shadow` or `live`. In `off`, an intro is ignored entirely: no
  row, no tombstone, and no catch-up later (F11);
- the author has `approach` and `processing` on;
- the author has no row and no blocking tombstone (§5);
- the message counts as an introduction (F2).

The `Member` role is **not** required (D25). The risk: a member who has not
yet been given the role may be pointed at places they cannot see. The reply
names them anyway, and the template does not say they are Member-only.

The member lookup (`GET /guilds/{id}/members/{user_id}`, which needs no
Guild Members intent, *verified 2026-09-01*) is still made, once per new
author. It supplies their names for redaction (§4) and their `joined_at` for
the tombstone (§5). Discord types `joined_at` as nullable *(verified:
`discord-api-types` 0.38, `APIGuildMember`)*. A member whose lookup returns
none is not evaluated, and that is logged: silence on doubt, as the locked
rollout prefers, since an empty value is how a seeded tombstone is marked.

**What counts as an introduction (F2).** With no join window, a long-standing
member who writes "Welcome!" under a newcomer's intro would otherwise count
as an introduction of their own. So a message counts only if **it is not a
reply, mentions no other member, and its author has never posted in
`#introductions` before** (owner, F2). "Never before" comes from tombstones,
seeded once from the Channel's full history when the responder first
starts. A seeded tombstone holds the author id only.

**The ceiling of "never before".** After the seed, only rows write
tombstones. A message that fails the test (a reply, or one mentioning
another member) writes nothing, so a member whose first post after the seed
is a reply has their first standalone post taken as their introduction.

"First starts" means the first process start with `SHERPA_INTRODUCTIONS=1`,
which is the first deploy, whatever the mode (owner, 2026-10-18). Before
reading anything, that start writes the boundary, `seed_until` (the snowflake
of the process start time, so nothing posted after the deploy is inside it),
to `sherpa_setting`, only if it is absent. The
seed reads every message up to `seed_until`, so a crash and restart mid-seed
resumes against the same boundary rather than moving it forward. It then
records completion (`seeded_at`). No evaluation starts until it has completed,
and the startup catch-up that follows covers anything posted during it. An
intro posted after the deploy while still `off` is not seeded: F11 applies,
and the member's next qualifying message after the switch is evaluated.

An intro ignored in `off` (F11) leaves no tombstone, so that member's next
qualifying message, in `shadow` or `live`, is evaluated as their
introduction.

### Watching, in plain terms (D13)

**Watching** is the time between a member's introduction and Sherpa's one
autonomous post. While watching, Sherpa:

- holds what it extracted from the member's words and images, **in memory
  only**;
- reads the member's own follow-ups, re-extracting each time, up to 5
  extractions, and reads any the allowance left unread just before its post
  (at most twice; owner, 2026-10-20);
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

**This is how the one autonomous greeting (D15) and the two configurable
thresholds (D1) are reconciled. The owner accepted it (F1).** A
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
closes nothing. **An image-only intro is evaluated**, but an image is a
gesture, not a disclosure (§4, *What an image means*). So an image-only intro
takes the greeting path, the Zifei case: a welcome and one question, with no
match call.

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
  - **Two separate calls, never one combined.** The member's text goes to
    `cheap`, with the interests schema below, and is the only source of
    signal. Their images, when there are any, go to `vision`, with the
    reading schema (§ *What an image means*). An intro with both makes both
    calls: "I love climbing" plus a meme keeps its interest, and the meme
    adds only a reading. Each call counts against the daily cap. Only the
    text call counts toward the extraction cap of 5 (and 2 reads before the post).
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

**What an image means (owner, 2026-10-17).** An image is not a disclosure of
interest. A meme or GIF in an introduction is almost always doing what that
meme does: a greeting, a friendly hello, excitement at arriving, a joke at
the member's own expense. Memes cannot be taken at literal face value. What
Sherpa takes from one is its accepted, publicly known internet-community
meaning, not the objects it depicts: a hazmat-suit GIF is not an interest in
laboratory science. So:

- The vision call returns a reading, never interests. It has its own schema:
  ```
  { "kind": "meme" | "photo" | "other",
    "known_as": string | null,   // the publicly known meme or source, ≤ 40 chars
    "meaning": "greeting" | "humor" | "excitement" | "self_deprecation" | "other" }
  ```
- **Images never contribute `interests`, `topics` or `life_stage`,** and so
  never feed matching. Signal comes only from the member's words. The rule
  applies to photos too, as the owner stated it for images in general.
- **The reading is used only to:**
  - mark an image-only intro as a greeting, not a lack of signal;
  - show on the shadow post's timeline as the fixed label of its `meaning`
    enum (`image: greeting`), so Staff can judge it.

  `known_as` is model text. It is used only inside the call, to steer the
  reading, and is **never rendered**: no template shows model-written text.
  The reading is held in memory with the rest of the extraction.

- **Which images:** images on the member's own messages in the watch, and on
  their invited-path messages (owner, F7), under the same limits and the same
  "not a disclosure" rule. What `#introductions` members actually post is
  mostly GIFs and memes:
  13 of the 14 sampled. The owner asked for exactly those to be read
  (2026-10-17), so they are in scope:
  - **attachments** of type `image/png`, `image/jpeg`, `image/webp` or
    `image/gif`. A GIF is sent as one still frame, taken from the media
    proxy with `format=jpeg`;
  - **GIF and image links**, meaning a message's `gifv` or `image` embeds
    (Tenor, Giphy, a pasted image URL). The URL is `image.proxy_url` if
    present, otherwise `thumbnail.proxy_url`, since Discord sets either or
    both. It is sent as a still frame.
  - At most **3 per message** and **6 per member**, across both paths: the
    `introduction` row's `images_read` and the `invitation` row's together
    (§5).
  - Each is downloaded through Discord's media proxy, with `width`, `height`
    and `format=jpeg` added to every URL, attachment or embed, so Discord
    does the downscaling and the GIF frame. Attachment GIFs came back as
    `image/jpeg` *(verified 2026-10-17 in the paid run)*. Link thumbnails
    were fetched without `format` in that run and came back as `image/webp`
    or `image/gif`; whether `format=jpeg` flattens them is *unverified*.
    **Only a JPEG response is accepted**: one that is still `image/gif`, or
    PNG or WebP (both can be animated), is skipped, not sent, so an animation
    never goes out whole. Redirects are refused, so the media-proxy allow-list
    cannot be led off. Any file over 4 MB is skipped too. No
    image library is added.
  - Each is sent as a base64 data URL, so the provider never fetches from
    Discord. It is held in memory for the call only.
- **The model:** a new `vision` role, `LLM_MODEL_VISION`, set to
  `deepseek/deepseek-v4.1-flash-1017` (owner, 2026-10-17). Text work stays on
  `deepseek-v4-flash-0731`, for cost. The vision build has text and image
  input and more than 9 zero-data-retention endpoints *(verified 2026-10-17
  against `openrouter.ai/api/v1/models` and `/endpoints/zdr`)*.
  - **Measured 2026-10-17** *(verified: a paid run under the bot's forced
    routing)*. 14 images and GIFs were taken from `#introductions` (13
    GIFs/memes, 1 image link), fetched into memory and sent inline, and
    nothing was stored. Six public Wikimedia photos were also run.

    | Model | Valid JSON | Mean latency (intros) | Cost per image |
    |---|---|---|---|
    | `deepseek-v4.1-flash-1017` | 14/14 intros, 6/6 public | 2.3 s | ~$0.00017 |
    | `nemotron-3.5-super-vl` (paid) | 14/14, 6/6 | 3.2 s | ~$0.00028 |
    | `nemotron-3.5-super-vl:free` | 6/6 public only; one took 90 s | — | $0 |

    That run asked for interests, before the owner's rule above. DeepSeek
    already read memes by their source and as humour (it named the films,
    games and shows they came from). Nemotron read them more literally, and
    once gave identical output for two different GIFs.
  - **Fallback:** paid `nvidia/nemotron-3.5-super-vl`, which has 5 ZDR
    endpoints.
  - **Not eligible:** `nemotron-3.5-super-vl:free`. Its only endpoint is
    NVIDIA's own, which is not on the ZDR list, so the forced routing refuses
    it. Sending member images to it would also break the privacy policy's
    "only providers that keep no data".
  - **`max_tokens`:** both vision models reason before they answer, so a cap
    of a few hundred tokens returns an empty answer. Use about 2,500.
  - **GIFs** are sent as one still frame, taken through Discord’s media proxy
    with `format=jpeg` on every URL, attachment or embed, as above. A still
    frame was enough to recognise them in the measured run.
  - Routing is unchanged: `data_collection: "deny"` and `zdr: true` are
    forced by `openai-wire.ts` *(verified: `main`)*.
  - The run above should be repeated with the reading schema before
    `shadow`, against the same kind of images, held in memory only.
- **Wire change.** `openai-wire.ts` sends `content` as a string today. For
  vision calls it sends the OpenAI multipart form (`text` and `image_url`
  parts). The OpenRouter host check and the forced routing are unchanged.
- **Containment.** An image cannot be redacted: a name written in a photo
  leaves as it is. Output validation still applies, and nothing the model
  writes reaches Discord.
- **Cost:** about $0.00017 per image measured, so under $0.001 per intro at
  the 6-image cap.

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
| The invited conversation: merged extraction, and the ids of messages already handled | Memory, keyed by member | Until the third exchange, 24 hours idle, a restart or erasure |
| Shadow-post reactors' ids, to count only Staff reactions (§8) | Memory, for the tally run | The run; never stored or logged (owner, 2026-10-18) |
| Others' messages | Read mechanically, never sent to a model. Opted-out members' messages are ignored entirely | The event |
| `introduction` row | `bot.db` | 30 days, or until erased |
| `invitation` row (F9) | `bot.db` | 30 days from the last exchange, or until erased. The 3-exchange cap resets with it (owner) |
| `tombstone` | `bot.db` | **Indefinite (F3)**, kept through erasure |
| `sherpa_setting` (mode, clock, thresholds) | `bot.db` | Until changed |

```
introduction(
  member_id      TEXT PRIMARY KEY,
  message_ids    TEXT NOT NULL,     -- [{id, edited_at, images_read}] that fed an extraction, intro first
  started_at     TEXT NOT NULL,
  joined_at      TEXT NOT NULL,     -- from the member lookup when evaluation starts (F10)
  extractions    INTEGER NOT NULL DEFAULT 0,
  images_read    INTEGER NOT NULL DEFAULT 0,  -- images sent to the vision call, ≤ 6
  posted_at      TEXT,              -- claimed before the one autonomous post
  outcome        TEXT CHECK (outcome IN ('responded','expired','failed')),
  reason         TEXT               -- 'recommended','welcome_only','question','cap','error','off'
)
invitation(                          -- the invited path's own state (F9)
  member_id      TEXT PRIMARY KEY,
  exchanges      INTEGER NOT NULL DEFAULT 0,  -- ≤ 3
  images_read    INTEGER NOT NULL DEFAULT 0,  -- with introduction.images_read, ≤ 6
  last_at        TEXT NOT NULL
)                                    -- no message ids: nothing here points at member content
tombstone(member_id TEXT PRIMARY KEY, joined_at TEXT, closed_at TEXT NOT NULL)  -- joined_at NULL: seeded (F2, F10)
sherpa_setting(key TEXT PRIMARY KEY, value TEXT NOT NULL, set_by TEXT NOT NULL, set_at TEXT NOT NULL)
                                     -- keys include mode, on_since, seed_until, seeded_at
```

**Atomicity, carried over from the reviewed design:**

- **An `introduction` row is created by one conditional `INSERT … SELECT …
  WHERE NOT EXISTS`** against a blocking tombstone and the opt-outs, after
  the last `await`. An `invitation` row is created by an upsert that checks
  only `processing` and the absence of an open, unposted `introduction`
  row: tombstones and `approach` do not apply to it (§9). A closed
  row whose `joined_at` differs from the member's current one (they left and
  rejoined) is deleted in the same transaction, so the rejoin lapse is not
  held off by the 30-day row (F10). An open row always blocks, even across
  a rejoin during the watch: the watch carries on as it was.
- **Every action is claimed** with `UPDATE … WHERE <field> IS NULL`, and a
  change count of 1 is required before any slow or visible step:
  - `posted_at` before the one post;
  - `outcome` before closing;
  - `extractions < 5` before each text extraction as a message arrives, and
    `extractions < 7` for up to two more just before the post, which read
    what the allowance left unread. New signal there moves the post later,
    timed from the latest message with words; past the second read the post
    goes with what was read (owner, 2026-10-20);
  - `rebuilds < 3` before the extraction that rebuilds an open row after a
    restart. A rebuild reconstructs what was already extracted, so it takes
    none of the text allowance, but a crash loop cannot spend the daily cap
    on one row either;
  - before a message's vision call, one `UPDATE` claims that message's
    images. It sets `images_read: true` on that message's entry in
    `message_ids`, and adds its n images to `images_read`, conditioned on the
    flag still being false and the total staying at or under 6. That is a
    separate counter, so images never use up the text allowance. Because the
    claim is keyed on the message, a second event for the same message finds
    the flag set and sends nothing;
  - `exchanges < 3` on the `invitation` row before each invited reply. The
    same `UPDATE` adds the message's n images to its `images_read`, on
    condition that both rows' counts together stay at or under 6; images
    over the cap are not sent. The cap counts the rows that exist. Each ages
    out at 30 days, and an erasure removes it, so this is a rolling bound
    rather than a lifetime one.
    A gateway event redelivered for the same message is dropped by the
    invited conversation's handled ids, in memory; there is no durable
    message key (§9).
- **Before every post and every model call,** the member's settings, the
  row's existence and the mode are read again. **After every model call
  returns,** before its result is merged or used, the same checks run
  again, against a per-member erasure count in memory that each erasure
  increments. A result from a call that started before an erasure is
  discarded, so a late reply cannot restore what erasure dropped.

The result: a crash costs a missed post, never a duplicate. The invariant is
**at most one** autonomous post, and the owner accepted it (F12): a crash
between the `posted_at` claim and Discord accepting the post leaves that
member with no post, and nothing retries it.

**The tombstone (D4, F3, F10).**

- **Written** when an `introduction` row closes, and when one is erased,
  carrying the row's `joined_at`. It replaces the member's earlier tombstone,
  except that an empty `joined_at` is never replaced. The seed (F2) writes
  them with `joined_at` empty. Erasing an `invitation` row alone writes no
  tombstone and leaves any existing one as it is.
- **What it does:** a tombstone blocks any new evaluation when its
  `joined_at` is the member's *current* one, or is empty. A different
  `joined_at` means the member left and rejoined. They are treated as new,
  which is the rejoin lapse the owner accepted. A seeded tombstone blocks for
  good: a historical member who rejoins is never welcomed (owner, F10).
- **Retention:** indefinite, as opt-outs are, and kept through erasure
  (owner, F3). With no join window, a 30-day tombstone would let anyone be
  welcomed again a month later.

---

## 6. Erasure

**Sherpa never deletes its own posts**, in `#bot-tests` or in
`#introductions`, even when the intro is deleted. Staff handle every deletion
(owner, 2026-10-17; F6). There is therefore no post-deletion queue, no
reconciliation and no nonce.

**What the owner accepted:** `delete-my-data` and deleting the intro do not
remove shadow or live posts. Those posts still tie the member, through the
jump link or the reply, to places, possibly age-stage Channels.

**What erasure does cover: the durable row, and memory.**

- **`/privacy delete-my-data`, `opt-out approach` and `opt-out processing`**
  delete the `introduction` and `invitation` rows, and write the tombstone
  from the `introduction` row if there was one (§5), in one transaction,
  synchronously in the handler. The same handler then drops the member's
  in-memory watch, extraction and invited conversation at once, through an
  in-process call to the responder (owner, F8). The settings check before every call or post stays
  as a second guard.
- **A deleted contributing message.** A `MESSAGE_DELETE` for any id in
  `message_ids` erases the row, writes the tombstone and drops the
  extraction. As a backstop, the **erasure loop** re-fetches those ids
  hourly, to catch deletions made while the process was down. A delete of
  any message that fed the in-memory invited conversation (one of those ids,
  or one of its handled ids) drops that conversation too; the `invitation`
  row holds no content and stays.
- **Age.** `introduction` rows older than 30 days are deleted, and
  `invitation` rows 30 days after their last exchange.

**The erasure loop runs in any mode,** including `off`, and whether or not
the responder's checks pass. It stops once no rows remain.

**Timing:**

- **The rows and memory:** gone at once on a `/privacy` erasure.
- **A deletion in Discord:** handled at once while the process runs, and
  within about an hour otherwise.
- **Backups:** within about 31 days: the bucket's 30-day lifecycle rule plus
  R2's best-effort expiry, the bound the owner accepted (`docs/runbook.md`).
- **Railway logs:** they carry member and message ids (D26), and their
  retention is Railway's, **outside the erasure policy**.

---

## 7. Staff controls: `/sherpa` (D1, D16, D17, D18)

**Staff** here is the glossary's Staff: holders of a role named `Staff` **or**
`Event Managers`, resolved by name from the role manifest, as `isMember`
resolves `Member` (owner, F5, which supersedes D16's `Staff` alone).

- **One definition for both commands (F5).** `/monitored` moves to the same
  check. Its Manage Server or Administrator check goes, along with the
  `ManageGuild` default permission that hides it today.
- **Staff alone, not Member as well.** Both commands are dispatched before
  `interactions.ts`'s `NOT_A_MEMBER` gate, so a holder of `Event Managers`
  alone is admitted. A test covers the matrix: `Staff`, `Event Managers`,
  `Member` alone, and none.
- **The rename ceiling.** Role ids are resolved by name through the stored
  role manifest, which the six-hourly sync refreshes. Renaming a role takes
  effect at the next sync: until then its holders keep access, and after it,
  renaming both roles locks everyone out of `/sherpa` and `/monitored`.
  Removing the role from a person takes effect at once, since the
  interaction carries their current roles. `isMember` has the same ceiling.
- **Visibility.** Discord cannot hide a command by role at registration
  without an OAuth bearer token *(unverified)*. So `/sherpa` and `/monitored`
  are visible to everyone, refuse non-Staff on use, and every reply is
  ephemeral.

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

- **One write port.** Its only write is `post(kind, body, replyTo)`, where
  `replyTo` is the id of the message being answered: the intro on the
  autonomous path, the triggering message on the invited path, which may
  have no `introduction` row behind it (F9). It resolves the target from
  the mode at call time:
  - `shadow` posts to the constant `#bot-tests` id, with a jump link to
    `replyTo`;
  - `live` posts an inline reply to `replyTo` in the constant
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
  Intro responder (shadow) · would POST <kind> · replying to: <jump link to replyTo>
  Timeline: clock active · acknowledged +2m · active minutes 20 · extractions 1 · novelty dropped 1 · images 1 · image: greeting
  Would post:
  > <the exact live reply>
  ```

  It shows no intro text, no member name and no extracted fields (D23). The
  one exception is `image: <meaning>`, the fixed label of the vision
  reading's enum, which is never model text. It is shown so Staff can judge
  how an image was read.
  Invited-path replies in shadow go to `#bot-tests` too, in the same format,
  so a member who asks sees no answer until `live` (owner, F4).
- **Review.** Staff react to each post: ✅ right, ❌ wrong, ⚠️ harmful.
- **The tally.** A daily pass, and one at startup, while the checks pass,
  lists Sherpa's own posts in `#bot-tests` and reads each one's kind from the
  header. It reads each one's ✅, ❌ and ⚠️ reactors, and counts a reaction
  only from a reactor who is Staff. Each reactor is looked up once per run,
  and the ids are held for the run only, never stored or logged (owner,
  2026-10-18). It then computes the go-live bar:
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

- **Trigger:** a new message (`MESSAGE_CREATE`, never an edit) in
  `#introductions` that mentions Sherpa, or replies to Sherpa's post. A new
  gateway session after a restart does not replay old creates, so the
  in-memory handled ids are enough to dedupe. It counts as invited unless
  the member is being watched
  (an open row with no post yet). A closed row (`responded`, `expired` or
  `failed`) and a tombstone never block an explicit ask: the owner chose
  "an explicit ask always gets an answer" (F9).
- **Gateway only.** Startup catch-up does not replay mentions, so one made
  while the process is down goes unanswered. That is what lets the
  `invitation` row hold no message ids.
- **State (F9).** The invited path keeps its own `invitation` row (§5),
  created on the first invited exchange. It is separate from the autonomous
  `introduction` row. The conversation itself (the merged extraction and the
  ids already handled) is held in memory only (§5), so the locked "ask →
  merge → reassess" holds across exchanges without storing member content.
  A restart loses it, and the next exchange starts from the new message.
- **Flow (§7's invited path):**
  1. Extract from the new message, together with the member's earlier
     contributing messages, re-fetched by id while the `introduction` row
     lives. Images on the new message are read under the same limits (F7).
     Merge the result into the conversation's extraction.
  2. If there is signal, match with `findPlaces`. **Novelty is not applied
     here: the member asked.**
  3. Otherwise, ask one fixed targeted question.

  Each exchange is claimed (`exchanges < 3`). After the third, Sherpa posts the
  widest doors and the Index link. **Structured output and templates only.**
  A mention after the cap is answered with a fixed text pointing to `/find`
  and the Index: no model call, no claim, nothing recorded. So an explicit
  ask is always answered (F9), and the cap bounds only model use.
- **Opt-outs.**
  - `approach` off: does not apply, because the member asked.
  - `processing` off: Sherpa replies with the fixed `/find` opt-out text. No
    `invitation` row is created or claimed and no model call is made, so an
    erasure is not undone by the member's next mention.
- **The same daily cap, the same mode** (shadow means `#bot-tests`), and the
  same Member-role rule (none).
- **Where (owner, F4):** `#introductions` only, for now. `PROJECT-STATUS.md`
  §2 also lists "responds to direct mentions anywhere it has access".
  Answering elsewhere means public posts in other Channels, and member text
  from unmonitored Channels reaching a model under a new `mention` origin. It
  is a later step, with its own toggle.

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
- Images never feed matching. A vision reading leaves `interests`, `topics`
  and `life_stage` empty and makes no match call. A text-plus-image intro
  keeps its text interests. An image-only intro takes the greeting path. And
  nothing from `known_as` appears in any rendered post.
- Atomicity: row creation, and each claim under two concurrent decisions.
- Restart: a row with `posted_at` set gets no second post.
- Erasure: a `/privacy` opt-out followed by an opt-in leaves the rows
  erased, the in-memory watch dropped and the tombstone kept; a
  `MESSAGE_DELETE` on a follow-up erases the row; the erasure loop runs in
  `off`.
- The write-port test in each mode.
- The tombstone: the same `joined_at` blocks; a new one admits; a seeded one
  (empty `joined_at`) blocks any.
- `off`: an intro creates no row and no tombstone, and the catch-up after
  switching on does not reach it.
- The invited path: an `expired` or `failed` row, or a tombstone, does not
  block an @mention; an open, unposted row does. A processing-off mention
  leaves no `invitation` row. Images on both paths together stop at 6.
- The seed: no evaluation before `seeded_at`; a `shadow` → `live` switch
  leaves `on_since` unchanged; a message older than `on_since` feeds an open
  row but starts none.
- A member lookup with no `joined_at` starts no evaluation.
- The invited path: a second exchange keeps the first exchange's
  `life_stage`; an erasure, or a delete of a message that fed it, drops the
  in-memory conversation; a model call that resolves after an erasure
  changes nothing; a fourth mention gets the fixed text and no call.
- The seed: a restart mid-seed keeps the first `seed_until`.
- The Staff matrix for `/sherpa` and `/monitored` (§7).
- Rejoin: a closed row with an older `joined_at` is replaced, not blocking.

**Each guard test is shown to fail** against a broken guard before it is
kept.

**By hand, and paid:**

- Synthetic intros go through extraction and then matching. Synthetic
  images, with no real people, go through the vision reading only, and
  must not reach matching.
- The ConnorDavidSmith and xEMPTYCANx shapes are confirmed to come out as
  welcome-only.
- The vision run is repeated with the reading schema, as §4 says.

**Never locally:** the responder runs only where `SHERPA_INTRODUCTIONS=1`
and a mode is set, which means in deployment. `record-fixtures.ts` records
Channel objects only. No real intro or image goes into fixtures, tests or
docs.

---

## 11. Cost and rate

| Per introduction | Calls | Cost |
|---|---|---|
| Extraction, text | ≤ 5, plus ≤ 2 reads before the post, plus ≤ 3 rebuilds after restarts | well under 1¢ |
| Image reading (separate `vision` call; ≤ 3 per message, ≤ 6 per member) | 1 per image-carrying message | ~$0.00017 per image, measured |
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
    Image-only intros are no longer terminal. **An image is not a disclosure
    of interest** (owner, 2026-10-17). A meme is read by its accepted
    community meaning (a greeting, a hello) and never by face value, and no
    image feeds matching (§4).
15. **One response:** exactly one autonomous post. An `@mention` that asks
    for more is answered through the invited path. (Superseded by F12: at
    most one, since a crash can leave none.)
16. **The `/sherpa` command:** yes. Staff are holders of the role named
    `Staff`, by name. (Superseded by F5: `Staff` or `Event Managers`.)
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

## Follow-up decisions (owner, 2026-10-17)

F1–F7 came from the owner's answers; F8–F12 from the cross-model review of
the decided version (GPT-5.6 Sol, 2026-10-17), as gaps touching member data
or retention.

1. **F1. One-post timing:** accepted as §3 states it. Greet threshold with no
   signal and no human question; otherwise the recommend threshold, counted
   from the latest message carrying signal; otherwise the ceiling, as a warm
   welcome.
2. **F2. What counts as an introduction:** accepted, with the seed. Not a
   reply, mentions no other member, author never posted in
   `#introductions`. A one-time read of the Channel's full history at first
   start stores author-id tombstones.
3. **F3. Tombstone retention:** indefinite, keyed by member and `joined_at`,
   kept through erasure.
4. **F4. Invited-path scope:** `#introductions` only; "anywhere" is a later
   step behind its own toggle. In `shadow`, invited replies go only to
   `#bot-tests`, so a member who asks sees no answer until `live`.
5. **F5. Staff:** the glossary stands: `Staff` or `Event Managers`. Both
   `/sherpa` and `/monitored` gate on it, which supersedes D16 and replaces
   `/monitored`'s Manage Server check (§7).
6. **F6. Live posts:** confirmed. Sherpa never deletes its live replies, even
   when the intro is deleted.
7. **F7. Invited-path images:** read, within the same limits and the same
   "not a disclosure" rule. The 6-per-member cap covers both paths together.
8. **F8. Erasure of memory:** the `/privacy` handler clears the member's
   in-memory watch at once, through an in-process call.
9. **F9. Invited-path state:** its own `invitation` row (member id,
   exchanges, images, last exchange), kept 30 days from the last exchange,
   after which the cap resets. A closed row (`expired` or `failed`) and a
   tombstone never block an explicit @mention.
10. **F10. Tombstone identity:** `joined_at` is stored on the
    `introduction` row and copied to its tombstone. Seeded tombstones block
    permanently; a historical member who rejoins is not welcomed.
11. **F11. `off` mode:** an intro that arrives while `off` is ignored
    entirely: no row, no tombstone, no later catch-up. Where it meets F2
    (owner, 2026-10-18): the seed covers history up to the first deploy, so
    an intro posted after the deploy but before the first switch out of
    `off` falls under F11, not the seed.
12. **F12. At most one:** accepted. A crash between the `posted_at` claim and
    Discord accepting the post costs that member's welcome; there is no
    check-and-retry.
