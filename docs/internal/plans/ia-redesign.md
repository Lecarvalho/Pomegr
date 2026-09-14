# Information architecture redesign

> Status: approved design, implementation not started.
> Created: 2026-09-13.
> Audience and owner: Pomegr maintainers; each executing agent owns the task it selects.
> Lifetime: ephemeral. Delete this plan and `docs/internal/plans/ia-redesign/` in the change that completes the last task, after moving enduring rules into `DESIGN.md`, `docs/OBSERVATION_CACHE.md`, and `docs/METRICS.md`.
> Scope: web dashboard sitemap, session page tabs, agent detail route, repository file history, app bar and page header, sidebar limits, request chart lanes, transport and per-domain caching, resource sample history with retention.
> Authority: work plan only. `AGENTS.md`, `DESIGN.md`, and `docs/OBSERVATION_CACHE.md` remain authoritative and must be updated by the tasks that change behavior.
> Next task or decision: resolve the open questions at the end of this plan, then start T00.
> Completion criteria: every task from T00 through T13 has a dated checkpoint, T12 has moved the enduring rules to their owners, and this plan and its prototype folder are deleted.
> Permanent destinations: `DESIGN.md` with `/design-system`, `docs/OBSERVATION_CACHE.md`, `docs/METRICS.md`, `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, and `AGENTS.md`.

## Outcome

Pomegr shows an overview first and depth on demand. A newcomer reads one session
screen without scrolling; an analyst opens a tab; an expert opens an agent or a
request. Every layer is a URL, loads only its own data, and polls only while
mounted. The visual tone stays calm: outline chips, muted tints, brand color only
on the primary action, active tab, and text links.

The approved visual reference is the prototype in
[`ia-redesign/prototype/`](ia-redesign/prototype/README.md). Implementation must
match it at high fidelity. Each UI task ends with a side-by-side comparison of the
running app and the matching artboard, recorded in the task checkpoint.

## Prototype fidelity rules

- Open the artboard HTML file next to the running app at 1440px (desktop) or
  390px (phone) width. Every artboard is sized to its full content, so nothing
  below the fold is implied: what the artboard shows is the complete planned
  page, top to bottom. Compare layout, order, spacing, type sizes, chip styles,
  and wording. Differences must be either fixed or written down with a reason.
- The prototype uses hard-coded dark theme colors copied from
  `app/styles/tokens.css`. The implementation uses the tokens and must also render
  correctly in the light theme.
- Every control uses one of the six button roles in `app/styles/shell.css`. Chips
  use `.commandChip` / `.agentChip`. No new literal colors, radii, or font sizes.
  Add samples to `/design-system` and `DESIGN.md` for every new shared control
  (tab bar, page header, lane chart, file tree, file history panel, sidebar limits).
- Sample data in the prototype is placeholder. File names such as
  `SessionTabs.tsx` and `RequestLanes.tsx` are illustrative, not required names.
- Fonts: the prototype loads Inter and Geist Mono from Google Fonts for preview
  only. The app keeps its bundled fonts.

### Prototype-only elements that must not ship

| Element in prototype | Treatment in the app |
| --- | --- |
| Audience chips "Everyone", "Analyst", "Expert" (sitemap and Details tab context inventory) | Do not render. They mark intended audience for the plan only. |
| Dashed grey note boxes on the sitemap artboard | Do not render. |
| Muted hint text inside the tab bar ("Header stays on every tab · tabs load on open") | Do not render. |
| Subtitle "same chart as the session tab, scope fixed" on agent detail | Do not render. |
| Subtitle "click a lane name to focus it" on the Requests tab | Move into the existing dotted info popover on the Requests heading. |
| Minimap hint "Drag the window · arrow keys step · Home / End" | Do not render inline. Keep it as the minimap `aria-valuetext` and popover text. |
| Footer lines that explain a rule ("Edited by comes from…", "Peaks are matched…", "Estimates from the provider's…") | Keep the short honesty caveats that exist today ("File history covers recorded operations…", "Not a quality assessment", "Estimate, not a bill"). Move longer explanations into info popovers. |
| Placeholder counts in tab labels | Real counts from the domain responses; hide the count when a domain is not ready. |
| Sidebar limits at 70 and 90 percent | Use the METRICS.md thresholds (75 and 85 percent) and severity colors. |

## Agreed decisions

Sitemap and navigation:

- Four layers. L0 global navigation. L1 session overview. L2 session tabs. L3 agent detail.
- Global navigation order: Home, Sessions (live count badge), Repositories, Models & delegation, then Usage limits, Settings.
- Rename the `/agents` page to "Models & delegation". Its unit of analysis is a run aggregated by model, role, and work kind across sessions. Route may stay `/agents`; the label changes.
- Remove the `/dashboards` page. It is a four-row link table duplicating navigation. Redirect `/dashboards` to `/` and fold its intent into Home pins.
- Repositories page gains a Files tab beside Overview, Git, Plugin, Context inventory, Reporting.

App bar and page header (artboard `HeaderStandard`):

- The app bar never changes shape by route: brand, spacer, search trigger, monitor dot, alerts, profile. Search trigger is 280px on desktop, 200px on tablet, icon only on phone. It opens a Ctrl K palette. The app bar never contains a breadcrumb.
- The palette is a new overlay component. Today the "palette" is a single search input with a Ctrl K focus shortcut (`CommandCenterShell.tsx`). The overlay keeps the current regex routing to the destinations (minus Dashboards) and adds recent sessions and repositories as results.
- One page header component on every page: breadcrumb eyebrow (absent on Home and Settings), title, optional meta line, actions slot on the right bottom-aligned with the last line of the title block, optional tab bar below. Sessions list puts its filter segment in the actions slot. Session detail breadcrumb ends at the project; the title is the session title.
- Sidebar bottom holds a limits widget: one line per provider with sessions in the last seven days, showing that provider's tightest window percentage and window label, and a link to the Usage limits page. Fill colors follow the existing usage-limit rule in `docs/METRICS.md` ("Usage-limit colors"): normal from 0 through 74 percent, warning from 75 through 84, critical from 85 through 100. The prototype's 70 and 90 percent thresholds are superseded; every usage-limit surface keeps one rule. It is shell chrome, never session data, and never renders inside historical session state. Cursor appears the same way once its adapter reports windows.

Session page (artboards `Main`, `SessionAgents`, `ActivityTab`, `RequestsTab`, `RequestsFromActivity`, `RepositoryTab`, `ResourcesTab`, `DetailsTab`, `Mobile`; Settings › Storage on `SettingsStorage`):

- Persistent session header on every tab: breadcrumb (Sessions › project), title, one meta line, and the five KPIs (agents observed, all-agent context, wall time, tool calls, agent estimate). The meta line holds, in order: provider chip, session state chip (Live · In progress, Finished, Needs input; green tone on text and dot only), shortened session id (first and last segment, full value on hover), branch chip with the git icon, and the start time. The actions slot bottom-aligns with the last line of the title block: the meta line here, the title on pages without one such as the Sessions list. It holds actions only. Download report is a quiet action, as DESIGN.md already specifies. The project name appears once, in the breadcrumb; wall time appears once, in the KPI; approval mode and the full session id live on the Details tab. There is no live state card and no collapsed header variant. The header is identical on every tab.
- Tab bar sits directly under the KPIs. Tabs in order: Overview, Agents, Activity, Repository, Signals, Resources, Details. Resources is hidden only when a session has neither live samples nor stored resource rows. Tab is a URL query (`?tab=`) and deep links accept `agent`, `request`, and `path` parameters.
- Decision 2026-09-14 (supersedes the separate Activity and Requests & cache tabs below): a request and its tool calls are one object, so they live on one tab. **Activity** = the lane chart as scrubber plus a feed grouped by request (request line with request-local counts, tool calls nested under it). **Signals** = every rule-generated view (efficiency signals, cache evidence, flow score, cache lifetime per agent, agent-reported MCP signals), labeled once as deterministic and not a quality assessment. Links go one way, Signals to Activity with the request selected. The "Activity tab" and "Requests & cache tab" bullets below are kept for their component-level rules until the leftover pass rewrites them; where they conflict with this bullet, this bullet wins.
- Overview tab content: Right now (one row per active agent: name, role and model, latest action, latest context, age), Efficiency signals (top two, with "Show in agent"), Repository one-liner (branch, comparison chip, local change count, link to the Repository tab), request strip (last 48 requests, fresh tokens, agent track under the bars with a legend, link to Requests & cache), Progress (plan tasks and agent estimate), Work by kind (session counts), Cost (estimate label). Nothing session-specific sits above the tab bar except the header.
- Agents tab: filter, List/Tree/Grid segment, All/Active/Finished segment, one row per agent with status dot, name, role · model · effort, latest action, latest context, wall time, calls, status chip, chevron. Subagent rows indent under their parent. A selected-agent strip shows cache lifetime, compactions, shell tasks, signals, and two secondary actions: "Model across sessions" and "Open agent detail". Cache badges, lineage, signals, and shell tasks move to agent detail. The same row component serves the Live agents tab on Models & delegation.
- Activity tab: the session-wide feed and the session-wide Work by kind. Left, the same paged feed component as agent detail with an added Agent column and an agent filter select; there is no All / Shell / Reading segment, Work by kind is the filter; rows are the targets: clicking a row opens its request in Requests & cache and the agent cell opens agent detail, with no per-cell text links so the brand color stays off the table; targets show file names only. Right, Work by kind for the whole session with count and median; each row is a toggle (`aria-pressed`) that filters the feed to that kind and takes the raised surface, one kind at a time, combined with the agent filter, cleared by clicking again or by the quiet "Show all" in the feed header; plus a "By agent" secondary action that opens the Agents tab, then a Shell tasks panel with running and recent tasks (Bash description, lifecycle, exit code, duration only). Overview keeps compact Work by kind counts as the teaser; Lineage stays on agent detail. No new endpoint: `session-history?kind=activity` already pages and scopes.
- Requests & cache tab: agent lanes. One lane per agent sharing the same request order; each request appears in exactly one lane; window, minimap, and keyboard stepping stay one control. Each lane uses its own scale with its maximum printed at the top right of the lane. Primary lane taller, subagent lanes equal height. Lane label: agent name and role · model, no colored dot. Compaction markers stay in their lane. Beyond eight lanes, collapse to one lane per workflow group, expand on click. Clicking a lane name focuses that lane (full height, others dimmed). Controls: Fresh tokens / Full breakdown and Lanes / Single chart. Single chart is today's view plus the agent track strip. No Prev/Next buttons; selection is by clicking bars or arrow keys. Minimap is neutral grey. Request detail shows the four token counts and the tallies reworded as "Fed by" and "Called" with the adjacency caveat in the info popover; hide the row when both tallies are empty. Largest requests list keeps a small agent label per row.
- Live window rule: while live, the chart keeps advancing even with a selection. A selected bar drifts left as new requests arrive, stops at the left edge of the window, and stays selected there; the request detail keeps showing it. The minimap window stays where it is while its right side keeps growing. Dragging the window right hands the selection to the nearest bar at the left edge of the viewport, as today. There is no pin that freezes the chart.
- Repository tab: one bar with branch, comparison chip ("2 ahead of origin/main"), PR chip, and a muted second line (commits in session, PR size, remote check age, git task counts), plus a link to the repository Git tab. Below it, the shared file tree scoped to files this session touched (status chip and name only, no agent or edit counts), a "Changed elsewhere" group for uncommitted files the session did not touch, a search box, and the segment Touched here / Uncommitted / Changed elsewhere. The right pane is the shared file history panel with the current session highlighted. Commit lists leave the session page.
- Resources tab: three sparkline cards (CPU, memory, disk I/O) with current value and window peak, window segment 5 min / 30 min / Session, and a peaks table matched to activity by time with the caveat that it is coincidence, not causation. Live sessions render the cards and the peaks table; historical sessions render only the recorded peaks table. The tab is hidden only when neither live samples nor recorded peaks exist. The process table drawn in the artboard (kind and Bash description, CPU, memory, I/O, since) has no data source today: the resource feed is machine-aggregate only (`ResourceUsage` in `shared/monitor-contract.ts`). It is deferred to a follow-up that adds a monitor-private per-task sampler; it does not ship in this plan.
- Details tab: Session facts (provider, session id, project, started, approval mode, plugin and policy as observed at session start) with the one-shot Copy transcript path button; Flow score with its two inputs and the "not a quality assessment" caveat; Cost estimate; Context inventory inline (loaded, deferred, reserved, category table with kind, groups, repository inventory revision link). Usage limits are no longer on this tab.
- Phone: app bar with menu, brand, search icon, alerts. Page header, three KPIs (agents, context, calls), sticky tab bar with five tabs that fit 390px without scrolling: Overview, Agents, Activity, Repo, More. More holds Requests, Resources, Details. Overview content stays under two screens. Hit targets at least 44px.

Agent detail (artboard `AgentDetail`), route `/sessions/:sessionId/agents/:agentId`:

- Breadcrumb: session title › Agents › agent name. Header: agent name, status chip, role and model chips, parent link, start time, wall time. Actions: "<model> across sessions" (Models & delegation filtered to that model) and Copy transcript path.
- KPIs: latest context (with compaction count), tool calls, wall time, cache lifetime, signals.
- Request chart in single-chart mode scoped to this agent: own scale, minimap, one-line request detail with the four counts and Fed by / Called.
- Below: Activity for this agent only (paged) on the left; Work by kind as the kind filter, and Lineage, on the right.
- The Models & delegation evidence panel links to this route with the agent id. Insights "Show in agent" links here too.

File history (artboards `RepositoryTab`, `RepoFiles`):

- One record type: file change with repository id, file identity, session id, normalized agent id, kind (created, edited, deleted, moved), observed time, request number.
- Two groupings of the same records. Repository Files tab groups by file: tree with per-file distinct session counts rolled up to folders, search, "With session history only" and "Include historical files" toggles, file history panel on the right. Session Repository tab groups by session as described above.
- File history panel: breadcrumb path, file name, working-tree status chip when the file is currently modified, "N recorded sessions · newest first", provider segment (All providers / Claude Code / Codex), one entry per session with kind chip (Edited, Created), edit count, session title link, provider chip, agent names, time. Header action differs by side: "Copy path" on the repository side, "All history on repository page" on the session side. Footer caveat: recorded Write and Edit operations only; shell scripts and external edits may be missing.
- Moves keep file identity. History for the new path shows older sessions with the old path noted per entry. Untracked moves outside both detection sources stay as delete plus create.
- Deep links: `/repositories/:id?tab=files&path=…` and `/sessions/:id?tab=repository&path=…`.

Transport and caching:

- One `EventSource` per browser tab, module singleton with reference counting.
- Domain responses with independent revisions, 204 on unchanged revision, ETag equals revision, gzip.
- SSE is the primary trigger; fallback poll 30s while connected, 5s while reconnecting, 30s when hidden. No fixed 2s or 3s timers. Historical sessions fetch each domain once.
- Live chart: at latest, a history event triggers one page fetch; scrolled back, only the event's total updates the minimap.
- Browser store keyed by session, domain, params; bounded to the current session plus two recent ones.
- Monitor derivation split per domain; derived caches for sessions idle for ten minutes drop to checkpoint and rebuild on demand.
- File-change index in `node:sqlite`, monitor-owned, rebuildable from checkpoints plus git.
- Development request log stays available for debugging behind an environment flag; the default output omits 204 responses.

Visual tone:

- Outline chips only; tone in text (amber MOD, green NEW, green Active); no tinted chip fills. This changes the base chip: `.commandChip` and `.agentChip` currently carry a border plus the panel-2 fill, enforced by `tests/ui/pomegr-design-contract.test.tsx`. T03 removes the base fill, updates the test, and fixes the DESIGN.md sentence that already contradicts the CSS ("Evidence chips stay flat fills with no border").
- Agent tints color by role family, never by agent identity. `Agent.role` is the bounded browser-safe enum, so the palette is fixed: primary (orchestrator) carries no tint and uses the neutral track grey; reading (explore, researcher) blue; planning (plan) teal; writing (builder, tester) ochre, kept away from warning amber; reviewing (reviewer) rose, kept away from error red; generic (general-purpose, workflow-worker, fork) grey; system (compaction, unknown, custom) lighter grey. Five tints plus neutral, muted, same oklch chroma and lightness with only the hue varying. Tints appear only in the overview agent track and its legend; lanes, minimap, trees, and lists use no role colors. The legend lists role families present in the session with counts ("explore ×3"); same-role agents share one tint, and hovering or clicking a bar names the agent. Role tint never appears as a dot beside an agent name: the status dot stays status (green active, grey idle, amber needs input, purple finished).
- Selected rows use the raised surface only. No inset brand bars.
- Progress and limit bars are grey unless warning.
- Brand color appears only on the primary action, the active tab underline, text links, and the sidebar active item background as today.

## Findings that motivated the plan

Measured on 2026-09-13 with one live session tab, sixty seconds, steady state:

| Endpoint | Requests per 60s |
| --- | --- |
| `/api/state` | 30 |
| `/api/session-history?kind=activity` | 20 |
| `/api/session-history?kind=requests` | 20 |
| `/api/sessions` | 12 |
| `/api/usage-limits`, `/api/provider-status` | 3 |
| `/api/events` SSE | 2 open streams |

Causes: fixed-interval polling continues although SSE exists (`app/components/dashboard/useActivityHistory.ts`, `app/components/AppShell.tsx`); two separate `EventSource` connections (`AppShell.tsx` and `app/history-publications.ts`); activity keeps polling every 10s on historical sessions; `/api/state` serializes every section on every 2s poll regardless of what is on screen; vinext logs one line per request.

Structure: `app/Dashboard.tsx` stacks twelve panels with disclosures and no tabs. Agent status, context, and cache lifetime render in four places; cache badges in three; workflow progress twice. The session page never links to an agent page; `AgentEvidencePanel.tsx` links to a session but drops the agent id although `(sessionId, agentId)` exists on every `AgentsRun`. Insights link to an agent, never to the cache event or compaction they trace to. Usage limits is a dead end although `HomeSnapshot.limitActivities` exists in the contract and no component renders it (not addressed by this plan; T12 records it as a follow-up). `docs/METRICS.md` and `docs/SIGNAL_DICTIONARY.md` have no audience tiers; the tiers must be invented in the UI, not surfaced from metadata.

## Tasks

Each task lists its owner area from `docs/AGENT-WORKFLOW.md`, the artboards it must match, the verification commands, and the privacy checks. Run `npm run verify:fast` before handing off any task and `npm test` for rendering, metric, parser, or structure changes. Record a checkpoint under the task when done.

Execution order and dependencies:

1. T00 (privacy decisions) before T07 and T08.
2. T02 before T01. Revision-gated history fetches need the 204 path that T02 adds; T01 without T02 saves nothing.
3. T03 before T04 (page header, tab bar). T04 before T04b, T05, T06, T08, T09, T10 (tab shell).
4. T07 before T08, T09, and T13.
5. T11 any time. T12 last.

Common rules for every task:

- `scripts/check-architecture.mjs` caps new source files at 800 lines. Split the lane chart, file tree, file history panel, and page header into files under that cap from the start.
- `npm run check:boundaries` rejects orphan modules. Delete a replaced component and its test in the same change; never leave it unreferenced.
- New routes must be added to `APP_PATHS` or the path regex in `desktop/lan-gateway.mjs`, or the paired LAN browser cannot open them.

### T00 Privacy decisions for file history and repository persistence

Owner: `AGENTS.md`, `docs/OBSERVATION_CACHE.md`, `docs/METRICS.md`. Artboards: none. No code.

Today no Write or Edit target path reaches the browser or a checkpoint. Providers keep only basenames for activity detail and truncated SHA-256 scope digests for overlap detection (`monitor/providers/claude.mjs`, `monitor/providers/codex-activity-events.mjs`), and the Activity feed drops the mutation field before serialization. The only repository-relative paths shown today come from `git status`, not from tool calls. T07 and T08 need a new invariant, written before any code:

- Add to `AGENTS.md`: file-change records may expose only a repository-relative path bound to a recognized repository root, the normalized session and agent IDs, a fixed kind, an observation timestamp, and a request number. Targets outside the repository root, inside provider configuration folders, or that fail the same identifier validation used for custom agent types are dropped at commit time. Never expose absolute paths, command text, tool arguments, or transcript paths.
- Add to `docs/OBSERVATION_CACHE.md`: checkpoints may additionally persist repository-relative file-change records under the same rule; the file-history index is rebuildable from them plus Git.
- Add to `docs/OBSERVATION_CACHE.md`: for historical sessions, checkpoints may persist the recorded uncommitted file list, comparison (ahead, behind, branch, kind), and pull-request state at last check, so the Repository tab can render recorded state instead of an empty panel. Today only the branch survives (`monitor/server.mjs`, `recordedGitState`).
- Add serialization tests that reject absolute paths, drive letters, `..` segments, and provider folder prefixes in every browser-facing domain response.

### T01 Single shared event stream and SSE-primary cadence

Owner: browser/API state (`app/`). Artboards: none.

Depends on T02 (204 path for session-history, domain events).

- Create one `EventSource` module (`app/live-events.ts` or extend `app/history-publications.ts`) with reference counting; `AppShell.tsx` and the history hooks subscribe to it. Delete the second connection.
- Replace every fixed timer with revision-gated fetches triggered by events plus the fallback cadence (30s connected, 5s reconnecting, 30s hidden). Timers to remove: catalog poll 5s ready and 1s loading in `AppShell.tsx`; activity 3s live and 10s historical in `useActivityHistory.ts`; the 3s stay-at-latest timer in `useSessionRequestSelection.ts`; the 5s preloader in `useRequestPageCache.ts` (keep the preloader, drive it by readiness instead of a timer). Loading states may keep a 1s poll until the domain reports ready.
- Historical sessions: fetch each domain once after its readiness is ready; while a domain reports hydrating, retry on its events only. No timers.
- Update the "Frontend API cadence" table in `docs/OBSERVATION_CACHE.md`.
- Verify: `npx vitest run tests/ui/` suites touching Activity and Requests; a manual sixty-second count with one live tab must be under fifteen requests on a quiet session.

### T02 Per-domain session responses with independent revisions

Owner: monitor indexing and projection (`monitor/`), serving handlers, `shared/`.

- Split session projection into domains: `session-summary`, `agents`, `agent` (by id), `cache-events`, `repository`, `resources`, `details`. Activity and requests stay on `session-history`; `scope=<agentId>` is already accepted. Add a bounded `workKind=<WorkKind>` filter for `kind=activity` (one recognized value, rejected otherwise) so the Activity tab and agent detail filter server-side without fetching every page.
- Each domain owns a revision counter and readiness; `writeCommitted` serves 204 on matching revision. `/api/session-history` today always answers 200 with an in-body revision string and never uses `writeCommitted`; add the 204 path there too.
- Set ETag to the revision. Compression is new work: vinext compresses only static build assets, and `proxyMonitorJson` buffers the body and copies one header. Implement gzip in the monitor (honor `Accept-Encoding`, `Vary: Accept-Encoding`) and let the proxy pass `Content-Encoding` through, or compress in the proxy. `desktop/lan-gateway.mjs` already forwards `etag`, `if-none-match`, and `content-encoding`.
- SSE events carry domain, session id, revision, and for history the total count. Today `/api/events` emits only `catalog`, `repositories`, and `history` with `{domain, revision}` and no session id.
- Keep `/api/state` as a composed view of the domains until T10 removes its last consumer (T08, T09, and T10 still read it), then delete it in T12.
- Privacy: each domain response is checked by the existing serialization tests for prompts, responses, credentials, paths. Add a test per domain.
- Update `docs/OBSERVATION_CACHE.md` (phases D and S, revision semantics, readiness per domain) and `docs/ARCHITECTURE.md`.

### T03 App bar, palette, page header, sidebar limits

Owner: UI (`app/components/command-center/`, `app/styles/shell.css`, `DESIGN.md`). Artboard: `HeaderStandard.html`; app bar and sidebar also visible on every desktop artboard.

- App bar: remove the breadcrumb and the `hasBreadcrumb` grid variants from `CommandCenterShell.tsx` and `shell.css`. Search becomes a fixed-width trigger that opens the palette; phone shows an icon.
- Palette: reuse the current regex routing; add recent sessions and repositories from the catalog store. Keyboard: Ctrl K opens, Esc closes, arrows move, Enter navigates.
- Page header component with breadcrumb eyebrow, title, meta line, actions slot, optional tabs. Adopt it on Home, Sessions, session detail, Repositories index and detail, Models & delegation, Usage limits, Settings.
- Sidebar limits widget from the existing usage-limits store: one line per provider with sessions in the last seven days (computed from `SessionSummary.provider` and `createdAt` in the catalog context), tightest window only, colors from the METRICS.md usage-limit rule (75 and 85 percent). Never rendered as part of session state; historical views unaffected.
- Rename the Agents navigation label to "Models & delegation". Remove the Dashboards page and its navigation entry; redirect `/dashboards`. Also remove: the `/dashboards` entry in `APP_PATHS` in `desktop/lan-gateway.mjs`, the Home pin in `app/HomeDashboard.tsx`, the palette regex row, the `DashboardsView` component in `CommandViews.tsx`, and `tests/ui/dashboards-view.test.tsx`.
- Chip base change: remove the panel-2 fill from `.commandChip` and `.agentChip`, keep the border, keep tone on text and dot only. Update the chip assertions in `tests/ui/pomegr-design-contract.test.tsx` and correct the DESIGN.md chip sentence.
- Add page header, tab bar, and sidebar limits samples to `/design-system`; update `DESIGN.md` and `tests/ui/pomegr-design-contract.test.tsx`.
- Compare against `HeaderStandard.html` at 1440, 900, and 390 widths.

### T04 Session header, tab bar, Overview tab

Owner: UI (`app/Dashboard.tsx`, `app/components/dashboard/`). Artboards: `Main.html`, `Mobile.html`.

- Persistent header: hero and KPI strip as today, with the breadcrumb from the page header. Tab bar directly under the KPIs; tab in `?tab=`; unknown values fall back to Overview. Reuse the URL pattern from `app/components/repositories/repository-route.ts` and `RepositoryDetailView.tsx` (parser, `router.replace` with `scroll: false`, `role="tab"` keyboard handling). `app/sessions/[sessionId]/page.tsx` takes no `searchParams` today; thread `tab`, `agent`, `request`, and `path` through it.
- Role tint tokens: add the five family tints plus neutral to `app/styles/tokens.css` (light and dark, `--role-reading`, `--role-planning`, `--role-writing`, `--role-reviewing`, `--role-generic`, `--role-system`), map `AgentRole` to a family in one shared browser module, document the mapping in `DESIGN.md` as the only per-role color exception, and render the legend sample in `/design-system`. Same-role agents share a tint by design.
- Overview tab renders from `session-summary` only: Right now, Efficiency signals, Repository one-liner, request strip with agent track and legend, Progress, Work by kind, Cost.
- Remove from the page: stacked disclosures, `ResourceUsagePanel` default-open, `CacheEvidenceDisclosure`, `RepositoryDisclosurePanel`, `SessionDetailsPanel` (their content moves to tabs in later tasks). Until those tasks land, the tabs may render the existing panels behind the tab switch.
- Phone: three KPIs, sticky five-tab bar with More, overview in the order Right now, Signals, Repository, Requests strip, Progress, Work by kind, Cost (about 1380px tall at 390px width), 44px targets. Test at 390px that the tab bar has no horizontal scrollbar.
- Compare against `Main.html` and `Mobile.html`.

### T04b Activity tab

Owner: UI (`app/components/dashboard/`, existing activity feed and work-by-kind components). Artboard: `ActivityTab.html`.

Depends on T04.

- Mount the existing paged activity feed session-wide with the Agent column and agent filter; remove the All / Shell / Reading segment; Work by kind rows drive the `workKind` filter; reuse both on agent detail with the scope fixed (T05).
- Work by kind session-wide from the `session-summary` domain's work-kind aggregates (bounded counts and median durations only); Shell tasks from execution-task metadata.
- Row click opens `?tab=requests&request=<n>` (artboard `RequestsFromActivity.html`): the Requests tab scrolls its window so the request is in view rather than at latest, outlines and labels the bar, moves the minimap window back while the live edge keeps growing, and shows the request detail with the originating task under Fed by. A "From Activity" strip under the tab bar carries the task description and time, a quiet "Back to Activity" that restores the feed with its filter, and a "Jump to latest" quiet action on the axis. The agent cell opens the agent route.
- Compare against `ActivityTab.html`.

### T05 Agents tab and agent detail route

Owner: UI and agents analytics (`app/components/dashboard/agent-roster/`, `app/agents/`, `monitor/agents-analytics.mjs`). Artboards: `SessionAgents.html`, `AgentDetail.html`.

- Agents tab from the `agents` domain: row component with the columns in the artboard, List/Tree/Grid, All/Active/Finished, filter, indented subagents, selected-agent strip with two secondary actions.
- Reuse the row component in the Models & delegation Live agents tab.
- Agent detail route `/sessions/:sessionId/agents/:agentId` from the `agent` domain plus scoped history: header, KPIs, single-chart request view scoped to the agent (T06 provides the chart; until then mount today's chart with the scope fixed), Activity for this agent, Work by kind, Lineage.
- Allow the new route in `desktop/lan-gateway.mjs`: the path check accepts only `^/sessions/[^/]+$` today. Confirm `desktop/security-policy.mjs` does not need a matching change.
- Data gaps to fill in the `agents` and `agent` domains: `Agent` has no per-agent compaction count (derive from context-history boundaries by `agentId`) and no children array (build the tree from `parentId`). `Agent.model`, `effort`, `cacheLifetime`, `toolCalls`, `durationMs`, and `tokens.total` (the latest snapshot) already exist. The transcript-path endpoint already accepts `agentId`.
- `AgentEvidencePanel.tsx` links to the agent route with the agent id. Insights "Show in agent" links there. Session Agents tab "Open agent detail" links there.
- Remove duplicates: `AgentHistoryIndicators` renders only on agent detail; cache lifetime renders in the row and the detail only.
- Compare against both artboards.

### T06 Requests & cache tab with agent lanes

Owner: UI (`app/components/dashboard/requests-actions/`) and history serving. Artboard: `RequestsTab.html`.

- Lane chart: one lane per agent, shared request order and window, per-lane scale with the maximum label, primary lane taller, equal subagent lanes, compaction markers per lane, lane label without dot, click lane name to focus, collapse to workflow groups beyond eight lanes.
- Lanes / Single chart toggle; single chart is today's `RequestBarsChart` plus the agent track strip. Fresh tokens / Full breakdown as today.
- Remove Prev, Next, and the agent scope dropdown; keep keyboard stepping and bar clicks. The minimap stays neutral grey.
- Request detail: four counts, "Fed by" and "Called" tallies with the caveat moved to the info popover, row hidden when both are empty. Largest requests keeps agent labels.
- Cache evidence list under the request detail (as drawn), each entry labeled observed, inference, or attributed and linking to its request and agent.
- Live window rule from Agreed decisions, implemented in `useSessionRequestSelection.ts` and `RequestMinimap.tsx`: selection persists as it drifts to the left edge; minimap window holds while total grows; dragging right hands selection to the left-edge bar.
- Tests: window math with a growing total and a fixed selection; lane assignment covers every request exactly once; focus and collapse behavior; no provider ids in the DOM.
- Update `docs/METRICS.md` if any presentation rule changes; `docs/OBSERVATION_CACHE.md` for the history event total.
- Compare against `RequestsTab.html` and the chart on `AgentDetail.html`.

### T07 Monitor SQLite store: file-change index and resource history

Owner: monitor persistence (`monitor/`), `docs/OBSERVATION_CACHE.md`.

Depends on T00.

- Add one monitor-owned `node:sqlite` database under the Pomegr data root (`resolvePomegrDataRoot` in `shared/pomegr-paths.mjs`, `%APPDATA%\pomegr` on Windows), for example `monitor-store-v1/monitor.sqlite`. Not under `outputs/`, which holds development diagnostics only. It hosts the file-change index and the resource sample history. No timeseries database: the whole working set for an eight-hour session is under one megabyte and every query is "one session, one time range", which an index on (session id, timestamp) answers directly.
- File-change tables: `files` (id, repository id, current relative path, first seen, deleted at), `file_paths` (file id, path, valid from, valid to, source), `file_changes` (id, file id, session id, agent id, kind, observed at, request number).
- Resource tables, written on the checkpoint cadence from the in-memory sampler (raw samples stay in memory for the last 30 minutes only):
  - `resource_minutes` (session id, minute start, and for each of CPU cores, CPU machine percent, memory bytes, read bytes per second, write bytes per second: min, avg, max, and the exact sample timestamp of the max). One row per minute per session; a peak keeps its magnitude and its second-level time after downsampling.
  - `resource_peak_samples` (session id, peak id, timestamp, the five fields): raw samples for the two minutes before and after each of the top ten peaks per field. Bounded to ten peaks per field per session. Older peaks that fall out of the top ten lose their window.
  - `resource_peaks` (session id, field, timestamp, value, matched task ids, matched request number): the bounded peaks table itself, a few hundred bytes per session.
- Peak matching: a peak matches every execution task whose start-to-end interval contains the peak time, and the request active at that time. It is time overlap only. No per-task token attribution: the UI may show the request that followed and its request-local counts, labeled as adjacency.
- Retention, monitor-side, run after checkpoint writes and never in a GET:
  - Age: retention setting with fixed choices 30, 90, 180, 365 days, or keep all. Default 90 days. Past the age, drop `resource_minutes` and `resource_peak_samples` for that session. Keep `resource_peaks` and `file_changes` for as long as the session remains in the catalog.
  - Size: total database size cap, default 500 MB. When exceeded, prune the oldest sessions' `resource_minutes`, then their `resource_peak_samples`, then run incremental vacuum. Peaks and file changes are pruned only when the session leaves the catalog.
  - Settings read: desktop passes the two bounded values through the existing private desktop settings and a fixed-key IPC, like the provider folders; web development reads `POMEGR_RETENTION_DAYS` and `POMEGR_STORE_MAX_MB`. Browser and LAN requests can never change retention or trigger a prune.
  - Expose one bounded storage readiness for Settings: database size in bytes, oldest retained day, last prune time, and the effective choices. Never paths.
- Populate from recorded Write and Edit targets during commit (phase C to P), never during GETs. Providers currently keep only basenames and hashed scope digests for these targets; retain the repository-relative path in evidence under the T00 rule and persist it in checkpoints so the index is rebuildable. Learn moves from `git diff --name-status -M` at checkpoints and from shell tasks already classified by private command structure as `mv` or `git mv` with two repository-relative arguments. Ambiguous commands are ignored.
- Repository-relative paths only. Never absolute paths, command text, PIDs, or transcript paths. Add serialization tests.
- Rebuild on missing or corrupt index; serve "history rebuilding" readiness meanwhile.
- Confirm `node:sqlite` is available in the Electron runtime used by `desktop/`; if not, record the fallback decision here before proceeding. Verified on 2026-09-13: the module loads on the installed Node 24 with an `ExperimentalWarning`, and the `engines` floor of 22.13 is the first unflagged release. The monitor runs inside an Electron 43 `worker_threads` worker (`desktop/monitor-worker.mjs`), so the check must run there, not in the system Node. Silence or accept the experimental warning in development output.
- Document the store, bounds, and rebuild rule in `docs/OBSERVATION_CACHE.md`.

### T08 Repository tab and repository Files tab

Owner: UI (`app/components/repositories/`, `app/components/dashboard/`). Artboards: `RepositoryTab.html`, `RepoFiles.html`.

- Shared file tree component with scope variants: repository scope (session counts, rolled up to folders, toggles) and session scope (status chip and name only, Changed elsewhere group, three-way segment).
- Shared file history panel with the two header actions and the current-session highlight.
- Session Repository tab: top bar as in the artboard; commit lists removed from the session page; PR popover replaced by the chip and second line.
- Repository page Files tab beside the existing tabs; Git tab gains the commit lists that left the session page.
- Deep links with `path` on both sides.
- Historical sessions: recorded branch, recorded files, PR state at last check, never the current tree. This needs the T00 checkpoint additions: today `recordedGitState` in `monitor/server.mjs` keeps only the branch and returns empty files, null comparison, empty commits, and unavailable pull requests for historical sessions. Persist files, comparison, and pull-request state at the last live check and serve them from the `repository` domain.
- "Commits in session" is a new count. Today the repository section carries the last eight commits on HEAD regardless of session. Count commits whose committed time falls inside the session's wall-time window on the recorded branch, or drop the number from the second line.
- Compare against both artboards.

### T09 Resources tab

Owner: UI (`app/components/dashboard/ResourceUsagePanel.tsx` successor). Artboard: `ResourcesTab.html` (version 22 shows the peak zoom panel in place of the process table).

Depends on T07 (resource tables).

- Three sparkline cards with current and peak, window segment 5 min / 30 min / Session, peaks table matched to activity by time with the caveat. No process table (see Agreed decisions; deferred).
- Data sources by window: 5 min and 30 min read the in-memory raw samples through the `resources` domain; Session reads `resource_minutes` (max line with avg band). Clicking a peak in the table or on the chart zooms to its `resource_peak_samples` window at full resolution when one exists; otherwise the minute row is shown with "full-resolution window not retained".
- Peaks table row: field, time, value, matched execution tasks (work kind and Bash description, duration), and a link to the request active at that time with its request-local uncached-input count. Wording: "request after this task carried N uncached input tokens". Never "this task cost N tokens".
- Live sessions render cards and peaks; historical sessions render the Session window and the peaks table from the store. Both use the same components.
- Tab hidden only when there are neither live samples nor stored rows for the session.
- Retention effects are visible: a session past the retention age shows the peaks table and the note "resource curve not retained (retention: N days)" instead of the Session chart.
- Remove `observedPeak` from the in-memory state once the store serves peaks.
- Privacy: the `resources` domain exposes only session id, timestamps, the five numeric fields, bounded peak IDs, matched normalized task IDs, and request numbers. Add a serialization test.
- Compare against the artboard.

### T10 Details tab

Owner: UI (`SessionDetailsPanel.tsx`, `MachineryPanel.tsx` successors). Artboard: `DetailsTab.html`.

- Session facts, one-shot Copy transcript path (unchanged endpoint), Flow score with inputs, Cost estimate with the estimate label, Context inventory inline with the category table, groups link, and repository inventory revision link.
- No usage limits on this tab. No audience chip.
- Compare against the artboard.

### T11 Development request log

Owner: `scripts/dev.mjs`, `scripts/run-vinext.mjs`.

- The per-request lines come from vinext's development server (`node_modules/vinext/dist/server/request-log.js`), not from Pomegr scripts; both scripts spawn children with inherited stdio and log nothing per request. First check whether the installed vinext version exposes a request-log option. If not, `scripts/run-vinext.mjs` pipes the child's stdout, drops lines whose status is 204, and writes the rest through unchanged. Keep TTY color detection working by forwarding `FORCE_COLOR` when the parent is a TTY.
- `POMEGR_DEV_REQUEST_LOG=all` restores every line. Document the flag in `docs/CONFIGURATION.md` with the other development-only variables.

### T13 Storage retention setting

Owner: desktop lifecycle (`desktop/`), Settings UI (`app/settings/`), `docs/CONFIGURATION.md`. Artboard: `SettingsStorage.html`; it follows the existing Settings → Providers layout.

Depends on T07.

- Settings → Storage section: retention age as a segmented control with the fixed choices from T07, size cap as a select with fixed steps (250 MB, 500 MB, 1 GB, 2 GB), and the storage readiness line (size, oldest retained day, last prune). Read-only in a browser and over LAN; editable only in the desktop shell through a fixed-key IPC with enum values, confirmed natively like the provider-folder save.
- The monitor applies the change on the next prune cycle. Never prune synchronously in the IPC handler and never delete peaks or file changes for sessions still in the catalog.
- Document the two development environment variables and the defaults in `docs/CONFIGURATION.md`; document the bounded IPC in `docs/OBSERVATION_CACHE.md` next to the provider-folder settings.
- Add the Storage section sample to `/design-system` only if it introduces a new shared control; the segmented control and select already exist.
- Compare against `SettingsStorage.html`.

### T12 Closure

- Move enduring rules into `DESIGN.md` (page header, tab bar, lanes, file tree, file history panel, sidebar limits, role tint families, quiet tone rules), `docs/OBSERVATION_CACHE.md` (domains, cadence, file-change index), and `docs/METRICS.md` (Fed by / Called wording, lane presentation, role-family coloring of the agent track as a presentation rule, not a measurement).
- Delete `/api/state` and its proxy once T10 has landed; update `docs/ARCHITECTURE.md` and `AGENTS.md` (Architecture section lists the route).
- Record the final sixty-second request count and the before/after screenshot pairs in the last checkpoint.
- Record follow-ups that leave this plan: the Resources process table with a monitor-private per-task sampler, and a consumer for `HomeSnapshot.limitActivities` or its removal from the contract.
- Move the SQLite store schema, retention tiers, and storage readiness into `docs/OBSERVATION_CACHE.md`, and the peak-matching rule (time overlap, adjacency wording) into `docs/METRICS.md`.
- Delete this plan and the prototype folder in the same change.

## Open questions before implementation

- **Resolved 2026-09-14: Activity row to Requests deep link.** The ping-pong existed because two tabs answered one question. Requests and tool calls merge into the Activity tab (chart as scrubber, feed grouped by request); cache evidence, efficiency signals, flow score, cache lifetime per agent, and agent-reported signals move to a new Signals tab. Artboards 12 (Activity) and 5 (Signals) on the canvas are the reference; artboard 13 was deleted. Leftover pass: rewrite the Activity, Requests & cache, and Details bullets under Agreed decisions; merge T04b and T06 into one Activity task and add a Signals task; T02 pages the feed by request range (`kind=activity&from=<n>&to=<n>`, tool calls nested under their request number) instead of by event page; regenerate `ia-redesign/prototype/` exports and README (RequestsTab.html and RequestsFromActivity.html are stale); `docs/METRICS.md` gains the Signals tab caveat wording; Fed by / Called tallies and their adjacency caveat are dropped.
- Requests tab lists still draw per-agent colored dots from the earlier identity scheme; the plan says lists carry no agent colors. Strip them or amend the rule.
- Undrawn states, ranked by implementer risk: historical session (finished chip, recorded peaks, recorded repository state), Agents tab Tree and Grid, lanes collapsed beyond eight and a focused lane, single chart mode, palette overlay, phone More sheet, Models & delegation Live agents tab, Repository Git tab with commit lists, Home pins, Sessions list header, light theme.

## Continuation checkpoint

- 2026-09-14 · Open question 1 resolved (see above). Canvas at version 38, prototype exports regenerated to match (artboards 4, 5-old and 13 deleted; `SignalsTab.html` added). Decisions this session, all drawn on the canvas and not yet folded into the task list: (1) **Activities** tab (plural) = Requests lane chart as scrubber with the agent filter in its header applying to everything on the tab, Largest requests as a strip under the minimap, then one **Activity feed** panel: left rail with Actions by kind (icons, count, share, median, click filters), Shell tasks and Failed shell runs, caveats; right, five requests around the selection with tool calls nested under each request, request-local counts on the request line, Previous / Next / Jump to latest. Fed by / Called tallies dropped. (2) **Signals** tab holds every rule-generated view: efficiency signals, cache evidence, flow score (removed from Details), cache lifetime by agent, agent-reported MCP signals; links go one way to Activities. Name chosen over "Audit". (3) **No agent detail route.** Agents tab keeps today's roster plus selected-agent pane (status bar, legend, role counts, filter, Group by workflow, Status and Model selects, Hide finished, Sort; pane with lineage, facts, skills, signals, "Activities for this agent", "<model> across sessions", Copy transcript path). Deep links use `?tab=agents&agent=<id>` and `?tab=activities&agent=<id>`; T05's `desktop/lan-gateway.mjs` path change is no longer needed. (4) Lane labels 220px with ellipsis and a title tooltip carrying full name and role · model. Leftover pass still owed: rewrite the Agreed decisions bullets for Activity, Requests & cache, Agents tab, Agent detail and Details; merge T04b and T06, rewrite T05, add a Signals task; T02 feed paged by request range; phone artboard still shows the old tab set (next session). No code changed, no tests run.
- 2026-09-13 · Plan validated against the codebase and refined; no implementation. Canvas at version 31 (https://claude.ai/code/artifact/eb54dd04-0c68-450d-8c04-ab4776816fd9), prototype exports regenerated to match. Decisions recorded in this document: T00 privacy pre-work, T02 before T01, SQLite monitor store with resource history and tiered retention, T13 Storage settings, T04b Activity tab with Work by kind as the filter, header identical on every tab with one meta line and a quiet Download report bottom-aligned to it, role-family tints, usage-limit thresholds from METRICS.md, full-height artboards. Verification: canvas check passed on every save; artboard heights measured in a browser; no repository tests run because no code changed. Next: resolve the open questions above, start T00. Append one dated entry per completed task with: task id, what shipped, verification commands run and their result, the artboard comparison outcome with any accepted deviations, and open follow-ups.
