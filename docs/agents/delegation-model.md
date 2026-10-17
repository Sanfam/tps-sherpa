# Delegation model

Who does which work, on which model, at what reasoning effort, and how each is
invoked. This document is why the roster is what it is.

## The roster

| Role | Brief | Model | Effort | Sandbox |
|---|---|---|---|---|
| Orchestrator / top architect | *(main thread)* | Claude Opus 5.5 | High | — |
| UX designer | `docs/agents/codex-briefs/ux-designer.md` | GPT-6 Astra | Medium | `workspace-write` |
| Architectural reviewer | `docs/agents/codex-briefs/architecture-consultant.md` | GPT-6 Astra | Medium | `read-only` |
| Implementer — judgement | `.claude/agents/implementer-opus.md` | Claude Opus 5.5 | Low–High, per dispatch | — |
| Implementer — packet | `.claude/agents/implementer-sonnet.md` | Claude Sonnet 5.5 | Low–XHigh, per dispatch | — |
| Implementer — mechanical | `.claude/agents/implementer-haiku.md` | Claude Haiku 5.5 | Low–High, per dispatch | — |
| Researcher | `.claude/agents/researcher-haiku.md` | Claude Haiku 5.5 | Low–High, per dispatch | read-only by instruction — holds Bash |
| Implementer — worker | `docs/agents/codex-briefs/implementer-luna.md` | GPT-5.6 Luna | High | `workspace-write` |
| Implementer — hard worker | `docs/agents/codex-briefs/implementer-luna-max.md` | GPT-5.6 Luna | Max | `workspace-write` |
| Final review | `docs/agents/codex-briefs/final-reviewer.md` | GPT-5.6 Sol | High | `read-only` |

The four Claude roles are Claude Code subagents in `.claude/agents/`. Every GPT
role is a Codex session, not a subagent: its brief lives in
`docs/agents/codex-briefs/`. Astra roles may move Low–Medium and final review
Medium–High; Codex effort is chosen per call.

### Choosing a Claude subagent's effort

The model sets the kind of work a delegate can own; effort sets how deep it
thinks inside that. Each subagent's frontmatter `effort:` is its default. For
any other level, pass `effort` on the Agent call — this section is the
instruction that licenses the override, so pick the level by the task:

| Effort | The task |
|---|---|
| Low | Fully specified: the edit, lookup or check is written out, nothing to work out |
| Medium | Clear spec with one obvious approach, a little logic or reading to connect |
| High | Real logic: several pieces that interact, edge cases that matter |
| XHigh | Sonnet only: a small packet with one tricky edge that is easy to get almost right |

A task that wants XHigh on Haiku, or more than High on Opus as a delegate,
belongs a tier up or in the main thread.

## How a Codex role is invoked

**Only through the `skill-codex` skill.** It shells out to `codex exec` with an
explicit model, reasoning effort and sandbox, and it owns the invocation
details: flags, stdin prompts, timeouts, resuming a session. Follow the skill
rather than copying a command line here that will drift from it.

What this repo adds to each call:

- **The prompt is the role's brief plus the task.** Pipe the brief file, then
  the intent: what the change is for, what was verified, what to look at. A
  reviewer that does not know what the code was for can only check syntax.
- **The model, effort and sandbox are the roster's**, passed explicitly so a
  local Codex default cannot substitute its own.
- **Working directory is the repo root**, so the brief's relative paths
  resolve.

## Why it is shaped this way

**The orchestrator holds the context.** Delegates start cold and re-derive
everything, which is their real cost. Work stays in the main thread unless
delegating buys isolation, a different model's blind spots, or genuine
parallelism.

**Author and reviewer are never the same model.** That is the whole argument in
`review-process.md`, and it is the one rule here that is not negotiable. An
Opus-authored change reviewed by Sol is independent; an Opus-authored change
reviewed by Opus is one mind marking its own work. A change a Codex role wrote
is reviewed by Claude instead — see `review-process.md`.

**Workers are cheap but unverified.** Luna, Sonnet and Haiku implementers take
bounded, well-specified tasks. Their output is *always* validated — by the orchestrator,
by `npm test` / `npm run typecheck` / `node scripts/check-content.mjs`, and by
the final review before it becomes history. Offloading is a throughput
decision, never a trust decision.

**Advisors do not edit, and the sandbox enforces it.** The final reviewer and
the architectural reviewer run under `read-only`, which lets them run
`git diff` and read the tree but not write to it. A reviewer that can fix what
it finds stops reporting and starts patching, and the author never learns what
was wrong.

## Routing

Pick the cheapest delegate whose lane holds the whole task, then the effort
from the table above. Cut a large task into packets first: several small
parallel packets beat one large delegation.

- **Needs judgement, spans modules, touches privacy, permissions or durable
  data** → `implementer-opus` (High for a privacy contract, durable data, or
  several interacting seams), or keep it in the main thread.
- **Small and bounded, a few named files, clear spec** → `implementer-sonnet`.
  It owns local choices inside its files — a private name, how to write a
  loop — and stops on anything another file depends on.
- **Mechanical: you could write the diff yourself, and it is much longer than
  its spec** — a rename across many files, one pattern applied to every
  handler, bulk content edits → `implementer-haiku`. If writing the packet
  takes as long as making the edit, make it in the main thread. If the packet
  leaves the implementer anything to decide, it is a Sonnet packet.
- **Reading, searching, summarising, inspecting** — where something lives, what
  a doc or issue says, what a log or commit shows → `researcher-haiku`. Its
  findings are leads: the orchestrator reads the cited line before a decision
  rests on one.
- **Bounded, one module, clear spec, wants a different model's eyes** → Luna,
  High; bounded but genuinely hard → Luna, Max.
- **Unsure whether the approach is right** → the architectural reviewer before
  writing code, not after.
- **Before every commit** → the final review. Not optional.

**Parallel packets** name disjoint files and share the main tree, so the final
review sees all of them; packets that must share a file go in sequence.

**A packet that comes back stopped or failing goes up one tier** — Haiku to
Sonnet, Sonnet to Opus — with the delegate's report attached. It is not
retried at the same tier. A Haiku packet that bounces is a routing miss:
route narrower next time.

**Validation does not scale down with the model.** Every implementer's output
gets the three checks and the final review. For a Haiku packet the orchestrator
also reads the whole diff against the packet before accepting it: the diff is
small by construction, and it is the only check that catches an edit applied to
the wrong place in a way the checks cannot see.

## Stop conditions outrank routing

Every delegate halts and asks rather than proceeding when work would touch child
data or member PII, need a new credential or scope, add a vendor, contradict a
locked decision in `ASTRO-ARCHITECTURE.md`, or produce the bot's first public
post. A delegate hitting one of these reports it; it does not decide it.
