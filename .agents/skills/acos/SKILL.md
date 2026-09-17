---
name: acos
description: Size a task against the project's session limits, compose an ACOS run manifest (or a plan of manifests, one per session), show it, wait for GO, then execute it without further interruptions and record what actually ran. Use when the user invokes /acos, asks to "run this through acos", or the project has a .acos.yaml and the user asks for a non-trivial code change.
---

# ACOS runner

You are the **orchestrator**. Before any token is spent on the task, you
size it, compose a run manifest, show it, and wait for GO. A task too big
for one session becomes a plan: several manifests, each sized for its own
session. Then you do the work, mostly yourself, without stopping for
re-approval. At the end you write down what actually ran.

Full semantics: `SPEC.md` in the ACOS folder. This file is the operating
procedure. Adapter details: `references/adapters.md`. Workflow compilation:
`references/workflow.md`.

## 0. Locate the catalog

Look, in order, for:

1. `acos/` in the repo root (imported copy: `catalog/`, `presets/`,
   optional `calibration.md`)
2. `.claude/skills/acos/catalog/` and `.claude/skills/acos/presets/` (bundled copy)

Read `.acos.yaml` from the repo root if present. If the catalog is missing,
tell the user ACOS is not installed here and point at `install.md`. Stop.
If the catalog exists but `.acos.yaml` does not, run **init** (section 7)
first, then continue.

## Subcommands

| Invocation | Action |
|------------|--------|
| `/acos <task>` | Size, compose, present, GO, execute, report. Sections 1 to 6. A task that does not fit becomes a plan; see section 2. |
| `/acos plan <task>` | Size and compose only. Nothing executes. Big task: agree the cut, write the plan, stop. Small task: say so, write one manifest, stop. Section 2. |
| `/acos run <path> [n]` | Execute an existing manifest: a manifest file, a run dir, or a plan dir plus part index (default: the first part not `done`). Show it, GO, execute. Section 4 onward. |
| `/acos init` | Derive `.acos.yaml` from the repo. Section 7. |
| `/acos calibrate` | Read past runs, write `acos/calibration.md`. Section 8. Run it in its own session. |
| `/acos save-preset <name>` | Save the last executed manifest's stage shape as `acos/presets/<name>.yaml`. Section 9. |
| `/acos show` | Print the last manifest for this session, or the newest under `runs/`. |

## Economy rules

These decide most of the manifest. Apply them before anything else.

- **Default adapter is `inline`.** You do the work. Delegate a stage only
  when one of these is true: it needs a judgement independent of yours
  (review), two or more pieces are independent and worth running in
  parallel, or a large read would bloat your context more than the
  delegation round trip costs.
- **Never more agents than the work has independent parts.** Three files
  do not need ten subagents. `limits.agents` caps it; the default when
  absent is 3.
- **Fewest stages.** `implement` alone is a complete manifest for a change
  you understand. Add `plan` when the design is not obvious, `review`
  when the change is risky or public, `explore` only when neither you nor
  `calibration.md` knows the area.
- **Effort matches the stage**, not the task. Planning high, mechanical
  implementation medium, checks low.
- **Workflow adapter is rare.** Three or more independent parallel stages,
  and the user has seen `adapter: workflow` in the manifest before GO.
- **Orchestrator context is the scarce resource.** Default ceiling when
  `limits.orchestrator_tokens` is absent: 100000.

## 1. Understand intent

Restate the user's request in one or two sentences. That is the `intent`
field. If the request is ambiguous in a way that changes the manifest
(for example, "add tests" versus "fix the failing tests"), ask **one**
question, then continue. Do not ask about anything the manifest itself
will make visible.

## 2. Size the task

Read `acos/calibration.md` if present. Using it, the scope the user gave,
and the number of files you expect to touch, estimate the whole intent:
stages, agents, orchestrator tokens, worker tokens. Compare with `limits`
from `.acos.yaml` (or the defaults above).

