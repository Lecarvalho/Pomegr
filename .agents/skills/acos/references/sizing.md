# Sizing

Size in things you can count, then derive tokens from them.

## 1. Count

- Files the change creates or edits (tests included), lines changed,
  and deliverables (each sentence of acceptance is one).
- With a design, run the `contract` stage first: each contract line is
  a deliverable, counted apart; a contract too large for one context's
  reservation is sliced by artboard or region.
- Count without opening files: the tree listing, globs, a search for
  the symbols the intent names, imports, test names. Whoever opens a
  file should be the one that edits it (§3, One reader per file), so
  open one while sizing only when you will edit it inline yourself.
- A wide or unknown area: delegate the count to a read-only worker on
  the `fast` tier, so the answer comes back as a page of paths and your
  budget survives sizing. It locates; it does not read files end to end.
- What one context (an inline part, or one slice) holds is decided by
  its token reservation (§2) against its limit.

## 2. Reserve context

Start from `config.yaml` `startup` (40k orchestrator, 25k worker when
absent); every part pays it again. Use `calibration.md` Cost figures
when they apply (`calibration: project`, confidence justified by their
sample). Otherwise `calibration:
fallback`, `confidence: low`, and these floors:

| Work class | Reservation |
|------------|-------------|
| semantic inline | 40k + 12k per file, on top of startup |
| semantic worker | 150k + 15k per file, startup included |
| mechanical inline (delete, rename, import cleanup, generated) | 8k + 2k per file, on top of startup; deleted lines do not count |
| mechanical worker | worker startup + 10k + 3k per file |
| command-only | 0 |
| evidence worker | 60k |
| review worker | 200k |
| coordination | 10k once per part with any delegation |
| expected review failure | + half the implement cost, per part with review |

Record each worker separately (stage, class, reservation, limit).
`aggregate_reserved_tokens` is their sum plus the orchestrator's;
`observed_tokens: null`.

- **Earlier parts measured?** When `plan.yaml` has `actual` on earlier
  parts, scale by the mean actual/reservation ratio for matching lanes
  and classes (files and lines when tokens were not measured). Say the
  ratio in `basis`; re-cut a part whose lane then breaks its limit.
- **Distrust a fit just under the limit.** If most parts land at
  80–100% of a limit, you fitted guesses to it: recount and cut further.

## 3. Mode, cut and slice

### Mode

Work one context holds has no mode: go to §4. Anything bigger is cut
differently depending on how it will be run, so ask before cutting,
unless the request already says. Use the harness's question tool when
it has one, your recommendation first with one line of why:

```
How should this run?
  single      one session: I orchestrate, workers implement side by side
  sequential  a fresh session per part, one after the other
  parallel    several sessions at once, on parts that share no file
```

Recommend `single` when every group can be delegated and your lane for
the whole plan fits; `parallel` when the groups are disjoint but one
session could not coordinate them all, or the user runs several
terminals; `sequential` when parts build on each other or each needs a
look before the next starts. The answer is `mode` in `plan.yaml` and
`part.mode` in every manifest.

**`single`: one session, you orchestrate.** The goal is wall-clock time
without losing your own context, because you are there until the end.
- Every capability group is a part with its own implementer, which
  reads and edits its `owns`. Parts no `after` links form a **wave**:
  their delegated stages are spawned together, in one message. Order
  the cut so the first wave is as wide as the groups allow.
- You cut from structure, write briefs, run checks and read verdicts.
  You do not read the files workers own, their diffs or their
  artifacts. Edit inline only what is cheaper than a spawn: a few lines
  in a file no worker owns (a registry line, a seam between two parts).
- Your lane is one startup plus every part's brief and coordination,
  compared once with `limits.orchestrator_tokens` for the whole plan
  (`estimate.orchestrator` in `plan.yaml`; parts after the first carry
  `startup_tokens: 0`). Over the limit: fewer and larger parts, or
  recommend another mode. Never start a plan you cannot finish.
- A wave is as wide as the disjoint groups allow. `sessions: 1`, no
  handoff files between
  parts, verify on the merged tree after each wave, review and evidence
  once at the end.

**`sequential`: a fresh session per part.** Each part fits alone, leaves
the tree working and hands off to the next. `after` defaults to the
part before.

**`parallel`: sessions at the same time.** The goal is parts whose pull
requests cannot conflict.
- Parts that run together share no file, counting the ones nobody
  lists: lockfiles, barrel and index files, route or injection
  registries, translation catalogs, migration sequences, snapshots,
  generated code, changelogs. Such a file goes to a small part that
  runs alone first, or to one that runs last and wires the rest. Never
  to two parts of the same wave.
- Sessions share one worktree: `worktree: shared` on the part. Each
  works freely inside its `owns` and writes nothing outside, verifies with a command scoped to what it
  owns while the others are mid-edit, and the full verify runs once on
  the merged tree in the last part. One worktree is one branch; the
  user splits commits or pull requests by `owns`.
- `worktree: own` is the exception, with its reason in the plan: the
  part must regenerate a file another part owns, its verify cannot be
  scoped and breaks on the others' half-done edits, or it must ship on
  its own branch before the others finish.
- Inside each part, slice as below.

### One reader per file

Reading is the cost. A file opened by the planner and then opened again
by the implementer is paid twice, so the context that opens a file is
the one that edits it, and no two contexts open the same file. Not a
hard rule, but every exception is tokens spent for nothing.

