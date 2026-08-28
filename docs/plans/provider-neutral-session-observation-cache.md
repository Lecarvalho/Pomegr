# Provider-neutral session observation, cache, and progressive loading plan

> Status: implemented and repository-verified on 2026-08-28.
>
> Historical implementation record only. The durable operational contract now lives in
> `docs/OBSERVATION_CACHE.md`, with repository-wide invariants in `AGENTS.md`. Do not use
> this plan as runtime authority. It records the agreed replacement for request-driven
> provider parsing and the decisions that led to the implemented contract.

## Objective

Move provider discovery, incremental ingestion, normalization, and enrichment ahead of
browser requests so that `/api/state`, `/api/sessions`, and `/api/home` serve already-built,
immutable snapshots. Historical normalized evidence must not disappear merely because its
raw source record has moved outside a live-read window or because a source was observed
during a partial write.

The resulting system must:

- continuously ingest provider-owned source changes in the background;
- retain bounded normalized evidence independently of source read-window sizes;
- publish only complete, validated snapshot revisions;
- keep the last known-good revision visible while a replacement is being built;
- recover quickly across monitor restarts without persisting raw provider content;
- let independently produced UI regions become ready independently; and
- preserve the existing privacy and provider-normalization boundaries.

## Problem statement

The current browser refresh path calls provider session analysis. Provider adapters then
read transcript tails, merge some evidence into process-local caches, and project the
result. The dashboard polls live session state frequently, so bounded reads were introduced
to avoid repeatedly parsing complete, potentially large, multi-agent sessions.

That optimization currently conflates two separate concerns:

1. how much new provider data should be read during one update; and
2. how long previously normalized evidence should remain available.

The distinction breaks when a cache generation cannot be reused. A tail-only parse can
replace a previously complete normalized cache even though the provider transcript still
contains the older evidence. Increasing a tail from 512 KiB to another fixed size only
postpones the same failure for longer sessions.

Home aggregation has a related coupling problem. Provider usage limits may already be
available, but the UI waits for slower session/request correlation before rendering the
combined usage-and-activity region. Readiness is currently expressed too coarsely.

## Locked design decisions

- The monitor owns a provider-neutral observation store and observer lifecycle.
- Provider adapters own source discovery, native schemas, incremental parsing, evidence
  upgrades, and privacy filtering.
- Raw provider records never enter the shared observation store.
- Browser GET requests never open or parse provider transcripts.
- GET requests read the latest committed normalized snapshot and may reuse its prebuilt
  serialized representation.
- Existing cached data remains visible during refresh, revalidation, and staged rebuilds.
- Skeletons are used only where no committed data exists for that specific UI region.
- Loading, ready-empty, unsupported, and confirmed-unavailable are distinct states.
- Provider usage limits and local session/request correlation have independent readiness.
- A source read or chunk limit controls ingestion cost only; it never controls normalized
  evidence retention.
- The browser API remains provider-neutral. Provider-native source schemas remain inside
  `monitor/providers/`.

## Target architecture

```text
Claude source observer ─┐
Codex source observer  ─┼─ normalized candidate revisions ─▶ SessionObservationStore
Future observer        ─┘                                      │
                                                               ├─ committed evidence
Background Git/resource/usage observers ───────────────────────┤
                                                               ├─ readiness by region
                                                               └─ serialized snapshots
                                                                      │
                                            /api/sessions ─────────────┤
                                            /api/home ─────────────────┤
                                            /api/state ────────────────┘
                                                                      │
                                                                 frontend render
```

The shared layer coordinates lifecycle and publication but does not understand Claude,
Codex, JSONL, app-server records, or any future provider-native format. A provider may
watch files, poll a local API, or subscribe to a native event source without changing the
store or browser contract.

## Pipeline terminology

Use these phase names consistently in implementation, tests, diagnostics, and future
design discussions:

- **U1 — Acquisition:** backend provider code reads raw provider-owned files, events, or
  APIs.
- **U2 — Normalization:** the backend adapter converts complete native records into
  bounded normalized evidence.
- **C — Commit:** the backend atomically writes validated normalized evidence into the
  in-memory committed cache.
