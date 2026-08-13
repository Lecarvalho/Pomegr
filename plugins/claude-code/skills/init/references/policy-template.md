# Pomegr reporting policy

Policy version: 2

## Session naming

- Allow Claude Code to assign a concise native automatic title after the first substantive request.
- Never ask the user to name the session and never report a title through Pomegr MCP.

## Privacy and semantics

- Report only project-specific state that helps an observer understand the work.
- Treat every signal as agent-reported and potentially stale, not as a Pomegr judgment.
- Report transitions, not heartbeats. Replace a signal when a new configured state applies; clear agent or session state when none applies.
- Never include prompts, responses, secrets, commands, stdout, stderr, tool results, credential values, or sensitive repository content.
- Use only labels and conditions approved below. Pomegr's universal MCP validation remains the safety boundary, not this file as an application enum.

## Delegated agent tooling

- When delegating work that can produce a configured agent or execution-task signal, include the applicable signal rows and transition rules in the Agent prompt.
- Ensure that subagent tooling includes the Pomegr MCP tools. If an agent definition has an explicit `tools` allowlist, add the resolved Pomegr MCP namespace, typically `mcp__plugin_pomegr_pomegr__*`, or the exact Pomegr reporting and clearing tool names available in the session.
- Do not assign agent- or task-signal reporting to a subagent that cannot call the applicable Pomegr MCP tool.

## Session signals

| Label | Tone | Report when | Replace or clear when |
| --- | --- | --- | --- |
| Ready for review | positive | The requested repository change is implemented and its required checks pass. | Replace if review finds new work; clear when the session moves to unrelated work. |

## Agent signals

_No project-specific signals configured._

## Task signals

| Label | Tone | Report when | Replace or clear when |
| --- | --- | --- | --- |
| Checks passed | positive | A recognized execution task finishes the repository's required verification successfully. | Replace only if a later outcome for the same execution task supersedes it; task signals are not cleared. |
