# Compose and present

## Compose

1. **Shape**, first that applies: a preset the user named,
   `calibration.md` Shape guidance, `config.yaml` `preset`, otherwise ad
   hoc from blocks (leave `preset` out).
2. **Merge each stage**, later wins: block defaults, preset entry,
   `config.yaml` `stages.<block>` (tier, effort), `config.yaml`
   `provider` when none is named, calibration adjustments, the user's
   request.
3. **Resolve.** Substitute `{{ project.* }}` from `config.yaml`; a
   placeholder with no value is a compose error. Resolve each delegated
   stage's and escalation entry's `tier` to alias and current id
   (SKILL.md, Models).
4. **Identify.** `id`: `YYYY-MM-DD-<slug-of-intent>`. `scope` only when
   given or obvious.
5. **Design.** With `design.sources`: `design.contract` is
   `runs/<id>/artifacts/design-contract.md`, the first stage is
   `contract`, and `implement`, `evidence` and `review` read
   `design-contract`. A slice gets only the lines for what it owns.
6. **Estimate** per `sizing.md`: files, lines, calibration, confidence,
   orchestrator startup/work/coordination/reserved/limit, one entry per
   worker, aggregate volume, `observed_tokens: null`, agents, and a
   `basis` naming every source and ratio. `cost` only with prices you
   actually know.
7. **Limits** from `config.yaml`, plus any per-run override the user gave.
8. **Workflow.** Stages with `adapter: workflow` are compiled now into
   `runs/<id>/workflow-<n>.js` (`workflow.md`); they are part of GO.

**Compose errors**, fixed before presenting:
- missing required field, bad enum, duplicate stage name, or an input
  no earlier stage produces (`design` comes from `design.sources`);
- `design` without a `contract` stage, or a visible stage not reading
  `design-contract`;
- `provider`, `tier`, `model` or `effort` on an inline stage;
- `adapter: external` on your harness's own provider (it is a
  `subagent`), or `subagent`/`workflow` on another provider or where
  `providers.yaml` has `null` (`adapters.md`, Which adapter a provider
  allows);
- an effort the tier does not list in `providers.yaml` (none = `inherit`),
  on a stage or an escalation entry;
- a lane over its limit (re-cut per `sizing.md`);
- parallel stages without `owns`, or a path in two of them;
- a part in a plan without `part.attendance`; in an `afk` part,
  `on_fail: ask`, a stage `gate` or `gates.per_stage`;
- a part in a plan without `part.mode`; in `parallel`, a part without
  `part.worktree`, a path owned by two parts of one wave, or a full
  verify on a part that shares its worktree with a running one;
- in `single`, a session lane over `limits.orchestrator_tokens`;
- an output or artifact name containing `report`, `summary`,
  `findings` or `analysis`, or a delegated prompt asking a worker to
  write such a file (Claude Code refuses it; `adapters.md`, Artifact
  names);
- deferred evidence without: every claim, URL and capture target in
  `part.evidence.deferred_to`, a deterministic command check on the
  last non-evidence stage, and a final part that lists `covers_parts`,
  repeats every claim and holds the evidence stage.

## Running a written manifest (`/acos run`)

The command is the GO: nothing waits, unless the user asked to see the
strategy first. Read `config.yaml`, `calibration.md`, the manifest,
`plan.yaml` and the previous part's handoff, then:

- `part.assumes`: check the tree matches, say so in one line; a mismatch
  is a question, not a blocker.
- A part in `part.after` not `done`: say so.
- `part.attendance: afk`: nobody is asked from here on, the `assumes`
  mismatch included; assume or defer by judgement, record it in
  `plan.yaml` `pending`, go on. When `plan.yaml` says `present` and the
  manifest `afk`, an earlier part changed it: `present` wins.
  `present`: settle the `pending` entries addressed to this part before
  the strategy (`execute.md`, Attendance). No `attendance` on an older
  manifest: `present`.
- Settle the strategy (`execute.md`, Strategy). The manifest on disk is
  the planner's suggestion; this is where it becomes yours, with the
  discoveries and measured actuals of the parts before it.
- Print the summary below, its last line `Starting now; interrupt to
  change.`, and start.
- `part.mode: single`: print the plan table (`sizing.md` §5) once, then
  each part's strategy as its wave starts; every part not `done` runs.
- `part.mode: parallel`: name the parts running alongside and the
  worktree in one line.

## Present

Write `manifest.yaml`, then print:

```
run: <slug>                              (part <i> of <n> — <slug>, <mode>, <afk | present> in a plan; no plan id)
intent: <one line>
orchestrator: ~<reserved> / <limit>   (<startup> startup + <work> work + <coordination> coordination)
workers: <stage> ~<reserved> / <limit>; ...

| stage | runs on | class | check | reservation |
|-------|---------|-------|-------|-------------|
| 1 <name> | inline | semantic | <check> | ~<k> |
| 2 <name> | <model>, <effort> | review | <check> | ~<k> |

reserved context volume: ~<aggregate> across <n> contexts; not observed usage
<fallback provenance line when calibration is absent>

Manifest: runs/<id>/manifest.yaml
Reply GO, or tell me what to change.
```

- Round to thousands (`~165k / 200k`). Print nothing zero or already
  visible; no workers line when nothing is delegated.
- `runs on`: `inline`, or model and effort (model alone on `inherit`).
  `check`: the check itself (`full verify`), `—` for `none`.
- `∥` after a model marks a stage running with the row above; list their
  `owns` under the table, one line each, plus any
  `Workflow script: runs/<id>/workflow-<n>.js`.
- A long conversation or wide exploration before this: one line
  recommending `/acos run <path>` in a fresh session, just above the GO
  prompt.
- Full YAML only on request. Changes requested before GO: new manifest,
  present again.
- A manifest for a later session (`/acos plan`): its workers and slices
  are a suggestion its orchestrator settles at the start; say so in one
  line under the table.
