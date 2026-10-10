# Sizing

Size in things you can count, then derive tokens from them.

## 1. Count

- Files the change creates or edits (tests included), lines changed,
  and deliverables (each sentence of acceptance is one).
- With a design, run the `contract` stage first: each contract line is
  a deliverable, counted apart; a contract too large for one context's
  reservation is sliced by artboard or region.
- Count without opening files: the tree listing, globs, a search for
  the symbols the intent names, imports, test names. That is enough to
  cut parts. Open files when you are the one running the work and need
  them to plan it (§3, Reading).
- A wide or unknown area: delegate the count to a read-only worker on
  the `fast` tier, so the answer comes back as a page of paths and your
  budget survives sizing. It locates; it does not read files end to end.
- What one context (an inline part, or one slice) holds is decided by
  its token reservation (§2) against its limit; a worker aims lower
  than its limit (§2, Worker target).

## 2. Reserve context

Start from `config.yaml` `startup` (40k orchestrator, 25k worker when
absent); every part pays it again. Use `calibration.md` Cost figures
when they apply (`calibration: project`, confidence justified by their
sample). Otherwise `calibration:
fallback`, `confidence: low`, and these floors:

| Work class | Reservation |
|------------|-------------|
| semantic inline | 40k + 12k per file, on top of startup |
| mechanical inline (delete, rename, import cleanup, generated) | 8k + 2k per file, on top of startup; deleted lines do not count |
| implementing worker | your judgement, from worker startup up (Worker target, below) |
| command-only | 0 |
| evidence worker | 60k |
| review worker | 200k |
| coordination | 10k once per part with any delegation |
| expected review failure | + half the implement cost, per part with review |

Record each worker separately (stage, class, reservation, limit).
`aggregate_reserved_tokens` is their sum plus the orchestrator's;
`observed_tokens: null`.

- **Worker target.** Aim each implementing worker at about 170k and
  never plan one past `limits.worker_context_tokens` (200k as shipped).
  A long run re-reads its whole context on every turn and leaves
  everything waiting on one agent. How much work that is has no
  formula; it is a balance of scope and cost that you judge per slice:
  - the kind of work: a scripted change run through the shell over many
    files costs little more than startup; reading every file and taking
    a precise decision in each costs most;
  - the size of the files (lines, not count), and how much of each must
    be read;
  - how much the brief already decided;
  - `calibration.md` and earlier parts' measured workers, when present.

  Write your figure as the worker's reservation and the reasoning in
  `basis`. Cut only when a cut is needed: over the target means more
  slices or a more precise brief; well under it, one worker is right.
  Your own reading to brief is judged the same way and counted in your
  lane.
- **Earlier parts measured?** When `plan.yaml` has `actual` on earlier
  parts, scale by the mean actual/reservation ratio for matching lanes
  and classes (files and lines when tokens were not measured). Say the
  ratio in `basis`; re-cut what then breaks its limit.
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
- Every capability group is a part with its own implementers, which
  edit its `owns`. Parts no `after` links form a **wave**: their
  delegated stages are spawned together, in one message. Order the cut
  so the first wave is as wide as the groups allow.
- You read what you need to cut and brief, write briefs, run checks and
  read verdicts: not workers' diffs or artifacts. Edit inline only what
  is cheaper than a spawn: a few lines in a file no worker owns (a
  registry line, a seam between two parts).
- Your lane is one startup plus every part's reading, brief and
  coordination, compared once with `limits.orchestrator_tokens` for the
  whole plan (`estimate.orchestrator` in `plan.yaml`; parts after the
  first carry `startup_tokens: 0`). Over the limit: give a part's
  reading to a delegated `plan` stage that writes its briefs, make
  fewer and larger parts, or recommend another mode. Never start a plan
  you cannot finish.
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

### Attendance

Mark every part `afk` or `present`: is the user at the terminal while
it runs? A part is one or the other for its whole length. It is
`attendance` on the part's entry in `plan.yaml` and `part.attendance`
in its manifest.

