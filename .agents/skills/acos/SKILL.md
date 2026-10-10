---
name: acos
description: Size a task against the project's session limits, compose an ACOS run manifest (or a plan of manifests, one per session), show it, wait for GO, then execute it without further interruptions and record what actually ran. Runs only when the user invokes /acos.
disable-model-invocation: true
---

# ACOS runner

You are the **orchestrator**. Before any token is spent on the task you
size it, compose a run manifest, show it, and wait for GO. A task too big
for one context becomes a plan of parts, cut for how the user wants to
run it: in this one session, in sessions one after the other, or in
sessions side by side. Then the work runs without asking again, and you
record what actually ran.

## Files

Every path here is relative to the **skill folder**, the directory
holding this file. A pointer SKILL.md that sends you here may name
another folder for the project's own files; follow it.

| Path | What | Owner |
|------|------|-------|
| `SKILL.md`, `references/`, `scripts/`, `agents/openai.yaml` | procedure, tools, Codex policy | upstream |
| `catalog/providers.yaml` | tier aliases, effort levels, invoke commands | upstream |
| `catalog/blocks/`, `presets/` | stage blocks, optional pipelines | project once copied |
| `config.yaml` | project defaults, written by `init` | project |
| `calibration.md` | written by `calibrate`, read at compose | project |
| `runs/` | manifests, plans, logs, artifacts (git-ignored) | project |

No `catalog/`: ACOS is not installed; say so and stop. No `config.yaml`:
run `init` first, then continue.

**Models.** Blocks, presets and `config.yaml` never name a model id.
They ask for a **tier** (`fast`, `balanced`, `strong`, `local`);
`providers.yaml` maps it to an **alias**, a model family (`opus`,
`sol`); where the runner needs full ids, its invoke command adds the
generation (`gpt-6-{{alias}}`).
Only the manifest names an id: at compose time write each delegated
stage's `tier`, and in `model` the id its alias points to today as far
as the harness tells you, or the alias itself if it does not (say so in
`estimate.basis`). A tier the provider does not map runs on the
runner's default; say so in the manifest. Adapters invoke by alias; the
log records what ran.

## Commands

| Invocation | Action | Read |
|------------|--------|------|
| `/acos <task>` | Size, compose, present, GO, execute, close. | the loop below |
| `/acos plan <task>` | Size, ask the run mode, cut and compose; write the plan or the one manifest; stop. | `references/sizing.md` |
| `/acos run <path> [n]` | Run a manifest, run dir, or plan dir + part (default: first not `done`): settle its strategy, print it, start. A bare id resolves under `runs/`. | `references/manifest.md`, `references/execute.md` |
| `/acos init` | Derive `config.yaml` from the repo. | `references/maintain.md` |
| `/acos calibrate` | Learn from past runs into `calibration.md`. Own session. | `references/maintain.md` |
| `/acos save-preset <name>` | Save the last run's shape as `presets/<name>.yaml`. | `references/maintain.md` |
| `/acos show` | Print the last manifest, or the newest under `runs/`. | — |

## The loop

1. **Intent.** Restate the request in one or two sentences. Ask at most
   one question, and only if the answer changes the manifest. Record
   every design source named (canvas, artboards, mockups) under
   `design.sources` now; a design added later means stop and re-present.
2. **Size.** Count files, lines and deliverables, then derive context
   reservations from the counts, never the reverse. Fits: one manifest.
   Does not fit: ask the run mode (`single`, `sequential`, `parallel`),
   cut for it, mark each part `afk` or `present`, confirm the cut,
   write the plan, present it and stop.
   Inside a part the plan only suggests workers and slices.
   `references/sizing.md`.
3. **Compose.** Build the manifest from a preset or ad hoc from blocks,
   resolve tiers and placeholders, estimate, validate.
   `references/manifest.md`.