- **D — Derivation:** the backend consumes committed normalized evidence to build public
  session, catalog, Home, or correlation snapshots.
- **P — Persistence:** the backend copies committed normalized state into durable
  privacy-filtered checkpoint files.
- **S — Serving:** backend API handlers read committed serialized snapshots and never
  parse raw provider data.
- **F — Presentation:** the frontend calls APIs and renders their responses.

Cache names:

- **L1 evidence cache:** committed normalized session evidence held in backend memory.
- **L1 response cache:** committed pre-serialized API snapshots held in backend memory.
- **L2 checkpoint cache:** privacy-filtered persistent JSON used only for restart recovery.
- **Frontend view state:** current React state; it is not a source-of-truth cache.

A frontend request may request or prioritize hydration for an uncached session, but it
cannot perform hydration synchronously. The serving path checks L1, queues an observer
command when needed, and returns the current snapshot or loading readiness. The observer
then performs U1, U2, C, and D independently.

## Provider observation contract

Extend the provider contract with an observation lifecycle rather than making
`readSession` perform ingestion. The exact API may evolve during implementation, but the
responsibilities should remain equivalent to:

```ts
interface ProviderObserver {
  start(publisher: NormalizedObservationPublisher, signal: AbortSignal): Promise<void>;
  hydrate(localSessionId: string): Promise<void>;
  listSessions(): Promise<ProviderSessionMetadata[]>;
}

interface NormalizedObservationPublisher {
  publishCatalog(providerId: ProviderId, entries: ProviderSessionMetadata[]): void;
  publishSession(providerId: ProviderId, localSessionId: string, candidate: ProviderSessionEvidence): void;
  invalidateSession(providerId: ProviderId, localSessionId: string, reason: BoundedInvalidationReason): void;
}
```

Only normalized values accepted by `provider-contract.mjs` may cross `publishSession`.
The store validates each candidate before committing it. A rejected candidate leaves the
previous committed revision untouched.

`readSession` may remain temporarily as a compatibility operation while adapters migrate,
but its final responsibility is retrieving provider-private normalized state rather than
parsing source data on demand.

## Observation and publication lifecycle

### Startup

1. Start the loopback monitor and provider observers.
2. Load compatible persistent checkpoints into the in-memory store.
3. Make those committed snapshots immediately readable by the API.
4. Discover current provider sessions and source generations.
5. Validate cached source fingerprints in the background.
6. Continue incrementally when a source is compatible; otherwise stage a complete rebuild.
7. Atomically publish the rebuilt revision only after normalization and contract validation.

A cold session with no checkpoint exposes catalog metadata and per-region `loading`
readiness while its first normalized snapshot is built.

### Incremental updates

Each provider source maintains provider-private ingestion state containing:

- a source identity suitable for detecting replacement;
- the byte or provider-event offset after the last committed complete record;
- bounded structural continuity evidence;
- an unfinished final-record fragment held in memory only; and
- provider-specific reducers or normalized candidate state.

For append-only sources, observers read every byte after the committed offset in bounded
chunks. A chunk size is not a history window: multiple chunks are consumed until the
observer reaches the source's confirmed end.

### Partial writes

- Parse only complete provider records.
- Retain an unfinished final fragment in memory.
- Keep the committed offset at the fragment's beginning.
- Never persist the fragment because it may contain private raw content.
- After restart, reread from the last complete-record offset.

### Evidence upgrades

Some facts become stronger when later records arrive. Providers must use stable internal
identities and deterministic upsert rules. For example, a compaction may progress from an
ambiguous boundary to a supported automatic or manual classification. Later incomplete
evidence must not downgrade a stronger committed observation.

### Truncation, replacement, and discontinuity

When identity, size, continuity, or an authoritative provider generation proves that a
source is not append-compatible:

1. keep serving the last committed snapshot;
2. build a replacement index separately from the visible revision;
3. validate the replacement source from its beginning or authoritative checkpoint;
4. normalize and validate the complete candidate; and
5. atomically swap revisions.

A failed rebuild never publishes a tail-only or partially reconstructed replacement.

