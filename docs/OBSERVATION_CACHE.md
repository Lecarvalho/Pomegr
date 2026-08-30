# Observation cache and progressive readiness contract

This document is the canonical operational contract for Pomegr's provider-neutral
session observation cache, API serving model, and progressive UI readiness. Design plans
under `docs/plans/` are historical records; when a plan and this document differ, this
document and `AGENTS.md` govern repository changes.

## Non-negotiable invariants

- Provider acquisition and normalization run before and independently of browser GETs.
- Background acquisition and normalization must yield between bounded chunks and session
  hydration units so the monitor's cache-serving event loop remains responsive.
- Production `/api/sessions`, `/api/state`, `/api/home`, and `/api/usage-limits` handlers
  read only committed response caches. They never open, seek, or parse provider
  transcripts and never synchronously call a provider usage service.
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

Codex lifecycle observation has an explicit ownership boundary. A connected owning
app-server supplies runtime status through read-only list/read observations with
successful per-thread confirmation; its status expires after 120 seconds without a
fresh observation as `observation_gap`. The separate account-only app-server used for
usage limits is never a session observer. The CLI documents a proxy to a running local
daemon, but Desktop owner association and socket discovery are not established by this
contract, so production does not auto-attach, pair, or configure that transport. The
hook bridge is opt-in and requires a recognized Codex/ChatGPT ancestor or a validated
explicit owner PID; it does not reuse an old lease when current identity is unavailable.
It persists only its versioned bounded snapshot: v2 allowlisted lifecycle event,
optional SessionStart source, stop-hook continuation flag, bounded IDs, timestamps,
sequence, and local lease state. Legacy v1 snapshots remain parseable but contribute
unavailable evidence. Stop/SubagentStop/SessionEnd are boundary signals rather than
completion proofs; compact SessionStart preserves state only with matching non-null
turn identity and owner/lease identity, otherwise it is unknown. Lease expiry and
missing ownership downgrade to unknown/stale and never to idle. Historical views omit
runtime liveness and hook snapshots.

U1 detects lifecycle-only changes using a bounded private fingerprint alongside
transcript generations, including source status, evidence, freshness, and live/history
classification. The fingerprint never exposes a provider path or raw lifecycle
payload. A changed fingerprint schedules U2 normalization with an empty transcript
delta even without source-byte growth; C then validates and atomically commits the
candidate. Known API-only sessions do not require a rollout file to enter this path.
Unchanged normalized observations do not create duplicate revisions. Restored Codex
lifecycle state is downgraded to unknown/stale until fresh acquisition confirms it;
startup rederivation consumes that downgraded evidence, never the original checkpoint lifecycle.
All production GETs remain cache-only: a request may queue hydration but cannot acquire
or normalize synchronously, and the last-known-good committed revision remains served
until a complete replacement validates and commits atomically.

For an open Codex turn, freshness is measured from the latest recognized provider
progress record, not from turn start, file modification time, or poll time. More than
120 seconds of silence is unknown, never idle; malformed, incomplete, or mismatched
record generations also remain unknown until a complete replacement is acquired.

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
- For multi-file Codex sessions, U1 owns an independent cursor and bounded private
  lookbehind for every root or child rollout. After the initial complete build, U2 receives
  only newly completed records plus that lookbehind; it does not rescan the complete
  transcript or the generic live tail for session-story normalization.
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
| Structural catalog projection | Backend monitor / D | Commits additions, removals, live, needs-input, and activity-status transitions to the catalog response cache | Schedule in the next event-loop turn; structural work preempts a queued summary refresh |
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

Usage refresh failures retain the last known-good provider values. The public refresh
state may include only the normalized `authentication_required`, `rate_limited`, or
`unavailable` kind, the safe attempt timestamp, and the earliest local retry-eligibility
timestamp computed from the coordinator's cooldown. Raw provider response bodies,
headers, request identifiers, credentials, and endpoint details remain monitor-private.
`rate_limited` means only that the usage request received a recognized throttle response;
it is not evidence that an account or session exhausted its plan allowance.

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
context snapshot, bounded agent-reported progress, and the normalized primary agent's
nullable current-activity label, observation timestamp, and fixed `current`
qualification. D derives that qualification from the primary agent's
committed lifecycle, not from child activity, wall-clock recency, or file timestamps.
Only an observed/current active primary in a working or needs-input catalog row is current
(a child awaiting input does not stop the primary). Unknown, stale, inferred, missing,
restored, or inactive primary lifecycle produces null in the catalog, even if children
work. The older heading remains in retained agent evidence, not in Current activity.
An Idle or non-live catalog row suppresses any older cached heading immediately, before
detail hydration, without erasing the retained primary evidence. Both the observation
catalog and compatibility session feed use the same projection rules; with observation
enabled, the feed returns the committed catalog directly rather than rebuilding from a
separately cached summary. F renders only qualified current headings, with the original
activity icon. All other cases show an em dash in the activity column and no compact
heading; legacy unqualified or last-observed payloads never acquire a current icon.
Completed rows retain their
last committed agent count, context snapshot, and progress; their active-agent count is
zero and current activity is null. Subagent activity, context history, resources, provider
records, and every other agent field remain outside the catalog response. React consumes
each row directly and never joins catalog identity to a parallel summary collection.
Caught provider, filesystem, and checkpoint failures use fixed sanitized states rather
than arbitrary exception text.

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
