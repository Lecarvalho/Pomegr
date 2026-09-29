# ACOS adapters for Claude Code

How each `adapter` value runs a stage when the orchestrator is a Claude Code
session. Every adapter takes a stage definition plus a built prompt, and
returns text (the stage output) plus, when available, token counts.

## inline

The orchestrator does the work itself in the current session.

- Use the session's own tools (read, edit, run commands).
- No `provider`, `tier`, `model` or `effort`: the session's are fixed.
  How deeply the stage works belongs in the block prompt.
- Tokens: not reported by the harness. Leave `tokens` out of the stage
  record; do not estimate.
- Escalation on an inline stage always delegates, even to the session's
  own tier: run the retry as a `subagent` (see `execute.md`).

Best for: nearly everything. Plan, implement, verify, and review of small
changes. This is the default adapter.

## subagent

Spawn one agent with the Agent tool.

- `subagent_type`: `general-purpose` for implement, `Explore` for explore,
  `Plan` for plan, `general-purpose` for review. Use a project-defined
  agent type instead if `config.yaml` names one under `agents.<block>`.
- `model`: pass the stage tier's alias from `catalog/providers.yaml`
  (`opus`, `sonnet`, `haiku`) through the Agent tool `model` field when
  the harness accepts it, never the manifest's concrete id. Log the id
  that actually ran if the result reports it, otherwise the manifest's.
- `effort`: state it in the prompt as a one-line instruction, e.g.
  "Effort: low. Minimal exploration, terse report." On `inherit` write
  no effort line: the agent runs at the harness default.
- The prompt must be self-contained: the agent has no conversation
  context. Include intent, scope notes, inputs, and the block prompt.
- Ask the agent to end with a clear final report; that report is the stage
  output.
- Tokens: log the total the Agent tool result reports, if any. Never an
  estimate.
- Each spawn counts against `limits.agents`. A retry is a new spawn.

Parallel stages: consecutive `subagent` stages that share no
inputs/outputs dependency and whose `owns` are disjoint are spawned in
one message and awaited together. Log them separately, each with its own
`started` and `ended`. Never use a `fork` agent for a fan-out slice: it
inherits the whole conversation, which is the cost the fan-out exists to
avoid. A fresh `general-purpose` agent with a self-contained brief is the
right shape.

Fan-out brief: an implementer receives its own `## <stage name>` section
of `artifacts/plan.md`, its `owns` list, the intent, the scope notes and
the verify command. Not the other sections. Its report ends with the
capture lines for its slice when the slice is visible; collect those from
every implementer into the evidence stage's prompt.

Background stages: an `evidence` stage is spawned with
`run_in_background` and awaited after the handoff is written. Its report
comes back as text only; the crops stay on disk. Open a crop yourself
only when the verdict names it.

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

- Take `providers.<provider>.invoke.external`. Substitute `{{alias}}`
  with the stage tier's alias and `{{effort}}` through the provider's
  `effort_map`. An empty value (unmapped tier, `inherit`) drops the
  whole argument holding it and the flag in front of it, so the CLI
  runs at its own default.
- Pass the built prompt on stdin. Capture stdout as the stage output.
- Non-zero exit is a stage error, distinct from a check failure. Log the
  exit code and the last lines of stderr, then apply `on_fail`.
- If the command is `null` for that provider, compose fails before GO.
- Tokens: parse them if the CLI prints usage; otherwise leave them out.

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

A stage output goes to `runs/<id>/artifacts/<output-name>.md` only when
another context reads it (`execute.md`, Each stage, step 4). A delegated stage
receives its inputs inline in the prompt under a heading per input name.
If an input is larger than about 400 lines, pass the file path instead
and tell the worker to read it.
