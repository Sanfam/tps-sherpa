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

## Tests are purposeful

**A test replays a real-world use and guards a failure in it that is invisible
or complex.** The scenario is one that can actually happen — a member, an
editor, Discord or another service doing something it really does — and the
failure is one reading the code will not catch: a privacy or permission leak,
lost durable data, subtle state, an edge case that is easy to get almost right,
a contract with Discord or another service.

- Code whose correctness shows on reading gets no test.
- A test that proves the code does what it is written to do — restating its
  branches, its calls or its return shape — is not a test. Derive the expected
  outcome from the use case, not from the implementation.
- Assert on wording — a word in a reply, a heading, a label — only when the
  system's operation depends on it: a command name Discord matches, a marker
  another component parses, a string a contract requires.

When you write one, prove it bites: break the code, watch it fail, restore.

## One worktree per conversation and per task

**Every conversation that changes files, and every subagent or Codex task,
works in its own git worktree under `.claude/worktrees/`**, on its own branch.
The main checkout belongs to the human; leave it as you found it.

- A conversation enters a fresh worktree before its first edit, branched from
  `main` unless the task builds on another branch.
- A subagent runs in its own worktree; a Codex role runs with its working
  directory set to the worktree of the task it serves.
- A new worktree has no `node_modules`: run `npm ci` in it before the checks.
- Remove the worktree when its branch is merged or abandoned.

`docs/agents/delegation-model.md` covers how a delegate's worktree is
dispatched and how its work comes back.

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