- Fits: one manifest. With `/acos plan`, say in one line that it fits a
  single run and no plan is needed, then compose the manifest (section
  3), present it (section 4) and stop without executing. Without
  `/acos plan`, compose and present as usual.
- Does not fit: break the intent into **parts**. Each part is a manifest
  that fits the limits on its own and leaves the tree in a working state
  (tests pass, nothing half-wired). Cut along natural seams: a layer, a
  module, a user-visible step.

**Confirm the cut before writing anything.** Very short:

```
Too big for one session (~<tokens> vs <limit>). Proposed cut, <n> parts:
  1. <what>   ~<tokens>
  2. <what>   ~<tokens>
  3. <what>   ~<tokens>
OK to write the plan, or change the cut?
```

Wait. Apply what the user says (merge, split, reorder, drop). Only then
compose every part's manifest (section 3, once per part), with
`part.plan`, `index`, `of`, and `assumes` stating what earlier parts
leave behind, and write the plan:

```
runs/<plan-id>/plan.yaml
runs/<plan-id>/<index>-<slug>/manifest.yaml     one per part
```

`plan.yaml` shape is in `SPEC.md` section 8: intent, limits, one entry
per part (index, dir, summary, estimate, status `planned`), total
estimate with `sessions: <n>`. Then present the plan, not the manifests:

```
ACOS plan: <plan-id>   Parts: <n>   Sessions: <n>
Total: ~<orchestrator tokens> orchestrator, ~<worker tokens> workers, <agents> agents
  1. <slug>   <stages>   ~<tokens>   <one-line summary>
  2. <slug>   ...
Manifests: runs/<plan-id>/<index>-<slug>/manifest.yaml
Next: /acos run runs/<plan-id> 1   (fresh session recommended | can run here now)
```

Then stop. Do not print any manifest. The files are on disk; say so.
Say in one line whether you recommend running part 1 in this session or
a fresh one: this session if the plan was cheap to make and part 1 is
small, a fresh one if sizing took wide exploration or the conversation
is already long. The user decides. If they say GO here, run part 1
(section 4 onward) in this session.

The user can attach the manifests to a work item and run them any time.
Each must therefore be complete on its own: intent, scope, stages,
`assumes`, nothing that depends on this conversation.

## 3. Compose the manifest

1. Pick a starting shape, in this order: a preset the user named,
   `calibration.md` Shape guidance for this kind of task, `.acos.yaml`
   `preset`, otherwise ad hoc from blocks per the economy rules. Leave
   `preset` out when ad hoc.
2. For each stage, merge in this order, later wins: block defaults,
   preset stage entry, project defaults for missing provider/model,
   calibration adjustments, user overrides given in the request.
3. Substitute every `{{ project.* }}` placeholder from `.acos.yaml`. A
   placeholder with no value is a compose error: say which one and stop.
4. Generate `id`: `YYYY-MM-DD-<short-slug-of-intent>`.
5. Fill `scope` only if the user gave hints or it is obvious. Otherwise omit.
6. Estimate: `orchestrator_tokens`, `worker_tokens`, `agents`, tokens per
   stage. Use `calibration.md` Cost figures when present, otherwise guess
   from scope size. Write `basis` saying which. Add `cost` only if the
   catalog has prices for the chosen models.
7. Copy `limits` from `.acos.yaml`; apply any per-run override the user
   gave in sizing.
8. If any stage has `adapter: workflow`, compile the script(s) now per
   `references/workflow.md` and write them under `runs/<id>/`. They are
   part of what the user approves at GO.

Validate the result mentally against `schema/acos.schema.json`: required
fields present, enums valid, stage names unique, every `inputs` entry
produced by an earlier stage, estimate within limits.

## 4. Present and wait for GO

For `/acos run`, first read the manifest. If it has `part.assumes`, check
the tree matches (files exist, verify passes if it says so) and say so in
one line; a mismatch is a question, not a blocker. If `plan.yaml` marks
an earlier part as not `done`, say so.

Write `manifest.yaml` to its run directory first. Then print a summary,
not the file:

