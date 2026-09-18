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
| `/acos save-preset <name>` | Save the last run's stage shape, drift applied, as `acos/presets/<name>.yaml`. Section 9. |
| `/acos show` | Print the last manifest for this session, or the newest under `runs/`. |

## Economy rules

These decide most of the manifest. Apply them before anything else.

- **Default adapter is `inline`.** You do the work. Delegate a stage only
  when one of these is true: it needs a judgement independent of yours
  (review), two or more slices are disjoint and worth running in
  parallel (fan-out), it runs a script and looks at the result (evidence),
  or a large read would bloat your context more than the delegation round
  trip costs.
- **Delegating does not save tokens; it saves your context and time.** A
  subagent starts cold: it re-reads the repo docs and every file it
  touches, then runs the check itself. Budget 150k worker tokens for any
  subagent before it writes a line. What makes it pay: the worker runs on
  a cheaper tier, its context dies when it returns, and yours is re-sent
  every turn until the session ends. Never delegate to move spend out of
  the orchestrator budget; a single slice too big to implement inline is
  too big, cut it.
- **Tier by role.** You plan, brief, judge and hand off on the session
  model. Fan-out implementers run on `{{ project.models.balanced }}`.
  Evidence runs on `balanced` too: it must see the crops. Review runs on
  `strong`. A stage that is only a command runs no model. A preset or
  `.acos.yaml` may override any of these; `calibration.md` says when a
  tier is not holding up in this repo.
- **Plan and implement share one context, unless it is a fan-out.** For
  one slice: both inline, or both in the same subagent. For two or more
  disjoint slices: you plan once and write a brief per slice; each
  implementer reads only its brief and its slice. The second reading is
  paid at the balanced tier, in parallel, and never lands in your context.
- **Fan-out only where slices are real.** Two or more groups of files that
  share nothing, each about three files or more, each fitting the file and
  line limits alone. One group means inline. A file two groups both need
  is owned by exactly one slice or moved into a small part that runs
  first. `limits.agents` caps the slices.
- **Review once per plan, not once per part.** In a plan, parts carry no
  review stage unless the part is risky on its own (auth, data loss,
  public API); one review part near the end reads the whole diff.
- **Never more agents than the work has independent parts.** Three files
  do not need ten subagents. `limits.agents` caps it; the default when
  absent is 3.
- **Fewest stages.** `implement` alone is a complete manifest for a change
  you understand. Add `plan` when the design is not obvious, `review`
  when the change is risky or public, `explore` only when neither you nor
  `calibration.md` knows the area.
- **Evidence only where there is something to see.** Add `evidence` when
  the part changes a visible surface and `.acos.yaml` has `shot`. Without
  either, no capture stage and no try-it page. When it runs, it is a
  subagent that runs the captures, looks at every crop and captions it;
  the pixels never enter your context, and its verdict is a check the part
  must pass before it closes.
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

Size in things you can count, then derive tokens from them. Never the
other way round.

1. **Count.** Files the change creates or edits (tests included), lines
   changed, and deliverables (things the part must make true; each
   sentence of acceptance is one). Compare with `limits.files` (default
   8), `limits.lines` (default 400) and at most 5 deliverables. A part
   over any of these is too big, whatever the token guess says.
2. **Derive tokens.** Use `acos/calibration.md` Cost figures when
   present. Otherwise these floors, which are measured, not hopeful:
   - inline implement: 40k + 12k per file touched
   - any subagent: 150k + 15k per file it touches
   - review subagent: 200k
   - a review is expected to fail once: add one fix (half the implement
     cost) to every part that has a review stage
   Tokens mean what the harness reports for the whole agent, re-read
   context included. That is the number `actual` will hold, so it is the
   number to estimate.
3. **Learn from earlier parts.** When sizing or running a part of a plan
   whose `plan.yaml` has `actual` on earlier parts, scale by the mean
   actual/estimate ratio of those parts: tokens where `actual` has them,
   otherwise files and lines, then re-derive tokens from step 2. Say so
   in `basis`, and re-cut the part if the scaled figure breaks a limit.
4. **Distrust a guess that lands just under the limit.** If most parts
   estimate between 80% and 100% of a limit, you fitted the guesses to
   the limit. Recount from step 1 and cut further.