- Planning does not read what an implementer will read. Cut and brief
  from structure (paths, names, imports, signatures found by search),
  not from file contents. A brief says what to achieve and which files
  are the worker's; the worker reads them and works out the how.
- Where the plan needs the file's contents to be written at all, plan
  and implement are one context: both inline, or both in the one worker
  that owns the file.
- A worker needs something from a file it does not own: put the
  signature, selector or type in its brief instead of the path.
- The cheap exception: a locate pass on the `fast` tier, where a read
  costs little. Keep it narrow all the same.
- **When it cannot hold, say so.** If the modules to change cannot be
  told from structure (coupling, no module boundaries, behaviour spread
  across files that do not name it) and files must be opened just to
  learn who changes what, do that mapping on the `fast` tier and state
  it in the cut and in the presentation, never silently:
  `Double read: <paths or area>; <cause in this repo>; mapped on
  <tier>, read again by the implementer.`

### Cut

1. Group files by the capability they serve: the route, store, view and
   test of one behaviour are one part. Each file gets one owner, listed
   in the part's `owns` in `plan.yaml`. `owns` is a perimeter: name
   directories where the group is a module, so a file nobody planned
   still has exactly one owner. A truly shared file goes to the
   earliest part that needs it and is named in the later part's
   `assumes`. A file under three or more parts means a layer cut:
   regroup.
2. Inside a part, files that import, style or test each other are one
   group. Two or more disjoint groups become a fan-out: one plan stage
   that briefs from structure, one `balanced` implement stage per
   slice, one verify on the merged tree. A file two slices would edit gets one owner or is done in a
   small part before the fan-out. One group stays inline, or is one implementer if your budget
   cannot hold it. Lanes: your plan and briefs, one worker per slice, an
   evidence worker if visible, 10k coordination.
3. Order parts by `after`: the parts each truly builds on. In
   `sequential` the default is the one before. In `single` and
   `parallel` leave `after` empty wherever nothing is built on, since
   every link removes a part from a wave.

## 4. Decide

- **Fits:** one manifest. With `/acos plan`, say it fits, compose,
  present, stop.
- **Does not fit one context:** ask the mode (§3). In `sequential` and
  `parallel`, slice inside one part first.
- **Does not fit one session**, or the mode is `single` or `parallel`:
  parts, each leaving the tree working (tests pass, nothing
  half-wired).

Confirm the cut before writing anything:

```
Too big for one context (~<files> files; <lane that does not fit>: ~<reserved> / <limit>).
Mode: <single | sequential | parallel>
Proposed cut, <n> parts, one owner per file:
  1. <what>   <paths it owns>   ~<files> files   orchestrator ~<reserved>/<limit>; workers <lanes>
  2. ...
Waves: 1, 2, 3 together; then 4   (single and parallel)
Shared: <path> owned by <n>, assumed by <m>   (only if a file could not get one owner)
Own worktree: part <n>; <why it cannot share>   (parallel, only if any)
Double read: <paths or area>; <cause>; mapped on <tier>   (only if any)
OK to write the plan, or change the cut?
```

If the paths read as layers, you cut wrong: regroup before asking.
Wait, apply what the user says, then compose every part's manifest
(`part.plan`, `index`, `of`, `mode`, `after`, `assumes`, `worktree`
in `parallel`) and write:

```
runs/<plan-id>/plan.yaml                      intent, mode, limits, one entry per part
                                              (index, dir, summary, owns, after,
                                              worktree, estimate, status: planned),
                                              double_reads, aggregate volume
                                              (one startup per session; volume,
                                              not fit), sessions: <n>
runs/<plan-id>/<index>-<slug>/manifest.yaml   one per part
```

## 5. Present the plan

A table, not the manifests:

```
intent: <what the whole plan makes true>
mode: <single | sequential | parallel>   sessions: <n>

| part | wave | summary | files | orchestrator | workers |
|------|------|---------|-------|--------------|---------|
| 1 | 1 | <few words> | 4 | ~88k / 120k | none |
| 2 | 1 | <few words> | 6 | ~65k / 120k | implement-a ~195k / 300k; implement-b ~195k / 300k |

Manifests: runs/<plan-id>/<index>-<slug>/manifest.yaml
Next: <per mode, below>
```

Columns come straight off each `estimate`; never add unlike lanes into
one column. One part per row, in run order; `wave` only in `single` and
`parallel`; no other columns, no stage lists, tier names or totals row.
In `single` the orchestrator column is each part's share, and one line
under the table gives the session: `orchestrator, whole session:
~<reserved> / <limit>`. Any `Own worktree:` and `Double read:` line of
the cut is repeated here. Optionally one line `reserved context volume: ~<n> across
<m> contexts; not observed usage`, plus, without calibration,
`Conservative reservation from ACOS fallback floors; actual usage is
unknown until execution.` Then `Next:`, by mode:

- `single`: `GO runs every part here, wave by wave`, or
  `/acos run runs/<plan-id>` in a fresh session when this one already
  carries a long conversation. GO covers the whole plan.
- `sequential`: `/acos run runs/<plan-id> 1`, and one line on whether
  to run part 1 here (cheap plan, small part) or in a fresh session.
  If the user says GO, run part 1 here.
- `parallel`: one `/acos run runs/<plan-id> <i>` per part of the first
  wave, each in its own terminal in this worktree, and for an
  `own` part the worktree to open it in.

Stop.
