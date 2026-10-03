# Provider observers and unified notifications

> Status: active implementation; part 1 is implemented and verified, with parts 2–5 assigned to subsequent sequential chats.
> Created: 2026-10-03.
> Scope: provider updates, usage availability, model news, and the existing Needs input notifications through one notification subsystem.
> Continuation owner: the Pomegr maintainer running the next ACOS part.
> Authority: proposed implementation checklist; current runtime contracts still govern shipped behavior.
> Next task: review and merge the part-1 PR, then execute part 2 for durable state and native delivery.
> Completion criteria: all five parts pass their checks, independent review, and inspected UI evidence; unsupported sources remain explicitly unavailable.
> Permanent destinations: observation-cache.md, overview.md, provider-status.md, agent-workflow.md, the public Settings and Usage limits guides, and DESIGN.md if shared controls change.
> Lifetime: temporary; transfer enduring contracts and remaining obligations, repair references, then delete this plan and its temporary artifacts when completed, cancelled, or superseded.

The owner approved the sequential structure on 2026-10-03 and clarified that the
existing notification is **Needs input**. The owner subsequently authorized all
five parts in sequential chats, coordinator validation and fixes, and one PR per
part for the user to merge. This supersedes the original planning-only gate and
the phase-owning chat's no-commit restriction. The current tray's “Needs
attention” group is a presentation label, not a separate source of truth.

## What exists and why it should change

The current code has useful delivery boundaries, but no shared notification
lifecycle. Adding each new observer to both existing implementations would repeat
policy and make their behavior diverge.

| Current owner | Observed behavior | Consequence |
| --- | --- | --- |
| `desktop/runtime/notifications.mjs` | Native Needs input payload, safe session routes, and an in-memory transition set | Reusable delivery safety; no durable deduplication or first-run baseline |
| `desktop/runtime/shell-main.mjs` | Polls the committed session catalog every two seconds and delivers native alerts | Keep native delivery in Electron main; remove source-specific polling from the shell |
| `app/components/command-center/NotificationCenter.tsx` | Builds Needs input, provider service, and monitor alerts in React; keeps read identities in memory | Separate derivation and read behavior from rendering |
| `desktop/runtime/desktop-behavior.mjs` and `settings.mjs` | Notifications enablement and quiet behavior | Preserve existing choices and migrate settings without resetting them |
| `server/runtime/observation-runtime.mjs` | Asynchronous usage observation and committed cached responses | Reuse observations; notification GETs must not fetch account data |
| `server/runtime/provider-status-observation.mjs` | Cached public provider health | Reuse for incident and recovery events; do not add another health poller |
| `server/repository/repository-plugin-runtime.mjs` | Current repository plugin setup and published-version comparison | Reuse its release reader; do not confuse installed setup with session-observed plugin metadata |
| `desktop/runtime/updater.mjs` | Pomegr application update lifecycle | An optional future source; preserve its independent installation boundary |

This is a structural assessment from symbol searches and a fast-tier locate pass,
not a claim that every current behavior has been tested. The runtime owners and
their focused tests must be read by their implementers. The known double reads
are the notification surfaces and provider observation seams: the locate pass
mapped behavior spread across desktop, React, and monitor modules; implementation
will read those owners again.

## Notification catalog

| Event family | Trigger and wording | Initial scope |
| --- | --- | --- |
| Needs input | A live session enters the normalized needs-input condition; clear when committed evidence resolves it | Required; first migrated producer |
| Provider release | A newly observed eligible Claude Code or Codex release; distinguish “released” from “update available for this installation” | Required; CLI first, other client products only with a validated source |
| Pomegr plugin release | A newer official reporting-plugin/MCP package release; installation comparison uses current setup | Required; one release notification, not one per repository |
| Usage window reset | Fresh evidence confirms a window rollover; label the affected provider and window | Required; distinct from the clock merely crossing a timestamp |
| Capacity restored | Fresh evidence shows a previously exhausted applicable window below its limit | Required; never claim the entire account is usable while another applicable window remains exhausted |
| Reset available | Codex reports an available earned reset after previously reporting none, or a later increase | Required when supported; notification opens Usage limits, never consumes a reset |
| Model announcement | A new entry in a verified official announcement source | Required with a validated source; does not assert account access |
| Model in client catalog | A complete, fresh supported client catalog gains a visible model | Required where supported; say “Listed in your client,” not “You have access” |
| Model access | Only an explicit supported entitlement source can establish account availability | Evidence-gated; absence of such a source is an explicit limitation |
| Provider incident/recovery | Existing committed public status changes | Migrate the existing incident card in part 1; add coalesced recovery behavior |
| Authentication needs action | An existing observer returns a recognized authentication state that persists beyond its normal retry | Recommended addition, opt-in native notification; unknown failures do not qualify |
| Model deprecation | A verified official announcement names a retirement or replacement | Recommended addition to the model source, no inference from a missing catalog row |

