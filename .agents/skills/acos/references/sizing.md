# Sizing

Size in things you can count, then derive tokens from them.

## 1. Count

- Files the change creates or edits (tests included), lines changed,
  and deliverables (each sentence of acceptance is one).
- With a design, run the `contract` stage first: each contract line is
  a deliverable, counted apart; one context holds about 20, more means
  slicing by artboard or region.
- A wide or unknown area: delegate the count to a read-only worker, so
  the answer comes back as a page and your budget survives sizing.
- One context (an inline part, or one slice) holds at most
  `limits.files` (8), `limits.lines` (400) and 5 deliverables. A fan-out
  part may exceed them in total, never per slice.

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

## 3. Cut and slice

1. Group files by the capability they serve: the route, store, view and
   test of one behaviour are one part. Each file gets one owner, listed
   in the part's `owns` in `plan.yaml`. A truly shared file goes to the
   earliest part that needs it and is named in the later part's
   `assumes`. A file under three or more parts means a layer cut:
   regroup.
2. Inside a part, files that import, style or test each other are one
   group. Two or more disjoint groups become a fan-out: one plan stage,
   one `balanced` implement stage per slice, one verify on the merged
   tree. A file two slices would edit gets one owner or is done in a
   small part before the fan-out. One group stays inline, or is one implementer if your budget
   cannot hold it. Lanes: your plan and briefs, one worker per slice, an
   evidence worker if visible, 10k coordination.
3. Order parts by `after`: the parts each truly builds on (default: the
   one before). Parts in untouched subtrees may run alongside.

## 4. Decide

- **Fits:** one manifest. With `/acos plan`, say it fits, compose,
  present, stop.
- **Does not fit one context:** slice it inside one part.
- **Does not fit one session:** parts, each fitting alone and leaving
  the tree working (tests pass, nothing half-wired).

Confirm the cut before writing anything:

```
Too big for one session (~<files> files; <lane that does not fit>: ~<reserved> / <limit>).
Proposed cut, <n> parts, one owner per file:
  1. <what>   <paths it owns>   ~<files> files   orchestrator ~<reserved>/<limit>; workers <lanes>
  2. ...
Shared: <path> owned by <n>, assumed by <m>   (only if a file could not get one owner)
OK to write the plan, or change the cut?
```

If the paths read as layers, you cut wrong: regroup before asking.
Wait, apply what the user says, then compose every part's manifest
(`part.plan`, `index`, `of`, `after`, `assumes`) and write:

```
runs/<plan-id>/plan.yaml                      intent, limits, one entry per part
                                              (index, dir, summary, owns, estimate,
                                              status: planned), aggregate volume
                                              (one startup per session; volume,
                                              not fit), sessions: <n>
runs/<plan-id>/<index>-<slug>/manifest.yaml   one per part
```

## 5. Present the plan

A table, not the manifests:

```
intent: <what the whole plan makes true>
sessions: <n>

| part | summary | files | orchestrator | workers |
|------|---------|-------|--------------|---------|
| 1 | <few words> | 4 | ~88k / 120k | none |
| 2 | <few words> | 6 | ~65k / 120k | implement-a ~195k / 300k; implement-b ~195k / 300k |

Manifests: runs/<plan-id>/<index>-<slug>/manifest.yaml
Next: /acos run runs/<plan-id> 1
```

Columns come straight off each `estimate`; never add unlike lanes into
one column. One part per row, in run order; no other columns, no stage
lists, tier names or totals row. Optionally one line `reserved context volume: ~<n> across
<m> contexts; not observed usage`, plus, without calibration,
`Conservative reservation from ACOS fallback floors; actual usage is
unknown until execution.` Then at most two lines: which parts may run at
the same time (only when `after` is not simply the previous part), and
whether to run part 1 here (cheap plan, small part) or in a fresh
session. Stop. If the user says GO, run part 1 here.
