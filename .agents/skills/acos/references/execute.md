# Execute and close

## Start

From GO on, `manifest.yaml` is never edited. Start `log.yaml` beside it:
manifest id, `sessions` with this session's id when exposed (Claude
Code: `claude:` + `CLAUDE_CODE_SESSION_ID`; Codex: `codex:` +
`CODEX_THREAD_ID`), a start timestamp, `drift: []`.

## Each stage

1. **Gate.** `gate: true` or `gates.per_stage: true`: show the stage, ask.
2. **Prompt.** Block `prompt` + stage `prompt` + intent + scope notes +
   every named input. Inline: it is your own instruction. A fan-out
   implementer gets only its brief (its `## <stage>` section of the
   plan), its `owns`, and the interfaces the brief names.
3. **Run** through the adapter (`adapters.md`). `∥` stages are spawned in
   one message and awaited together. Write the handoff while evidence
   runs.
4. **Artifacts.** Write an output to `runs/<id>/artifacts/<name>.md` only
   when another context reads it (a delegated stage, a gate, a later
   part). Between inline stages it stays in your context; `git diff` is
   the diff.
5. **Check.** `command`: exit 0. `review`: first line `VERDICT: PASS`.
   `none`: pass. A stage reading `design-contract` must also end with
   the contract repeated and every line marked; an unmarked line fails,
   and the retry lists only those lines.
6. **Log** a stage record: name, iteration, adapter, provider, model,
   started, ended, tokens only if reported, outcome, shortest decisive
   check output. `effort` on delegated stages only (`inherit` when none);
   for inline, the session's model if the harness names it.

## On failure

`on_fail` from the stage, else `loop.on_fail`:

- `retry`: rerun with the check output appended, up to `max_iterations`
  (stage, else loop, else 3).
- `escalate`: as retry, on the next `escalation` entry's tier and
  effort; the last entry repeats. From an inline stage the retry runs as
  a subagent (log `adapter: subagent`, count it in `limits.agents`).
- `ask`: show the output; retry, skip or stop. Opt-in only: blocks and
  shipped presets never default to it.
- `stop`: end the run as failed.

Whatever `on_fail` says:
- **Failed review:** fix the blockers inline with a regression test
  each, rerun the command check, record the rest as deferred findings.
  No fix subagent, no second review unless asked or a blocker was a
  design error; then resume the same reviewer with the blocker list.
- **Failed evidence:** fix the named crops inline, rerun the command
  check, resume the same evidence agent with only those captures. Still
  wrong after that: the part fails.
- **Fan-out implementer out of iterations:** finish it inline from its
  report and `git diff` of its `owns`. Log as drift.

## Drift

A plan that turns out wrong is changed, not re-approved: drop or add a
stage, swap a tier or effort, fix a check. Append to `log.yaml`:

```yaml
- at_stage: implement
  change: "stages[review]: dropped"
  reason: "three-line change, reviewed inline"
```

No new manifest. Retries and escalation within the rules are records,
not drift.

## Discovery

A measured finding that contradicts what the plan assumed (a premise,
cause, later part's scope, order, ownership or acceptance target).

- Changes only how this part gets there: drift.
- Invalidates this part's intent: stop and ask once (re-scope, continue,
  stop).
- In a plan: append it to `plan.yaml` `discoveries` (date, part,
  finding, evidence path), show the adjusted cut for later parts in the
  confirm-the-cut form (`sizing.md` §4), and on OK rewrite their entries
  and manifests. `done` parts are never rewritten.

## Close

1. **Log.** `ended`, `outcome`, `actual` (files and lines from
   `git diff --stat`, new files included; agents) and `observed` only for
   measured tokens, orchestrator and workers apart.
2. **Plan.** In `plan.yaml`: status `done` or `failed`, `actual` beside
   `estimate`.
3. **Handoff.** When later parts build on this one,
   `artifacts/handoff.md`, at most 40 lines: what they reuse, decisions
   not to undo, deferred findings with their owning part, verify result,
   plan adjustments from discoveries. None outside a plan or for the
   last part.
4. **Evidence.** A part that changed a visible surface closes only with
   `artifacts/try-it.md` from the evidence stage: one captioned crop per
   claim, verdict `PASS`. Open a crop yourself only when the verdict names
   it. Exception: an approved deferral, with the handoff repeating every
   claim; the final evidence part cannot defer again and must pass every
   carried claim. No visible surface: no try-it page. With a design
   contract, every line is `done` with a crop or `deferred` to a named
   part that repeats it, the handoff listing deferred lines by number; a
   `differs` line is a defect, fixed and recaptured.
5. **Clean up.** Stop every server, browser or background shell you
   started. Temporary files live under `runs/<id>/` or the scratchpad,
   never in the working tree.
6. **Report**, pointing at files:
   - run id and outcome (success, failed at stage X, stopped)
   - per stage: name, iterations, model used, check result
   - drift, one line each
   - actual files, lines, agents against the estimate; tokens if reported
   - in a plan: parts done/total and the next command
     (`/acos run runs/<plan-id> <i+1>`), or "plan complete"
   - `git status --short`
   - paths worth opening: run dir, handoff, try-it page
