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

This file is the operating procedure. Adapter details:
`references/adapters.md`. Workflow compilation: `references/workflow.md`.

## 0. Locate the catalog

Look, in order, for:

1. `acos/` in the repo root (imported copy: `catalog/`, `presets/`,
   optional `calibration.md`)
2. `.claude/skills/acos/catalog/` and `.claude/skills/acos/presets/` (bundled copy)

Read `.acos.yaml` from the repo root if present. If the catalog is missing,
tell the user ACOS is not installed here and stop. If the catalog exists
but `.acos.yaml` does not, run **init** (section 7) first, then continue.

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

- **You do not start at zero.** `.acos.yaml` `startup` says what this
  session carries before it reads anything (system prompt, tools, MCP
  servers, memory, skills) and what a fresh worker carries. Missing key:
  40000 for you, 25000 for a worker, said in `basis`. Your budget for
  the work is `limits.orchestrator_tokens` minus `startup.orchestrator`,
  and that is the number every sizing decision below is measured
  against.
- **Inline is the default for work one context should hold.** You do the
  work. Delegate a stage when it needs a judgement independent of yours
  (review), when two or more slices are disjoint and worth running in
  parallel (fan-out), when it runs a script and looks at the result
  (evidence), or when what is left of your budget cannot hold the read.
- **One more agent is cheaper than one more part.** A part costs a whole
  session's startup, a handoff written and read, and the gap before
  someone starts it. A worker costs its own startup, on a cheaper tier,
  in parallel, and dies when it returns. When the counted work does not
  fit your remaining budget, delegate inside the part first; cut a new
  part only for a real dependency, when one session could not verify the
  merged tree, or when even the slices together outgrow the session.
- **Cut vertically.** A part owns whole files, and every file has one
  owner in the whole plan. Cut along what the change does — a
  capability, a route, a screen, through every layer it touches — never
  along what the files are (all models, then all services, then all
  views). A layer cut makes the next part re-read what the last one
  read, behind a fresh session's startup each time. Unavoidable overlap
  is allowed: one owner, `assumes` in the later part, and one line
  saying so.
- **Delegating does not save aggregate context; it saves your lane and time.** A
  subagent starts cold: it re-reads the repo docs and every file it
  touches, then runs the check itself. Budget 150k worker tokens for any
  subagent before it writes a line, its own startup included. What makes
  it pay: the worker runs on a cheaper tier, its context dies when it
  returns, and yours is re-sent every turn until the session ends. Never
  delegate to hide reserved volume; delegate because the work is separable.
  Compare each worker with `limits.worker_context_tokens`, never the sum
  of workers with that per-context ceiling. Only `worker_tokens_total`,
  when present, caps aggregate worker reservations.
- **Tier by role, effort only where it exists.** You plan, brief, judge
  and hand off on the session model. Fan-out implementers run on
  `{{ project.models.balanced }}` at medium. Evidence runs on `balanced`
  at low: it must see the crops. Review runs on `strong` at high. A
  stage that is only a command runs no model. Effort belongs to a
  delegated stage only: yours is fixed for the whole session, so never
  give an inline stage an effort and never plan as if step 1 could run
  high and step 3 low. A preset or `.acos.yaml` may override a tier;
  `calibration.md` says when one is not holding up in this repo.
- **Plan and implement share one context, unless it is a fan-out.** For
  one slice: both inline, or both in the same subagent. For two or more
  disjoint slices: you plan once and write a brief per slice; each
  implementer reads only its brief and its slice. The second reading is
  paid at the balanced tier, in parallel, and never lands in your context.
- **Fan-out only where slices are real.** Two or more groups of files that
  share nothing, each about three files or more, each fitting the file and
  line limits alone. One group means inline, unless your remaining
  budget cannot hold it: then it is one implementer, not a second part.
  A file two groups both need is owned by exactly one slice or moved
  into a small part that runs first. `limits.agents` caps the slices.
- **Review once per plan, not once per part.** In a plan, parts carry no
  review stage unless the part is risky on its own (auth, data loss,
  public API); one review part near the end reads the whole diff.
