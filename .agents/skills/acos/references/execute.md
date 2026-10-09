# Execute and close

## Strategy

A manifest written by `/acos plan` is a suggestion, sized from counts
by a planner that had not read the code. Before the first stage of a
part, make it yours. A manifest you composed in this session with the
files already open is yours: go to Start.

1. **Catch up.** `plan.yaml` `discoveries`, earlier parts' `actual`,
   the previous handoff. Scale reservations by the measured ratio
   (`sizing.md` §2).
2. **Read to plan.** Open what decides how the work splits and what a
   brief must say (`sizing.md` §3, Reading). Reading your lane cannot
   hold goes to a delegated `plan` stage that writes the briefs.
3. **Re-cut your own work.** Stages, slices, order, tiers and checks
   are yours to change. Cut where a cut is needed: judge each worker
   from the kind of work and the size of its files (`sizing.md` §2,
   Worker target), aim at about 170k, never past
   `limits.worker_context_tokens`, and give every file one worker.
   Fixed: the part's intent and acceptance, its `owns` while other
   sessions edit the tree, and parts already `done`.
4. **Brief so the work is mechanical.** Per slice: the steps file by
   file, the decisions already taken, every signature it shares with
   another slice, the tests, what done looks like. The less a worker
   has to discover, the shorter its run.
5. **Rewrite `manifest.yaml`** to what will run, estimate included.
   The first drift entry of the log says how it differs from the
   suggestion; nothing when it does not.
6. **Say it and start.** Print the summary (`manifest.md`, Present)
   ending `Starting now; interrupt to change.` Do not wait and do not
   ask, whatever the new volume. What the user says while you work is
   applied like any other change of strategy.

Do it again mid-part when the work shows the strategy wrong: a slice
far larger than sized, a seam that does not hold, a worker that comes
back half done. Re-cut what remains, rewrite the manifest, log the
drift, say it in one line, continue.

## Start

Start `log.yaml` beside the manifest:
manifest id, `sessions` with this session's id when exposed (Claude
Code: `claude:` + `CLAUDE_CODE_SESSION_ID`; Codex: `codex:` +
`CODEX_THREAD_ID`), a start timestamp, `drift: []`.

`part.mode` decides what surrounds the stages:

- `single`: GO covered the whole plan. Run it wave by wave: settle the
  strategy of every part in the wave, spawn their delegated stages in
  one message, check each, verify the merged tree, close those parts, start the next wave
  without stopping or asking. One `log.yaml` per part, no handoff
  between them. Keep from each worker its verdict and paths, nothing
  else. A session that dies is resumed with `/acos run <plan>`, from
  the first part not `done`.
- `sequential`: one part, then stop.
- `parallel`, `worktree: shared`: other sessions are editing this tree
  now. The part's `owns` is its perimeter: change anything inside it,
  planned or not; write nothing outside it, owned by another part or by
  nobody, and put what is needed there in the handoff for the part that
  owns it or the last part. A change you did not make is another
  session's: never fixed, reverted or reported as yours. Run the part's
  scoped check, not the full verify, unless this is the last part.

## Each stage

1. **Gate.** `gate: true` or `gates.per_stage: true`: show the stage, ask.
2. **Prompt.** Block `prompt` + stage `prompt` + intent + scope notes +
   every named input. Inline: it is your own instruction. A fan-out
   implementer gets only its brief (its `## <stage>` section of the
   plan), its `owns`, the interfaces the brief names, and whether other
   agents run at the same time. Its `owns` is then its perimeter: free
   inside, nothing written outside.
3. **Run** through the adapter (`adapters.md`). `∥` stages are spawned in
   one message and awaited together. When they return, apply the
   changes they asked for outside their perimeters: yourself when
   small, otherwise in the next wave's briefs. Write the handoff while
   evidence runs.
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
  a subagent (log `adapter: subagent`).
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

A plan that turns out wrong is changed, not re-approved: re-cut the
slices, drop or add a stage, swap a tier or effort, fix a check.
Rewrite `manifest.yaml` in place so it says what is running, and
append to `log.yaml`:

```yaml
- at_stage: strategy
  change: "stages[implement]: 1 worker, 30 files -> implement-a, -b, -c, 10 files each"
  reason: "large files, a decision in each: one worker would run far past 200k; three near 150k along the module seams"
- at_stage: implement
  change: "stages[review]: dropped"
  reason: "three-line change, reviewed inline"
```

The manifest is the current strategy; the drift entries are how it got
there. Retries and escalation within the rules are records, not drift.

## Discovery

A measured finding that contradicts what the plan assumed (a premise,
cause, later part's scope, order, ownership or acceptance target).

- Changes only how this part gets there: drift.
- Invalidates this part's intent: stop and ask once (re-scope, continue,
  stop).
- In a plan: append it to `plan.yaml` `discoveries` (date, part,
  finding, evidence path) and update the entries of the later parts it
  changes (summary, `owns`, `after`, acceptance), saying so in one
  line. Their manifests are left to their own orchestrators, which
  re-cut from the discoveries when they start. `done` parts are never
  rewritten; a part running in another session is told through the
  handoff.

## Close

1. **Log.** `ended`, `outcome`, `actual` (files and lines from
   `git diff --stat`, new files included; agents) and `observed` only for
   measured tokens, orchestrator and workers apart.
2. **Plan.** In `plan.yaml`: status `done` or `failed`, `actual` beside
   `estimate`.
3. **Handoff.** When later parts build on this one,
   `artifacts/handoff.md`, at most 40 lines: what they reuse, decisions
   not to undo, deferred findings with their owning part, verify result,
   plan adjustments from discoveries. None outside a plan, in `single`
   mode, or for the last part.
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
     (`/acos run runs/<plan-id> <i+1>`), or "plan complete"; in
     `single`, one report at the end of the plan, not one per part
   - `git status --short`
   - paths worth opening: run dir, handoff, try-it page