Later candidates are Pomegr application update-ready, provider/plugin
compatibility changes, and persistent loss of observation. They use the same
registry when implemented. Task completion, every failed tool, percentage
thresholds, and transient fetch failures are excluded from this first release to
avoid noisy alerts without a demonstrated user need.

“Codex version” must be qualified by product: CLI, desktop app, and IDE extension
have different release and installation identities. The first source covers the
CLI Pomegr can validate. If desktop or extension metadata is unavailable, label
that coverage explicitly rather than calling the CLI release a desktop update.
Similarly, the Pomegr plugin version is not the Pomegr application version or the
MCP protocol version.

## Architecture and ownership

Use one small, typed subsystem with explicit producer registration. Avoid a
general message broker, dynamically loaded notification plugins, or one polling
timer per notification kind.

```text
Existing/new provider adapters and desktop status sources
    -> validated normalized observations, committed by their existing owners
    -> notification rules and bounded occurrence ledger
    -> committed notification snapshot + revision
    -> cache-only API / existing invalidation transport
    -> in-app tray and native desktop delivery adapters
```

The proposed monitor owner is `server/notifications/`, with composition in
`server/runtime/notification-observation.mjs`. Provider-specific acquisition stays
in `server/providers/<provider>/`; official plugin release acquisition remains
with its existing repository owner. A provider-neutral registry accepts injected
normalized facts and pure rules. It must not import provider-private modules.
`shared/notification-contract.ts` defines the public discriminated union and
fixed action keys. Extend the executable import-boundary rules and agent workflow
for the new folder; do not silently allow every server folder to import it.

Each producer declares its kind, supported source capability, scope, identity
rule, freshness requirement, transition rule, resolution rule, retention, default
delivery category, and fixed action. Pure rules receive prior committed facts,
current committed facts, and an injected clock. Adding a producer should require
its rule, source normalization if new, one registration, and focused fixtures;
it should not require editing native delivery or the tray's business logic.

The monitor owns occurrences derived from committed monitor evidence. A monitor
cannot announce its own unreachability to a disconnected client: the client-local
connection condition uses the same contract and presentation policy but stays
local, with a separate identity namespace. Electron's update-ready state can
likewise remain a native fact until its future producer is implemented. These
exceptions must not grow into duplicate provider rules in React.

### Public record and safe actions

Propose a versioned, bounded record containing only an opaque occurrence ID,
allowlisted kind/category/severity, normalized provider/product scope, recorded
or observed event time with a bounded basis, current lifecycle state, bounded
validated kind-specific data, and a fixed action key. The kind-specific union
admits only the data its copy requires: a normalized session ID and already
approved bounded session title, semantic version, fixed usage-window key, or
validated model identifier/display label. Render static copy from these fields;
never pass through release bodies, reset-credit titles/descriptions, or raw errors.

Actions resolve from fixed keys to safe local routes such as a session, Sessions,
Usage limits, Providers, or repository plugin setup. Any official release link
must be assembled or checked against an exact product/source allowlist in the
native boundary. Notification records cannot carry arbitrary navigation URLs,
commands, executable paths, reset-credit IDs, or arbitrary IPC calls. Clicking an
alert never installs software, authenticates, consumes a reset, approves work, or
changes a provider.

These are proposed new serialization/persistence contracts. Update AGENTS.md's
allowlists and the observation-cache contract in the same implementation that
introduces each field. Existing request-model and usage-window permissions do not
implicitly authorize a new model catalog or credit payload. If the minimal source
needs broader data than this approved feature requires, report the limitation
instead of broadening collection.

