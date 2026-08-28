# CLAUDE.md

This repository keeps one set of agent instructions. `AGENTS.md` is the single source of
truth for every harness. Do not copy its guidance into this file: extend `AGENTS.md` so
Claude, Codex, and future harnesses stay in sync.

@AGENTS.md

## Claude Code specifics

- Repository skills are defined once in their canonical package (`.agents/skills/` for
  shared repository skills and `.codex/skills/` for Codex-hosted skills). Each package
  under `.claude/skills/` is a pointer to its canonical counterpart, so behavior lives
  in one file.
- The Impeccable design hook is installed per harness by the Impeccable skill itself, not
  by hand: `.codex/hooks.json` for Codex, the gitignored `.claude/settings.local.json` for
  Claude Code. Run the Impeccable skill's `hooks on` action to wire it on a new machine.

See [docs/AGENT-WORKFLOW.md](docs/AGENT-WORKFLOW.md) for the path-routing table and
single-file verification commands.
