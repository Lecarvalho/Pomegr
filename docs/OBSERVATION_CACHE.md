# Observation cache and progressive readiness contract

This document is the canonical operational contract for Pomegr's provider-neutral
session observation cache, API serving model, and progressive UI readiness. Design plans
under `docs/plans/` are historical records; when a plan and this document differ, this
document and `AGENTS.md` govern repository changes.

## Non-negotiable invariants

- Provider acquisition and normalization run before and independently of browser GETs.
- Background acquisition and normalization must yield between bounded chunks and session
  hydration units so the monitor's cache-serving event loop remains responsive.
- Production `/api/sessions`, `/api/state`, `/api/home`, `/api/usage-limits`, `/api/agents`, `/api/provider-status`, `/api/repositories`, and `/api/repository-inventory` handlers
  read only committed response caches. They never open, seek, or parse provider
  transcripts and never synchronously call a provider usage or session-status service.
- A serving request may enqueue asynchronous hydration for a known uncached session, but
  it returns the current committed response or explicit loading readiness immediately.
- A raw-source chunk or tail limit bounds one acquisition operation only. It never defines
  normalized evidence retention and must not make older committed evidence disappear.
- Only complete, validated normalized candidates can replace a committed revision.
  Refreshes, transient failures, partial writes, and staged rebuilds retain the last
  known-good revision.
- Raw provider records and provider-native schemas remain adapter-private. Shared monitor
  state, checkpoints, APIs, and React components remain provider-neutral.
- UI regions become ready independently. A skeleton represents only a region that has no
  committed value and is still loading; it never replaces already-rendered data.
- Provider/account usage limits and local session/request correlation are separate cached
  domains with separate readiness and revisions.
- The monitor-private agent-query API serves only committed, privacy-filtered query
  projections. Its GETs cannot acquire providers, hydrate sessions, parse transcripts,
  refresh usage, or derive a response from raw evidence.

## Pipeline terminology and ownership

Use these names in code, tests, diagnostics, and architecture discussions:

| Phase | Owner | Consumes | Produces or writes |
| --- | --- | --- | --- |
| **U1 — Acquisition** | Backend, provider adapter | Raw provider-owned files, events, or APIs | Complete native records and adapter-private cursor state; no committed cache mutation |
| **U2 — Normalization** | Backend, provider adapter | Complete provider-native records | Bounded, privacy-filtered normalized candidate evidence |
| **C — Commit** | Backend, shared observation store | A validated normalized candidate | One immutable L1 evidence revision |
| **D — Derivation** | Backend, monitor jobs | Committed L1 evidence plus independently committed Git, resource, and usage state | Public session, catalog, Home, correlation, or usage response revisions |
| **P — Persistence** | Backend, checkpoint writer | Committed L1 evidence | Privacy-filtered L2 checkpoint JSON |
| **S — Serving** | Backend, API handlers | Committed L1 response revisions | A response body, loading shell, or `204 No Content`; never normalized evidence |
| **F — Presentation** | Frontend, React | Provider-neutral API responses | Frontend view state and independently rendered regions |

U1 and U2 are the upstream raw-data boundary. C, D, P, and S are downstream consumers of
normalized state. P writes the durable cache; S only consumes committed response caches.
F consumes the browser API and never fills or owns a backend cache.

## Agents analytics

Agents is an independent D Derivation and S Serving domain. Its background job reads
only committed normalized session snapshots and the committed session catalog. It
cannot hydrate sessions, open transcripts, consult provider APIs, or initiate upstream
work. Historical evidence that has not been retained remains unavailable.

The job prepares bounded responses for each supported project, 7/30/90-day window,
and main/delegated/all scope. A derivation uses one captured evidence set and clock,
yields between bounded batches, and publishes a validated replacement atomically.
Relevant evidence changes coalesce to at most one attempt per minute; time-window
boundaries also invalidate affected selections. Failed attempts retain the last
successful summary and retry with the same bounded cadence. Removed selections
are pruned so response-cache growth stays bounded. A domain-wide monotonic revision
sequence prevents a removed and re-added selection from reusing an old revision;
in-process observation restarts preserve the committed variants.

GET /api/agents only selects and serves a committed response. It accepts project,
days, scope, and an optional numeric revision. It never computes aggregates, creates
cache entries, or schedules provider hydration. The same-origin proxy forwards only
these parameters and preserves no-store and unchanged 204 responses. Each response
contains selection provenance, independent revision, generation time, readiness,
coverage, precomputed model/role/work summaries, bounded supporting runs, and a
stable parent-before-child live roster. The historical start-date filter does not
exclude agents from the live roster.

The browser polls the selected response every minute while visible, serializes requests,
refreshes on focus, and aborts abandoned selections. During a filter change, presentation
retains one displayed response and its applied project, period, and scope controls until
the requested response is ready; the controls and evidence then change together. A response
for a previous selection cannot appear beneath new applied filters. This is transient
display state, not a browser cache of analytics variants. Requests still target the latest
requested selection, and abandoned responses cannot replace the display. Slow selection
changes show feedback after 300ms; failures show explicit retry feedback while retaining
the applied selection. Routine refreshes do not insert banners or toggle header labels.
Refresh and network failures retain visible data;
a skeleton is used only before the first committed summary. An old generatedAt alone
does not imply failure: unchanged evidence does not require a new derivation. Backend
refreshReadiness distinguishes a failed refresh from an unchanged successful summary.

Initial Agents loading includes visible guidance to check back later and explains the
automatic refresh on return. A committed Models & work summary with no runs and missing
session evidence shows a compact waiting state with an indeterminate loader and check-back
guidance instead of suggesting different filters or displaying zero totals. The loader
stops for reduced motion or a disconnected monitor. This is missing coverage, not proof
of active hydration; the past-session caveat remains in About this data. A complete empty selection
keeps the filter guidance, and retained results stay visible during refreshes.

Coverage describes retained evidence, not complete source history. Missing sessions,
unknown model/role metadata, and bounded evidence are disclosed. The endpoint exposes
only the normalized Agents contract; it includes no raw provider kind, source path,
prompt, response, command, tool output, credentials, cumulative tokens, or billing.
It adds no checkpoint schema or durable analytics ledger.


## Public provider service status

Public service status is an independent observation domain, not session evidence,
account authentication, usage limits, or a measurement of an individual request.
It starts and stops with `createObservationRuntime` but never enters the transcript
worker queue, session store, Home derivation, or checkpoint writer.

- U1 reads fixed official public status endpoints through the provider registry.
  Provider adapters own component mappings, response byte/item bounds, API formats,
  timeout/cancellation and redirect rejection. Requests carry no OAuth credentials,
  session identifiers, prompts, or inference traffic.
- U2 emits only bounded provider-neutral health, update times, and up to eight
  relevant public incidents. C validates the complete candidate, then D produces an
  immutable response with its own revision. Updates never revise session evidence.
- Each provider checks immediately in the background on startup, every five minutes
  normally, and every minute while a relevant incident, degradation, outage, or
  active maintenance is reported. Timers add at most ten percent jitter. Failures
  back off through one, two, five, and ten minutes; work for one provider is serialized
  and never blocks the other. Each acquisition is bounded by a ten-second deadline.
- A failed or rejected replacement retains the last successful status, incidents,
  and `checkedAt`, while marking observation readiness unavailable. A separate timer
  commits stale freshness after fifteen minutes without a successful check, even
  during backoff. A failed request is never evidence that the provider is down.
- S serves only the committed `/api/provider-status` response, including before
  initial acquisition finishes. GETs cannot start or refresh upstream work. The
  same-origin proxy returns both providers, supports a numeric `revision` query and
  `204` for unchanged data, and uses `no-store`. This domain has no P persistence,
  session-history attachment, report export, or operations-IPC payload in v1.
- F uses one shared provider-status store per browser tab, with serialized local GETs
  every thirty seconds while visible consumers exist, focus refresh, and pause handling.
  Provider network cadence does not depend on browser tabs or selected sessions.
  Frontend failures retain visible data, but elapsed freshness never remains green
  indefinitely when the monitor is unreachable. No browser storage caches status.
- Home and Usage limits show compact fixed status. A live session shows a dismissible
  yellow notice only for a fresh relevant service issue; healthy, unknown, stale, and
  historical views show no session notice. Dismissal is bounded tab-memory view state,
  keyed by a monitor-issued incident identity and severity. Recovery removes a notice;
  a new incident or material worsening can show it again.
- The shell notification tray lists one current service issue per affected provider,
  with an official incident/status link and the original last-check timestamp. The
  bell indicates unread issues even when no session needs input. Read acknowledgement
  lives only in bounded tab memory, survives closing the tray, ignores repeated polls,
  and resets after recovery, a new incident, or material worsening. A failed refresh
  may retain a fresh last-confirmed report with explicit delayed-refresh wording;
  stale, unknown, loading, and healthy status do not create service notifications.
  Sessions rows show the same status details only when `isLive` is true and the
  normalized provider matches. Historical rows never acquire a current warning.
  Both surfaces consume the existing shared store and never revise session evidence.