5. **Group the files into slices.** Put files that import, style or test
   each other in one group. Two or more groups that share no file, each
   about three files or more and each within the file and line limits,
   are slices of one fan-out part: one plan stage, one balanced-tier
   implement stage per slice, one verify. A shared file (a stylesheet
   every group edits, a types module) goes to one owner or becomes a
   small part that runs before the fan-out. Its tokens: your plan and
   briefs at the inline floor for the files you read, plus the subagent
   floor per slice as worker tokens, plus about 60k worker tokens for
   evidence when there is a visible surface. Your own reading of the
   results is small; say so in `basis`.
6. **Order the parts by what they build on.** Each part's `after` lists
   the parts it needs in the tree. Default is the part before it. A part
   in a subtree no other part touches waits only for the parts it truly
   needs; the presentation says which parts may run alongside which.

Compare with `limits` from `.acos.yaml` (or the defaults above).

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
Too big for one session (~<files> files, ~<tokens> vs <limit>). Proposed cut, <n> parts:
  1. <what>   ~<files> files   ~<tokens>
  2. <what>   ~<files> files   ~<tokens>
  3. <what>   ~<files> files   ~<tokens>
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
  2. <slug>   <stages>   ~<tokens>   <summary>   after 1
  3. <slug>   plan, implement x3 (balanced), verify, evidence   ~<tokens>   <summary>   after 1, alongside 2
Manifests: runs/<plan-id>/<index>-<slug>/manifest.yaml
Next: /acos run runs/<plan-id> 1   (fresh session recommended | can run here now)
```

`after` is printed only when it is not the part before; `alongside` names
parts that may run in a second session at the same time. Fan-out parts
show their slice count and tier.

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
6. Estimate: `files`, `lines`, `orchestrator_tokens`, `worker_tokens`,
   `agents`, tokens per stage, all from sizing (section 2). Write `basis`
   saying which figures came from `calibration.md`, which from the
   floors, and any ratio applied from earlier parts. Add `cost` only if the
   catalog has prices for the chosen models.
7. Copy `limits` from `.acos.yaml`; apply any per-run override the user
   gave in sizing.
8. If any stage has `adapter: workflow`, compile the script(s) now per
   `references/workflow.md` and write them under `runs/<id>/`. They are
   part of what the user approves at GO.

Validate the result mentally against `schema/acos.schema.json`: required
fields present, enums valid, stage names unique, every `inputs` entry
produced by an earlier stage, estimate within limits. Stages that will run
at the same time (consecutive delegated stages with no input/output
dependency) each carry `owns`, and no path appears in two of them; an
overlap is a compose error, fix the cut before presenting.

## 4. Present and wait for GO

For `/acos run`, first read the manifest. If it has `part.assumes`, check
the tree matches (files exist, verify passes if it says so) and say so in
one line; a mismatch is a question, not a blocker. If `plan.yaml` marks
a part named in `part.after` (default: the part before) as not `done`,
say so. Parts not in `after` may still be running elsewhere; that is
fine.

If earlier parts in `plan.yaml` have `actual`, re-size this part now
(section 2, step 3). When the scaled estimate breaks a limit, say so in
two lines and propose the split before the summary: run the first half
now, write the second half as a new part after it. The user may say GO
as is. This is compose time; after GO nothing is re-sized.

Write `manifest.yaml` to its run directory first. Then print a summary,
not the file:

```
ACOS run: <id>                      (Part <i> of <n>, plan <plan-id>   when in a plan)
Intent: <one line>
Stages: <n>   Agents: <k>/<limit>   Orchestrator: ~<tokens>/<limit>   Workers: ~<tokens>
  1. <name>   <adapter>   <model or "session">   <effort>   check: <kind>   ~<tokens>
  2. <name>   subagent   <model>   <effort>   check: <kind>   ~<tokens>   || owns <paths>
  3. <name>   subagent   <model>   <effort>   check: <kind>   ~<tokens>   || owns <paths>
  4. <name>   ...