Filesystem watcher notifications are wake-up hints, not completeness evidence. Observers
must periodically reconcile known live sources because notifications may be missed,
duplicated, or coalesced across platforms.

## Cache design

### Tier 1: in-memory committed snapshot store

The runtime-authoritative cache is a provider-neutral map keyed by qualified session ID:

```ts
type CachedSessionSnapshot = {
  revision: number;
  readiness: SessionReadiness;
  evidence: ProviderSessionEvidence;
  publicState: MonitorState;
  serializedState: string;
  observedAt: string;
};
```

Properties:

- immutable, copy-on-write revisions;
- atomic publication after provider-contract validation;
- prebuilt normalized projection and serialized JSON for inexpensive GET responses;
- last known-good retention while updates are pending;
- live and selected sessions eligible for pinning in memory; and
- least-recently-used pruning of unpinned historical sessions toward the configured entry
  and byte targets.

The implementation must measure representative state sizes before locking the historical
entry count or byte budget. The limit must be based on normalized cache size, not raw
transcript size.

### Tier 2: persistent normalized checkpoints

Use schema-versioned, atomic JSON checkpoint files under Pomegr's own data directory.
JSON is preferred initially because normalized state is bounded, inspectable, directly
privacy-auditable, and avoids a native database dependency in Node/Electron packaging.

A checkpoint may contain only:

- cache schema version;
- provider and normalized local session identity;
- provider-private bounded source fingerprints;
- offsets after the last complete committed record;
- normalized bounded provider evidence;
- readiness state;
- committed revision and observation timestamps.

A checkpoint must never contain:

- raw provider records or transcript lines;
- incomplete record fragments;
- prompts, responses, reasoning, commands, patches, stdout, stderr, or tool-result content;
- credentials, OAuth data, provider account identifiers, or raw diagnostics; or
- browser-visible transcript paths.

Writes are debounced and use temporary-file creation followed by atomic replacement.
Checkpoint corruption, unknown schema versions, failed validation, or incompatible source
fingerprints cause the checkpoint to be ignored and rebuilt. Checkpoints are always an
optimization; provider-owned sources remain the source of truth.

If measurements later demonstrate that atomic JSON rewriting is insufficient, the storage
implementation may move behind the same cache interface to SQLite. Do not introduce a
native database dependency before those measurements exist.

### Browser and HTTP caching

Do not use browser storage, service-worker storage, or shared HTTP caches for session
state. Browser requests remain `no-store`. The server may retain the serialized response
for each committed revision and write it directly to the response without rebuilding the
state.

## Cache-write and UI-consumption cadence

Disk persistence, in-memory publication, API serving, and frontend polling are independent
schedules. A browser request never controls provider acquisition, normalization, evidence
retention, or checkpoint writes.

