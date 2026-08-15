---
name: doctor
description: Diagnose a repository's Pomegr reporting setup without changing files or emitting telemetry. Use when the user invokes /pomegr:doctor, reports missing signal tools or policy loading, or asks whether .pomegr/signals.md and the Claude plugin are configured correctly.
---

# Diagnose Pomegr reporting

Perform a read-only diagnosis. Do not edit files, report signals, or call either clear tool.

1. Resolve this plugin's `scripts/policy.mjs` relative to this `SKILL.md`. Run `node <script> validate --cwd <repository-root>` and interpret its JSON output:
   - `valid`: show the path and byte size, list the `delegatedAgents` rows, and list any `warnings` as delegation drift; recommend `/pomegr:init` to repair them.
   - `missing`: explain that repository-specific reporting is inactive and recommend `/pomegr:init`.
   - `invalid`: list the bounded validation errors and recommend `/pomegr:init` to review an update.
2. Confirm that the current context contains the marker `[Pomegr reporting policy loaded]` when the policy is valid. This is the runtime proof that the hook loaded this policy. If absent, explain that this session may predate initialization or that the `SessionStart` hook did not run; direct the user to Claude Code's `/hooks` view to verify the Pomegr `SessionStart` hook, then recommend `/reload-plugins` and starting or resuming a session.
3. Report delegation coverage when the policy configures agent or execution-task signals. An empty `delegatedAgents` list means no subagent receives the rows automatically, which is correct only when the delegating session keeps all reporting for itself. A declared row means the `PreToolUse` delegation hook appends the applicable rows to that subagent's prompt at spawn time; that marker is `[Pomegr delegated reporting policy]` and appears in the subagent's prompt, never in this session's context.
4. Check the available inventory for these five logical Pomegr MCP tools: `report_session_signal`, `report_agent_signal`, `report_task_signal`, `clear_session_signal`, and `clear_agent_signal`. Claude exposes plugin tools with names such as `mcp__plugin_pomegr_pomegr__report_session_signal`; recognize the Pomegr MCP namespace plus each logical suffix, while displaying the short names to the user. Do not invoke them as a connection test because their transcript calls have semantic meaning.
5. If any tool is missing, direct the user to Claude Code's `/mcp` view and `/reload-plugins`. Do not read credential files or expose MCP configuration values.
6. Verify that the plugin package contains `.mcp.json`, `hooks/hooks.json`, and `scripts/policy.mjs`, and that the hooks manifest registers `SessionStart`, `PreToolUse`, and `SubagentStop`. This confirms packaged structure, not runtime registration.
7. Return a compact checklist covering policy, automatic loading, delegation coverage, MCP tools, and native session naming. Native naming passes when Claude Code is allowed to create its automatic title; an idle session may remain Untitled.

Never modify `AGENTS.md`, `CLAUDE.md`, `.claude/settings*`, or `.pomegr/signals.md` during diagnosis.