- **Never more agents than the work has independent parts.** Three files
  do not need ten subagents. `limits.agents` caps it; the default when
  absent is 3.
- **Fewest stages.** `implement` alone is a complete manifest for a change
  you understand. Add `plan` when the design is not obvious, `review`
  when the change is risky or public, `explore` only when neither you nor
  `calibration.md` knows the area — and delegate it when you do: it is
  a wide read whose result is one page, the clearest case there is for a
  worker.
- **Evidence only where there is something to see.** Add `evidence` when
  the part changes a visible surface and `.acos.yaml` has `shot`. Without
  either, no capture stage and no try-it page. When it runs, it is a
  subagent that runs the captures, looks at every crop and captions it;
  the pixels never enter your context, and its verdict is a check the part
  must pass before it closes. A visible part may defer evidence to one
  named final part only when deterministic verification passes, its
  `part.evidence` records every claim and capture target, and the final
  part carries all of them and names every part it covers. Evidence is
  batched, never dropped.
- **Effort matches the delegated stage**, not the task: a fan-out
  implementer medium, evidence low, review high. Inline stages carry
  none, and no model either.
- **Workflow adapter is rare.** Three or more independent parallel stages,
  and the user has seen `adapter: workflow` in the manifest before GO.
- **Orchestrator context is the scarce resource.** Default ceiling when
  `limits.orchestrator_tokens` is absent: 120000, of which the startup
  load is already gone before you read a file.

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
   sentence of acceptance is one). When the area is wide or unknown,
   delegate the count to a read-only worker instead of reading the tree
   yourself: the answer comes back as a page, and the budget the work
   needs survives the sizing. Compare with `limits.files` (default
   8), `limits.lines` (default 400) and at most 5 deliverables. Those
   bound one context: an inline part, or one slice. A part that
   fans out may total more across its slices, but no single slice may
   break them.
2. **Subtract the startup load.** Read `.acos.yaml` `startup`
   (`orchestrator`, `subagent`; 40k and 25k when the key is absent).
   Your work budget for this part is `limits.orchestrator_tokens` minus
   `startup.orchestrator` — with the defaults, 80k, not 120k. Every
   part of a plan pays that startup again, in its own session. Put the
   figure in `estimate.orchestrator.startup_tokens` and name it in `basis`.
3. **Classify and reserve context.** Use `acos/calibration.md` Cost
   figures when they apply. Otherwise set `calibration: fallback`,
   `confidence: low`, and use these conservative floors:
   - semantic inline: 40k + 12k per file touched, on top of your startup
   - semantic worker: 150k + 15k per file touched, worker startup included
   - mechanical inline (delete, rename-only, import cleanup, generated
     replacement): 8k + 2k per file, on top of startup; deleted lines do
     not increase it
   - mechanical worker: worker startup + 10k + 3k per file
   - command-only verification: 0 model tokens
   - evidence worker: 60k
   - review worker: 200k
   - delegated-stage coordination: 10k once per part with any delegation,
     recorded in `estimate.orchestrator.coordination_tokens`
   - a review is expected to fail once: add one fix (half the implement
     cost) to every part that has a review stage
   Record each worker separately with its stage, work class, reservation
   and per-worker limit. `aggregate_reserved_tokens` is their sum plus
   the orchestrator reservation; it is context volume, not a fit value or
   observed usage. Set `observed_tokens: null`. If project calibration
   supplies the applicable values, use `calibration: project` and a
   confidence justified by its sample instead.
4. **Learn from earlier parts.** When sizing or running a part of a plan
   whose `plan.yaml` has `actual` on earlier parts, scale by the mean
   measured-actual/reservation ratio for matching lanes and work classes;
   when tokens were not measured, use files and lines, then re-derive from
   step 3. Never copy a reservation into `actual`. Say what ratio was used
   in `basis`, and re-cut the part if a lane breaks its own limit.
5. **Distrust a guess that lands just under the limit.** If most parts
   estimate between 80% and 100% of a limit, you fitted the guesses to
   the limit. Recount from step 1 and cut further.