Public serialization is limited to provider/source enums, health/readiness/freshness,
last successful local check and provider update timestamps, a fixed official status-page
URL, opaque notice/incident identities, and bounded plain-text incident labels, lifecycle,
impact, timestamps and validated official incident URLs. No raw bodies, component schemas,
provider-native IDs outside public incident URLs, arbitrary URLs, fetch errors, credentials,
or transcript metadata cross this boundary. Public status reports can lag actual failures;
the normal UI label is **Reported healthy**, never a guarantee of availability.

The official source and component-filter details are documented in `docs/PROVIDER_STATUS.md`.

## MCP agent-query projections

The six MCP observation queries form an independent D Derivation and S Serving domain.
Background derivation captures committed catalog, session, public-provider-status, and
account-usage revisions, removes browser-forbidden fields, and atomically publishes a
bounded projection. A failed refresh retains the last known-good projection. Serving
may select, filter, and cap already-projected rows, but it never reads raw evidence or
starts U1 acquisition, U2 normalization, session hydration, provider requests, or usage
refreshes.

`GET /api/agent/v1/*` is monitor-private. It is absent from the browser proxies, event
stream, and LAN gateway. Packaged desktop requests require a separate 256-bit per-launch
capability that authorizes only this route family. Electron main publishes its version,
loopback origin, and token atomically in a bounded descriptor under the stable per-user
Pomegr data root after monitor
startup, and removes that descriptor on clean shutdown only when the token still matches.
A present but invalid or stale descriptor fails unavailable. Source development may use
the fixed unauthenticated `127.0.0.1:4317` monitor only when the descriptor does not exist.

The MCP transport accepts only HTTP loopback origins, rejects redirects, waits at most
two seconds, and accepts at most 256 KiB. It never logs or returns the capability. Query
responses carry schema version, readiness, committed revision where applicable, and the
source observation or projection generation time. Monitor absence and missing session or
agent references are bounded unavailable observations; invalid arguments and malformed
internal responses remain protocol errors.

Session projections contain exact qualified session references, bounded agent identity
and relationship fields, latest non-zero context snapshots, and normalized retained
failures. Context is one request-local snapshot, never cumulative token consumption,
throughput, billing, or session spend. Failure selection prefers a matching execution
task over its tool-call record and excludes commands, arguments, descriptions, output,
raw provider errors, and tool results. Public provider health does not establish impact or
causation for a specific account, model, or session. Current account usage limits remain
independent of agents and historical sessions.

Clients use these queries only when an observation can change the next decision. They do
not poll or call every query at session start. The tool-specific triggers and caveats are
documented in [MCP observation queries](MCP_QUERIES.md).

## Focused report evidence

`metrics.tokens.reportEvidence` belongs to D Derivation and is serialized in the same
committed public session response as the rest of `/api/state`. It does not introduce
an export acquisition path, endpoint, polling lane, or checkpoint schema. Export may
refresh the existing cache-only state endpoint; rendering consumes one returned
revision or the last visible snapshot. A loading/unavailable region cannot be
reported as an observed zero. Failed refreshes retain the last-known-good response.

Report selection uses retained normalized evidence before display caps, with at most
100 qualifying refill transitions (up to three independent request snapshots each)
and 100 context boundaries (at most one independently normalized snapshot each).
Aggregate counts describe that retained evidence; they never claim original-file
completeness or expose source offsets, fingerprints, or acquisition diagnostics.
This adds bounded data to the selected-session response, not a full request ledger.
The existing source/evidence lifetime, 4,096-observation session contract, and
checkpoint retention rules remain unchanged.

The request serializer is shared with the existing independent request feed. Only
opaque report/request IDs, normalized agent IDs/timestamps, request-local token counts,
resolved lifetime enums, fixed cache classification/diagnostic/status/sequence fields,
and normalized context boundaries enter this surface. Private classifier request
references, model/comparison identities, diagnostics, paths, prompts, summaries,
commands, and output never enter response or checkpoint data. Report-local task
selection consumes already normalized per-agent task feeds.

## Cache-lifetime policy normalization

