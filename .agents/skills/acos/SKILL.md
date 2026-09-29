---
name: acos
description: Size a task against the project's session limits, compose an ACOS run manifest (or a plan of manifests, one per session), show it, wait for GO, then execute it without further interruptions and record what actually ran. Runs only when the user invokes /acos.
disable-model-invocation: true
---

# ACOS runner

You are the **orchestrator**. Before any token is spent on the task you
size it, compose a run manifest, show it, and wait for GO. A task too big
for one session becomes a plan: several manifests, one per session. Then
you do the work, mostly yourself, without asking again, and record what
actually ran.

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
| `/acos plan <task>` | Size and compose; write the plan or the one manifest; stop. | `references/sizing.md` |
| `/acos run <path> [n]` | Run a manifest, run dir, or plan dir + part (default: first not `done`). A bare id resolves under `runs/`. | step 4 onward |
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
   Does not fit: slice inside one part, then cut into parts, confirm the
   cut, write the plan, present it and stop. `references/sizing.md`.
3. **Compose.** Build the manifest from a preset or ad hoc from blocks,
   resolve tiers and placeholders, estimate, validate.
   `references/manifest.md`.
4. **Present.** Write `runs/<id>/manifest.yaml`, print the one-screen
   summary, then stop: no stage, no agent, no further reads until GO.
   `gates.go: auto` in `config.yaml` (never a preset) skips the wait;
   say so in the header.
   `references/manifest.md`.
5. **Execute.** Stage by stage through its adapter, checking each; on
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
- **Estimates act at compose time only.** Nothing is re-sized after GO;
  `calibrate` judges them afterwards. Never write a reservation as an
  actual.

Shape
- **Inline by default.** Delegate only for an independent judgement
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
- **Fan-out only for real slices:** two or more groups sharing no file,
  each about three files or more and within `limits.files`/`lines`. You
  plan once and brief each slice; implementers never see each other's
  briefs. A file two slices need has one owner, or goes in a small part
  that runs first. Never more agents than independent parts;
  `limits.agents` caps (3 when absent).
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
- **Inline stages carry no provider, tier, model or effort.** The
  session's are fixed for its whole life. A stage that needs other ones
  is delegated (an escalated retry too), or is a part the user starts in
  a session set up for it.

Running
- **After GO, no re-approval.** Adjust, log drift, continue. The only
  questions: `on_fail: ask`, a gate, or a discovery that invalidates the
  part's intent.
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
- **Manifests stand alone.** A fresh session with no memory of this
  conversation must be able to run one.
- **Scope is advisory.** Warn once if a worker writes outside it.
- **Workers do not commit.** The user decides.
- **Terse terminal, contents in files.** Summaries fit one screen; point
  at paths instead of repeating them.