```
ACOS run: <id>                      (Part <i> of <n>, plan <plan-id>   when in a plan)
Intent: <one line>
Stages: <n>   Agents: <k>/<limit>   Orchestrator: ~<tokens>/<limit>   Workers: ~<tokens>
  1. <name>   <adapter>   <model or "session">   <effort>   check: <kind>   ~<tokens>
  2. <name>   ...
Manifest: runs/<id>/manifest.yaml
Workflow script: runs/<id>/workflow-1.js        (only if compiled)
Reply GO to execute, or tell me what to change.
```

Then stop. Do not start any stage. Do not spawn any agent. Do not read
files beyond what sizing and composing needed.

Print the full YAML only if the user asks for it. Scope, prompts, loop
rules and escalation live in the file; the summary must fit on one
screen. Same for every other output of this skill: short sentences on
the terminal, contents in files, and a path the user can open.

If this session already carries a lot of context (a long conversation
before `/acos`, wide exploration while sizing), add one line recommending
`/acos run <path>` in a fresh session instead of GO here. Judgement, not
a rule.

If the user asks for changes, produce a new manifest and present again.
If `.acos.yaml` sets `gates.go: auto`, say so in the header line and
proceed without waiting. Presets cannot set this.

## 5. Execute

On GO:

1. `manifest.yaml` is already in the run directory (written at present,
   rewritten if the user asked for changes before GO). From GO on, never
   edit it. Start `log.yaml` next to it with the manifest id, a start
   timestamp, and an empty `drift: []` list.
2. For each stage in order:
   a. If `gate: true` or `gates.per_stage: true`, show the stage and ask
      to continue.
   b. Build the worker prompt: block `prompt` + stage `prompt` + intent +
      scope notes + the content of every named `inputs` artifact. For
      `inline`, the prompt is your own instruction; do not paste it
      anywhere.
   c. Run it through the stage's adapter (see `references/adapters.md`).
   d. Store the result as the stage's `outputs` artifact(s) in
      `runs/<id>/artifacts/<name>.md`. For inline stages a few lines is
      enough: what changed, verify result.
   e. Run the `check`. `command`: run it, exit 0 is pass. `review`: the
      stage output's first line must be `VERDICT: PASS`. `none`: pass.
   f. Append a stage record to `log.yaml`: name, iteration, adapter,
      provider, model, effort, started, ended, tokens if the adapter
      reports them (else your estimate, marked `estimated: true`), check
      outcome, and the shortest decisive check output.
   g. On fail, apply `on_fail` (stage value, else `loop.on_fail`):
      - `retry`: rerun the stage with the check output appended to the
        prompt. Stop after `max_iterations` (stage, else loop, else 3).
      - `escalate`: same as retry, but take the next `escalation` entry
        for provider/model/effort. When the list is exhausted, keep the
        last one and behave as `retry`. Log the model actually used.
      - `ask`: show the check output and ask the user: retry, skip, stop.
      - `stop`: end the run as failed.
3. **Drift.** When the plan turns out wrong, change course and keep going.
   Drop a stage you no longer need, add one you do, swap a model or
   effort, fix a check command. Append to `drift` in `log.yaml`:

```yaml
- at_stage: implement
  change: "stages[review]: dropped"
  reason: "three-line change, reviewed inline"
```

   Do not ask for approval. Do not write a new manifest. The only
   mid-run questions are an `on_fail: ask` failure and a gate. Limits
   are not checked mid-run: you cannot measure your own token use, so
   keep going and let `calibrate` judge it afterwards from `estimate`
   versus `actual`. Retries and escalation within the rules are not
   drift; they are just log records.

## 6. Report and executed manifest

1. Write `manifest.executed.yaml` next to `manifest.yaml`: the planned
   manifest with `stages` as they actually ran (dropped stages removed,
   added stages inserted, models and efforts as used), an `actual` block
   with the same shape as `estimate` (tokens estimated when not reported,
   say so in `basis`), and the `drift` list from the log.
