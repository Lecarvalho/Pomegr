# ACOS adapters

How each `adapter` value runs a stage. Every adapter takes a stage
definition plus a built prompt, and returns text (the stage output) plus,
when available, token counts.

## Which adapter a provider allows

Your harness is the one this session runs in (Claude Code, Codex). In
`catalog/providers.yaml` each provider names its `harness` and, under
`invoke`, what each adapter resolves to.

- **Your harness's provider** (its `harness` is yours): `native`
  adapters run inside this session. `external` is not available: a
  shell call to your own harness's CLI (`claude -p`, `codex exec`)
  opens a second session that pays startup again and reports nothing
  back. Delegate with `subagent`.
- **Any other provider**: only `external`. Its `native` entries describe
  its own harness, not yours.
- `null`, or an adapter the rules above exclude: compose error before GO.

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

Spawn one agent with your harness's own subagent tool, inside this
session: the Agent tool in Claude Code, the agent-spawning tool in Codex.
Never through a shell command.

- Agent type, Claude Code: `subagent_type` `general-purpose` for
  implement, `Explore` for explore, `Plan` for plan, `general-purpose`
  for review. Use a project-defined agent type instead if `config.yaml`
  names one under `agents.<block>`. A harness without agent types
  spawns its plain worker.
- `model`: pass the stage tier's alias from `catalog/providers.yaml`
  through the spawn tool's model field when the harness accepts one,
  never the manifest's concrete id: the alias itself in Claude Code
  (`opus`, `sonnet`, `haiku`), the form the provider's `external`
  command spells in Codex (`gpt-6-<alias>`). No model field: the worker
  runs on the session's model; log that as drift when the tier differs.
  Log the id that actually ran if the result reports it, otherwise the
  manifest's.
- `effort`: state it in the prompt as a one-line instruction, e.g.
  "Effort: low. Minimal exploration, terse report." On `inherit` write
  no effort line: the agent runs at the harness default.
- The prompt must be self-contained: the agent has no conversation
  context. Include intent, scope notes, inputs, and the block prompt.
- An output another context reads (`execute.md`, Each stage, step 4) is
  written by the agent itself to `runs/<id>/artifacts/<output>.md`. Its
  final message stays short: status or verdict first, the artifact path,
  the decisive numbers. That message is the stage output; open the
  artifact only when the next step needs it, so its contents never pass
  through your context twice.
- Tokens: log the total the spawn tool's result reports, if any. Never
  an estimate.
- A retry is a new spawn, logged as its own stage record.

Artifact names: Claude Code's Write tool refuses a subagent's file whose
name reads as a report, in any folder, with "Subagents should return
findings as text, not write report files." Names containing `report`,
`summary`, `findings` or `analysis` are refused; names such as
`review`, `plan`, `notes`, `result`, `handoff`, `try-it` and
`design-contract` are accepted. Name outputs and artifacts after what
they hold (`result`, `notes`, `review`, `handoff`); a refused word is a
compose error (`manifest.md`). A product file in the stage's `owns`
that must keep such a name is written with a shell heredoc; nothing
else is.

Parallel stages: consecutive `subagent` stages that share no
inputs/outputs dependency and whose `owns` are disjoint are spawned in
one message and awaited together. Log them separately, each with its own
`started` and `ended`. Never use an agent that inherits the whole
conversation (Claude Code's `fork`) for a fan-out slice: that is the
cost the fan-out exists to avoid. A fresh agent with a self-contained
brief is the right shape.

Fan-out brief: an implementer receives its own `## <stage name>` section
of `artifacts/plan.md`, its `owns` list, the intent, the scope notes and
the verify command. Not the other sections. It is told that other
agents run at the same time, which makes `owns` its perimeter: free
inside, nothing written outside. No other worker opens its files, and
what it needs from a file it does not own arrives as a signature in
the brief. Its report ends with the
capture lines for its slice when the slice is visible; collect those from
every implementer into the evidence stage's prompt.

Background stages: an `evidence` stage is spawned in the background
where the harness can and awaited after the handoff is written. Its report
comes back as text only; the crops stay on disk. Open a crop yourself
only when the verdict names it.

## workflow

Claude Code only. Compile the stage (or a run of consecutive `workflow`
stages) into a Workflow tool script. Full rules and a template:
`workflow.md` in this folder. Load the `workflow-authoring` skill before
writing the script.

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

Run a shell command from the provider catalog, for a provider other than
your harness's own.

- Take `providers.<provider>.invoke.external`. Substitute `{{alias}}`
  with the stage tier's alias and `{{effort}}` through the provider's
  `effort_map`. An empty value (unmapped tier, `inherit`) drops the
  whole argument holding it and the flag in front of it, so the CLI
  runs at its own default.
- Pass the built prompt on stdin. Capture stdout as the stage output.
- Non-zero exit is a stage error, distinct from a check failure. Log the
  exit code and the last lines of stderr, then apply `on_fail`.
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
