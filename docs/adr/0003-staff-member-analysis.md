# ADR-0003: Staff analysis of a member's messages

**Status:** Accepted, 2026-10-18. The owner's decisions are recorded at the end.
**Covers:** Deep User Analysis (#51, `docs/proposals/deep-user-analysis.md`)
and User Monitoring (#52, `docs/proposals/user-monitoring.md`).
**Departs from:** the rules listed under *What this lifts*. Each departure is an
owner decision; this ADR records which way each goes once decided.

## Context

Every model call Sherpa makes today describes a place, not a person:

- **Subjects, never people.** The boundary's subjects are Entities
  (`boundary.ts`, `AskRequest.subject`). Summaries "describe places, not
  people" (`content/privacy-policy.md`). The architecture's redaction rule
  exists to stop "a member who flies for a living" from identifying anyone
  (`ASTRO-ARCHITECTURE.md`, *Models and privacy*).
- **No model prose to Discord.** "Structured output only; the app renders from
  a template. This is the prompt-injection containment" (anti-goals).
- **Opt-out.** The published policy says `opt-out processing` means "Sherpa
  stops keeping your messages and sending them to its AI model."
- **Monitored conversation** (`#introductions`) is extract-and-discard. Only
  `extractIntroduction` may send it to a model (responder design §4).
- **Child data** is stored coarse, never echoed, never scheduled on
  (`PROJECT-STATUS.md` §4). The owner accepted, for intro images only, that
  photos of children reach the provider (responder D14).

The owner asked for two Staff tools that are, by design, about one person:
a one-off review of a member's history (#51), and a time-limited watch on a
member that writes observations to a Staff Forum (#52). The owner framed both
as moderation, where "the normal privacy considerations need not be as
comprehensively respected". That framing is not yet reconciled with the
published policy or the locked rules above. This ADR is where it is.

## Decision (proposed)

**Sherpa gains one new boundary origin, `moderation`, used only by the two
Staff tools.** It is a separate function in `boundary.ts`, as
`extractIntroduction` is, not an option on `ask()`. Under it:

1. **The subject is a member, named by id.** Every source must be authored by
   that member, except where a decision below admits others' text. The
   member's own names (username, global name, nickname, from the member
   lookup) are replaced with "the member" on the way out, and refused on the
   way back, like any other name. Code, never the model, renders who the
   report is about (`<@id>`).
2. **Output is structured, with bounded free-text fields.** The schema has
   enums where it can (event kind, tone, trend, alert level) and short strings
   where it cannot (a timeline line, a note, an action item). Each string has
   a length cap. The existing validation applies to every string: no
   snowflake, no mass mention, no member name. Citations are **indexes into
   the sources sent**, which code maps to message ids and renders as jump
   links. A model cannot cite a message it was not shown.
3. **Output reaches only Staff,** and only in two places: an ephemeral reply
   to the Staff member who asked (#51), and the member's Post in the
   `📊︱user-monitoring` Forum (#52). No other write path takes `moderation`
   output.
4. **Nothing member-authored is stored by the tools themselves.** Sources live
   in memory for the call. What persists is what Sherpa posts to Discord
   (#52), plus the watch row (#52).
5. **Who may run them** is a role check at the command, refused otherwise,
   with every reply ephemeral (as `/sherpa`, responder §7).

### What this lifts, each pending an owner decision

| Rule | Lifted how | Decision |
|---|---|---|
| Describe subjects, never people | Lifted for `moderation` output to Staff only | O1 |
| No model prose to Discord | Bounded strings in a template, Staff audience only | O2 |
| `opt-out processing` stops sending a member's words to the model | Not decided: see O3 | O3 |
| Monitored conversation is never sent, except by `extractIntroduction` | Not decided: see O4 | O4 |
| Child data never echoed, never sent beyond intro images | Not decided: see O5 | O5 |
| Never put roles in an LLM prompt (`ASTRO-ARCHITECTURE.md`, *Role data*) | **Not lifted.** Roles stay out of every prompt | — |
| Withheld Channels never read | **Not lifted.** Withheld is enforced in code too (below) | — |

**O1. People as subjects.** Recommended: lift, for Staff-only `moderation`
output. Alternative: refuse both tools.

**O2. Model text in Staff-only output.** Recommended: bounded fields as above.
Alternatives: enums and citations only, with no free text (safe, but it
cannot write notes for Staff); or free prose (the containment this project
rejected, and a crafted message could then write Staff's notes for them).

**O3. Opted-out members.** The choice is the policy or the tool:

- **A. Honour the policy.** Neither tool reads a member with processing off.
  The command says so. Monitoring stops when the member opts out. No policy
  change. A member under concern can switch the tool off themselves.
- **B. A moderation exception, published.** Both tools read anyone. The policy
  gains one line, e.g. "Staff can have Sherpa review a member's messages for
  moderation, whatever their settings. Those reviews go only to Staff." This
  is a policy change, which the owner has declined before.
- **C. An exception, unpublished.** Both tools read anyone and the policy is
  unchanged. **This contradicts a published promise,** not a silence the owner
  has accepted before (responder D11). Listed because the owner's framing
  points at it; it is not recommended.

Recommended: **B** if the owner wants the tools to work on the members they are
for, otherwise **A**. Others' text admitted as context (O6) follows A in every
option: an opted-out member's words are never sent on someone else's account.

**O4. Monitored conversation.** Recommended: admit the subject's **own**
messages in monitored Channels under `moderation`, sent and discarded, never
stored. Their introduction is often the best context Staff have.
Alternative: keep the carve-out whole.

**O5. Child data.** Parents' messages are full of their children. Recommended:
sources are sent as they are (filtering them out would blank most of a
parent's history), the prompt forbids child details in output, and the schema
has no field for them. This would extend D14 (which the owner
accepted for intro images only): children's details in members' messages
would reach the provider. **Child data is a stop condition; the owner has not
decided this, and nothing here is built on it until they do.** Alternative: drop every message in
the parenting Channels and their Posts from sources, which costs most of the
context for most members.

**O6. Others' messages as context.** Recommended for #51: the subject's
messages only, plus, for a reply, the one message it replies to, marked as
someone else's, with that author's names redacted and opted-out authors
dropped. For #52 the Staff notes already in the member's Post are context too
(user-monitoring proposal §4). Alternative: subject only, which leaves a
conflict with half its story.

**O7. Who counts as Staff here.** The glossary's Staff is `Staff` **or**
`Event Managers` (F5). Recommended: the glossary's Staff, one definition.
Alternative: the `Staff` role alone, which needs a glossary entry for the
narrower group, since "moderator" is a word to avoid.

### Enforced in code whatever is decided

- **Withheld Channels never reach a model.** History is unreadable there
  (`canReadHistory`), but the gateway may still deliver new messages from a
  Channel the bot can view *(unverified: Discord's gateway docs, not re-read)*.
  So the `moderation` origin refuses a source from any Channel, or a Thread
  under one, that the Catalog marks withheld, as `ask()` refuses withheld
  subjects today.
- **Only places a Member can reach (a rule to build, not a property of the
  Catalog).** The Catalog holds every container the bot can see, Staff-only
  ones included (`catalog.ts`, `visibleContainers`), and #53 filters access
  where places are *shown*, not at Catalog membership. So sources come from
  Catalog Entities and their Threads and Posts **only if** the Entity is
  visible to the `Member` role (by #53's role-id access fields, which fail
  closed) and is neither withheld nor excluded. Without that check, Staff's
  own conversations about a member could be swept in. #51 and #52 depend on
  #53 for it.
- **Life stage is never an output field,** and no output is scheduled on.

## Consequences

**Gained:** Staff get a reviewed, cited summary of a member's history, and
early notice under triggers they set, in the Forum they already use.

**Costs, if the proposal is accepted:**

- A model's judgement about a person sits in Staff's records, and in #52
  outlives the member's erasure, as shadow posts do (responder D30). Sherpa
  never deletes those posts; Staff do.
- Prompt injection can no longer make Sherpa say anything to a member, but it
  can shape what Staff read about one. Citations and jump links are the
  check: every claim points at a message Staff can open.
- The policy either gains a line (O3 B) or the tools skip the members who
  opted out (O3 A).

**Not yet verified:**

- That Discord's Search Guild Messages endpoint serves bots, and its rate
  limits (deep-user-analysis proposal §2).
- The gateway delivering messages from Channels where history is denied.

## Owner decisions (2026-10-18)

- **O1:** people may be subjects, for Staff-only `moderation` output.
- **O2:** bounded model text in that output.
- **O3:** **B, a published moderation exception.** The privacy policy gains
  one line saying Staff can have Sherpa review a member's messages for
  moderation, whatever their settings, that reviews go only to Staff, and
  that a watch can run for up to 90 days. The owner approves the exact
  wording before it ships.
- **O4:** the subject's own messages in monitored Channels are admitted,
  sent and discarded.
- **O5:** accepted as recommended. Sources are sent as they are; no child
  details in the output, and no field for them. This extends D14 for these
  tools.
- **O6:** as recommended. For a reply, the one message it replies to,
  redacted, with opted-out authors dropped; for #52, the Staff notes
  already in the member's Post.
- **O7:** **holders of the role named `Staff` alone**, not the glossary's
  Staff (`Staff` or `Event Managers`). `CONTEXT.md` needs an entry for this
  narrower group when the tools are built.