### State, identity, and delivery

Separate an active condition (for example, still waiting for input) from an
occurrence (the transition into that condition), and both from client read state
and native delivery state. Reading an alert does not resolve its condition.

- Occurrence identity is stable across repeated polls and restored revisions.
  Use opaque digests over validated scope and evidence generation; no paths,
  account IDs, source fingerprints, or raw provider IDs reach clients.
- A newly initialized producer establishes a baseline. Existing conditions appear
  in the tray, but first observation does not manufacture “new” native alerts.
  A later false-to-true Needs input transition creates a new occurrence even for
  the same session. A missing page, stale snapshot, or fetch failure is not false.
- Persist only the bounded normalized occurrence ledger and minimal producer
  baselines required to avoid restart duplicates. Reuse the monitor's atomic
  persistence machinery; retain the last known-good revision on invalid load or
  write failure. Never persist upstream payloads or credential information.
- Proposed bounds: newest 200 occurrences, 30-day retention, and a 1 MiB serialized
  budget; at most 100 active session conditions, with a bounded overflow count.
  Producers retain bounded keys, not an unbounded set of all observed releases,
  sessions, repositories, or models. Deduplication may expire with retention;
  document that limit rather than claim permanent exactly-once delivery.
- Track browser read/dismiss state per client using a bounded list of opaque
  occurrence IDs. Paired browser preferences are local and cannot mutate native
  settings. Desktop native delivery has one owner under the existing single
  instance lifecycle, and durable delivery claims scoped to the local profile.
- Claim an occurrence durably before native dispatch. This avoids normal restart
  replay but can miss a toast if the process crashes between claim and dispatch;
  the tray retains the occurrence. Do not promise exactly-once OS delivery.
- Disabled/quiet native notifications consume eligible transitions, as today;
  they are not replayed when quiet mode ends. Current tray conditions remain
  visible. Keep existing preferences on migration; new low-priority news defaults
  to in-app visibility, with native alerts opt-in by category.
- Coalesce provider releases and model news, and rate-limit native dispatch (a
  proposed maximum of three toasts per minute). Needs input has higher priority,
  but storms must still leave all retained events accessible in the tray.
- On reconnect, use the latest committed revision plus retained occurrences.
  Suppress old native events (proposed age cutoff: 15 minutes); show retained
  information in-app. Starting a second tab never causes a native toast.
- Switching provider folders or a private credential-source scope resets that
  producer's comparison baseline. Source fingerprints remain private; neither
  switching accounts nor missing evidence may masquerade as a reset or new model.

### Observation scheduling

Consume existing usage, catalog, status, and plugin commits through subscription
or injected callbacks; do not run duplicate provider requests for notifications.
New release and announcement readers run in low-priority background jobs, with a
proposed six-hour cadence, bounded jitter, single-flight requests, timeouts,
response-size/item limits, conditional requests where supported, and exponential
backoff that honors Retry-After. Proposed model catalog cadence is one hour only
when a supported read-only source exists. All intervals are internal constants,
not an arbitrary user-programmable scheduler.

A known reset deadline may enqueue a refresh through the existing usage
coordinator when its cooldown permits. It never bypasses backoff or makes a GET
acquire data. Refreshes after resume coalesce; no busy loop runs on an overdue
timestamp. Timers stop on shutdown, and disabled/unavailable providers create no
new acquisition jobs. A broken news endpoint must not delay session observation,
cached serving, or a Needs input transition.

## Evidence rules for the requested observers

### Usage and reset availability

Use original observation times and normalized windows from the account usage
coordinator. A clock crossing `resetsAt` only means the reported deadline passed;
it can schedule a check, not emit “Your limits reset.” A later fresh observation
must establish rollover or restored capacity. Preserve window identity and
distinguish a rollover from a same-window decrease; the latter may justify
“capacity available again” without asserting why. Require matching private source
scope and reject out-of-order, stale, partial, or incomparable observations.

Deduplicate a rollover/capacity pair into one user-visible occurrence when they
describe the same recovery. A five-hour recovery while a weekly limit remains
exhausted says only that the five-hour window recovered. Local Claude status-line
observations retain their provenance and original age; they are not an
authoritative account-wide entitlement probe.

