# Pipeline operations monitor

This document defines Pomegr's internal, manually launched observation-pipeline monitor.
It is an engineering diagnostic, not a product dashboard, session metric, or efficiency
signal.

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

The client reconnects after a monitor restart. `--json` prints the same bounded snapshots
as NDJSON for temporary engineering analysis; operators remain responsible for redirecting
that output only to an approved local destination.

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

## Failure details

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

Implementation: [failure recording](../monitor/pipeline-operations-failures.mjs) and
[normalized-schema summaries](../monitor/pipeline-operations-validation.mjs).

## Timings available in V1

| Terminal stage | Boundary | Interpretation |
| --- | --- | --- |
| Provider catalog discovery | Before and after the provider's bounded catalog list operation | Time to obtain the latest normalized catalog references |
| Source queue | Routed source notification to worker dequeue | Capacity pressure before provider work starts |
| Source preparation | Provider-private source topology preparation | Work shared by or required before hydration |
| Acquire + normalize | Provider worker acquisition call | Combined U1/U2 duration in V1; it is not yet a trustworthy split between the two phases |
| Catalog commit wait | First catalog-dirty mark to commit start | Intentional coalescing or event-loop delay; structural changes normally use the next-turn fast path |
| Catalog projection | Catalog projection start through committed revision notification | Shared D/C work for the bounded catalog response |
| Session commit wait | Normalized candidate publication to session commit start | Primarily the configured 500 ms coalescing window plus scheduler delay |
| Session derivation | Start and completion of public session derivation | D work over an already normalized candidate |
| Normalized store commit | Start and completion of the immutable L1 store publication | C validation and commit work |
| Candidate to commit | Normalized candidate publication through store publication | Combined downstream candidate latency |

These are monotonic process durations, not provider timestamps. They are diagnostic wall
time and can include asynchronous waiting. They are not throughput, token usage, billing,
or an authoritative performance score. An empty timing row means the running monitor has
not observed that phase since startup.

V1 does not retain per-session traces, split acquisition from normalization for every
adapter, measure API delivery, or measure browser rendering. Those omissions must be shown
as unavailable rather than inferred from unrelated timestamps.

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