4. **Present.** Write `runs/<id>/manifest.yaml`, print the one-screen
   summary, then stop: no stage, no agent, no further reads until GO.
   `gates.go: auto` in `config.yaml` (never a preset) skips the wait;
   say so in the header. A written manifest started with `/acos run`
   does not wait either: the command was the GO.
   `references/manifest.md`.
5. **Execute.** For a part of a plan, settle your strategy first:
   catch up on what earlier parts found, read what you need, re-cut
   your own work, rewrite the manifest, print it and start without
   waiting. A `present` part first settles with the user what `afk`
   parts left pending. Then stage by stage through its adapter, checking each; on
   failure apply `on_fail`; log drift and discoveries without asking.
   `references/execute.md`, `references/adapters.md`,
   `references/workflow.md` for `adapter: workflow`.
6. **Close.** Complete `log.yaml` with measured actuals, update
   `plan.yaml`, write the handoff and the try-it evidence where they
   apply, stop anything you started, report in a few lines with paths.
   `references/execute.md`.

## Principles

Budget
- **You do not start at zero.** Your work budget is
  `limits.orchestrator_tokens` minus `config.yaml` `startup.orchestrator`
  (defaults 120k and 40k). A worker starts at `startup.subagent` (25k).
- **Fit is per context.** Compare yourself with the orchestrator limit
  and each worker with `limits.worker_context_tokens`. The sum of
  reservations is volume (never a budget, forecast, actual, spend or
  fit), compared only with `worker_tokens_total` when set. Delegate
  because work is separable, never to hide volume.
- **A worker aims at about 170k** and is never planned past
  `limits.worker_context_tokens` (200k as shipped). How much work that
  is has no formula: you judge it from the kind of work (scripted and
  mechanical, or a decision in every file) and the size of the files.
  Work that would take one worker further is more slices or a more
  precise brief, not a longer run.
- **The plan suggests; the part's orchestrator settles.** `/acos plan`
  sizes from counts and proposes workers and slices. Whoever runs a
  part re-sizes and re-cuts its own work at the start, with what
  earlier parts learned, and again whenever the work shows the strategy
  wrong. `calibrate` judges both afterwards. Never write a reservation
  as an actual.

Shape
- **The mode shapes the cut.** `single`: one session, you orchestrate
  and workers implement side by side, as many at once as the groups
  allow. `sequential`: a fresh session per part, in order. `parallel`:
  sessions at the same time on parts sharing no file, so their pull
  requests cannot conflict, in one worktree unless a part cannot share
  it. Ask before cutting unless the request says.
- **Attendance shapes it too.** Every part is wholly `afk` or
  `present`, negotiated: the user may say it, you propose it with the
  cut, either pushes back. Put what needs the user in as few `present`
  parts as the work allows: one first for a decision the rest is built
  on, one later for everything else. A doubt with a defensible answer
  does not make a part `present`.
- **In `single` you are there until the end.** Delegate every group,
  read what you need to cut and brief, then verdicts instead of diffs
  and artifacts. Edit inline only what is cheaper than a spawn. Your
  lane for the whole plan must fit; reading it cannot hold goes to a
  delegated `plan` stage that writes the briefs.
- **You read to plan; no two workers read one file.** Open what decides
  how the work splits and write briefs a worker follows almost
  mechanically: that reading is your job and counts in your lane. What
  to avoid is two workers opening the same file: each file has one
  worker, and what another needs from it goes in its brief as a
  signature. A habit, not a law. At plan time, for parts that run
  later, cut from structure: the reading belongs to whoever runs them.
- **Inline by default**, outside `single`. Delegate only for an independent judgement
  (review), disjoint slices worth running in parallel (fan-out), a script
  whose output must be looked at (evidence), a wide read that returns one
  page (explore), or work your remaining budget cannot hold.
- **Fewest stages.** `implement` alone is a manifest. Add `plan` when the
  design is not obvious, `review` when risky or public, `explore` only
  when the area is unknown, `evidence` when a visible surface changes
  and `config.yaml` has `shot`.
