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
- bounded observer, coalescing, failure, cache, and revision counters; and
- bounded aggregate duration summaries.

It must never contain transcript paths, filenames, source fingerprints, session IDs or
titles, prompts, responses, reasoning, commands, patches, stdout, stderr, tool results,
credentials, provider-native records, arbitrary error text, or checkpoint contents.

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