6. **Cut vertically, then slice.** Group the counted files by the
   capability they serve, not by the layer they live in: the route, the
   store, the view and the test of one behaviour belong in one part, and
   "all the models" is not a part. Each file gets exactly one owner in
   the whole plan; list every part's files in its `owns` entry in
   `plan.yaml`. A file two capabilities truly share goes to the earliest
   part that needs it, and the later part names it in `assumes` — one
   line in the cut, so the re-read is visible and accepted rather than
   hidden. A file under three or more parts means you cut along layers:
   regroup before going on.
   Then inside a part: files that import, style or test each other are
   one group. Two or more groups that share no file, each about three
   files or more and each within the file and line limits, are slices of
   one fan-out part: one plan stage, one balanced-tier implement stage
   per slice, one verify on the merged tree. One group stays inline
   unless your remaining budget cannot hold it, and then it is one
   implementer, not a second part. A file two slices would both edit
   goes to one owner or is done before the fan-out. Reserve your plan and
   briefs in the orchestrator work lane, one semantic worker lane per
   slice, an evidence worker lane when there is a visible surface, and
   10k of orchestration coordination once for the part. State each lane
   in `basis`; do not collapse them to decide fit.
7. **Order the parts by what they build on.** Each part's `after` lists
   the parts it needs in the tree. Default is the part before it. A part
   in a subtree no other part touches waits only for the parts it truly
   needs; the presentation says which parts may run alongside which.

Compare like with like: the orchestrator reservation with
`limits.orchestrator_tokens`, every worker reservation independently with
`limits.worker_context_tokens`, and their sum with
`limits.worker_tokens_total` only when that optional aggregate ceiling
exists. Never compare aggregate reserved volume with a context limit.

- Fits: one manifest. With `/acos plan`, say in one line that it fits a
  single run and no plan is needed, then compose the manifest (section
  3), present it (section 4) and stop without executing. Without
  `/acos plan`, compose and present as usual.
- Does not fit in one context: slice it inside one part first (step 6).
  A session that plans once and runs two or three implementers in
  parallel does the work of several parts for one startup.
- Does not fit in one session either: break the intent into **parts**.
  Each part is a manifest that fits the limits on its own and leaves the
  tree in a working state (tests pass, nothing half-wired). Cut along
  what the change does — a capability, a route, a screen, taken through
  every layer it touches — never along the layers themselves. Each part
  owns its files outright; a part that only half-changes a file the next
  part finishes is a horizontal cut wearing a vertical name.

**Confirm the cut before writing anything.** Very short:

```
Too big for one session (~<files> files; <lane that does not fit>: ~<reserved> / <limit>).
Proposed cut, <n> parts, one owner per file:
  1. <what>   <paths it owns>   ~<files> files   orchestrator ~<reserved>/<limit>; workers <lane list>
  2. <what>   <paths it owns>   ~<files> files   orchestrator ~<reserved>/<limit>; workers <lane list>
  3. <what>   <paths it owns>   ~<files> files   orchestrator ~<reserved>/<limit>; workers <lane list>
Shared: <path> owned by <n>, assumed by <m>   (only when a file could not be given one owner)
OK to write the plan, or change the cut?
```

The paths are there so the user can see the cut is vertical. If they
read as layers (all the components in one part, all the stores in
another), you cut wrong: regroup before asking.

Wait. Apply what the user says (merge, split, reorder, drop). Only then
compose every part's manifest (section 3, once per part), with
`part.plan`, `index`, `of`, and `assumes` stating what earlier parts
leave behind, and write the plan:

```
runs/<plan-id>/plan.yaml
runs/<plan-id>/<index>-<slug>/manifest.yaml     one per part
```

`plan.yaml` holds: intent, limits, one entry per part (index, dir,
summary, `owns`, estimate, status `planned`), and plan-wide
`aggregate_reserved_tokens` with `sessions: <n>`. That total counts one
orchestrator startup per session and is labelled as context volume, not fit.

Then present the plan, not the manifests. A table, and nothing the user
did not ask to see:

```
intent: <one line, what the whole plan makes true>
sessions: <n>

| part | summary | files | orchestrator | workers |
|------|---------|-------|--------------|---------|
| 1 | <a few words> | 4 | ~88k / 120k | none |
| 2 | <a few words> | 6 | ~65k / 120k | implement-a ~195k / 300k; implement-b ~195k / 300k |
| 3 | <a few words> | 3 | ~50k / 120k | evidence ~60k / 300k |

Manifests: runs/<plan-id>/<index>-<slug>/manifest.yaml
Next: /acos run runs/<plan-id> 1
```

The columns come straight off each part's `estimate`: files, the
orchestrator lane, and every worker lane. Never add unlike lanes into a
column called `tokens`, and never compare their sum with a context limit.
Summary is a few words, not a sentence; the manifest holds the detail.
One part per row, in run order, and no other columns.

After the table, when useful, one explicit volume line may appear:
`reserved context volume: ~<aggregate> across <contexts> contexts; not
observed usage`. When calibration is absent, add: `Conservative context
reservation from ACOS fallback floors; actual usage is unknown until
execution.`

Below the table, two lines at most. The first only when it is true:
which parts may run at the same time, where `after` is not simply the
part before. The second, whether you recommend part 1 in this session or
a fresh one — this session if the plan was cheap to make and part 1 is
small, a fresh one if sizing took wide exploration or the conversation is
already long. Nothing else: no stage lists, no tier names, no totals row,
no restating what the table already says.

Then stop. Do not print any manifest. The files are on disk; the
Manifests line says where. The user decides what runs; if they say GO
here, run part 1 (section 4 onward) in this session.

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
6. Estimate: `files`, `lines`, `calibration`, `confidence`, the
   orchestrator's startup/work/coordination/reserved/limit values, one
   worker entry per delegated stage, `aggregate_reserved_tokens`,
   `observed_tokens: null`, `agents`, and per-stage work classes and
   reservations. Write `basis` saying where startup came from, which
   figures came from project calibration or fallback floors, and any
   ratio applied from earlier measured parts. Add `cost` only if the
   catalog has prices for the chosen models.
7. Copy `limits` from `.acos.yaml`; apply any per-run override the user
   gave in sizing.
8. If any stage has `adapter: workflow`, compile the script(s) now per
   `references/workflow.md` and write them under `runs/<id>/`. They are
   part of what the user approves at GO.

Validate the result mentally: required fields present, enums valid,
stage names unique, every `inputs` entry produced by an earlier stage,
estimate within limits. An inline stage
carries no `provider`, `model` or `effort`: they are invalid there, and
the session could not honour them anyway. If a stage needs a model or an
effort other than the session's, delegate it. Stages that will run
at the same time (consecutive delegated stages with no input/output
dependency) each carry `owns`, and no path appears in two of them; an
overlap is a compose error, fix the cut before presenting.

For deferred evidence, the earlier manifest records
`part.evidence.deferred_to` and every claim, URL and capture target. Its
last non-evidence stage must have a deterministic command check. The
named final part records `covers_parts`, repeats every deferred claim and
contains the evidence stage. A missing or changed claim is a compose
error.

## 4. Present and wait for GO

For `/acos run`, first read the manifest. If it has `part.assumes`, check
the tree matches (files exist, verify passes if it says so) and say so in
one line; a mismatch is a question, not a blocker. If `plan.yaml` marks
a part named in `part.after` (default: the part before) as not `done`,
say so. Parts not in `after` may still be running elsewhere; that is
fine.

If earlier parts in `plan.yaml` have `actual`, re-size this part now
(section 2, step 4). When the scaled estimate breaks a limit, say so in
two lines and propose the split before the summary: run the first half
now, write the second half as a new part after it. The user may say GO
as is. This is compose time; after GO nothing is re-sized.

Write `manifest.yaml` to its run directory first. Then print a summary,
not the file:

```
run: <slug>                              (`part <i> of <n> — <slug>` in a plan)
intent: <one line>
orchestrator: ~<reserved> / <limit>   (<startup> startup + <work> work + <coordination> coordination)
workers: <stage> ~<reserved> / <per-worker-limit>; <stage> ~<reserved> / <per-worker-limit>

| stage | runs on | class | check | reservation |
|-------|---------|-------|-------|-------------|
| 1 <name> | inline | semantic | <check> | ~<tokens> |
| 2 <name> | <model>, <effort> | review | <check> | ~<tokens> |

reserved context volume: ~<aggregate> across <contexts> contexts; not observed usage
<fallback provenance line when calibration is absent>

Manifest: runs/<id>/manifest.yaml
Reply GO, or tell me what to change.
```

Every reservation figure is rounded to thousands: `~176k / 280k`, never
`~176000/280000`. The precision is not there, and the line is read at a
glance.

Print nothing that is zero or already visible. No stage count — the table
has rows. Omit the workers line when nothing is delegated. Never call the
aggregate volume a budget, forecast, actual, spend, or fit result.
No plan id in the header: it is the first segment of the Manifest path
directly below.

`runs on` is `inline` for a stage this session does, or the model and
effort for a delegated one — an inline stage never prints an effort,
because it runs at whatever this session runs at and nothing in the
manifest can change that mid-run. `check` is the check itself (`full
verify`, `dotnet test`), not its kind; a stage with `kind: none` prints
`—`.

A `∥` after the model marks a stage that runs at the same time as the row
above it. Those stages list their files under the table, one line each
(`owns: <paths>`), where a long path does not stretch a column. A
compiled workflow script gets a line there too:
`Workflow script: runs/<id>/workflow-1.js`.

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
a rule. It goes between the Manifest line and the GO prompt, so the last
line printed is the one asking for a decision.

If the user asks for changes, produce a new manifest and present again.
If `.acos.yaml` sets `gates.go: auto`, say so in the header line and
proceed without waiting. Presets cannot set this.

## 5. Execute

On GO:

1. `manifest.yaml` is already in the run directory (written at present,
   rewritten if the user asked for changes before GO). From GO on, never
   edit it. Start `log.yaml` next to it with the manifest id,
   `sessions` holding this session's id when the harness
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
      provider, model, started, ended, tokens only if the adapter
      reports them (never an estimate), check outcome, and the shortest
      decisive check output. `effort` only for a delegated stage; for an
      inline one record the session's model when the harness names it
      and leave effort out.
   g. On fail, apply `on_fail` (stage value, else `loop.on_fail`):
      - `retry`: rerun the stage with the check output appended to the
        prompt. Stop after `max_iterations` (stage, else loop, else 3).
      - `escalate`: same as retry, but take the next `escalation` entry
        for provider/model/effort. When the list is exhausted, keep the
        last one and behave as `retry`. Log the model actually used.
        From an inline stage, run the escalated retry as a subagent on
        that model: you cannot change your own model or effort. Log
        `adapter: subagent` on that iteration and count it against
        `limits.agents`.
      - `ask`: show the check output and ask the user: retry, skip, stop.
        This is opt-in only: catalog blocks and shipped presets must not
        default to `ask`.
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
   and an `observed` block only for token counts adapters or a usage
   observer measured. Keep orchestrator and worker observations separate;
   add `aggregate_tokens` only from those measurements. Leave out what was
   not measured; never write an estimate or reservation as `actual`.
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
   verdict has failed, whatever the tests say. The only exception is an
   approved evidence deferral: deterministic verification passed,
   `part.evidence` carries every claim and target to its named later part,
   and the handoff repeats them. The final evidence part cannot defer
   again and must pass every carried claim. A part with no visible surface
   writes none.
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
   (`files: 8`, `lines: 400`, `orchestrator_tokens: 120000`,
   `worker_context_tokens: 300000`, `agents: 3`, `stages: 5`) unless the user
   gave others.
