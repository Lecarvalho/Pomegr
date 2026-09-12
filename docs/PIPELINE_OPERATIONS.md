# Pipeline operations monitor

> Scope: development-only, anonymous pipeline diagnostics.
> Authority: operational contract for the continuous JSONL diagnostics path.

Pomegr continuously writes bounded local JSONL diagnostics during normal development. This is an engineering diagnostic, not product evidence, a dashboard metric, or an efficiency judgment. Perfetto has been removed; there is no setup, capture, export, viewer, SQL query, comparison, or benchmark mode.

## Continuous development JSONL logs

Before provider observation begins, development creates one writer in ignored
`outputs/pipeline-logs/`. It owns only its generated files, assumes one writer, retains at
most ten 25 MiB files (250 MiB total), never follows symlinks, and never deletes files it
does not own. Records queue to at most 1 MiB; an active drain batch is separately bounded
to 1 MiB. A record is at most 64 KiB. Startup, retention, rotation, and append failures
degrade diagnostics only and cannot change acquisition, normalization, scheduling,
persistence, publication, or committed evidence.

Each record has fixed schema version 1, a fresh diagnostic-local run UUID, an ISO observation
time, and one of `span_start`, `span`, `flow`, `counter`, `health`, `gap`, or `lifecycle`.
It may contain only allowlisted stages, domains, outcomes, counters, synthetic lanes, opaque
numeric flow/revision/scope handles, and bounded timing/count data. A `span_start` without a
settled span is unfinished, not failed. `gap` records report observed writer or instrumentation
loss with a fixed reason. Retention, malformed records, partial lines, rotation, limits, missing
files, and gaps reduce coverage; they never prove complete session history or a cause.

`session_projection` is a derivation substage for the normalized browser-safe session projection;
it excludes optional repository association, which must never delay publication.
Its `session_capabilities` and `session_state_projection` children distinguish capability
resolution from deterministic projection without adding source or session identity.
Checkpoint diagnostics classify a failed write only as validation, privacy, collection,
candidate, size, or storage; they never record an exception message, checkpoint path, or
session identity.

Logs must never contain session IDs or selectors, source paths or fingerprints, prompts,
responses, reasoning, transcript or tool content, commands, output, credentials,
provider-native payloads, or raw errors. They never enter checkpoints, browser state, reports,
HTTP, or renderer IPC.

Analyze or follow existing files from the repository root:

```powershell
npm run diagnostics:logs -- --since 1h
npm run diagnostics:logs -- --follow
npm run diagnostics:analyze -- --since 1h
```

`diagnostics:analyze` is a compatibility alias for the same passive JSONL analyzer.
The analyzer validates fixed records, bounds file/byte/line/pending-span/history/follow output,
does not contact the monitor, and cannot trigger provider work, scheduling, checkpoint writes,
or publication. Follow starts at current EOF, serializes polls, and reports partial or missed
rotation coverage. Partial lines retain independent bounded bytes across reads. Each poll
reports bounded malformed and oversized record counts and reduces coverage when either is
nonzero; intentional timestamp or stage filtering is not a coverage loss. Coverage describes
only that poll, never a complete session.

## Auxiliary current snapshot

`npm run diagnostics:snapshot` reads a bounded current operations snapshot through private local
IPC. It is read-only, in-memory, and not a browser API. It cannot acquire provider data or
trigger normalization, derivation, persistence, or publication. Its worker counters and rolling
timing windows are current diagnostic observations, not throughput, token usage, billing, CPU
utilization, or a performance score. Durations are wall time and can include asynchronous waits.

The snapshot may expose only fixed provider IDs, bounded counters, allowlisted failure categories,
sanitized failure summaries, bounded operation timing samples, and response revisions. Raw errors,
paths, source/session identity, prompts, responses, credentials, and provider payloads remain
monitor-private. It is auxiliary current health; retained JSONL is the sole historical diagnostics
path.

## Development and build boundary

The generic monitor-private instrumentation emits only the fixed JSONL vocabulary and opaque
correlations needed for the writer. It retains no diagnostic event history and exposes no capture
endpoint. Browser presentation timing and renderer telemetry are not collected. Production and
desktop builds exclude the continuous writer and its development composition; browser and LAN
traffic cannot start, stop, configure, or read diagnostic facilities.

## Verification

Use focused checks after changing diagnostics:

```powershell
npm run test:diagnostics
node --test tests/provider-observation.test.mjs tests/session-observation-coordinator.test.mjs
npm run check:architecture
npm run check:boundaries
```

Inspect coverage, gaps, pending starts, and sample counts before interpreting timings. Missing
records are unavailable evidence, not proof of success, failure, or a causal relationship.
