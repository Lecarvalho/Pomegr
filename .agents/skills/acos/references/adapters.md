# ACOS adapters for Claude Code

How each `adapter` value runs a stage when the orchestrator is a Claude Code
session. Every adapter takes a stage definition plus a built prompt, and
returns text (the stage output) plus, when available, token counts.

## inline

The orchestrator does the work itself in the current session.

- Use the session's own tools (read, edit, run commands).
- `provider` and `model` may be omitted; the session model is used.
- Map `effort` to your own behaviour: `low` means minimal exploration and
  terse output, `high` and `max` mean read more before acting.
- Tokens: not reported by the harness. Estimate from what you read and
  wrote (roughly 4 characters per token) and log
  `tokens: <n>, estimated: true`.
- Escalation on an inline stage: if the next `escalation` entry names
  the session model, raise effort and retry inline. If it names a
  different model, run the retry as a `subagent` with that model, count it
  against `limits.agents`, and log `adapter_used: subagent`.

Best for: nearly everything. Plan, implement, verify, and review of small
changes. This is the default adapter.

## subagent

Spawn one agent with the Agent tool.

- `subagent_type`: `general-purpose` for implement, `Explore` for explore,
  `Plan` for plan, `general-purpose` for review. Use a project-defined
  agent type instead if `.acos.yaml` names one under `agents.<block>`.
- `model`: pass the stage model through the Agent tool `model` field when
  the harness accepts it. Map catalog ids to the harness's short names
  (`claude-opus-5` to `opus`, `claude-sonnet-5` to `sonnet`,
  `claude-haiku-4-5` to `haiku`). If the harness cannot select that model,
  log the model actually used.
- `effort`: state it in the prompt as a one-line instruction, e.g.
  "Effort: low. Minimal exploration, terse report."
- The prompt must be self-contained: the agent has no conversation
  context. Include intent, scope notes, inputs, and the block prompt.
- Ask the agent to end with a clear final report; that report is the stage
  output.
- Tokens: not reported by the harness. Log `tokens: null`, or an
  estimate marked `estimated: true` if the agent reports what it read.
- Each spawn counts against `limits.agents`. A retry is a new spawn.

Parallel stages: if two consecutive stages share no inputs/outputs
dependency, they may be spawned in one message. Log them separately.

## workflow

Compile the stage (or a run of consecutive `workflow` stages) into a
Workflow tool script. Full rules and a template: `workflow.md` in this
folder. Load the `workflow-authoring` skill before writing the script.

- Opt-in: the GO reply on a manifest that shows `adapter: workflow` is the
  user's explicit request for a workflow. Never move a stage to
  `workflow` after GO.
- Write the script to `runs/<id>/workflow-<n>.js` before presenting the
  manifest; name the path in the header line so the user can inspect it.
- Only native-provider models can run inside a workflow. Another provider
  on a `workflow` stage is a compose error before GO.
- Gates split the script into segments. `on_fail: ask` returns
  `status: "ask"` from the script and the orchestrator takes over.
- Tokens: as reported by the workflow run, if any.

## external

Run a shell command from the provider catalog.

- Take `providers.<provider>.invoke.external`. Substitute `{{model}}` and
  `{{effort}}` (via the provider's `effort_map`).
- Pass the built prompt on stdin. Capture stdout as the stage output.
- Non-zero exit is a stage error, distinct from a check failure. Log the
  exit code and the last lines of stderr, then apply `on_fail`.
- If the command is `null` for that provider, compose fails before GO.
- Tokens: parse them if the CLI prints usage; otherwise `null`.

Write-capable external agents (for example `codex exec`) edit the working
tree directly. Run `git status --short` before and after to derive the
diff summary for the log.

## Check evaluation

| kind | pass condition |
|------|----------------|
| `command` | exit code 0. Run from repo root. Timeout 10 minutes. |
| `review` | first non-empty line of the stage output is `VERDICT: PASS`. |
| `none` | always pass. |

Store the shortest decisive check output in the log, not the full stream.

## Artifacts

Stage outputs go to `runs/<id>/artifacts/<output-name>.md`. Later stages
receive them inline in the prompt under a heading per input name. If an
artifact is larger than about 400 lines, pass the file path instead and
tell the worker to read it.
