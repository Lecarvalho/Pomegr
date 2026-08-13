---
name: doctor
description: Diagnose a repository's Pomegr reporting setup without changing files or emitting telemetry. Use when the user invokes /pomegr:doctor, reports missing signal tools or policy loading, or asks whether .pomegr/signals.md and the Claude plugin are configured correctly.
---

# Diagnose Pomegr reporting

Perform a read-only diagnosis. Do not edit files, report signals, or call either clear tool.

1. Resolve this plugin's `scripts/policy.mjs` relative to this `SKILL.md`. Run `node <script> validate --cwd <repository-root>` and interpret its JSON output:
   - `valid`: show the path and byte size.
   - `missing`: explain that repository-specific reporting is inactive and recommend `/pomegr:init`.
   - `invalid`: list the bounded validation errors and recommend `/pomegr:init` to review an update.
2. Confirm that the current context contains the marker `[Pomegr reporting policy loaded]` when the policy is valid. This is the runtime proof that the hook loaded this policy. If absent, explain that this session may predate initialization or that the `SessionStart` hook did not run; direct the user to Claude Code's `/hooks` view to verify the Pomegr `SessionStart` hook, then recommend `/reload-plugins` and starting or resuming a session.
3. Check the available inventory for these five logical Pomegr MCP tools: `report_session_signal`, `report_agent_signal`, `report_task_signal`, `clear_session_signal`, and `clear_agent_signal`. Claude exposes plugin tools with names such as `mcp__plugin_pomegr_pomegr__report_session_signal`; recognize the Pomegr MCP namespace plus each logical suffix, while displaying the short names to the user. Do not invoke them as a connection test because their transcript calls have semantic meaning.
4. If any tool is missing, direct the user to Claude Code's `/mcp` view and `/reload-plugins`. Do not read credential files or expose MCP configuration values.
5. Verify that the plugin package contains `.mcp.json`, `hooks/hooks.json`, and `scripts/policy.mjs`. This confirms packaged structure, not runtime registration.
6. Return a compact checklist covering policy, automatic loading, MCP tools, and native session naming. Native naming passes when Claude Code is allowed to create its automatic title; an idle session may remain Untitled.

Never modify `AGENTS.md`, `CLAUDE.md`, `.claude/settings*`, or `.pomegr/signals.md` during diagnosis.