The official [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
documents `rateLimitResetCredits.availableCount` on `account/rateLimits/read`.
Use only a bounded normalized availability/count, observation time, and supported
or unknown status. Null/missing is unknown, not zero. Detect zero-to-positive or
an increased count after a baseline; repeated positive values are not new events.
Do not retain credit IDs, titles, descriptions, or redemption payloads, and never
call the reset-consumption method. A positive credit count does not prove a
specific exhausted window is currently eligible for redemption.

### Releases and plugin updates

Pin official sources in the adapter, validate semantic versions/channel/product,
ignore drafts and unintended prereleases, and use the channel appropriate to
the observed installation where known. Claude's [setup documentation](https://code.claude.com/docs/en/setup)
distinguishes stable/latest channels and package-manager updates. If installation
or channel evidence is missing, notify “release published,” not “your installation
can update.” A version recorded in a historical transcript is not the installed
version today.

Validate exact current source endpoints before implementation; source checks use
official release/channel metadata, never search snippets or scraped logged-in
pages. Release links, redirects, payload limits, conditional requests, and schema
failure behavior get fixtures. Reuse the official Pomegr plugin release reader;
aggregate affected installations without exposing configuration paths or emitting
one identical toast for every repository. Do not download or execute installers.

### Models and availability

Keep announcement, client catalog, and account entitlement as separate evidence
classes. Official [Codex model listing](https://learn.chatgpt.com/docs/app-server)
is a candidate source, but OpenAI also documents that some configurations return
a [bundled catalog rather than an entitlement check](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
Catalog additions must be labeled accordingly. Do not launch paid inference or
synthetic conversations to prove access.

Account-only Codex observation is presently restricted to usage reads. Extending
it with a bounded model-list read requires explicit adapter/contract changes,
capability gating, complete pagination within a hard bound, timeout and shutdown
tests, and no thread, turn, or lifecycle operations. Do not turn the existing
short-lived usage client into an unbounded resident app-server.

Claude model-list or account-availability acquisition is conditional on finding a
documented read-only source compatible with its authentication and Pomegr's
privacy rules. Never reuse a coding subscription credential against an unrelated
API endpoint. A source that cannot be verified ships as unsupported, while the
official announcement producer can still operate. Do not claim removals or
deprecations from incomplete pagination, parser failures, hidden rows, changed
aliases, or one missing snapshot.

## Five sequential ACOS parts

Each part ends with a working tree and a handoff. Parts are vertical capabilities;
within a large part, delegated stages run sequentially against explicit seams.
There is no simultaneous editing of shared contracts or composition files.

| Part | Deliverable | Principal owners | Acceptance evidence |
| --- | --- | --- | --- |
| 1 | Shared notification contract, occurrence rules, cached serving, and migrated in-app Needs input/status alerts | New notification domain and contract; runtime/serving integration; NotificationCenter and its client | Same normalized condition in one producer; no provider acquisition in GETs; legacy React derivation removed; current alerts still render |
| 2 | Native delivery, durable baselines/claims, read state, preferences, and safe actions | Notification persistence; desktop notifications, behavior/settings/preload; notification preferences UI | Restart, second tab, quiet mode, recurrence, corrupt store, and action allowlist fixtures |
| 3 | Usage reset/capacity and supported reset-availability notifications | Claude/Codex usage normalization and usage producer | Fake-clock and synthetic account-window transitions; no reset consumption; stale/missing/source changes do not notify |
| 4 | Provider and Pomegr plugin release notifications | Provider release sources and release producer; existing plugin release seam | Version/channel/install distinctions, repository deduplication, bounded network/backoff fixtures |
| 5 | Model announcement/catalog observers, declared availability coverage, final review and visual evidence | Model sources and producer; final contracts/guides and integration tests | No announcement-to-entitlement inference; all retained claims demonstrated; one independent final review |

Part 1 owns the common event contract and runtime registration seam. Later parts
consume it and add their named kinds through its defined registry, rather than
forking the envelope. Shared composition/contract/documentation edits are
explicit serial integration work; the manifests name these owners and assumptions.
Do not run these manifests in parallel. Test-only fixture routes or servers stay
outside production and use synthetic data.

The early 25–35-file estimate covered the main behavior owners. Composition,
privacy contracts, dedicated regression fixtures, and visual evidence require
additional file touches; manifests count their explicit worker slices separately.
File/line reservations are conservative estimates, not limits on completing the
authorized behavior, measured usage, or a promise of implementation size.

### Checks and closeout

- [x] Part 1: pure-rule tests, cached-serving/revision/privacy tests, existing app-shell tests, boundary checks, and `npm run verify:fast` pass.
- [ ] Part 2: desktop notification/behavior/security tests and preference UI tests pass; no provider actions are reachable through a notification.
- [ ] Part 3: usage fixtures cover deadline-only, real rollover, same-window recovery, other exhausted windows, source switches, stale data, repeated credit counts, and unsupported fields.
- [ ] Part 4: release fixtures cover channel changes, downgrades, equal versions, prereleases, unavailable installed versions, invalid payloads, redirects, timeouts, and duplicate repositories.
- [ ] Part 5: model fixtures cover announcements, bundled catalogs, partial pagination, aliases, unavailable entitlement sources, and false deprecation prevention.
- [ ] Final review covers all five parts, serialization/persistence boundaries, scheduler isolation, stale data, retention, multi-client delivery, and extension cost.
- [ ] Inspected captures show Needs input, quiet/disabled preferences, usage recovery/reset availability, release news, and separately labeled model announcement/catalog evidence at desktop and phone widths.
- [ ] Run the canonical full verifier and focused desktop security checks for the completed implementation; record results without claiming OS toast acceptance from unit tests alone.
- [ ] Transfer enduring rules into current contracts/public guides, assign evidence-gated unsupported sources explicitly, repair links, and delete temporary planning artifacts under the maintenance workflow.

Use synthetic facts and injected clocks for durable tests. Test deadlines across
sleep/resume and clock jumps, complete/incomplete catalog pages, stale transitions,
retention overflow, schema migration, and failed persistence. Verify a slow or
failed release source cannot block cached reads or live-session observation.
Native OS toast display/click behavior needs interactive desktop acceptance when
available; blocked OS acceptance remains an explicit unmet check, never an
invented screenshot or silent pass.

## Run instructions and continuation checkpoint

The local ACOS package is
`.agents/skills/acos/runs/2026-10-03-provider-notifications/`, containing `plan.yaml`
and one `manifest.yaml` under each numbered part. ACOS run output is gitignored
by the installed skill; this tracked plan is the durable design/continuation
record. Do not silently change the skill's ignore policy to publish run artifacts.

Start in a fresh Codex session in this repository:

```text
/acos run runs/2026-10-03-provider-notifications 1
```

Each manifest embeds its intent, acceptance, safety boundaries, scope, input
paths, checks, and estimates. It has `mode: sequential` and `gates.go: required`.
Complete one part, read its handoff in the next session, and run the next index.
Each phase-owning chat records implementation outcomes, commits and pushes its
validated changes, and opens a PR against main. Delegated implementation workers
must not commit or push. No phase merges its PR or starts the next phase.

The provider catalog specifies the external Codex adapter. Manifests
use it with resolved `gpt-6-sol` implementation/evidence workers and a
`gpt-6-astra` final reviewer. Invocation must use executable/argument arrays and
stdin, never interpolated shell commands. Record actual model and usage when the
harness provides them. Native Codex subagents may replace the external adapter
while retaining the manifest model/effort roles; record this execution drift.
Do not modify ACOS configuration as part of this feature.

Part-1 checkpoint: the common contract, bounded occurrence ledger, committed
catalog/status projection, cache-only API, SSE invalidation, and migrated web tray
are implemented. The focused tests, `verify:fast`, build, and full tests passed;
the final client suite covers lower/equal revisions after restart, pending-request
resume, delayed prior-epoch responses, and malformed record rejection. The
existing platform/opt-in tests remain explicitly skipped by their test gates.
Current behavior belongs to the enduring contracts linked above.

Part 2 owns persistence, native delivery and durable read markers. Part 5 owns
both retained part-1 visual claims at 1280 and 390 px: Needs input with safe
session navigation, and distinct provider incident/recovery and client-local
monitor-offline states. Exact synthetic capture commands live in the part-1
handoff artifacts; no production fixture route or provider probe was added.
