# Handoff: the next build round, #49 to #54

For the next conversation. Read `AGENTS.md`, then `docs/handoffs/2026-10-18.md`
for the wider state. This file covers only the builds for #49–#54. Every one
is decided by the owner. Build from the proposal, and **where a proposal's
*Owner decisions* section differs from its body, the decisions win**.

## Where things stand

- `main` is at `03fb633`, with #55 and #56 merged.
- The introductions responder is built and deployed, but off. Its paid checks
  passed on 2026-10-18. It is not yet switched on: `SHERPA_INTRODUCTIONS=1` is
  not yet set on Railway, and Staff have not yet set `/sherpa introductions
  mode shadow`. Shadow runs 14 days or more; build this round alongside it.
- **#53, per-role access, is live.** Every place Sherpa names goes through
  `visibleTo` and `deniedTo` (`sync/catalog.ts`). The Catalog still holds
  Staff-only places the bot can see, so the access filter is the only thing
  keeping them from Members. Never bypass it.

## Build order

Each build is its own branch and its own PR to `main`, reviewed before merge.

### 1. #54: the `/lately` layout (small, start here)
- Spec: the issue body. The owner chose layout A.
- Each place is one line: a `<#id>` anchor and the relative time. The activity
  summary goes beneath it, as `-# ` subtext.
- An Entity whose `thread_state` is not open falls back to its name and a link.
- The spoiler tag stays inside the subtext: `-# ||…||`.
- Files: `sherpa/lately.ts` and its test.

### 2. #50: alerts for Ambassadors and Staff
- Spec: `docs/proposals/ambassador-alerts.md`; every recommendation is
  accepted.
- `/alerts joins|intros on|off`. Alerts are template-only and go to
  `#ambassador-chamber` (`1550882422189596672`), behind a Staff switch that
  defaults to `off`. The owner authorised Staff to make the first post there.
- **The Guild Members intent is granted.** Request it in code and check that
  it is enabled in the Discord Developer Portal.
- Before Staff give the bot access to the channel, decide with Staff whether
  to add it to the durable exclusions. #53 keeps it out of Member results
  either way.

### 3. #51: Deep User Analysis
- Specs: `docs/proposals/deep-user-analysis.md` and ADR-0003 (Accepted).
- **First packet:** verify that a bot token may call Discord's Search Guild
  Messages endpoint. The design rests on it.
- The depth is **everything since the member joined** (owner). Re-derive the
  call counts and costs, which were written for 1,000 messages. The caps stay:
  10 runs a day, one per subject per hour.
- **Staff here is the role named `Staff` alone** (ADR-0003 O7). Add a
  `CONTEXT.md` entry for that narrower group.
- **The privacy policy gains one line** (ADR-0003 O3, B): Staff can have
  Sherpa review a member's messages for moderation, whatever their settings;
  the reviews go only to Staff; a watch can run up to 90 days. **The owner
  approves the exact wording before it ships.**
- Sources are the subject's own messages, including those in
  `#introductions` (O4), plus the one message each replies to (O6). Use only
  places the `Member` role can see, never withheld ones, under a new
  `moderation` boundary origin.

### 4. #52: User Monitoring (builds on #51)
- Specs: `docs/proposals/user-monitoring.md` and ADR-0003.
- Watches last up to 90 days, with at most 5 triggers Staff write.
- Observations go to the member's Post in the `User Monitoring` forum
  (`1534214620976254977`), titled with the member's server name and Discord
  username.
- Alerts ping only the Staff member who set the watch.
- Sherpa adds up to 2 tags and never removes any.
- When the member leaves (Guild Members intent), the watch ends. Sherpa notes
  the departure and its time, with up to 5 of the member's messages from just
  before it.
  - **Open, ask the owner at build:** whether those messages are quoted or
    linked, and how ADR-0003 O5 ("no child details in output") applies to
    quoting a member's own words.
- Staff exclude the forum before giving the bot access to it.

### 5. #49: themed replies to @mentions (last)
- Spec: `docs/proposals/mention-replies.md`.
- **Write ADR-0004 first.** It records that model text reaches members:
  bounded, at most **500 characters**, validated, and shadowed first.
- The reply works in **every Channel the bot is in**; the owner authorised
  the first reply in each. Monitored and withheld Channels are still refused.
- **There is no exchange cap.** A **15-second per-member cooldown** applies,
  plus a daily cap.
- Context is the newest 10 messages from others, redacted, with opted-out
  authors dropped. There are no follow-ups without a mention.
- Role flavour is added in code; roles never reach a prompt.
- **The voice is a kindly gamer dad**, helpful and kind, defined in a
  reviewed persona file under `content/config/`. It does not portray Sherpa
  people.
- It builds on the responder's invited path, so let shadow show that path
  working first.

## How the work runs

- **Delegate per `docs/agents/delegation-model.md`.**
  - Agents stop at the 40-turn limit often; resume them with `SendMessage`.
  - Worktree agents start from `main`, so tell them which branch to reset to.
- **Review.** Every change set gets GPT-5.6 Sol through `skill-codex`.
  - The owner accepts **Medium** effort for small or docs-only sets.
  - Codex hits its usage limit; if it does, ask the owner before using the
    blind Opus fallback.
- **One PR per build.** Never push onto a PR that is ready to merge: #56
  happened because a commit landed after #55 merged.
- **Node.** Homebrew's `node` is broken locally. Use a standalone Node 26
  (checksum-verified from nodejs.org), or run `brew upgrade node` once
  Homebrew's lock clears.
- **Stop conditions.** These need the owner:
  - the exact privacy-policy wording;
  - the bot's first posts in a new channel, unless already authorised above;
  - new Discord permissions in a channel;
  - anything about child data that is not recorded in ADR-0003.
