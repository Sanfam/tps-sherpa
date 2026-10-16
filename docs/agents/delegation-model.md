# Delegation model

Who does which work, on which model, at what reasoning effort, and how each is
invoked. This document is why the roster is what it is.

## The roster

| Role | Brief | Model | Effort | Sandbox |
|---|---|---|---|---|
| Orchestrator / top architect | *(main thread)* | Claude Opus 5.5 | High | — |
| UX designer | `docs/agents/codex-briefs/ux-designer.md` | GPT-6 Astra | Medium | `workspace-write` |
| Architectural reviewer | `docs/agents/codex-briefs/architecture-consultant.md` | GPT-6 Astra | Medium | `read-only` |
| Implementer — judgement | `.claude/agents/implementer-opus.md` | Claude Opus 5.5 | Medium | — |
| Implementer — hard judgement | `.claude/agents/implementer-opus-high.md` | Claude Opus 5.5 | High | — |
| Implementer — worker | `docs/agents/codex-briefs/implementer-luna.md` | GPT-5.6 Luna | High | `workspace-write` |
| Implementer — hard worker | `docs/agents/codex-briefs/implementer-luna-max.md` | GPT-5.6 Luna | Max | `workspace-write` |
| Final review | `docs/agents/codex-briefs/final-reviewer.md` | GPT-5.6 Sol | High | `read-only` |

`implementer-opus` and `implementer-opus-high` are Claude Code subagents, the
same brief at two efforts. Every GPT role is a Codex
session, not a subagent: its brief lives in `docs/agents/codex-briefs/`.

Effort ranges the roles are licensed for, where a task warrants moving: Astra
roles Low–Medium, the Opus implementers Low–High, final review Medium–High.
Codex effort is chosen per call; the Opus subagent's is its `effort:`
frontmatter.

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

**Workers are cheap but unverified.** Luna implementers take bounded,
well-specified tasks. Their output is *always* validated — by the orchestrator,
by `npm test` / `npm run typecheck` / `node scripts/check-content.mjs`, and by
the final review before it becomes history. Offloading is a throughput
decision, never a trust decision.

**Advisors do not edit, and the sandbox enforces it.** The final reviewer and
the architectural reviewer run under `read-only`, which lets them run
`git diff` and read the tree but not write to it. A reviewer that can fix what
it finds stops reporting and starts patching, and the author never learns what
was wrong.

## Routing

- **Needs judgement, spans modules, touches privacy or permissions** →
  `implementer-opus`, or keep it in the main thread.
- **Judgement and genuinely hard** — durable data, a privacy contract, several
  interacting seams → `implementer-opus-high`.
- **Bounded, one module, clear spec** → Luna, High.
- **Bounded but genuinely hard** — subtle state, tricky edge cases, an algorithm
  that is easy to get almost right → Luna, Max.
- **Several independent tasks, no shared state** → dispatch in parallel, one
  delegate per problem domain.
- **Unsure whether the approach is right** → the architectural reviewer before
  writing code, not after.
- **Before every commit** → the final review. Not optional.

## Stop conditions outrank routing

Every delegate halts and asks rather than proceeding when work would touch child
data or member PII, need a new credential or scope, add a vendor, contradict a
locked decision in `ASTRO-ARCHITECTURE.md`, or produce the bot's first public
post. A delegate hitting one of these reports it; it does not decide it.