- **One more agent before one more part.** A part costs a session
  startup and a handoff; a worker costs its startup on a cheaper tier, in
  parallel. Cut a new part only for a real dependency, when one session
  could not verify the merged tree, or when even the slices outgrow it.
- **Cut vertically; one owner per file.** A part carries one capability
  through every layer it touches. Never cut by layer. An unavoidable
  shared file has one owner and is named in the later part's `assumes`.
- **Slices share no file.** Each is worth a worker's startup and sized
  near the worker target. Disjoint groups run side by side; a group too
  big for one worker is split at its thinnest seam, the interface
  across it fixed in both briefs, or its second worker runs after the
  first. Implementers never see each other's briefs. A file two slices
  need has one owner, or goes in a small part that runs first.
- **Plan and implement share one context** outside a fan-out: both
  inline, or both in one subagent.
- **Review once per plan**, in a part near the end, unless a part is
  risky on its own (auth, data loss, public API).
- **Workflow adapter is rare:** three or more parallel stages, shown in
  the manifest before GO.

Models and effort
- **Tier by role.** You plan, brief, judge and hand off. Fan-out
  implementers: `balanced`, medium. Evidence: `balanced`, low. Review:
  `strong`, high. An implementer carrying design-contract lines: high
  (`calibration.md` says when it needs `strong`). Command stages: no
  model. `config.yaml` `stages` may move a block to another tier or
  effort.
- **Your own provider is never `external`.** A delegated stage on the
  provider of the harness you run in is a `subagent` of this session.
  `external` is a shell call to another provider's CLI.
  `references/adapters.md`.
- **Inline stages carry no provider, tier, model or effort.** The
  session's are fixed for its whole life. A stage that needs other ones
  is delegated (an escalated retry too), or is a part the user starts in
  a session set up for it.

Running
- **After GO, no re-approval.** Adjust, rewrite the manifest to what is
  running, log drift, continue. The only questions: `on_fail: ask`, a
  gate, or a discovery that invalidates the part's intent. A larger
  volume than the plan suggested is not one of them.
- **Away means decide, not wait.** An `afk` part asks nothing. Where
  it would have asked it judges, with no fixed rule: assume and just
  mention it, assume and have it confirmed, or defer. All three go to
  `plan.yaml` `pending`. A `present` part opens by settling with the
  user what is addressed to it and may ask when an answer changes the
  work. An `afk` part with nobody to address marks a later part
  `present`. `references/execute.md`.
- **Say the strategy, then start.** When a part starts, print how you
  will run it (slices, workers, order) and begin; the user challenges
  while you work.
- **Discoveries change the plan now**, before the part that found them
  closes. A missed target becomes a named later part's acceptance check,
  with the evidence of where the time or the failure went.
- **A design is a contract.** A `contract` stage transcribes it into
  numbered lines first; each is ticked by the implementer, checked
  against the render by evidence, read by review. No part closes on an
  open line.
- **Visible changes close on evidence**, not prose: cropped captures a
  worker has looked at, verdict `PASS`. Evidence may be deferred to a
  named final part, never dropped.
- **Workers write their artifacts; you read verdicts.** A delegated
  stage saves its output under `runs/<id>/artifacts/` and ends with a
  short status and the path. No output is named report, summary,
  findings or analysis. `references/adapters.md`.
- **Manifests stand alone.** A fresh session with no memory of this
  conversation must be able to run one.
- **Scope is advisory.** Warn once if a worker writes outside it.
- **Workers are proactive inside their perimeter.** `owns` is a
  worker's perimeter: there it changes whatever the work turns out to
  need. With others editing the tree it writes nothing outside, owned
  or not, and says what is needed there. Alone, the tree is its own.
- **Workers do not commit.** The user decides.
- **Terse terminal, contents in files.** Summaries fit one screen; point
  at paths instead of repeating them.
