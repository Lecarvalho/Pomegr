# Pomegr reporting policy

Policy version: 4

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

- A subagent inherits the parent's MCP tools but not the parent's context, so it never sees this policy on its own. Declare every signal-owning subagent type under `Delegated agents`; the plugin's `PreToolUse` delegation hook then appends the applicable rows to that subagent's prompt.
- Never rely on the delegating session remembering to paste the rows. Injection is the mechanism; a pasted copy is only a fallback, and the hook does not append a second copy when the prompt already carries one.
- Every agent definition that can own a configured agent or execution-task signal must also carry the Pomegr reporting tools in its `tools` allowlist. Claude Code subagents inherit MCP tools from the parent unless a definition sets an explicit allowlist.
- Prefer the resolved Pomegr MCP namespace, typically `mcp__plugin_pomegr_pomegr__*`, and use the exact reporting and clearing tool names where allowlist wildcard support is not confirmed.
- Never assign agent- or task-signal reporting to a subagent that cannot call the applicable Pomegr MCP tool. Add the tool, or keep the reporting in the delegating session.

## Delegated agents

_No delegated agent types configured._

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
