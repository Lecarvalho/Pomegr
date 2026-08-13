# Threadlight reporting policy

Policy version: 1

## Session naming

- Allow Claude Code to assign a concise native automatic title after the first substantive request.
- Never ask the user to name the session and never report a title through Threadlight MCP.

## Privacy and semantics

- Report only project-specific state that helps an observer understand the work.
- Treat every signal as agent-reported and potentially stale, not as a Threadlight judgment.
- Report transitions, not heartbeats. Replace a signal when a new configured state applies; clear agent or session state when none applies.
- Never include prompts, responses, secrets, commands, stdout, stderr, tool results, credential values, or sensitive repository content.
- Use only labels and conditions approved below. Threadlight's universal MCP validation remains the safety boundary, not this file as an application enum.

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