U2 resolves Codex's documented `30m+` minimum only from each request's recognized recorded model, using the adapter-owned family allowlist documented in [Metrics](METRICS.md#cache-events). Missing or unsupported models stay unavailable; neither current settings nor a parent agent supplies a missing request model. D aggregates retained resolved lifetimes independently per normalized agent before the presentation feed is capped. F formats `30m+` as `cache TTL ≥30m` in the existing List and Tree metadata, without provider-schema logic or inline policy documentation. Minimum-only values never establish an expiry threshold.

The enum extension remains compatible with checkpoint version 1. Privacy-valid normalized evidence may preserve `30m+`; legacy `null` values remain unknown until ordinary background acquisition and normalization produce a complete replacement. Startup hydration, last-known-good retention, atomic commits, original observation timestamps, revision semantics, checkpoint privacy filters, endpoint cache-only serving, readiness, and UI polling are unchanged. No cache TTL network requests, credentials, raw provider fields, or extra browser fields are introduced.

## Cache-read drop evidence

U2 may retain optional `cacheReadComparable` and `cacheReadPreviousAt` metadata on
normalized request observations: explicit numeric evidence eligibility and the
normalized timestamp of the immediately preceding eligible observed request.
These bounded monitor-private fields are not cache-write evidence. Codex marks
only explicit, uncoerced, unclamped input/read/write counts with an original recorded timestamp;
missing, malformed, or ambiguous evidence breaks adjacency. An overlapping smaller
read preserves proven context for the identical request, never a fabricated
predecessor for new data. Source replacement still requires a complete validated
candidate; temporary read bounds do not erase retained evidence.

D derives `metrics.tokens.cacheReadDrops` only from committed normalized evidence,
before presentation caps, using the thresholds and boundaries in [Metrics](METRICS.md#cache-read-drops).
The read-share transition is at least 80% to at most 20%, with an independent
requirement that actual cached tokens fall by at least 80%. The broader
current-share ceiling changes only D derivation; evidence and response shapes
remain compatible.
This feed is separate from write-backed cache events and report counts. F reuses
the existing agent indicator and popover, labels the conclusion as an inference,
and links the signal definition. It never reconstructs comparisons from request
rows or provider schemas. S continues to serve committed responses only: no new
endpoint, source read, subscription, polling lane, or provider request is added.

The optional evidence fields are compatible with checkpoint version 1. A legacy
checkpoint without explicit eligibility remains unknown until normal background
normalization commits a complete replacement. Eligibility and predecessor metadata
remain inside L1/L2 evidence and never serialize to the browser. The public feed
allows only readiness, normalized agent IDs, bounded counts, opaque occurrence IDs,
original timestamps, two read percentages, and elapsed gaps. No raw usage, source
paths, model identities, comparisons, prompts, or credentials are added. Existing
revision handling, atomic commits, last-known-good retention, readiness, cache-only
GETs, and UI polling remain unchanged.

## Cache tiers and bounds

| Tier | Authority and contents | Current default bound |
| --- | --- | --- |
| **L1 evidence cache** | Runtime-authoritative immutable normalized session evidence in monitor memory | 100-entry and 8 MiB pruning targets for unpinned entries; one entry larger than 8 MiB is rejected |
| **L1 response cache** | Prebuilt provider-neutral JSON responses and revisions for cache-only serving | Bounded by the committed evidence and response domains |
| **L2 checkpoint cache** | Schema-versioned, privacy-filtered JSON used only to accelerate restart recovery | 100 entries and 16 MiB total |
| **Frontend view state** | The latest response retained by React while refreshing | Not a source of truth and not durable |

Live and selected sessions may be pinned in L1. Unpinned historical sessions use
least-recently-used pruning. Pinned entries are protected from that pruning and can
temporarily take the store beyond its entry or aggregate-byte target; source catalog
bounds still limit the population. Limits are based on normalized cache size, never raw
transcript size.

Browser requests use `cache: "no-store"`. Do not add browser storage, service-worker
storage, or shared HTTP caching for session state; the monitor-owned L1/L2 caches are the
authoritative caching boundary.

### Desktop phone access

The optional desktop LAN gateway is an additional S Serving transport for the existing
web routes. It authenticates a paired browser and forwards only approved reads to the
loopback web service. It does not acquire provider data, normalize, derive metrics, or
maintain a second response cache. Existing asynchronous hydration requests remain owned
by the monitor; a phone GET never performs synchronous provider acquisition.

Forwarding preserves readiness, original observation times, revision headers, `204`
responses, no-store headers, and streaming catalog revision hints. Last-known-good
retention and checkpoint formats remain unchanged. Closing a phone connection cancels
its upstream read/stream, not observation work. Native desktop pause affects that
desktop renderer; each phone retains the existing independent focus/visibility polling.

Gateway pairing and native sharing state are outside normalized monitor API state and
outside L1/L2 checkpoints. Only the startup preference persists in desktop settings.
The gateway blocks transcript-path reads and never forwards native desktop actions.
Unknown or changed network eligibility revokes access, independently of monitor readiness.

## Provider observer contract

Every provider adapter must expose the observation lifecycle required by
`monitor/providers/provider-contract.mjs`:

- start and stop its observer with the monitor lifecycle;
- publish a bounded normalized catalog independently from detailed hydration;
- include normalized creation and update timestamps in catalog references, with committed
  catalog rows ordered by creation time descending and opaque session ID as the tie-breaker;
- hydrate a known local session asynchronously;
- publish only contract-valid normalized evidence;
- keep provider-native source identities, paths, cursors, fragments, and schemas private;
- isolate its failures so one provider cannot block another; and
- report only bounded monitor-private diagnostics.

Adapters may watch files, poll a local API, or subscribe to provider events. The transport
does not change the shared store or browser contract.

### Event-driven acquisition pipeline

Provider notifications are the primary acquisition trigger. The ten-second poll is a
reconciliation safety net for missed or unsupported notifications, not the normal path to
discovering transcript changes.

```text
 Claude transcript tree       Codex rollout/index/liveness       Future provider source
          |                              |                                |
          +---------------- provider-native change notification ----------+
                                         |
                      adapter-private source-event router
                  (path/header/reverse-index data stays private)
                          /                         \
             catalog dirty                         session dirty(local ID)
          fresh bounded discovery                           |
                    |                                       |
                    +--------- provider observation scheduler ---------+
                               | separate catalog lane                  |
                               | one coalesced queue entry per session  |
                               | same session serialized + dirty-again  |
                               | different sessions run concurrently   |
                               +------------------+---------------------+
                                                  |
                              U1 acquire appended complete records
                                                  |
                                  U2 provider-owned normalization
                                                  |
                          C commit -> D derive -> P persist -> S cache
                                                  |
                         safe catalog revision event (no session data)
                                                  |
                         browser cache-only GET -> F presentation

                  10-second safety reconciliation -----^ (low priority)
```

Each provider owns an independent observer and bounded worker concurrency, so a busy or
failed Claude adapter cannot occupy Codex workers, and vice versa. Within one observer,
duplicate events for a queued session coalesce. If a source changes while that session is
already being acquired, one dirty-again pass is retained so the newest complete records
are not lost. Sessions may acquire in parallel, but one session is never acquired by two
workers concurrently.

The adapter may map a known source directly through its private reverse index. A newly
created or unresolved source requests a fresh catalog read that bypasses short-lived
provider discovery caches; bounded provider-header inspection may identify the owning
session sooner. The router emits only provider-local session IDs and a catalog-dirty bit
to the shared scheduler. Native paths, filenames, headers, and schemas never enter the
normalized candidate, checkpoint, diagnostics, or browser response.

Committed catalog revisions wake the browser through a same-origin server-sent event.
The event contains only the fixed `sessions` domain and a non-negative revision; it is an
invalidation hint, never a state payload. The browser responds by fetching `/api/sessions`
with its current revision. That GET still reads only the committed response cache. A
dropped event is harmless because focus refresh and serialized recovery polling remain.

Claude observes both its project transcripts and its provider session registry.
Registry creation, updates, and removal queue one coalesced catalog reconciliation
instead of waiting for the ten-second safety poll. The bounded previously-live set
is also hydrated against the new catalog, including a departed session older than the
eager history window. The source fingerprint includes only normalized live/history,
status, and needs-input state so lifecycle-only changes update detail without requiring
transcript growth; no registry paths, owners, or raw contents enter the fingerprint
payload or browser API. Unsupported watchers retain periodic reconciliation.
Confirmed native owner exit overrides transcript recency, including final shutdown
writes and the registry-directory-unavailable fallback. The adapter retains at most
512 private PID/start associations and exit decisions in memory only. Missing
registrations trigger a read-only process-existence check, shared by PID and cached
for 250 ms; only definite process absence proves exit. A reused but existing PID,
permission denial, or failed inspection does not. When registry removal precedes
process exit, one timer checks only these departing owners every 250 ms for at most
15 seconds, without PowerShell, transcript acquisition, or repeated catalog scans.
A confirmed departure queues the same coalesced catalog/detail refresh. Abort and
explicit observer stop cancel that timer. Current PID/start mismatches invalidate
stale registrations; individual inaccessible identities remain unknown. A new
validated registration replaces prior ownership; an unvalidated replacement cannot
inherit its predecessor's exit. Never-observed sessions and restart uncertainty retain
the existing recency grace. Explicit-file selection retains its compatibility override.
No ownership history is checkpointed or added to browser state. Last-known-good
evidence, cache-only GETs, and committed revision publication are unchanged.

Claude also discovers native registry-only identities before the first prompt creates
a transcript. Admission requires a validated process owner and a recorded native start
time; no plugin, transcript fabrication, or prompt is required. The bounded catalog
unions these identities with transcript-backed rows by the same normalized session ID.
Until a source exists, title/project use safe unknown labels, idle maps to Open, and
recorded working/input states keep their usual precedence. Open's five-minute window
uses the native start timestamp, never repeated registry reads, mtime refresh, or a
monitor restart. The entry remains Open under All after that window while registered.
Cached normalized Remote Control lifecycle may apply during this catalog pass, but a
fresh optional remote lookup never delays initial registry-only presence. A changed
normalized result queues one scoped catalog refresh; it neither creates evidence nor
starts a polling loop.
Registry removal or invalidated ownership removes a never-recorded identity; no
transcript-recency grace applies to it. Explicit-file selection does not discover
unrelated registry-only identities.

An adapter-private `detailReadiness: unavailable` marks a confirmed absent detail
source. C/D project it into existing summary/readiness fields, with null catalog
counts/context and a bounded committed unavailable detail shell. S serves that cached
shell without requesting hydration; F shows “No recorded activity yet” without
skeletons, invented agents, zero-valued metrics, or an error. There is no L1 session
evidence or L2 checkpoint for a registry-only identity. First-source arrival removes
the marker, queues ordinary ingestion, and commits real evidence under the same ID.
Last-known-good snapshots override this marker; an absent previously observed
transcript must not replace recorded evidence with an empty state. Marker changes are
structural catalog revisions even when identity and lifecycle have not changed.

Codex lifecycle observation has an explicit ownership boundary. A connected owning
app-server supplies runtime status through read-only list/read observations with
successful per-thread confirmation; its status expires after 120 seconds without a
fresh observation as `observation_gap`. The separate account-only app-server used for
usage limits is never a session observer. The CLI documents a proxy to a running local
daemon, but Desktop owner association and socket discovery are not established by this
contract, so production does not auto-attach, pair, or configure that transport.
On Windows, the independent native writer-presence collector observes known threads'
provider-owned locks without a plugin. It opens read-only and probes one byte at offset
zero, including beyond EOF on an empty file. Contention must be accompanied by stable
file identity and exactly one Restart Manager owner whose executable matches a locally
resolved native Codex installation and whose current process creation time matches
the owner record. A process name, PID alone, file existence, or file recency is insufficient.
Permission failures, ambiguous owners, source replacement and unexpected failures do
not establish presence. The observer never locks, writes, renames, or deletes provider
files and never shuts down, resumes, or attaches to a provider process.

Acquisition probes at most 500 safe, unarchived known IDs, yields between batches of
32, and uses at most one hidden asynchronous owner-query process per refresh, with an
eight-second deadline and 256 KiB output bound. Refreshes coalesce with a five-second
acquisition cache; native lock-directory notifications invalidate it. Restart Manager
registers the held-file set as a group, following its
[resource-grouping guidance](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmregisterresources).
A complete single-process union can confirm each independently held file; a multi-process
union is partitioned sequentially before attribution, never copied to every file. Queries
are bounded to 63 groups and 512 process records per group. A complete empty, foreign-only,
or ambiguous single-file group remains unavailable without poisoning independently resolved
groups; native errors, incomplete results, budget exhaustion, and timeouts reject the batch.
Successful owner
confirmation has a separate thirty-second maximum health age, so an ongoing refresh
does not erase accepted presence merely because its acquisition cache expired. Completed
failed checks clear confirmation; invalidation/shutdown prevent late results from
re-publishing it. All ownership stays in bounded adapter-private memory, never an L2
checkpoint, browser response, diagnostic log, or transcript. This health bound is not
an idle-session retention heuristic and cannot end an unresolved recorded turn.

The lifecycle hook bridge, detached owner watcher, snapshot/lease persistence, and
plugin build wiring are removed. Existing installed-plugin files and old user data
are not deleted by the monitor and are not consumed. The plugin remains optional for
policy, signals and progress. The legacy normalized `lifecycle_bridge` source enum is
accepted only for checkpoint compatibility; restore still downgrades it, never renews
presence, and historical views omit runtime liveness. macOS/Linux do not inherit the
Windows probe; connected owning-runtime and recorded lifecycle remain available there.

U1 detects lifecycle-only changes using a bounded private fingerprint alongside
transcript generations, including source status, evidence, freshness, and live/history
classification. The fingerprint never exposes a provider path or raw lifecycle
payload. A changed fingerprint schedules U2 normalization with an empty transcript
delta even without source-byte growth; C then validates and atomically commits the
candidate. Known API-only sessions do not require a rollout file to enter this path.
Unchanged normalized observations do not create duplicate revisions. Rollout boundary carry-forward requires matching file identity and a bounded prior-suffix continuity check; a larger rewrite rebuilds lifecycle instead of inheriting the previous turn. Restored Codex
lifecycle state is downgraded to unknown/stale until fresh acquisition confirms it;
startup rederivation consumes that downgraded evidence, never the original checkpoint lifecycle.
All production GETs remain cache-only: a request may queue hydration but cannot acquire
or normalize synchronously, and the last-known-good committed revision remains served
until a complete replacement validates and commits atomically.

Codex recorded execution state is independent of runtime confirmation. A validated
start remains in progress, and a structured unmatched input remains needs-input,
until matching provider evidence resolves it; transcript silence is not a heartbeat
failure or a completion event. Recognized terminal records retain idle/stopped even
when old. Their timestamps never advance just because the monitor polls. Structured
lifecycle freshness means the retained evidence matches a complete acquired source
generation, not that the provider process is currently computing. An ordinary append
pending U1 acquisition or ending in an unfinished record does not replace that accepted
lifecycle. U2 retains its original observation timestamp while matching file identity,
monotonic growth, and the prior bounded suffix confirm append continuity. The full
observer owns the successor once it has acquired the source; a bounded tail cannot
discard an accepted turn or unmatched input just because its source record is outside
that tail. Before full observation, a complete tail may survive an unfinished append
only when every intervening record remains within the continuous read window and no
malformed record was acquired. Acquisition pending and invalid acquired evidence are
distinct adapter-private states; neither adds browser or checkpoint fields. Cold
incomplete sources without accepted evidence, malformed acquired records, and confirmed
source discontinuities remain unknown until valid evidence is acquired. Catalog and
detail use the same accepted lifecycle; C/D publish a successor only when its evidence
is ready, with no timeout extension or presentation debounce.

The Live catalog includes unresolved recorded work and confirmed owner-backed
presence. A terminal record alone does not establish presence: it ends the unresolved
work, while a current owning runtime or confirmed native writer owner can still keep the session
open. Catalog activity distinguishes working, needs_input, idle, stopped, open, and
unknown. A completed idle turn with confirmed current owner-backed presence is
`open`, remains in Live while its catalog visibility age is valid, and keeps its individual agents idle. Working, needs-input,
and stopped evidence retain precedence. Open never follows from a recent file alone. The grid displays In progress, Needs input, Idle, Stopped, Open, and Unknown.
Unknown non-live entries must never be labeled Complete. A crash without a terminal
record may leave unresolved work; no elapsed transcript-silence window guesses an end.
Existing catalog, cold-discovery, working-set, and evidence-cache bounds remain in force.

Live visibility is a shared D catalog projection, not a replacement for provider
presence or lifecycle evidence. An owner-retained `open` row remains
`activityStatus: open`, but `isLive` becomes false when five minutes have elapsed
since the catalog row's last recorded activity (`updatedAt`). Missing, invalid, or
future `updatedAt` values do not qualify `open` for Live. Working and `needs_input`
rows, including states retained from recognized child/background aggregation, do not
expire under this rule. Ownership probes, monitor restarts, and viewing a session do
not renew `updatedAt`; an expired row is shown under All while its underlying runtime
presence is not thereby declared ended. One shared expiry timer schedules this
projection; GETs continue to serve only committed response caches. Restart reprojects
retained catalog rows before waiting for provider acquisition. A selected Open row
continues its normal detail polling even outside Live; this filter transition does
not turn its current evidence into a historical snapshot.

The Windows CLI cold-discovery predicate opens the native writer-lock file read-only
and probes one byte at offset zero. An exclusive byte-range lock can deny that read
even when opening succeeds and the file is empty. Only `EBUSY` establishes contention;
permission errors, missing/non-file paths, and unexpected failures do not. A negative
probe means no confirmed contention, not confirmed idle or completion. Non-Windows
platforms do not inherit Windows mandatory-read-lock semantics. This predicate only
gates bounded CLI acquisition; contention alone is not native session-presence authority.

Native writer ownership has a separate lifecycle acceptance suite. The opt-in `tests/codex-native-lock-acceptance.test.mjs`
suite uses an explicitly selected native executable and isolated temporary provider
home, without credentials, installed plugins, or model turns. Its read-only owner
query checks stable file identity, read contention, a unique file user, exact native
executable, and matching process-start identity. Those checks establish an observation,
not a guarantee against every concurrent ownership race. The Windows native
acceptance run with Codex CLI 0.152.1 confirmed idle loaded tasks retain zero-byte locks, unsubscribe retains
loaded state during its grace period, and both stdin shutdown and forced child exit
release locks. A separate Desktop acceptance check on 2026-09-02 confirmed that a completed
task retained its native owner after switching away, and user archiving set the native
archive flag and removed that task's lock while Codex kept running. Archiving an empty
synthetic task was rejected; the Desktop check covered the real completed-task case.
The scaling acceptance additionally holds 70 real native task locks concurrently,
confirms all within the helper deadline, distinguishes two native process owners, and
rejects a lock with an additional foreign file user without misattributing another lock.
The separate 500-candidate test retains one held lock among unlocked stale files; it is
not a substitute for the many-held-lock acceptance.
Enable the isolated test only by supplying an absolute native executable
in `POMEGR_CODEX_NATIVE_TEST_EXECUTABLE`; normal test runs explicitly skip it. Recorded
execution precedence, checkpoint format, and browser fields are unchanged. GETs remain cache-only and
last-known-good retention and lifecycle-only revisions keep their existing contract.

Owning-runtime confirmation expiry and native writer confirmation expiry remain independent health
checks. Checkpoint restore still downgrades runtime claims until fresh acquisition;
complete transcript replay can then re-establish an unresolved turn even after hours
of silence. When hydration repairs a startup catalog classification, the observer
updates the catalog reference used by subsequent preparation so stale startup rows
cannot reverse it. Unchanged silence creates no new candidate or response revision.

Native ownership acquisition is an independent, single-flight background lane.
Catalog discovery schedules it without awaiting its helper; transcript acquisition,
normalization, startup readiness, and detail reads consume only its last committed
in-memory snapshot. A slow or unavailable owner query must never hold either transcript
worker or catalog publication. The five-second acquisition cooldown starts at query
completion, while the thirty-second confirmation health remains anchored to probe
start. Watcher bursts invalidate presence conservatively without repeatedly killing
the helper; the latest pending request replaces prior requests, and invalidated results
cannot publish. Observer shutdown cancels the helper and removes its subscriptions.

Effective owner changes, including recovery after confirmation expiry, send a private
wakeup for one coalesced non-fresh catalog reconciliation and bounded observed-session
hydration. Timestamp-only renewals and cache hits do not send wakeups. Index/ownership
events use one coalesced fresh discovery pass, not a separate router prefetch. Their
detail hydration uses the new catalog, including sessions leaving the eager set.
Known transcript rotations also enter acquisition immediately rather than waiting on
discovery. Failed/unavailable catalog reads retain queued lifecycle wakeups for retry.
Source/catalog wakeups invalidate in-flight eager preparation; a superseded batch is
replaced or freshly prepared before acquisition. Routine prepared work cannot overwrite
a queued priority-zero source update with its older context.
No native ownership waits, reads, or notifications are introduced into GET handlers,
React, persisted checkpoints, or browser API fields.

### Startup working set and lazy history

- Catalog discovery remains lightweight and includes bounded historical rows so the
  sidebar can show and select them without parsing their session sources.
- Startup source preparation, transcript hydration, normalization, and checkpoint restore
  are eager only for live or needs-input sessions and sessions updated within the last
  seven days. Seven days is the provider-neutral maximum window required by current Home
  correlations; missing or malformed timestamps remain catalog-only.
- Selecting any known uncached historical row queues hydration for that one session. The
  API immediately returns its safe catalog identity with loading readiness, and the UI
  shows the session skeleton until a committed revision is ready.
- A known selection is pinned before hydration so its first committed snapshot survives
  competing background commits until the browser can receive it. Switching selections
  releases the previous historical pin, including a selection still awaiting hydration.
- Explicit hydration carries its requested status through queue coalescing and retains a
  serialized follow-up if acquisition is already running. For the generic incremental
  observer used by Claude, a private cursor is not proof that the L1 snapshot still exists:
  when the scoped checkpoint lookup finds no committed source, requested hydration rebuilds
  from complete source records. Unchanged retained sessions and ordinary background
  reconciliation do not rebuild evicted history solely to refill the cache. Missing
  or incomplete sources remain loading; failed normalization can retry without a source append.
- Home never schedules history work older than seven days. Shorter provider windows still
  filter their own correlation inputs, while provider usage-limit values remain an
  independent committed domain.
- A reconciliation publishes the complete bounded catalog first, then prepares source
  topology only for the eager working set. It must never prepare every old source merely
  because its catalog row exists.

### Complete-record ingestion

- Append-only JSONL acquisition uses 64 KiB chunks and continues until every currently
  available byte has been consumed; 64 KiB is not a history window.
- Only newline-complete records are parsed. The offset remains at the start of an
  unfinished record and that fragment stays in memory only.
- An incomplete generic-provider fragment is bounded to 256 KiB. Codex permits up to
  8 MiB for one encoded record (while still yielding 64 KiB reads) because image-tool
  result records can exceed 256 KiB; larger or malformed Codex records degrade to
  unknown without exposing raw content or blocking later complete records.
- Compatible checkpoints resume at the last complete-record offset. After restart, any
  unfinished record is reread from that offset.
- Multi-session reconciliation prepares provider-private source topology once per catalog
  pass. A provider must not repeatedly scan or fingerprint its full catalog separately for
  every session.
- Source notifications for known files use the adapter's private source-to-session reverse
  index and queue that session immediately without waiting for a catalog pass. Unknown or
  newly created files trigger cache-bypassing bounded discovery, then join the same queue.
- One provider worker pool may hydrate different sessions concurrently. Work for the same
  session is serialized, duplicate queued notifications coalesce, and a notification that
  arrives during acquisition retains one dirty-again follow-up.
- Stable internal identities and deterministic upserts must let later, stronger evidence
  upgrade an existing observation without duplication or downgrade.
- Codex fallback discovery collapses multiple rollout generations carrying the same
  top-level session ID into one catalog entry, retaining the earliest recorded creation
  time while the newest rollout remains the private source for current observation.
- Codex fallback discovery treats its recent-file scan limit as a per-pass acquisition
  budget, never as a permanent creation-date cutoff. A retained background cursor
  advances through older files on subsequent discovery passes, including when no
  watcher notification was received. Recent startup discovery remains bounded and
  does not wait for a complete historical walk.
  The default history batch visits at most 500 directory entries and yields every
  32 entries; its cursor advances at most once per second and completed sweeps wait
  at least ten seconds before restarting. The existing periodic observer drives
  this work. A forced refresh without an exact file hint may also visit one bounded
  recent batch, using a temporary cursor so historical progress is preserved.
- Exact Codex transcript watcher hints enter a bounded, deduplicated private queue.
  Discovery validates root containment and the actual file before admitting its
  header directly; it does not send an older resumed source back through the recent
  filename window. Watcher bursts coalesce through the existing observer scheduler
  and do not restart the historical scan. Directory or missing-filename notifications
  rely on reconciliation. Hints are acquisition candidates, never session identities
  or evidence of work on their own.
- The Codex discovery cache retains bounded private metadata and source generations.
  It holds at most 500 headers and 128 deduplicated hints by default.
  Unchanged retained sources reuse their headers; changed sources undergo bounded
  header validation, and transient failures retain the last valid metadata. Cache
  selection favors retained live sessions and recently updated candidates. The public
  catalog selects live rows before filling its remaining bounded history slots and
  retains its usual recency ordering. Discovery metadata, paths, cursors, and hints
  remain in memory only; no new checkpoint or browser fields are introduced. Detail
  hydration and normalized evidence retention continue under the existing U1/C/P
  contracts, and GETs continue to serve committed response caches only.
- A Codex source generation replacement revalidates the bounded header identity
  before ingesting records against an existing session. A changed identity queues
  discovery and leaves the prior committed evidence intact; ordinary appends retain
  their incremental acquisition path.
- For multi-file Codex sessions, U1 owns an independent cursor and bounded private
  lookbehind for every root or child rollout. After the initial complete build, U2 receives
  only newly completed records plus that lookbehind; it does not rescan the complete
  transcript or the generic live tail for session-story normalization.
- Completed approval-review decisions are retained per normalized agent across empty
  and partial Codex deltas. U2 seeds review normalization from the prior normalized
  feed, deduplicates all incoming decisions before applying the 100-row display cap,
  and preserves prior totals and stronger action/risk/duration evidence. Bounded
  lookbehind replays do not add reviews; a complete source replacement rebuilds the
  feed without inherited decisions. Incomplete replacements retain the last committed
  revision. Only the existing normalized fields reach checkpoints and browser state;
  review requests, rationale, commands, and provider turn IDs remain private. This
  adds no GET acquisition, polling lane, checkpoint field, or revision mechanism.
- "Delta" describes upstream acquisition and normalization, not a partial browser payload.
  S returns one complete committed revision so a fresh page, a second client, or a client
  that missed revisions always receives a self-contained view. React replaces its prior
  revision only after that complete successor is ready.
- L2 restores the last privacy-filtered normalized revision immediately. Codex rebuilds
  its provider-private per-file cursor map in the background because the provider-neutral
  checkpoint exposes no paths or native cursor map; the restored revision remains visible
  until that rebuild validates.

### Replacement and discontinuity

Identity changes, truncation, same-size content replacement, failed continuity, or an
authoritative provider generation change require a staged rebuild:

1. Keep the last committed revision visible.
2. Build a separate candidate from the replacement source or a compatible authoritative
   checkpoint.
3. Consume the replacement through its confirmed end and validate the normalized result.
4. Swap revisions atomically only after validation succeeds.

A partial or tail-only reconstruction must never replace complete committed evidence.
Filesystem notifications are wake-up hints, not proof of completeness.

## Publication and persistence cadence

These schedules are independent. A frontend request never controls U1, U2, C, D, or P.

| Work | Owner / phase | Cache relationship | Cadence |
| --- | --- | --- | --- |
| Source-change routing | Backend adapter / U1 | Maps a provider-native notification privately to catalog-dirty and/or session-dirty work | Wake immediately on a provider event or filesystem notification; known sessions enter the worker queue in the same event-loop turn |
| Source-change ingestion | Backend adapter / U1 | Feeds normalization; does not write a committed cache | Start when a provider worker is available; default concurrency is 2 sessions per provider, with same-session serialization and event coalescing |
| Safety reconciliation | Backend adapter / U1 | Repairs missed notifications and feeds normalization | Every 10 seconds for observed sources; reconciliation work has lower priority than notification-driven work |
| Provider normalization | Backend adapter / U2 | Builds a private candidate | Immediately after complete records are acquired |
| Session publication | Backend store / C | Writes a new immutable L1 evidence revision | Coalesce to the first candidate's 500 ms deadline; later candidates replace pending evidence without restarting the timer. Fresh evidence preempts a delayed failure retry. |
| Structural catalog projection | Backend monitor / D | Commits additions, removals, live, needs-input, and activity-status transitions to the catalog response cache | Schedule in the next event-loop turn; structural work preempts a queued summary refresh. One shared five-minute Open-visibility expiry timer handles idle owner-retained rows; it does not acquire provider evidence or renew activity. |
| Session-summary projection and Home correlation | Backend monitor / D | Reads committed dependencies and writes L1 response revisions | Catalog summaries publish in the next event-loop turn after a session commit, without another 500 ms delay. Other dependency refreshes retain their existing coalescing ceiling. |
| Catalog revision notification | Backend serving / S | Carries no state; announces only the committed `sessions` revision | Emit immediately after a catalog response revision commits |
| Resource observation | Backend monitor / D input | Updates the private resource sampler, then republishes affected session projections from committed L1 evidence without provider acquisition | Every five seconds for live sessions; confirmed unavailability resolves the resource region instead of leaving it loading |
| Routine checkpoint | Backend writer / P | Reads L1 evidence and atomically replaces L2 JSON | Five seconds after quiet; at least once per 60 seconds during continuous activity |
| Graceful shutdown | Backend writer / P | Flushes the latest committed L1 revision for every pending checkpoint | After uncommitted scheduled candidates are cancelled and before the observer lifecycle is released |
| Usage observation coordinator | Backend / U1 through D | Refreshes the centralized usage response cache | Check for due work every 60 seconds; each provider's authenticated request cache permits at most one request per five minutes and honors longer `Retry-After` cooldowns |

Checkpoint files use temporary-file creation followed by atomic replacement. A missing,
corrupt, oversized, unknown-version, invalid, or source-incompatible checkpoint is ignored
and rebuilt in the background. Checkpoints are an optimization; provider-owned sources
remain the source of truth.

## Endpoint ownership and revision semantics

| Endpoint | Committed domain | Consumers |
| --- | --- | --- |
| `/api/sessions` | Provider-neutral presentation-ready catalog rows with bounded committed summaries and per-row summary readiness | Application shell, Sessions directory, sidebar, Home destination labels |
| `/api/events` | No committed data; server-sent invalidation events containing only a fixed domain and revision | Application shell immediate refresh trigger |
| `/api/state?sessionId=...` | One session's normalized public state and per-domain readiness | Individual session view and report generation |
| `/api/home` | Cross-session aggregates and per-limit local activity correlation | Retained aggregate API; the Home page no longer requests this domain |
| `/api/usage-limits` | Central provider/account-scoped usage values, bounded refresh-failure kind, earliest local retry eligibility, and per-provider readiness | Shared frontend usage store used by Usage limits and session views |

Callers send their current revision. When the relevant committed revision is unchanged, S
returns `204 No Content` with no state body. A known uncached session returns its safe
catalog identity and loading readiness while asynchronous hydration proceeds.

`/api/home` retains its committed response and provider-limit revision contract. Any correlation consumer must match that revision to the centralized usage snapshot before combining them. The personal Home page consumes neither domain; removing its polling does not change cache-only GET serving, backend derivation, last-known-good retention, or revision semantics.

Historical session state never receives current Git state or current usage limits.

Session publications allocate revisions from a store-wide monotonic sequence. Evicting
and rebuilding a session cannot reuse a revision still held by a client and incorrectly
return `204`. Checkpoint restoration preserves its recorded revision and advances the
sequence floor; identical retained candidates do not advance their revision. This adds
no per-session revision ledger, checkpoint fields, or browser-visible source metadata.

Usage refresh failures retain the last known-good provider values. The public refresh
state may include only the normalized `authentication_required`, `rate_limited`,
`runtime_unavailable`, or `unavailable` kind, the safe attempt timestamp, and the earliest local retry-eligibility
timestamp computed from the coordinator's cooldown. Raw provider response bodies,
headers, request identifiers, credentials, and endpoint details remain monitor-private.
`rate_limited` means only that the usage request received a recognized throttle response;
it is not evidence that an account or session exhausted its plan allowance.

A missing or unsupported usage runtime publishes `runtime_unavailable` and unavailable
readiness after the background capability check, with no fabricated account attempt or
retry timestamp. Completed empty reads settle to unavailable; loading is reserved for
pending work. This lets the shared browser usage store leave its initial one-second
polling cadence. Codex presents **Codex CLI required for usage limits** and expanded
setup help. Account-read failures and successful responses with no windows show sign-in
and connectivity guidance; retained figures do not hide failures. Healthy readings
remove the helper. Native CLI detection remains process-scoped, so installing or
updating it requires fully quitting and reopening Pomegr.

This is a normalized failure/readiness presentation change. Provider acquisition stays
in background work, GETs serve committed caches, revisions and last-known-good values
retain their existing semantics, and historical views still omit current usage. No raw
runtime paths, provider errors, credentials, or account data are added to browser state
or checkpoints. Codex help is informational in both browser and desktop windows and
adds no native or HTTP control action.

### Local Claude usage observations and desktop recovery

The optional status-line bridge is an explicit local integration. Its provider-owned U2
normalizer accepts only a complete five-hour/seven-day usage pair and persists one
bounded, atomically replaced normalized file: version, local observation timestamp,
percentages, and reset timestamps. Raw status-line input is never persisted. Repeated
identical pairs retain the original observation time. An invalid or partial replacement
does not erase an already accepted observation.

The existing U1 background usage job reads this file on its normal sixty-second cadence.
A valid local observation within five minutes, whose windows have not expired, can
satisfy the usage read immediately while the existing coordinated API check runs in the
background. API checks continue to update model-specific windows absent from the local
feed; their five-minute minimum and longer `Retry-After` cooldowns remain authoritative.
Fresh local usage remains available through an API failure. The adapter selects a complete successful
observation, never a synthetic mixture of local and remote windows. Failures retain the
last good data and original observation time. Future-dated or malformed observations
cannot establish fresh evidence. This feed is scoped operationally to the configured
local Claude profile and data root, not merged across accounts.

The local pair does not contain model-specific weekly limits. When the adapter switches
from an API observation to a newer local pair, it retains the last normalized Fable
window in a separate optional `retainedLimits` group with its original API `fetchedAt`.
This group is bounded by the usage-window schema (at most 16 windows; Claude emits only
the recognized Fable window) and is display-only. It never enters
the current `limits` array or limit-activity sampling, and never inherits the newer
local timestamp. A newer successful API observation replaces or clears it. No extra
API request outside the existing shared cooldown is made to populate it. F presents **Last API value** with its own age;
without a prior API observation, the local-feed Fable column says **Unavailable**.
Neither missing data nor an expired reset becomes a fabricated zero-percent reading.

P persists the normalized account API observation separately in `usage-snapshots/claude-api.json`.
This bounded (8 KiB), atomically replaced file contains only a schema version, an opaque
credential-source fingerprint, the original successful observation and last-attempt timestamps,
a fixed failure kind, the next allowed attempt timestamp, and at most the three recognized
windows (`current-session`, `all-models`, `model-fable`). Each stored window contains only
its fixed ID, numeric percentage, normalized reset timestamp or null, and active flag.
Labels, window names, severity, availability, retry state, and fixed error messages are
reconstructed from the allowlist. Raw responses, headers, credentials, account identifiers,
credential paths, and error text are never persisted.

U1 lazily restores this cache during background usage acquisition. The source fingerprint
uses only the selected credential file's path and filesystem metadata through a one-way hash;
it does not read or hash credential contents. Restoration and writes require the fingerprint
to match the current regular credential file. Profile changes, credential replacement or
metadata changes invalidate remote reuse, including in-memory values; in-flight results from
a changed source cannot be published or checkpointed. This deliberately favors isolation over
cache reuse when Claude refreshes its credentials. The local status-line pair retains its
existing operational profile/data-root scoping and separate schema.

Restored remote data keeps its original observation timestamp and is marked stale by the
existing freshness rules. A newer local pair can still show the restored Fable value as
**Last API value**. Restoring a failed attempt preserves the last good API observation and
the full provider retry deadline, so restarting Pomegr does not cause an early retry for
the same credential source. A successful response that omits Fable clears the model value,
including across restarts; failures and malformed cache files never fabricate a value.
Cache I/O failure must not fail a live usage observation. No cache restoration or persistence
runs inside serving GETs, no new polling loop is added, and committed revisions/204 handling,
last-known-good serving, browser privacy, and historical-session exclusion are unchanged.

During the initial API request, locally sourced usage has `attemptedAt: null`; Fable
shows **Checking…** until the next background usage publication includes the completed
check (normally within sixty seconds). The adapter reads the coordinator's already
completed cache without acquiring more data, so a settled result is not delayed by an
additional observation cycle. Local success never clears a completed API failure:
the existing sanitized `failureKind`, `retryAt`, and API `attemptedAt` remain visible
alongside the valid local windows. Fable distinguishes authentication, throttling, and
other check failures from a successful response that simply omitted the model window.

D publishes optional bounded `origin` (`local_observation` or `provider_api`) and
`freshness` (`fresh` or `stale`) fields alongside the existing normalized usage shape.
For local evidence, `fetchedAt` is the original observation time, not the latest file read.
F labels it **Last observed**. The Usage limits page consolidates provider provenance,
freshness, and account scope into one note below all provider panels; session detail
continues to identify stale local figures inline. Provider rejection
means saved access was rejected; it does not prove a full login is required. Readiness,
revision/204 handling, last-good retention, and historical exclusion are unchanged.
Local usage files are separate from session observation checkpoints and never contribute
to context, throughput, cost attribution, or session-history usage limits.

**Enable local usage** and **Reconnect Claude Code** are user-initiated native desktop
operations behind trusted-renderer IPC and native confirmation. The first preserves
existing user configuration while installing the bridge. The second launches only
Claude Code's own sign-in flow. They accept no renderer-supplied paths, commands, or URLs;
return only allowlisted outcomes; and neither read nor expose credentials. No HTTP
control route exists. Serving GETs remain cache-only and never launch setup, sign-in,
provider acquisition, or normalization. Recovery uses normal background retry cadence.
F expands usage connection help for a recorded failure even while last-good readings
remain available, and removes it after recovery. Browser help supplies the fixed manual
sign-in command for the monitor computer; desktop sign-in remains explicit and native.
Throttling help explains the cooldown without suggesting sign-in as a way around it.

### Claude Remote Control lifecycle acquisition

The Claude adapter supplements local registry discovery with read-only native metadata for locally discovered, live `sdk-cli` sessions with validated PID/start ownership and an exact bridge association. U1 requests only the fixed Anthropic session metadata endpoint; U2 accepts only matching identity and explicit `running`, `requires_action`, or `idle` lifecycle. Registry/remote transport fields remain provider-private. Only U1 background catalog discovery and source acquisition perform network refreshes. The U2 evidence reducer applies the cached normalized snapshot without network access; S Serving and F Presentation never call the native API.

The private reader retains at most 50 associations, coalesces concurrent requests, permits four network reads at a time, and bounds each read to six seconds and 256 KiB. Successful reads are cached for ten seconds; unsuccessful reads retry no sooner than sixty seconds. The normal ten-second observer reconciliation supplies refresh opportunities. Failures retain the last valid state and original transition-observation timestamp for the same owner, while ownership, bridge, or credential changes invalidate reuse. No status is invented before a valid observation.

A normalized lifecycle change contributes to the adapter source fingerprint, so hydration updates even when transcript bytes do not change. The existing staged replacement and contract validation still govern C Commit: incomplete replacement input cannot erase a prior complete revision. Repeated identical status does not advance the lifecycle observation timestamp or force transcript reacquisition. D Derivation and revision-aware cache-only GETs remain unchanged. P Persistence may retain only existing normalized evidence and the opaque source fingerprint; the remote response, bridge ID, token/hash, and private association cache are never checkpointed. Historical session hydration never requests remote status for that session.

Claude catalog acquisition also incrementally reduces the complete primary transcript
for successful, structured background workflow/shell/native-agent launches and exact terminal
notifications, or exact run-matched completed workflow manifests whose valid provider
completion timestamp is at or after the recorded task launch. A resume can reuse the
run ID while leaving an older completed manifest intact; the launch timestamp scopes
private completion memory and participates in workflow-manifest cache validation.
Both catalog and workflow detail reject that stale completion without changing the
source lifetime, commit, serving, or checkpoint contracts.
This evidence is scoped to the validated process identity and its
registry start time, independent of native primary idle and modification-time agent
heuristics. The private cache holds at most fifty sessions with 256 pending calls
and 256 open task IDs each; raw records never leave acquisition/normalization.
Cooperative 64 KiB reads and a 256 KiB fragment limit bound acquisition, not the
lifetime of observed work. A malformed or incomplete replacement preserves the
last valid observation; process replacement discards the old association. Only the
composed catalog activity enum crosses C Commit, with no new browser or checkpoint
fields. Native `Agent` launch results require matching tool identity, explicit
`status: async_launched`, `isAsync: true`, and a bounded `agentId`; only its exact
trusted terminal notification closes that agent. Child completion, file recency,
agent counts, and foreground or incomplete launch results cannot substitute for
this evidence. A confirmed background parent remains open while executing nested
children, without acquiring child transcripts on the catalog path. Background work
can make a session Working while its primary agent is Idle. This extends only
U1/U2 recognition: last-known-good retention, revision publication, bounded private
cursors, and cache-only GETs are unchanged; no raw agent IDs or result fields are
added to browser or checkpoint state.

Claude agent-detail U1/U2 also replays each observed parent's complete native agent
launch/notification history, independently of process ownership. Only successful
matched `Agent` background launches and trusted exact terminal notifications set an
individual child to `finished` or `stopped`; a null final stop reason does not erase
this recorded completion. A trusted notification can be recorded in a different related
transcript of the same session from its launch, including a root queue notification
for a nested child. Detail normalization joins these complete per-file observations
on the exact native agent ID and launch tool-use ID; a cross-file notification without
the tool-use ID is unavailable. Launch call/result pairing remains local to its file.
A supplied notification tool-use ID must match its launch; after an agent ID is
reused by a later launch, that tool-use ID is required to disambiguate delayed delivery.
Duplicate delivery preserves the first terminal timestamp, while later child
conversation or a new successful launch clears the old state. The private complete-history
reader retains the latest non-synthetic child conversation timestamp so resumption
cannot disappear behind a recent-tail bound. Equal conversation and cross-file terminal
timestamps cannot establish their order and do not promote the child to finished. Ambiguous identities
across parents are unavailable. The private reader retains at most 100 file cursors,
256 pending calls, 256 agent states, and 256 exact-call notification candidates per
file, using cooperative 64 KiB reads and a 256 KiB fragment bound. Session-wide
aggregation has an explicit 25,600-entry ceiling; exceeding it rejects the candidate
and retains the last committed normalized revision rather than truncating evidence.
The join uses only that session's related files and rejects ambiguous identities even
when one parent's launch has no completion. It does not change catalog background-work
aggregation or use stop-hook success as completion evidence. Tail growth cannot age
out completion. Incomplete,
malformed, or over-bound replacement retains the last valid observation; complete
validated source replacement swaps it. Raw IDs, payloads, and cursors remain private;
only existing normalized status and timing fields enter evidence/checkpoints.
Observation publication and revision-aware cache-only GETs are unchanged. F suppresses
live cache timing warnings for finished/stopped agents even within a live session.

Claude sessions with a validated current registry owner remain Live between turns,
even when the recorded activity is old. Native idle with that validated owner maps
to catalog `open`; individual agents remain `idle`. Active, needs-input, and recorded
background work retain precedence. Unvalidated registry compatibility entries and
recency-only fallback rows cannot acquire Open merely from being Live. Owner loss
removes confirmed presence through the existing catalog reconciliation; no new
recent-idle grace period is added.

Non-live Claude catalog rows use `idle` as a no-live-session fallback, not
provider-confirmed completion; live rows with unavailable lifecycle evidence remain
`unknown`. This changes only the normalized catalog enum. Structural catalog
projection publishes it through the existing committed revision and notification
path; GETs remain cache-only, last-known-good evidence and checkpoints are retained,
and no new public or persisted fields are introduced.

The request and schema compatibility contract is in [Claude session status](CLAUDE_SESSION_STATUS.md).

## Readiness contract

Readiness is explicit and bounded to `loading`, `ready`, or `unavailable`. Capability
support is separate: an unsupported capability is not loading or unavailable.

- Never infer loading from `null`, zero, or an empty array.
- `ready` with no records is a factual empty result.
- `unavailable` is used only after the backend confirms that supported evidence cannot be
  produced. Observer startup failure confirms catalog unavailability. A transient later
  acquisition or catalog failure retains the previous committed value; if no committed
  value exists yet, it remains `loading` and reconciliation retries it.
- A committed value remains `ready` during refresh. Do not regress it to `loading` while a
  replacement is being built.
- Readiness granularity follows independently produced backend jobs, not every React
  component.

The retained Home aggregate API tracks catalog, provider limits, per-limit activity correlation, and per-session summary enrichment independently. The Home page itself uses the shell catalog only to resolve pinned destinations and the last-viewed session; product discovery is available independently of catalog readiness. Session views track core provider evidence, agents,
context, activity, repository, resources, and usage as independently produced domains.

## Presentation rules

- Use geometry-matched skeletons only when a region has no committed value and readiness
  is `loading`.
- Session loading shells use the loaded session header's shared typography, identity
  styling, and responsive rules; known catalog titles must not flash a different type scale.
- Keep existing data visible during refresh, observer failure, API failure, and retry
  backoff.
- Show normal factual empty copy for `ready` empty data and a fixed sanitized error state
  for confirmed `unavailable` data.
- One slow provider, usage limit, correlation, or session enrichment must not block a
  ready sibling region.
- A discovered sidebar session is a real selectable row before detailed hydration
  completes. Unknown counts must not render as zero.
- Navigation to an uncached session renders the new session shell and known catalog
  identity immediately; it must never leave the previous session visible under the new
  route.
- Skeletons are `aria-hidden`; their containing region uses `aria-busy="true"` and one
  visually hidden status. Reduced-motion mode disables the opacity pulse.
- Skeleton colors remain neutral; semantic evidence colors are not loading colors.

## Frontend API cadence

Polls are serialized, scheduled after the preceding response, aborted on navigation, and
never overlap. Focus or return to the foreground triggers an immediate fetch. Desktop
**Pause updates** pauses F only and never controls backend observation.

For the catalog/sidebar, a committed revision event is the primary visible refresh
trigger. The application shell immediately issues its normal revisioned cache-only GET
and applies session identity, live count, and attention state as an urgent React update.
Ready-state polling remains at five seconds only as lost-event and disconnected-stream
recovery; it is not the expected propagation path.

| Consumer | Visible cadence |
| --- | --- |
| Loading session | `/api/state` every 1 second until required regions are ready |
| Selected live session | `/api/state` every 2 seconds |
| Ready historical session | Fetch once, then stop |
| Loading catalog/sidebar | `/api/sessions` every 1 second |
| Ready catalog/sidebar | Immediately on a safe catalog revision event; `/api/sessions` every 5 seconds as recovery |
| Personal Home | No page-owned polling; destination labels reuse the shell catalog |
| Loading provider usage | `/api/usage-limits` every 1 second |
| Ready provider usage | `/api/usage-limits` every 60 seconds |
| Any active consumer in a hidden tab | Every 30 seconds |

Failed frontend calls back off approximately 2, 5, 10, then 30 seconds while retaining
the most recent committed value.

## Home navigation preferences

Home is a personal entry point, not an aggregate monitoring view. It does not request
`/api/home`, `/api/state`, or `/api/usage-limits`; the shell's existing catalog cadence
continues unchanged for navigation and notifications. Pins never display activity,
progress, usage, or context counters. Loading or unavailable catalogs affect destination
labels only, and never hide the static feature previews or clear saved pins.

Browser storage key `pomegr-home-v1` may retain only a schema version, up to six validated
session/project/view identifiers, one last-viewed normalized session identifier, and an optional fixed current-update identifier for dismissing the product update. Older or unknown update identifiers are discarded, so a new update can appear again.
Titles and details resolve from the committed catalog; no copied session snapshots,
transcript paths, raw content, or credentials enter this preference. A session is remembered
only after actual navigation to its detail route and confirmation in the catalog.
Project pins open an exact project filter in Sessions. These preferences are local to the
browser origin (including the desktop renderer), not monitor evidence or checkpoints.
Unavailable storage falls back to memory and the UI explains the limitation. Missing
catalog destinations remain removable and reappear if their records return.

Session coach, Saved views, and Session comparison are non-interactive Coming soon
previews. No agent runs, model call, external transmission, or session control is enabled
by these previews. The coach's proposed opt-in policy is product direction only.

## Checkpoint and browser privacy

An L2 checkpoint may contain only:

- schema version;
- provider and normalized local session identity;
- bounded monitor-private source fingerprint and complete-record offset;
- contract-valid bounded normalized evidence and readiness; and
- committed revision and observation timestamps.

It must never contain raw records, incomplete fragments, prompts, responses, reasoning,
commands, patches, stdout, stderr, tool-result content, credentials, OAuth/account data,
raw diagnostics, provider message/event IDs, or transcript paths. Cache filenames use a
safe hash of normalized identity and never contain a source path.

Browser responses remain subject to every allowlist and privacy invariant in `AGENTS.md`.
The optional cache message-change sequence is derived during complete-history provider
normalization and committed only as the fixed `post_tool_task_notification_resume` enum
or `null`. Serving and presentation never reconstruct it from browser-visible labels or
timestamps. Incomplete acquisition, an interrupted structural chain, or unrecognized
provider evidence degrades to `null`; complete replacement, atomic commit, and
last-known-good retention apply exactly as they do to other normalized evidence.
Caches and browser responses may carry only the bounded provider-neutral work-kind enum
derived during U2 normalization. Raw commands and provider-native tool schemas remain
adapter-private; missing or ambiguous classification degrades to the generic shell kind.
Caches and `/api/sessions` directory rows may carry only catalog identity and lifecycle
fields, per-row summary readiness, bounded visible-agent counts, the latest all-agent
context snapshot, bounded agent-reported progress, the activity fallback described below,
and the normalized primary agent's
nullable current-activity label, observation timestamp, and fixed `current`
qualification. D derives that qualification from the primary agent's
committed lifecycle, not from child activity, wall-clock recency, or file timestamps.
Only an observed/current active primary in a working or needs-input catalog row is current
(a child awaiting input does not stop the primary). Unknown, stale, inferred, missing,
restored, or inactive primary lifecycle produces null in the catalog, even if children
work. The older heading remains in retained agent evidence, not in `currentActivity`.
For Claude Code, U2 recognizes only a bounded one-line `description` on a native
`Bash` tool-use record and associates it privately with that exact tool-use ID. A
matching result or recognized turn/agent terminal clears the description. Commands,
other arguments, results, thinking, prompts, response text, attachments, arbitrary
tool descriptions, and MCP arguments never enter this field. Parallel calls are
tracked independently and only the newest still-pending recognized description is
selected. A validated current Claude registry owner may supply the primary agent's
observed/current lifecycle qualification; registry ownership details remain private.
Historical evidence omits the field, source replacement resets retained state, and
bounded-tail acquisition may carry forward only a description previously normalized
from a complete record.
An Idle or non-live catalog row suppresses any older cached heading immediately, before
detail hydration, without erasing the retained primary evidence. Both the observation
catalog and compatibility session feed use the same projection rules; with observation
enabled, the feed returns the committed catalog directly rather than rebuilding from a
separately cached summary.

The Sessions **Last activity** column prefers that qualified provider heading, then uses the
separate nullable `activityFallback`. D derives this fallback from committed normalized
agent execution tasks and tool calls. Its only public fields are a fixed-vocabulary
label (or bounded running-task count label), original observation timestamp, `current`
or `last_observed` state, `execution_task` or `tool` source, and `primary`, `subagent`,
`multiple`, or `unknown` actor scope. No task descriptions, actor labels or IDs, tool
names, arguments, commands, results, provider records, plan subjects, or reported
progress enter this summary. The summary does not change `currentActivity` semantics.

Recorded running execution tasks take priority while the catalog is live and working
or needs-input and the owning agent is active, waiting, or needs-input. Tasks with a
finish timestamp or exit code cannot qualify. A separate agent liveness observation,
when present, must be observed/current; adapters without it use their normalized
agent and execution-task status. No new wall-clock recency rule qualifies running work.
Checkpoint-restored execution evidence remains last-observed until fresh provider
evidence validates and commits; downstream rederivation alone cannot promote it.
Multiple running tasks show a count and the appropriate actor scope. Otherwise the
latest retained normalized tool or execution-task observation supplies the fallback,
including completion/failure/stop observations, with deterministic ordering for ties.
Missing or malformed evidence remains null. Unknown tool work kinds are unavailable;
unclassified shell tasks use the generic shell category.

Catalog idle, stopped, open, unknown, or non-live transitions immediately replace a
running fallback with last-observed evidence, without new acquisition or changing the
retained session evidence. Failed candidates preserve the previous committed revision.
The compatibility summary cache retains a separate last-observed fallback for the same
reconciliation; neither fallback is added to Home, session-detail state, or reports.
F renders the work label for last-observed work, with a static version of the activity
icon and "Previous activity" accessible naming. Delegated and multiple-agent scope remains
inline; primary-agent attribution and the age appear only in the popover. Qualified
current headings and execution summaries keep
the existing animated icon. Missing activity is an em dash on desktop and compact
layouts. Provenance is available on hover and keyboard focus, using "Provider-reported",
"Execution task", or "Tool activity" with the relative age and actor. Only a changed label
fades in for 150 ms, including changes to/from the dash; initial mount and timestamp-only
updates do not animate. Icon identity and row geometry remain stable, lifecycle changes
apply immediately, and reduced-motion preferences disable the fade and pulse.

Completed rows retain their
last committed agent count, context snapshot, and progress; their active-agent count is
zero and provider current activity is null. Their last-observed fallback survives summary
eviction when the recorded session timestamp is unchanged. Beyond the bounded fallback,
subagent activity, context history, resources, provider
records, and every other agent field remain outside the catalog response. React consumes
each row directly and never joins catalog identity to a parallel summary collection.
Caught provider, filesystem, and checkpoint failures use fixed sanitized states rather
than arbitrary exception text.

## Repository context inventory

Repository context inventory is a separate repository/provider-scoped committed domain.
Repository identity is an installation-salted opaque ID derived monitor-side from the
canonical Git worktree root, or normalized session working directory for a non-Git
project. Paths remain in memory only and never enter checkpoints, public summaries,
revision documents, browser responses, logs, or renderer IPC. Worktrees are independent
repositories; duplicate display names receive only an opaque short disambiguator.

Repository rows are derived asynchronously from committed session catalog and session
evidence. Their GETs never resolve Git roots, read providers, capture diagnostics, parse
output, persist data, or hydrate sessions. `/api/repositories` serves the committed list
revision and `/api/repository-inventory` serves one already-committed immutable detail.
Both are safe for read-only LAN presentation. Repository revision events only tell the
browser to fetch a newer committed response.

Claude Code capture is an explicit desktop action. The renderer supplies only a bounded
opaque repository ID and provider ID after an inline confirmation. A trusted Electron
IPC handler sends a bodyless, token-authenticated POST directly to the loopback monitor.
There is no same-origin POST proxy or LAN route. The monitor accepts the action only with
an exact loopback host, no Origin, desktop authorization, and fixed parameters. Codex is
explicitly unsupported and never receives reconstructed or Claude-derived evidence.

The Claude adapter starts an allowlisted executable with a fixed argument array, the
monitor-resolved repository root, `shell: false`, a bounded environment, timeout, and
output buffer. Raw stdout and stderr remain process-local and are discarded. Only a
complete parsed and validated inventory may be committed. Capturing and bounded failure
states are in memory; cancellation, failure, timeout, invalid output, or persistence
failure retains the last successful revision.

Persistence contains only a version, installation salt, feature-introduction time,
bounded revision counters, immutable normalized inventory revisions, and bounded session
binding decisions. Each repository/provider retains at most ten detailed revisions; the
domain retains at most 100 revisions and 16 MiB. The latest normalized model label,
categories, groups, counts, capture time, and a private normalized-content fingerprint
are saved atomically. No provider output, error text, command, executable, credential,
or path is persisted. Fingerprints support only comparison to a previous saved capture;
they are neither exposed nor treated as continuous configuration-drift observation.

Session association is future-only and immutable. Sessions that predate the persisted
feature-introduction time receive an explicit no-binding decision. A new session may bind
once to the newest revision for the same repository/provider whose successful commit time
is no later than the session start. A capture completed after session start never attaches
retroactively. Completed sessions retain their compact reference; if bounded retention
removes the detail, the reference remains and reports that detail is unavailable. A real
provider snapshot recorded inside the session always takes presentation precedence. With
neither source, F renders nothing and never asks the user to run `/context`.

## Diagnostics and acceptance

Monitor-private QA counters may measure observer wakeups, routed and unresolved source
events, active and pending hydrations, coalesced and dirty-again work, aggregate
notification-to-acquisition queue delay, bytes and records acquired, normalization
failures, structural catalog fast paths, catalog commit delay, commits, rebuilds, cache
hits/misses, memory, response revisions, checkpoint writes, and checkpoint bytes. Bounded
failure details may retain the latest fixed stage, allowlisted reason code/type, and local
observation timestamp per existing provider failure-counter category (at most nine per
provider). Schema-validation failures may additionally retain at most eight deduplicated
normalized-contract field/rule pairs and a truncation flag. Array indexes, rejected values,
unrecognized key names, and raw issue metadata are excluded; unknown fields/rules remain
unavailable/unknown. They remain in-memory operations diagnostics only, never evidence, checkpoints,
browser API fields, or per-session traces. Raw errors, messages, stacks, paths, and identities
are excluded, and successful work does not erase historical failure details. Bounded
monotonic duration windows may additionally cover catalog discovery, source preparation,
combined acquisition/normalization, catalog projection, session derivation, normalized
store commit, and candidate-to-commit delay. Delay diagnostics are aggregate numbers only;
they contain no native source or session identity.

The manually launched `npm run ops:pipeline` client consumes a fixed versioned snapshot
over a Windows named pipe or per-user Unix socket. That IPC feed is read-only, bounded,
in-memory, and not an HTTP/browser API. Connecting cannot cause acquisition, normalization,
derivation, persistence, or revision publication. The complete operational contract and
the separately deferred renderer `performance.mark()` bridge are documented in
`docs/PIPELINE_OPERATIONS.md`. Browser presentation timing remains unavailable until that
future opt-in milestone is implemented.

Changes to this subsystem must keep focused coverage for complete-record framing, partial
writes, multi-chunk acquisition, append continuity, staged replacement, checkpoint
restart/corruption/privacy, cache-only concurrent GETs, endpoint revision handling,
independent readiness, last-known-good rendering, accessibility, and retry cadence.

The structural performance acceptance criterion is: once a committed response exists,
GET latency and provider-source I/O are independent of raw transcript length, the GET path
performs zero transcript reads, and a background catalog hydration pass cannot starve
`/health` or committed API responses until a frontend proxy deadline expires.

When this contract changes, update this document, the executable provider/monitor
contracts, frontend and API types, focused regression tests, and `AGENTS.md` if a
repository-wide invariant changes.
