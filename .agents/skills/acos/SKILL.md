---
name: acos
description: Compose an ACOS run manifest from the project's block catalog, show it, wait for GO, then execute it stage by stage. Use when the user invokes /acos, asks to "run this through acos", or the project has a .acos.yaml and the user asks for a non-trivial code change.
---

# ACOS runner

You are the **orchestrator**. Before any worker spends tokens on the task,
you compose a run manifest, show it, and wait for GO. Then you execute it.

Full semantics: `SPEC.md` in the ACOS folder. This file is the operating
procedure. Adapter details: `references/adapters.md`. Workflow compilation:
`references/workflow.md`.

## 0. Locate the catalog

Look, in order, for:

1. `acos/` in the repo root (imported copy: `catalog/`, `presets/`)
2. `.agents/skills/acos/catalog/` and `.agents/skills/acos/presets/` (bundled copy)

Read `.acos.yaml` from the repo root if present. If the catalog is missing,
tell the user ACOS is not installed here and point at `install.md`. Stop.
If the catalog exists but `.acos.yaml` does not, run **init** (below)
first, then continue.

## Subcommands

| Invocation | Action |
|------------|--------|
| `/acos <task>` | Compose, present, GO, execute. Sections 1 to 5. |
| `/acos init` | Derive `.acos.yaml` from the repo. Section 6. |
| `/acos save-preset <name>` | Save the last presented or executed manifest's stage shape as `acos/presets/<name>.yaml`. Section 7. |
| `/acos show` | Print the last manifest for this session, or the newest under `runs/`. |
| `/acos amend <change>` | Change the running manifest's rules mid-run. Section 8. Also triggered by any in-flight request that changes a rule. |

## 1. Understand intent

Restate the user's request in one or two sentences. That is the `intent`
field. If the request is ambiguous in a way that changes the manifest
(for example, "add tests" versus "fix the failing tests"), ask **one**
question, then continue. Do not ask about anything the manifest itself
will make visible.

## 2. Compose the manifest

1. Pick a starting shape:
   - user named a preset: use it
   - `.acos.yaml` has `preset`: use it
   - otherwise compose **ad hoc** from blocks: `implement` alone for
     changes you expect to touch one or two files; `explore`, `plan`,
     `implement`, `review` for anything larger or unclear. Leave the
     manifest `preset` field out. Presets are a convenience, not a
     requirement.
2. Load the preset. For each stage, merge in this order, later wins:
   block defaults, preset stage entry, project defaults for missing
   provider/model, user overrides given in the request.
3. Substitute every `{{ project.* }}` placeholder from `.acos.yaml`. A
   placeholder with no value is a compose error: say which one and stop.
4. Generate `id`: `YYYY-MM-DD-<short-slug-of-intent>`.
5. Fill `scope` only if the user gave hints or it is obvious. Otherwise omit.
6. Estimate, if the catalog has prices for the chosen models: guess tokens
   per stage from the size of the task, multiply by the price table, and
   write `estimate.basis`. Mark it rough. Skip entirely if no prices.
7. Copy `budget` from `.acos.yaml` if present. Budget never stops a run.
8. If any stage has `adapter: workflow`, compile the script(s) now per
   `references/workflow.md` and write them under `runs/<id>/`. They are
   part of what the user approves at GO.

Validate the result mentally against `schema/acos.schema.json`: required
fields present, enums valid, stage names unique, every `inputs` entry
produced by an earlier stage.

## 3. Present and wait for GO

Print the manifest as a YAML block, in full. Above it, three lines:

```
ACOS run: <id>
Preset: <preset or "ad hoc">   Stages: <n>   Estimate: <cost or "none">
Workflow script: runs/<id>/workflow-1.js        (only if compiled)
Reply GO to execute, or tell me what to change.
```

Then stop. Do not start any stage. Do not spawn any agent. Do not read
files beyond what composing needed.

If the user asks for changes, produce a new manifest and present again.
If `.acos.yaml` sets `gates.go: auto`, say so in the header line and
proceed without waiting. Presets cannot set this.

## 4. Execute

On GO:

1. Create `runs/<id>/`. Write `manifest.yaml` there. Start `log.yaml` with
   the manifest id and a start timestamp.
2. For each stage in order:
   a. If `gate: true` or `gates.per_stage: true`, show the stage and ask
      to continue.
   b. Build the worker prompt: block `prompt` + stage `prompt` + intent +
      scope notes + the content of every named `inputs` artifact.
   c. Run it through the stage's adapter (see `references/adapters.md`).
   d. Store the result as the stage's `outputs` artifact(s) in
      `runs/<id>/artifacts/<name>.md`.
   e. Run the `check`. `command`: run it, exit 0 is pass. `review`: the
      stage output's first line must be `VERDICT: PASS`. `none`: pass.
   f. Append a stage record to `log.yaml`: name, iteration, revision,
      adapter, provider, model, effort, started, ended, tokens if the
      adapter reports them, check outcome, and the shortest decisive
      check output.
   g. On fail, apply `on_fail` (stage value, else `loop.on_fail`):
      - `retry`: rerun the stage with the check output appended to the
        prompt. Stop after `max_iterations` (stage, else loop, else 3).
      - `escalate`: same as retry, but take the next `escalation` entry
        for provider/model/effort. When the list is exhausted, keep the
        last one and behave as `retry`. Log the model actually used.
      - `ask`: show the check output and ask the user: retry, skip, stop.
      - `stop`: end the run as failed.
