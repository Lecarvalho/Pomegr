---
name: init
description: Initialize or update a repository's Threadlight reporting policy. Use when the user invokes /threadlight:init, asks to configure which project-specific session, agent, or execution-task signals coding agents should report, or wants to revise .threadlight/signals.md.
---

# Initialize Threadlight reporting

Create or update `.threadlight/signals.md` without changing `AGENTS.md`, `CLAUDE.md`, provider settings, or application code.

## Workflow

1. Inspect the repository before asking questions. Read only safe project structure, package/build manifests, test and CI configuration, contributor guidance, and an existing `.threadlight/signals.md`. Do not inspect secrets, credentials, transcripts, prompts, responses, command output archives, or environment files.
2. If a policy exists, resolve this plugin's `scripts/policy.mjs` relative to this `SKILL.md` and run `node <script> validate --cwd <repository-root>`. Summarize its configured signals and preserve user-written signal-table choices. The `Session naming` and `Privacy and semantics` sections are canonical safety policy; restore them from the template if they drift.
3. Identify only project-specific states that Threadlight cannot already derive. Do not propose generic working, idle, running, finished, context-size, Git, tool-count, approval, agent-liveness, or task-lifecycle signals.
4. Ask the user concise questions about the outcomes observers need to notice and when those outcomes cease to apply. For every proposed signal, lock its scope, label, tone, `Report when`, and `Replace or clear when` condition.
5. Prefer a small transition vocabulary. Use session scope for the overall goal, agent scope for a particular agent's semantic role or conclusion, and task scope only for an outcome tied to a known execution-task ID.
6. Read [the policy template](references/policy-template.md). Draft the complete file with the same title, policy version, headings, and four-column tables. Use `_No project-specific signals configured._` for an empty scope.
7. Preview the complete proposed Markdown or a focused diff for an existing policy. Explain which signals were omitted as duplicates. Obtain explicit user confirmation before writing.
8. Write only `.threadlight/signals.md`, creating `.threadlight/` if needed. Never blindly replace an existing policy: apply the confirmed changes while retaining unrelated user-authored guidance that remains valid.
9. Run the validator again. Fix structural errors without changing approved semantics. Report the final path, configured scopes, and whether the five expected logical MCP tools are available: `report_session_signal`, `report_agent_signal`, `report_task_signal`, `clear_session_signal`, and `clear_agent_signal`. Claude exposes plugin tools with names such as `mcp__plugin_threadlight_threadlight__report_session_signal`; match the Threadlight namespace plus these logical suffixes, while displaying the short names to the user. If unavailable, direct the user to `/mcp`; do not emit a diagnostic signal.
10. Follow the resulting policy immediately. Allow Claude Code to create its native automatic session title; never ask the user to invoke `/rename`.

## Constraints

- Labels must be plain text, 1-20 characters.
- Tones are `neutral`, `info`, `positive`, `warning`, or `negative`.
- Conditions must be concrete, observable, and at most 240 characters.
- Policy table cells cannot contain pipe characters.
- Report transitions rather than periodic progress. A later report replaces the same scope; clear resolved agent/session state when no replacement applies. Task outcomes remain durable.
- Never put raw commands, output, matched source text, prompts, responses, secrets, or credentials in a policy or signal.
