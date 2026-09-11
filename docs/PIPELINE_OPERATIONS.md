# Pipeline operations monitor

This document defines Pomegr's local development pipeline diagnostics.
It is an engineering diagnostic, not a product dashboard, session metric, or efficiency
signal.

## Continuous development JSONL logs

Normal development automatically creates one anonymous continuous JSONL writer before provider observation. It is the primary diagnostic history; Perfetto remains optional targeted export, viewer, and SQL tooling. The writer owns only generated files in ignored `outputs/pipeline-logs/`, assumes one development writer, and retains at most ten owned files of at most 25 MiB each (250 MiB default). It never follows symlinks or deletes files it does not own. Accepted records are bounded to 1 MiB of queued memory, with a separately bounded active in-flight write batch of at most 1 MiB; neither bound is a process-RSS guarantee. A record is limited to 64 KiB. Startup, retention, rotation, and append failures degrade diagnostics without changing observation behavior.

Each newline-delimited record has a fixed versioned schema: a fresh per-run UUID, ISO observation time, and one of `span_start`, `span`, `flow`, `counter`, `health`, `gap`, or `lifecycle`. It can contain only allowlisted stage/domain/outcome/counter vocabulary, synthetic lanes, opaque numeric flow/revision/scope handles, bounded health snapshots, and non-negative bounded timings or counts. `span_start` without a matching settled span is unfinished, not failed. `gap` records report observed dropped or rejected records with only `backpressure`, `disk_error`, or `instrumentation_limit`; lifecycle records delimit a run. Retained files, malformed input, partial trailing lines, rotations, file disappearance, limits, and gaps reduce observed coverage. They never establish whole-session coverage, a cause, or end-to-end duration.

Records must never contain session IDs or selectors, source paths or fingerprints, prompts, responses, reasoning, transcript/tool content, commands, output, credentials, provider-native payloads, or raw errors. The run UUID and opaque handles are diagnostic-local, not hashes or encodings of identity. Logs never enter checkpoints, browser state, reports, HTTP, or renderer IPC.

From the repository root, passively analyze retained files or follow new validated records:

```powershell
npm run diagnostics:logs -- --since 1h
npm run diagnostics:logs -- --follow
```

This file-first analyzer/follower validates the fixed schema and bounds its file, byte, line, pending-span, health-history, and follow output. It neither connects to the monitor nor triggers provider acquisition, scheduling, checkpoint persistence, or publication. Follow begins at current EOF, serializes polls, and reports missed rotation or bounded-poll coverage rather than silently claiming continuity. Normal `npm run dev` does not start capture IPC.

## Optional Perfetto capture and viewer

Perfetto remains optional targeted tooling and does not gate continuous logs.
The aggregate snapshot below remains an auxiliary current-health view because it retains
fixed failure categories and live worker counters that are not part of a trace export.
Recording is separate from provider observation:
it cannot request acquisition, change scheduling, or modify product evidence.

From the repository root, install the pinned official Windows processor and static UI:

```powershell
npm run diagnostics:setup
```

