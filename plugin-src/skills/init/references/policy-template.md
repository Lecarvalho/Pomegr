# Pomegr reporting policy

Policy version: 7

## Session naming

- After the first substantive request makes the work clear, set one concise, meaningful title through an available provider-native capability. If no safe title capability is available, allow the provider's automatic title.
- Never ask the user to name the session and never overwrite a title explicitly set by the user. Only the main session names itself; subagents never rename the session.

## Privacy and semantics

- Report only project-specific state that helps an observer understand the work.
- Treat every signal as agent-reported and potentially stale, not as a Pomegr judgment.
- Report transitions, not heartbeats. Replace a signal when a new configured state applies; clear agent or session state when none applies.
- Never include prompts, responses, secrets, commands, stdout, stderr, tool results, credential values, or sensitive repository content.
- Use only labels and conditions approved below. Pomegr's universal MCP validation remains the safety boundary, not this file as an application enum.

## Tool suffixes

Use these suffixes in the resolved Pomegr MCP namespace; provider-specific prefixes are not part of this policy.

| Tool suffix | Use |
| --- | --- |
| `report_session_signal` | Report or replace the overall session state when a configured Session signals row applies. |
| `clear_session_signal` | Clear the session state when no configured Session signals row applies. |
| `report_agent_signal` | Report or replace the calling agent's state when a configured Agent signals row applies. |
| `clear_agent_signal` | Clear the calling agent's state when no configured Agent signals row applies. |
| `report_task_signal` | Record a durable outcome for a recognized execution-task ID when a configured Task signals row applies; task signals are never cleared. |
| `report_session_progress` | When Session progress is enabled, report or replace the overall progress estimate. |
| `clear_session_progress` | Clear the progress estimate when it is no longer meaningful. |

## Delegated agent tooling

- A subagent can start without this policy in its context. Declare every signal-owning subagent type under `Delegated agents`; the active provider adapter's delegation hook then supplies the applicable rows to that subagent.
- Never rely on the delegating session remembering to paste the rows. Injection is the mechanism; a pasted copy is only a fallback, and the hook does not append a second copy when the prompt already carries one.
- Every signal-owning subagent must retain access to the Pomegr MCP server and the applicable reporting tools. A custom agent definition that replaces or disables inherited MCP configuration must explicitly restore that access.
- Match the logical tool suffixes `report_agent_signal`, `report_task_signal`, and `clear_agent_signal` in the resolved Pomegr MCP namespace; provider-specific prefixes are not part of this policy.
- Never assign agent- or task-signal reporting to a subagent that cannot call the applicable Pomegr MCP tool. Add the tool, or keep the reporting in the delegating session.

## Session progress

- Enabled: no

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