7. Measure the **startup load**: what a session of this project holds
   before it reads a line of code. Every estimate starts from it, so a
   wrong figure is wrong on every future part.
   - If the harness can print its context breakdown (Claude Code:
     `/context`), ask the user to run it in a fresh session of this repo
     and paste the total plus the breakdown. That is a measurement; use
     it, and record the method.
   - Otherwise estimate: characters divided by four over what always
     loads — `CLAUDE.md` and the files it imports, the frontmatter
     description of every skill the session lists, agent definitions,
     the tool schemas of the MCP servers configured here — plus 20000
     for the harness's own system prompt and built-in tools. Say in
     `basis` that it is an estimate.
   - `startup.subagent` is the same minus what a worker does not get
     (the conversation, usually the MCP servers, usually the skill
     list). With nothing to measure, use 25000.
   Write `startup.orchestrator`, `startup.subagent` and a `basis` line
   naming the date and the method. Tell the user the number moves when
   the project gains an MCP server, a skill or a memory file, and that
   `/acos init` re-run updates it.
8. Write it and say what was chosen and why, one line per field. Ask
   for confirmation only if the verify command is a guess (nothing in
   the repo named it) or the startup load needs a `/context` paste; ask
   both in one message, and show just those lines.

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
   dropped, re-ordered), models and efforts planned versus used
   (delegated stages only; inline ones ran at their session's),
   iterations per stage, adapters used and agent count, reserved versus
   measured tokens by matching lane and work class where present, and
   runs whose measured lane exceeded its corresponding limit.
   Plans count too: each part directory is a run; note how many parts
   plans had, and whether parts turned out too big or too small.
4. Look for patterns across runs, not per run: which stages get dropped,
   which get added, which checks get changed the same way, how far
   estimates miss, what task shape tends to need which stages. A miss of
   about the same size on every part, in the same direction, is not
   noise: it is `.acos.yaml` `startup` being stale or absent. Say so in
   **Recurring drift**, with the date `startup.basis` carries, and tell
   the user to re-run `/acos init`. Where a plan's parts overlapped on
   files — the same path owned by two parts, or read by three — say how
   much the re-reads cost and that the cut ran along layers. Always
   derive the per-unit figures sizing needs: tokens per file for inline
   implement, fixed cost plus tokens per file for a subagent, cost of a
   review, how often review fails first time. Per tier: how often a
   balanced-tier implementer passed its check first time, and how often
   the orchestrator had to finish a slice; when that is worse than one in
   three, the Shape section says to run implementers on `strong` or to
   cut smaller slices. Compare a plan's parts with its fan-outs too:
   what one more part cost in startup and handoff against what one more
   worker cost, so the next cut knows which to reach for. Wall time too: stage `started` to `ended` per
   stage, part start to part end, and the gap from one part's end to
   the next part's start, so the Cost section can say whether fan-out
   and parallel parts shortened the plan and where the time went.
5. Write `acos/calibration.md` in this fixed shape: a header line with
   the run count, the date range and today's date; then sections
   **Shape**, **Cost**, **Recurring drift**, **Notes**. Under
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
adapters, checks, on_fail, escalation, loop and gates, and efforts on
delegated stages only: an inline stage in a preset carries no model and
no effort, whatever the session it came from was running. Add `name`
and a one-line `description` derived from the intent. Write to
`acos/presets/<name>.yaml`. Say the path and the stage list in one line.

Refuse to overwrite an existing preset without asking.

## Rules

- The GO gate is not optional. Only `.acos.yaml` can set it to `auto`.
- Inline stages have no model and no effort. The session's are fixed for
  its whole life; work that needs different ones is delegated, or is a
  part the user starts in a session set up for it.
- Every file has one owner in a plan. Cut by capability, not by layer;
  an unavoidable second reader is stated in the cut, not hidden.
- After GO, no re-approval. Adjust, log drift, continue. Ask only on
  `on_fail: ask` or a gate.
- Limits and estimates act at compose time only. Nothing checks them
  mid-run; `calibrate` does that afterwards.
- Fit is per context lane. Aggregate reserved volume is never called
  usage and is compared only with an explicit aggregate limit.
- Command-only stages reserve zero model tokens. Mechanical deletions and
  renames use the mechanical class, regardless of removed line count.
- Scope is advisory. Warn once if a worker writes outside `scope.include`.
- Workers do not commit. The user decides.
- One clarifying question at most before sizing. A plan is presented, not
  negotiated stage by stage; the user edits the cut by asking.
- A manifest must run correctly in a session that has never seen this
  conversation. Everything it needs is in the file.
