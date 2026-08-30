# Pipeline operations monitor

This document defines Pomegr's internal, manually launched observation-pipeline monitor.
It is an engineering diagnostic, not a product dashboard, session metric, or efficiency
signal.

For panel definitions, see [header and revisions](#header-and-revisions),
[worker columns](#worker-columns), [timing columns](#timing-columns), and
[timing stages](#timings-available-in-v1). For interpretation, see
[lifetime and reset behavior](#lifetime-and-reset-behavior) and
[reading common patterns](#reading-common-patterns).

## Run the V1 terminal monitor

Start Pomegr from the repository, then attach the operations client in a separate terminal:

```powershell
npm run dev
```

```powershell
npm run ops:pipeline
```

Optional arguments:

```powershell
npm run ops:pipeline -- --provider codex
npm run ops:pipeline -- --port 4317
npm run ops:pipeline -- --json
npm run ops:pipeline -- --once
```

In an interactive terminal, continuous mode refreshes one panel in an alternate screen
without adding snapshots to console scrollback. The panel fits the current terminal size;
resize the terminal, filter with `--provider`, or use `--once` to see clipped rows or columns.
Ctrl+C restores the previous console screen. `--once` and redirected output remain plain
text without terminal control sequences.

The feed sends a snapshot on connection and then every 500 ms by default. This is the
panel refresh interval, not the provider acquisition interval. The client retries a lost
connection every second; reconnecting does not reset a still-running monitor's counters.

The default monitor port is 4317, or the value of `SESSION_PULSE_PORT` when set;
`--port` overrides it. `--provider` filters provider rows in the text panel only.
Shared timings and revision counters always cover the whole monitor. `--json` prints
the complete bounded snapshot as NDJSON, including all providers even when `--provider`
is supplied. It also includes diagnostic fields not shown in the panel, such as individual
failure categories and lifetime timing sample counts. Operators remain responsible for
redirecting that output only to an approved local destination.

`--once` prints the first valid snapshot and exits; it does not wait for every stage
to have samples or for workers to become idle. Combine `--json --once` for one structured
snapshot. If the connection closes before a valid snapshot, once mode exits unsuccessfully
instead of reconnecting.

V1 attaches to a source-development monitor running on a concrete port. The packaged
desktop monitor selects an ephemeral authenticated port and does not currently advertise
an operations endpoint to an external terminal.

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
        npm run ops:pipeline
```

The monitor publishes a fixed versioned NDJSON snapshot over local IPC. It does not add an
HTTP route, browser proxy, or React state field. The terminal is passive: connecting cannot
queue hydration, read a transcript, change cadence, or mutate a committed revision. The
IPC server closes with the monitor lifecycle and never persists a snapshot.

Each duration series retains at most 256 numeric values in memory. The terminal reports
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
| Timestamp after `Pomegr pipeline operations` | UTC time when the monitor assembled this diagnostic snapshot, shown in ISO 8601 format. | It is not the time of the last provider event or the last timing sample. A changing timestamp confirms new diagnostic snapshots are arriving, even if every other value is unchanged. `time unavailable` means no valid timestamp was supplied. |
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

When a displayed provider has non-zero failures, the terminal adds a `FAILURES` section
before the timing table. It shows each non-zero category's cumulative count followed by
its latest recorded stage, reason, and UTC timestamp. For example:

```text
claude · acquisitionFailures: 1
  acquire_normalize · EACCES · 2026-08-30T12:00:00.000Z
```

JSON exposes the same data under each provider's `failureDetails`, keyed by the existing
failure-counter category. This is an additive V1 field: a new CLI can read an older monitor,
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
source/session identity are never retained. Both the monitor and CLI re-allowlist details.

Schema-validation details include an optional `validation` object with `issues` and
`truncated`. Each issue contains only `field` and `rule`. The field vocabulary is derived
from the canonical normalized evidence, catalog-reference, and usage schemas in
`provider-contract.mjs`, not from rejected values or provider-native schemas. Numeric
array indexes become `[]`; `$` means the root object; unknown paths become `unavailable`.
The CLI renders these pairs beneath the failure, for example:

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
| `Window` | Number of retained samples for this stage, from 0 to 256 in the running V1 monitor. It is neither seconds nor the number of panel refreshes. JSON additionally exposes `sampleCount`, the lifetime number of recorded samples. |

Durations are recorded as non-negative whole milliseconds, bounded to 24 hours per sample.
The text panel shows `ms` below one second, `s` with two decimal places below one
minute, and `m` with one decimal place thereafter. Formatting can round near a unit
boundary. `0ms` can represent a measured duration below half a millisecond; it does not
prove no work occurred.

When `Window` is zero, all five duration columns show `—`: no sample is available for
that stage. This can mean it has not run, is still running, or has no applicable
instrumentation. For example, a provider without a preparation hook has no preparation
samples. Refreshing the panel does not create timing samples.

For example, four recorded durations in arrival order `4, 6, 10, 20 ms` produce
`Last 20ms`, `Avg 10ms`, `p50 6ms`, `p95 20ms`, `Max 20ms`, and `Window 4`.

## Timings available in V1

The first four labels are prefixed by the provider ID. The remaining six are prefixed
`shared`. Phase names U1, U2, C, and D refer to the ownership model in
[OBSERVATION_CACHE.md](OBSERVATION_CACHE.md#pipeline-terminology-and-ownership).

| Terminal stage | Measurement boundary | Interpretation |
| --- | --- | --- |
| `catalog discovery` | Start through settlement of the provider's catalog list call. | Time to discover catalog references. Excludes later source preparation and hydration. A failed list attempt can still produce a timing sample. |
| `source queue` | After a source notification is routed, until its pending hydration is dequeued. | Wait for a worker slot or a previous hydration of the same session. Coalesced notifications retain the earliest routed timestamp for that pending job. Routine reconciliation and explicit hydration without a source-event timestamp do not add samples; this does not measure event-delivery or routing latency. |
| `source preparation` | Start through settlement of an optional provider preparation call. | Provider-private preparation before acquisition, such as source topology work. One sample can cover a batch of sessions or a single hydration, including a failed attempt. |
| `acquire + normalize` | Start through settlement of a worker's acquire/ingest call. | Combined U1/U2 duration, including failed calls. Excludes queue wait, the worker's preceding event-loop yield, separate preparation, and downstream shared derivation/commit. V1 does not split acquisition from normalization. |
| `catalog commit wait` | First pending catalog-dirty mark through the start of catalog commit. | Intentional batching and scheduler delay. Structural changes normally use the next-event-loop-turn fast path and can preempt a queued summary refresh. |
| `catalog projection` | Start of catalog commit through response construction, cache commit, and synchronous revision notification. | Shared D/C work to build and publish the catalog response. Excludes its earlier wait and asynchronous browser receipt or rendering. |
| `session commit wait` | The candidate's monitor-side queue timestamp through the start of its commit attempt. | Normally includes the configured 500 ms coalescing delay plus scheduling. New candidates replace pending ones and restart that delay; retries can add longer waits. It does not start at the original provider event. |
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
| `failureDetails` | Latest stage, reason, and timestamp per fixed failure category. Lives with the corresponding observer or registry counter, survives successful work and CLI reconnects, and resets when its owner is recreated. Not a session trace or proof of an ongoing failure. |
| Timing columns | Each observer/coordinator owns its stage windows. A new sample beyond 256 evicts the oldest. Samples do not expire with elapsed time: an idle stage keeps its last values. Recreating the owning observer/coordinator resets its windows; monitor restart resets all of them. |
| Header revisions | Sequence numbers for the current response-cache instances. Recreating those caches on monitor restart begins new sequences; startup publications can advance them before the CLI connects. Restored individual session evidence revisions are separate and do not restore these response counters. |

Closing, reopening, or filtering the CLI only changes the client view. It does not clear
monitor diagnostics, reset windows, or trigger work. The diagnostic counters and durations
are never persisted in observation checkpoints. After a disconnect the panel can retain
its last frame while waiting to reconnect; use the header timestamp to distinguish that
frame from a newly received snapshot.

## Reading common patterns

These are investigation cues, not automatic diagnoses or fixed performance thresholds.
Compare the same stage and provider under similar workloads.

| Pattern | What it can mean / what to check |
| --- | --- |
| `Active` stays at `Capacity`, `Queued` grows, and `source queue` rises | Hydration demand may be exceeding worker capacity. Compare preparation and acquisition timings; the panel alone does not prove CPU saturation or identify a source. |
| `Dirty` and `Coalesced` increase during active sessions | New requests arrived while work was running or already queued. This is expected coalescing behavior; by itself it does not imply dropped evidence or a defect. |
| `session commit wait` is near 500 ms while derivation and store commit are short | Often the configured coalescing delay. A larger value can also include scheduling or retry delay; it is not automatically slow parsing. |
| `p95` is much higher than `p50` | The retained samples include a slower tail. Check `Window`: percentiles from a handful of samples are especially unstable. |
| Timestamp advances but timings and counters do not | New diagnostic snapshots are arriving without new samples for those stages. Check current workers; they may be idle or still inside an operation that has not yet recorded its duration. |
| `Failures` increases | One or more covered error/rejection counters increased. Inspect the bounded JSON categories before attributing a cause; the total does not identify a failed session or prove lost committed state. |
| `—` remains on a timing row | No samples for that stage are available. It may be unused or uninstrumented, rather than fast or broken. |
| Waiting-for-feed message or a frozen timestamp | The client may be disconnected or the feed may be delayed. Check that the development monitor and selected port are available. The last visible panel is not a new measurement. |

## Implementation references

When changing a field, keep this reference aligned with its measurement and display owners:

- [CLI formatter and refresh behavior](../scripts/pipeline-ops.mjs).
- [Bounded schema, counters, and duration statistics](../monitor/pipeline-operations.mjs).
- [Failure-detail recording and allowlisting](../monitor/pipeline-operations-failures.mjs).
- [Normalized-schema failure summaries](../monitor/pipeline-operations-validation.mjs).
- [IPC feed and refresh cadence](../monitor/pipeline-operations-transport.mjs).
- [Provider worker scheduling and measurements](../monitor/providers/normalized-polling-observer.mjs).
- [Provider failure counters](../monitor/providers/registry.mjs).
- [Shared derivation and commit measurements](../monitor/session-observation-coordinator.mjs).
- [Response revision sources](../monitor/observation-runtime.mjs) and
  [response-cache revision allocation](../monitor/committed-response-cache.mjs).

## Future milestone: renderer performance marks

`performance.mark()` entries live only inside one browser renderer. They do not become
visible to the operations terminal merely because the terminal is attached. A future
renderer milestone may add an explicit, opt-in telemetry bridge while keeping the product
UI unchanged.

The proposed renderer sequence is:

```text
catalog revision received
        |
        | performance.mark("pomegr:catalog-event-received")
        v
cache-only catalog GET completed
        |
        | performance.mark("pomegr:catalog-fetch-complete")
        v
React committed the matching revision
        |
        | performance.mark("pomegr:catalog-react-commit")
        v
next animation frame painted
        |
        | performance.mark("pomegr:catalog-next-paint")
        v
PerformanceObserver -> sanitized bridge -> terminal
```

The bridge design must satisfy all of the following before implementation:

1. Renderer collection is disabled by default and active only for an explicit local
   operations session. Disconnecting the terminal disables collection and clears marks.
2. Mark and measure names come from a fixed allowlist. User, provider, route, component,
   session, and source values may never become mark names or detail payloads.
3. A record may contain only the committed catalog revision, a fixed stage enum, a bounded
   duration, and a local observation timestamp. Correlation uses the revision; it does not
   expose a provider event ID or session identity.
4. A `PerformanceObserver` consumes and clears allowlisted entries with bounded sampling
   and backpressure. Missing marks, navigation, background throttling, clock anomalies, or
   bridge failure degrade to unavailable.
5. Renderer telemetry remains in memory, is never written to observation checkpoints, and
   never becomes normalized session evidence, an efficiency signal, or a user-facing
   metric.
6. The bridge must be unavailable to non-loopback browser clients and must not weaken the
   monitor's desktop authorization, same-origin proxy, or Content Security Policy.
7. The operations terminal joins renderer durations to backend aggregate/revision timing;
   the browser cannot trigger U1, U2, C, D, or P work through this channel.

The exact loopback/desktop handshake for enabling that bridge is deliberately deferred to
the milestone's threat model. Direct Chrome DevTools Protocol attachment is not the
preferred design because it is browser-specific and would widen the local debugging
surface.

## Verification

Focused checks for V1 are:

```powershell
npm run test:ops
node --test tests/provider-observation.test.mjs tests/session-observation-coordinator.test.mjs
npm run check:boundaries
npm run verify:fast
```

Any future renderer bridge additionally requires UI lifecycle, privacy serialization,
loopback authorization, desktop boundary, and disabled-by-default tests.