| Item | Owner | Phase | Input | Cache relationship | Cadence |
| --- | --- | --- | --- | --- | --- |
| Provider source-change ingestion | Backend adapter | U1 | Raw provider files, events, or API | Produces complete records for normalization; does not directly mutate a committed cache | Wake immediately from a provider event or filesystem notification |
| Provider safety reconciliation | Backend adapter | U1 | Raw source metadata and unread bytes/events | Repairs missed acquisition notifications and may produce records for normalization | Every 10 seconds for live sources |
| Provider normalization | Backend adapter | U2 | Complete provider-native records | Builds a private normalized candidate; never publishes partial state | Immediately after acquisition |
| Normalized snapshot publication | Backend observation store | C | Validated normalized candidate | Writes a new immutable revision to L1 evidence | Implemented as a 500 ms coalesce after a candidate arrives; watcher wakes are immediate and missed events use the 10-second reconciliation ceiling |
| Public session projection | Backend monitor | D | L1 evidence plus independently committed Git, resource, and usage state | Reads committed inputs and writes the L1 `/api/state` response cache | After a relevant committed dependency changes, using the same 500 ms coalescing ceiling |
| Home correlation builder | Backend monitor | D | L1 session summaries and provider-limit state | Reads committed inputs and writes independent per-limit Home correlation revisions | After relevant session/request or provider-limit evidence changes; coalesce for 500 ms |
| Routine persistent checkpoint | Backend checkpoint writer | P | Latest committed L1 evidence | Reads L1 and atomically writes L2; never reads raw provider data | Five seconds after activity becomes quiet; at least once every 60 seconds during continuous activity |
| Graceful-shutdown checkpoint | Backend checkpoint writer | P | Latest committed L1 evidence for pending checkpoints | Reads committed L1 and atomically writes L2 | Implemented before observer shutdown; the proposed compaction, completion, and pre-eviction triggers were not retained as V1 guarantees |
| `/api/state` handler | Backend API | S | Qualified session ID and optional current revision | Reads only the L1 response cache | Only when called by the frontend |
| `/api/sessions` handler | Backend API | S | Catalog request and optional current revision | Reads only the committed catalog response cache | Only when called by the frontend |
| `/api/home` handler | Backend API | S | Home request and optional current revision | Reads only the committed Home response cache | Only when called by the frontend |
| Selected live session refresh | Frontend | F | `/api/state` | Consumes the L1 response through the API and updates frontend view state | Every 2 seconds |
| Uncached or loading session refresh | Frontend | F | `/api/state` | Consumes loading or partial readiness and never fills backend cache directly | Every 1 second until required regions become ready |
| Cached historical session | Frontend | F | `/api/state` | Consumes one committed immutable response | Fetch once, then stop |
| Uncached historical session | Frontend plus observer scheduling | F to observer command | Initial `/api/state` result | Serving queues asynchronous hydration without parsing raw data; frontend polls L1 | Every 1 second until ready, then stop |
| Sidebar and catalog refresh | Frontend | F | `/api/sessions` | Consumes the catalog response cache | Every 5 seconds |
| Home with unresolved regions | Frontend | F | `/api/home` | Consumes a partial committed Home response; skeletons represent missing revisions | Every 1 second |
| Home ready with live sessions | Frontend | F | `/api/home` | Consumes the committed Home response cache | Every 5 seconds |
| Home ready without live sessions | Frontend | F | `/api/home` | Consumes the committed Home response cache | Every 30 seconds |
| Hidden browser tab | Frontend | F | Relevant API | Consumes committed responses less frequently and does not alter backend ingestion | Every 30 seconds |
| Navigation or return to foreground | Frontend | F | Relevant API | Immediately consumes the newest committed response | Fetch immediately |
| Unchanged revision | Backend API | S | Frontend's current revision | Reads the response-cache revision and returns no state body | Return `204 No Content` |

Failed frontend calls back off approximately 2, 5, 10, then 30 seconds. Polls are
scheduled after the preceding response completes, aborted on navigation, and never overlap.
Existing committed data remains visible throughout refresh and error backoff.

## Provider-neutral readiness contract

Do not infer loading from `null`, zero, or empty arrays. Add explicit bounded readiness to
normalized Home and session state:

```ts
type Readiness = "loading" | "ready" | "unavailable";

type HomeReadiness = {
  catalog: Readiness;
  providerLimits: Record<ProviderId, Readiness>;
  limitActivity: Record<string, Readiness>; // qualified provider + limit identity
  sessionSummaries: Record<string, Readiness>; // qualified session identity
};

type SessionReadiness = {
  core: Readiness;
  agentEvidence: Readiness;
  contextEvidence: Readiness;
  activityEvidence: Readiness;
  repository: Readiness;
  resources: Readiness;
  usageLimits: Readiness;
};
```

The final keys should follow actual independently produced backend jobs rather than every
visual widget. Provider capability status continues to express `supported` or
`unsupported`; readiness expresses whether supported evidence is still loading, ready, or
confirmed unavailable.

When a previous value exists, background refresh does not change its readiness to
`loading`. The committed value remains `ready` until a replacement is published or the
source is authoritatively unavailable.

## UI behavior

### Shared loading rules

- Skeletons appear only for a region with no committed value and readiness `loading`.
- Existing committed data is never replaced by a skeleton during refresh.
- `ready` with no records shows the normal factual empty state.
- `unavailable` shows a fixed error state only after the backend confirms failure.
- Unsupported sections follow capability behavior and never masquerade as loading.
- Skeletons match final component geometry to prevent large layout shifts.
- Skeleton colors are neutral; green, amber, lavender, and red remain reserved for
  semantic evidence.
