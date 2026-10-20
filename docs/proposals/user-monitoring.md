# Design: User Monitoring (#52)

**Status:** Accepted by the owner, 2026-10-18 (*Owner decisions*, at the end). **Where the owner's decisions at the end differ from the body, the decisions win**; the body is updated when this is built. Builds
on Deep User Analysis (#51, `deep-user-analysis.md`) and shares
[ADR-0003](../adr/0003-staff-member-analysis.md).

"User Monitoring" is the owner's name and the Forum's. The person watched is a
**member**. The per-member threads in the Forum are **Posts**.

Claims about Discord or library behaviour are marked *(verified: how)* or
*(unverified)*.

---

## 1. The ask

A Staff-only, time-limited, passive watch on one member, under triggers Staff
define. Sherpa writes its observations to that member's Post in the
`📊︱user-monitoring` Forum (`1534214620976254977`). With no Post, Sherpa
creates one; with one, it reads the Post's history and takes earlier comments
into account. The purpose is early alerts when a member's messages match
patterns of concern or interest. A moderation tool, not engagement.

The Forum already describes this purpose in its own topic, and defines tags
for it: *Escalation Risk, Behavioral Pattern, Activity Change, Concerning
Interaction, Wellness Concern, Needs Follow-Up, Verification Needed, Monitor
Activity, Support Needed, Do Not Engage Alone, Resolved* *(verified: the
Forum's topic in `sync/__fixtures__/guild-channels.json`, recorded
2026-09-01)*.

## 2. What exists, and what is new

**Reused:**

- **The responder's gateway** (responder §2): `GuildMessages` and
  `MessageContent`, already approved by the owner (D20), with a filter as the
  first line of the handler. The process already receives the whole guild's
  messages; the owner accepted that.
- **#51's `analyseMember`** and the `moderation` origin (ADR-0003). An
  observation is that analysis run on a few new messages.
- `/sherpa` and `isStaff` (responder §7), `sherpa_setting`, `dailyCap`.
- **The exclusion table** in `bot.db` (ADR-0001), for the Forum's exclusion.
- The adapter's `listThreads` and the Forum's `availableTags`, carried on the
  read port (`discord-adapter.ts`).

**New:**

- A second gateway filter, keyed on watched member ids.
- A `watch` table and a `monitoring_post` table.
- A write port for the Forum, whose only targets are Posts in it.
- `/sherpa watch start|stop|list`.

## 3. The Forum enters the Catalog; #53 keeps it out of Member results

**The bot cannot see `📊︱user-monitoring` today** *(verified: `visible: false`,
`contentReadable: false` in the 2026-09-01 fixture; it may have changed since)*.
Staff must grant it View Channel, Send Messages (a Forum's "Create Posts"),
Send Messages in Threads and Read Message History there.

**The moment they do, the next sync puts the Forum and every Post in it into
the Catalog**: the sync takes every container the bot can see (`visible`), not
only what a Member can see (`catalog.ts`, `visibleContainers`). From there its
Post titles and opening messages would reach Tier 0 and activity summaries,
the snapshot and the site's Index.

#53 keeps it out of `/find` and `/lately`: the sync records the role ids that
can view each Entity, and a place is named only to an asker whose roles can see
it. The Forum has no granting role, so no Member is shown it. **#53 must land
before Staff grant the bot access.** It does not remove the Forum from the
Catalog, so the capture, summaries and snapshot remain unless **the Forum's id
is in the durable exclusions** (ADR-0001), which Staff should do before
granting permission, since its Posts are observations about members. An
excluded container's Posts are never enumerated into the Catalog
(`catalog.ts`). The startup checks (below) refuse to run the watch while the
Forum is in the Catalog.

## 4. Design

### The watch

`/sherpa watch start member:<member> days:<1–30> triggers:<text> [post:<link>]`

- **Triggers** are Staff's text: up to 5, each up to 200 characters,
  separated by `;`. For example: "hostile to newer members; mentions selling
  or money; signs they're struggling".
- **`post`** links an existing Post in the Forum to this member, once. Without
  it, Sherpa uses the Post it holds for the member, or creates one.
- `stop` ends a watch early. `list` shows watches, their setters, their
  expiry and their Posts.
- One watch per member. Starting a second replaces the first's triggers and
  expiry and is logged.

```
watch(
  member_id   TEXT PRIMARY KEY,
  set_by      TEXT NOT NULL,
  set_at      TEXT NOT NULL,
  expires_at  TEXT NOT NULL,          -- at most 30 days after set_at (D52-2)
  triggers    TEXT NOT NULL           -- JSON, ≤ 5 strings of ≤ 200 characters; Staff text
)
monitoring_post(member_id TEXT PRIMARY KEY, post_id TEXT NOT NULL, linked_by TEXT NOT NULL)
```

### The read path

- **A second filter** beside the responder's: a `MESSAGE_CREATE` passes when
  its author is in the watched set (in memory, reloaded from `watch` on every
  change and hourly). Everything else that the responder's filter does not
  keep is dropped on the spot, as now.
- **It drops, in code:** bots; withheld Channels and anything under one
  (ADR-0003, because the gateway may deliver them *(unverified)*); anything
  not under a Catalog Entity; the Forum itself; and monitored Channels unless
  ADR-0003 O4 admits them.
- **Edits** are ignored; a **delete** removes the message from the buffer.
- **The buffer:** each watched member's new messages are held **in memory**,
  for at most 30 minutes or 20 messages, whichever comes first. A restart
  loses it; startup does not catch up (the next message starts a new buffer).

### The observation

When a buffer flushes:

1. **Opt-out check** per ADR-0003 O3. Under A, an opted-out member's watch is
   paused and the buffer dropped; under B, it continues.
2. **Read the Post's history:** the newest 50 messages, one REST call. Staff
   comments are Staff's own words: their names are redacted, and a Staff
   author with processing off is dropped, as any member's words are. Sherpa's
   own earlier observations are included as derived text. Capped at 6,000
   characters, newest kept.
3. **One `cheap` call** under `moderation`, with the triggers, the Post's
   history, and the buffered messages (indexed). It returns:
   ```
   { "level": "none" | "note" | "alert",
     "matched": [trigger index],          // which of Staff's triggers, by position
     "observation": string ≤ 400,
     "cites": [index],                    // ≤ 5, into the buffered messages
     "tags": [forum tag name] }           // ≤ 2, from the Forum's own tag set
   ```
   Indexes and tags are checked against what was offered.
4. **`none` posts nothing,** and is counted in the logs. `note` and `alert`
   post one message to the member's Post, from a template:
   ```
   Sherpa observation · alert · watch set by <@setter> · ends <t:expires:R>
   Matched: hostile to newer members
   > <observation>
   Messages: <jump link> <jump link>
   ```
   `alert` pings the setter alone: `allowed_mentions: { users: [setter], parse: [] }`.
   `note` pings nobody. The model's `tags` are added to the Post's
   `applied_tags`, never removed (D52-5).

### Creating and writing the Post

- **The write port has two writes:** `createPost(memberId)` and
  `observe(memberId, body, ping)`. Both resolve their target from
  `monitoring_post`, and the Forum id is a constant. Neither takes a channel.
- **A new Post** is titled from a template (D52-4) and opens with a fixed
  message: who set the watch, when it ends, and its triggers. It carries the
  *Monitor Activity* tag if the Forum still defines it, since a Forum can
  require one (`RequireTag`, *unverified for this Forum*).
- **An archived Post** is written to as it is. Discord unarchives a Post when
  a message is sent, given Send Messages in Threads *(unverified)*. A
  **locked** Post is not written to: the watch pauses and `list` says why.
- **Expiry:** when a watch ends, Sherpa posts one closing line in the Post and
  deletes the `watch` row. `monitoring_post` stays, so the next watch reuses
  the Post.

### Startup and hourly checks

The watch pauses, loudly, if any fails: the Forum is excluded from the
Catalog; the bot can view, create Posts, send in Threads and read history
there; and the Forum is not monitored. The erasure handling (§5) keeps running.

## 5. What is kept, and erasure

| Data | Where | How long |
|---|---|---|
| Buffered messages | Memory | Until the flush, a restart, a delete, or the watch ends |
| The Post's history | Memory, for the call | The call |
| `watch` row | `bot.db` | Until it expires or is stopped; at most 30 days |
| `monitoring_post` row | `bot.db` | Until Staff unlink it, or the member leaves (D52-6) |
| Observations | The member's Post in Discord | Staff's to delete. Sherpa never deletes its posts (as responder F6) |

**On `/privacy`:** under ADR-0003 O3 A, `opt-out processing` and
`delete-my-data` drop the member's buffer at once, through an in-process call
as F8 does, and pause the watch; the watch's Staff see "paused: member opted
out" in `list`. Under B, they change nothing here. **Posted observations are
never removed by Sherpa** in either case, and they tie the member to Staff's
concerns past any erasure. This is the same gap the owner accepted for shadow
posts (D30), but larger, and the policy says nothing about it.

## 6. Cost and caps

- A flush is about 4,000 tokens, about $0.0003 at `f6e7d9d`'s rate.
- **Caps:** at most 10 watches at once; 24 observation calls per member per
  day; 200 per day in total (`SHERPA_WATCH_DAILY_CAP`). At the cap the buffer
  is dropped, not queued, and one line in the Post says observations are
  paused until the next UTC day.
- Worst case: 200 calls a day, about $2 a month.

## 7. Owner decisions needed

ADR-0003's O1–O7 apply, and land harder here: the watch runs on its own,
continuously, and writes to Discord. Specific to this tool:

1. **D52-1. Build on #51.** Recommended: this follows #51, and shares its
   boundary function. Alternative: build this alone; it then carries the
   boundary work.
2. **D52-2. Watch length: at most 30 days, renewable by starting again.**
   Recommended. Alternatives: 7 days; or no maximum (not time-limited, which
   the owner's ask is).
3. **D52-3. Triggers: Staff's free text, at most 5.** Recommended, as the
   owner asked. Alternative: a fixed set of trigger kinds from the Forum's
   tags, which is safer to render but is not "triggers that Staff define".
4. **D52-4. The Post's title.** Recommended: the member's current username
   and id, for example `quietdad (123…)`, since Staff search the Forum by
   name. Alternative: id only, which is less PII in a title but harder to
   find. Either way the title is member data in a Staff Forum.
5. **D52-5. Sherpa applies Forum tags.** Recommended: add up to 2, never
   remove, so Staff's own tagging is not undone. Alternative: no tags; Staff
   tag by hand.
6. **D52-6. When the member leaves.** Recommended: the watch ends and
   `monitoring_post` is kept, so a rejoin finds the same Post. Detecting a
   departure needs the Guild Members intent, so without it, a watch on a
   departed member simply sees no messages until it expires. Alternative:
   ask for the intent (as `ambassador-alerts.md` D50-2 might).
7. **D52-7. Alerts ping the setter only.** Recommended. Alternatives: a Staff
   role ping, or no pings.
8. **D52-8. The bot's permissions in the Forum,** granted by Staff after the
   exclusion is in place and #53 has landed: View Channel, Send Messages, Send Messages in
   Threads, Read Message History. New permissions, and Sherpa's first posts
   there.
9. **D52-9. The policy.** If ADR-0003 O3 is B, the policy's new line covers
   this too. If it is A, the policy is unchanged, and Staff need to know an
   opt-out pauses a watch.

## 8. Packets

After #51's packets 2 and 3, and after the responder's gateway and `/sherpa`
are merged.

1. **The startup assertion** that the Forum is excluded from the Catalog.
   *Sonnet, Medium.* #53 must be deployed, and the Forum excluded, before
   Staff grant any permission. No seed packet.
2. **`watch` and `monitoring_post`, and `/sherpa watch`.** *Sonnet, High.*
3. **The second gateway filter and the buffer,** with the drops in §4 and the
   `/privacy` hook. *Opus implementer, High: a privacy filter.*
4. **The Forum write port:** create, observe, tags, archived and locked Posts,
   the permission checks. *Opus implementer, High.* Parallel with 3.
5. **The observation call** on #51's `analyseMember` contract, and the flush,
   caps and expiry. *Sonnet, High.* Depends on 2–4.

Then the final review.

## 9. Tests

- **The filter:** with a watch on A, a message from B in any Channel is
  dropped; one from A in a withheld Channel, a Thread under one, the Forum, a
  Staff-only Channel, or (if O4 is no) `#introductions` is dropped; one from A
  in an ordinary Channel is kept.
- **The write port:** records every write; fails on any write outside the
  Forum's Posts, or to a Post not mapped to the member.
- **Pings:** an `alert` sets `allowed_mentions.users` to exactly the setter, a
  `note` to nobody, and no body can ping anyone else.
- **Opt-out (O3 A):** an opt-out drops the buffer at once and a call that
  returns after it posts nothing (the responder's erasure-count pattern).
- **Expiry:** a watch past `expires_at` keeps nothing in memory and takes no
  call, across a restart.
- **The startup check:** the watch does not start while the Forum is in the
  Catalog.
- **Validation:** an unknown trigger index, tag or citation fails the call.

Each is shown to fail against a broken guard before it is kept.

## Owner decisions (2026-10-18)

D52-1, D52-3, D52-5, D52-7 and D52-8 are accepted as recommended.

- **D52-2:** a watch lasts **up to 90 days**.
- **D52-4:** the Post title is the member's **server name and Discord
  username**.
- **D52-6:** when the member leaves, the watch ends and the Post is kept.
  Sherpa **adds a note to the Post that the member left, and when, with up
  to 5 of the member's messages from just before the departure.** The owner
  granted the **Guild Members intent** for this. *Open, for build time:*
  whether those messages are quoted or linked. Quoted text is posted with
  `allowed_mentions: { parse: [] }`. The owner confirms whether it falls
  under ADR-0003 O5's "no child details in output", which governs model
  output; these are the member's own words.
- **D52-9:** the policy follows ADR-0003 O3 (B). Its line should say a watch
  can run for up to 90 days.
- Staff here means **holders of the role named `Staff` alone** (ADR-0003 O7).

## As built (2026-10-19)

- **The Forum is never in the Catalog.** It sits under the `👮 Staff` category,
  which the sync excludes as a whole (owner, 2026-10-19), so §3's manual
  exclusion is not needed. The checks still pause the watches if it ever is.
- **Watches last 1–90 days** (D52-2), under 1–5 triggers of at most 200
  characters, separated by `;`. At most 10 at once.
- **The Post is made when the watch starts,** so Staff have its link from the
  start, titled `<server name> (<username>)` (D52-4), opening with the
  setter, the end and the triggers, and tagged *Monitor Activity*.
- **The departure note quotes** up to 5 of the member's newest messages from
  places a Member can see, each clipped to 200 characters and escaped, with
  its jump link and `allowed_mentions: { parse: [] }`. The owner chose quotes
  over links on 2026-10-19, which settles §7's open question: the member's
  own words are not model output, so ADR-0003 O5 does not apply to them.
- **Caps:** 24 observation calls per member a day, in memory, and 200 a day
  across all watches (`SHERPA_WATCH_DAILY_CAP`). At either, the buffer is
  dropped, and the Post gets one line a day saying so.
- **The opt-out does not pause a watch** (ADR-0003 O3 B). A Staff note by an
  author with processing off is dropped from the Post's history.
- **The watches run under `SHERPA_INTRODUCTIONS=1`**, the gateway that
  carries messages and departures.
- **A Post Staff delete is replaced** by a new one at the next write. Only a
  404 counts as deleted; lost access (a 403) is retried, never unlinked.
- **Tags on a Post Staff made and linked** need Manage Threads, which D52-8
  does not grant. Without it they fail softly and are logged. Posts Sherpa
  made take tags without it.
- **A departure while the bot is down is missed:** Discord does not replay
  `GUILD_MEMBER_REMOVE`. The watch then runs to its end.
- **A departure note that cannot post** (a locked Post, say) is retried each
  minute until the watch would have ended, then given up.
