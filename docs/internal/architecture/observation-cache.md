# Observation cache and progressive readiness contract

This document is the canonical operational contract for Pomegr's provider-neutral
session observation cache, API serving model, and progressive UI readiness. Plans under
`docs/internal/plans/` describe work or historical reasoning, not runtime authority; when
a plan and this document differ, this document and `AGENTS.md` govern repository changes.
The [Limitations reference](limitations.md)
owns the provider-related and Pomegr-specific inventory and capability matrix;
this document retains authority over acquisition, committed evidence, and serving.

**Contents**

- [Non-negotiable invariants](#non-negotiable-invariants)
- [Pipeline terminology and ownership](#pipeline-terminology-and-ownership), including the
  [activity feed](#activity-feed), [session response domains](#session-response-domains),
  and [paged session evidence history](#paged-session-evidence-history)
- [Agents analytics](#agents-analytics), [public provider service status](#public-provider-service-status),
  [MCP agent-query projections](#mcp-agent-query-projections), and
  [focused report evidence](#focused-report-evidence)
- Cache evidence: [synthetic records and cache comparison](#synthetic-records-and-cache-comparison),
  [cache-lifetime policy normalization](#cache-lifetime-policy-normalization), and
  [cache-read drop evidence](#cache-read-drop-evidence)
- [Cache tiers and bounds](#cache-tiers-and-bounds), including
  [desktop phone access](#desktop-phone-access),
  [provider-folder settings](#desktop-provider-folder-settings), and
  [storage settings](#desktop-storage-settings)
- [Provider observer contract](#provider-observer-contract): the [source ledger](#source-ledger),
  [event-driven acquisition](#event-driven-acquisition-pipeline),
  [startup working set](#startup-working-set-and-lazy-history),
  [session inventory](#session-inventory-and-directory-coverage),
  [complete-record ingestion](#complete-record-ingestion), and
  [replacement and discontinuity](#replacement-and-discontinuity)
- [Publication and persistence cadence](#publication-and-persistence-cadence) and
  [bounded persistence ownership](#bounded-persistence-ownership)
- [Endpoint ownership and revision semantics](#endpoint-ownership-and-revision-semantics),
  including [local Claude usage recovery](#local-claude-usage-observations-and-desktop-recovery)
  and [Claude Remote Control lifecycle](#claude-remote-control-lifecycle-acquisition)
- [Readiness contract](#readiness-contract), [presentation rules](#presentation-rules),
  [frontend API cadence](#frontend-api-cadence), and
  [Home navigation preferences](#home-navigation-preferences)
- [Checkpoint and browser privacy](#checkpoint-and-browser-privacy), including the
  [approved file-history persistence contract](#approved-file-history-persistence-contract)
- [Monitor SQLite store](#monitor-sqlite-store), [repository context inventory](#repository-context-inventory),
  and [current repository plugin setup](#current-repository-plugin-setup)
- [Diagnostics and acceptance](#diagnostics-and-acceptance)

## Non-negotiable invariants

- Provider acquisition and normalization run before and independently of browser GETs.
- Background acquisition and normalization must yield between bounded chunks and session
  hydration units so the monitor's cache-serving event loop remains responsive.
- Production `/api/sessions`, `/api/state`, `/api/session-domain`, `/api/session-history`, `/api/home`, `/api/usage-limits`, `/api/agents`, `/api/provider-status`, `/api/repositories`, `/api/repository-inventory`, `/api/repository-files`, and `/api/storage` handlers
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
- Claude session work-start classification belongs to U2. Only its normalized nullable
  `session.startedAt` crosses the evidence boundary; local command text and classification
  evidence remain private. The [session duration rules](metrics.md#session-duration)
  exclude setup-only records. D derives wall time from committed timestamps, and F renders
  a missing work start as **Not started**. An acquisition tail limit must not advance an
  established start: the adapter reads complete records in yielding bounded chunks and
  retains only the earliest eligible timestamp and bounded pending command linkage in
  a bounded private per-file cache. Source-generation checks invalidate replaced files.
  A transcript that only grew while it was being read (same identity, and the 256-byte
  suffix ending at the observed size still matches) keeps the observed prefix's answer, and
  the next read continues from that prefix. A replaced, truncated, or rewritten prefix still
  fails that acquisition.
  Refresh and checkpoint replacement retain the last known-good revision until a complete
  validated candidate commits; GETs never reclassify raw records. A changed Claude source
  normalization identity schedules existing checkpoints for re-observation without
  changing their schema or exposing private command linkage.
- Session projection may derive the bounded `Agent.customType` display label from
  already-committed type evidence when the resolved role is `unknown`, under the
  [agent role rules](metrics.md#agent-roles). Individual agent-query and analytics
  rows may carry the same validated label; aggregation remains keyed by role.
  Checkpoints retain the existing evidence schema and rederive the label after
  restore. This adds no acquisition to GETs and does not alter revision, readiness,
  or last-known-good retention semantics. Full provider kinds and mapping contents
  remain private.
- UI regions become ready independently. A skeleton represents only a region that has no
  committed value and is still loading; it never replaces already-rendered data.
- Provider/account usage limits and local session/request correlation are separate cached
  domains with separate readiness and revisions.
- The optional repository usage guard consumes only the committed, monitor-private
  account-usage projection. Its hooks cannot start acquisition, refresh a provider,
  hydrate sessions, parse transcripts, or alter a committed revision. Hook-local
  cadence/deduplication state is not observation evidence, browser state, or a checkpoint.
  The bounded Pomegr-data-root record is keyed by a hash of provider/session/agent and
  contains only version, stage, configuration hash, and last-check time; persistent
  `usage-guards` records retain at most 256 entries for 30 days. Stale locks and
  temporary coordination files are cleaned up separately; concurrently active transient
  files are not counted as retained records. It serializes concurrent hook checks and
  suppresses unchanged low, unknown, or threshold notices during routine checks. Every
  guard event, including `SessionStart` after resume, obeys configured cadence. Routine
  due checks emit only on stage changes; a due `SessionStart` may repeat current pressure
  to refresh resumed context.
  Handoff advice follows the repository's existing workflow, location, format, and
  privacy/version-control conventions. No handoff directory or ignore rule is imposed;
  absent an existing workflow, advice requests a concise conversational handoff.
  Handoff contents never enter the monitor or its persistence.
- `localActivity` is a separately committed, bounded same-machine/provider observation:
  original catalog `committedAt`, live count, working count, unknown-activity count, and
  count-truncation flag. It is independent of usage observation time and revision.
  D derives it before catalog-listing truncation, excludes idle and unknown activity from
  the working count, and publishes it with the cached usage projection. Browser or MCP
  GETs never rederive it, list sessions, acquire providers, or refresh usage.
- The monitor-private agent-query API serves only committed, privacy-filtered query
  projections. Its GETs cannot acquire providers, hydrate sessions, parse transcripts,
  refresh usage, or derive a response from raw evidence.

## Pipeline terminology and ownership

Use these names in code, tests, diagnostics, and architecture discussions:

| Phase | Owner (folder) | Consumes | Produces or writes |
| --- | --- | --- | --- |
| **U1 — Acquisition** | `server/providers/claude/` and `server/providers/codex/` on `server/providers/kernel/`; Git in `server/repository/`, resources in `server/resources/` | Raw provider-owned files, events, or APIs | Complete native records and adapter-private cursor state; no committed cache mutation |
| **U2 — Normalization** | The provider adapters, using the `server/normalize/` kernel | Complete provider-native records | Bounded, privacy-filtered normalized candidate evidence |
| **C — Commit** | `server/sessions/checkpoints/session-observation-store.mjs` and `server/persistence/committed-response-cache.mjs` | A validated normalized candidate | One immutable L1 evidence revision |
| **D — Derivation** | `server/sessions/domain/`, `server/sessions/catalog/`, `server/analytics/`, `server/repository/`, `server/resources/` | Committed L1 evidence plus independently committed Git, resource, and usage state | Independently revisioned session domains, composed public state, catalog, Home, correlation, or usage responses |
| **P — Persistence** | `server/sessions/checkpoints/`, `server/sessions/history/`, `server/persistence/` | Committed normalized evidence | Atomic L2 checkpoints and committed normalized history; maintenance runs separately |
| **S — Serving** | `server/serving/request-handler.mjs` and the serving projections in `server/sessions/domain/` | Committed L1 response revisions | A response body, loading shell, or `204 No Content`; never normalized evidence |
| **F — Presentation** | `app/` (React) | Provider-neutral API responses | Frontend view state and independently rendered regions |

`server/runtime/` orchestrates the phases; it owns scheduling, not evidence. U1 and U2 are the upstream raw-data boundary. C, D, P, and S are downstream consumers of
normalized state. P writes the durable cache; S only consumes committed response caches.
F consumes the browser API and never fills or owns a backend cache.

### Activity feed

D derives `ActivityFeed` from the full retained normalized event set: total,
tool-call count, message/input count, failed-shell count, and bounded WorkKind
counts with median resolved wall durations. S serves only its newest 200 items;
the small state feed remains a summary projection. Activities consumes the
separate paged request-group history below: five groups around its selection,
with calls nested only when their recorded request association validates. Totals
can exceed the state window. No page, range, selection, or agent-scope action
acquires provider evidence. Unlinked normalized events remain retained where
supported but do not enter the grouped feed.

Explicit request selection uses the committed exact query to align chart, request
details, and feed. A browser sends a revision only for that exact retained query;
a matching `204` retains its body. New range or selection queries fetch a committed
body, preserve last-known-good bodies while loading, and cancellation or a stale
response cannot replace a newer selection. Background revisions preserve anchored
older selections; historical sessions never follow live additions.

Activity items add only nullable `durationMs` (0–86,400,000 ms) and `requestId`
(the opaque ID of a served request snapshot). U2 pairs recorded call/result
timestamps privately; D validates request membership before stamping links.
Unmatched or unavailable durations and links stay null. Provider call IDs and
request-mapping keys never cross the browser or persistence boundary. C/P retain
only validated normalized evidence. These fields round-trip through observation
checkpoints; aggregate feeds are derived from retained evidence after restore.
Readiness stays `activityEvidence`; the Requests chart retains its separate
`contextEvidence` gate. Cache-only GETs, last-known-good replacement, revisions,
checkpoint cadence, and browser polling remain unchanged.
Claude's `conversation-activity-v6` and Codex's `codex-activity-v2` source
fingerprints trigger rehydration of checkpoints produced before duration and
request-link normalization was added.
Claude merges recorded tool IDs across fragments sharing one request identity,
including live snapshot merges after a read window advances. The private
ID-to-kind map is stripped before normalized evidence and checkpoints. Usage
remains the latest request snapshot; fragments never add token totals. Revision
v5 also rebuilds the incomplete links produced by the earlier fragment handling.
Revision v6 links assistant replies, including reply-only requests, through an
exact actor-scoped recorded request identity. U2 retains only an opaque reply ID
in its private correlation index; the index is stripped before evidence and
checkpoints. D serves only links to retained request snapshots. Missing usage,
altered identities, and requests outside the served window leave links null;
timestamp proximity cannot establish a link. Replies remain message events.

### Session response domains

D projects each committed session into seven independently revisioned response domains:
`session-summary`, `agents`, `agent`, `signals`, `repository`, `resources`, and
`details`. `agent` selects one normalized agent ID from its committed projection.
`session-summary` alone contains the session header and Overview inputs: lifecycle,
readiness-qualified agent status counts, all-agent context, current-agent rows, two efficiency signals, a repository summary,
the latest 48 request-local snapshots with agent roles, plan progress and tasks, work
kind totals, the bounded session signal for the header tag, the normalized cost
estimate, and a readiness-qualified resources-presence flag used only to decide
whether the Resources tab can be hidden. `signals` owns the committed Efficiency,
Cache lifetime, and agent-reported Reported signals sections, including the same
session signal in its detailed row.
Deterministic evidence and labeled inferences remain distinct from
agent-reported signals, which may be stale. Missing source evidence remains unavailable;
historical and current projections remain isolated. Current-agent fallbacks come from
committed normalized tool calls attributed by agent ID, never from display labels, and the
repository summary carries a branch comparison only after its remote check succeeded, as the
Repository tab does. `agents` also carries the roster's per-agent history marks: insights,
loop patterns, possible full refills, cache-read drops and context boundaries. The other
domains retain their corresponding normalized public state. The inspector
also carries bounded selected-agent request, insight, cache and task evidence. Each
composed domain preserves the readiness of its source sections: a ready core does not
make missing agent, context, activity or request evidence ready. Request-strip readiness
is retained separately from its bounded items; missing evidence is never a measured zero.

Each projection has its own monotonic revision clock and bounded readiness. D stages and
serializes every candidate before atomically publishing any of them. A failure therefore
retains the complete last-known-good set and emits no partial revision events. The
top-level observation time is metadata rather than semantic content, so a later identical
observation does not revise every domain. Catalog lifecycle changes can revise the summary
without revising unrelated domains. Startup derives the domains for every restored L1
entry even when checkpoint rederivation is unchanged.

The derived-domain cache retains at most 24 sessions by default. A session not read or
rederived for ten minutes drops from this cache while its committed L1 evidence or L2
checkpoint remains authoritative. The first later GET returns explicit loading readiness
and queues a D-only rebuild from committed state. It never parses or acquires provider
data. Rebuild revisions cannot reuse an ETag previously held by a client.

Repository paths in the new projection are checked against the canonical Git root
retained privately by background enrichment, including when the session working
directory is nested. The dedicated validator rejects traversal, absolute and Windows
special forms, configured provider roots, and link escapes. An unknown root or uncertain
containment cannot admit a path. Existing committed live repository/resource evidence
remains available, and missing historical evidence never falls back to today's working tree.

The `repository` domain's `fileHistory` block is served from the `file-history-domain`
source (see "Approved file-history persistence contract"), and `recordedAt`,
`commitsInSession`, `gitTasks`, and the recorded `gitObservedFiles` accompany it. A historical session's repository block
is the recorded snapshot described there when one exists; without one it keeps the
branch-only recorded state. The `resources` domain's `retained` block is committed by the
`resource-domain` monitor-store contributor, registered after `resource-history` so it
reads the same cycle's committed rows. For each demanded session (at most 32 per cycle) it
reads the newest 1,440 minute rows (`minutesTruncated` marks a longer curve), the
`resource_curve_removals` record, and the top three peaks per display field with their
sample windows and matched execution-task IDs, then keeps the normalized block in memory.
An explicit retained-resource request is scheduled before the ordinary demanded sessions,
so a selected session is not delayed behind older retained sessions when the cycle bound
applies. When more newly requested sessions remain after that bound, the contributor queues
one further checkpoint pass; a failed read never self-schedules a retry loop. Remaining
ordinary sessions keep their ordinary demand order.
`retained()` is a pure map lookup and `request()` only nudges the store to schedule a
cycle; a GET never reads SQLite. Readiness is `unavailable` without a store, `rebuilding`
while the store rebuilds, `loading` until a block commits, then `ready`. A failed read
keeps the session's previous block. `curveRemoval` carries `age_retention` or
`size_cleanup` from the removal table, or `not_recorded` when peaks exist but no curve
rows or removal record do; missing rows are never presented as zero. The Resources tab is
offered when live samples or stored rows exist.

### Paged session evidence history

`GET /api/session-history` serves committed normalized history independently of
the bounded `/api/state` summary. Query kinds are `activity` and `requests`;
responses carry readiness, revision, total row count, offset, a bounded page,
and the selected request's linked-event count. Activity pages contain at most
eight rows; request windows contain at most 60 (20 on phones). Agent scope,
request lookup, request-only filtering, and an opaque event anchor operate on
committed indexes. GETs never acquire or normalize provider records.

Each request record in this surface, including a grouped request header, also carries
`model`: the one model identifier recorded for that request, validated monitor-side as a
bounded identifier (at most 120 letters, digits, `.`, `_`, `:`, `@`, `+`, `[`, `]`, or
`-`, with no drive prefix, path separator, markup, prose, or control characters), or
`null` when it is missing, synthetic, unsafe, or was committed before per-request models
were retained. It describes that request only, not agent model history, routing, or
service tier. The `/api/state` request-snapshot feed, cache events, cache-read drops, and
reports still exclude request-level model identities. Older committed generations serve
`null` until a complete replay commits a replacement revision; a GET never backfills it.

Activity history additionally accepts a positive request-number `from`/`to` range
covering at most 64 consecutive numbers, `selected`, and an opaque continuation. Range
endpoints must be supplied together; reversed or out-of-bound ranges, duplicate query
keys and unrecognized query keys are rejected. It returns at most five
scoped request headers around the selection, adjusted at either end, with calls nested
under their recorded request. A retained request header without request-linked calls
reports `noMatchingCalls`. Each group carries at most 50 calls and a
page carries at most 200; remaining calls use explicit continuation. A continuation
reserves budget for its target group before other groups, so dense preceding groups
cannot prevent progress. Nested calls retain chronological order. Stable request
numbers do not change across agent scopes. Calls without a recorded request association stay
in the legacy flat feed but never enter a request group. Agent scope is applied
consistently to request headers, nested calls, work-kind counts, median wall durations,
and shell-task totals. A request-linked call with no normalized actor participates only
in `scope=all`.

Activity rows and offsets are chronological, earliest first, matching Requests.
Page 1 contains the earliest scoped events. Activity `latest` and `last` select
the aligned final page, which may contain fewer than eight rows. Serving reverses
the committed descending activity index before applying offsets and lookups;
existing persisted generations remain usable without rewriting them in a GET.

Request pages also carry a full scoped minimap `overview` from the same committed
revision. Each chronological tuple contains only that request's non-negative safe
integer uncached-input, cache-write, cache-read, and output counts. These are
independent observations, never buckets, cumulative totals, or sums across requests.
The tuple count equals the scoped history total. Publication stores the tuples in
the normalized index; serving reads that index and only the selected detail blocks.
It never loads all request-detail blocks for the minimap. Index schema version 3
contains request overviews and the activity work-kind, status, duration, request, and
agent references used by grouped reads. Older indexes are not served as grouped history;
ordinary background publication replaces them under a new immutable generation,
including when normalized history is unchanged. A v3 index with a missing overview
returns a null overview until the same background upgrade. Malformed or incomplete
overview tuples degrade to null.
The overview adds no provider identities, work details, paths, or raw records.
Request-page preloads use `overview=0` to omit the already-loaded overview;
omission or `overview=1` retains the default response. Other values are rejected.

#### Incremental history persistence

Disk-backed contribution publication uses per-session SQLite schema version 5 in
the existing private history directory. Indexed request/activity rows and stable
request-number records are the bounded storage units. One transaction publishes
changed rows, compact index references, readiness, admission fences, and the current
revision together. SQLite's rollback journal preserves the previous complete
transaction until commit; it replaces the full-generation manifest switch for this
format. DELETE journal mode avoids an accumulating WAL or replay chain. This is an
in-process persistence implementation, not another service or a provider worker.

A small suffix contribution reads and writes only its supplied normalized identities,
their correlation/number records, and constant-size metadata. It does not deserialize
or rewrite the retained history, even with `maxResident: 0`. Unchanged rows remain in
the same indexed pages. Full explicitly requested history replay still performs a
complete validated replacement. The first background contribution to legacy v3
history migrates its committed snapshot once; GETs continue to read legacy committed
indexes and never perform that migration. Existing v3 generations are retained as
legacy evidence, not refreshed compatibility copies on each new contribution.

Contribution admission retains at most 24 pending domain/session keys, 16 MiB in
aggregate, 8 MiB per contribution, and 16,384 supplied rows. Same-epoch queued updates
merge by normalized row identity with newer values winning; source epoch changes
replace the pending contribution. These bounds constrain admission, not the lifetime
of already committed normalized evidence. Overflow or write failure preserves the
last committed history. Runtime retries retain at most 32 keys/16 MiB with three
attempts; state/catalog polls never add to this demand.

History GETs use read-only transactions. They read compact normalized indexes and
only the requested detail rows, preserving stable numbering, grouped Activity,
request overviews, and existing browser revision semantics. They never open a writable
database, recover a journal, publish, compact, or replay provider evidence. Following
an interrupted writer, a hot rollback journal can temporarily make read-only history
unavailable until background publication or scheduled maintenance opens it for recovery.
The previous complete transaction survives; ordinary GETs do not repair it.

Free database pages are reused. Explicit low-priority maintenance reclaims at most one
free page per visited database, within the shared maintenance batch budget. Legacy
generation cleanup keeps the current and preceding generation and deletes only
recognized files incrementally; leases protect readers. Maintenance and compaction
never run from a contribution or a GET. Persistent records contain only the same
allowlisted normalized history metadata; raw content, native IDs, source paths,
credentials, and diagnostic payloads remain excluded.

Provider-owned `readSessionHistory` replays available session sources in the
background. Complete normalized history has no 100-request or 200-event lifetime
cutoff. Ordinary context, cache-event, report, and state-feed budgets remain
independent. Complete candidates validate before replacement; incomplete or
failed reads preserve the last committed history. History persistence contains
only normalized request snapshots, sanitized activity metadata, stable request
numbers, and indexes. It excludes raw content, native identities, transcript
paths, and private correlation keys. Generation files and a committed manifest
allow bounded page reads without reparsing complete histories in GETs.
Complete replay uses two bounded ownership lanes: one foreground slot for selected
history demand and one background slot within the separate history scheduler.
Only an Activity or Requests `/api/session-history` request may enqueue or promote
asynchronous replay when committed history does not match its current private
observation-source key; it still returns committed or loading history immediately.
Startup, selection through state or domain APIs, state polling, and fresh provider
observations do not automatically schedule complete replay. Observations update
the private source proof so the next history demand can detect stale history.
Same-session replay remains serialized and coalesces one follow-up when its source
changes during an active read.
The runtime retains at most 128 private attempted and completed source keys. A
complete replay rejected by a newer contribution fence queues one follow-up; an
incomplete stable source waits for a later source observation instead of spinning.
A missing or invalid committed history manifest clears the matching proof so a
later history request can schedule repair. None of these keys enter history
persistence, diagnostics, revision events, or browser state.
Source-complete Activity may commit first with null request links and durations.
Provider-private history ownership annotations stay in a separate history projection;
registering progressive callbacks must not add fields to the strict session evidence.
Observer-path tests validate session publication with those callbacks enabled and retain
normalized agent ownership in both early and enriched history rows.
The same observer then commits a bounded request contribution only after the
existing strict monitor-side correlation resolves it; that contribution atomically
adds request snapshots and enriches matching Activity IDs without removing retained
rows. Both contributions carry private source epoch and sequence watermarks. A
replay fences both domains and is discarded if either advances while it reads, then
the runtime schedules one dirty follow-up replay. Same-process contribution bursts
coalesce to one pending durable write; unchanged watermarks do not advance the
browser-visible history revision. A failed durable contribution retries at most
three times from its already-normalized envelope and never causes a GET acquisition.
Private producer-admission watermarks are bounded to the active in-memory session
cap. When that LRU cap evicts a current-runtime session, its narrow private
watermark is restored from a runtime-nonce-bound sidecar before another
contribution is admitted; this preserves stale rejection without evicting
normalized history. A fresh runtime deliberately ignores the prior nonce so a
restarted source may begin a new epoch/sequence safely.

The maintained synthetic benchmark runs cold startup, disk-restored history with
`maxResident: 0`, a 1,000-row warm append, and a 16-contribution continuous
burst. It records only controlled history readiness, convergence, process CPU/RSS
deltas, and GET/publication counts. Its per-scenario traces and summaries are not
provider-I/O, whole-application, renderer, or paint measurements.
The catalog's native presence/status remains an independent catalog observation;
detailed per-agent lifecycle still shares the session acquisition path and has no
separate producer until its source dependencies are split and measured.
The monitor privately caches at most four parsed history manifests, bounded by
16 MiB of source JSON across entries (parsed-object overhead is additional).
Every read verifies file identity, size, and nanosecond modification/change times;
a cold read rechecks that fingerprint before caching. Changed, removed, or corrupt
manifests invalidate cached entries, as does successful local publication. Least
recently used entries are evicted at either bound; larger manifests are served
without retention. Only selected immutable detail blocks are read, and all public
rows still pass the existing normalized serializer. This cache adds no provider
acquisition, browser fields, checkpoints, or persisted diagnostics.

Opaque request identity does not include a streamed fragment's changing
timestamp. A session-scoped number is assigned on first history publication and
preserved across filtering, paging, appends, and restart. Activity stores its
normalized agent identity and request reference; display labels never establish
ownership. A linked request need not occur in the current state summary or
loaded chart window. User inputs and system events without an established
request relationship remain unlinked; timing alone never establishes one.

F keeps at most the current activity page and its adjacent pages, invalidating
neighbors when history revision or scope changes. It renders up to eight rows, keeps
existing content during a same-scope load, ignores stale session responses, and
anchors older live pages, including page 1, to their first visible event. The feed
opens at the latest page and follows its advancing page boundary on refresh.
Manual older-page navigation or older-request selection anchors the view;
new events offer View latest, which resumes following the final page. Explicit
request selection reveals linked rows, and an activity-row
selection loads an absent request window. History readiness is separate from
the summary's activity/context evidence readiness.
Request selection first checks the current and adjacent committed activity pages;
a resident match renders synchronously without a request lookup. A partial page
does not establish the full linked-event count, so that count is omitted for a
resident match. Scope initialization consumes a simultaneous request navigation
once, and repeated selection of an in-flight target reuses that lookup.
Foreground navigation preserves rows beneath a translucent loading veil and
exposes a live status outside the busy table, including while the requested chart
window is pending because of chart-window navigation. Selecting a visible
Activity row only loads the linked chart details; it must not veil or disable the
already-committed Activity page. Stale row links cannot activate while the feed
itself is being replaced. Failures remove the veil and
explain that the previous page is retained. Live Activity refreshes on matching history
publications and the shared 30/5/30-second fallback described under Frontend API cadence.
Refreshes stay visually quiet and preserve older-page anchors. A revision arriving during
navigation coalesces into one follow-up after the lookup finishes. Historical hydration
uses events and reconnect revalidation; ready historical queries have no periodic timer.
These are F presentation states, not backend readiness.
Refreshes never cancel an in-flight navigation. A loading or unavailable response retains
the same request lookup, scope, offset and anchor instead of substituting the latest page.
New navigation and unmount cancel obsolete work. GETs continue to serve committed history
only, preserving last-known-good values and checkpoint/browser privacy.
Background cleanup retains the current and previous immutable
page generations after the new manifest commits.

F preloads request history in sequential pages of at most 60 rows after the initial
overview arrives, independently of pointer navigation. Only the viewed session,
agent scope, viewport capacity, and committed revision are resident in memory;
there is no browser persistence. Cached positions span that revision's retained
history, allowing any fully loaded 60-row desktop or 20-row phone window to render
synchronously during dragging. The initial page remains visible while other pages
load. Failed preloads retain loaded rows; readiness, a new committed revision or reconnect
can resume work without a fixed preload timer. Uncached preload queries omit the revision
so the monitor returns their body. Session, scope, viewport and revision changes abort
obsolete preloads and discard their
positions; responses with a different revision or total never mix into the cache.
Preloading reads only existing committed pages, never provider evidence. Foreground
navigation retains its existing fallback for windows that are not yet resident.
Activity request links look up normalized request identity in the same cache and
reuse any complete resident window containing that request. The identity index
is discarded together with positions on session, scope, capacity, or revision
change. A newer explicit row or bar selection cancels pending request navigation;
late responses and retry timers cannot restore the older target.

Before the first request-history page arrives, F renders the latest scoped window
of committed request snapshots already present in session state (60 desktop, 20
phone). This recent-request preview uses observation times, never fabricated
history numbers or a full-history minimap. It remains visible during history
loading or failure; retries replace it with the committed history page and its
stable numbers, preserving a selected request by identity when present. A ready
request page or available preview can render independently of the broader
`contextEvidence` loading gate. No preview changes evidence, checkpoints, or GET
acquisition behavior.

Selecting the newest request on the latest scoped live page resumes automatic
selection and event-driven history refresh. Activity row links, request bars and
keyboard steps share that selection rule, including after a linked window loads.
Older selections stay pinned while incoming history totals extend the minimap;
historical sessions never follow live appends. Navigation carries its follow-latest
intent to Activity, and manual Activity paging remains independent between selection
actions. Live recovery uses the shared fallback cadence rather than a three-second timer.

Codex U2 correlates rollout activity before global sorting, within each normalized
actor's source sequence. Private parser callbacks identify normalized calls,
replies, and usage observations by record position; no callback index or request
mapping enters evidence or persistence. A native `token_usage_record` seals an
output group, and its request-local components must match the next `token_count`.
Legacy streams can close a contiguous output group at token count directly.
Turn/user/lifecycle boundaries, compaction, unusable usage, conflicting repeated
identities, and a new response after tool results without closing usage break
association. Pending output has no link until usage arrives. Canonical rows can
inherit a link only through an identical normalized rollout event ID, after
source merging. Snapshot fallback identity is the same for live and historical
reads. Only opaque request IDs and normalized issued-work counts leave U2.
Adjacent completed-message/response-item mirrors with matching text and phase
share one normalized reply identity when the response item omits its native ID.
The text digest is private and never establishes a cross-request association.
Full observation hydration uses the strict ordinary evidence shape; history-only
ownership markers are present solely during the separate history normalization.

### Messages and summaries in Activity

U2 emits **Assistant replied** only for recognized assistant text records and
**Summary updated** for Claude Code's native `system/away_summary` records.
Reasoning, tool calls/results, synthetic messages, compaction summaries, and
user-authored lookalikes do not establish these events. An assistant reply does
not require usage data; a summary update never becomes a request snapshot.

Events carry only a bounded opaque ID, original provider timestamp, normalized
actor label (`System` for a summary), fixed event label, existing `report` work
kind, empty detail, and null failure status. No message/summary text or native
request/record identity enters the activity feed or its checkpoint. Provider
summary text remains governed by the separate session-summary contract.
Repeated fragments of the same assistant message collapse to one event at the
latest recorded text timestamp; distinct message identities remain separate.

Claude retains these normalized events in the same incremental per-source reader
as system task deliveries below, independently of raw acquisition tails, and
bounds the merged session activity to the newest 256 entries. Complete replay
recovers retained events after restart. Partial, malformed, or unavailable
replacement sources preserve the last complete observation. The normalization
revision invalidates older checkpoints without requiring transcript growth.
C/P use the existing activity schema; D includes these events in recent activity
without adding tool calls, token usage, efficiency signals, or request timestamps.
GETs remain cache-only and UI polling is unchanged.

Codex recognizes assistant message items and delivered rollout message events.
Native message identity joins streamed and canonical copies; rollout timestamps
take precedence. Without identity, only an immediately adjacent event/response
pair with matching text and phase qualifies as a mirror. Intervening records
break that comparison. Fallback event IDs include the original timestamp so
separate identical replies survive incremental reads. The existing 24-record
lookbehind preserves an adjacent pair split across observations. Canonical final
replies may use their native turn-completion time; filesystem and observation
times never substitute for missing delivery evidence. At most 256 replies per
parsed source and 4,096 merged activity events survive the existing Codex
observation/checkpoint pipeline. Codex has no equivalent away-summary event.

### System task notifications in Activity

Claude U2 distinguishes provider-owned delivered task notifications from human input
using the native system-origin metadata. It emits only the provider-neutral `System`
actor, fixed `Task completed`, `Task failed`, or `Task stopped` label, original delivery
timestamp, opaque event ID, existing work kind, and fixed background-task detail.
A matching prior structured async launch resolves `Background agent`, `Background command`,
or `Background workflow`; unavailable or mismatched launch evidence leaves `Background task`.
Unknown or malformed outcomes are omitted and never fall back to human input. A user
pasting notification-shaped text remains human input. Queue operations alone are not
deliveries. System deliveries can resume a turn independently of human-input classification.

The adapter reuses bounded, yielding U1 JSONL acquisition for complete replay and
incremental U2 reduction, retaining at most 256 calls, launches, and normalized deliveries
per source across at most 50 sources in memory. Acquisition tails do not expire normalized
deliveries. Partial, malformed, or unavailable replacements retain the last complete result;
a complete valid replacement replaces it atomically. Native task/call identities and
notification content remain adapter-private. An adapter normalization revision in the opaque
source fingerprint rebuilds pre-fix checkpoints even for unchanged transcripts; subsequent
unchanged observations do not publish new revisions. C and P use the existing activity schema;
D selects recent activity without adding notifications to tool counts or efficiency rules;
S remains cache-only, and F renders the supplied labels without provider recognition or
polling changes. Codex collaboration actions retain their existing normalization; they
do not establish a delivered completion notification.

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

The official source and component-filter details are documented in [provider status](provider-status.md).

## MCP agent-query projections

The seven MCP observation queries form an independent D Derivation and S Serving domain.
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
The desktop parent also removes its matching descriptor after confirmed monitor-worker
exit, including forced termination, startup failure, and an unexpected worker exit.
Both normal quit and startup rollback await this parent-owned cleanup even if the
worker has already exited. Cleanup never removes a descriptor belonging to another
launch, never stops the development monitor, and never changes MCP GET serving or
fallback behavior. Terminating the entire desktop process without running parent
cleanup can still leave a stale descriptor.
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
failures. They also contain one bounded Markdown report produced by the shared dashboard
report renderer from the committed public state and its session revision. Context is one request-local snapshot, never cumulative token consumption,
throughput, billing, or session spend. Failure selection prefers a matching execution
task over its tool-call record and excludes commands, arguments, descriptions, output,
raw provider errors, and tool results. Public provider health does not establish impact or
causation for a specific account, model, or session. Current account usage limits remain
independent of agents and historical sessions.

Unchanged immutable session snapshots reuse their bounded report rendering, agent
rows, and latest-context maps across query-projection refreshes. A replacement
snapshot or revision derives them again; cache ownership follows the retained
snapshot, with no persisted report cache. Projection
generation times, report filenames, and recent-failure windows still advance on each
refresh. Serving continues to select a precomputed report and never renders or
acquires provider data. This prevents unrelated startup restores from repeatedly
rendering every historical report on the live publication path.

Clients use these queries only when an observation can change the next decision. They do
not poll or call every query at session start. The tool-specific triggers and caveats are
documented in the public [MCP queries guide](../../public/using-pomegr/mcp-queries.md);
[MCP observation queries](mcp-queries.md) holds the resolution, evidence, and transport contract.

The Codex stdio MCP process resolves a default qualified session reference only from
one valid host-supplied thread identity (`CODEX_THREAD_ID`/`CODEX_SESSION_ID`).
Conflicting providers, conflicting IDs, malformed IDs, and missing identity fail
unavailable. Claude's `CLAUDE_CODE_SESSION_ID` is never a default: the subprocess can
retain its launch ID after `/clear` or a session switch. Instead, the plugin's
`PreToolUse` hook fills an omitted `session_ref` on each recognized session query from
the host-owned current `transcript_path` filename. A UUID-named main transcript maps
directly; a recognized `subagents/agent-*.jsonl` locator maps to its UUID-named owning
session directory. The hook ignores stale `session_id` metadata, reads no transcript,
persists nothing, and emits only the qualified reference and existing tool selectors.
The path never enters MCP arguments, results, monitor state, or errors. The hook does
not grant permission. An invalid locator or missing hook leaves the MCP default
unavailable, never bound to the previous Claude session.

The private GET still receives an exact qualified reference and never infers one from
repository roots, timestamps, catalog ordering, or process activity. All session reads,
including `get_session_report`, retain optional exact `session_ref` overrides for
historical and delegated inspection. The hook preserves explicit selectors. The MCP
reader rejects responses identifying a session other than the requested reference.
Selection changes no cache-only GET, readiness, retention, checkpoint, or revision rules.

## Focused report evidence

`metrics.tokens.reportEvidence` belongs to D Derivation and is serialized in the same
committed public session response as the rest of `/api/state`. It does not introduce
an export acquisition path, polling lane, or checkpoint schema. Dashboard export may
refresh the existing cache-only state endpoint; rendering consumes one returned
revision or the last visible snapshot. The MCP agent-query D projection runs the same
report renderer over that committed public state and stores the bounded Markdown for
cache-only S Serving. The private report GET selects the precomputed value and never
renders, hydrates, or reads a transcript. A loading/unavailable region cannot be
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
references, request-level model/comparison identities, diagnostics, paths, prompts,
summaries, commands, and output never enter response or checkpoint data. The report
renderer may additionally include only the bounded latest `model` and `effort` already
present in committed normalized agent state. Missing values remain unavailable; service
tier, routing, model history, and provider-native runtime payloads remain excluded.
Report-local task selection consumes already normalized per-agent task feeds.

## Synthetic records and cache comparison

Claude U2 distinguishes recognized synthetic assistant records from requests with
invalid usage. Synthetic records create no usage snapshot and preserve the previous
comparable request; real missing or malformed usage remains a comparison boundary.
Compactions and model changes still prevent attribution. The exact recognition and
metric semantics are defined in [Metrics](metrics.md#context-usage).

The Claude source fingerprint includes normalization revision `conversation-activity-v6`.
Background hydration replays unchanged sources whose checkpoints predate this revision,
then C replaces the evidence atomically after complete validation. Last-known-good
evidence remains available while replay is pending or fails; subsequent unchanged
observations do not churn revisions. Checkpoint schema version 1, original observation
timestamps, cache-only GETs, readiness, UI polling, and privacy filtering are unchanged.
Synthetic markers and raw usage never enter browser state or checkpoint fields.

## Cache-lifetime policy normalization

U2 resolves Codex's documented `30m+` minimum only from each request's recognized recorded model, using the adapter-owned family allowlist documented in [Metrics](metrics.md#cache-events). This includes GPT-5.6 variants, GPT-6 Astra, Sol, and Luna, and GPT-6.1 Sol, with date-suffixed snapshots; `codex-auto-review` remains unavailable until its policy is established. Missing or unsupported models stay unavailable; neither current settings nor a parent agent supplies a missing request model. D aggregates retained resolved lifetimes independently per normalized agent before the presentation feed is capped. F formats `30m+` as `cache TTL ≥30m` in the existing List and Tree metadata, without provider-schema logic or inline policy documentation. Minimum-only values never establish an expiry threshold.

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
before presentation caps, using the thresholds and boundaries in [Metrics](metrics.md#cache-read-drops).
The read-share transition is at least 80% to at most 20%, with an independent
requirement that actual cached tokens fall by at least 80%. The broader
current-share ceiling changes only D derivation; evidence and response shapes
remain compatible. Same-model occurrences omit `kind` and retain the existing
possible-refill inference. When recorded models differ, D may retain the occurrence
with the bounded `kind: "model_change"` value when the same normalized agent and
comparison group have adjacent observations with explicit provenance, no
compaction/context-reduction, and the prompt-size, read-share, cached-token collapse,
and zero-write gates pass. F labels that occurrence **Cache reuse dropped
across a model change** and makes no refill, expiry, or causation inference; model
identifiers remain monitor-private.
This feed is separate from write-backed cache events and report counts. F reuses
the existing agent indicator and popover, labels the same-model conclusion as an inference,
and links the [same-model signal definition](signal-dictionary.md#cache-read-reuse-dropped)
or [model-change signal definition](signal-dictionary.md#cache-read-reuse-dropped-model-change).
It never reconstructs comparisons from request
rows or provider schemas. S continues to serve committed responses only: no new
endpoint, source read, subscription, polling lane, or provider request is added.

The optional evidence fields are compatible with checkpoint version 1. A legacy
checkpoint without explicit eligibility remains unknown until normal background
normalization commits a complete replacement. Eligibility and predecessor metadata
remain inside L1/L2 evidence and never serialize to the browser. The public feed
allows only readiness, normalized agent IDs, bounded counts, opaque occurrence IDs,
original timestamps, two read percentages, elapsed gaps, and the optional bounded
`model_change` kind. No raw usage, source paths, model identities, comparisons,
prompts, or credentials are added. Existing
revision handling, atomic commits, last-known-good retention, readiness, cache-only
GETs, and UI polling remain unchanged.

## Cache tiers and bounds

| Tier | Authority and contents | Current default bound |
| --- | --- | --- |
| **L1 evidence cache** | Runtime-authoritative immutable normalized session evidence in monitor memory | 100-entry and 8 MiB pruning targets for unpinned entries; one entry larger than 8 MiB is rejected |
| **L1 response cache** | Prebuilt provider-neutral JSON responses and independent revisions for cache-only serving | Session domains retain a soft bound of 24 sessions (live or open catalog rows and the most recently requested session are exempt up to 128) and evict after ten minutes without a request or semantic change; other response domains retain their documented bounds |
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
Network verification controls forwarding independently of monitor readiness. A failed
probe or temporary absence of an eligible adapter suspends access: the native state is
`recovering`, the existing listener/address and bounded paired-client credentials remain
in memory, and the five-second watcher keeps checking. All upstream reads and streams
are cancelled; requests receive a fixed no-store `503` with `Retry-After: 5`, and new
pairing is blocked. Pending pairing codes are discarded without extending their lifetime.
No last-known network observation authorizes forwarding while verification is unavailable.
The same in-flight observation is shared by native state reads, requests, and the watcher.
Only a successful observation of the original private adapter/profile identity, address,
and subnet resumes forwarding and permits existing phone credentials to work again.
Repeated temporary failures keep access suspended without expiring the existing pairing;
retained sessions and retry cadence remain bounded. Public networks, confirmed identity
changes, malformed/unsupported normalized observations, Stop, disposal, and listener
failure still revoke access. Newer observations and explicit revocation win over pending
request checks; recovery does not reopen a stopped gateway. This changes native phone
state only, not normalized session APIs, cache ownership, revisions, or checkpoints.

### Desktop provider-folder settings

`desktop/runtime/provider-settings.mjs` owns the native **Settings → Providers** action.
Version 5 desktop settings may persist only three additional bounded absolute
directory overrides: `claudeConfigDir`, `claudeProjectsDir`, and `codexHome`.
Versions 1–4 migrate in memory with null overrides; invalid/future settings remain
protected from writes. These configured roots are a private native-settings
exception, never transcript-file paths or observation checkpoint fields.

Only the trusted main desktop frame may request a fixed-key folder picker, clear
an override, discard a draft, or request save/restart. Native dialogs own the full
paths. IPC returns only selection (`default`, `environment`, `custom`), directory
availability (`available`, `unavailable`), persistence/pending booleans, and fixed
action statuses. Availability checks only directory readability; it does not
assert that sessions exist. No HTTP or LAN action configures sources or triggers
provider acquisition. The renderer never submits a path.

The local or authenticated paired LAN browser's read-only `GET /api/provider-folders` returns only
the three effective startup folder roots (`claudeConfigDir`, `claudeProjectsDir`,
`codexHome`). Each value is a bounded absolute path of at most 4096 characters
without control characters, or `null` when unavailable. This endpoint serves a
prepared startup configuration, never acquisition, file contents, transcript-file
paths, native drafts, or credentials. It has no mutation methods or path inputs.
The web route requires a loopback host and same-origin request; the monitor boundary
does not permit cross-origin browser access. The LAN gateway forwards only GETs
without query strings or bodies after its pairing, origin, and current-network
checks, using the trusted upstream host and authorization. The LAN-bound development
server validates the actual peer against local interfaces and the requested host
against the machine name, its `.local` name, or local interface addresses. It validates
the original origin before canonicalizing a trusted request to loopback for the web
route; forwarded headers cannot authorize remote clients. Unpaired remote development
clients are denied. Responses are no-store, and these roots never enter ordinary normalized
state, reports, logs, checkpoints, or browser persistence. The browser shows
selectable read-only fields and directs folder changes to the desktop app.

Selections remain native drafts until a native save/restart confirmation. Validate
newly selected directories again after confirmation and persist through the shared
serialized settings writer before restarting only Pomegr. Defaults remove saved
overrides and use the launch environment or standard provider home. The restart
passes inherited private configuration only to the new native process, never back
into the old in-process web host's environment. Other desktop settings writes must
preserve committed provider overrides. Choosing a folder never changes provider
files, credentials, or running coding tools.

Saved choices override matching launch environment values. Claude's effective
configuration root supplies default projects, native registry, tasks, usage
credentials, and plugin/native setup; a separate explicit projects root affects
only transcript discovery. A saved Claude configuration/projects override disables
an inherited single-file pin. Codex's home applies to history, native presence,
plugin setup, and the account-only usage reader together. Profile changes start a
new monitor; checkpoint source compatibility and atomic commit rules still apply.
GETs remain cache-only, and existing committed regions retain their last known
good revisions during reconciliation.

For desktop custom Claude configuration roots, default local usage and cost
destinations are isolated beneath their existing storage roots by an opaque digest
of the normalized profile root. The standard profile retains its existing paths.
Do not import an unscoped local reading into a custom profile. Explicit snapshot
root environment overrides remain operator-owned destinations; separate profiles
require separate overrides. The local bridge writer and monitor must use identical
destinations. Existing recognized generated bridge commands targeting older roots
require a separate native **Enable local usage** confirmation to rebind those
assignments while preserving the delegate. Malformed or ambiguous bridges remain
unavailable. Snapshot payload allowlists, observation ages, account-cache source
fingerprints, and retry deadlines are unchanged. Snapshot destination paths and
profile digests never enter browser state or reports; the separate settings view
exposes only the three configured provider roots described above.

### Desktop storage settings

`desktop/runtime/storage-settings.mjs` owns the native **Settings → Storage** action.
Version 6 desktop settings may persist only two bounded enum overrides:
`retentionDays` (30, 90, 180, 365, or keep all) and `storeMaxMb` (250, 500, 1024,
or 2048), each null or a fixed choice. Versions 1–5 migrate with null storage.
Only the trusted main desktop frame may set a draft field, discard, or request
save/restart; IPC returns only enum values, pending state, and status. After the
native confirmation the app restarts, and the monitor applies the saved values
(else `POMEGR_RETENTION_DAYS`/`POMEGR_STORE_MAX_MB`, else 90 days / 500 MB) only
at its next start and prune cycle, never from IPC or a GET. Browser and LAN
clients read `GET /api/storage` only and render the controls read-only.

## Provider observer contract

Every provider adapter must expose the observation lifecycle required by
`server/providers/provider-contract.mjs`:

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

An adapter's injected observation clock must also reach its observer scheduler. Catalog
age and eager working-set hydration use that same clock, including after restart;
the scheduler must not silently fall back to wall-clock time when the adapter supplies one.
This clock wiring does not change cache-only GETs, committed evidence retention,
revision or checkpoint semantics, or the browser privacy boundary.

### Source ledger

A provider-neutral source ledger (`server/providers/kernel/source-ledger.mjs`) indexes
session-to-file topology (root, child, fork, shared group) and one filesystem generation
per known file, so a selected session's family can be resolved without walking an entire
transcript tree on every read. It parses no provider record itself: an adapter translates
its own bounded header read into the ledger's neutral shape before ingesting it. The
adapter feeds it from its periodic header enumeration (each pass starts 60 seconds after
the previous one finishes), from discovery loads, and from the files it lists and parses
while resolving a family. The index can lag the disk and is bounded (the oldest non-live
entries are evicted first), so it is a header cache and a root locator, never proof that a
family is complete.

Family completeness comes from the disk. A family is closed over the headers of the files
the adapter lists, breadth first, so the result does not depend on listing order, and is
bounded to 500 identities; exceeding the bound rejects acquisition and the last committed
evidence stays. A listed file's header is taken from the ledger only while the file keeps
the filesystem identity it had when indexed and has only grown since; otherwise it is
parsed again. When two files carry one identity, the adapter-defined preferred copy is
used. Remembered cold misses expire after 60 seconds or when the identity is indexed. File
paths and headers held by the ledger are monitor-private working state: they never enter
evidence, checkpoints, diagnostics, logs, or browser responses, and the ledger's diagnostic
surface reports bounded counts only.

Every map key the ledger derives from a file path (for cached-header and file-ownership
lookups) goes through one path-canonicalization step first, memoized per literal input
string. This is what lets a configured-root path (from a directory listing) and a
realpath-resolved path (from a notification filter) for the same physical file converge on
one ledger identity instead of shadowing each other, which matters for a junction- or
symlink-aliased provider home. The memoization keeps the cost to one resolution per distinct
path string, not per event; it holds twice the ledger's entry bound (at least 8,192 strings),
so a warm pass over a full ledger never re-resolves every file. A resolution that fails (a
path not yet created, a transient error) keys on the literal string (lowercased on Windows) for that call only and is
not memoized, so the path converges on its canonical key once it resolves. `cachedHeader()` performs exactly one `statSync` per call and,
on a hit, also refreshes the owning identity's growth observation, so `recency()` stays
current for any caller that only ever reaches a file through `cachedHeader()` (such as
Codex's family-member re-read), not only through `noticeSource()`.

Both Claude and Codex resolve their selected session through this same ledger contract, each
with its own instance. Codex resolves a selected session's rollout family with `resolveCodexRolloutFamily`
(`server/providers/codex/session-metadata.mjs`). The ledger locates the root's file.
Descendants are always created after their root, so the adapter lists the dated
`YYYY/MM/DD` rollout directories from one day before the root file's own directory on,
every undated directory, and the whole archive root; an archived or undated root, or one
that joins another thread's shared group (and so can have older siblings), lists the whole
active tree. It reads each listed file's header, yielding to the event loop between
batches, closes the family over those headers, and re-reads each member's full header from
its file. A root the ledger does not know, a failed or oversized listing, or a member whose
file is gone or now carries another identity falls back to the bounded whole-tree walk,
whose result is ingested. An empty walk result is remembered as a miss unless the root's
indexed file still exists. File modification time is not used to detect
change: Codex does not advance a rollout's modification time while appending to it.

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

Each provider owns an independent observer and its own bounded worker-concurrency
bookkeeping, so a busy or failed Claude adapter's queued work does not consume Codex's own
concurrency slots, and vice versa. All providers still share one Node.js event loop:
synchronous work inside one adapter's acquisition path (a blocking filesystem call, a
spawned process) delays every other provider's async work too, independent-slot bookkeeping
notwithstanding, which is why acquisition code is expected to prefer cheap, non-blocking
checks and to yield cooperatively (see the source-ledger note above and the Claude index
and owner-validation note under "Complete-record ingestion").
Within one observer, duplicate events for a queued session coalesce. If a source changes
while that session is already being acquired, one dirty-again pass is retained so the
newest complete records are not lost. Sessions may acquire in parallel, but one session is
never acquired by two workers concurrently. Claude and Codex both default to three
interactive hydration slots plus one background slot, so one slot never has to serve every
live session's source updates by itself. Two unrelated live source updates can normalize
concurrently while one interactive slot remains reserved. First publication for a live or
needs-input session and explicit selection use urgent priority; ordinary source updates can
occupy every interactive slot except the reserved one. With a custom single interactive
slot, urgent work leads queued updates but cannot preempt an acquisition already running.
Promoting a queued session immediately rechecks capacity without concurrent acquisition
of the same session. A session that was absent from the observer's first catalog and is
still within ten minutes of its own recorded creation is also treated as
first-publication/urgent priority on each catalog refresh until it is hydrated, even when it
has already finished, so a short-lived session is never queued behind the whole historical
background working set; a session already present in the very first catalog an observer
reads at startup is exempt from this rule, so a restart with many recently created sessions
already on disk cannot flood the interactive lanes. Per-provider diagnostics record queue
wait as one aggregate series (source-driven hydrations only, unchanged) plus one series per
priority tier (urgent, source-update, background), with urgent work a viewer explicitly
selected recorded separately as `queueWaitSelected` (its trace lane is `selected`; scheduling
is unchanged, selections share urgent priority); the per-priority series sample every
dequeued item from its own enqueue time, including urgent selections and background
hydrations that never carried a source event, so a starved lane is visible on its own.

Initial live hydration enters the queue directly with session-local preparation, ahead
of bulk working-set preparation. It retains urgent eligibility across catalog refreshes
until a candidate publishes successfully. The observer's private publication bookkeeping
is pruned against its catalog and cleared on shutdown. Cold-discovered historical rows
and routine reconciliation stay in the background lane. Broad lifecycle/index catalog
notifications refresh non-live rows in that lane too; exact source notifications keep
ordinary interactive priority. First-live work is queued before catalog fan-out. These
are asynchronous event-loop tasks, so complete-file readers must also yield cooperatively;
the slots do not imply separate CPU workers or a fixed source-to-display latency.

Selecting a restored live snapshot with stale lifecycle evidence also queues urgent
revalidation on a cache hit. Repeated reads coalesce, and a selection made before the
observer attaches retains only the latest startup request. A fresh candidate awaiting
commit suppresses redundant revalidation. Restored live evidence temporarily withholds
its acquisition cursor so an unchanged source still normalizes once; normal cursor reuse
resumes after fresh evidence commits. The saved revision remains readable throughout.
Historical snapshots and freshly acquired unknown status do not trigger this restore
refresh. GETs still serve committed caches only; they never acquire provider evidence
synchronously. Atomic commits, revision handling, checkpoint privacy, and browser data
boundaries remain unchanged.

The adapter may map a known source directly through its private reverse index. A newly
created or unresolved source requests a fresh catalog read that bypasses short-lived
provider discovery caches; bounded provider-header inspection may identify the owning
session sooner. The router emits only provider-local session IDs and a catalog-dirty bit
to the shared scheduler. Native paths, filenames, headers, and schemas never enter the
normalized candidate, checkpoint, diagnostics, or browser response.

A notification that marks the catalog dirty does not start its own discovery pass. The
shared observer (every provider) keeps one catalog-dirty bit: an idle observer whose last
catalog pass began at least one second earlier starts a fresh pass at once; otherwise a
single trailing pass starts when that second has elapsed, or when the in-flight pass
finishes if that is later. Any catalog pass that begins after the notification, including
the ten-second reconciliation, answers it and is upgraded to a cache-bypassing pass. A
burst of notifications therefore costs at most one discovery pass per second, and the last
notification is always followed by a pass that starts after it, so a new session appears
within about one second plus its discovery time. Known-session hydration is not delayed by
this spacing; it still enters the queue in the same event-loop turn. Catalog-dirty session
IDs are retained for the pass that answers them, and a failed pass keeps them for retry.

Claude catalog discovery walks the projects tree through `fs.promises`, so the event loop
is free between directory reads and file-stat batches. Each directory's listing is reused
while its identity and modification time are unchanged and it had been unmodified for at
least two seconds when it was read, since adding, removing, or renaming an entry advances
the parent directory's modification time; every transcript is still stat-ed on every pass
because appends do not change the directory. The result equals a full synchronous walk for
the same tree: traversal order, the six-level depth limit, entry classification, missing
roots, and read errors. Listings live only in memory, are replaced by each completed pass,
and are never persisted, logged, or exposed. The rare synchronous resolver fallback walk
shares the same listings.

For Codex, a new rollout notification is filtered to a rollout-*.jsonl name with realpath
containment in a configured root — the same check `notice`/`trustedRootFor` already apply —
and, only then, noticed in the shared source ledger directly, so the owning session is
located without a directory walk. Codex header recency comes from the newest complete
record's own time, not the rollout file's modification time, which Codex does not advance
reliably. The tail answer is cached by file size and mtime. A newest record larger than the
64 KiB tail gets one 1 MiB read; only past that does recency fall back to the later of the
creation time and the file mtime.

Committed catalog revisions wake the browser through a same-origin server-sent event.
The event contains only the fixed `sessions` domain and a non-negative revision; it is an
invalidation hint, never a state payload. The browser responds by fetching `/api/sessions`
with its current revision. That GET still reads only the committed response cache. A
dropped event is harmless because focus refresh and serialized recovery polling remain.

Claude observes both its project transcripts and its provider session registry.
Its observer publishes bounded transcript-tail summaries before complete title
scans and owner-scoped background-task reconciliation finish. Live detail hydration
uses the same nonblocking title path. Existing complete metadata remains usable
during append reconciliation; a cold title may initially be unavailable and refine
after enrichment. Title acquisition uses one serialized, bounded private queue,
and only validated source generations may replace its cache. Changed metadata
queues a scoped catalog/detail refresh. Stopping the observer suppresses late
title publications. Native registry working/input states keep precedence while
background lifecycle evidence is unknown. Direct complete-history reads retain
their exact metadata path. None of this acquisition runs inside a browser GET.
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

As approved by the product owner on 2026-09-28, work abandoned by a killed or crashed
Codex process is never presented as live, so it does not enter Live at all, not even
briefly after a restart. Codex takes a thread's writer lock before it creates the rollout
(observed: lock 0.7 seconds before the file) and holds it while the thread is loaded. On
Windows, when the provider lock directory exists, the liveness observation therefore reads
the lock of each thread whose recorded work is unresolved. Each lock is read once per
observation, synchronously, and the result is never retained, persisted, or exposed. A
missing lock, or one readable without contention, is a release only when the
cold-discovery contention probe agrees; a held lock at either read wins. Unresolved
recorded work, meaning an open turn or an unmatched input wait, counts as live only when
a writer could still resolve it: the thread has owning-runtime status or a confirmed
owner, or its own lock or its root's lock is not released. Otherwise the thread reports
status `unknown`, evidence `unavailable`, freshness `stale`, and reason `writer_released`,
with its original observation timestamp. An unreadable lock, a missing lock directory,
or a non-Windows platform gives no release evidence and keeps the recorded state. Release
never establishes completion, idle, stopped, or success, and it never changes checkpoints
or recorded lifecycle state. A Codex surface that wrote rollouts without taking writer
locks would be misread as released. Every surface observed so far takes the lock.

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
until matching provider evidence resolves it, while a writer could still resolve it (see
the writer-lock rule above); transcript silence is not a heartbeat failure or a
completion event. Recognized terminal records retain idle/stopped even
when old. Their timestamps never advance just because the monitor polls. Structured
lifecycle freshness means the retained evidence matches a complete acquired source
generation, not that the provider process is currently computing. An ordinary append
pending U1 acquisition or ending in an unfinished record does not replace that accepted
lifecycle. U2 retains its original observation timestamp while matching file identity,
monotonic growth, and the prior bounded suffix confirm append continuity. A bounded
lifecycle tail may close retained work before full hydration when every intervening
record fits the read window, all records are complete and parseable, the source
generation stays stable across the read, and the existing lifecycle reducer accepts
a terminal boundary newer than the retained turn and activity. Partial, malformed,
gapped, unstable, older, or mismatched candidates retain the accepted lifecycle.
This terminal-only path retains normalized evidence in bounded private memory; it
does not acquire detail or history, change checkpoints, or run from a GET. Writer
ownership can retain presence but cannot turn the terminal into working execution.
Before a full live-body hydration finishes, ordinary Codex catalog candidates inspect
at most a 128 KiB/256-record lifecycle tail. A session with a confirmed native writer
owner may inspect at most a 4 MiB/2,048-record lifecycle tail so an explicit current-turn
boundary can populate the header promptly after restart. This owner-scoped allowance
does not treat ownership as execution, does not parse detail metrics, and does not widen
history acquisition; absent explicit structured lifecycle evidence the row remains Open
or Unknown until normal acquisition completes. When that complete stable tail contains
fresh recognized provider activity but its turn boundary is still outside the bounded
window, current owner confirmation may admit the existing short-window activity inference.
The result remains labeled inferred; a structured terminal boundary still wins, and
neither owner presence nor file recency alone can produce working state.
The full observer otherwise owns the successor once it has acquired the source; a bounded tail cannot
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
On Windows, work whose thread and root writer locks are released is never live and shows as Unknown.
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
projection. The same D commit updates the persisted session-directory lifecycle overlay,
so Live filtering, the Live count, and the bounded catalog shell cannot disagree about an
expired Open row. Header discovery never renews that overlay, and directory GETs remain
read-only committed-cache/index reads. Restart reprojects retained catalog rows before
waiting for provider acquisition. A selected Open row
continues its normal detail polling even outside Live; this filter transition does
not turn its current evidence into a historical snapshot.

The Windows CLI cold-discovery predicate opens the native writer-lock file read-only
and probes one byte at offset zero. An exclusive byte-range lock can deny that read
even when opening succeeds and the file is empty. Only `EBUSY` establishes contention;
permission errors, missing/non-file paths, and unexpected failures do not. A negative
probe means no confirmed contention, not confirmed idle or completion. Non-Windows
platforms do not inherit Windows mandatory-read-lock semantics. This predicate only
gates bounded CLI acquisition; contention alone is not native session-presence authority.

Native writer ownership has a separate lifecycle acceptance suite. The opt-in `tests/server/providers/codex/native-lock-acceptance.test.mjs`
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

- U1 observer attachment and the first local catalog run before repository inventory
  readiness, reconciliation, or current plugin-setup observation. Those D-only
  jobs continue in the background and a late completion cannot start plugin
  observation after monitor shutdown. Repository sidecars load concurrently, and
  only those whose checkpoint is on disk, so the load follows the checkpoint bound
  rather than every retained sidecar; checkpoint projection waits for that private
  sidecar load, while live provider discovery does not.
- L2 checkpoint restoration runs independently and does not delay observer
  attachment. Fresh
  candidates seen while restoration is pending win over the matching saved
  record, including if their first commit is still in flight or has already
  been evicted. Other valid working-set records restore normally. This preserves
  last-known-good checkpoint evidence without allowing a delayed L2 record to
  replace newer U1/U2 evidence.
- While that restoration is still running, a session requested through `/api/state`
  or a session-domain GET that misses the L1 store, where it would otherwise queue a
  selected hydration, restores its own checkpoint first. The bounded uncatalogued
  probe is unchanged.
  The GET only queues this work and answers `loading`; it never reads or parses
  synchronously. The asynchronous load reads the one identity-keyed checkpoint file
  (no directory scan), waits for the same private sidecar readiness plus that session's
  own identity-keyed sidecar when the startup load did not cover it, and applies the
  same payload, legacy-upgrade, candidate-validation, lifecycle-downgrade, and
  preserved-revision rules as the bulk pass. Fresh or already committed evidence
  still wins. Each identity is tried at most once per restore window (at most 256),
  and the bulk pass skips identities claimed on demand, so a record is never restored
  twice and cannot replace a newer committed revision. A restored record publishes a
  session revision event and is then served and revalidated exactly like a
  bulk-restored one. A missing, invalid, or rejected checkpoint queues the ordinary
  selected hydration. After restoration finishes, a miss hydrates directly as before.
  This persists and exposes nothing new.
- Header discovery inventories every eligible top-level session within the configured
  provider roots and archive scope. Its acquisition batches and resident pages are bounded;
  a batch limit is never a permanent limit on identities reachable in the directory.
- Codex header enumeration reads each rollout header asynchronously through one file
  handle, so the event loop is free between files. The same read classifies a header with
  no valid session record (a complete window of at most 64 KiB is an explicit
  non-candidate; anything else keeps the pass incomplete), without a second open. A
  provider-owned in-memory cache reuses a rollout's header, or its non-candidate
  classification, while the file's identity, size, modification and change times are
  unchanged and it had been settled for two seconds when read; inconclusive reads are never
  cached. Missing files leave the cache, a complete pass drops every file it did not visit,
  and the cache holds at most 16,384 entries. Output equals an uncached pass. The cache is
  never persisted, logged, or exposed.
- Startup source preparation, transcript hydration and normalization are eager only for
  live or needs-input sessions. Recent timestamps alone do not authorize detail hydration.
  Historical identities remain selectable without acquiring their transcript bodies.
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
- Home does not schedule historical detail or complete-history replay for its correlation
  windows. Correlations use retained observations with explicit bounded coverage; provider
  usage-limit values remain an independent committed domain.
- A reconciliation publishes committed header batches first, then prepares source
  topology only for the eager working set. It must never prepare every old source merely
  because its catalog row exists.

### Session inventory and directory coverage

The monitor owns a normalized session-header inventory in an isolated table in its SQLite
store. It is independent of detail checkpoints and the complete-history store. Discovery
validates identities and commits lightweight rows before detail is available. Failed detail
hydration cannot erase a valid discovered identity. Provider and top-level session identity
form the deduplication key: active/archive generations contribute once, child agents never
contribute, and a fork contributes only when the provider records it as a top-level session.

**Available sessions** means the unique validated top-level identities in the committed
inventory revision for the configured sources. Coverage is `discovering`, `complete`, or
`partial`. The known count remains available while discovery proceeds. An exact total is
present only after every configured source and provider enumerates successfully; unreadable,
inaccessible, or inconclusive sources prevent that claim. A rescan retains the last completed
total and its original observation timestamp separately, without calling it currently exact.

`/api/sessions?mode=directory` serves a bounded page from committed normalized inventory.
Search, lifecycle filters, and project/repository scope execute monitor-side. Rows are
always ordered newest-created first; there is no other directory order. Pages default to
25 rows and cannot exceed 100. SQLite performs filtering, counting, ordering, and page
selection without materializing the complete inventory in memory. A cursor binds to the
query and names the last row's creation position (keyset), not an offset or revision, so
live-status updates and newly created sessions never move a later page; new sessions
appear only on the first page. A cursor for another query or a malformed cursor restarts
at the first page. The directory never receives a global
session array. The default catalog response is a separate small shell feed for live,
needs-input, pinned, and selected destinations, capped at 200 rows; its length is not
the inventory total. Header scans use batches of at most 100 rows and repeat on a
60-second reconciliation cadence. The bounded 256-row memory fallback reports partial
coverage if it overflows; it cannot silently claim a complete large inventory.

Inventory persistence contains only validated normalized catalog fields, a durable settled
lifecycle status (`idle`, `closed`, `stopped`, or null), revision/coverage facts, and one monitor-private opaque source-scope fingerprint. Changed provider roots,
archive inclusion, explicit transcript selection, or enabled identity sources invalidate
old inventory rows and completed totals before they can be presented as
current facts. The fingerprint is never returned to the browser. Transcript paths, raw provider records, private identifiers beyond the existing
normalized identity contract, prompts, responses, tool content and credentials are excluded.
Provider source locators remain adapter-private. Committed SQLite queries are cache reads;
GETs never synchronously enumerate sources, acquire provider evidence, or normalize it.

Each inventory row keeps volatile presence separate from a durable settled status.
Presence (`is_live`, `needs_input`, and the presence `activity_status` such as working,
needs input, or open) is reset at monitor start and when a row leaves the provider's
bounded lifecycle set. The settled status is never reset by either. It is written only
from a not-live, not-needs-input row whose status is `idle`, `closed`, or `stopped`,
whether it comes from a provider-projected lifecycle row (`updateProviderLifecycle`) or
from an adapter header row carrying that adapter's non-live fallback (Claude reports
`idle`, the documented no-live-session fallback, not proof of completion; Codex header
rows record no root status and stay `unknown`). Provider-confirmed `closed` or `stopped`
is never downgraded to `idle`; `unknown`, `open`, or a missing status never overwrites a
settled value. The column is added by an additive migration guarded by
`PRAGMA table_info`, so older inventories keep their rows. A directory row's
`activityStatus` is its presence status while it is live, needs input, or is an expired
Open row; otherwise it is the settled status, but only after that provider's first
presence pass (`updateProviderLifecycle`) has committed in the current monitor run, and
`unknown` before it. A resumed session is therefore live at its first observation and
never shows Idle and then Working. The Live and Needs input filters and counts read
presence only. No new field reaches the browser.

The inventory also persists one bounded row summary per row (`summary_json` plus the
recorded `updatedAt` it is bound to, added by the same guarded additive migration): the
visible-agent count, the latest all-agent context snapshot, the agent-reported progress,
and the activity fallback only in its `last_observed` form (fixed label, original
timestamp, source, actor scope). Current qualification, `currentActivity`, cache timing,
tool names, task descriptions, IDs and paths are never persisted. The Session row module
(`server/sessions/catalog/session-catalog-row.mjs`) projects the summary from the committed snapshot and
validates it before persistence. C writes it after every accepted commit, changed or
unchanged, so checkpoint-restored records seed summaries at startup, and only when it
differs from the persisted one and the recorded `updatedAt` is not older. A live row's
writes coalesce to the checkpoint cadence (5-second quiet, 60-second maximum) and flush
when the row leaves live or the monitor stops. No write acquires, parses, or hydrates.

Selecting a historical row queues only that session's detail and immediately presents its
committed identity/loading state. A known selected or live Codex session must not await
global metadata enumeration. Opening Activity or Requests may enqueue a coalesced complete
history replay for that session while serving committed/loading history. `/api/state` and
ordinary state polling never request complete replay. The dedicated history scheduler keeps
that work separate from urgent live and selected detail hydration.

When a selected Codex identity lacks a trusted retained source locator, its adapter
locates the identity's root through the shared source ledger and closes its rollout family
over the rollout directories that can hold descendants (see "Source ledger" above),
independently of the global catalog. Only an unknown root, a failed listing, or a missing
or replaced member falls back to one bounded whole-tree header walk. Selected-family
metadata is capped at 500 identities on either path, and the whole-tree walk also at 16
relationship closure passes. Exceeding a bound rejects acquisition and retains the last
committed evidence; it must never commit a silently truncated family. These
detail-acquisition bounds do not limit top-level inventory enumeration or directory
reachability.

### Complete-record ingestion

- Append-only JSONL acquisition uses 64 KiB chunks and continues until every currently
  available byte has been consumed; 64 KiB is not a history window.
- Only newline-complete records are parsed. The offset remains at the start of an
  unfinished record and that fragment stays in memory only.
- An incomplete generic-provider fragment is bounded to 256 KiB. Codex permits up to
  8 MiB for one encoded record (while still yielding 64 KiB reads) because image-tool
  result records can exceed 256 KiB; larger or malformed Codex records degrade to
  unknown without exposing raw content or blocking later complete records.
- A malformed or oversized record degrades only its provider-specific evidence and never
  publishes private exception data.
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
- Complete Claude history reads visit transcript files sequentially and yield after each
  64 KiB chunk. Complete Codex rollout reads and parses the same bounded chunks. Both
  revalidate the source generation before a complete replacement can commit, allowing
  selected foreground work and cache serving to proceed between maintenance units.
- Stable internal identities and deterministic upserts must let later, stronger evidence
  upgrade an existing observation without duplication or downgrade.
- A warm Claude read parses only records appended since the previous read. A per-file
  parsed-tail cache holds the same last-2 MiB window of complete records that a cold read
  returns, validated by file identity, size and a suffix digest. An append parses only the new
  complete records and trims the window by bytes; a replacement, truncation, or rewrite that
  changes the sampled 256-byte suffix drops the entry and reads cold (the same generation rule
  as the other Claude tail readers). An unfinished trailing record is never cached. The cache is
  bounded to 64 MiB of retained window bytes and 512 files (least recently used first),
  drops files that no longer exist, and is never persisted or exposed. Its output must equal a
  cold read at every record boundary.
- Claude file-change paths go through a per-provider validated-path cache in front of the
  repository-path validator. Entries are keyed by the recognized root's realpath and file
  identity, the forbidden roots and the candidate path, and live for 5 s (4,096 entries). The
  root itself is re-resolved at most once a second, so a replaced or retargeted root stops
  serving its entries within one second; a miss is cached only when the root was unchanged
  on both sides of its validation. Links inside the root and the forbidden roots are not
  re-checked until an entry expires, so a link swapped within those 5 s keeps its earlier
  answer; a newly seen path is always validated against the current filesystem. A rejection
  is cached as a rejection; syntax rejections never reach the cache or the filesystem. Other
  callers use the uncached validator.
- A live Claude usage-snapshot read whose file generation has not changed serves the retained
  snapshots without parsing the tail again. Work-kind classification memoizes its bounded
  WorkKind result by a SHA-256 digest of the classified text (4,096 entries); the text itself
  is not retained.
- One Claude readSession checks each transcript file's generation once: one stat and one
  256-byte suffix read, shared by the parsed-tail cache, usage snapshots, activity events and
  agent lifecycle instead of each of those readers opening the file again. Removing entries for
  deleted files uses one existence check per cached file per read, shared by every per-file
  cache.
- Per-file derived evidence is reused while that file's generation (identity, size, mtime and
  suffix digest) is exactly unchanged: historical usage snapshots (also keyed by agent, session,
  compaction times and window mode), the execution-task record pass, and the tool-call and
  user-input scan (also keyed by agent and primary-file role). Cross-file joins, task signals,
  historical stop times, agent labels and file-change path validation run on every read, so
  reuse never freezes a cross-file input or a validator answer. Complete-history reads never
  use or fill these caches. Each is in memory only, bounded to 512 files (least recently used
  first), drops files that no longer exist, hands out fresh tool-call, user-input and task
  objects, and its output must equal a cold read. The tool-call scan keeps each structured file
  tool's candidate target paths, unvalidated, so they can be revalidated on every read; like the
  parsed-tail records they are monitor-private memory, never persisted, logged or exposed, and
  they can outlive that file's parsed-tail entry until the scan's own bound evicts them.
- Codex folds each bounded live delta into its complete normalized story through the shared,
  provider-neutral `session-fold.mjs`. The provider declares a per-field policy: keyed unions
  (usage snapshots, tool calls, activity, compactions, pull-request creations) with a bound
  and a preferred merge on collision, an OR of rule flags, a custom agent merge that depends on
  the merged tool calls, and retain-if-absent only for the SessionStart plugin marker, which
  cannot be legitimately cleared. Every undeclared field takes the delta's value, so cleared
  signals, progress and status stay cleared.
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
- The Codex detail-discovery cache retains bounded private metadata and source generations.
  Its retained header and deduplicated hint bounds do not limit the separate complete
  normalized inventory. Enumeration commits identities before releasing each batch.
  Unchanged retained sources reuse their headers; changed sources undergo bounded
  header validation, and transient failures retain the last valid metadata. Cache
  selection favors retained live sessions and recently updated candidates. The public
  shell feed selects live and requested destinations within its bound. Private discovery
  metadata, paths and hints remain in memory only; normalized inventory rows use the
  separate persistence contract above. Detail
  hydration and normalized evidence retention continue under the existing U1/C/P
  contracts, and GETs continue to serve committed response caches only.
- Monitor shutdown coalesces the explicit close and listener-close callbacks into
  one observation stop, allowing the persistence writer and its SQLite handle to
  drain before a desktop runtime releases its private data root.
- Codex U1 canonicalizes trusted rollout paths before indexing a session's root and
  child source parts. Windows short names and directory aliases for one file share
  a single source identity, including incremental record and generation lookups;
  watcher hints and copied transcript paths use that same resolved file. A failed
  resolution remains a bounded unavailable source, and no alias extends trusted
  discovery beyond the configured provider roots. Repository mutation targets
  resolve their existing parent before comparing with a recognized Git root, so
  a Windows alias does not erase structured file-change attribution. None of
  these private paths enters normalized state or a GET response cache.
- A Codex source generation replacement revalidates the bounded header identity
  before ingesting records against an existing session. A changed identity queues
  discovery and leaves the prior committed evidence intact; ordinary appends retain
  their incremental acquisition path.
- For multi-file Codex sessions, U1 owns an independent cursor and bounded private
  lookbehind for every root or child rollout. After the initial complete build, U2 receives
  only newly completed records plus that lookbehind; it does not rescan the complete
  transcript or the generic live tail for session-story normalization.
- Claude resolves an already-known session's main file through the shared source ledger
  (see "Source ledger" above) instead of walking its whole projects tree again. Claude
  sessions carry no provider-native parent/fork/group relation, so the adapter only uses
  `locate()`/`noticeSource()`, never `family()`: every discovery pass ingests each listed
  `{file, activityMs}` as a header named from the file's own basename, with `activityMs` as
  the ledger's preference value, so a duplicated session ID across project folders keeps
  discovery's own newest-activity copy independent of ingestion order. Each pass is ingested
  oldest first, so over the ledger's 4,096-entry bound the least recent sessions are evicted,
  never the newest. A located file is re-verified with one file stat before being trusted
  (a same-path replacement carries the same session ID and is read afresh); a missing file
  falls back to one full walk. Session detail, paged history keys, and transcript-path copy
  all resolve through this lookup. An identity the ledger cannot serve (unknown, or its file
  is gone) falls back to a full walk; if that walk still finds nothing, the miss is
  remembered for the ledger's own miss TTL, so a repeated read for the same ID does not walk
  again until the TTL expires or a notification ingests the ID first. A filtered
  new-transcript notification (a `.jsonl` name outside any session's `subagents` tree — the
  same files discovery lists as main transcripts — plus realpath containment in the projects
  root, the same shape as Codex's `trustedRolloutPath` filter) is noticed directly under its
  configured-root path, clearing any remembered miss without waiting for the next full
  discovery pass. Native and Remote Control owner validation
  reuses a validated owner identity for 1.5 seconds. A
  non-spawning liveness check retires a positive identity as soon as its process is gone.
  After 1.5 seconds, on Windows, the last answer is served while one asynchronous process
  enumeration re-confirms the start identity, so a read inside that five-second bound never
  blocks the event loop on a process spawn. A first check, a changed start identity, and an
  answer older than five seconds still use a synchronous probe.
- Codex U2 seeds model and reasoning effort from the same agent's prior normalized
  evidence across continuous incremental updates, including empty lifecycle updates
  and live-to-history transitions. A missing field retains its recorded value; an
  explicitly present invalid or unavailable field normalizes to unavailable and
  takes precedence over an older requested spawn value. Field-presence bookkeeping
  remains private to the adapter. New
  runtime fields replace prior values independently for each agent. Complete source
  replacements rebuild without inherited runtime evidence; incomplete replacements
  retain the committed revision. This adds no transcript rescans, browser or checkpoint
  fields, GET acquisition, polling lane, or revision mechanism.
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
| Source-change ingestion | Backend adapter / U1 | Feeds normalization; does not write a committed cache | Start in bounded provider lanes: Claude has two interactive slots, Codex has three, and each keeps one interactive slot reserved from routine updates plus one background reconciliation slot; same-session serialization and event coalescing still apply |
| Safety reconciliation | Backend adapter / U1 | Repairs missed notifications and feeds normalization | Every 10 seconds for observed sources; reconciliation work has lower priority than notification-driven work |
| Provider normalization | Backend adapter / U2 | Builds a private candidate | Immediately after complete records are acquired |
| Complete session-history replay | Backend monitor / U1 through C | Replaces normalized paged history only after a complete validated read | Activity/Requests demand only, with one foreground and one background slot in its separate scheduler; matching source keys do not replay, and state polling never enqueues work |
| Session publication | Backend store / C | Writes a new immutable L1 evidence revision | Coalesce to the first candidate's 500 ms deadline; later candidates replace pending evidence without restarting the timer. Fresh evidence preempts a delayed failure retry. |
| Structural catalog projection | Backend monitor / D | Commits additions, removals, live, needs-input, and activity-status transitions to the catalog response cache | Schedule in the next event-loop turn; structural work preempts a queued summary refresh. One shared five-minute Open-visibility expiry timer handles idle owner-retained rows; it does not acquire provider evidence or renew activity. |
| Session-domain projection | Backend monitor / D | Atomically stages independently revisioned `session-summary`, `agents`, `agent`, `signals`, `repository`, `resources`, and `details` responses from committed state | After session commits, after restore even when evidence is unchanged, after catalog commits for already retained sessions only, and asynchronously after a known evicted session is requested |
| Session-summary projection and Home correlation | Backend monitor / D | Reads committed dependencies and writes L1 response revisions | Catalog summaries publish in the next event-loop turn after a session commit, without another 500 ms delay. Other dependency refreshes retain their existing coalescing ceiling. |
| Revision notification | Backend serving / S | Carries no state; announces a bounded domain, revision, session ID for session-scoped domains, and history total only for history | Emit immediately after the corresponding response revision commits |
| Resource observation | Backend monitor / D input | Updates the private resource sampler, then republishes affected session projections from committed L1 evidence without provider acquisition | Every five seconds for live sessions; confirmed unavailability resolves the resource region instead of leaving it loading |
| Routine checkpoint | Backend bounded owner / P | Coalesces committed L1 evidence and atomically replaces L2 JSON | Eligible five seconds after quiet or after 60 seconds of continuous activity; queue service and failures can delay durability |
| Resource history | Monitor store contributor / P | Aggregates the private sampler's in-memory raw samples (30-minute window) into `resource_minutes`, bounded peaks, and peak sample windows in one transaction per session; never read or written by a GET | On the coalesced post-checkpoint store cycle, which the resource observation also schedules at most once per 60 seconds while sessions are sampled |
| Graceful shutdown | Backend writer / P | Drains the newest accepted checkpoint revisions with bounded attempts, then closes history and contributor storage | Cancel maintenance and scheduled candidates, stop producers, drain accepted persistence, then close storage |
| Usage observation coordinator | Backend / U1 through D | Refreshes the centralized usage response cache | Check for due work every 60 seconds; each provider's authenticated request cache permits at most one request per five minutes and honors longer `Retry-After` cooldowns |

Checkpoint files use temporary-file creation followed by atomic replacement. A missing,
corrupt, oversized, unknown-version, invalid, or source-incompatible checkpoint is ignored
and rebuilt in the background. Checkpoints are an optimization; provider-owned sources
remain the source of truth.

### Bounded persistence ownership

`observation-persistence-queue.mjs` is the in-process C-to-P boundary. It admits at
most 128 normalized session keys and 32 MiB of conservatively estimated pending
payloads, with one active write of at most 32 MiB separately retained while a newer
revision replaces its pending value. Only persistence fields are retained; public
state and serialized browser responses are excluded. Estimates count strings, keys,
and structure, reject unsupported depth/cycles, and do not truncate evidence.

Each key has one ready position and one optional debounce timer. Replacements retain
the first dirty deadline; ready keys use FIFO order. A revision arriving during an
active write remains pending until it commits separately. A hot key cannot fill the
ready queue with duplicate work. Overflow rejects a new admission or an oversized
replacement, retaining its prior accepted candidate and durable checkpoint. Later
normal observation may submit it again; a GET never retries persistence.

Writes retry at the ready tail at most three times, separated by 100 ms during
normal operation. Exhaustion releases the failed work and preserves the prior
checkpoint. Shutdown closes admissions, cancels debounce delays, and drains accepted
work through the same finite attempt limit without backoff. It waits for active
filesystem operations; there is no promised wall-time bound on an operating-system
write. The monitor store closes after these writes and their contributor cycle.
History replay results carry a lifecycle fence so a provider read that finishes
after shutdown cannot publish into the next lifetime.

A checkpoint commit validates and serializes only its own evidence, writes an
exclusively created temp, then renames it atomically. It never awaits pruning,
directory enumeration, orphan cleanup, or a full reconciliation. Failed operations
remove their own temp when possible. Checkpoint schema version 1 and repository
sidecar schema remain compatible; no browser fields or private evidence permissions
change.

`persistence-maintenance.mjs` schedules one batch per second, alternating checkpoint
and history owners. Each batch has a 32-unit budget and yields when stopped or when
observation, persistence, or selected/history work is pending. Checkpoint maintenance
retains a directory cursor, updates an inventory, and validates changed files rather
than reparsing every checkpoint after every write. Startup restores valid checkpoints
without pruning or deleting temps. Exact owned temp names become cleanup candidates
only after a one-hour age grace; active writes are protected. Deferred deletions recheck
recorded file metadata and generation under the same per-identity ownership as atomic
publication. A checkpoint eviction never deletes its repository sidecar: the checkpoint
is rebuilt from its transcript on the next hydration, recorded repository state cannot
be. Sidecars are bounded on their own (2,000 files, oldest modification time first),
with the same metadata recheck. Unrecognized files are left
alone. Capacity can temporarily exceed retention targets until a maintenance pass
finishes; continuously busy higher-priority work can defer that pass.

These are logical asynchronous owners in one monitor process, not dedicated threads.
They protect ordering and bound pending work; synchronous serialization and database
transactions can still occupy the event loop. No production latency claim follows
from fixture operation-count tests.

## Endpoint ownership and revision semantics

| Endpoint | Committed domain | Consumers |
| --- | --- | --- |
| `/api/sessions` | A bounded shell feed with committed summaries and primary-agent `cacheTiming`, or `mode=directory` pages from the normalized header inventory with query-bound cursors, coverage, and counts; header pages do not carry detail metrics | Application shell, Sessions directory, sidebar, Home destination labels |
| `/api/events` | No committed data; server-sent invalidations with domain and revision, session ID for session domains/history, and history total only | Immediate revision-gated refresh trigger |
| `/api/state?sessionId=...` | One session's normalized public state and per-domain readiness | Individual session view and report generation |
| `/api/session-domain?sessionId=...&domain=...` | One of `session-summary`, `agents`, `agent`, `signals`, `repository`, `resources`, or `details`; `agent` also requires a normalized `agentId` | Session regions during migration from composed state |
| `/api/session-history?sessionId=...` | Committed activity or request pages, including bounded grouped request-range activity | Activity and request navigation |
| `/api/home` | Cross-session aggregates and per-limit local activity correlation | Retained aggregate API; the Home page no longer requests this domain |
| `/api/usage-limits` | Central provider/account-scoped usage values, bounded refresh-failure kind, earliest local retry eligibility, and per-provider readiness | Shared frontend usage store used by Usage limits and session views |
| `/api/storage` | Committed monitor SQLite store readiness, size, retention, and cleanup status (see "Monitor SQLite store") | Settings storage/retention display |
| `/api/repository-files?repositoryId=...` | Committed repository file listing, or with `fileId` or `path` one file's grouped session history (see "Approved file-history persistence contract"); `no-store`, revision in the body | Repository Files tab and the session Repository tab's history panel |

Callers send their current revision. When the relevant committed revision is unchanged, S
returns `204 No Content` with no state body. A known uncached session returns its safe
catalog identity and loading readiness while asynchronous hydration proceeds.

Committed JSON responses use the quoted numeric revision as `ETag` and preserve
`X-Pomegr-Revision`. The same-origin proxy requests identity encoding from the monitor,
then may gzip the decoded JSON for a client that accepts it. It honors explicit quality
zero and wildcard precedence, sets `Vary: Accept-Encoding` on compressed and
uncompressed results, and never attaches a body to `204`. Precompressed responses set
the Workers `encodeBody: "manual"` option so the Cloudflare-backed development runtime
does not gzip the bytes again. Verification covers the actual Workers transport as well
as the production Node transport; a direct `Response` unit test cannot prove wire encoding.
Bodies under 1,024 decoded bytes remain uncompressed. Every JSON proxy forwards a
validated `If-None-Match`;
paired LAN forwarding preserves that header and `Accept-Encoding`, together with
response ETag, revision, encoding and Vary. These headers do not weaken no-store or
pairing authorization.

`/api/home` retains its committed response and provider-limit revision contract. Any correlation consumer must match that revision to the centralized usage snapshot before combining them. The personal Home page consumes neither domain; removing its polling does not change cache-only GET serving, backend derivation, last-known-good retention, or revision semantics.

Historical session state never receives current Git state or current usage limits.

The one-shot `/api/transcript-path` read sits outside this table because it returns one
local file location, not a revisioned body. When observation is active and the session
has committed L1 evidence, the monitor checks the requested agent's `transcriptAvailable`
flag in that evidence. It then asks the adapter to locate only that agent's file, so a
copy action does not acquire, parse, or normalize the session. Claude locates the file in
the session's subagent and workflow directories; Codex finds the child's rollout file in
its cached thread-metadata tree. Two cases still use a full compatibility read: a session
without committed evidence, and a Codex child that thread metadata cannot place because
only a parent rollout record links it.

Session-domain revision clocks are monotonic per domain across sessions. A domain
advances only when its semantic JSON changes; the observation timestamp alone does not
advance it. Eviction retains the clock floor, so rebuilding a response cannot make an
old client ETag appear current, but only within one monitor process: revision clocks restart at
0 in a new process, so the clock-floor guarantee does not span a restart. If the new process's
first resolved revision for a domain happens to equal the revision a browser client retained
from before the restart, the monitor's equality-only comparison answers `204` and skips the
revision event; the client keeps its pre-restart content until the next semantic change advances
the revision, and the browser store's epoch-based regression guard never applies because no body
arrives to accept or reject (n4). Restart recovery otherwise depends on the browser store
detecting a new live-event connection epoch; if its `EventSource` never opens, for example
because SSE is blocked or buffered by an intermediary, the epoch never advances after a restart,
so the new process's lower-revision resolved bodies are rejected as same-epoch regressions,
retained pre-restart data stays visible, and the entry falls back to 1-second polling until the
new process's revision passes the retained one (n5). A monitor-instance component in the ETag
would remove both residual cases; none is implemented.

Session-domain retention follows demand, not commit order. A semantically identical
re-projection is a no-op: it neither advances a revision nor refreshes retention, so
catalog churn cannot reorder or evict retained sessions. A catalog commit re-projects
only sessions whose domains are already retained; other rows project when their evidence
commits or when a request asks for them. Above the soft bound, never-requested sessions
evict first, then the least recently used. Live or open catalog rows and the most recently
requested session are exempt up to a hard ceiling of 128 sessions. A request recorded
before a projection exists carries over to the first commit after rebuild or hydration.

A requested catalog row without committed L1 evidence serves `loading` and queues one
asynchronous, pinned selection hydration, the same one `/api/state` queues, until its
evidence commits or a 30-second retry window passes. It receives no unavailable
placeholder. Only a row whose catalog readiness is `unavailable` projects the unavailable
placeholder, and that placeholder never replaces a retained evidence projection.

Absence from the shell feed is never proof that a session is absent. The complete inventory is
the header lookup authority, and incomplete enumeration cannot prove absence. During monitor
startup, before every provider catalog has published, a request
for a session with neither committed L1 evidence nor a catalog row serves `loading` and queues
the same deduplicated selection hydration. Its commit publishes the domain revision event that a
browser entry recovers from. After every provider catalog has published, a request for such a
session with a syntactically valid ID of a registered provider also serves `loading`, and queues
one asynchronous probe hydration (at most four outstanding at a time, with at most 128 retained
outcomes). A found session commits normally and publishes its domain revision event. Only after
the probe publishes no evidence does the request answer `unavailable` (HTTP 404). A proven
absence is re-probed at most once per 30-second retry window and keeps answering 404 meanwhile.
An ID of an unregistered provider answers 404 without hydration. The probe cannot distinguish a
failed acquisition from a missing source, so a transient acquisition failure also answers 404
until it is re-probed. The session-domain proxy route passes this definitive 404 through with its
fixed unavailable body; every other proxy route, and any monitor failure or timeout, still maps
to 503. GETs never acquire, parse, or normalize synchronously.

A session-domain request for committed evidence restored from a checkpoint as live prioritizes
the same deduplicated restored-live revalidation that `/api/state` selection triggers.

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

The private reader retains at most 50 associations, coalesces concurrent requests, permits four network reads at a time, and bounds each read to six seconds and 256 KiB. The first local catalog never awaits this optional read; a changed normalized result wakes a later scoped catalog refresh. Successful reads are cached for ten seconds; unsuccessful reads retry no sooner than sixty seconds. The normal ten-second observer reconciliation supplies refresh opportunities. Failures retain the last valid state and original transition-observation timestamp for the same owner, while ownership, bridge, or credential changes invalidate reuse. No status is invented before a valid observation.

A normalized lifecycle change contributes to the adapter source fingerprint, so hydration updates even when transcript bytes do not change. The existing staged replacement and contract validation still govern C Commit: incomplete replacement input cannot erase a prior complete revision. Repeated identical status does not advance the lifecycle observation timestamp or force transcript reacquisition. D Derivation and revision-aware cache-only GETs remain unchanged. P Persistence may retain only existing normalized evidence and the opaque source fingerprint; the remote response, bridge ID, token/hash, and private association cache are never checkpointed. Historical session hydration never requests remote status for that session.

Claude catalog acquisition also incrementally reduces the complete primary transcript
for successful, structured background workflow/shell/native-agent launches and exact terminal
notifications, matched successful `TaskStop` results, or exact run-matched completed
workflow manifests whose valid provider
completion timestamp is at or after the recorded task launch. A resume can reuse the
run ID while leaving an older completed manifest intact; the launch timestamp scopes
private completion memory and participates in workflow-manifest cache validation.
Both catalog and workflow detail reject that stale completion without changing the
source lifetime, commit, serving, or checkpoint contracts.
`TaskStop` requires a preceding structured call targeting an already observed open
launch, a non-error tool result matching that call, and the same bounded `task_id`
in the call and structured result. The result timestamp must be at or after the
call. Pending stop calls retain only bounded identity, timestamp, and launch
association in the existing private pending-call map. A delayed result cannot close
a later launch reusing the task ID. Stop intent, text-only confirmation, malformed
or mismatched identities, and failed results do not close work. Raw result content,
messages, commands, and task types are not retained or exposed by this reducer.
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
trusted terminal notification or matched successful `TaskStop` closes that agent.
Child completion, file recency,
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

Confirmed Claude runtime departure maps to the bounded catalog `closed` status
only when the existing private registry observer excludes that session from Live.
It reports runtime closure, never an exit reason or successful task completion.
Missing registration or uncertain process inspection alone cannot supply Closed.
Validated resumption replaces it; explicit-file compatibility selection retains
its Live override. Owner/closure memory remains bounded, private, and unpersisted;
restart uncertainty retains the existing fallback. Only the normalized enum crosses
the catalog boundary, through existing structural revisions and cache-only GETs.

Other non-live Claude catalog rows use `idle` as a no-live-session fallback, not
provider-confirmed completion; live rows with unavailable lifecycle evidence remain
`unknown`. This changes only the normalized catalog enum. Structural catalog
projection publishes it through the existing committed revision and notification
path; GETs remain cache-only, last-known-good evidence and checkpoints are retained,
and no new public or persisted fields are introduced.

The request and schema compatibility contract is in [Claude session status](claude-session-status.md).

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

The retained Home aggregate API tracks catalog, provider limits, per-limit activity correlation, and per-session summary enrichment independently. The Home page itself uses the shell catalog only to resolve pinned destinations and the last-viewed session; product discovery is available independently of catalog readiness. Session views consume explicit readiness from
`session-summary`, `agents`, `agent`, `signals`, `repository`, `resources`, and
`details`; Activity and Requests consume history readiness. The composed `/api/state`
readiness remains compatible while consumers migrate. A future file-history producer
and retained resource-history producer are explicitly unavailable; this does not erase
valid committed repository files or current live resource samples.

## Presentation rules

- The Requests chart renders only committed request snapshots; window, selection, and
  sort are frontend view state and never trigger acquisition.
  Desktop retains a 60-request visible window and phone a 20-request window. Selection
  and window anchors follow normalized snapshot identity as the bounded feed rolls
  over; live updates follow the newest request only while selection and window are
  already at the end. Agent scope, chart mode, and selection reset on session change. The
  Activities tab orders the Requests chart before the Activity feed. Desktop request Prev/Next crosses
  committed history pages. Phone omits Prev/Next and retains a slim tappable minimap; horizontal dragging
  on the chart moves its 20-request window, with rightward drags revealing older
  requests and leftward drags revealing newer requests. Taps select bars; vertical
  pan and pinch zoom remain native. Pointer cancellation releases the gesture,
  additional pointers cannot take over, and a drag does not select a bar on release.
  The minimap and phone chart navigate the full scoped history
  using its committed total and zero-based page offset, independent of stable
  request numbers. Dragging or keyboard navigation uses the preloaded request
  cache immediately; a missing window requests only its bounded history page,
  accompanied by the compact committed overview. No provider acquisition or
  synthetic token history is added. The overview's bar geometry is reused while
  the window moves, rather than rebuilding every miniature bar per pointer event.
  The detail chart recalculates its scale from the committed visible window during
  navigation so off-window requests cannot compress its bars. Agent scope, chart mode,
  capability, window, or revision changes may change that scale.
  The thumb previews the requested position while the chart keeps its last
  committed page; aborted or stale responses cannot replace a newer navigation.
  Miniature bars cover all scoped requests and use one stable full-overview maximum
  for the selected mode, independent of the detail page. Page and overview replace
  together, retaining the last committed revision during loading or failure.
  Older monitors without an overview show only loaded positions, which do not
  imply zero usage elsewhere. Agent scope or session changes discard the prior overview.
  A committed window move publishes its resulting chart selection to Activity once,
  for both chart swipes and minimap navigation. Pending windows retain the prior
  chart and activity target; background refreshes do not repeat that navigation or
  override manual Activity paging.
  Selection still reveals linked activity without a
  request-only presentation filter. These presentation changes leave cache-only GETs,
  last-known-good revisions, checkpoint privacy, and polling cadence unchanged.
- The session KPI strip renders once core evidence is ready. Agent counts and status
  tallies follow agent readiness, latest context follows context readiness, and tool
  calls and the agent estimate follow activity readiness. Each pending cell shows an
  em dash instead of an invented zero; core wall time remains visible independently.
  Summary cards retain the activity-evidence gate, with independent placeholders for
  workflow agent/context evidence. These are presentation-only consumers of committed
  revisions; they do not change hydration, serving, checkpointing, or polling.
- Use geometry-matched skeletons only when a region has no committed value and readiness
  is `loading`.
- The Sessions directory shows a labeled, neutral list skeleton while it has no catalog
  rows and either its first browser request or the monitor catalog is still loading.
  It hides zero result/filter counts and source-configuration advice until the catalog
  settles. A confirmed unavailable catalog or disconnected monitor takes precedence
  over loading when no rows are retained; committed rows remain visible during refresh
  and reconnect. This is presentation behavior only and does not alter acquisition,
  polling, revisions, cache-only GETs, or checkpoint contents.
- An empty combined session catalog remains `loading` while any configured provider
  has not reported its first discovery result. Once all providers have reported, it
  becomes `ready` if any succeeded, or `unavailable` if all failed. Available catalog
  rows are served immediately even if another provider is still discovering. A
  readiness-only transition commits a new catalog revision and uses the existing
  revision notifications; GETs still read committed caches only.
- Session loading shells use the loaded session header's shared typography, identity
  styling, and responsive rules; known catalog titles must not flash a different type scale.
- Keep existing data visible during refresh, observer failure, API failure, and retry
  backoff.
- Restoring the agent roster selection, opening groups, and applying committed updates
  must preserve page and roster scroll positions. Only an explicit Show agent action
  scrolls to the selected roster row.
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

One tab-scoped, reference-counted `EventSource` serves the application shell, session
view, history hooks and repository consumers. The first subscriber connects and the last
subscriber releases the stream and reconnect timer. Publications are validated and
deduplicated by domain and normalized session within the connection epoch. A new stream
resets that epoch; only a real open event marks it connected.

Revision events are the primary refresh trigger. Each consumer serializes requests and
coalesces events received during a request into one follow-up. Late responses cannot
replace a newer selection. A revision is sent only when the exact query already has a
retained body: uncached offsets, request lookups and preload pages must fetch a body.
A `204` retains that query's body and restores connectivity after a transient failure.

| Consumer | Refresh and recovery |
| --- | --- |
| Catalog/sidebar | Revision events; 30 seconds connected, 5 seconds reconnecting, 30 seconds hidden; 1 second while initially loading |
| Sessions directory | Catalog revision events and a 30-second visible / 60-second hidden fallback; **Pause live refresh** stops refresh; query changes reset the bounded cursor trail |
| Selected live session (`/api/state` compatibility) | Matching session-domain or catalog events; the same 30/5/30-second fallback; 1 second while unresolved |
| Mounted session domain (`/api/session-domain`) | One exact-query browser entry per session/domain/agent; current plus two recent session IDs retained; matching domain events and the 30/5/30-second live fallback; 1 second while unresolved |
| Live Activity and Requests history | Matching history events and the same 30/5/30-second fallback; explicit navigation fetches the selected query |
| Historical session and history | Mounted queries hydrate through events and reconnect revalidation; ready queries have no periodic timer; navigation, focus and reconnect may revalidate |
| Repository inventory | Repository events and the same 30/5/30-second fallback; shared consumers and desktop Pause do not create extra pollers |
| Repository files and file history | Separate shared store: 1.5 seconds unresolved, backing off to 5 seconds while loading or rebuilding, 15 seconds ready and visible, paused while hidden |
| Request-history preload | Readiness/revision-driven sequential pages; no fixed preload timer |
| Personal Home | No page-owned polling; destination labels reuse the shell catalog |
| Provider/account usage | Separate shared store: 1 second unresolved, 60 seconds ready, 30 seconds hidden |
| Public provider status | Separate shared store: 30 seconds |
| Global agents analytics | Separate query store: 60 seconds while mounted |

The last three stores have separate producers without session-domain invalidations;
their existing bounded polling remains independent of session evidence. Usage failures
retain their established 2/5/10/30-second backoff. All frontend refreshes retain
last-known-good values. Focus or foreground return revalidates mounted consumers;
hidden session consumers suppress immediate event bursts and use their 30-second
fallback. Desktop **Pause live refresh** pauses F subscriptions and polling, including
repository views, and never controls backend observation.

The session-domain browser store never sends a revision without the exact retained
query body. It validates the returned session, domain, and selected normalized agent
identity before caching. Server rendering returns an empty snapshot without retaining
module-global query entries. Unmount aborts an active request; remount reuses only a
complete last-known-good body. Historical entries whose last request succeeded with a
resolved body have no periodic timer, including when their readiness is unavailable. A
failed request or a still-loading body retries every 5 seconds (30 seconds hidden) until
it resolves, and a failure clears the pending invalidated revision so a replayed event
can revalidate. Events, reconnect recovery, navigation, and focus may also revalidate
them. Hidden revision bursts remain coalesced until the hidden fallback or foreground
return.

A loading response never replaces a retained resolved body. Within one live-event
connection epoch, a lower revision than the entry's retained revision is rejected. After an
epoch change (a reconnect or a monitor restart), retained data stays visible while the entry
is loading, and the first resolved body is accepted even at a lower revision than the
retained one; accepting that body re-arms the guard for the new epoch. A declined rebuild
(a rejected lower-revision body) keeps the 1-second retry cadence rather than falling back to
the slower connected cadence. A 404 from the session-domain route is a definitive unavailable
result, not a transient failure. The store drops a retained `loading` placeholder but keeps
resolved last-known-good data, reports no error, and schedules no retry timer. Only a
matching domain revision event, a live-event reconnect, focus or visibility, or an explicit
revalidate re-checks it. The session page shows "Session unavailable" instead of the
monitor-connection notice.

A loading historical response cannot leave an in-flight flag set after its request
settles: later readiness events and reconnects must be able to finish hydration.
Following latest updates chart and feed together. An older pinned selection retains its
visible page while newer committed totals extend the minimap; it must never be
reinterpreted as a different request. Preload and visible-page revisions never mix.

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
safe hash of normalized identity and never contain a source path. Pomegr-owned cache and
checkpoint writes never mutate provider sources and stay compatible with read-only
observation.

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
Request action correlation is also derived in U2, separately for each resolved Claude
transcript actor in file order. Only two bounded work-kind count arrays enter normalized
usage evidence and checkpoints (8 kinds per array, counts 1–999). Tool-use/result identity
maps and tool details remain adapter-private. Recognized actor compaction timestamps
clear pending preceding-result counts. D revalidates the arrays and adds only the fixed
`transcript_adjacency` and `recorded_link` association labels, or null for empty tallies;
reports omit all four fields. Legacy and Codex evidence defaults to empty arrays.
This additive evidence follows the existing complete-replacement, atomic-commit,
last-known-good retention, revision and checkpoint rules. GETs still serve committed
responses only; action correlation never runs in S Serving or changes UI polling.
Directory rows and non-resident shell rows read the persisted row summary described under
inventory persistence. It is last-known-good: it survives restart and L1 eviction, shows
`summaryReadiness: "ready"`, reports zero active agents and no `currentActivity` for a
non-live row, and never carries a `current` fallback. Rows without a summary stay `loading`.
A resident committed snapshot still supplies the live values for shell rows.
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
turn opens on recognized user input, a system task notification, or a system-sourced
subagent hand-back or automatic continuation; other meta records never open one. A
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
Each committed `session-summary.rightNow` row also derives an optional agent-scoped
`activityFallback` from that row's normalized execution tasks and activity calls only.
It uses the same fixed vocabulary, original timestamp, `current` or `last_observed`
state, and lifecycle qualification as the session fallback, but cannot borrow another
agent's task or call. Serving reads the already committed domain projection and never
acquires provider evidence. F prefers a qualified provider `currentActivity`, then this
agent-owned fallback, then normalized status. Only active provider activity or an active
`current` fallback receives the existing current marker and shimmer; `last_observed`
fallback text remains static. This remains bounded execution evidence, not provider
narration or authoritative proof of current work.
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

### Approved file-history persistence contract

This subsection approves the policy for file-history and historical Repository work. The
checkpoint evidence, the monitor-private index, the historical repository snapshot, and
their browser serving described below ship. Provider mutation targets still never enter
browser responses.

Shipped evidence shape: a normalized tool call may carry `fileChanges`, at most 64 entries
of `{ path, kind, previousPath }`, with a normalized `repositoryId` on bound Codex entries.
`path` and `previousPath` are slash-separated and at most 512 characters. Codex paths
are relative to their independently recognized repository root; legacy Claude paths
are relative to the recorded working directory and rebased during indexing. `previousPath`
is present only for `moved`. Only a call with recorded success evidence carries it (Claude:
a non-error tool result, with `Write` classified `created` from the structured result type;
Codex: a completed patch or file-change item). Only structured file tools with an explicit
target contribute: Claude `Write`, `Edit`, `MultiEdit`, and `NotebookEdit`, and Codex patch
and file-change items, including the rollout `item_completed` `FileChange` item Codex records
for a patch applied inside a code-mode `exec` cell (the wrapping `exec` call itself carries
none). Claude `Bash`/`PowerShell` calls and Codex shell items never carry
`fileChanges`: the files a command writes cannot be known reliably from its text, so those
changes surface only through the Git-observed lists below. `assertCheckpointPayload` rejects any
absolute, drive, UNC, device, traversal, backslash, control-character, provider-folder,
or over-bound path.

A future L1 revision and L2 checkpoint may retain bounded normalized file evidence
consisting only of a normalized repository identity, safe repository-relative path, fixed
`created`, `edited`, `deleted`, or `moved` kind, observation timestamp, and opaque file
identity when continuity across paths requires one. Normalized session and agent identities
and a stable session-scoped request number are nullable and may accompany the record only
when recorded provider evidence establishes each attribution. A move
observed only through asynchronous Git inspection may preserve repository-scoped path,
time, kind, and opaque file continuity, but it cannot itself create a session file-change
record, populate session, agent, or request identity, or contribute to session edit counts.
Joining by time, path, branch, or nearby activity must not fill those fields. The single
approved exception (product owner, 2026-09-23) is the separately labeled Git-observed
category below: a session window and recorded-branch join may list paths as Git-observed,
but it never fills session, agent, or request identity, never creates a `file_changes`
row, and never contributes to edit counts.

U2 validates each candidate with a dedicated repository-path validator before C commits
it. The validator uses the monitor-private recognized repository root and rejects absolute
paths on every platform, drive-relative paths, UNC and device paths, traversal segments,
control characters, empty or otherwise unsafe paths, configured provider configuration
or transcript locations, and any candidate that cannot be contained under the recognized
root. It normalizes the accepted browser value to a bounded repository-relative path and
preserves legitimate nested directories and filenames; the custom-agent identifier syntax
is not a path validator. Invalid or over-bound candidates are dropped rather than
truncated into a different path. Repository roots, native target values, commands, tool
arguments, provider records, and validation failures remain monitor-private.

Codex binds successful structured mutations during U2 through the inventory's private
repository resolver, before strict normalized evidence is committed. Each accepted target
has its own recognized root and normalized repository identity, including targets outside
the launch cwd. Relative targets require a recorded tool/turn working directory; shell
command text cannot establish that directory or a file write. A move must validate both
paths within the same recognized repository. The launch/recorded cwd names the session's
project unless a proven mutation repository points elsewhere (approved by the product
owner on 2026-09-27; see `server/normalize/session-identity.mjs`); the cwd itself remains private
provider evidence. The public compatibility
`session.cwd` field is empty; roots and raw target inputs never enter browser state.

Private root bindings accumulate across bounded live updates. The recognized launch
repository supplies the project association unless a proven mutation repository refines
it to a single other repository (approved by the product owner on 2026-09-27); two or
more distinct proven repositories still clear the single-repository association and
leave its Git and touched-file summary unavailable. Per-repository file
listings retain their separately bound records. Catalog projections use the committed
project and clear obsolete repository IDs instead of falling back to earlier catalog rows.
Delayed association results are accepted only for the binding that requested them.

Live Git enrichment validates the recognized root and its provider-recorded branch before
publishing branch, working-tree files, comparison, pull requests, or commit counts. Missing
branch evidence or a root/branch mismatch preserves the last verified session snapshot or
leaves the existing unavailable state. It never commits the unrelated checkout state to a
historical sidecar. Historical fallback without a sidecar does not query current GitHub
state through the checkout. All resolution and Git work remains outside S Serving.
Concurrent live Git inspections of the same working tree (for example two live sessions in
one repository) share one in-flight set of Git processes, and each caller receives its own
copy of that answer. A finished inspection is never reused, so each session's check keeps
its own time and cadence. Repository-root lookups (`git rev-parse --show-toplevel`) run once
per directory: concurrent callers share the lookup, and its answer is reused for the same
300-second freshness the providers' memoized repository resolver already applies.
A live session with no repository binding (a Codex session without one proven repository,
or a Claude session without a recorded branch) has nothing to check: its repository
readiness is `ready` with no repository, a factual empty result, so it cannot hold the
session summary at `loading`. A bound session is `loading` until Git answers for its
current binding, stays `loading` through a failed check, and becomes `unavailable` only
when Git confirms the root or branch does not match. A changed binding, or an attribution
that is briefly unknown after the session had a repository, returns to `loading` so clients
keep the last committed value.

Repository sidecar version 4 carries a nullable normalized repository ID. A sidecar is
served only for the same single-repository identity in normalized session evidence, for
every provider (`session.repositoryAttribution`/`repositoryId`; see
`server/normalize/session-identity.mjs`); an older sidecar recorded before that identity was
proven, or with a mismatched identity, remains unavailable. A new identity starts a new
baseline and cannot inherit another repository's files, PRs, comparisons, or Git-observed
lists.

Checkpoint evidence written before the session-identity rule has no
`session.repositoryAttribution`. A provider whose evidence was then bound to its launch
cwd declares `legacyRepositoryAttribution: "launch"` in its adapter (Claude does; Codex
does not). At restore only, the checkpoint store gives that provider's legacy evidence the
generic attribution `launch` (`withLegacyRepositoryAttribution` in
`server/repository/repository-snapshot.mjs`) without rewriting the checkpoint file. `launch` keeps
the behavior that evidence had before the rule: its recorded sidecar and recorded branch
are served, its unbound file changes resolve through its launch cwd, and restore reads role
configuration from that cwd. Shared modules read only the attribution value, never the
provider. Legacy evidence of a provider without the declaration stays unbound.

A provider may also record `launch` in live evidence when its cwd is, by the provider's own
transcript schema, the fixed launch directory rather than a navigated one. Claude does:
`readSession` records `single` with the repository ID when the shared rule proves the
launch directory is one Git repository, and `launch` otherwise (not Git, a removed
worktree, Git unavailable, or the 5 s bound), so those sessions keep their pre-rule
sidecar, branch, file history, and context-inventory association. Claude catalog rows name
the project from the nearest enclosing `.git` of the launch directory without a Git
subprocess, the same name the rule gives a proven repository. A Claude live repository
check records the proven repository ID on its sidecar, so a `single` session's sidecar
satisfies the identity gate. Sidecars that such a provider recorded before the rule carry no
repository ID; they came from the launch directory, so a `single` session of a provider that
declares `legacyRepositoryAttribution: "launch"` adopts its unbound sidecar, both for serving
and as the carry-forward baseline of its next live check. Codex never adopts one.

The monitor-owned file-history index (`server/repository/file-change-index.mjs`) is a derivative of
committed file-change evidence plus Git state acquired asynchronously outside S Serving.
It runs as a store contributor on the post-checkpoint cycle, receiving the snapshots
written since the last cycle. Bound Codex paths use their own normalized per-call
repository ID; the index never reinterprets them through the session cwd. Every other
entry — including every Claude entry, since Claude has no per-call binding — is attributed
only through the session's own recorded identity (`session.repositoryAttribution`/
`repositoryId`, the same provider-neutral rule for every provider; see
`server/normalize/session-identity.mjs`): when that identity is a proven single repository, the
path is rebased from the recorded working directory onto the private Git root and
revalidated, and a working directory that resolves to another repository supplies no
root; `launch` evidence (above) resolves its repository from the launch cwd as
before the rule; when the identity is multiple, unknown, or absent, the entry is skipped
rather than reinterpreted through a navigated cwd. Writes are additive: a change
already recorded for the same session, agent, kind, timestamp, and path is skipped, so
replaying a checkpoint is idempotent, and a later snapshot whose bounded evidence tail no
longer carries earlier tool calls never removes their committed rows. Git renames come from
`git diff --name-status -M` against the last recorded head, at most once per repository
per minute and 512 renames per read; the first observation records the head only. A
Git rename updates `files.current_path` and opens a `file_paths` row with source `git`,
never a `file_changes` row. A missing, rebuilt, or unversioned index is repopulated
once from retained checkpoints, and storage readiness stays `rebuilding` until that pass
completes. File-index version 2 removes file identities touched by old Codex rows whose
repository was inferred from one session cwd, while preserving untouched Claude identities.
Affected mixed-provider identities are also removed: deleting only the Codex event could
leave its incorrect move or deletion attached to surviving Claude history. It replays only Codex
checkpoint entries with normalized repository bindings. A failed checkpoint load leaves
the migration pending and file-history serving in `rebuilding`; GETs do not repair it.
Older unbound Codex file records are unavailable until structured source evidence is
observed again. Records outside retained checkpoints/source coverage cannot be recovered
by this migration. Session 5 queries `listSessionFileChanges`, `listRepositoryFiles`, and
`fileHistory` (page size 100, maximum 200); `request_number` stays null until a
monitor-side request mapping is threaded to the index. It must be rebuildable
from retained checkpoints and independently committed Git evidence. Index loss or rebuild
cannot trigger provider acquisition from a GET, change a committed evidence revision, or
weaken last-known-good retention. Git can establish repository-scoped path and file-
identity continuity in the index's file-path records; it cannot establish which session,
agent, or request made a change or add a session-level file-change count.

The `file-history-domain` source (`server/repository/file-history-domain.mjs`) serves the index. It
registers after the file-change-index contributor, so each cycle groups already-committed
rows, and reports `rebuildComplete: true` because it is a derived cache, never a rebuild
target. Per cycle it builds at most 32 demanded sessions' touched-file summaries (at most
200 files, folded into the `repository` domain's `fileHistory`), 8 repository listings
(at most 5,000 files), and 32 per-file histories (at most 100 sessions). It retains at
most 64 listings and 256 histories in LRU order and drops an entry idle for ten minutes.
Explicitly requested session summaries lead the 32-session budget; when requested
summaries remain beyond that bound, the source schedules one further bounded pass. Each
cycle otherwise spends its budget on keys with no committed block first, then on rebuilds
of existing blocks, newest-touched first, so a new selection is never starved by older
ones. Per-file histories aggregate rows by session in SQLite before applying the 100-session
limit, so a session with many raw file changes neither hides older sessions nor undercounts
its edits.
Every lookup is a pure map read that returns `loading` and queues hydration on a miss;
readiness is `unavailable` without a store and `rebuilding` while it rebuilds. Paths are
re-validated with `isSafeRecordedRepositoryPath`; a stored path that fails is served as no
match, never exposed. Session and agent attribution come only from recorded
`file_changes` rows; a Git-only `file_paths` move yields "as <old path>" continuity,
never attribution.

The index also keeps `file_change_agents`, one row per (session, agent) with a recorded
`file_changes` row (`server/repository/file-change-agents.mjs`): the agent's bounded
one-line label (at most 200 characters), optional recorded assignment (at most 512), and
latest reported model identifier (validated like the request model; `unknown` is dropped).
The file-change contributor upserts it from the same committed snapshot's normalized
`publicState.agents` in the transaction that records the changes. A field or agent the
snapshot no longer reports keeps its last recorded value; agents without a recorded change
are never stored. The model is the agent's latest value, not the model of the request that
made a change. A missing `file_agents_version` meta key replays retained checkpoints once;
the replay is additive and never duplicates changes. A full index rebuild deletes identity
rows whose session and agent no longer have a recorded change. Store retention never prunes
this table, matching `file_changes`.

Per-file history entries carry each session agent's recorded label, assignment, and model;
a label from a peek at the session-domain store's committed `agents` snapshot (no demand,
no hydration) takes precedence while the monitor holds that session. Each session
touched-file summary lists the normalized agent IDs whose recorded `file_changes` rows
changed that file in that session (at most 12, newest-touching first, with a per-agent
change count and the recorded identity); rows without an agent never contribute. The
session-domain projection re-validates each ID and field, prefers the same session's visible
agent fields, and falls back to the recorded identity, so the Repository tab can name who
edited a file, show its assignment and latest model, and open that agent in the Agents tab.

`GET /api/repository-files?repositoryId=<repo-…>` returns the repository listing;
adding exactly one of `fileId=<f…>` or `path=<repository-relative path>` returns that
file's grouped history. Unknown or repeated keys, both selectors, or an invalid ID or
path return `400`; other methods `405`; a serving failure `503` with an `unavailable`
body. Responses are `Cache-Control: no-store` and carry their own `revision` in the body
(no ETag or `X-Pomegr-Revision`). The same-origin proxy forwards it and the LAN gateway
allowlists it. The browser store polls 1.5 seconds while unresolved, backing off to 5
seconds while `loading` or `rebuilding`, 15 seconds while `ready` and visible, and pauses
while hidden. A failed or non-OK poll, including a `503` with an `unavailable` body, keeps
the last resolved response; only a still-loading placeholder becomes `unavailable`.

Historical repository snapshots ship as a sidecar next to each session checkpoint:
`repository-<checkpoint identity sha256>.json` in the checkpoint directory, at most 64 KiB,
versioned, and validated as a whole record (any invalid field rejects the file, never a
partial read). It holds the recorded branch, `isMain`, at most 200 recorded uncommitted
files with their status, branch comparison and its check time, at most 10 allowlisted pull
requests with their check time, `commitsInSession`, and the check timestamp. The
checkpoint payload schema is unchanged. The monitor starts the bounded sidecar load with
startup and gates checkpoint projection on its completion; it does not hold live observer
attachment. That load reads only the sidecars whose checkpoint is on disk, the set the
bulk checkpoint restore projects. Any other session's sidecar is read on demand, one
identity-keyed file with no directory scan, before that session's historical projection,
its on-demand checkpoint restore, or its next live write; a session-domain commit that
finds the recorder without an answer queues the same read and recommits when it holds a
snapshot. These reads run in projection and commit work, never in a GET. The recorder
keeps at most 512 answers in memory (a snapshot, or a known absence) by recency.
Each live Git check calls `onRepositoryCheck` once observation serving is
active; until that load settles the check queues behind it, so a live write cannot replace
an older sidecar baseline before it is restored. The recorder writes a changed
snapshot atomically and the session domains recommit. A check whose remote, pull-request,
or commit count was not observed carries the previous recorded value forward only within
the same bound repository identity, and an
invalid candidate never replaces the last complete valid snapshot.

A sidecar's lifetime is independent of its checkpoint. A checkpoint is a cache that the
next hydration rebuilds from the transcript; a recorded repository snapshot cannot be
rebuilt, because an ended session never has another live check. Checkpoint capacity
eviction therefore leaves the sidecar in place, as does age: a sidecar recorded before
its session's first checkpoint write, or one whose checkpoint was evicted long ago, is
kept. Maintenance removes sidecars only beyond their own bound of 2,000 files, oldest
modification time first; `prune()` applies the same bound and also removes an invalid
sidecar. Historical serving prefers the recorded snapshot and otherwise
keeps the branch-only recorded state, itself shown only when the session's own recorded
identity resolved a proven single repository (`session.repositoryAttribution`/
`repositoryId`, the same rule for every provider; see `server/normalize/session-identity.mjs`), or
when the evidence carries the `launch` attribution.
GETs never inspect Git or GitHub, and a recorded snapshot is never refreshed from them. The no-snapshot fallback leaves pull requests
unavailable rather than asking through the current checkout. Nothing
substitutes the current branch, working tree, comparison, files, commits,
or pull-request state for recorded evidence.

Snapshot version 2 adds the Git-observed lists. `dirtyAtFirstCheck` is set once, at the
first live check under version 2, and never replaced or shown; it survives restarts in the
sidecar. `becameDirty` is the sticky union of status paths absent from that baseline.
`committedInWindow` is the latest successful `readCommitsInWindow` result (`git log
--format=%H --name-status --no-renames --since --until HEAD` with `core.quotepath=false`
and an argument array, 3
seconds, 256 KiB), read only when the live branch equals the recorded branch and carried
forward when a read fails. `gitObservedTruncated` is sticky. Each list holds at most 200
paths and 6,000 path characters, so a full record stays under the 64 KiB sidecar cap. A
version 1 record loads as version 4 with null sentinels, meaning "never measured". A
session already in progress when it first meets version 2 takes its then-current dirty
set as the baseline, so earlier edits are not Git-observed.

Snapshot version 3 adds `committedChanges`: null, or one fixed `added`/`modified`/`deleted`
per `committedInWindow` path, aligned index for index. Each path's net change comes from its
name-status letters across the window's commits, newest first: `deleted` when the newest
change deleted it, `added` when any commit in the window added it, otherwise `modified` (a
type change counts as modified). It travels with `committedInWindow`: carried forward when a
read fails, replaced on a successful read, and null when a read returned paths without
change kinds. A version 2 record loads as version 4 with `committedChanges` null.
Earlier versions load with `repositoryId` null; for every provider, they can satisfy the
repository-identity gate again only once the same session is re-observed and its evidence
records a matching proven single-repository identity. `launch` evidence is served
its recorded sidecar whatever the sidecar's repository ID, as before the rule.

The monitor derives `gitObservedFiles: { files: [{ path, source, change }], truncated } | null`
from those lists. `source` is `committed` or `uncommitted`; committed wins for a path in
both. `change` is the committed path's recorded net change, else null; the projection
drops any other value, and an uncommitted path always carries null. It travels through the `gitObservedForSession` side channel (observation runtime to
session-domain store to projection), like `fileHistory`, and the projection re-validates
every path with the repository-path validator. It appears only in the `repository`
domain, never on `/api/state` `session.repository`. The UI drops a path that already has
a recorded `fileHistory` row. GETs never run Git for it, and a historical session serves
only its recorded lists, never the current tree.

## Monitor SQLite store

The monitor owns one `node:sqlite` database, `monitor-store-v1/monitor.sqlite` under the
Pomegr data root (`resolvePomegrDataRoot` in `shared/pomegr-paths.mjs`), never under
`outputs/` (development diagnostics only). It hosts the file-change index and resource
history described in the approved persistence contract above; `files`, `file_paths`,
`file_changes`, and `file_change_agents` are populated by the file-change index, and `resource_minutes`,
`resource_peaks`, and `resource_peak_samples` by the resource-history contributor
(`server/resources/resource-history.mjs`). The database path and any raw SQLite error text never appear in browser state,
logs, thrown errors, or reports; a failure to open surfaces only as `MONITOR_STORE_UNAVAILABLE`.

The store is a rebuildable index, never a migration target. It rebuilds (recreating an
empty schema) whenever the file is missing, fails `PRAGMA quick_check`, or carries a
different schema version than the running monitor expects. While a rebuilt store has
registered contributors that have not finished repopulating it, `/api/storage` reports
`rebuilding`; with no registered contributors it reports `rebuilding` until the first
checkpoint-triggered cycle completes, then `ready`. A store that opens cleanly (not
rebuilt) is `ready` immediately. A disabled or failed-to-open store is `unavailable` with
null size and day fields. Node prints an `ExperimentalWarning` on every `node:sqlite`
import; the monitor installs a one-time `process.emitWarning` filter that drops only the
warning whose type is `ExperimentalWarning` and whose message starts with `SQLite is an
experimental feature`, leaving every other warning, including a differently-typed or
differently-worded one, untouched.

Retention runs monitor-side only after a checkpoint write commits, never in a GET, IPC, or
HTTP handler, and at most once every five minutes. Two settings govern it: an age choice
of 30, 90, 180, or 365 days, or keep all (default 90), and a soft database-size threshold
of 250, 500, 1024, or 2048 MB (default 500). Desktop passes both through private desktop
settings and a fixed-key IPC; web development reads `POMEGR_RETENTION_DAYS`
(`30`, `90`, `180`, `365`, or `all`) and `POMEGR_STORE_MAX_MB` (`250`, `500`, `1024`, or
`2048`), silently falling back to the default for any other value. Browser and LAN
requests can never change retention or trigger a prune.

Age retention drops a session's `resource_minutes` and `resource_peak_samples` once its
latest sample is older than the configured age. Size retention, once the database meets
or exceeds the effective byte threshold, deletes the oldest sessions' `resource_minutes`
first, then their `resource_peak_samples`, running an incremental vacuum between batches
and stopping after a bounded number of sessions per cycle. `resource_peaks`,
`file_changes`, `files`, `file_paths`, and `meta` are never deleted by retention; if
protected rows alone keep the database at or above the threshold, the database is allowed
to exceed it rather than deleting protected history. The committed storage-readiness
response distinguishes `normal` usage, `cleanup_pending` (the threshold is met but the
per-cycle cap has not yet cleared it), and `protected_excess` (only protected rows remain
and the threshold still cannot be met).

When retention deletes a session's minute curve, it records the bounded reason and removal
time in `resource_curve_removals`. If the session later records new minute data and a later
age or size cleanup deletes that new curve, the record is replaced so the browser describes
the latest actual removal rather than an earlier cleanup.

`/api/storage` serves the committed storage-readiness object and nothing else:

```
revision, readiness ("loading" | "rebuilding" | "ready" | "unavailable"),
databaseBytes (number | null), thresholdBytes, percent (databaseBytes / thresholdBytes,
may exceed 100; null when bytes are unknown), oldestRetainedDay ("YYYY-MM-DD" UTC or null),
lastPrunedAt (ISO timestamp or null), retentionDays (30 | 90 | 180 | 365 | null),
cleanupStatus ("normal" | "cleanup_pending" | "protected_excess" | null)
```

Checkpoint/prune work owns measurement; GETs serve only the committed result and never
touch SQLite.

## Repository context inventory

Repository context inventory is a separate repository/provider-scoped committed domain.
Repository identity is an installation-salted opaque ID derived monitor-side from the
canonical Git worktree root, or normalized session working directory for a non-Git
project. Paths remain in memory only and never enter checkpoints, public summaries,
revision documents, browser responses, logs, or renderer IPC. Worktrees are independent
repositories; duplicate display names receive only an opaque short disambiguator.

Repository rows are derived asynchronously from committed session catalog and session
evidence. Rows are ordered alphabetically by display name, with opaque repository ID as
the tie-breaker; session activity timestamps and counts never determine repository order.
Their GETs never resolve Git roots, read providers, capture diagnostics, parse
output, persist data, or hydrate sessions. `/api/repositories` serves the committed list
revision and `/api/repository-inventory` serves one already-committed immutable detail.
Both are safe for read-only LAN presentation; the LAN gateway allowlists `/api/repositories`
so the repository page, including its Files and Git tabs, loads for a paired LAN browser. Repository revision events only tell the
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
categorized total, monitor-derived initial/deferred/reserved allocation, categories with
their bounded allocation kind, groups, counts, capture time, and a private
normalized-content fingerprint are saved atomically. Old retained revisions without
allocation kinds are classified from their already-normalized category labels during
checkpoint restoration; an old compact binding without retained categories keeps a null
allocation and must not be presented as an initial-context estimate. No provider output,
error text, command, executable, credential,
or path is persisted. Fingerprints support only comparison to a previous saved capture;
they are neither exposed nor treated as continuous configuration-drift observation.

Session association is future-only, immutable, and background-only. The normalized session
commits before association begins; a settled association may queue a later re-projection but
must never delay the ready session or retry its provider observation. Sessions that predate the persisted
feature-introduction time receive an explicit no-binding decision. A new session may bind
once to the newest revision for the same repository/provider whose successful commit time
is no later than the session start. A capture completed after session start never attaches
retroactively. Completed sessions retain their compact reference; if bounded retention
removes the detail, the reference remains and reports that detail is unavailable. A real
provider snapshot recorded inside the session always takes presentation precedence. With
neither source, F renders nothing and never asks the user to run `/context`.

## Current repository plugin setup

This current-machine observation is independent of transcript-derived plugin
metadata and saved context inventories. It does not attach to session evidence,
reports, or checkpoints. No installation, upgrade, or policy edit runs automatically.

- U1/U2 provider methods `readRepositoryPluginSetup({ cwd })` own provider-native
  installation registries, manifest resolution, configuration precedence, and source
  provenance. Complete local observations run in background when a repository becomes
  known and every minute, with at most 200 repository targets, provider single-flight
  reads, bounded files/directory entries, and serialized repository batches. Unsupported
  or ambiguous formats degrade to unknown; an old cache folder alone is not evidence
  of the version selected by the provider.
- Official published manifest checks use only fixed `raw.githubusercontent.com`
  Pomegr paths and bounded `main`, release-tag, or commit refs, without credentials or
  redirects. Each request has an eight-second deadline and 32 KiB response ceiling.
  Shutdown cancels pending requests and prevents late local reads from starting new ones.
  At most 64 provider/ref entries retain successful responses for one hour or failures
  for five minutes. Failed checks retain the last successful available version and
  its original observation time while marking update status unavailable. No check
  rewrites an existing pin or infers a billing or efficiency benefit.
- C validates an explicit normalized projection; D includes it in the committed
  repositories response with the repository revision and existing revision event.
  Failure retains last-known installed version/scope/time, marks readiness unavailable,
  and disables mutation affordances. Shared policy recognition uses the shipped policy
  validator with a 24 KiB read bound; policy text and validation errors stay private.
  Removal prunes current observations. There is no P persistence for this domain.
- S repository GETs serve only committed snapshots and never inspect configuration,
  start a release check, or install anything. F serializes polling, refreshes on focus,
  aborts on unmount, retains visible data, and distinguishes loading from failure.
  Installed, enabled, available update, and session-loaded versions remain separate.
- The narrow native `repositoryPluginAction` IPC accepts only a known opaque repository
  ID, provider, and `recheck`/`install`/`update` enum. It accepts no paths, versions,
  commands, or URLs from the renderer. Private loopback preparation/recheck POSTs
  require the desktop token, exact loopback host, no Origin, and no request body.
  Preparation may return a known root only to desktop main; it must never cross
  renderer IPC or a public route. Preparation itself remains read-only.
- Desktop main confirms repository/provider/scope/current-to-target version and
  re-prepares the plan before running fixed provider CLI argument arrays. It owns
  and bounds only the new CLI children; provider session processes are untouched.
  Only the official Pomegr marketplace/plugin is eligible. Native CLI output and
  errors are discarded. Mutations serialize, retain the existing scope, and verify
  the resulting version from a fresh local check before returning a bounded outcome.
  Browser and LAN clients receive instructions and current normalized status only.

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
store commit, and candidate-to-commit delay. The aggregate feed contains no native source
or session identity.

Before development observation begins, the development composition creates one continuous
anonymous JSONL writer. It is file-first: it owns generated files only in
`outputs/pipeline-logs/`, retains at most ten files of at most 25 MiB each (250 MiB default),
and assumes one development writer. Its accepted-record queue is bounded to 1 MiB, and a
separate active drain batch is independently bounded to at most 1 MiB; neither bound is a
process-memory guarantee. Fixed versioned records contain only a fresh run UUID, local
observation timestamp, allowlisted stages/domains/outcomes/counters, synthetic lanes, and
opaque numeric flow/revision/scope handles. They must not contain a session ID, selector,
path, fingerprint, prompt, response, transcript/tool content, credential, raw error, or
provider-native payload. `span_start` records make unfinished work explicit; `gap` records
declare observed writer/instrumentation loss with fixed reasons; health records preserve
bounded normalized operations snapshots; lifecycle records delimit a run. Retention,
malformed records, partial trailing lines, rotations, limits, missing files, and gaps reduce
coverage. They never establish a complete session history or a causal diagnosis.

`npm run diagnostics:logs -- ...` passively validates, analyzes, or follows these retained
files. It does not connect to the monitor, acquire provider data, alter scheduling, write
checkpoints, or publish a revision. Diagnostic GETs do not exist. Normal development does
not start capture IPC. Continuous JSONL is the sole diagnostics path; no rolling recorder,
capture/export transport, viewer, or renderer instrumentation remains. Continuous logging is
excluded from production and desktop artifacts, not merely disabled.
Browser/LAN routes cannot start or stop any diagnostic facility. Schema, retention, coverage,
local setup and offline analysis belong to `docs/internal/operations/pipeline-diagnostics.md`.

The manually launched `npm run diagnostics:snapshot` reader consumes a fixed versioned snapshot
over a Windows named pipe or per-user Unix socket. That IPC feed is read-only, bounded,
in-memory, and not an HTTP/browser API. Connecting cannot cause acquisition, normalization,
derivation, persistence, or revision publication. The complete operational contract is
documented in `docs/internal/operations/pipeline-diagnostics.md`.

Changes to this subsystem must keep focused coverage for complete-record framing, partial
writes, multi-chunk acquisition, append continuity, staged replacement, checkpoint
restart/corruption/privacy (persisted cache files are scanned with the same hostile
sentinels as browser serialization tests), cache-only concurrent GETs, endpoint revision handling,
independent readiness, last-known-good rendering, accessibility, and retry cadence.

The structural performance acceptance criterion is: once a committed response exists,
GET latency and provider-source I/O are independent of raw transcript length, the GET path
performs zero transcript reads, and a background catalog hydration pass cannot starve
`/health` or committed API responses until a frontend proxy deadline expires.

When this contract changes, update this document, the executable provider/monitor
contracts, frontend and API types, focused regression tests, and `AGENTS.md` if a
repository-wide invariant changes.
