# Delegation model

Who does which work, on which model, at what reasoning effort. Agent definitions
live in `.claude/agents/`; this document is why they are what they are.

## The roster

| Role | Agent | Model | Effort | Edits code? |
|---|---|---|---|---|
| Orchestrator / top architect | *(main thread)* | Claude Opus 5.5 | High | yes |
| UX designer | `ux-designer` | GPT-6 Astra | Medium | yes |
| Architectural reviewer | `architecture-consultant` | GPT-6 Astra | Medium | **no** |
| Implementer — judgement | `implementer-opus` | Claude Opus 5.5 | Medium | yes |
| Implementer — worker | `implementer-luna` | GPT-5.6 Luna | High | yes |
| Implementer — hard worker | `implementer-luna-max` | GPT-5.6 Luna | Max | yes |
| Final review | `final-reviewer` | GPT-5.6 Sol | High | **no** |

Effort ranges the roles are licensed for, where a task warrants moving: Astra
roles Low–Medium, `implementer-opus` Low–Medium, `final-reviewer` Medium–High.
Changing one means editing that agent's `effort:` frontmatter — effort is fixed
per definition, not chosen at spawn time. That is why Luna High and Luna Max are
two files rather than one.

## Why it is shaped this way

**The orchestrator holds the context.** Subagents start cold and re-derive
everything, which is their real cost. Work stays in the main thread unless
delegating buys isolation, a different model's blind spots, or genuine
parallelism.

**Author and reviewer are never the same model.** That is the whole argument in
`review-process.md`, and it is the one rule here that is not negotiable. An
Opus-authored change reviewed by Sol is independent; an Opus-authored change
reviewed by Opus is one mind marking its own work.

**Workers are cheap but unverified.** Luna implementers take bounded,
well-specified tasks. Their output is *always* validated — by the orchestrator,
by `npm test` / `npm run typecheck` / `node scripts/check-content.mjs`, and by
`final-reviewer` before it becomes history. Offloading is a throughput decision,
never a trust decision.

**Advisors do not edit.** `architecture-consultant` and `final-reviewer` have
no `Write` or `Edit` in their `tools:` list — but they keep `Bash`, because a
reviewer that cannot run `git diff` or the tests cannot review, and `Bash` can
write through a redirect. So this is enforced by instruction, not by the tool
list, and an advisor that edits has broken its brief. A reviewer that can fix
what it finds stops reporting and starts patching, and the author never learns
what was wrong.

## Routing

- **Needs judgement, spans modules, touches privacy or permissions** →
  `implementer-opus`, or keep it in the main thread.
- **Bounded, one module, clear spec** → `implementer-luna`.
- **Bounded but genuinely hard** — subtle state, tricky edge cases, an algorithm
  that is easy to get almost right → `implementer-luna-max`.
- **Several independent tasks, no shared state** → dispatch in parallel, one
  agent per problem domain.
- **Unsure whether the approach is right** → `architecture-consultant` before
  writing code, not after.
- **Before every commit** → `final-reviewer`. Not optional.

## How the GPT models are reached

Astra, Luna and Sol are served through the local model gateway, which exposes
them as Claude-shaped ids (`claude-gpt-6-astra[1m]`, `claude-gpt-5.6-luna[1m]`,
`claude-gpt-5.6-sol[1m]`). The agent definitions name those ids directly. The
gateway must be running; `ANTHROPIC_BASE_URL` points at it.

This is a different mechanism from the `skill-codex` skill, which shells out to
the `codex` CLI as a separate process. Both reach OpenAI models; only the
gateway route gives you a real subagent with tools. The CLI fallback when the
gateway cannot serve a model is `codex exec -s read-only -m <model>`, fed the
agent's brief and the intent on stdin, with `-m` pinned to a model other than
the author's — see `review-process.md`.

**Known gap (2026-09-24):** the gateway rejects `gpt-5.6-sol` when Codex is
signed in with a ChatGPT account, so `final-reviewer` fails on its first call.
Until the gateway is authenticated with an API key, run the final review
through the CLI fallback and say so in the commit message.

## Stop conditions outrank routing

Every agent halts and asks rather than proceeding when work would touch child
data or member PII, need a new credential or scope, add a vendor, contradict a
locked decision in `ASTRO-ARCHITECTURE.md`, or produce the bot's first public
post. A subagent hitting one of these reports it; it does not decide it.
