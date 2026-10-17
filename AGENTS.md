# Papa Squad hub site + Papa Sherpa

A Discord catalog and index for the Papa Squad community, plus Papa Sherpa — a
bot that matches members' interests against it.

Start with `docs/proposals/project-fundamentals/ASTRO-ARCHITECTURE.md`, the
current build handoff. It names its own locked decisions, stop conditions, and
anti-goals; read them before writing code.

## Build only what the task needs

Every agent here — orchestrator, subagent, Codex role — works YAGNI. Write the
code the task asks for; a helper, option or abstraction for a need nobody has
yet waits until someone has it.

Tests follow the same rule. **A test guards a failure that is invisible or
complex** — a privacy or permission leak, lost durable data, subtle state, an
edge case that is easy to get almost right, a contract with Discord or another
service. Code whose correctness shows on reading, and a test that only restates
the implementation, get no test. When you write one, prove it bites: break the
code, watch it fail, restore.

## Review process

**Every change set is challenged by an adversarial review from a different model
before commit, and valid in-scope findings are fixed first.** Not optional.
GPT-5.6 Sol reviews Claude's work through the `skill-codex` skill; Claude
reviews Codex's. See
`docs/agents/review-process.md` for the cycle, the triage rules, and the record
of what it has caught.

## Delegation model

Opus 5.5 at High effort orchestrates. Implementation, UX, architectural advice
and final review are delegated — Codex roles through the `skill-codex` skill
with briefs in `docs/agents/codex-briefs/`; the Opus, Sonnet and Haiku
implementers and the Haiku researcher as subagents in `.claude/agents/`. Author and reviewer
are never the same model. See `docs/agents/delegation-model.md` for the roster
and the routing rules.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root, ADRs in `docs/adr/`. See `docs/agents/domain.md`.