- Motion is a restrained opacity pulse. Reduced-motion users receive static placeholders.
- Skeleton shapes are `aria-hidden`; the containing region uses `aria-busy="true"` and one
  visually hidden status announcement rather than repeated live-region messages.

### Home

Home renders these domains independently:

1. session catalog;
2. usage limits per provider;
3. session/request correlation per usage-limit row; and
4. summary enrichment per live session.

Provider usage cards and bars appear as soon as their provider limits are ready. The
activity lane beneath each bar reserves its final geometry and shows a neutral skeleton
until that specific limit's correlation is ready. One slow provider or limit must not
delay another.

Session cards appear as soon as catalog metadata exists. Real title, project, provider,
activity state, and navigation remain visible. Unresolved agent totals, context totals, or
progress enrichment use compact skeletons in their final positions.

On a true catalog cold start, Home shows a bounded session-grid skeleton rather than a
visible loading sentence. Ready-empty and confirmed-offline states retain factual copy.

### Sidebar

- A true catalog cold start shows several fixed-height skeleton rows and skeleton counts.
- A discovered session immediately becomes a real selectable row, even when its detailed
  session snapshot is not ready.
- Existing rows remain visible during background catalog refresh.
- Sidebar counts never show a misleading zero while readiness is unknown.
- Selecting an uncached row navigates immediately to that session's shell and detail
  skeletons.

### Individual session

A cached session renders immediately. Background refresh is visually silent unless a
confirmed failure changes availability.

For an uncached session:

- render the application shell and known catalog identity immediately;
- show the target session's real title, project, provider, and liveness when available;
- use panel-shaped skeletons for unresolved evidence domains;
- replace each independent region as its committed revision becomes ready; and
- never leave the previously selected session visible underneath the new route.

Usage limits, repository state, resource usage, and provider-normalized session evidence
may resolve independently. Within provider-normalized evidence, readiness granularity
should match actual observer publication boundaries rather than create a status for every
React component.

## API behavior

### Endpoint ownership

The proposed public endpoint set has four independently cached domains:

1. `/api/sessions` — provider-neutral catalog used by the application shell and sidebar;
2. `/api/state?sessionId=...` — one selected session's normalized state;
3. `/api/home` — cross-session derived summaries and per-limit local activity correlation;
4. `/api/usage-limits` — provider/account-scoped usage-limit state shared by Home and
   individual session views.

`/api/usage-limits` is the remaining design decision. The recommended direction is to
centralize it because provider usage is account-scoped, has its own authenticated retrieval
and refresh cadence, and is not owned by any session or by Home. Home and session pages
should consume the same frontend usage store rather than receive duplicated copies from
their page-specific endpoints.

The Home derivation may consume provider usage internally to choose correlation windows,
but `/api/home` should return only the derived activity/correlation result and its matching
provider-limit revision. The frontend renders correlation only when that revision matches
the centralized usage snapshot; otherwise the correlation lane remains a skeleton until
the Home derivation catches up.

During migration, existing `usageLimits` fields may remain temporarily in `/api/state` and
`/api/home` for compatibility. Remove them only after both surfaces use the shared usage
client and serialization/privacy coverage has been updated.

### `/api/state`

- Resolve the qualified session ID.
- Read the latest committed public snapshot from `SessionObservationStore`.
- Return its prebuilt serialized representation.
- Never open, seek, or parse a provider transcript in the request path.
- If the session is known but uncached, return catalog identity plus readiness states while
  background hydration proceeds.

### `/api/sessions`

- Return the latest committed provider catalogs.
- Do not wait for detailed session hydration.
- Include only normalized catalog readiness needed to distinguish a true zero from a cold
  catalog.

### `/api/home`

- Return one coherent snapshot that may contain independently ready regions.
- Do not wait for limit-activity correlation before returning available provider limits.
- Publish correlation revisions as background session summaries and request observations
  become available.

