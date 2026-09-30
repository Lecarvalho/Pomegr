# Limitations

> Scope: current provider evidence gaps and Pomegr's own observation, attribution,
> and presentation limits.
> Authority: maintained limitations inventory. The executable
> [provider contract](../../../server/providers/provider-contract.mjs) and adapter
> manifests own capability declarations; [Observation cache](observation-cache.md)
> owns acquisition and serving; [Metrics](metrics.md) and
> [Global session statuses](../../SESSION_STATUS.md) own exact rules.
> Related code and checks: [Claude adapter](../../../server/providers/claude/index.mjs),
> [Codex adapter](../../../server/providers/codex/index.mjs),
> `npm run check:provider-docs`.

This page lists known limitations of Pomegr's current behavior. The first section
covers evidence the recognized provider sources do not supply. The second covers
what Pomegr cannot yet observe, separate, or infer reliably from available evidence.
An unavailable value is not zero, and a missing observation does not prove a session
or agent was inactive. Privacy and read-only boundaries are deliberate product
rules; they are named here only when they limit a specific feature.

## Provider-related limitations

### Declared capability support

The table is generated from every adapter's enforced capability manifest. It
lists the complete **declared capability catalog**, not every narrower detection
gap. “Supported” means the adapter implements the capability; runtime readiness
and evidence in an individual session remain separate. An unsupported feature is
omitted rather than shown as zero.

<!-- provider-capabilities:start -->
| Capability | Normalized evidence | Claude Code | Codex |
| --- | --- | --- | --- |
| Approval mode | `session.approvalMode` | Supported | Supported |
| Automatic compactions | `compactions` | Supported | Supported |
| Context machinery | `session.contextMachinery` | Supported | Unsupported — Codex session evidence does not expose normalized context-machinery categories. |
| Repository context inventory | `repository.contextInventory` | Supported | Unsupported — Codex does not expose a comparable repository context inventory diagnostic. |
| Repository plugin setup | `repository.pluginSetup` | Supported | Supported |
| Estimated cost | `session.cost` | Supported | Unsupported — Codex session evidence does not expose a provider cost estimate. |
| Live sessions | `catalog.isLive` | Supported | Supported |
| Needs-input state | `catalog.needsInput` | Supported | Supported |
| Plan tasks | `planTasks` | Supported | Supported |
| Cache-write usage | `usageSnapshots.cacheWrite` | Supported | Unsupported — Codex usage evidence does not provide normalized cache-write tokens. |
| Cache usage classification | `usageSnapshots.cacheComparable` | Supported | Unsupported — Codex usage evidence cannot safely classify cache-write behavior. |
| Session summary | `session.summary` | Supported | Unsupported — Codex session evidence does not expose a bounded provider session summary. |
| Agent-reported signals | `session.signal` | Supported | Supported |
| Usage limits | `usageLimits` | Supported | Supported |
| Workflows | `workflows` | Supported | Unsupported — Codex does not expose the structured workflow artifacts required by the normalized workflow contract. |
<!-- provider-capabilities:end -->

### Session status and lifecycle

| Provider | Limitation | Effect and evidence boundary |
| --- | --- | --- |
| Claude Code | A Remote Control `sdk-cli` session's local registry can omit its worker lifecycle; that state may also be absent from the transcript. | Pomegr uses the bounded native session metadata response only for a locally registered session with a validated owner and bridge identity. Missing access or an unrecognized response leaves new status **Unknown**; a temporary failure may retain a previously valid observation for that same owner without renewing its time. See the [Claude lifecycle contract](../../CLAUDE_SESSION_STATUS.md#source-and-evidence). |
| Claude Code | Ordinary session metadata does not include the worker's background-task list. | A primary **idle** state cannot prove all background work ended. Pomegr recognizes only structured launches and closures in the primary transcript; unrecorded tasks and some child-only work can be missed. The worker metadata route is unavailable to ordinary OAuth, and Pomegr does not attach to the worker. See [background execution](../../CLAUDE_SESSION_STATUS.md#background-execution-is-independent-of-primary-idle) and [whole-session aggregation gaps](../../SESSION_STATUS.md#whole-session-aggregation-gaps). |
| Both | A provider's recorded lifecycle can be incomplete or unavailable for an individual session. | **Open** confirms presence without establishing that work is executing; **Unknown** preserves uncertainty. A recorded turn end does not prove overall task success or inactivity of related agents. See [global status](../../SESSION_STATUS.md#global-status-table). |

The detailed precedence rules and integration gaps remain in
[Global session statuses](../../SESSION_STATUS.md).

### Usage, cache, and estimates