Manifest: runs/<id>/manifest.yaml
Workflow script: runs/<id>/workflow-1.js        (only if compiled)
Reply GO to execute, or tell me what to change.
```

`||` marks stages that run at the same time as the one above them.

Then stop. Do not start any stage. Do not spawn any agent. Do not read
files beyond what sizing and composing needed. For `/acos run` of an
existing manifest, that means no catalog and no presets: the manifest is
complete, and the only reads before GO are `.acos.yaml`, `calibration.md`,
the manifest, `plan.yaml` and the previous part's handoff.

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
   edit it. Start `log.yaml` next to it (shape in `SPEC.md` 2.8) with the
   manifest id, `sessions` holding this session's id when the harness
   exposes one (Claude Code: `claude:` + `CLAUDE_CODE_SESSION_ID`; Codex:
   `codex:` + `CODEX_THREAD_ID`), a start timestamp, and an empty
   `drift: []` list.
2. For each stage in order:
   a. If `gate: true` or `gates.per_stage: true`, show the stage and ask
      to continue.
   b. Build the worker prompt: block `prompt` + stage `prompt` + intent +
      scope notes + the content of every named `inputs` artifact. For
      `inline`, the prompt is your own instruction; do not paste it
      anywhere. A fan-out implementer gets only its own section of the
      plan (the brief for its slice, headed by its stage name), its
      `owns` list, and the interfaces the brief names; not the whole plan
      and not the other slices.
   c. Run it through the stage's adapter (see `references/adapters.md`).
      Stages marked `||` at present are spawned in one message and
      awaited together; log each on its own. While an `evidence` stage
      runs, write the handoff; do not wait idle.
   d. Write the stage's `outputs` to `runs/<id>/artifacts/<name>.md`
      only when another context reads them: a later `subagent`,
      `workflow` or `external` stage takes them as input, a gate shows
      them, or a later part needs them. Between inline stages the output
      stays in your context: no plan file for your own implement, no
      diff file. `git diff` is the diff and the log holds the check.
   e. Run the `check`. `command`: run it, exit 0 is pass. `review`: the
      stage output's first line must be `VERDICT: PASS`. `none`: pass.
   f. Append a stage record to `log.yaml`: name, iteration, adapter,
      provider, model, effort, started, ended, tokens only if the adapter
      reports them (never an estimate), check outcome, and the shortest
      decisive check output.
   g. On fail, apply `on_fail` (stage value, else `loop.on_fail`):
      - `retry`: rerun the stage with the check output appended to the
        prompt. Stop after `max_iterations` (stage, else loop, else 3).
      - `escalate`: same as retry, but take the next `escalation` entry
        for provider/model/effort. When the list is exhausted, keep the
        last one and behave as `retry`. Log the model actually used.
      - `ask`: show the check output and ask the user: retry, skip, stop.
      - `stop`: end the run as failed.
      A failed `review` check is handled cheaply whatever `on_fail`
      says: fix the blockers inline (you hold the review text; add a
      regression test per blocker), rerun the command check, and record
      the rest as deferred findings. No fix subagent. No second review
      unless the user asks for one or a blocker was a design error; then
      resume the same reviewer with the blocker list only.
      A failed `evidence` check is handled the same way: the verdict
      names the crops that do not show their claim; fix inline, rerun
      the command check, then resume the same evidence agent with only
      those capture lines. A crop that still disagrees with its claim
      after that is a failed part, not a deferred finding.
      A fan-out implementer that fails its check after `max_iterations`
      is finished inline by you: read its report and `git diff` of its
      `owns`, not its files from scratch. Log it as drift.
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

## 6. Close the run

There is no executed manifest. `manifest.yaml` plus `log.yaml` is the
record.

1. Append to `log.yaml`: `ended`, `outcome`, and `actual` with `files`
   and `lines` from `git diff --stat` (new files included), `agents`,
   and tokens only where adapters reported them. Leave out what was not
   measured; never write an estimate as `actual`.
2. If the manifest is a part, set its `status` in `plan.yaml` to `done`
   or `failed`, and copy `actual` next to its `estimate` there.
3. If later parts build on this one, write `artifacts/handoff.md`, at
   most 40 lines: what later parts reuse, decisions they must not undo,
   deferred findings with the owning part index, verify result. A run
   outside a plan, or the last part, has no handoff.
4. If the part changed a visible surface, it does not close on prose:
   the `evidence` stage has written `artifacts/try-it.md`, one cropped
   screenshot per claim a reader can check, each with a one or two line
   caption, and its first line was `VERDICT: PASS`. You do not open the
   crops yourself unless the verdict named one; the evidence agent looked
   at every one before captioning it. A part that ends without that
   verdict has failed, whatever the tests say. A part with no visible
   surface writes none.
5. Leave nothing running. A server, browser or background shell a stage
   started is stopped before the report, and anything temporary a stage
   wrote lives under `runs/<id>/` or the session's scratchpad, never in the
   working tree.
6. End with a short report. Point at files; do not repeat them.

- run id, outcome (success / failed at stage X / stopped by user)
- one line per stage: name, iterations, model actually used, check result
- drift, one line each, if any
- actual files, lines and agents next to the estimate, tokens where reported
- when in a plan: parts done / total, and the exact next command
  (`/acos run runs/<plan-id> <i+1>`), or "plan complete"
- files changed, from `git status --short`
- paths worth opening: the run directory, the handoff, the try-it page,
  anything a stage wrote for the user

## 7. Init: derive `.acos.yaml`

Goal: write a correct `.acos.yaml` without the user editing a template.

1. Find the verify command. Look, in order, at: `package.json` scripts
   (`test`, `check`, `verify`, `lint`), `Makefile` targets, `pyproject.toml`
   / `tox.ini` / `pytest.ini`, `Cargo.toml`, `go.mod`, `build.gradle`,
   `*.csproj`, CLAUDE.md or README instructions. Prefer the command the
   repo's own docs tell contributors to run. If several, chain them with
   `&&` in the order lint, build, test.
2. Set `shot`, the capture command a part's try-it page is built from:
   `node <installed skill path>/scripts/shot.mjs` for a project with a web
   interface, the project's own capture command for one whose interface is
   something else, and no key at all when there is no visible surface.
3. Detect reachable providers. Run `which`/`Get-Command` for `claude`,
   `codex`, `gemini`, `ollama`. Keep only providers whose CLI exists, plus
   the harness's native provider.
4. Fill model tiers from `catalog/providers.yaml` for the native provider:
   `fast` = tier fast, `balanced` = tier balanced, `strong` = tier strong.
5. Pick `preset`: leave unset. Ad hoc composition is the default until
   the user saves one.
6. Set `gates.go: required`. Set `limits` to the defaults
   (`files: 8`, `lines: 400`, `orchestrator_tokens: 100000`,
   `worker_tokens: 300000`, `agents: 3`, `stages: 5`) unless the user
   gave others.
7. Write it and say what was chosen and why, one line per field. Ask
   for confirmation only if the verify command is a guess (nothing in
   the repo named it); then show just that line.

Never overwrite an existing `.acos.yaml` without asking.

## 8. Calibrate: learn from past runs

Run this in its own session, not during a task. Goal: make the next
sizing and compose more accurate for this repo.

1. Collect every `runs/*/` that has `manifest.yaml`. Read, per run:
   `manifest.yaml` and `log.yaml`, plus `plan.yaml` for plans. A run
   without a log counts as planned only.
2. Fill token counts missing from a log only from measurement: if a
   usage query for past sessions is available (a session monitor's MCP
   tool, for example), ask it for the log's `sessions` between each
   stage's `started` and `ended`. Otherwise leave them unknown. Never
   read an estimate as an actual.
3. For each run, derive: intent size (files and lines from the log's
   `actual`), planned versus executed stages (added,
   dropped, re-ordered), models and efforts planned versus used,
   iterations per stage, adapters used and agent count, tokens estimated
   versus actual where present, runs whose actual exceeded a limit.
   Plans count too: each part directory is a run; note how many parts
   plans had, and whether parts turned out too big or too small.
4. Look for patterns across runs, not per run: which stages get dropped,
   which get added, which checks get changed the same way, how far
   estimates miss, what task shape tends to need which stages. Always
   derive the per-unit figures sizing needs: tokens per file for inline
   implement, fixed cost plus tokens per file for a subagent, cost of a
   review, how often review fails first time. Per tier: how often a
   balanced-tier implementer passed its check first time, and how often
   the orchestrator had to finish a slice; when that is worse than one in
   three, the Shape section says to run implementers on `strong` or to
   cut smaller slices. Wall time too: stage `started` to `ended` per
   stage, part start to part end, and the gap from one part's end to
   the next part's start, so the Cost section can say whether fan-out
   and parallel parts shortened the plan and where the time went.
5. Write `acos/calibration.md` in the fixed shape from `SPEC.md`
   section 7: header line with run count, date range and today's date;
   sections **Shape**, **Cost**, **Recurring drift**, **Notes**. Under
   40 lines. Overwrite the previous file; if it had a **Notes** section,
   keep entries that are still true. Each Recurring drift line that
   points at a config fix (verify command, a block default, a limit)
   should name the file to change.
6. Say where the file is, give one line per section, and stop. Do not
   change `.acos.yaml`, blocks or presets; suggest those changes in
   **Recurring drift** and let the user decide.

Refuse politely if fewer than two runs exist: say so and stop.

## 9. Save-preset: promote a manifest shape

Take the last run from this session (or `runs/<newest>/`): its
`manifest.yaml` with the stage drift from `log.yaml` applied (dropped
stages removed, added ones inserted, models and efforts as used). Strip
run-specific fields: `id`, `intent`, `part`, `scope`, `estimate`,
`outputs`. Replace concrete model ids with the matching
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
