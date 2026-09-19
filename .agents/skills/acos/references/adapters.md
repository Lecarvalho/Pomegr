# ACOS adapters for Claude Code and Codex

The runner resolves the active harness profile before selecting an adapter.
Every adapter takes a stage definition plus a built prompt and returns stage
output plus token counts only when the harness reports them. A native adapter
is legal only when its resolved provider equals the active profile provider
and the provider catalog names the active harness as its `native_harness`.
Cross-provider stages always use `external`; they are never routed through a
native adapter.

## inline

The orchestrator does the work itself in the current session.

- Use the session's own tools (read, edit, run commands).
- `provider`, `model` and `effort` are absent. The stage runs on the session's
  model at the session's
  reasoning effort, both fixed for the session's whole life: a manifest
  cannot raise effort for one stage and lower it for the next, and a
  summary that shows it is describing something no runner can do. How
  deeply the stage works belongs in the block prompt, not in an effort
  field.
- The session's startup load (`harnesses.<active>.startup.orchestrator`) was
  spent before the first stage began. It belongs in the estimate, not in
  the stage record.
- Tokens: not reported by the harness. Leave `tokens` out of the stage
  record; do not estimate.
- Escalation on an inline stage always delegates: run the retry as a
  `subagent` on the `escalation` entry's model and effort — even when it
  names the session model, since the session cannot raise its own
  effort — count it against `limits.agents`, and log the iteration with
  `adapter: subagent`.

Best for: nearly everything. Plan, implement, verify, and review of small
changes. This is the default adapter.

## subagent

Every worker gets a self-contained prompt with intent, scope notes, inputs,
and its block prompt, and ends with a clear final report. Its fresh startup
comes from `harnesses.<active>.startup.subagent`; every spawn (including a
retry) counts against `limits.agents`. Log tokens only when reported and log
the actual model when the harness exposes it.

### Claude Code

Spawn one agent with the Agent tool. Keep Claude's native aliases and behavior:

- Use `general-purpose` for implement/review, `Explore` for explore, and
  `Plan` for plan, unless `.acos.yaml` defines `agents.<block>`.
- Pass the stage model through Agent's `model` field when accepted, using
  `claude-opus-5` → `opus`, `claude-sonnet-5` → `sonnet`, and
  `claude-haiku-4-5` → `haiku`.
- State effort as a concise prompt instruction because the Agent tool has no
  native effort field. If the harness reports a different model, log that one.

### Codex

Spawn one fresh native worker with `spawn_agent`, always using
`fork_turns: "none"`; never inherit the orchestrator conversation or use a
forked agent for a fan-out slice. Pass the stage `model` and `reasoning_effort`
through the native spawn fields, not by describing them only in the prompt.
Await completion through the collaboration wait mechanism, retaining the
worker's final report as stage output. When the spawn/final result exposes the
model actually used, log it; otherwise leave the actual-model field absent.

Parallel stages: consecutive Codex `subagent` stages with no input/output
dependency and disjoint `owns` lists are spawned before waiting, then awaited
through the collaboration wait mechanism. Claude may likewise start its
independent Agent-tool workers together and await each result. Log each stage
with its own start and end time.

Fan-out brief: an implementer receives its own `## <stage name>` section
of `artifacts/plan.md`, its `owns` list, the intent, the scope notes and
the verify command. Not the other sections. Its report ends with the
capture lines for its slice when the slice is visible; collect those from
every implementer into the evidence stage's prompt.

Background stages: Claude may spawn an `evidence` Agent with
`run_in_background`; Codex spawns it first, writes the handoff, and then
awaits it through the collaboration wait mechanism. Its report comes back as
text only; the crops stay on disk. Open a crop yourself only when the verdict
names it.

## workflow (Claude Code only)

Compile the stage (or a run of consecutive `workflow` stages) into a Claude
Code Workflow tool script. Full rules and a template: `workflow.md` in this
folder. Load the `workflow-authoring` skill before writing the script. Codex
has no Workflow adapter: compose equivalent independent native `subagent`
stages instead, or reject an existing manifest that requests Workflow.

- Opt-in: the GO reply on a manifest that shows `adapter: workflow` is the
  user's explicit request for a workflow. Never move a stage to
  `workflow` after GO.
- Write the script to `runs/<id>/workflow-<n>.js` before presenting the
  manifest; name the path in the header line so the user can inspect it.
- Only Claude's Anthropic native provider can run inside a workflow. Another
  provider or the Codex harness on a `workflow` stage is a compose error before GO.
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
another context reads it (SKILL.md section 5, step 2d). A delegated stage
receives its inputs inline in the prompt under a heading per input name.
If an input is larger than about 400 lines, pass the file path instead
and tell the worker to read it.