The frontend may continue polling initially. A future event stream can reduce redundant
GETs, but transport changes are outside this plan and must not delay decoupling ingestion
from reads.

### `/api/usage-limits` (proposed)

- Return the latest committed provider-scoped usage snapshot and readiness per provider.
- Read only the shared provider-usage L1 response cache.
- Never trigger an authenticated provider request synchronously.
- Let the backend usage coordinator keep its single-flight, cooldown, stale-value, and
  sanitized-failure behavior.
- Let a shared application-level frontend provider fetch once for both Home and session
  routes.
- While initially loading, poll every second; once ready, poll every 60 seconds and refresh
  immediately when the window regains focus.
- Return `204 No Content` when the caller's provider-usage revision is unchanged.

## Privacy, security, and correctness safeguards

- Keep provider-native schemas and raw records inside their adapters.
- Validate every published candidate through the executable provider contract.
- Persist only fields already permitted inside normalized provider evidence plus bounded
  monitor-private source fingerprints and offsets.
- Add checkpoint privacy scans using the same hostile sentinels as browser serialization
  tests.
- Never include raw transcript paths in cache filenames, persisted payloads, logs, error
  messages, or browser responses. Use safe provider/session identities or hashes for cache
  filenames.
- Keep the monitor loopback-bound and browser state normalized.
- Pomegr-owned cache writes do not mutate provider sources and remain compatible with the
  read-only observation promise.
- Bound record fragments, normalized collections, cache entries, persistent bytes, and
  reconciliation concurrency.
- A malformed or oversized record degrades its provider-specific evidence safely without
  publishing private exception data.
- Provider failures remain isolated; one observer cannot block publication from another.

## Implementation milestones

### POMEGR-OBS-01 — Shared observation contract and committed store

- [x] Add provider-neutral observer lifecycle types and executable validation.
- [x] Implement `SessionObservationStore` with atomic immutable revisions, last-known-good
  retention, serialized-state reuse, and bounded memory accounting.
- [x] Start and stop observers with the monitor lifecycle.
- [x] Keep the existing request-driven provider operations behind a temporary compatibility
  seam.
- [x] Add contract, lifecycle, concurrency, rejection, and provider-isolation tests.

### POMEGR-OBS-02 — Incremental provider ingestion

- [x] Implement provider-private source cursors, complete-record framing, partial-fragment
  retention, reconciliation, and staged rebuilds for each supported adapter.
- [x] Keep Claude and Codex schemas inside their adapter modules.
- [x] Ensure every appended byte is eventually consumed even when more than one ingestion
  chunk arrives between observations.
- [x] Preserve deterministic evidence upgrades and stable identities.
- [x] Remove transcript parsing from production GET paths after both adapters conform; the
  compatibility `readSession` operation remains adapter-private and observer-driven.

### POMEGR-OBS-03 — Persistent normalized checkpoints

- [x] Define a versioned, bounded checkpoint schema.
- [x] Implement privacy-filtered atomic JSON persistence, startup loading, validation, and
  pruning.
- [x] Keep incomplete raw fragments memory-only and resume at the last complete offset.
- [x] Instrument checkpoint size and write frequency with monitor-private QA counters; use a
  five-second quiet debounce and a 60-second continuous-activity maximum, with bounded
  retention values remaining configurable.
- [x] Add corruption, unknown-version, replacement, restart, cadence, and privacy tests.

### POMEGR-OBS-04 — Progressive Home readiness

- [x] Extend the Home contract with provider- and limit-scoped readiness.
- [x] Publish provider limits without waiting for correlation.
- [x] Publish session summaries independently and recompute bounded correlations in the
  background.
- [x] Add geometry-matched skeletons for cold catalog, card enrichment, and correlation
  lanes.
- [x] Preserve factual ready-empty and confirmed-unavailable states.

### POMEGR-OBS-05 — Sidebar and session progressive rendering

- [x] Add catalog skeleton rows and unknown-count placeholders without blocking navigation.
- [x] Make discovered sessions selectable before detailed hydration completes.
- [x] Render cached session snapshots immediately.
- [x] Render catalog identity plus per-domain panel skeletons for uncached sessions.
- [x] Prevent the previously selected session from remaining visible after route selection.
- [x] Verify keyboard, screen-reader, reduced-motion, narrow-screen, and layout-shift behavior.