3. Never edit `manifest.yaml` in place. Rule changes go through an
   amendment (section 8). Outcomes the rules allow go in the log.

## 5. Report

End with a short report:

- run id, final revision, outcome (success / failed at stage X / stopped by user)
- amendments, one line each, if any
- one line per stage: name, iterations, model actually used, check result
- actual tokens or cost if any adapter reported them, next to the
  estimate; if the budget ceiling was crossed, say so
- files changed, from `git status --short` or a diff summary
- pointer to `runs/<id>/`

## 6. Init: derive `.acos.yaml`

Goal: write a correct `.acos.yaml` without the user editing a template.

1. Find the verify command. Look, in order, at: `package.json` scripts
   (`test`, `check`, `verify`, `lint`), `Makefile` targets, `pyproject.toml`
   / `tox.ini` / `pytest.ini`, `Cargo.toml`, `go.mod`, `build.gradle`,
   `*.csproj`, CLAUDE.md or README instructions. Prefer the command the
   repo's own docs tell contributors to run. If several, chain them with
   `&&` in the order lint, build, test.
2. Detect reachable providers. Run `which`/`Get-Command` for `claude`,
   `codex`, `gemini`, `ollama`. Keep only providers whose CLI exists, plus
   the harness's native provider.
3. Fill model tiers from `catalog/providers.yaml` for the native provider:
   `fast` = tier fast, `balanced` = tier balanced, `strong` = tier strong.
4. Pick `preset`: leave unset. Ad hoc composition is the default until
   the user saves one.
5. Set `gates.go: required`. Omit `budget` unless the user asked for one.
6. Show the file. Ask for confirmation only if the verify command is a
   guess (nothing in the repo named it). Otherwise write it and say what
   was chosen and why, one line per field.

Never overwrite an existing `.acos.yaml` without asking.

## 7. Save-preset: promote a manifest shape

Take the last manifest from this session (or `runs/<newest>/manifest.yaml`).
Strip run-specific fields: `id`, `intent`, `scope`, `estimate`, `outputs`.
Replace concrete model ids with the matching `{{ project.models.<tier> }}`
placeholder when they equal a tier in `.acos.yaml`, and the verify command
with `{{ project.verify }}`. Keep adapters, efforts, checks, on_fail,
escalation, loop and gates. Add `name` and a one-line `description`
derived from the intent. Write to `acos/presets/<name>.yaml`. Show it.

Refuse to overwrite an existing preset without asking.

## 8. Amend: change the rules mid-run

Trigger: the user asks for something during execution that the current
manifest does not allow (add or drop a stage, swap a model or effort,
raise `max_iterations`, change a check, change `on_fail`), or you can see
the current rules will not reach the intent. Do not silently comply and
do not silently improvise. Amend.

1. Compose the new manifest: copy the current one, apply the change,
   increment `revision`. Completed stages stay as they were.
2. Write the full new manifest to `runs/<id>/manifest.r<N+1>.pending.yaml`.
   Show only the diff: one line per changed field, `path: old -> new`.
   Added stages show as `stages[<name>]: (added) adapter/model/effort`.
   Do not paste the full manifest. Header:

```
ACOS amendment: <id> r<N> -> r<N+1>   at stage: <current stage>
Proposed by: user | orchestrator   Reason: <one line>
Full manifest: runs/<id>/manifest.r<N+1>.pending.yaml
Reply GO to continue under r<N+1>, or tell me what to change.
```

3. Wait for GO unless `gates.go: auto`.
4. On GO: rename `manifest.yaml` to `manifest.r<N>.yaml`, rename the
   pending file to `manifest.yaml`, append to `amendments.yaml`:

```yaml
- revision: <N+1>
  at_stage: <name>
  proposed_by: user | orchestrator
  reason: "<one line>"
  changes: "<field path: old -> new; ...>"
```

5. Resume at the current stage. If the current stage's check or model
   changed, restart that stage's iteration count.

Not an amendment: retry, escalation, and the user answering an `ask`
with retry / skip / stop. Those are outcomes the rules already allow and
go to the log only.

## Rules

- The GO gate is not optional. Only `.acos.yaml` can set it to `auto`.
- Budget and estimate are advisory. Never stop a run because of them.
- Scope is advisory. Warn once if a worker writes outside `scope.include`.
- Workers do not commit. The user decides.
- One clarifying question at most before presenting the manifest.