- **Codex cache writes and refill classification:** Subscription-backed session
  records do not currently provide reliable cache-write counts. Pomegr can show
  recorded cache reads, but omits Cache write and write-backed refill, miss, and
  reuse classifications. It does not reconstruct writes from later reads. This
  upstream gap is tracked at [openai/codex#35300](https://github.com/openai/codex/issues/35300).
  See [context usage](metrics.md#context-usage) and
  [cache events](metrics.md#cache-events).
- **Cache timing for either provider:** A reply, summary, or lifecycle event
  without valid request usage cannot supply a request or cache-touch timestamp.
  Missing or malformed cache evidence leaves lifetime and classification
  unavailable. Codex's `30m+` indication is a documented model-policy minimum,
  not a recorded expiry time; elapsed time never proves an entry was dropped.
  See [Cache timing](../../CACHE_TIMING.md#lifetime-indication).
- **Cost and account usage:** Codex has no supported session-cost source. Claude
  Code cost is available only when its optional status-line bridge captures the
  provider's client-side estimate; it is not billing. Both providers' usage-limit
  views need a working authenticated source, and Codex additionally needs a
  supported native CLI. A supported capability can therefore be unavailable on
  one installation or during a provider failure. See [API list-rate estimate](metrics.md#api-list-rate-estimate)
  and [configuration](../../CONFIGURATION.md#capability-availability).

Provider service status is public component-level reporting. It cannot establish
whether an incident affected one account, model, or session. See
[Provider service status](../../PROVIDER_STATUS.md).

## Pomegr-specific limitations

### Session file scope and attribution

The session Repository tab's **Touched here** list is broader than files proven to
have been edited by that session. It combines recorded structured file-tool edits
with separately marked **Git-observed** paths. A Git-observed path is a file
committed on the recorded branch during the session window or one that became
uncommitted after the session's first live Git check. This branch-and-time match
cannot identify the actor: work by another session, a person, a script, or a
background process can appear under **Touched here**. The Git glyph marks these
paths; they have no session agent or request attribution and do not count as
recorded edits. A Git-marked row proves only that Git saw the path during the
session window. It does not prove that this session changed it. Changes already
present at the first live check form a baseline and can be absent from the
Git-observed portion. Pomegr cannot currently provide a complete, exclusive list
of files changed by this session.

In a live view, the adjacent **Uncommitted** segment shows the repository's
working-tree changes, including paths outside the selected session; a historical
view uses its recorded snapshot. **Changed elsewhere** excludes paths
already placed in **Touched here**, so a path changed by another actor can also make
that segment understate unrelated work. These are Pomegr scoping and presentation
limits, not proof that the provider attributed those files to the session. See
[Git-observed files](metrics.md#git-observed-files) and the
[Repository tab grouping](../../../app/components/dashboard/repository-files-view.ts).

Provider records do not prove every filesystem write. Pomegr records file-change
attribution only from recognized structured file tools with an explicit target and
matching success evidence. Shell commands, scripts, builds, and external editors
can change files without a reliable session, agent, or request association. Git
observations can add separately labeled paths, but cannot manufacture that
attribution. Consequently, recorded session-attributed history can omit files the
session actually changed, even while the broader Git-observed list can include
unrelated work. See [File-change history](metrics.md#file-change-history).

### Session status coverage

- **Claude Code child activity:** Pomegr's global row tracks recognized open
  background launches in the primary transcript, but does not fully aggregate
  child input waits or work recorded only in child transcripts. **Idle** or
  **Unknown** can therefore miss active children; **Needs input** may reflect the
  primary even while another agent works. See
  [whole-session aggregation gaps](../../SESSION_STATUS.md#whole-session-aggregation-gaps).
- **Claude Code stopped label:** The current global mapping never emits
  **Stopped** for Claude sessions, although individual agents and tasks can stop.
  See [global status](../../SESSION_STATUS.md#global-status-table).
- **Codex approvals and related work:** The default monitor has no owning-runtime
  approval feed. Mobile permission waits can be missed; no specific mobile event
  has been inspected to prove it is absent from a transcript. Recognized linked
  live children are aggregated, but missing or unlinked children and shell tasks
  are not independently established as active by the global reducer. See
  [completion and permission evidence](../../SESSION_STATUS.md#completion-and-permission-evidence).
- **Codex presence outside Windows:** Pomegr validates native writer ownership on
  Windows. It does not infer presence from locks on platforms without separately
  validated native semantics. See [live status](../../SESSION_STATUS.md#what-establishes-live-status).

### Other product and interpretation limits

- **Desktop availability:** Packaged Pomegr desktop downloads are currently
  available for Windows x64 only. See [Install Pomegr](../../public/get-started/install.md).
- **Repository associations:** Commits counted in a session window can include
  commits by anyone on its branch. A pull request found for the live branch need
  not have been created by the selected session. Neither is per-session
  authorship. See [Git state](metrics.md#git-state) and
  [pull-request associations](metrics.md#pull-request-associations).
- **Usage-limit movement:** Pomegr's retained usage feed can correlate a
  provider-reported percentage change with local request activity in the same
  interval. It cannot assign that
  change, a bill, or a proportional share of usage to a session. See
  [plan usage](metrics.md#plan-usage).
- **Cache timing and efficiency signals:** Pomegr's deterministic rules operate
  on bounded observations. They do not establish why a cache entry became
  unavailable, when it expired, or what money was saved. See
  [cache events](metrics.md#cache-events) and
  [Cache timing](../../CACHE_TIMING.md#lifetime-indication).

### Keeping this inventory current

When a limitation changes, update the affected behavior contract and this inventory
together. For declared provider capabilities, update the adapter manifest and
regenerate the table with `npm run docs:providers`. Do not describe a Pomegr
integration gap as missing provider data without evidence. Run
`npm run check:provider-docs` and the documentation checks in the
[maintenance workflow](../development/documentation.md#verify-the-change).
