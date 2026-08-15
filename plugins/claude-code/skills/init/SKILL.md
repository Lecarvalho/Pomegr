---
name: init
description: Initialize or update a repository's Pomegr reporting policy. Use when the user invokes /pomegr:init, asks to configure which project-specific session, agent, or execution-task signals coding agents should report, or wants to revise .pomegr/signals.md.
---

# Initialize Pomegr reporting

Create or update `.pomegr/signals.md`, and the `tools` allowlists of agent definitions that can own a configured signal. Change nothing else: never edit `AGENTS.md`, `CLAUDE.md`, provider settings, or application code.

## Workflow

1. Inspect the repository before asking questions. Read only safe project structure, package/build manifests, test and CI configuration, contributor guidance, and an existing `.pomegr/signals.md`. Do not inspect secrets, credentials, transcripts, prompts, responses, command output archives, or environment files.
2. If a policy exists, resolve this plugin's `scripts/policy.mjs` relative to this `SKILL.md` and run `node <script> validate --cwd <repository-root>`. Summarize its configured signals and delegated agents, and preserve user-written table choices. The `Session naming`, `Privacy and semantics`, and `Delegated agent tooling` sections are canonical policy; restore them from the template if they drift. A policy written for an earlier version is upgraded here: keep its signal rows, replace the canonical sections, and add the `Delegated agents` section.
3. Identify only project-specific states that Pomegr cannot already derive. Do not propose generic working, idle, running, finished, context-size, Git, tool-count, approval, agent-liveness, or task-lifecycle signals.
4. Ask the user concise questions about the outcomes observers need to notice and when those outcomes cease to apply. For every proposed signal, lock its scope, label, tone, `Report when`, and `Replace or clear when` condition.
5. Prefer a small transition vocabulary. Use session scope for the overall goal, agent scope for a particular agent's semantic role or conclusion, and task scope only for an outcome tied to a known execution-task ID.
6. Whenever the drafted policy configures agent or execution-task signals, settle delegation explicitly. Enumerate the subagent types this repository actually delegates to, including project definitions in `.claude/agents/*.md` and any plugin- or harness-provided types the user names. Ask which of them can reach a configured outcome, and record each as a `Delegated agents` row owning `agent`, `task`, or `agent and task`. Use `*` only when every subagent type in the repository can own a configured signal, because that row makes the delegation hook append rows to every spawn. Leave the section empty when the delegating session keeps all reporting for itself.
7. Read [the policy template](references/policy-template.md). Draft the complete file with the same title, policy version, headings, canonical delegated-agent tooling requirements, the two-column `Delegated agents` table, and four-column signal tables. Use `_No delegated agent types configured._` for an empty delegation table and `_No project-specific signals configured._` for an empty signal scope. A `Delegated agents` row may only own a scope that configures at least one row.
8. Resolve agent-definition repairs for every declared delegated agent type. A definition with an explicit `tools` allowlist that omits the Pomegr tools receives the injected rows and still cannot report, so prepare an edit adding the resolved namespace, typically `mcp__plugin_pomegr_pomegr__*`, or the exact reporting tool names. Prepare these edits as part of initialization; the user confirms them at the preview step. Do not add reporting instructions to an agent definition body: the plugin's `PreToolUse` delegation hook supplies the rows at spawn time, which also works when a definition is a thin wrapper around a canonical body elsewhere.
9. Preview the complete proposed Markdown or a focused diff for an existing policy, together with every prepared agent-definition edit. Explain which signals were omitted as duplicates. Obtain explicit user confirmation before writing.
10. Write `.pomegr/signals.md`, creating `.pomegr/` if needed, and apply the confirmed agent-definition edits. Never blindly replace an existing policy: apply the confirmed changes while retaining unrelated user-authored guidance that remains valid.
11. Run the validator again. Fix structural errors without changing approved semantics. Report any `warnings` it returns as delegation drift: a declared agent type that cannot reach the Pomegr tools, or a definition carrying those tools that no `Delegated agents` row matches. Report the final path, configured scopes, declared delegated agents, and whether the five expected logical MCP tools are available: `report_session_signal`, `report_agent_signal`, `report_task_signal`, `clear_session_signal`, and `clear_agent_signal`. Claude exposes plugin tools with names such as `mcp__plugin_pomegr_pomegr__report_session_signal`; match the Pomegr namespace plus these logical suffixes, while displaying the short names to the user. If unavailable, direct the user to `/mcp`; do not emit a diagnostic signal.
12. Follow the resulting policy immediately. Delegation needs no per-call discipline: the plugin appends the applicable rows to a declared subagent's prompt, and pasting them again is unnecessary. Allow Claude Code to create its native automatic session title; never ask the user to invoke `/rename`.

## Constraints

- Labels must be plain text, 1-20 characters.
- Tones are `neutral`, `info`, `positive`, `warning`, or `negative`.
- Conditions must be concrete, observable, and at most 240 characters.
- Delegated agent types are the subagent type name, at most 64 characters, or `*`. Ownership is `agent`, `task`, or `agent and task`.
- Policy table cells cannot contain pipe characters.
- Report transitions rather than periodic progress. A later report replaces the same scope; clear resolved agent/session state when no replacement applies. Task outcomes remain durable.
- Never put raw commands, output, matched source text, prompts, responses, secrets, or credentials in a policy or signal.