2. If the manifest is a part, set its `status` in `plan.yaml` to `done`
   or `failed`, and add `actual` next to its `estimate` there.
3. End with a short report:

- run id, outcome (success / failed at stage X / stopped by user)
- one line per stage: name, iterations, model actually used, check result
- drift, one line each, if any
- actual tokens and agents next to the estimate, marked estimated when
  the harness did not report them
- when in a plan: parts done / total, and the exact next command
  (`/acos run runs/<plan-id> <i+1>`), or "plan complete"
- files changed, from `git status --short` or a diff summary
- pointer to the run directory

## 7. Init: derive `.acos.yaml`

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
5. Set `gates.go: required`. Set `limits` to the defaults
   (`orchestrator_tokens: 100000`, `worker_tokens: 300000`, `agents: 3`,
   `stages: 5`) unless the user gave others.
6. Write it and say what was chosen and why, one line per field. Ask
   for confirmation only if the verify command is a guess (nothing in
   the repo named it); then show just that line.

Never overwrite an existing `.acos.yaml` without asking.

## 8. Calibrate: learn from past runs

Run this in its own session, not during a task. Goal: make the next
sizing and compose more accurate for this repo.

1. Collect every `runs/*/` that has `manifest.yaml`. Read, per run:
   `manifest.yaml`, `manifest.executed.yaml` if present, `log.yaml`.
   A run without an executed manifest counts as planned only; use its
   log for what ran.
2. For each run, derive: intent size (files touched, from the log or
   `git` if the artifacts say), planned versus executed stages (added,
   dropped, re-ordered), models and efforts planned versus used,
   iterations per stage, adapters used and agent count, tokens estimated
   versus actual where present, runs whose actual exceeded a limit.
   Plans count too: each part directory is a run; note how many parts
   plans had, and whether parts turned out too big or too small.
3. Look for patterns across runs, not per run: which stages get dropped,
   which get added, which checks get changed the same way, how far
   estimates miss, what task shape tends to need which stages.
4. Write `acos/calibration.md` in the fixed shape from `SPEC.md`
   section 7: header line with run count, date range and today's date;
   sections **Shape**, **Cost**, **Recurring drift**, **Notes**. Under
   40 lines. Overwrite the previous file; if it had a **Notes** section,
   keep entries that are still true. Each Recurring drift line that
   points at a config fix (verify command, a block default, a limit)
   should name the file to change.
5. Say where the file is, give one line per section, and stop. Do not
   change `.acos.yaml`, blocks or presets; suggest those changes in
   **Recurring drift** and let the user decide.

Refuse politely if fewer than two runs exist: say so and stop.

## 9. Save-preset: promote a manifest shape

Take the last executed manifest from this session (or
`runs/<newest>/manifest.executed.yaml`, falling back to `manifest.yaml`).
Strip run-specific fields: `id`, `intent`, `part`, `scope`, `estimate`,
`actual`, `drift`, `outputs`. Replace concrete model ids with the matching
`{{ project.models.<tier> }}` placeholder when they equal a tier in
`.acos.yaml`, and the verify command with `{{ project.verify }}`. Keep
adapters, efforts, checks, on_fail, escalation, loop and gates. Add `name`
and a one-line `description` derived from the intent. Write to
`acos/presets/<name>.yaml`. Say the path and the stage list in one line.

Refuse to overwrite an existing preset without asking.

## Rules

- The GO gate is not optional. Only `.acos.yaml` can set it to `auto`.
- After GO, no re-approval. Adjust, log drift, continue. Ask only on
  `on_fail: ask` or a gate.
- Limits and estimates act at compose time only. Nothing checks them
  mid-run; `calibrate` does that afterwards.
- Scope is advisory. Warn once if a worker writes outside `scope.include`.
- Workers do not commit. The user decides.
- One clarifying question at most before sizing. A plan is presented, not
  negotiated stage by stage; the user edits the cut by asking.
- A manifest must run correctly in a session that has never seen this
  conversation. Everything it needs is in the file.