Setup verifies the [v58.2 release](https://github.com/google/perfetto/releases/tag/v58.2)
archive SHA-256 values and stores tools in ignored
`work/perfetto/`. Downloads follow only bounded official GitHub asset redirects.
`npm run diagnostics:setup -- --offline` verifies the cached archives and restores their
extracted files without network access.
Capture, native queries, and the separate loopback viewer operate locally after setup.
No trace upload, remote collector, or product iframe is involved. The local viewer sends
a Content Security Policy that blocks external connections and remote assets.

Continuous JSONL logging starts automatically with the development app. The optional rolling capture does not: use the save/capture tooling only for a targeted trace.

```powershell
npm run dev
```

For routine diagnosis, use `npm run diagnostics:logs -- ...`. When a targeted trace is needed, save rolling history from another local shell:

```powershell
npm run diagnostics:save
npm run diagnostics:viewer
```

The save command prints a timestamped file under ignored `outputs/pipeline-traces/`.
It exports the preceding five minutes, or the shorter retained interval, without clearing
the buffer or stopping recording. After two minutes of uptime, at most two minutes exist.
Memory pressure can shorten the window; the export reports actual coverage. Restarting
development clears the buffer. Saved files remain until explicitly removed.

Use `--last 30s` for a shorter window or `--session <normalized-session-id>` to focus on
known session work plus shared pipeline work. Session lookup is private to development;
the selector and association map never enter the exported trace or reports. A selection
with no retained match is reported as such, not attributed from coincident timestamps.
`--output <local-path>` chooses a filename; save refuses to overwrite an existing file.
For a readable report, run `node scripts/diagnostics-tools.mjs analyze --input <saved-file> --markdown`.
The optional `diagnostics:capture -- --duration 30 --output <local-path>` still measures
a future interval; on the development recorder it leaves the rolling buffer active.
Requests longer than five minutes still export only the most recent retained window.

Open the viewer's loopback URL and choose **Open trace file**. Its WebAssembly and
scripts come from the pinned local archive. Stop the viewer with Ctrl+C. Native SQL
queries are also available through the installed Trace Processor; the maintained
report query is `scripts/diagnostics/perfetto-report.sql`. Reports show per-stage
samples, p50/p95, maximum, incomplete and failed/rejected attempts. Summed slice
durations include overlapping work and are never described as end-to-end elapsed time.

The save/capture client defaults to development port 4317; use `--port` for another known development monitor.
An authenticated Windows named pipe or per-user Unix socket admits one capture client.
Its private token descriptor stays under the user's diagnostic directory, never in
HTTP, logs, or trace exports. A second listener cannot overwrite an existing endpoint
or descriptor. Browser/LAN clients cannot start or stop recording or supply output paths.

Production and desktop builds exclude continuous logging, the recorder, recording transport,
and renderer instrumentation. There is no desktop opt-in or production renderer-trace endpoint.
The development entrypoint composes these capabilities separately from the core monitor;
environment variables cannot enable them in a shipped application.
The capture client reads the token privately; never print descriptor contents. No renderer
control starts recording. A crashed process may leave a descriptor: confirm that its
named pipe has no listener before removing that one stale local descriptor. Startup
deliberately refuses to overwrite another listener's capability.

The development ring targets 300,000 ms with at most 16,384 events and a 3 MiB serialized
event budget. JavaScript object overhead is additional but bounded by the event/handle
limits; this is not a process-RSS guarantee. Defaults are 256 open spans and 256 live
flow/revision handles, with hard limits of 1,024. Expiry and completion release capacity.
Exports rebase event timestamps to their retained window and remain bounded to 4 MiB.
`metadata.rolling` reports start/end offsets from recorder startup, retained duration,
eviction count, capacity limitation, and anonymous selection coverage. Open or clipped
work is explicitly incomplete. Save does not create provider work or alter product state.
Legacy standalone timed test recorders retain their smaller 2,048/4,096 event limits.

Only fixed stage/domain/outcome labels, non-negative bounded timings/counters, synthetic
lanes, and fresh capture-local flow/revision numbers are permitted. Tokens are not
hashes of session identity. Starts and settlement outcomes distinguish unfinished,
failed, rejected, unchanged, and superseded attempts. Overlapping jobs get separate
logical lanes; Perfetto flow links express recorded scheduling relationships.

### Renderer timing contract

Renderer timing is available only in the development build with its recorder running. A committed
catalog, Activity, or Requests response may mint one bounded opaque capture token. The browser
can return that token only with fixed `renderer_event`, `renderer_fetch`,
`renderer_react_commit`, and `renderer_next_frame` duration records for the matching
`catalog`, `activity`, or `requests` domain. It cannot mint a token, start or stop capture,
choose a trace destination, attach a revision/session/source identifier, add a label, or
send a URL, mark detail, text, native ID, clock claim, or arbitrary calibration value. It may
return only the two fixed browser-monotonic boundaries of the token-bearing request interval;
the monitor derives the clock bound from its private issuance time.

The same-computer development bridge verifies the actual socket peer, local host and
same-origin request; forwarded headers do not authorize it. A development-only monitor
handler accepts the fixed payload after the local middleware validates it. Production
has neither route nor recording code. Marks are cleared immediately, records and pending POSTs are bounded, and a
capture shutdown aborts outstanding browser telemetry. `renderer_next_frame` records a
requestAnimationFrame opportunity, never proof that pixels were painted.
For a live History publication, the EventSource listener records `performance.now()` at the
actual notification receipt and carries that fixed number only to the refresh it starts.
`renderer_event` ends at that refresh's React commit. It therefore measures receipt to
commit; it is never synthesized from a fetch response. `renderer_fetch` remains fetch start
to response receipt, while the commit and next-frame stages remain separately overlapping
intervals. A next frame is still an opportunity, never proof of pixels painted.

The committed response is a request-bound calibration exchange. The monitor records its own
monotonic token-issuance point between browser fetch start and response receipt. The browser
returns only those two bounded `performance.now()` boundaries with the fixed timing records.
The bridge derives the midpoint offset monitor-side and exports the converted renderer slices
only when the interval is at most 1,000 ms, the token is fresh, and the active page remains
visible. Error is at least 1 ms plus half the measured request interval; it is exported only
as bounded `clockErrorUs` with `clock: request_interval_bound`. Raw browser timestamps and
the token never enter a trace. Invalid, late, hidden, navigated, dropped, or uncalibrated
browser data is unavailable rather than placed on an apparently shared clock.

The capture has fixed `rendererClock` metadata only: unavailable/bounded status, emitted
calibrated-span count, rejected-calibration count, and maximum error in microseconds. The
trace records a zero-duration `cache_serve` issuance point and calibrated presentation slices
under the same capture-local numeric revision handle, with a fixed catalog/activity/requests
surface enum. This establishes bounded revision-to-renderer milestones; it does not establish
source-to-pixel or visual latency. Capture start clips a duration that crosses it and drops a
duration ending before it, marking incomplete coverage.

Process sampling runs only during recording: CPU is microseconds consumed since the
preceding sample, memory is process RSS bytes, and event-loop delay is the maximum
observed delay in milliseconds for that sample interval. Queue depth, active slots,
capacity, and oldest pending age are aggregate provider-worker values. Worker slots
are asynchronous work, not OS threads or CPU cores. Coverage distinguishes configured
measurement sites from sites actually observed in this capture.

Export validation rejects unknown fields at every level. Prompts, responses, reasoning,
tool arguments/results, commands, output streams, source paths/fingerprints, session
IDs/titles, credentials, and arbitrary error text remain forbidden. Traces never enter
observation checkpoints or normalized browser state. Diagnosis begins with coverage,
drop counts and clock validity; absent observations cannot establish a cause.

Use `diagnostics:benchmark` with an explicit archived baseline checkout and local output
directory. The baseline must contain the pre-change runtime and resolve its dependencies.
For example, after preparing that checkout locally:

```powershell
npm run diagnostics:benchmark -- --baseline-root work/perfetto-baseline --output-directory outputs/pipeline-traces/acceptance --repeat 5
npm run diagnostics:compare -- --before outputs/pipeline-traces/acceptance/synthetic_warm_append_history-before.trace.json --after outputs/pipeline-traces/acceptance/synthetic_warm_append_history-after.trace.json --markdown
```

The maintained scenarios cover cold startup, disk-restored history, a warm append with
1,000 retained rows, and a 16-item burst. Five to ten paired samples record first-ready
and convergence percentiles, CPU/RSS deltas, history GET/read/publication counts, fixed
workload parameters, Node/platform versions and code digests. Held derivation scenarios
require publication before release, first-ready p95 below half the held baseline, correct
row counts and convergence within one second. Restored history checks availability and
correctness without requiring a relative speedup. Imposed waits demonstrate scheduling
behavior; they do not predict latency for real sessions or measure browser presentation.

The implementation acceptance run on 2026-09-10 passed all applicable checks across five
samples per scenario. First-ready p95 in milliseconds, baseline/current: cold startup
111.592/17.138, restored history 54.128/69.603, warm append 662.999/54.834, burst
584.417/103.428. Restored reads were slower in this sample. Re-run against matching local
builds to diagnose a regression; these figures are not production performance budgets.

`diagnostics:analyze` remains the Perfetto command: it runs maintained stage, resource-counter, causal-flow and calibrated
renderer SQL. Its
JSON and Markdown include capture loss, configured versus observed coverage, clocks,
and per-stage samples. No causal edge means unavailable evidence, not zero delay.
`diagnostics:compare` requires matching controlled scenario, schema, clock, coverage,
and complete recordings before labeling results compatible; live captures without a
controlled workload remain descriptive comparisons. Do not add stage percentiles.
Renderer reports join response issuance to matching React/frame milestones and include
lower/upper latency bounds from the clock uncertainty. Visual latency remains unavailable.
Acquisition byte/record counters cover the incremental cursor only; supplementary discovery
and full-history reads are not included. Missing counter samples do not mean zero I/O.
`diagnostics:overhead` measures only a fixed synthetic recorder workload, with tracing
off and on. It does not estimate whole-app overhead.

For snapshot field definitions, see [header and revisions](#header-and-revisions),
[worker columns](#worker-columns), [timing columns](#timing-columns), and
[timing stages](#timings-available-in-v1). For interpretation, see
[lifetime and reset behavior](#lifetime-and-reset-behavior) and
[reading common patterns](#reading-common-patterns).

## Read the auxiliary current snapshot

Start Pomegr from the repository, then read one passive operations snapshot:

```powershell
npm run dev
```

```powershell
npm run diagnostics:snapshot
```

Optional arguments:

```powershell
npm run diagnostics:snapshot -- --provider codex
npm run diagnostics:snapshot -- --port 4317
npm run diagnostics:snapshot -- --json
```

The command reads one bounded snapshot and exits. It emits Markdown by default; `--json`
emits the validated fixed schema. It never starts a polling loop or an interactive panel.
The feed remains passive and sends its first snapshot immediately; the client closes after
the first valid record.

The default monitor port is 4317, or the value of `SESSION_PULSE_PORT` when set;
`--port` overrides it. `--provider` filters provider rows in the Markdown view; JSON
remains the complete validated snapshot. Both forms retain bounded failure categories,
latest allowlisted failure detail, worker counters, revisions, and timing summaries.
Operators remain responsible for redirecting output only to an approved local destination.

The snapshot reader attaches to source-development monitors on concrete ports. Desktop
monitors use ephemeral ports and expose this auxiliary endpoint only when their trusted
host explicitly opts into diagnostics, as described above.

## V1 architecture and privacy boundary

```text
provider notification / reconciliation
                  |
                  v
       provider worker diagnostics
                  |
                  v
       coordinator diagnostics snapshot
                  |
                  v
 Windows named pipe / per-user Unix socket
                  |
                  v
        npm run diagnostics:snapshot
```

The monitor publishes a fixed versioned NDJSON snapshot over local IPC. It does not add an
HTTP route, browser proxy, or React state field. The snapshot reader is passive: connecting cannot
queue hydration, read a transcript, change cadence, or mutate a committed revision. The
IPC server closes with the monitor lifecycle and never persists a snapshot.

Each duration series retains at most 256 numeric values in memory. The snapshot reports
the most recent value plus rolling average, p50, p95, and maximum. It may expose only:

- a fixed schema version and local observation timestamp;
- registered provider ID;
- worker capacity, active count, and pending count;
- bounded observer, coalescing, failure, cache, and revision counters;
- the latest fixed stage, allowlisted reason, local observation timestamp, and bounded
  normalized-schema field/rule summary per provider failure-counter category; and
- bounded aggregate duration summaries.

It must never contain transcript paths, filenames, source fingerprints, session IDs or
titles, prompts, responses, reasoning, commands, patches, stdout, stderr, tool results,
credentials, provider-native records, arbitrary error text, or checkpoint contents.

## Header and revisions

| Field | Meaning | How to read it |
| --- | --- | --- |
| `observedAt` | UTC time when the monitor assembled this diagnostic snapshot, shown in ISO 8601 format. | It is not the time of the last provider event or the last timing sample. `null` means no valid timestamp was supplied. |
| `catalog` | Current committed revision of the session catalog response used by `/api/sessions`. | Advances when a catalog response is committed, including catalog summaries. It is not the number of sessions. |
| `home` | Current committed revision of the Home response used by `/api/home`. | Tracks Home publication independently of catalog and usage publication. |
| `usage` | Current committed revision of the usage-limit response used by `/api/usage-limits`; named `usageLimits` in JSON. | It is not a count of provider API requests: a publication can contain cached values or readiness updates. |

Revisions are independent publication sequence numbers. Compare a domain with its own
previous value, not with another domain. They need not advance together, and a new revision
does not guarantee visibly different values. Zero means no committed response revision is
available. These are monitor-wide response revisions, not individual session evidence
revisions or provider-native versions. See [the observation cache contract](OBSERVATION_CACHE.md#endpoint-ownership-and-revision-semantics)
for serving behavior.

## Worker columns

Here, a **hydration** is one provider worker's attempt to acquire and normalize a session's
source evidence. A worker slot is an asynchronous unit of monitor work, not a coding agent,
OS thread, or CPU core. The same session is never hydrated concurrently by two slots.

| Column | Meaning | Scope and interpretation |
| --- | --- | --- |
| `Provider` | Registered provider identifier, such as `claude` or `codex`. | All remaining values on that row belong to that provider. |
| `Active` | Number of hydration jobs currently occupying worker slots. | A current gauge. Includes jobs waiting or preparing within hydration; it does not mean those jobs are consuming CPU at that instant. |
| `Capacity` | Configured maximum concurrent hydration jobs. | Normally 2 per provider; supported values are 1 through 16. This is configuration, not measured utilization. |
| `Queued` | Number of distinct pending session hydration jobs. | A current gauge, excluding running jobs but including a pending follow-up for a session already running. Repeated requests for one pending session share one queue entry. |
| `Coalesced` | Number of additional hydration requests merged into an already pending job. | Accumulates over the observer's lifetime. It is not the queue length, a count of lost events, or a measured amount of work saved. |
| `Dirty` | Number of times a new follow-up job was queued for a session while its hydration was already running. | Accumulates over the observer's lifetime; it is not the current number of dirty sessions. Further requests merged into that pending follow-up increase `Coalesced` instead. |
| `Failures` | Sum of the observer's acquisition/preparation failure counter and the eight allowlisted registry failure/rejection counters for that provider. | Accumulated recorded events, not current failed jobs, unique incidents, or failed sessions. Recovery does not subtract earlier failures. |

The registry portion of `Failures` covers catalog reads, rejected catalog entries,
readiness probes, session reads, rejected session evidence, observer startup, explicit
observer hydration, and rejected observer publications. It excludes usage-limit failures
and shared coordinator derivation/store rejections. A single underlying problem can cause
more than one recorded event, while an uninstrumented failure may not appear here. Use
`--json` to inspect the bounded categories; zero is not proof that every pipeline step
succeeded.

### Failure details

When a displayed provider has non-zero failures, the Markdown snapshot adds a `Failures` section
before the timing table. It shows each non-zero category's cumulative count followed by
its latest recorded stage, reason, and UTC timestamp. For example:

```text
claude · acquisitionFailures: 1
  acquire_normalize · EACCES · 2026-08-30T12:00:00.000Z
```

JSON exposes the same data under each provider's `failureDetails`, keyed by the existing
failure-counter category. This is an additive V1 field: a new snapshot reader can read an older monitor,
but shows `Detail unavailable (not recorded by this monitor).` for counts without detail.
Restart the monitor with the updated code to begin recording details; old exceptions
cannot be reconstructed, and restarting also resets the in-memory counters.

The observer distinguishes `worker_yield`, `source_preparation`, `acquire_normalize`, and
`session_publication`. Registry categories identify catalog discovery/validation, readiness
probes, session reads/evidence validation, observer startup, explicit hydration, and
publication. Registry publication details additionally distinguish catalog publication,
session publication, invalidation, and checkpoint reads. Stages identify the boundary that
caught the exception, not necessarily its root cause. Acquisition and normalization are
still combined; a preparation sample may cover a batch rather than one session.

Reasons retain only exact `ENOENT`, `EACCES`, `EPERM`, `EBUSY`, `EMFILE`, `ENFILE`, `ENOMEM`,
`ENOSPC`, `EIO`, `ENOTDIR`, `EISDIR`, `ETIMEDOUT`, `ECONNRESET`, or `ABORT_ERR` codes. Without
an allowlisted code, native `SyntaxError`, `TypeError`, and `RangeError` are recognized;
recognized Zod validation exceptions are classified first as `schema_validation`.
Everything else becomes `unknown`. A type classification is not proof of a particular
schema or parser defect. Messages, stacks, causes, arbitrary names/codes, paths, and
source/session identity are never retained. Both the monitor and snapshot reader re-allowlist details.

Schema-validation details include an optional `validation` object with `issues` and
`truncated`. Each issue contains only `field` and `rule`. The field vocabulary is derived
from the canonical normalized evidence, catalog-reference, and usage schemas in
`provider-contract.mjs`, not from rejected values or provider-native schemas. Numeric
array indexes become `[]`; `$` means the root object; unknown paths become `unavailable`.
The Markdown snapshot renders these pairs beneath the failure, for example:

```text
claude · acquisitionFailures: 1
  session_publication · schema_validation · 2026-08-30T12:00:00.000Z
    agents[].executionTasks[].label · too_big
```

Allowlisted rules are `invalid_type`, `too_big`, `too_small`, `invalid_format`,
`not_multiple_of`, `unrecognized_keys`, `invalid_union`, `invalid_key`, `invalid_element`,
`invalid_value`, and `custom`; other rules become `unknown`. `custom` identifies a schema
refinement, not its private message. No expected/received values, bounds, enum options,
unrecognized key names, nested issue payloads, raw paths, or array indexes are retained.
At most 64 top-level issues are inspected, deduplicated into at most eight field/rule
pairs, with `truncated: true` when the scan or output cap omits issues. Field paths have
at most 16 segments and 128 characters. Both IPC boundaries re-allowlist the summary;
older monitors without summaries remain readable. These pairs locate a failed normalized
contract check but do not identify a session or establish why the adapter produced it.

Retention is at most one detail for each of nine fixed categories per provider, in memory
only. A later failure in the same category replaces its detail; success does not clear it
or imply that the previously failing session recovered. The timestamp is when the local
catch handler recorded the failure, not a provider event timestamp; unavailable timestamps
remain null. This adds no new failure counters, changes no retry/cadence behavior, and
does not instrument previously uncounted catches or provider usage-limit failures.

Catalog discovery and shared eager preparation run outside the hydration slots. Therefore,
`Active 0` and `Queued 0` do not prove the whole monitor is idle. Conversely, a pending
follow-up can wait for its own running session even when another slot is free.

Missing or non-finite numeric diagnostic fields normalize to zero; other values are bounded. For example, `Capacity 0`
can mean that no worker diagnostics were supplied, rather than a configured zero-worker
pool. A provider can appear because failure counters exist even if its observer did not
start. `No matching provider diagnostics.` means there is no provider row in the snapshot
matching the text filter; it does not establish that the provider is uninstalled.

## Timing columns

Each stage has its own rolling window of the most recent 256 recorded durations. These
are sample windows, not time windows. Each provider also has separate windows; the rows
prefixed `shared` aggregate coordinator work across providers.

| Column | Meaning |
| --- | --- |
| `Stage` | The operation being measured, with its provider identifier or `shared` scope. Boundaries are listed below. |
| `Last` | Most recently recorded duration for this stage. It is not elapsed time for a currently running operation. |
| `Avg` | Arithmetic mean of the retained durations, rounded to the nearest millisecond. |
| `p50` | 50th percentile of retained durations, using nearest rank: sorted sample at one-based position `ceil(0.50 × Window)`. For an even sample count this selects the lower middle sample, rather than averaging the two middle values. |
| `p95` | 95th percentile, using the same rule at `ceil(0.95 × Window)`. With few samples it can equal `Max`; it is not a guarantee about future operations. |
| `Max` | Largest duration still in the rolling window, not the all-time maximum. It can fall when an older slow sample leaves the window. |
| `Window` | Number of retained samples for this stage, from 0 to 256 in the running V1 monitor. It is neither seconds nor the number of snapshot reads. JSON additionally exposes `sampleCount`, the lifetime number of recorded samples. |

Durations are recorded as non-negative whole milliseconds, bounded to 24 hours per sample.
The Markdown snapshot shows `ms` below one second, `s` with two decimal places below one
minute, and `m` with one decimal place thereafter. Formatting can round near a unit
boundary. `0ms` can represent a measured duration below half a millisecond; it does not
prove no work occurred.

When `Window` is zero, all five duration columns show `—`: no sample is available for
that stage. This can mean it has not run, is still running, or has no applicable
instrumentation. For example, a provider without a preparation hook has no preparation
samples. Reading a snapshot does not create timing samples.

For example, four recorded durations in arrival order `4, 6, 10, 20 ms` produce
`Last 20ms`, `Avg 10ms`, `p50 6ms`, `p95 20ms`, `Max 20ms`, and `Window 4`.

## Timings available in V1

The first four labels are prefixed by the provider ID. The remaining six are prefixed
`shared`. Phase names U1, U2, C, and D refer to the ownership model in
[OBSERVATION_CACHE.md](OBSERVATION_CACHE.md#pipeline-terminology-and-ownership).

| Stage | Measurement boundary | Interpretation |
| --- | --- | --- |
| `catalog discovery` | Start through settlement of the provider's catalog list call. | Time to discover catalog references. Excludes later source preparation and hydration. A failed list attempt can still produce a timing sample. |
| `source queue` | After a source notification is routed, until its pending hydration is dequeued. | Wait for a worker slot or a previous hydration of the same session. Coalesced notifications retain the earliest routed timestamp for that pending job. Routine reconciliation and explicit hydration without a source-event timestamp do not add samples; this does not measure event-delivery or routing latency. |
| `source preparation` | Start through settlement of an optional provider preparation call. | Provider-private preparation before acquisition, such as source topology work. One sample can cover a batch of sessions or a single hydration, including a failed attempt. |
| `acquire + normalize` | Start through settlement of a worker's acquire/ingest call. | Combined U1/U2 duration, including failed calls. Excludes queue wait, the worker's preceding event-loop yield, separate preparation, and downstream shared derivation/commit. V1 does not split acquisition from normalization. |
| `catalog commit wait` | First pending catalog-dirty mark through the start of catalog commit. | Intentional batching and scheduler delay. Structural changes normally use the next-event-loop-turn fast path and can preempt a queued summary refresh. |
| `catalog projection` | Start of catalog commit through response construction, cache commit, and synchronous revision notification. | Shared D/C work to build and publish the catalog response. Excludes its earlier wait and asynchronous browser receipt or rendering. |
| `session commit wait` | The selected candidate's monitor-side queue timestamp through the start of its commit attempt. | New candidates replace pending ones but preserve the first pending deadline (normally 500 ms). A replacement near that deadline therefore has a shorter measured wait. Fresh evidence preempts a delayed failure retry. This is not the first dirty age or the original provider event's latency. |
| `session derivation` | Start through settlement of public session derivation. | D work over an already normalized candidate. Failed or superseded attempts can add samples without reaching store publication. |
| `normalized store commit` | Start through return or throw of the normalized store's publish call. | C validation and immutable in-memory L1 publication. Includes attempts that are unchanged, rejected, or throw. Excludes later checkpoint disk writes. |
| `candidate to commit` | The candidate's queue timestamp through return from the store publish call. | Combined downstream wait, derivation, and store-attempt duration. Recorded even when the store returns unchanged or rejected; absent if derivation or publication throws, or the candidate is superseded before publication. Excludes upstream U1/U2 and downstream checkpoint, catalog/Home rebuild, API delivery, and browser work. |

These are monotonic process durations, not provider timestamps. They measure wall time and
can include asynchronous waiting. They are not throughput, token usage, billing, CPU time,
or an authoritative performance score.

A timing sample is not a success marker. Each stage records at its own boundary, so stages
can have different sample counts and their latest samples can refer to different work.
Preparation can be shared across several sessions; shared derivation can also run after a
checkpoint restore or dependency refresh without new provider acquisition. Do not add the
rows, averages, or percentiles to estimate end-to-end latency: `candidate to commit`
already overlaps the downstream stages, and the windows are not correlated traces.

V1 does not retain per-session traces, split acquisition from normalization for every
adapter, measure API delivery, or measure browser rendering. Those omissions must be shown
as unavailable rather than inferred from unrelated timestamps.

## Lifetime and reset behavior

| Values | Retention and reset behavior |
| --- | --- |
| `Active`, `Queued`, `Capacity` | Read from the current provider observer on every snapshot. Active and pending counts rise and fall as work changes; capacity is configuration. |
| `Coalesced`, `Dirty`, `Failures` | Accumulated in memory, not limited to the timing window and not decremented by successful work. Observer counters start fresh when that observer is recreated; registry failure counters live with the registry. Restarting the monitor recreates both. |
| `failureDetails` | Latest stage, reason, and timestamp per fixed failure category. Lives with the corresponding observer or registry counter, survives successful work and snapshot-reader reconnects, and resets when its owner is recreated. Not a session trace or proof of an ongoing failure. |
| Timing columns | Each observer/coordinator owns its stage windows. A new sample beyond 256 evicts the oldest. Samples do not expire with elapsed time: an idle stage keeps its last values. Recreating the owning observer/coordinator resets its windows; monitor restart resets all of them. |
| Header revisions | Sequence numbers for the current response-cache instances. Recreating those caches on monitor restart begins new sequences; startup publications can advance them before the snapshot reader connects. Restored individual session evidence revisions are separate and do not restore these response counters. |

Reading or filtering a snapshot only changes the client view. It does not clear
monitor diagnostics, reset windows, or trigger work. The diagnostic counters and durations
are never persisted in observation checkpoints. If the one-shot read fails, no new
snapshot is available; use `observedAt` to distinguish a saved result from a new read.

## Reading common patterns

These are investigation cues, not automatic diagnoses or fixed performance thresholds.
Compare the same stage and provider under similar workloads.

| Pattern | What it can mean / what to check |
| --- | --- |
| `Active` stays at `Capacity`, `Queued` grows, and `source queue` rises | Hydration demand may be exceeding worker capacity. Compare preparation and acquisition timings; the snapshot alone does not prove CPU saturation or identify a source. |
| `Dirty` and `Coalesced` increase during active sessions | New requests arrived while work was running or already queued. This is expected coalescing behavior; by itself it does not imply dropped evidence or a defect. |
| `session commit wait` is near 500 ms while derivation and store commit are short | Often the configured coalescing delay. A larger value can also include scheduling or retry delay; it is not automatically slow parsing. |
| `p95` is much higher than `p50` | The retained samples include a slower tail. Check `Window`: percentiles from a handful of samples are especially unstable. |
| Timestamp advances but timings and counters do not | New diagnostic snapshots are arriving without new samples for those stages. Check current workers; they may be idle or still inside an operation that has not yet recorded its duration. |
| `Failures` increases | One or more covered error/rejection counters increased. Inspect the bounded JSON categories before attributing a cause; the total does not identify a failed session or prove lost committed state. |
| `—` remains on a timing row | No samples for that stage are available. It may be unused or uninstrumented, rather than fast or broken. |
| Snapshot connection failure | Check that the development monitor and selected port are available. A saved result is not a new measurement. |

## Implementation references

When changing a field, keep this reference aligned with its measurement and display owners:

- [One-shot snapshot reader and Markdown formatter](../scripts/diagnostics-snapshot.mjs).
- [Bounded schema, counters, and duration statistics](../monitor/pipeline-operations.mjs).
- [Failure-detail recording and allowlisting](../monitor/pipeline-operations-failures.mjs).
- [Normalized-schema failure summaries](../monitor/pipeline-operations-validation.mjs).
- [IPC feed and refresh cadence](../monitor/pipeline-operations-transport.mjs).
- [Provider worker scheduling and measurements](../monitor/providers/normalized-polling-observer.mjs).
- [Provider failure counters](../monitor/providers/registry.mjs).
- [Shared derivation and commit measurements](../monitor/session-observation-coordinator.mjs).
- [Response revision sources](../monitor/observation-runtime.mjs) and
  [response-cache revision allocation](../monitor/committed-response-cache.mjs).

## Renderer measurement boundaries

The implemented [renderer timing contract](#renderer-timing-contract) replaces the earlier
catalog-only proposal. Activity and Requests use fixed, immediately cleared marks and
capture-local nonce tokens. Their durations run from fetch start to response completion,
React commit, or the next available animation frame; these intervals overlap and must
not be added together. Marks never become aggregate snapshots or normalized evidence.

History notification receipt and bounded browser/backend timestamp correlation use the
request-interval method described above. The trace must not infer a receipt from fetch
completion, add visual percentiles, label an animation frame as paint, or claim a
source-to-pixel latency. Product code opens no debugging port; the optional Electron test
uses a debugger attached only to its isolated synthetic fixture.

## Verification

Focused checks for V1 are:

```powershell
npm run test:ops
node --test tests/provider-observation.test.mjs tests/session-observation-coordinator.test.mjs
npm run check:boundaries
npm run verify:fast
```

The renderer bridge is covered by UI lifecycle, privacy serialization, actual-peer
authorization, rolling history exports, and production/desktop artifact exclusion tests. After local
setup, optional host browser checks use isolated, hidden, sandboxed Electron fixtures:

```powershell
$env:POMEGR_PERFETTO_ELECTRON_SMOKE = "1"
$env:POMEGR_RENDERER_REACT_ELECTRON_SMOKE = "1"
node --test tests/perfetto-viewer-electron.test.mjs tests/renderer-trace-react-electron.test.mjs
```

The first opens the pinned viewer with a synthetic local trace. The second bundles the
actual Activity hook and tracing helper, proves an unlinked row renders before evidence
is released, then verifies SSE-driven enrichment preserves its DOM node. These fixtures
use no real provider files and assert zero unexpected external requests.

Development rolling-recorder acceptance on 2026-09-11 passed the production build,
plugin/operations/inventory checks, 1,124 Node tests (one additional test skipped),
722 UI tests, 56 focused diagnostics tests, both local Electron fixtures, and the
type/architecture/dependency checks. Web and desktop artifact scans verify that recording
and renderer instrumentation are absent. Synthetic saves verify past coverage, repeated
exports, opaque session selection, capacity limits, and native Trace Processor queries.
The preceding implementation also passed native comparison, offline setup, and the four
controlled performance scenarios above. Local logs and trace artifacts stay in ignored
`outputs/` or `work/`; they are diagnostics, not release certification.
