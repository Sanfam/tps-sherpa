# Review process

**A change set is challenged by an adversarial Codex review before it becomes
history. Valid, in-scope findings are fixed first.**

## Scope: what this applies to

| | Reviewed? |
|---|---|
| Human- or agent-authored code | **Yes** |
| Human- or agent-authored docs and config | **Yes** — a wrong doc misleads the next agent |
| The bot's own content commits (`content/index/data.json`, `roles.json`) | **No** |

The bot pushes generated content straight to `main` with no PR and no pause;
its safety net is CI plus the fact that the Catalog is regenerable. Requiring
an interactive review there would make one mandatory rule contradict another.
That exemption covers *generated output only* — the code that generates it is
reviewed like anything else.

**A "change set"** is everything that will land in one commit: staged, unstaged
**and untracked**. Plain `git diff` omits new files, which is how a whole new
module gets reviewed by nobody.

## Why an adversary, and what that is worth

| | Purpose |
|---|---|
| Self-verification — tests, typecheck, content check | Proves the code does what its author intended |
| Claude `/code-review` | Finds what the author overlooked, from the same mind that wrote it |
| **Codex adversarial review** | A second model, with different blind spots |

The honest claim is the third row as written: *different blind spots*, not
*better*. Where Codex authored the change, the independence argument inverts —
use Claude's review as the adversary instead. The point is that author and
reviewer differ, not that any particular model is the authority.

## The cycle

1. **Finish and self-verify.** From the repo root:
   `npm test` · `npm run typecheck` · `node scripts/check-content.mjs`
   Do not send broken work to review; a reviewer's attention is for defects you
   did not already know about.
2. **Run `/codex:adversarial-review`** over the change set. Frame it as *find
   what is wrong with this*, never *is this okay*. Give it the intent as well
   as the diff — a reviewer that does not know what the code was for can only
   check syntax.
3. **Triage every finding explicitly.** Three outcomes, no fourth:
   - **Valid, in scope** → fix before committing.
   - **Valid, out of scope** → file a ticket and link it in the commit message.
     Never leave it only in a transcript.
   - **Not valid** → say why in one sentence. A finding dismissed silently is
     indistinguishable from one that was missed.
4. **Re-verify after fixing**, and **re-review if the fixes were substantial.**
   A commit that differs materially from what was reviewed has not been
   reviewed.
5. **Record it in the commit message** — what review found, what was done.

## Precedence: the handoff's stop conditions win

`ASTRO-ARCHITECTURE.md` lists conditions that require halting and asking a
human — a locked decision appearing wrong, anything touching child data or
member PII, the bot's first public post, new credentials or scopes, adding a
vendor.

**If a finding is valid but acting on it would cross one of those, stop and ask.
Do not fix it because this document said "fix before committing".** Escalation
is the correct outcome, not a failure of the cycle.

The same applies to *"verify against real data"* below: it is not standing
authority to reach the live guild.

## When the cycle cannot run

- **Codex unavailable or unauthenticated** → run `/code-review` instead, and
  say in the commit message which reviewer ran and why. Do not silently skip.
- **Diff too large to review meaningfully** → split the change set. A review
  that ran but did not fit is worse than none, because it is recorded as done.
- **Author and reviewer disagree on validity** → the author decides and records
  the reasoning. There is no arbiter, and pretending otherwise would be
  theatre. This is the weakest joint in the process; treat a dismissal you
  cannot justify in one sentence as a signal you are wrong.

## Enforcement: honest limits

**This is honour-system.** CI checks types, tests and content structure. It
does **not** verify that a review happened, and nothing prevents an unreviewed
commit reaching `main`.

`/codex:setup --enable-review-gate` makes the harness require a fresh review
before a session ends, which is the only actual enforcement available. It is
currently **off**.

## Standards for a fix

- **Prove the fix bites.** Break the code, watch the test fail, restore. A test
  that passes against a broken implementation is decoration.
- **Verify claims rather than restating them.** An expected value derived by the
  same reasoning as the code is not a test — get it from a documented formula, a
  worked example, or live data.
- **Fix the class, not the instance.** If one caller had the bug, check them all.

## What review does not cover

Codex reads the diff. It does not know the guild, the privacy model, or what
the docs promised. **Several of the worst defects in this repo were invisible
to every reviewer and appeared only when the code met the live guild** — a
permission model that computed "readable" where Discord returned 403, an intent
check that would have refused to run on a correctly configured bot.

## Record

**Adopted 2026-09-03.** The rows below were found by Claude `/code-review`, not
by Codex — model diversity is the *reason* for adopting Codex, not something
this table evidences. The Codex record starts now.

| Found | Commit | Would have shipped |
|---|---|---|
| Every channel emitted as `type: channel` | `70f3e4a` | Category headers and voice channels in the Catalog with dead deep links |
| Tautological role-deletion test | `a51dd6d` | A test that passed against an implementation returning nothing |
| `@everyone` offered as an Access gate value | `a51dd6d` | A page gated on it locks out **every** reader, silently |
| Mention lookup built after exclusions | `b3cc603` | `#unknown-channel` published in other Entities' descriptions |
| Read errors swallowed beyond ENOENT | `b3cc603` | A fail-closed exclusion list silently failing open |
| Head window used `after=<entityId>` | `7de77be` | Every Post's first message missing from Tier 0 |
| Re-capture merged instead of replacing | `7de77be` | Deleted member messages living on, making a stated privacy guarantee false |
| `LENGTH()` counted characters, not bytes | `7de77be` | A volume footprint under-reported up to 4× |
| Evidence quoted raw into a Discord post | `08bf77e` | A flagged message containing `@everyone` re-pings the guild |
| Bare `dupe`/`duplicate` matched | `08bf77e` | "the dupe glitch still works?" flagged as a duplicate, in a gaming community |

**First Codex review, on this document:** 14 findings, including that the
paragraph above originally claimed Codex had caught all of the above. It had
not. That claim is the kind of thing a same-mind reviewer waves through.
