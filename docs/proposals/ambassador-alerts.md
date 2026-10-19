# Design: alerts for Ambassadors and Staff (#50)

**Status:** Accepted by the owner, 2026-10-18 (*Owner decisions*, at the end). **Where the owner's decisions at the end differ from the body, the decisions win**; the body is updated when this is built. Builds
on the introductions responder's gateway (`introductions-responder.md` §2–§3).

Claims about Discord or library behaviour are marked *(verified: how)* or
*(unverified)*.

---

## 1. The ask

Holders of the `Ambassador` or `Staff` role can opt in to either or both of:

- a new member **joining** the server;
- a new **introduction in `#introductions`**.

Sherpa then posts in `#ambassador-chamber` (`1550882422189596672`),
@mentioning each opted-in holder, with a link to the new member's
introduction and some context.

## 2. What exists, and what is new

**Reused:**

- **The responder's gateway and filter** (§2). `MESSAGE_CREATE` in
  `#introductions` already reaches the handler.
- **What counts as an introduction** (F2): not a reply, mentions no other
  member, and its author has never posted there before (tombstones, seeded
  from the Channel's history).
- **The member lookup** the responder makes once per new author, which
  supplies `joined_at` *(verified 2026-09-01: needs no Guild Members intent)*.
- `snowflakeTime` (`purge.ts`), for an account's creation time from its id.
- **Role checks by name** from the role manifest, as `isMember` resolves
  `Member` (`interactions.ts`) and `isStaff` will resolve Staff (responder §7).
- `sherpa_setting`, `dailyCap`, and the `seeded` pattern in `durable-store.ts`.

**New:**

- An `Ambassador` check, and a glossary entry for the role (`CONTEXT.md`).
- An `/alerts` command, open to Ambassadors and Staff.
- Two small tables.
- A write port whose only target is `#ambassador-chamber`.

## 3. `#ambassador-chamber` enters the Catalog; #53 keeps it out of Member results

The Channel was created on 2026-09-19 *(verified: its snowflake)*, after the
recorded fixture, so **whether the bot can see it is unverified**. If the bot
can, the Channel is already in the Catalog: the sync takes every container
the bot can see, not only what a Member can (`catalog.ts`). That means its
conversation is captured to Tier 0 and summarised.

#53 decides who is *shown* it: the sync records the role ids that can view each
Entity, and `/find` and `/lately` name a place only to an asker whose roles can
see it. A Staff-only Channel has no granting role, so it is in no Member's
results. **#53 must land before Staff grant the bot access.** It does not take
the Channel out of the Catalog, so the capture and summaries remain, and the
snapshot and site Index carry it, unless Staff add it to the durable exclusions (ADR-0001; the git seed file is read only at first initialisation, so editing it later does nothing). Staff's call; see packet 1.

## 4. Design

### Opting in

`/alerts joins on|off`, `/alerts intros on|off`, `/alerts settings`.

- Open to holders of `Ambassador` or Staff (`Staff` or `Event Managers`).
  The role is read from the interaction, as with every command. Every reply
  is ephemeral.
- **`Ambassador` resolves by name** from the role manifest. That a role named
  exactly `Ambassador` exists is *unverified*: roles are not in any fixture,
  and the manifest lives in the deployed `bot.db`.

```
alert_subscription(member_id TEXT NOT NULL, event TEXT NOT NULL CHECK (event IN ('join','intro')),
                   set_at TEXT NOT NULL, PRIMARY KEY (member_id, event))
alert_sent(member_id TEXT NOT NULL, event TEXT NOT NULL, joined_at TEXT NOT NULL, sent_at TEXT NOT NULL,
           PRIMARY KEY (member_id, event, joined_at))   -- one alert per member, per event, per join
```

### The two events

**Intro.** A message in `#introductions` that counts as an introduction under
F2, from a member with no `alert_sent` row for `intro` at their current
`joined_at`. This runs **whatever the responder's mode is**: in `off`, the
responder writes no tombstones (F11), so `alert_sent` is what stops a second
alert for the same member.

**Join.** Three ways to learn of one, and the choice is the owner's (D50-2):

- **A. Discord's own join message.** If the server posts "X joined" in its
  system channel, that arrives as a `MESSAGE_CREATE` of type 7 (`UserJoin`)
  under the `GuildMessages` intent the owner already approved
  *(verified: `MessageType.UserJoin` in `discord-api-types`; whether this
  server posts them, and where, is unverified)*. The filter gains that one
  Channel, for type-7 messages only, and keeps no text. No new intent.
- **B. `GUILD_MEMBER_ADD`,** which needs the privileged **Guild Members**
  intent. The application's flags, `565248`, include
  `GATEWAY_GUILD_MEMBERS_LIMITED` (32768) as well as Message Content
  *(verified: `565248` = 524288 + 32768 + 8192, against `ApplicationFlags` in
  `discord-api-types` 0.38.54; the flags were read 2026-09-01)*. So the portal
  toggle looks to be on already; asking for the intent is a code change, and
  an owner decision. The process would then receive every join, leave and
  member update in the guild.
- **C. "Becomes a Member":** an alert when the `Member` role is granted, which
  is what an Ambassador can act on, since `@everyone` sees only verification
  plumbing (`PROJECT-STATUS.md` §4). That is `GUILD_MEMBER_UPDATE`, so it
  needs the same intent as B.

Joins made while the process is down are not caught up under any option.

### The post

At send time, Sherpa:

1. Reads the subscriptions for the event, and **re-checks each holder** with
   the member lookup. Anyone who no longer holds `Ambassador` or Staff, or has
   left, is skipped (their row stays, in case the role returns). With nobody
   left, nothing is posted.
2. Skips the alert entirely if the new member has **`approach` off** (D50-4).
3. Claims the `alert_sent` row with a conditional insert before posting, so a
   redelivered event cannot post twice. A crash after the claim costs that
   alert, as F12 accepts for the responder.
4. Posts, from a template, to the constant `#ambassador-chamber` id:
   ```
   New introduction: <@member> · joined <t:joined:R> · account made <t:created:R>
   <jump link to the intro>
   For: <@holder> <@holder>
   ```
   A join alert says "Joined" and, when one exists by then, links the
   introduction; otherwise "no introduction yet".
   `allowed_mentions: { users: [the holders], parse: [] }`, so the new member's
   own mention renders but does not ping them. Discord allows at most 100 ids
   there *(unverified)*; past 100 holders, the extra holders are dropped and
   logged.

**Context is template-only** (D50-3): times and a link, no model call, no
roles. The architecture says a member's role list is never rendered to anyone
(`ASTRO-ARCHITECTURE.md`, *Role data is member data*), so no role is shown,
`Member` included, unless the owner decides otherwise.

**A Staff switch,** `/sherpa alerts off|on`, in `sherpa_setting`, defaults to
`off`. Setting `on` is what authorises Sherpa's first post in
`#ambassador-chamber` (D50-1), as D6 did for `#introductions`.

### Checks, at startup and hourly

The alerts pause, loudly, if the Channel is in the Catalog, or the bot cannot
view and send there.

## 5. What is kept, and erasure

| Data | Where | How long |
|---|---|---|
| `alert_subscription` | `bot.db` | Until the holder turns it off, or runs `delete-my-data` |
| `alert_sent` | `bot.db` | Indefinite, as tombstones are (D50-5). Ids and times only |
| The posted alerts | `#ambassador-chamber` | Staff's to delete. Sherpa never deletes its posts (as F6) |

No member text is read beyond what the responder already reads, and nothing
goes to a model.

## 6. Cost

No model calls. One member lookup per holder per alert. A daily cap of 50
alerts (`SHERPA_ALERTS_DAILY_CAP`) guards against a raid of joins, with one
"cap reached" line once a day.

## 7. Owner decisions needed

1. **D50-1. Sherpa posts in `#ambassador-chamber`,** behind a Staff switch
   that defaults to `off`. The first post there is the bot's first in that
   Channel: a stop condition. Recommended: authorise Staff to set it on, as
   D6 did for `#introductions`. It needs View Channel and Send Messages there.
2. **D50-2. How joins are detected.** Recommended: **A**, the system join
   message, if the server posts one, since it needs no new intent.
   Otherwise **C**, "becomes a Member", with the Guild Members intent, because
   a raw join is mostly not yet actionable. Alternative: B. Both B and C are a
   new privileged intent, an owner decision.
3. **D50-3. Context is template-only:** join time, account age and a link.
   Recommended. Alternatives:
   - a model summary of the intro: model text about a member, in a Channel
     that outlives erasure, and the "describe subjects, never people" rule
     lifted (ADR-0003's question, in a non-moderation setting);
   - the Topics the responder matched, as labels: derived member data, and
     only for members it evaluated;
   - "has the Member role": a role rendered to others, against the
     architecture's rule.
4. **D50-4. A member with `approach` off gets no alert.** Recommended: an
   alert exists to get people to approach them, and the policy says Sherpa
   won't "approach you on its own". Alternative: alert anyway, since humans,
   not Sherpa, do the approaching. `processing` off does not block a
   template alert: nothing is kept or sent to a model.
5. **D50-5. `alert_sent` kept indefinitely, through erasure.** Recommended,
   as tombstones are (F3): otherwise an erasure makes a member a "new"
   introduction again. It holds ids and times only. Alternative: 30 days.
6. **D50-6. Holders opt in to each event separately.** Recommended.
7. **D50-7. The privacy policy.** It says nothing about alerts to
   Ambassadors. Recommended: no change, as D11 accepted for the responder;
   the gap is listed here.

## 8. Packets

After the responder's gateway, `isStaff`, `/sherpa` and `sherpa_setting` are
merged.

1. **#53 (access fields), merged and deployed.** Not this feature's packet;
   it gates Staff granting the bot access. Then Staff decide whether to
   exclude the Channel from the Catalog as well (§3). No seed packet.
2. **Discovery,** read-only, with the bot token: the role manifest has
   `Ambassador`; the guild's `system_channel_id` and whether join messages
   are on; the bot's permissions in `#ambassador-chamber`. Ids and booleans
   only. *Researcher (Haiku), Low,* or a Staff member reading Server Settings.
   It informs D50-2.
3. **Tables and `/alerts`,** with the Ambassador-or-Staff check, and the
   glossary entry. *Sonnet, Medium.*
4. **The alert writer:** the gateway hook for both events, the holder
   re-check, the claim, the template, `allowed_mentions`, the switch, the
   cap, the checks. *Opus implementer, High: a write path that pings people.*
   Depends on 1–3.

Then the final review.

## 9. Tests

- **Pings:** `allowed_mentions.users` is exactly the holders who still hold
  the role; the new member is never in it; `parse` is empty.
- **The write port:** fails on any write to any id but `#ambassador-chamber`,
  and on any write while the switch is `off`.
- **Once only:** two events for the same intro, or a restart between them,
  post one alert; a rejoin (a new `joined_at`) may alert again.
- **`approach` off** posts nothing.
- **The F2 test** decides `intro` in every responder mode, including `off`.
- **The startup check:** nothing posts while the Channel is in the Catalog.

Each is shown to fail against a broken guard before it is kept.

## Owner decisions (2026-10-18)

D50-1 to D50-7 are accepted as recommended.

- **D50-2:** Discord's join message if the server posts one. The owner also
  granted the **Guild Members intent** (see user-monitoring D52-6), so
  "becomes a Member", or a raw join, can be detected directly.

## As built (2026-10-19)

- **Joins are "becomes a Member" (C).** The server suppresses Discord's join
  message (`system_channel_flags` has `SUPPRESS_JOIN_NOTIFICATIONS`, read
  2026-10-19), so A is not available. `GUILD_MEMBER_ADD` and
  `GUILD_MEMBER_UPDATE` alert once the member holds `Member`, and only for a
  member whose `joined_at` is after Staff last turned the switch on
  (`alerts_on_since`), so an existing Member's next role change does not alert.
- **A join alert links the introduction** only while the responder's
  `introduction` row for that join holds it; `alert_sent` keeps no message id.
- **The alerts run under `SHERPA_INTRODUCTIONS=1`**, which also requests the
  Guild Members intent. The portal toggle is on
  (`GATEWAY_GUILD_MEMBERS_LIMITED`, read 2026-10-19). An `Ambassador` role
  exists.
- **The "cap reached" line is a log line**, once a day.
- **The Catalog check pauses the alerts while the Channel is in the Catalog.**
  Since 2026-10-19, everything under the `👮 Staff` category, this Channel
  included, is excluded by the sync itself (owner), so no manual exclusion is
  needed.
