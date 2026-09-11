# Diagnose Pomegr latency with Perfetto

Use this workflow for delayed live updates and supplied pipeline traces. The maintained
[pipeline runbook](../../../../docs/PIPELINE_OPERATIONS.md) owns setup, activation,
privacy, units, limits, and SQL semantics; [Observation cache](../../../../docs/OBSERVATION_CACHE.md)
owns runtime behavior. Read the relevant sections when needed, rather than loading the
whole runbook for every investigation. Reuse the repository's diagnostic tools.

## Acquire the smallest useful evidence

Start with a supplied capture. If the user reports a recent delay, immediately save the
development recorder's retained history before older events are evicted.
Run from the Pomegr repository root; choose a new output filename to preserve prior evidence:

```powershell
node scripts/diagnostics-save.mjs --output outputs/pipeline-traces/investigation.json
node scripts/diagnostics-tools.mjs analyze --input outputs/pipeline-traces/investigation.json --json
```

Development recording starts with npm run dev and targets the last five minutes under
strict memory limits; save neither clears nor stops it. Inspect metadata.rolling for
actual retained coverage. Earlier events and pre-restart history cannot be reconstructed.
Use --last 30s for a smaller window and --session <normalized-id> for private monitor-side
selection; never write that selector into a filename or report. The exported trace remains
anonymous and retains shared work. No retained match means unavailable session coverage.
For a forward reproduction, diagnostics:capture remains available. Reproduce only actions
within the user's authorized scope. Browser timing must have been collected from the
affected visible development page during the interval; it cannot be added retrospectively.
Use `diagnostics:snapshot` for current queue/capacity and fixed failure details absent from
the trace. A later snapshot is not evidence of worker state during an earlier recording.

If the listener or processor is unavailable, inspect the local setup/activation contract.
On managed Windows, retry a blocked named-pipe connection in the authorized host environment
before concluding the listener is absent. An existing descriptor filename does not prove a
listener is alive. Never print descriptor contents or delete a capability merely to retry.
These recording tools are development-only; production and desktop exclude them. Use the
known development port with --port when it differs from 4317.
Do not silently install tools, restart processes, or fall back to raw
transcripts. Existing user authorization for those actions still applies.

## Interpret coverage before timings

Check schema/provenance, configured and observed stages, dropped events/spans/handles,
unfinished work, and renderer clock status. Mark gaps unavailable; an absent sample is
not zero latency. A clipped or overflowed recording cannot prove complete convergence.

Use the maintained stage, counter, flow, and renderer queries through `analyze`:

| Question | Evidence to inspect |
| --- | --- |
| Is work waiting upstream? | `source_notification`, `source_queue`, queue depth/capacity and oldest pending age. |
| Is ingest expensive? | `source_preparation`, combined `acquisition_normalization`, incremental bytes/records. Supplementary discovery/full-history I/O is outside those counters. |
| Is ready history delayed? | `history_contribution`, `history_publish`, `history_read`, commit waits, derivation and recorded flow edges. |
| Is the browser behind publication? | `revision_notify`, cache serving, and available revision-linked renderer milestones. |
| Is resource pressure plausible? | CPU deltas, RSS and event-loop delay aligned to the relevant interval; coincidence alone is not causation. |

Trace flows and revision handles are capture-local and identity-free. Never recover or
invent a session/request mapping from lane numbers, numeric handles, event order, or timing.
Keep SQL results bounded and aggregate; do not dump arbitrary trace arguments or raw files.
If a custom query is necessary, use fixed stage/field allowlists and explain its boundary.

Stages overlap: do not sum their durations, averages or percentiles into end-to-end latency.
The selected-candidate commit wait is not the first dirty age. Renderer `event` measures
actual SSE receipt to React commit; fetch, commit and next-frame intervals overlap.
Calibrated renderer reports join response issuance to a matching milestone and expose
lower/upper bounds. An animation frame is not proof of paint, and neither those bounds
nor unrelated timestamps establish source-to-pixel latency.

## Test an explanation and report

Prefer a controlled reproduction that isolates the suspected wait, followed by the same
workload after a change. Use `diagnostics:benchmark` for the maintained cold, restored,
warm-append and burst fixtures; inspect their correctness/convergence acceptance as well
as speed. Use `diagnostics:overhead` only for recorder overhead, not whole-app cost.

```powershell
node scripts/diagnostics-tools.mjs compare --before outputs/pipeline-traces/before.json --after outputs/pipeline-traces/after.json --markdown
```

Check comparison compatibility before drawing a regression conclusion: scenario, clock,
schema, coverage and complete recordings must match. Also compare workload parameters,
sample counts, build metadata and machine conditions. Uncontrolled live captures remain
descriptive even when timings differ. Report p50/p95 with sample counts and uncertainty;
do not claim a universal speedup from a synthetic fixture or a handful of samples.

Lead with the measured bottleneck or the evidence gap. Include the local capture/report,
the relevant stage or recorded relationship, typical/tail timing, coverage limitations,
and the next discriminating check. Label a proposed cause as inference until tested.
Keep prompts, provider commands, tool-result content, provider identities and raw session paths out of
reports. Local diagnostic artifact paths are acceptable; upload nothing to a hosted service.
