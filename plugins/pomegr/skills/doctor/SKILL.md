---
name: doctor
description: Diagnose a repository's Pomegr reporting setup for Codex without changing files or emitting signals. Use when the user invokes $pomegr:doctor, reports missing signal tools or policy loading, or asks whether .pomegr/signals.md and the Codex plugin are configured correctly.
---

# Diagnose Pomegr reporting

Perform a read-only diagnosis. Do not edit files, report signals, call either clear tool, or expose MCP configuration values.

1. Resolve this plugin's `scripts/policy.mjs` relative to this `SKILL.md`. Run `node <script> validate --cwd <repository-root>` and interpret its bounded JSON output:
   - `valid`: show the path and byte size and list the `delegatedAgents` rows.
   - `missing`: explain that repository-specific reporting is inactive and recommend `$pomegr:init`.
   - `invalid`: list the bounded validation errors and recommend `$pomegr:init` to review an update.
2. Confirm that the current context contains `[Pomegr reporting policy loaded]` when the policy is valid. If absent, explain that this task may predate initialization or the hooks may not be trusted. Direct the user to `/hooks` to review the Pomegr `SessionStart`, `SubagentStart`, and `SubagentStop` hooks, then recommend starting or resuming a task.
3. Report delegation coverage when agent or execution-task signals are configured. An empty delegation list means the main session retains reporting. A declared row means the `SubagentStart` hook supplies the matching rows to that agent type under `[Pomegr delegated reporting policy]`.
4. Check the available inventory for five logical Pomegr MCP tools: `report_session_signal`, `report_agent_signal`, `report_task_signal`, `clear_session_signal`, and `clear_agent_signal`. Recognize the resolved Pomegr namespace plus each logical suffix while displaying only the short names. Do not invoke them as a connection test because every report or clear call has semantic meaning.
5. If a tool is missing, direct the user to the Codex plugin settings and `/mcp`. Do not read credential files, `.mcp.json`, or other MCP configuration values.
6. Verify that the installed plugin package contains `.mcp.json`, `hooks/hooks.json`, `scripts/policy.mjs`, `skills/init/SKILL.md`, and `skills/doctor/SKILL.md`, and that the hooks file registers `SessionStart`, `SubagentStart`, and `SubagentStop`. This confirms packaged structure, not runtime trust or execution.
7. Validate optional repository role display mappings with `node <repository-root>/monitor/agent-roles.mjs validate --cwd <repository-root>`. Report missing as inactive, show only bounded terminal diagnostics and accepted mapping keys, and explain that an invalid file is ignored by the monitor. Never expose role-map values through browser-visible output.
8. Return a compact checklist covering policy validity, automatic loading, hook trust, delegation coverage, MCP tools, and optional role mappings.

Never modify `AGENTS.md`, `.codex/config.toml`, `.codex/agents/*`, `.codex/hooks.json`, `.pomegr/signals.md`, or application code during diagnosis.