### POMEGR-OBS-06 — Migration, metrics, and release verification

- [x] Remove request-triggered transcript parsing from production GETs and retain only the
  adapter-private reducer continuity state still required during U2 normalization.
- [x] Add monitor-private ingestion, publication, cache-hit, rebuild, checkpoint, and memory
  QA counters without exposing source paths or raw evidence.
- [x] Update architecture, metrics, configuration, and troubleshooting documentation.
- [x] Verify state serialization contains no raw or provider-private values.
- [x] Run focused provider, API, Home, sidebar, and session UI tests, followed by the required
  repository build and full test workflow.

## Required regression tests

### Observation and cache

- A structural event remains visible after its source record leaves any ingestion chunk.
- A final provider record split across multiple writes is parsed exactly once when complete.
- A source can grow by more than one chunk between observations without an evidence gap.
- A continuity mismatch never replaces a complete cache with a tail-only candidate.
- Truncation and replacement do not mix evidence from different source generations.
- Stronger later evidence upgrades rather than duplicates an existing observation.
- Concurrent GETs perform no provider transcript reads.
- Restart restores a compatible normalized checkpoint and continues from its complete-record
  offset.
- An invalid checkpoint is ignored and rebuilt without becoming visible.
- Cache files and browser responses contain none of the privacy sentinels.

### Progressive readiness

- Provider usage bars render while their activity correlation remains loading.
- Correlation readiness is independent per provider and per limit.
- Session catalog rows render before detailed session summaries.
- Unknown sidebar counts do not render as zero.
- Cached session navigation renders without skeletons.
- Uncached session navigation never displays the previous session under the new route.
- Only unresolved regions show skeletons, and ready-empty regions show factual empty states.
- Existing evidence remains visible during refresh and transient observer failures.
- Reduced-motion mode disables skeleton animation.
- Skeletons are hidden from the accessibility tree while their regions report busy state.

## Performance verification

Measure rather than assume acceptable limits:

- time to first committed catalog after cold start;
- time to first committed selected-session snapshot with and without a checkpoint;
- appended bytes and records processed per observer wake-up;
- GET latency and transcript-read count;
- normalized memory per live and historical session;
- serialized snapshot size;
- checkpoint write frequency and bytes;
- staged rebuild duration for representative long, multi-agent sessions; and
- Home time-to-usage-bar versus time-to-correlation.

The acceptance target is structural: GET latency and I/O must be independent of raw
transcript length once a committed snapshot exists.

## API and compatibility implications

- The browser state gains provider-neutral readiness metadata; existing normalized evidence
  shapes remain unchanged wherever possible.
- Capability status remains separate from readiness.
- During migration, old adapters may use the compatibility read path, but the registry must
  not claim observer-backed readiness for them.
- Historical views continue to exclude current Git state and usage limits.
- Existing report generation consumes only committed normalized snapshots and must never
  interpret skeleton/loading state as zero evidence.

## Resolved implementation defaults

The implementation selected the following V1 defaults. The durable authority for these
values and their semantics is `docs/OBSERVATION_CACHE.md`:

- L1 evidence pruning targets: 100 entries and 8 MiB, with pinned entries protected and an
  individual entry over 8 MiB rejected;
- L2 checkpoint retention: 100 entries and 16 MiB;
- checkpoint cadence: five seconds after quiet and at least once per 60 seconds during
  continuous committed activity, plus pending committed checkpoint writes on shutdown;
- observer reconciliation: 10 seconds with default concurrency 2;
- incremental acquisition chunk: 64 KiB;
- maximum memory-only incomplete-record fragment: 256 KiB; and
- revisioned snapshot GETs remain the V1 transport; an event stream is not required.

Operational values may evolve with measurement, but changes must update the canonical
contract and preserve the central correctness rule: a raw-source read bound cannot erase
committed normalized evidence, and an incomplete replacement cannot displace the last
known-good revision.
