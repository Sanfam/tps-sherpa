@AGENTS.md

## Claude Code specifics

The rules above are the project's; this section maps them onto Claude Code.

- **Worktrees.** Start a conversation that will change files with
  `claude --worktree <name>`, or call `EnterWorktree` before the first edit.
  Dispatch every subagent with `isolation: "worktree"`; the project agents in
  `.claude/agents/` also set it in their frontmatter.
- **The review gate** runs Codex through the `skill-codex` skill on the diff in
  the conversation's worktree, before commit.