It is negotiated, both ways. The user may say it in the request ("all
of it while I am away, I am back at the end"): cut for that. Otherwise
propose it with the cut. Push back, in the cut confirmation, when a
part the user wants `afk` needs a decision you cannot defensibly
guess; expect the user to push back when a part you marked `present`
could run without them.

- `afk`: work a brief and a check can carry. It never waits: where it
  would have asked, it assumes or defers by its own judgement and
  records it in `plan.yaml` `pending` (`execute.md`, Attendance).
- `present`: what the work needs the user for. A product or taste
  decision with no defensible guess, a look at the result, a credential
  or interactive login, an action the user would want to take or watch
  themselves.

Cut so the user is needed in few, known places:
- A decision the rest of the plan is built on: a small `present` part
  that runs first.
- Everything else of the user's: a `present` part that runs later,
  usually last. It opens by settling what the `afk` parts left pending,
  and its orchestrator re-sizes it then, once it knows what changed.
- A doubt with a defensible answer does not make a part `present`. The
  `afk` part assumes and records.
- No `present` part is required after an `afk` one. A part that turns
  out to need the user marks a later part `present` itself.

### Reading

Planning the execution means opening files, and that is the
orchestrator's job: read what decides how the work splits and what a
brief must say. It counts in your lane.

- **At plan time, cut from structure.** Parts that run later, in
  another session or after other parts have changed the tree, are read
  by whoever runs them. Paths, names, imports and signatures found by
  search are enough to draw perimeters and count.
- **When you run the work, read to brief.** Entry points, shared types,
  the largest files: enough to take the decisions and write steps a
  worker follows almost mechanically. Not every file end to end; the
  worker still reads its own.
- **No two workers on one file.** What to avoid is two workers opening
  the same file: each file has one worker, and what another needs from
  it goes in its brief as a signature, selector or type instead of the
  path. A habit worth keeping, not a law.

### Cut

1. Group files by the capability they serve: the route, store, view and
   test of one behaviour are one part. Each file gets one owner, listed
   in the part's `owns` in `plan.yaml`. `owns` is a perimeter: name
   directories where the group is a module, so a file nobody planned
   still has exactly one owner. A truly shared file goes to the
   earliest part that needs it and is named in the later part's
   `assumes`. A file under three or more parts means a layer cut:
   regroup.
2. Inside a part, **suggest the workers; do not settle them.** Judge
   the part's delegated work (§2, Worker target). Where one worker
   would pass the target, propose as many slices as bring each near it, along the
   groups structure shows (files that import, style or test each other
   belong together), and write them as the manifest's implement stages.
   Whoever runs the part settles the real slices when it starts
   (`execute.md`, Strategy): it has read the code and knows what
   earlier parts found. Work you can hold inline stays inline.
3. Slices share no file. Disjoint groups run side by side. A group too
   big for one worker is split at its thinnest seam, with the interface
   across it fixed in both briefs, or its second worker runs after the
   first. A file two slices would edit gets one owner or is done first.
   Lanes: your reading and briefs, one worker per slice, an evidence
   worker if visible, 10k coordination.
4. Order parts by `after`: the parts each truly builds on. In
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
  1. <what>   <afk | present>   <paths it owns>   ~<files> files   orchestrator ~<reserved>/<limit>; workers <suggested lanes>
  2. ...
Waves: 1, 2, 3 together; then 4   (single and parallel)
Present: part <n>, for <what it needs you for>   (one line per present part)
Shared: <path> owned by <n>, assumed by <m>   (only if a file could not get one owner)
Own worktree: part <n>; <why it cannot share>   (parallel, only if any)
OK to write the plan, or change the cut?
```

If the paths read as layers, you cut wrong: regroup before asking.
Wait, apply what the user says, then compose every part's manifest
(`part.plan`, `index`, `of`, `mode`, `attendance`, `after`, `assumes`,
`worktree` in `parallel`) and write:

```
runs/<plan-id>/plan.yaml                      intent, mode, limits, one entry per part
                                              (index, dir, summary, attendance, owns,
                                              after, worktree, estimate, status: planned),
                                              aggregate volume
                                              (one startup per session; volume,
                                              not fit), sessions: <n>
runs/<plan-id>/<index>-<slug>/manifest.yaml   one per part
```

## 5. Present the plan

A table, not the manifests:

```
intent: <what the whole plan makes true>
mode: <single | sequential | parallel>   sessions: <n>

| part | wave | user | summary | files | orchestrator | workers (suggested) |
|------|------|------|---------|-------|--------------|---------------------|
| 1 | 1 | afk | <few words> | 4 | ~88k / 120k | none |
| 2 | 1 | afk | <few words> | 22 | ~110k / 120k | implement-a ~150k / 200k; implement-b ~165k / 200k |
| 3 | 2 | present | <few words> | 3 | ~70k / 120k | none |

Manifests: runs/<plan-id>/<index>-<slug>/manifest.yaml
Next: <per mode, below>
```

Columns come straight off each `estimate`; never add unlike lanes into
one column. One part per row, in run order; `wave` only in `single` and
`parallel`; `user` is the part's attendance; no other columns, no stage
lists, tier names or totals row.
In `single` the orchestrator column is each part's share, and one line
under the table gives the session: `orchestrator, whole session:
~<reserved> / <limit>`. Any `Own worktree:` line of
the cut is repeated here. Optionally one line `reserved context volume: ~<n> across
<m> contexts; not observed usage`, plus, without calibration,
`Conservative reservation from ACOS fallback floors; actual usage is
unknown until execution.` Then `Next:`, by mode:

- `single`: `GO runs every part here, wave by wave`, or
  `/acos run runs/<plan-id>` in a fresh session when this one already
  carries a long conversation. GO covers the whole plan; the session
  waits for the user only where a `present` part starts, and says
  which parts those are.
- `sequential`: `/acos run runs/<plan-id> 1`, and one line on whether
  to run part 1 here (cheap plan, small part) or in a fresh session.
  If the user says GO, run part 1 here.
- `parallel`: one `/acos run runs/<plan-id> <i>` per part of the first
  wave, each in its own terminal in this worktree, and for an
  `own` part the worktree to open it in.

Stop.
