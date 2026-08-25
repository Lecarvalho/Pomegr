---
name: init
description: Initialize or update a repository's Pomegr reporting policy for Codex. Use when the user invokes $pomegr:init, asks which project-specific session, agent, or execution-task signals Codex should report, or wants to revise .pomegr/signals.md.
---

# Initialize Pomegr reporting

Create or update `.pomegr/signals.md`. Change nothing else: never edit `AGENTS.md`, Codex configuration, agent definitions, provider settings, or application code.

1. Inspect the repository before asking questions. Read only safe project structure, package/build manifests, test and CI configuration, contributor guidance, names of project-scoped agent files under `.codex/agents/`, and an existing `.pomegr/signals.md`. Do not inspect secrets, credentials, transcripts, prompts, responses, hook payloads, command-output archives, environment files, or MCP configuration values.
2. Resolve this plugin's `scripts/policy.mjs` relative to this `SKILL.md`. If a policy exists, run `node <script> validate --cwd <repository-root>`, summarize its configured signals and delegated agents, and preserve user-written table choices. Upgrade an older policy by retaining approved signal rows while restoring the current canonical sections from the template.
3. Identify only project-specific states that Pomegr cannot already derive. Do not propose generic working, idle, running, finished, context-size, Git, tool-count, approval, agent-liveness, plan-task, or execution-task lifecycle signals.
4. Ask concise questions about the outcomes an observer needs to notice and when each outcome ceases to apply. For every proposed signal, settle its scope, label, tone, `Report when`, and `Replace or clear when` condition.
5. Prefer a small transition vocabulary. Use session scope for the overall goal, agent scope for a particular agent's semantic role or conclusion, and task scope only for an outcome tied to a recognized execution-task ID.
6. When agent or execution-task signals are configured, settle delegation explicitly. Consider built-in Codex types such as `default`, `worker`, and `explorer`, project-scoped agent names the user confirms, and other harness-provided types the user names. Record only types that can reach a configured outcome and retain the Pomegr MCP tools. Use `*` only when every spawned type may own configured reporting. Leave the table empty when the main session keeps all reporting.
7. Read [the policy template](references/policy-template.md). Draft the complete file with the same title, policy version, headings, canonical sections, two-column `Delegated agents` table, and four-column signal tables. Use `_No delegated agent types configured._` for an empty delegation table and `_No project-specific signals configured._` for an empty signal scope. A delegation row may own only a scope that has at least one configured signal.
8. Preview the complete proposed Markdown or a focused diff for an existing policy. Explain which candidates were omitted because Pomegr already derives them. Obtain explicit user confirmation before writing.
9. Write only `.pomegr/signals.md`, creating `.pomegr/` when needed. Never blindly replace an existing policy; apply the confirmed update while retaining unrelated user-authored guidance that remains valid.
10. Run the validator again. Fix structural errors without changing approved semantics. Report the final path, configured scopes, declared delegated agents, and whether these five logical MCP tools are available: `report_session_signal`, `report_agent_signal`, `report_task_signal`, `clear_session_signal`, and `clear_agent_signal`. Match a Pomegr MCP namespace plus the logical suffix while displaying only the short names. Do not invoke a reporting or clearing tool as a connection test.
11. Confirm whether the current context contains `[Pomegr reporting policy loaded]`. If it does not, explain that initialization succeeded but automatic loading begins only after the plugin hooks are trusted and a new or resumed task triggers `SessionStart`. Direct the user to `/hooks` to review the Pomegr hooks and to start a new task after trusting them.
12. Follow the approved policy immediately in the current task. The `SubagentStart` hook supplies matching delegated rows automatically, so do not paste them into subagent prompts. Use provider-native automatic task naming unless a safe title capability is available.

## Constraints

- Labels are plain text, 1-20 characters.
- Tones are `neutral`, `info`, `positive`, `warning`, or `negative`.
- Conditions are concrete, observable, and at most 240 characters.
- Delegated agent types are normalized type names of at most 64 characters, or `*`. Ownership is `agent`, `task`, or `agent and task`.
- Policy table cells cannot contain pipe characters.
- Report transitions rather than periodic progress. A later report replaces the same scope; clear resolved agent/session state when no replacement applies. Task outcomes remain durable.
- Never put raw commands, output, matched source text, prompts, responses, secrets, credentials, transcript paths, or hook payloads in a policy or signal.
