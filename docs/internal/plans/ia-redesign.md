# Information architecture redesign

> Status: Session 3 in progress; part 1 of 7 (T06 selection core) is done and reviewed, while T06 presentation, docs and acceptance and T06b remain unfinished.
> Created: 2026-09-13.
> Audience and owner: Pomegr maintainers; each executing agent owns the task it selects.
> Lifetime: ephemeral. Delete this plan and `docs/internal/plans/ia-redesign/` in the change that completes the last task, after moving enduring rules into `DESIGN.md`, `docs/OBSERVATION_CACHE.md`, and `docs/METRICS.md`.
> Scope: web dashboard sitemap, session tabs and agent inspector, repository file history, app bar and page header, sidebar limits, correlated request chart and activity feed, transport and per-domain caching, resource history with retention and a storage usage bar.
> Authority: work plan only. `AGENTS.md`, `DESIGN.md`, and `docs/OBSERVATION_CACHE.md` remain authoritative and must be updated by the tasks that change behavior.
> Next task or decision: Continue Session 3 with part 2 (activities-desktop-feed), `/acos run runs/2026-09-16-ia-session-3 2`, from the Session 3 checkpoint.
> Completion criteria: T00 and every current implementation task (T01–T13, including T06b and excluding merged T04b) have a dated checkpoint, T12 has moved the enduring rules to their owners, and this plan and its prototype folder are deleted.
> Permanent destinations: `DESIGN.md` with `/design-system`, `docs/OBSERVATION_CACHE.md`, `docs/METRICS.md`, `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, and `AGENTS.md`.

## Outcome

Pomegr shows an overview first and depth on demand. A newcomer starts with the session
overview; an analyst opens a tab; an expert selects an agent or request within it.
Tabs and selections have URLs, load their own data, and subscribe only while
mounted (the persistent session header and shell keep their own subscriptions).
The visual tone stays calm: outline chips, muted tints and the scoped brand accents
listed under Visual tone.

The approved visual reference is the prototype in
[`ia-redesign/prototype/`](ia-redesign/prototype/README.md). Implementation must
match it at high fidelity, subject to the explicit written overrides below. Artboard names in this plan are shorthand; the prototype README links the current
`<name>-html/<name>.dc.html` exports. Each UI task ends with a side-by-side comparison of the
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
| Subtitle "click a lane name to focus it" on Activities | Move into the dotted info popover on the Requests chart heading. |
| Minimap hint "Drag the window · arrow keys step · Home / End" | Do not render inline. Keep it as the minimap `aria-valuetext` and popover text. |
| Footer lines that explain a rule ("Edited by comes from…", "Peaks are matched…", "Estimates from the provider's…") | Keep the short honesty caveats that exist today ("File history covers recorded operations…", "Not a quality assessment", "Estimate, not a bill"). Move longer explanations into info popovers. |
| Placeholder counts in tab labels | Real counts from the domain responses; hide the count when a domain is not ready. |
| Sidebar limits at 70 and 90 percent | Use the METRICS.md thresholds (75 and 85 percent) and severity colors. |

## Agreed decisions

Sitemap and navigation:

- Three route layers: global navigation, session overview, and session tabs. Agent depth uses the Agents tab inspector; request depth uses Activities. Both selections are deep-linkable within the session route; there is no separate agent detail route.
- Global navigation order: Home, Sessions (live count badge), Repositories, Models & delegation, then Usage limits, Settings.
- Rename the `/agents` page to "Models & delegation". Its unit of analysis is a run aggregated by model, role, and work kind across sessions. Route may stay `/agents`; the label changes.
- Remove the `/dashboards` page. It is a four-row link table duplicating navigation. Redirect `/dashboards` to `/` and fold its intent into Home pins.
- Repositories page gains a Files tab beside Overview, Git, Plugin, Context inventory, Reporting.

App bar and page header (artboard `HeaderStandard`):

- The app bar never changes shape by route: brand, spacer, search trigger, monitor dot, alerts, profile. Search trigger is 280px on desktop, 200px on tablet, icon only on phone. It opens a Ctrl K palette. The app bar never contains a breadcrumb.
- The palette is a new overlay component. Today the "palette" is a single search input with a Ctrl K focus shortcut (`CommandCenterShell.tsx`). The overlay keeps the current regex routing to the destinations (minus Dashboards) and adds recent sessions and repositories as results.
- One page header component on every page: breadcrumb eyebrow (absent on Home and Settings), title, optional meta line, actions slot on the right bottom-aligned with the last line of the title block, optional tab bar below. Sessions list puts its filter segment in the actions slot. Session detail breadcrumb ends at the project; the title is the session title.
- Sidebar bottom holds a limits widget: one line per provider with sessions in the last seven days, showing that provider's tightest window percentage and window label, and a link to the Usage limits page. Fill colors follow the existing usage-limit rule in `docs/METRICS.md` ("Usage-limit colors"): normal from 0 through 74 percent, warning from 75 through 84, critical from 85 through 100. The prototype's 70 and 90 percent thresholds are superseded; every usage-limit surface keeps one rule. It is shell chrome, never session data, and never renders inside historical session state. Cursor appears the same way once its adapter reports windows.

Session page (artboards `Main`, `SessionAgents`, `ActivityTab`, `SignalsTab`, `RepositoryTab`, `ResourcesTab`, `DetailsTab`, `Mobile`; Settings › Storage on `SettingsStorage`):

- Persistent session header on every tab: breadcrumb (Sessions › project), title, one meta line, and the five KPIs (agents observed, all-agent context, wall time, tool calls, agent estimate). The meta line holds, in order: provider chip, session state chip (Live · In progress, Finished, Needs input; green tone on text and dot only), shortened session id (first and last segment, full value on hover), branch chip with the git icon, and the start time. The actions slot bottom-aligns with the last line of the title block: the meta line here, the title on pages without one such as the Sessions list. It holds actions only. Download report is a quiet action, as DESIGN.md already specifies. The project name appears once, in the breadcrumb; wall time appears once, in the KPI; approval mode and the full session id live on the Details tab. There is no live state card and no collapsed header variant. The header is identical on every tab.
- Tab bar sits directly under the KPIs. Tabs in order: Overview, Agents, Activities, Repository, Signals, Resources, Details. URL values are `overview`, `agents`, `activities`, `repository`, `signals`, `resources`, `details`; unknown values fall back to Overview. Resources is hidden only when a session has neither live samples nor stored resource rows, including peaks. Deep links accept `agent`, `request`, and `path` parameters.
- Overview tab content: Right now (one row per active agent: name, role and model, latest action, latest context, age), top two efficiency signals with "Show in agent" or an evidence link to Activities, Repository one-liner, last-48-request strip with fresh tokens and role-family track/legend linking to Activities, Progress (agent-maintained plan and agent estimate), Work by kind counts, and Cost estimate.
- Agents tab keeps today's roster and selected-agent inspector: status bar, legend, role counts, filter, Group by workflow, Status and Model selects, Hide finished, Sort, and desktop List/Tree/Grid. The inspector retains lineage, facts, skills, cache lifetime, compactions, shell tasks and signals, plus "Activities for this agent", "<model> across sessions", and one-shot Copy transcript path. Models & delegation uses the shared row where applicable and links to the inspector by agent id.
- Activities tab combines a Requests chart as scrubber and one Activity feed grouped by request. The agent filter in the chart header applies to the whole tab. Largest requests is a strip under the minimap. The feed's left rail contains Actions by kind (icon, count, share, median; one pressed toggle filters nested calls), Shell tasks, Failed shell runs, and caveats. The right side shows five requests around selection with request-local counts and nested tool calls, then Previous / Next / Jump to latest. Targets show basenames only. Agent navigation opens the Agents inspector. There is no separate Requests tab and no Fed by / Called row.
- Desktop chart: one lane per agent sharing request order, viewport, minimap and keyboard stepping. Every request occurs once, with compactions in its own lane. Per-lane scales print maxima; the primary lane is taller. Labels are 220px, ellipsized, with the full name and role/model in a title tooltip and accessible name, and no role-colored dots. More than eight lanes collapse by workflow group; click expands a group or focuses a lane. Controls are Fresh tokens / Full breakdown and Lanes / Single chart; single chart includes the role-family agent track. The minimap is neutral grey. Chart selection uses bars or arrow keys; Previous / Next belong to the feed. Request detail shows the four request-local counts.
- Signals tab holds efficiency signals, cache evidence, flow score with its two inputs, cache lifetime by agent, and agent-reported MCP signals. Introduce deterministic rules with "Not a quality assessment"; retain observed/inference/attributed qualifications on cache evidence and clearly distinguish agent-reported signals. Evidence links go to Activities with the corresponding agent/request selected; never invent a request association. Flow score leaves Details.
- Live selection and correlation: incoming requests extend history and the minimap. The chart may advance while the selected bar remains inside its viewport; when further advancement would push it out, anchor the viewport with that bar at its left edge. Do not clamp an old bar into a false request position. Request details and the Activities feed always follow the selected visible bar. Anchoring never pauses collection. Dragging away transfers selection to the nearest visible bar (the left-edge bar when dragging right); update chart, request details and feed together. Jump to latest reveals/selects the latest request. Filters, keyboard navigation and paging obey the same invariant; no detail survives without its bar. During a range fetch retain the previous correlated view until the new view is ready, or show a coordinated loading state.

- Repository tab: one bar with branch, comparison chip ("2 ahead of origin/main"), PR chip, and a muted second line (commits in session, PR size, remote check age, git task counts), plus a link to the repository Git tab. Below it, the shared file tree scoped to files this session touched (status chip and name only, no agent or edit counts), a "Changed elsewhere" group for uncommitted files the session did not touch, a search box, and the segment Touched here / Uncommitted / Changed elsewhere. The right pane is the shared file history panel with the current session highlighted. Commit lists leave the session page.
- Resources tab: CPU, memory and disk-I/O sparkline cards with current value and window peak, a 5 min / 30 min / Session window selector, and a peaks table with a time-overlap caveat. Live sessions use raw recent samples or Session minute aggregates. Historical sessions show retained Session curves and recorded peaks; if curves were pruned, show peaks and the retention explanation. Hide only when neither live samples nor stored rows exist. Peak selection zooms to its retained sample window when available. Machine-aggregate measurements do not imply per-task resource attribution. The process table is deferred to a separate monitor-private sampler.
- Details tab: Session facts (provider, session id, project, started, approval mode, session-observed plugin/policy), one-shot Copy transcript path, Cost estimate, and inline Context inventory with category table, groups and repository revision link. Flow score is on Signals; usage limits remain shell chrome.
- Phone: app bar with menu, brand, search and alerts; three KPIs (agents, context, calls); sticky tabs Overview, Agents, Activities, Repo, More fitting 390px without scrolling. More opens Signals, Resources and Details using the same query URLs. Agents shows List/Grid without Tree; a row opens the full-viewport inspector with Back and focus restoration. Direct subagents uses one 48px summary line; context uses regular-weight primary text.
- Phone Activities always uses single chart, with no lane toggle. Include role track/legend, compaction labels in a reserved band above bars, minimap and Largest strip. Put five request groups before Actions by kind and Shell tasks. Each request line (44px) shows agent, role, uncached input and time; tapping it opens request detail with the four request-local counts. Each call line is one thin 32px full-width row: kind icon, ellipsized target and wall duration only, with a faint trailing chevron; the kind word, status, exit code, background flag and call/result times are not printed inline. Tapping a call line expands it in place: a detail block opens directly beneath the line, indented to the line's text edge on the raised surface, with the chevron rotated down. Tapping still selects the call's request and chart bar exactly as before; the expansion is purely additive. The block holds kind/status/foreground chips, then Kind, Wall duration, Called, Result and Agent rows, and nothing else: no links, no caveat text, no role suffix. One call is open at a time; tapping the open line or another line collapses it, Escape collapses it, the feed keeps scrolling normally, no sheet, popover or scrim is used, and no URL parameter is added. The block keeps the selected request's left rule when it belongs to that request. Failed or running calls tint only the duration text (amber), never the row. The selected request has the approved brand-colored left rule, and its call lines carry the same rule. Use one short caveat ("tap a call for details") with a dotted "how to read this" popover and 44px Previous / Next / Jump to latest targets. Overview stays about two phone screens; buttons, tabs and request lines are at least 44px, and the 32px call line is the single documented dense-list exception because it is full-width and separated by 44px request lines.

Agent selection and deep links:

- Inspector: `/sessions/:sessionId?tab=agents&agent=<id>`.
- Scoped activity: `/sessions/:sessionId?tab=activities&agent=<id>`; append `request=<n>` for a specific request.
- Models & delegation evidence and "Show in agent" retain both session and agent identity. A request link selects the matching visible bar and feed group.
- No `/sessions/:sessionId/agents/:agentId` route or separate agent chart is added.

File history (artboards `RepositoryTab`, `RepoFiles`):

- One record type: file change with normalized repository identity, opaque file identity, safe relative path, kind (created, edited, deleted, moved), and observation time. Session, agent and request attribution require supporting recorded evidence under T00; Git-only move continuity must not invent them.
- Two groupings of the same records. Repository Files tab groups by file: tree with per-file distinct session counts rolled up to folders, search, "With session history only" and "Include historical files" toggles, file history panel on the right. Session Repository tab groups by session as described above.
- File history panel: breadcrumb path, file name, working-tree status chip when the file is currently modified, "N recorded sessions · newest first", provider segment (All providers / Claude Code / Codex), one entry per session with kind chip (Edited, Created), edit count, session title link, provider chip, agent names, time. Header action differs by side: "Copy path" on the repository side, "All history on repository page" on the session side. Footer caveat: recorded Write and Edit operations only; shell scripts and external edits may be missing.
- Moves keep file identity. History for the new path shows older sessions with the old path noted per entry. Untracked moves outside both detection sources stay as delete plus create.
- Deep links: `/repositories/:id?tab=files&path=…` and `/sessions/:id?tab=repository&path=…`.

Transport and caching:

- One `EventSource` per browser tab, module singleton with reference counting.
- Domain responses with independent revisions, 204 on unchanged revision, ETag equals revision, gzip.
- SSE is the primary trigger; fallback poll 30s while connected, 5s while reconnecting, 30s when hidden. No fixed 2s or 3s timers. Historical sessions load each mounted domain/query once ready; explicit range/filter navigation and reconnect recovery may fetch again, without periodic history polling.
- Live chart: while following the latest window, a history event triggers one page fetch. With the viewport anchored on an older selection, history totals extend the minimap without moving the viewport or selection; fetch committed visible-range revisions only when its existing evidence changes. A range navigation fetches the corresponding chart and feed together.
- Browser store keyed by session, domain, params; bounded to the current session plus two recent ones.
- Monitor derivation split per domain; derived caches for sessions idle for ten minutes drop to checkpoint and rebuild on demand.
- File-change index in `node:sqlite`, monitor-owned, rebuildable from checkpoints plus git.
- Development request log stays available for debugging behind an environment flag; the default output omits 204 responses.

Visual tone:

- Outline chips only; tone in text (amber MOD, green NEW, green Active); no tinted chip fills. This changes the base chip: `.commandChip` and `.agentChip` currently carry a border plus the panel-2 fill, enforced by `tests/ui/pomegr-design-contract.test.tsx`. T03 removes the base fill, updates the test, and fixes the DESIGN.md sentence that already contradicts the CSS ("Evidence chips stay flat fills with no border").
- Agent tints color by role family, never by agent identity. `Agent.role` is the bounded browser-safe enum, so the palette is fixed: primary (orchestrator) carries no tint and uses the neutral track grey; reading (explore, researcher) blue; planning (plan) teal; writing (builder, tester) ochre, kept away from warning amber; reviewing (reviewer) rose, kept away from error red; generic (general-purpose, workflow-worker, fork) grey; system (compaction, unknown, custom) lighter grey. Five tints plus neutral, muted, same oklch chroma and lightness with only the hue varying. Tints appear only in agent tracks and their legends (Overview and single-chart Activities); lanes, minimap, trees, and lists use no role colors. The legend lists role families present in the session with counts ("explore ×3"); same-role agents share one tint, and hovering or clicking a bar names the agent. Role tint never appears as a dot beside an agent name: the status dot stays status (green active, grey idle, amber needs input, purple finished).
- Selected rows use the raised surface. The phone Activities feed alone uses the approved brand-colored left rule for the selected request; document this scoped exception in DESIGN.md and its contract test during T06.
- Progress and limit bars are grey unless warning.
- Brand color appears on the primary action, active tab underline, text links, sidebar active item background, and the selected-request rule in the phone Activities feed.

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

## Session execution queue

These six completion checkboxes are the queue for fresh implementation sessions.
Read them in document order and take exactly the first unchecked session. T00 is
already documented; the detailed T-numbered tasks below remain the acceptance
specification. Do not skip an unfinished session or automatically begin the next
one after finishing the selected scope.

### Session 1 — Data foundation

- [x] Session 1 complete — T02 then T01; verification baseline restored.

Start by inspecting the current worktree and reproducing the existing prototype
vendor/support lint failures. Fix only the generated-artifact lint boundary as
appropriate to repository policy; do not disable application lint rules or
rewrite exported vendor code. Record the resulting verification baseline.

A Sol worker owns T02: domain contracts, committed projection/serving, bounded
request-range paging, independent revisions and events, with privacy tests.
Keep domains whose producers arrive in later sessions explicitly unavailable;
do not fabricate file/resource evidence to fill the new shapes. After the
contracts and events are integrated, a Terra worker owns T01: the shared event
stream, subscriptions and fallback/reconnect behavior. Use Sol for an independent
review of cache-only GETs, last-known-good retention and historical isolation.

Done when both tasks and their required checks pass, the quiet-session request
count meets T01's target, and the handoff identifies the final domain/query
contracts for the UI workers. Keep the composed `/api/state` compatibility view.

### Session 2 — Navigation and session shell

- [x] Session 2 complete — T03, T04 and T05.

A Terra worker owns T03's app bar, palette, page header, sidebar limits and shared
design controls. Integrate that contract before T04. A Sol worker then owns
T04's session shell, URL selection and Overview. Once the shell is stable, a
Terra worker owns T05's roster and inspector migration. Sol reviews navigation,
scope preservation, accessibility and historical data boundaries independently
of the workers that changed them.

Done when all three tasks pass their checks and desktop/phone artboard comparisons,
agent links open the inspector without a new agent route, and tabs awaiting later
sessions retain the explicitly permitted existing-panel transition. Record those
temporary panels so Session 6 can verify their removal.

### Session 3 — Activities and Signals

- [ ] Session 3 complete — T06 and T06b.

A Sol worker owns T06's shared selection state, lane chart and grouped feed
integration. Once its selection/range interface is fixed, that worker may delegate
a disjoint chart, feed or phone component to Terra with an explicit file boundary.
Keep ownership of the shared selection hook with one worker. A Terra worker owns
T06b after Activities navigation is integrated. A different Sol worker reviews
the complete correlation behavior and evidence semantics.

Done when the selected bar, details and feed remain correlated through appends,
anchoring, drag, paging, filtering, keyboard navigation and loading; Signals links
resolve correctly; and desktop/phone comparisons and required tests pass. Record
any shared controls or contracts that Session 5 must reuse.

### Session 4 — Persistence and storage

- [ ] Session 4 complete — T07 then T13.

A Sol worker first verifies SQLite in the actual Electron monitor worker, then
owns T07's persistence schemas, concrete bounds, validated evidence, rebuild and
retention behavior. After the committed storage status and settings interface are
fixed, a Terra worker owns T13's native settings integration and storage usage bar.
A different Sol worker reviews checkpoint privacy, attribution, native-only
writes, soft-threshold behavior and failure recovery.

Done when T07 and T13 pass their checks, protected history survives age/size
cleanup, true over-100% usage remains visible, browser/LAN settings are read-only,
and the handoff specifies the committed file/resource queries for Session 5.
Resolve any SQLite fallback before marking this session complete.

### Session 5 — Repository and Resources

- [ ] Session 5 complete — T08 and T09.

With Session 4's contracts integrated, two Terra workers may implement T08 and
T09 in parallel if their files are disjoint. The coordinator owns any shared
route/type integration; workers request interface changes rather than both
editing the same file. Sol independently reviews historical repository snapshots,
file-history attribution, retained resource curves/peaks and request-link wording.

Done when both tabs use committed domain data, unavailable/retained/pruned states
are honest, repository and session file deep links work, and the desktop/phone
checks and artboard comparisons pass. Preserve the distinction between temporal
resource overlap and task attribution.

### Session 6 — Remaining migration and closure

- [ ] Session 6 complete — T10, T11 and T12.

Terra owns T10 Details and Luna owns the bounded T11 development-log change;
these can run in parallel when files are disjoint. After integration, a Sol
reviewer audits the full migration, temporary panels, `/api/state` consumers,
domain/privacy contracts and cross-tab navigation. The coordinator owns T12,
final verification, the quiet-session request measurement and documentation
closure. Do not remove `/api/state` while any consumer remains.

Done when the entire plan meets its acceptance criteria, required checks pass,
enduring rules and deferred follow-ups have maintained owners, and T12 removes
this plan and its prototype folder. Record final completion and verification in
the task's final handoff before deletion; do not retain an archive copy merely
to keep this checkbox. There is no next queue item after closure.

## Orchestration and completion protocol

Use the same protocol in every fresh session. The session group is the unit of
completion; worker tasks are bounded pieces within it.

1. Read this queue, the selected session's detailed tasks, the latest checkpoint,
   applicable AGENTS.md instructions and the relevant authority documents. Inspect
   the actual worktree before choosing files; preserve unrelated work. Briefly
   state the selected scope and worker assignments, then execute the already
   approved orchestration without asking the user to approve it again.
2. Keep the coordinator responsible for dependency order, interface decisions,
   integration, independent review and final verification. Delegate focused
   implementation and investigation. Sol, Terra and Luna in this plan name work
   classes. Select the explicit model from the column for the harness running the
   session:

   | Work class | Use for | Codex | Claude Code |
   | --- | --- | --- | --- |
   | Sol | Coupled state/persistence work and substantive independent reviews | `gpt-5.6-sol` | `claude-opus-5` (`opus`) |
   | Terra | Bounded UI/transport work | `gpt-5.6-terra` | `claude-sonnet-5` (`sonnet`) |
   | Luna | Narrow probes or edits | `gpt-5.6-luna` | `claude-haiku-4-5` (`haiku`) |
   | Ceiling | Never used by workers or their descendants | Astra | Fable |

   Prefer the cheapest capable model. A Sol-class implementation may start on the
   Terra-class model and escalate to the Sol-class model after a failed check;
   independent reviews start at Sol class. If a selected model is unavailable,
   choose another allowed model; do not silently exceed the ceiling.
3. Use at most the available four concurrent agent slots, including the root
   coordinator. Normally run two workers and leave the remaining slot for review
   or one nested worker. Nested delegation consumes this same limit; it does not
   create a separate allowance. Delegate only independent bounded work, with one
   active owner per file or shared contract. Do not run separate queue sessions
   concurrently against the same checkout.
4. Give workers a fresh, focused brief: task ID, objective, owned files, fixed
   interfaces, relevant plan/contract references, required checks and completion
   criteria. Avoid copying this conversation or the entire repository into every
   brief. Nested workers inherit the same model, ownership and reporting rules.
   A worker should finish one bounded deliverable before taking another; use a
   new worker for unrelated work rather than growing a long investigative chat.
5. Workers return a concise handoff: changed files, contract decisions, tests and
   results, unresolved findings and next dependency. Keep full logs and repetitive
   source listings out of the coordinator's context; retain only the evidence
   needed for the next decision. Reference source files rather than creating
   duplicate permanent documentation. Independent reviewers read the actual diff
   and affected contracts, not just the builder's summary.
6. Integrate prerequisite work before dependent work. Resolve review findings,
   update enduring documentation with each behavior change, and run the selected
   tasks' required checks. The coordinator serializes full builds/tests after
   integration: `npm test` already includes the build, so never run them together.
   Use the required host/escalated environment from AGENTS.md. Focused worker tests
   do not replace final integrated checks or required desktop/phone comparisons.
7. Before finishing, add a dated checkpoint containing the session number, completed
   task IDs, changed files, interface decisions, exact verification outcomes,
   accepted visual differences, remaining work and the next session number. Record
   branch/commit identity when available and whether changes remain uncommitted;
   a checkbox does not authorize a commit, push or release.
8. Mark only the selected session checkbox `[x]`, and only after its entire scope,
   required verification and review pass. Failed or unrun required checks leave
   it `[ ]`. If context or an external blocker interrupts work, checkpoint completed
   subtasks and the precise resume step without checking the session. A fresh
   session resumes that first unchecked item rather than redoing completed work.
   Stop after the selected session; the user starts the next fresh session.

The handoff documents decisions and verified state; it cannot guarantee that no
worker will compact. If compaction happens, continue from the same checkpoint and
owned task rather than expanding the scope or repeating finished investigations.

## Tasks

Each task lists its owner area from `docs/AGENT-WORKFLOW.md`, the artboards it must match, the verification commands, and the privacy checks. Run `npm run verify:fast` before handing off any task and `npm test` for rendering, metric, parser, or structure changes. Record a checkpoint under the task when done.

Execution order and dependencies:

1. T00 prerequisite documentation is complete; its executable privacy checks belong to T02, T07, and T08 before new evidence can ship.
2. T02 before T01 and domain-consuming UI work. T01 supplies the shared transport for T04 onward.
3. T03 before T04 (page header and tab shell). T04 before T05, T06, T06b, T08, T09, and T10. Former T04b is merged into T06; T06b owns Signals and depends on T06 for request navigation.
4. T07 before T08, T09, and T13. T03 before T13 for shared settings presentation.
5. T11 any time. T12 last, after every implementation task and its checks.

Common rules for every task:

- `scripts/check-architecture.mjs` caps new source files at 800 lines. Split the lane chart, file tree, file history panel, and page header into files under that cap from the start.
- `npm run check:boundaries` rejects orphan modules. Delete a replaced component and its test in the same change; never leave it unreferenced.
- Check route and redirect access through `desktop/lan-gateway.mjs`. Existing session query URLs need no agent-route expansion; preserve `/dashboards` access long enough for its redirect to work on LAN.

### T00 Privacy decisions for file history and repository persistence

Owner: `AGENTS.md`, `docs/OBSERVATION_CACHE.md`, `docs/METRICS.md`. Artboards: none. Documentation only.

Approved prerequisite contracts are recorded in their owners; runtime support remains pending. T02, T07 and T08 must enforce them before the new evidence can be committed or exposed.

- File-change evidence permits only bounded repository-relative paths validated against a recognized monitor-private root, opaque normalized file identity, normalized repository/session/agent IDs, fixed kind, observation time, and request number where supported.
- Use dedicated path validation, never the custom-agent terminal-identifier validator. Accept legitimate nested relative paths; reject absolute/drive/UNC/device paths, traversal, control characters, provider configuration or transcript paths, and any target whose containment is uncertain. Raw tool arguments and source paths remain private.
- Checkpoints may persist only these validated normalized records. The index rebuilds from committed checkpoints plus separately acquired Git evidence; GETs serve committed readiness or last-known-good state and cannot scan or rebuild synchronously.
- Historical repository persistence permits bounded recorded uncommitted files, comparison, and PR state with original check time. Missing historical evidence remains unavailable, never substituted from today's working tree.
- Git move evidence may preserve file identity but cannot invent session, agent or request attribution. File history describes recorded operations and incomplete coverage, never authorship of every change.
- T02/T07/T08 add serialization and checkpoint tests for valid nested paths, rejected path forms, forbidden source content, atomic replacement, recorded historical state and cache-only GETs. These tests are implementation work, not a completed T00 verification.

### T01 Single shared event stream and SSE-primary cadence

Completed 2026-09-14 in Session 1. See the [verified handoff](#session-1-handoff).

Owner: browser/API state (`app/`). Artboards: none.

Depends on T02 (204 path for session-history, domain events).

- Create one `EventSource` module (`app/live-events.ts` or extend `app/history-publications.ts`) with reference counting; `AppShell.tsx` and the history hooks subscribe to it. Delete the second connection.
- Replace every fixed timer with revision-gated fetches triggered by events plus the fallback cadence (30s connected, 5s reconnecting, 30s hidden). Timers to remove: catalog poll 5s ready and 1s loading in `AppShell.tsx`; activity 3s live and 10s historical in `useActivityHistory.ts`; the 3s stay-at-latest timer in `useSessionRequestSelection.ts`; the 5s preloader in `useRequestPageCache.ts` (keep the preloader, drive it by readiness instead of a timer). Live loading states may keep a 1s poll until the domain reports ready; historical hydration uses events and reconnect revalidation without a periodic timer.
- Historical sessions: load each mounted domain until ready using its events, including revalidation after SSE reconnect so a missed readiness event cannot strand it. Once ready, no periodic timers. Explicit navigation to a new range or filter still fetches that committed query once.
- Update the "Frontend API cadence" table in `docs/OBSERVATION_CACHE.md`.
- Verify: `npx vitest run tests/ui/` suites touching Activity and Requests; a manual sixty-second count with one live tab must be under fifteen requests on a quiet session.

### T02 Per-domain session responses with independent revisions

Completed 2026-09-14 in Session 1. See the [verified handoff](#session-1-handoff).

Owner: monitor indexing and projection (`monitor/`), serving handlers, `shared/`.

- Split session projection into domains: `session-summary`, `agents`, `agent` (inspector by id), `signals`, `repository`, `resources`, `details`. Signals owns cache events, efficiency signals, flow score, per-agent cache lifetime, and agent-reported signals. Activity and requests stay on `session-history`; `scope=<agentId>` scopes the chart, ranking, feed, kind aggregates, and shell-task views together.
- Page `kind=activity&from=<n>&to=<n>` by a bounded request-number range with tool calls nested under each request. The default feed shows five scoped requests around selection, adjusted at either end. Preserve stable session request numbers across filters and exclude unresolved associations from request groups rather than inventing one. Add a bounded `workKind=<WorkKind>` filter (one recognized value) for nested calls. A kind filter must not remove the selected request header or its bar; show an explicit no-matching-calls state. Validate range bounds and maintain response limits for requests with many calls, with explicit continuation rather than silent truncation.
- Each domain owns a revision counter and readiness; `writeCommitted` serves 204 on matching revision. `/api/session-history` today always answers 200 with an in-body revision string and never uses `writeCommitted`; add the 204 path there too.
- Set ETag to the revision. Compression is new work: vinext compresses only static build assets, and `proxyMonitorJson` buffers the body and copies one header. Implement gzip in the monitor (honor `Accept-Encoding`, `Vary: Accept-Encoding`) and let the proxy pass `Content-Encoding` through, or compress in the proxy. `desktop/lan-gateway.mjs` already forwards `etag`, `if-none-match`, and `content-encoding`.
- SSE events carry domain, session id, revision, and for history the total count. Today `/api/events` emits only `catalog`, `repositories`, and `history` with `{domain, revision}` and no session id.
- Keep `/api/state` as a composed view until every consumer has migrated, including Signals, Repository, Resources and Details; audit remaining consumers and delete it in T12.
- Privacy: add serialization coverage per domain for forbidden content and for the narrow T00 repository-relative path exception. Prove rejected paths cannot enter committed evidence, checkpoints, history or responses; retain the explicit one-shot transcript-path and provider-folder exceptions.
- Update `docs/OBSERVATION_CACHE.md` (phases D and S, revision semantics, readiness per domain) and `docs/ARCHITECTURE.md`.

### T03 App bar, palette, page header, sidebar limits

Completed 2026-09-14 within the partial Session 2 checkpoint. See the
[verified handoff](#session-2-checkpoint). Session 2 remains unchecked.

Owner: UI (`app/components/command-center/`, `app/styles/shell.css`, `DESIGN.md`). Artboard: `HeaderStandard.html`; app bar and sidebar also visible on every desktop artboard.

- App bar: remove the breadcrumb and the `hasBreadcrumb` grid variants from `CommandCenterShell.tsx` and `shell.css`. Search becomes a fixed-width trigger that opens the palette; phone shows an icon.
- Palette: reuse the current regex routing; add recent sessions and repositories from the catalog store. Keyboard: Ctrl K opens, Esc closes, arrows move, Enter navigates.
- Page header component with breadcrumb eyebrow, title, meta line, actions slot, optional tabs. Adopt it on Home, Sessions, session detail, Repositories index and detail, Models & delegation, Usage limits, Settings.
- Sidebar limits widget from the existing usage-limits store: one line per provider with sessions in the last seven days (computed from `SessionSummary.provider` and `createdAt` in the catalog context), tightest window only, colors from the METRICS.md usage-limit rule (75 and 85 percent). Never rendered as part of session state; historical views unaffected.
- Rename the Agents navigation label to "Models & delegation". Remove the Dashboards page and its navigation entry; redirect `/dashboards`. Keep `/dashboards` allowed in `desktop/lan-gateway.mjs` so the redirect works in paired LAN browsers. Remove the old Home pin in `app/HomeDashboard.tsx`, the palette regex row, the `DashboardsView` component in `CommandViews.tsx`, and `tests/ui/dashboards-view.test.tsx`.
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

### T05 Agents tab and inspector

Owner: UI and agents analytics (`app/components/dashboard/agent-roster/`, `app/agents/`, `monitor/agents-analytics.mjs`). Artboards: `SessionAgents`, `Mobile`.

Depends on T04 and the T02 agents/agent domains.

- Preserve the existing roster, filters, grouping, List/Tree/Grid and selected-agent inspector described in Agreed decisions. The inspector reads the `agent` domain; a new domain does not imply a new page.
- Use `?tab=agents&agent=<id>` for selection and external evidence links. "Activities for this agent" opens `?tab=activities&agent=<id>`. Model navigation keeps its filter. No agent-detail route or LAN route expansion.
- Preserve lineage, facts, skills, shell tasks, signals and local-client transcript-copy gating in the inspector. Derive per-agent compactions from normalized context boundaries and ancestry from `parentId`; retain latest-snapshot context semantics.
- Reuse the roster row where appropriate in Models & delegation Live agents. Repair `AgentEvidencePanel.tsx` so links carry the agent id.
- Phone uses List/Grid and the existing full-screen inspector sheet with Back/Escape, focus restoration and scroll lock; implement the group row and regular-weight context from `Mobile`.
- Verify scoped deep links, filters and inspector selection across view changes, phone focus restoration, historical evidence and serialization; compare both artboards.

### T06 Activities: correlated requests and grouped feed

Owner: UI (`app/components/dashboard/requests-actions/`, activity feed) and committed history serving. Artboards: `ActivityTab`, `Mobile`. This absorbs former T04b.

Depends on T04, T02 request-range history, and T01 transport.

- Build the lane chart and single-chart mode from Agreed decisions: shared request order, exactly-one-lane assignment, per-lane scales, compactions, workflow collapse beyond eight, focus, 220px labels and tooltips, neutral minimap, Fresh tokens / Full breakdown.
- Place agent scope in the chart header and apply it to chart, Largest strip, feed, Actions by kind and shell-task views. Kind toggles filter nested calls with count/share/median context; they do not orphan selection by deleting its request header. Largest values remain request-local.
- Under the minimap and Largest strip, render one Activity feed: left Actions by kind, Shell tasks and Failed shell runs; right five request groups around selection with nested calls. Previous / Next changes the request range and keeps chart selection visible; Jump to latest reveals and selects the latest request. No old cross-tab return strip or Fed by / Called tallies.
- Implement the approved anchored viewport in `useSessionRequestSelection.ts` and `RequestMinimap.tsx`: stop automatic viewport advance before selection would leave it, while history and minimap totals grow. Dragging beyond selection transfers it to a visible bar. Details and feed must never retain a selection absent from the chart. Use coherent loading and cancellation so rapid navigation cannot mix requests.
- Phone follows the single-chart and quiet grouped-feed rules above, including the 32px call line and the in-place call expansion (artboard `Mobile`, frame "Activities · tapped call line expands in place"). The expanded block exposes only already-bounded activity and execution-task metadata (work kind, Bash description or file basename, wall duration, call and result timestamps, lifecycle status, exit code, failure category, background flag, normalized agent and request number); never command text, output, per-call tokens or cost. Expansion is a disclosure on the line (aria-expanded), one open at a time, Escape collapses, no sheet or scroll lock, and no URL parameter. Add the scoped selected-request left-rule exception and the 32px phone call-line height to DESIGN.md and its contract tests before styling them.
- Keep traceable observed metadata in Activities; full cache evidence and rule-generated views live in Signals. Request details retain four counts and the shared association caveat explaining that recorded links do not allocate task token cost.
- Tests: growing totals with anchored selection; drag, page, keyboard and filter selection; synchronized loading and cancellation; request groups at range edges, empty/unresolved associations and bounded continuation; lane assignment/focus/collapse; scope consistency; no provider identifiers in DOM.
- Update `docs/OBSERVATION_CACHE.md` for range paging, selection and event totals, and `docs/METRICS.md` for request-local and association wording. Compare desktop and phone artboards.

### T06b Signals tab

Owner: UI (`app/components/dashboard/`), monitor signal projection, `docs/METRICS.md`. Artboard: `SignalsTab`; phone access through `Mobile` More sheet.

Depends on T04, T02 signals domain, and T06 request navigation.

- Render efficiency signals, cache evidence, flow score with its two inputs, cache lifetime by agent, and agent-reported MCP signals from the committed signals domain.
- Put the deterministic-rules and "Not a quality assessment" caveat at the tab introduction. Preserve evidence-specific observed/inference/attributed labels and identify MCP content as agent-reported; a shared tab does not make agent reports deterministic measurements.
- Link supported evidence to Activities with its request and agent selected. Evidence without a supported request link remains informative without a fabricated target. Remove flow score from Details and the old standalone cache disclosure.
- Test caveats, readiness/unavailable states, request navigation, historical isolation and domain serialization. Update METRICS.md and compare the artboard.

### T07 Monitor SQLite store: file-change index and resource history

Owner: monitor persistence (`monitor/`), `docs/OBSERVATION_CACHE.md`.

Depends on T00.

- Add one monitor-owned `node:sqlite` database under the Pomegr data root (`resolvePomegrDataRoot` in `shared/pomegr-paths.mjs`, `%APPDATA%\pomegr` on Windows), for example `monitor-store-v1/monitor.sqlite`. Not under `outputs/`, which holds development diagnostics only. It hosts file-change and resource history. Use indexed session/time-range queries; measure actual database growth, indexes and peak-window overhead during implementation rather than assuming a per-session byte size.
- File-change tables: `files` (id, repository id, current relative path, first seen, deleted at), `file_paths` (file id, path, valid from, valid to, bounded source enum), `file_changes` (id, file id, session id, agent id, kind, observed at, request number). Attribution columns are nullable when supporting evidence is absent; Git-only continuity must not create a session edit count. Choose and test concrete path, page, record and snapshot bounds before committing evidence.
- Resource tables, written on the checkpoint cadence from the in-memory sampler (raw samples stay in memory for the last 30 minutes only):
  - `resource_minutes` (session id, minute start, and for each of CPU cores, CPU machine percent, memory bytes, read bytes per second, write bytes per second: min, avg, max, and the exact sample timestamp of the max). One row per minute per session; a peak keeps its magnitude and its second-level time after downsampling.
  - `resource_peak_samples` (session id, peak id, timestamp, the five fields): raw samples for the two minutes before and after each of the top ten peaks per field. Bounded to ten peaks per field per session. Older peaks that fall out of the top ten lose their window.
  - `resource_peaks` (session id, field, timestamp, value, matched task ids, matched request number): the bounded peaks table itself, a few hundred bytes per session.
- Peak matching uses normalized execution-task start/end intervals for overlap only; unfinished tasks extend only through the latest observation. Link a request only when its normalized temporal association is unambiguous, otherwise omit the link. Usage observation timestamps alone do not establish a request execution interval. Request-local counts describe that request, never task cost; document the deterministic association rule in METRICS.md before shipping.
- Retention, monitor-side, run after checkpoint writes and never in a GET:
  - Age: retention setting with fixed choices 30, 90, 180, 365 days, or keep all. Default 90 days. Past the age, drop `resource_minutes` and `resource_peak_samples` for that session. Keep `resource_peaks` and `file_changes` for as long as the session remains in the catalog.
  - Size: a soft resource-history cleanup threshold, default 500 MB. At or above it, the next prune cycle removes the oldest sessions' `resource_minutes`, then their `resource_peak_samples`, and runs incremental vacuum. Preserve peaks and file changes while their session remains in the catalog. If protected records alone exceed the threshold, allow the database to exceed it; do not delete protected history or stop new records merely to enforce a hard cap. Age retention applies independently.
  - Settings read: desktop passes the two bounded values through the existing private desktop settings and a fixed-key IPC, like the provider folders; web development reads `POMEGR_RETENTION_DAYS` and `POMEGR_STORE_MAX_MB`. Browser and LAN requests can never change retention or trigger a prune.
  - Expose bounded committed storage readiness for Settings: database size in bytes, oldest retained day, last prune time, effective choices, and a fixed cleanup status distinguishing ordinary usage, cleanup pending and protected-history excess. Never paths or raw database errors. The percentage is database bytes divided by the effective byte threshold; label and bar use the same units. Checkpoint/prune work owns measurement; GETs serve the committed result.
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
- Peaks table row: field, time, value, matched execution tasks (work kind and Bash description, wall duration), and a link to Activities with a request only when the temporal association is unambiguous. Say "Request observed near this peak · N uncached input tokens"; describe interval overlap in the info popover. Never claim request execution intervals from usage timestamps alone, or say "this task cost N tokens".
- Live sessions render cards and peaks; historical sessions render the Session window and the peaks table from the store. Both use the same components.
- Tab hidden only when there are neither live samples nor stored rows for the session.
- Retention effects are visible: if curve rows are absent, retain the peaks table and explain whether age retention or size cleanup removed the curve, using bounded reason metadata. Never label missing data as a zero value or claim age-based deletion for size cleanup.
- Remove `observedPeak` from the in-memory state once the store serves peaks.
- Privacy: the `resources` domain exposes only normalized session id, bounded readiness/retention reasons, timestamps, bounded raw samples or minute min/avg/max aggregates with peak timestamps for the five numeric fields, bounded peak IDs, matched normalized task IDs, and optional request numbers. Resolve task labels through existing normalized metadata. Add a serialization test; no process identity or source content.
- Compare against the artboard.

### T10 Details tab

Owner: UI (`SessionDetailsPanel.tsx`, `MachineryPanel.tsx` successors). Artboard: `DetailsTab.html`.

- Session facts, one-shot Copy transcript path (unchanged endpoint), Cost estimate with the estimate label, Context inventory inline with the category table, groups link, and repository inventory revision link. Flow score and its inputs belong only to Signals.
- No usage limits on this tab. No audience chip.
- Compare against the artboard.

### T11 Development request log

Owner: `scripts/dev.mjs`, `scripts/run-vinext.mjs`.

- The per-request lines come from vinext's development server (`node_modules/vinext/dist/server/request-log.js`), not from Pomegr scripts; both scripts spawn children with inherited stdio and log nothing per request. First check whether the installed vinext version exposes a request-log option. If not, `scripts/run-vinext.mjs` pipes the child's stdout, drops lines whose status is 204, and writes the rest through unchanged. Keep TTY color detection working by forwarding `FORCE_COLOR` when the parent is a TTY.
- `POMEGR_DEV_REQUEST_LOG=all` restores every line. Document the flag in `docs/CONFIGURATION.md` with the other development-only variables.

### T13 Storage retention setting

Owner: desktop lifecycle (`desktop/`), Settings UI (`app/settings/`), `docs/CONFIGURATION.md`. Artboard: `SettingsStorage.html`; it follows the existing Settings → Providers layout.

Depends on T07.

- Settings → Storage section: retention age as a segmented control with the fixed choices from T07; **Resource history cleanup threshold** select (250 MB, 500 MB, 1 GB, 2 GB); a usage bar beside the selector; and the readiness line (size, oldest retained day, last prune). Show used/threshold and percentage, for example "380 MB / 500 MB · 76%" (illustrative). Desktop users can increase the threshold; browser/LAN clients see read-only values. Changes require fixed-key enum IPC and native confirmation.
- The monitor applies changes on the next prune cycle. Never prune in IPC or GET handlers and never delete peaks or file changes for cataloged sessions because of age or size cleanup.
- Bar copy: "At 100%, older resource curves and detailed sample windows become eligible for automatic cleanup. File history and recorded peaks are preserved." Explain that age retention applies independently. Cap visual fill at 100% but print the actual percentage above it; for example "550 MB / 500 MB · 110%". Use "Cleanup pending" until the monitor confirms protected records cause the excess, then "Preserved history exceeds the cleanup threshold." Use existing accessible meter/progress styling, numeric text and status wording; missing readiness is unavailable, never 0%. The bar is informational, not an interactive slider.
- Document the two development environment variables and the defaults in `docs/CONFIGURATION.md`; document the bounded IPC in `docs/OBSERVATION_CACHE.md` next to the provider-folder settings.
- Reuse existing segmented controls and selects. Add a static storage usage sample covering ordinary, 100%, over-threshold and unavailable states to `/design-system`; update DESIGN.md and contract tests for any new shared meter pattern. Test units, actual over-100 text with clamped fill, cleanup status, read-only browser/LAN behavior and native enum validation.
- Compare against `SettingsStorage.html`, recording the approved usage-bar addition and soft-threshold wording as intentional differences from the existing export.

### T12 Closure

- Confirm each task has moved its enduring rules into `DESIGN.md` (page header, tab bar, correlated Activities, agent inspector, lanes, file tree, history panel, sidebar limits, role tints, storage bar and phone selection exception), `docs/OBSERVATION_CACHE.md` (domains, cadence, anchored selection, file-change index), and `docs/METRICS.md` (Signals caveats, recorded associations, lane presentation and role tints as presentation, never measurement). Do not wait until closure to update a contract changed by an earlier task.
- Delete `/api/state` and its proxy once all domain consumers, including Signals, have migrated; update `docs/ARCHITECTURE.md` and `AGENTS.md` (Architecture section lists the route).
- Record the final sixty-second request count and the before/after screenshot pairs in the last checkpoint.
- Record follow-ups that leave this plan: the Resources process table with a monitor-private per-task sampler, and a consumer for `HomeSnapshot.limitActivities` or its removal from the contract.
- Move the SQLite store schema, retention tiers, and storage readiness into `docs/OBSERVATION_CACHE.md`, and the peak-matching rule (time overlap, adjacency wording) into `docs/METRICS.md`.
- Delete this plan and the prototype folder in the same change.

## Readiness and implementation handoff

No unresolved product decision blocks implementation. The latest approved rules are folded into the tasks above.

- Undrawn states follow existing components and DESIGN.md: historical readiness/empty/error states, desktop roster Tree/Grid, lane collapse/focus, palette overlay, Models & delegation Live agents, repository Git commits, Home pins, Sessions header and light theme. Record material deviations during task verification.
- Existing exports are visual references, not current runtime behavior. Use the actual paths in the prototype README. Written changes override stale drawing details: Activities/Signals navigation, inspector selection, no per-agent role dots in lists, phone selected-request rule, historical resource curves, and the Storage usage bar/soft threshold. Do not claim regenerated artboards for this documentation update.
- Verify SQLite inside the Electron monitor worker before T07 implementation. Resolve technical fallback from evidence if unavailable; a system-Node probe is insufficient.
- Implementation orchestration is finalized in the session queue and protocol above. The user will request implementation separately; that request starts exactly the first unchecked session. Do not start code changes under this documentation authorization.
- For implementation delegation use Sol-class or cheaper models only, from the harness column in the protocol's work-class table: `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna` under Codex; `claude-opus-5`, `claude-sonnet-5`, or `claude-haiku-4-5` under Claude Code. No Astra or Fable subagents. Nested subagents are permitted under the same ceiling, bounded task ownership and available concurrency. Prefer the cheapest capable model.
- Keep the coordinator's context small through focused task briefs and concise handoffs. Follow the ownership, dependency waves, model choices, integration/review responsibilities and verification protocol above; checkpoints must allow work to continue without repeating investigations.

## Continuation checkpoint

### Session 3 checkpoint

2026-09-17 · **Session 3 part 1 of 7 done: T06 selection core.** ACOS run
`runs/2026-09-16-ia-session-3/1-activities-selection-core` (manifest, log and stage artifacts
there). The independent Sol review passed in its second iteration. Session 3 stays unchecked.

**State.** Branch `claude/ia-redesign-session-3`. Part 1 is committed as one commit on top of
`47ebdb2`, together with this checkpoint. The ACOS run records under `runs/` are gitignored and
stay local.

**Changed files.**

- New:
  - `app/components/dashboard/ActivitiesTab.tsx`
  - `app/components/dashboard/useTransitionalSessionState.ts` (`/api/state` polling moved
    verbatim from `LegacySessionTab.tsx`)
  - `app/components/dashboard/activity-feed/{useActivityFeed.ts,feed-model.ts,ActivityRequestGroups.tsx,duration.ts}`
  - `app/components/dashboard/requests-actions/selection-viewport.ts`
- Modified:
  - `app/components/dashboard/requests-actions/useSessionRequestSelection.ts` (661 lines)
  - `requests-actions/useRequestSelection.ts`
  - `LegacySessionTab.tsx` (activities branch removed)
  - `ActivityPanel.tsx` (imports `activityDuration` from `activity-feed/duration.ts`)
  - `app/Dashboard.tsx` (routes `activities` to `ActivitiesTab`)
- Tests:
  - New: `tests/ui/{selection-viewport.test.ts,activities-selection.test.tsx,activity-feed.test.tsx,activities-tab.test.tsx,activities-test-server.ts}`
  - Adjusted: `tests/ui/requests-actions.test.tsx`. The minimap test now expects the selection to
    move to the nearest visible request, because the positional fallback was removed.
  - Adjusted: `tests/ui/transitional-session-tab.test.tsx` (tab union).

**Fixed interface for parts 2-4.** Parts 2-4 consume this interface and must not change the
selection hook.

- Selection owner is `useSessionRequestSelection`.
  - New options: `route?: { agent: string | null; request: string | null }` and
    `onRouteChange?`.
  - It keeps all earlier return fields.
  - It adds `mode: "follow" | "track" | "anchored"`, `selectedNumber`, `selectedIndex`,
    `workKind`, `setWorkKind`, `historyScope`, `pending`, `previousRange()`, `nextRange()`
    (steps of 5 in scope), `jumpToLatest()`, `moveWindow(start)` (moves the selection with the
    window) and `locate(id, targetScope?)`.
- `selection-viewport.ts` holds the pure rules: `advanceOnGrowth`, `transferOnViewportMove`,
  `stepTarget`, `modeFor`, `selectionAfterCommit`.
- Feed hook: `useActivityFeed({ enabled, query: { sessionId, scope, selected, workKind }, historyRevision })`.
  - It returns `{ status, correlated, groups, byKind, shellTasks, requestTotal, callTotal, revision, loadMore, loadingMore, retry }`.
  - `feed-model.ts` exports `parseActivityFeedPage`, `mergeCalls` and `targetBasename`.
- Container: `ActivitiesTab({ sessionId, historical, paused, route, onRouteChange })`.
  - It renders the unchanged `RequestsActionsPanel`, then the minimal
    `ActivityRequestGroups({ selection, feed, agents, busy })`, then the legacy `ActivityPanel`.
  - It sets `busy = !feed.correlated || selection.pending`.
  - Part 2 replaces `ActivityRequestGroups` and deletes `ActivityPanel` (sole consumer:
    `ActivitiesTab`).
  - `RequestsActionsPanel` is consumed only by `ActivitiesTab`.

**Invariants.**

- **Growth:**
  - Follow keeps the latest request selected.
  - Track advances the viewport until the selected bar would leave it, then anchors that bar at
    the left edge. The anchoring fetch completes before the page commits.
  - Anchored keeps its viewport while totals and the minimap grow.
- **Identity:**
  - A refreshed page is checked by position, then by request ID.
  - A request absent from scope jumps to latest and clears `request`.
  - Nothing is ever clamped to a false position.
- **Drag and minimap:** the selection moves to the nearest visible bar.
- **Filters:** the kind filter never moves the selection or viewport; the server keeps the
  selected header with `noMatchingCalls`. A scope change clears the kind filter.
- **Precedence:** a user selection supersedes an in-flight refresh. A queued history event
  flushes against the synchronously committed selection, never a stale mode.
- **Range fetches:** the previous chart stays rendered and the feed is marked busy.
- **StrictMode:** unmount interrupts reads and remount resumes them.

**Transport and URL decisions.**

- **Feed range:** the grouped feed sends `selected` with `scope`, and optionally `workKind`.
  It never sends `from`/`to`. A scoped agent's request numbers are sparse, so a 64-number range
  can hold fewer than five of its requests.
- **Feed cadence:** the feed has no subscription or timer of its own. It revalidates when the
  request page's committed revision changes, sending `revision=` so an unchanged answer returns
  204. That page already follows the Session 1 cadence, so historical sessions fetch once per
  query. Retry is manual.
- **URL `request`:** accepts a stable number, resolved with one grouped lookup, or an opaque
  request ID, which is rewritten to its number.
  - A lookup answered "loading" retries on the next revision or on reconnect.
  - A transient failure keeps the deep link.
  - Only a ready response without the number degrades to latest.
- **URL `agent`:** an unknown agent degrades to all agents.
- **Write-back:** happens only after user actions, once per settled gesture (300 ms UI settle,
  not polling). Follow mode writes `request` as null.

**Verification.** `npm run verify:fast && npm run test:ui`, run serially by the orchestrator
after the fix stage, passed.

- `verify:fast`: lint 0 errors and 16 pre-existing warnings. Architecture and boundary checks
  passed, with no file over 800 lines and no orphans.
- `test:ui`: 87 files, 867 tests.
- The full `npm test` (with the build) was not run in this part; part 7 owns it.

**Review.**

- Iteration 1 FAILED with three reproduced blockers:
  - React StrictMode stranded deep-link loads.
  - A queued history event undid a drag.
  - A selection during a track refresh committed a page without its bar.
- A fix stage resolved all three, plus six shoulds (including a route write per drag step) and
  three nits.
- Iteration 2 passed.

**Deferred findings and owners.**

- Part 5 (T06 docs): add an `docs/OBSERVATION_CACHE.md` cadence entry for the grouped feed
  (revalidation on page revision, 204, manual retry, 300 ms write settle).
- Part 2: `targetBasename` shortens prose that ends in a path ("Run tests for app/foo.test.ts"
  becomes "foo.test.ts"). Settle the target copy with the feed design.
- Part 7 regression sweep:
  - Cancelling an in-flight read leaves a queued publication waiting until the next event,
    fallback or selection (pre-existing, low impact).
  - A held arrow key stalls when fetches are slower than key repeat (pre-existing).
- Recorded only: the `advanceOnGrowth` follow and anchored branches are exercised only by tests,
  kept to document the rule.

**Next step.** Part 2 (activities-desktop-feed): `/acos run runs/2026-09-16-ia-session-3 2`,
preferably in a fresh session.

### Session 2 checkpoint

2026-09-16 · **Session 2 complete after rounds 3 to 5.** Acceptance-r4 verdict PASS, the
user's phone check PASS, and the full `npm test && npm run verify:fast` chain PASS on the
round-5 tree. Session 2 is now checked in the session queue above. This entry is the current resume point for
Session 3; the 2026-09-16 entry beneath it (stopped after round 2) and the 2026-09-14
entries stay as history. Supplementary evidence is retained locally under
`runs/2026-09-16-resume-ia-session-2/` (gitignored); every fact needed to resume is
restated in this entry.

**State.** Branch `claude/ia-redesign-session-2`. Session 2 work through round 3 is
committed as `9d9bd8f` (base main `3b116ad`); two user-owned ACOS tooling commits,
`1f91e8c` and `60621a5`, sit on top and are unrelated to Session 2. Rounds 4 and 5 are
uncommitted in the worktree. No push occurred. `git status --short`:

```
M  app/Dashboard.tsx
M  app/api/monitor-proxy.ts
M  app/api/session-domain/route.ts
M  app/components/dashboard/LegacySessionTab.tsx
M  app/components/dashboard/SessionTabs.tsx
M  app/session-domain-store.ts
M  docs/AGENT-WORKFLOW.md
M  docs/OBSERVATION_CACHE.md
M  docs/internal/plans/ia-redesign.md
M  monitor/observation-runtime.mjs
M  monitor/session-observation-coordinator.mjs
M  tests/session-domain-runtime.test.mjs
M  tests/session-domain-transport.test.mjs
M  tests/ui/dashboard-readiness.test.tsx
M  tests/ui/dashboard-t04.test.tsx
D  tests/ui/legacy-session-tab.test.tsx
M  tests/ui/session-domain-store.test.tsx
M  tests/ui/session-tabs.test.tsx
?? monitor/session-domain-serving.mjs
?? tests/ui/transitional-session-tab.test.tsx
```

**Round 3: acceptance-r2 findings resolved.**

| Finding | Resolution (round 3) |
| --- | --- |
| N1 restart froze rejected revisions forever | Epoch-aware guard added: `app/session-domain-store.ts` per-entry `dataEpoch` compared against `currentEpoch`, guard around lines 127-136, epoch advanced on every live event; a pending rebuild keeps its fast cadence. |
| N2 Agents List/Grid toggle a no-op, persistence deleted | `app/components/dashboard/AgentsTab.tsx` restores controlled `viewMode` and the `pomegr-agent-activity-view-<sessionId>` localStorage key; ported to `tests/ui/agents-tab.test.tsx`. Recorded as a T05 file-ownership exception. |
| N3 browser confirmation blocked by the "defects" state | Unblocked once N1, N2 and S1 landed; `confirm-navigation-r3.md`/`reconfirm-navigation-r3.md` passed every flow. |
| Checkpoint step 4, historical 503 stall | Monitor serves the retained loading body through an in-flight poll failure instead of dead-ending; the browser store retries. |
| S1 literal NUL bytes in `monitor/session-domain-store.mjs` | Restored to a normal text escape at both separator sites; the file diffs as text again. |
| S2 retained loading body hid poll errors | `app/Dashboard.tsx` now surfaces `summaryResult.error` on the loading-with-no-session branch. |
| S3 Resources deep link redirected while still loading | `SessionTabs.tsx` redirects only once `resourceAvailability.readiness` has actually resolved. |
| S4 unported Details assertions / report-mismatch test | Ported into the renamed `tests/ui/transitional-session-tab.test.tsx` and `tests/ui/dashboard-t04.test.tsx`. |
| S5 no explicit-request test, no DOM privacy test | Added to `tests/ui/dashboard-t04.test.tsx`. |
| S6 duplicated DESIGN.md paragraphs | De-duplicated. |
| T1 checkpoint should record T06 deferral, T05 exceptions, transitional-panel list | T06 deferral and T05 exceptions were recorded in round 3; the transitional-panel list itself waited for this entry (see the list below). |
| T2 browser-store doc lacked restart/epoch semantics | Promoted to acceptance-r3's blocker B2; resolved in round 4 (next table). |
| T3 pending-entry leak | Fixed via `survivedPrune` in round 3, but the one-pass fix reintroduced the defect as acceptance-r3's B1; properly resolved in round 4 (next table). |
| T4 phone `nav`/`tablist` share the label "Session sections" | Left open through round 3; resolved in round 4 with distinct "Session navigation" / "Session sections" labels. |
| Round-1 should, Activities ignores agent/request scope | Deferred to T06 throughout; unchanged (see "Known deferral" below). |
| Round-1 should, T05 exception for `AgentRoster.tsx` | Held; `AgentRoster.tsx` itself stayed untouched, only `AgentsTab.tsx`'s view-mode wiring is the T05 exception. |

**Round 4: acceptance-r3 findings resolved.**

| Finding | Resolution (round 4) |
| --- | --- |
| B1 detached pending entry after a multi-consumer keyed navigation | `app/session-domain-store.ts`: cleanup-time prune (`detachSubscriber`) no longer ages or consumes pending protection; only a subscribe-time pass (`touchSession`) sets `survivedPrune`; `attachSubscriber` re-registers a detached entry. The new multi-consumer test fails against the round-3 logic and passes with either half of the fix alone. |
| B2 restart/epoch semantics undocumented | Added to `docs/OBSERVATION_CACHE.md`: a loading response never replaces a resolved body; a lower revision is rejected within one epoch; the first resolved body after an epoch change is accepted and re-arms the guard; a pending rebuild keeps its fast cadence; revision clocks restart at 0 per monitor process; a 404 for a proven-absent session is definitive. Wording nits recorded as n-a below. |
| S-a sessions outside the 50-per-provider catalog window dead-ended on a retrying 503 | Bounded asynchronous hydration for uncatalogued IDs (4 concurrent probes, 128 records, 30 s recheck); only the session-domain route passes a genuine 404 through; the store stops retrying on 404 and recovers on a revision event, focus, reconnect, or revalidate. |
| S-b two lint errors | Fixed: store mutations moved into module functions; `LegacySessionTab.tsx` keys its inner panel on `sessionId`. `npm run lint`: 0 errors. |
| n1 domain GETs never prioritized restored-live re-hydration | Coordinator now triggers it, deduplicated via `restoredHydrations`. |
| n2 no test for the Overview "Show agent" button | Added. |
| n3 placeholder `catalogIdentity` check missing; no historical retry | Both added to `LegacySessionTab.tsx`. |
| n4 equal revision after a restart gives 204 and a skipped event | Documented alongside B2; no ETag instance component was added. |
| n5 restart recovery depends only on the SSE epoch | Documented, but flagged as still ownerless; assigned in this entry, see S-1(b) below. |
| n6 untracked `tsconfig.tsbuildinfo` | Moot; absent from the worktree (see the note below). |
| n7 wrong `AgentsTab` `onOpenActivities` comment | Corrected. |
| T4 (carried from acceptance-r2) | Resolved; see the round-3 table above. |

**acceptance-r4 verdict: PASS.** No blockers remained. Three S-1 deferrals needed owners
before Session 2 could close; assigned here:

(a) **Failure-versus-absence deferral.** A hydration probe that fails mid-read for a
session outside the provider catalog window is still served as 404 until the 30 s
recheck, the same as a proven-absent session; the two cases are not distinguished. Owner:
unassigned, next provider-observer change in `monitor/providers/normalized-polling-observer.mjs`
and `registry.mjs` (these already collapse a failure and a missing source into `false`); no
task in the current session queue owns provider-observer internals.

(b) **n5 residual.** Restart recovery depends only on the SSE epoch
(`app/session-domain-store.ts:127`, `app/live-events.ts`); in an environment where
`EventSource` never opens, the epoch never advances and a monitor restart reproduces the
original N1 symptom (stale data, 1 s polling). Owner: unassigned, next change touching
`app/live-events.ts` reconnect/epoch semantics or the store's restart guard; no queued
Session 3-6 task owns this transport hardening directly.

(c) **T05 exception unchanged.** The round-3 `AgentsTab.tsx` view-mode change remains the
only T05 exception; round 4 touched no T05 path (`git diff 9d9bd8f` over T05 paths is
empty).

**acceptance-r4 open nits (n-a to n-e), owners assigned in this entry:**

- n-a. `docs/OBSERVATION_CACHE.md` wording: a blocked SSE stream does advance the epoch
  (`app/live-events.ts:75,90-95` fires `error` and reconnects); the "1-second cadence"
  statement (`OBSERVATION_CACHE.md:1769-1771`) applies to live entries only, historical
  retries stay 5 s/30 s hidden; remove the review-finding IDs "(n4)"/"(n5)" from
  `OBSERVATION_CACHE.md:1359,1364`. Owner: Session 6 T12 closure documentation pass (or any
  earlier session that next edits `OBSERVATION_CACHE.md`).
- n-b. `app/session-domain-store.ts:120-123`, `app/api/monitor-proxy.ts:26-30`,
  `app/api/session-domain/route.ts:32-33`: "404 only after hydration proved absence" is
  overstated; an `agent` query for an agent missing from a committed record, and malformed
  or unregistered-provider IDs, also 404 without hydration (low impact today). Owner:
  whichever of T06b, T08 or T09 next extends `app/session-domain-store.ts`'s domain set.
- n-c. `app/session-domain-store.ts:333`: re-registering a detached entry checks key
  presence, not object identity; unreachable today because each query key has one
  consumer. Owner: same as n-b.
- n-d. `confirm-navigation-r4.md` Flow 1 (sidebar Sessions to the live session row) did not
  exercise B1's same-commit unmount/mount trigger; B1 itself is covered by the
  mutation-verified unit test. Owner: Session 6 T12's final regression sweep; optionally
  repeat Agents tab straight to another session through the command palette.
- n-e. `app/components/dashboard/LegacySessionTab.tsx:106,108`: a `reconnecting` event
  cancels a historical legacy tab's forced retry timer without `force`, so it waits for the
  next `connected` poll instead of retrying immediately (it still recovers). Owner: Session
  6 T12, since `LegacySessionTab.tsx` is itself one of the transitional panels scheduled for
  removal.

**Round 5: architecture fix, no behavior change.** The first full verification (under
round 4) failed `npm run verify:fast` at `check:architecture` with two violations that
predated round 4: `monitor/observation-runtime.mjs` at 913 lines (cap 800), and
`tests/ui/legacy-session-tab.test.tsx` using a legacy/versioned source filename. Fixed by
extracting `monitor/session-domain-serving.mjs` (168 lines; `createSessionDomainServing`
returning `commit`/`forget`/`clear`/`protectedSessionIds`/`serveSessionDomain`), which
brought `monitor/observation-runtime.mjs` down to 780 lines, and renaming the test file to
`tests/ui/transitional-session-tab.test.tsx` (byte-identical copy). The three path
references in this plan and one row in `docs/AGENT-WORKFLOW.md` were updated to match. The
orchestrator's normalized-line comparison against the pre-extraction file found only
identifier rewiring (`observationCoordinator`→`coordinator`,
`observationServingActive`→`isServingActive()`, `commitSessionDomains`→
`sessionDomainServing.commit`, and similar), a split import, re-wrapped comments, the
factory shell, and `stop()`'s reset folded into `sessionDomainServing.clear()` with the
same three underlying clears; no logic change.

**Browser and phone checks.** Desktop Chrome round 4 (`confirm-navigation-r4.md`)
confirmed all five flows with no defects: Flow 1, keyed navigation from an Agents tab via
the sidebar Sessions list to the live session, showed KPIs advancing within 30 s with no
reload (Calls 196→234, all-agent context 630.5K→668.3K, wall time 21m→28m); note per nit
n-d above that this flow went through the Sessions page rather than exercising B1's exact
same-commit trigger. Flow 2, an unknown session ID, resolved to a definitive "Session
unavailable" in about 10 s, with one retry 10-20 s later and then no further requests
(confirms no indefinite 5 s poll). Flow 3, a session older than the 50-per-provider catalog
window (identified from local file mtimes only, no content read), loaded successfully in
about 15-20 s, well inside the 90 s bar. Flow 4, a full monitor-process restart, saw the
monitor and web ports both answer in about 58 s, with the still-open Overview reflecting
current data with no reload in about 60-70 s total elapsed. Flow 5, regression sanity,
confirmed historical sessions still reach the tab bar quickly, agent/path selection
round-trips across tab changes, and the Agents List/Grid toggle persists across reload. The
known deferral (Activities ignoring agent/request scope) was confirmed still true, per the
T06 deferral, not a defect.

The user performed the 390px phone check in round 3 (`phone-check.md`): 6 of 6 items pass
(tab bar reached, sticky tabs with no horizontal scroll, 44px targets, More menu
open/focus-return, Agents List/Grid toggle). Item 2 (load time) passed but was noted as
slow; server-log evidence for that open showed only fast 200/204 responses with no 4xx/5xx,
so the wait is client-side (dev-mode bundle download and hydration over the LAN), not a
server defect. Limitation: only the one live session was opened on the phone; recommend
opening a historical session on the phone at the next manual check.

**Verification (`artifacts/verify.md`).** Command `npm test && npm run verify:fast`, run
serially from the repository root.

- Iteration 1, under round 4 (2026-09-16T21:07Z): FAIL. `npm test` exit 0 (Node: 1,180
  tests, 1,179 pass, 1 skipped, 0 fail; UI: 83 files, 808 tests pass). `npm run
  verify:fast` exit 1 at `check:architecture` on the two violations above;
  `check:boundaries` was not reached in this chain (it was clean in `integrate-r4`).
- Rerun, under round 5 (2026-09-16T22:01Z): PASS. `npm test` exit 0 (build regenerated
  plugin bundles with no tracked diffs; Node suites 38/38, 16/16, 33/35 with 2 skipped,
  9/9, 23/23, 36/36, totalling 1,180 with 1,179 pass, 1 skipped, 0 fail; UI: 83 files, 808
  tests pass). `npm run verify:fast` exit 0: lint 0 errors (17 pre-existing warnings);
  typecheck, provider-contract, provider-adapters and landing typechecks clean; contract
  and ops tests pass; provider capability documentation in sync; architecture checks
  passed (730 source files); no dependency violations (483 modules, 1,483 dependencies).

**Models used, rounds 3 to 5** (Sol/Terra harness column only; no Astra/Fable used by any
worker or reviewer):

| Stage | Round | Model | Effort | Iter. | Check |
| --- | --- | --- | --- | --- | --- |
| fix-monitor-r3 | 3 | opus | high | 1 | — |
| fix-store-restart-r3 | 3 | sonnet | high | 1 | — |
| fix-agents-view-r3 | 3 | sonnet | medium | 1 | — |
| fix-dashboard-r3 | 3 | sonnet | high | 1 | — |
| fix-tabs-legacy-r3 | 3 | sonnet | medium | 1 | — |
| integrate-r3 | 3 | sonnet | medium | 1 | pass |
| confirm-navigation-r3 | 3 | sonnet | medium | 1 | — |
| fix-browser-defects-r3 | 3 | sonnet | high | 1 | pass |
| reconfirm-navigation-r3 | 3 | sonnet | medium | 1 | FAIL (user: skip, no flow failed) |
| phone-check | 3 | opus | low | 1 | pass |
| acceptance-r3 | 3 | opus | high | 1 | FAIL |
| fix-store-monitor-r4 | 4 | opus | high | 1 | — |
| fix-legacy-tabs-r4 | 4 | sonnet | medium | 1 | — |
| integrate-r4 | 4 | sonnet | medium | 1 | pass |
| confirm-navigation-r4 | 4 | sonnet | medium | 1 | — |
| acceptance-r4 | 4 | opus | high | 1 | PASS |
| full-verification (1st attempt) | 4 | opus | low | 1 | FAIL (`check:architecture`) |
| fix-architecture-r5 | 5 | sonnet | high | 1 | pass |
| full-verification (rerun) | 5 | opus | low | 1 | PASS |
| handoff-r5 (this entry) | 5 | sonnet | medium | 1 | — |

**Session 6 must verify removal of these transitional panels**, unchanged since round 3
(from `acceptance-r3.md`, T1 details):

- Activities: `RequestsActionsPanel` and `ActivityPanel`
- Signals: `InsightsPanel` and `CacheEvidenceDisclosure`
- Repository: `RepositoryDisclosurePanel`
- Resources: `ResourceUsagePanel`
- Details: `SessionDetailsPanel`

**Note.** `tsconfig.tsbuildinfo` must never be committed. It is currently absent from the
worktree and is regenerated by builds.

**Known deferral unchanged.** The Activities tab ignores agent/request scope until T06.

**Next step.** Session 3 (T06 and T06b) starts only on a separate user request.

2026-09-16 · **Stopped on explicit user instruction after a second independent acceptance
failed: a handoff instead of a third round.** Its resume steps below supersede the
2026-09-14 "Essential resume steps"; the 2026-09-14 entries stay as history. Session 2
remained unchecked as of this entry (superseded by the completion entry above; Session 2
is now checked). Branch `main`, HEAD `3b116ada46ca91667e7b7378ce974bd0337770b0`. All
changes are uncommitted; no commit or push occurred.

Two independent-acceptance rounds ran against the T04 completion diff (round 1 verdict FAIL,
5 blockers; round 2 verdict FAIL, 3 blockers). Round 2 fixed 4 of round 1's 5 blockers and
found 2 new ones. Round 2 test results: `npm run test:ui` 83 files / 779 tests passed,
`npm run typecheck` clean, `npm run check:boundaries` clean (482 modules / 1,481
dependencies), and 35 targeted node tests (`session-domain-store`, `session-domain-runtime`,
`session-domain-transport`, `observation-serving`, `committed-response-cache`,
`api-serialization`) passed. Neither round ran the integrated `npm test` or
`npm run verify:fast`; no full-suite pass is claimed for T04/T05 in this session.

Fixed between rounds (round-1 blockers, now resolved and tested):

- Monitor re-commit/eviction flap (`monitor/session-domain-store.mjs`,
  `monitor/observation-runtime.mjs`): catalog events previously re-committed every catalog
  session and refreshed retention on each one, so bound-based eviction dropped the newest
  (live) rows first, producing the observed revision flap (0/0/76003/0/76105…) and a
  permanently "Loading session…" page. Fixed with demand-ordered retention, no-op identical
  re-commits, a protected-session exemption for live/working/needs_input/open rows, and
  hydration triggered from `serveSessionDomain` for hydratable rows with no committed
  evidence. Tests: `tests/session-domain-runtime.test.mjs` (catalog-churn and
  hydration-reaches-ready cases), `tests/session-domain-store.test.mjs`.
- Legacy consumer corrections (`app/components/dashboard/LegacySessionTab.tsx`): first 204,
  last-known-good plus notice, 1s/5s/reconnect cadence, hidden/focus handling,
  `refreshAfterFlight`, session reset, late-abort non-commit are now covered by
  `tests/ui/transitional-session-tab.test.tsx:100-268`.
- Deleted-suite behavior: progressive-readiness ported to
  `tests/ui/dashboard-readiness.test.tsx:32-69`; offline-only-after-failure ported
  (`app/Dashboard.tsx:131`, `tests/ui/dashboard-t04.test.tsx:250`); repository privacy,
  recorded-state labels, sanitized Codex usage, historical Usage-limits omission and the
  fallback details summary ported to `tests/ui/transitional-session-tab.test.tsx:271-331`.
- Tab accessibility (`app/components/dashboard/SessionTabs.tsx`): roving tabindex, `More`
  focus handling and arrow/Home/End/Escape, `aria-controls`/`aria-labelledby`, resolved and
  tested in `tests/ui/session-tabs.test.tsx:46-100`.
- Plan wording: Signals "Show agent" opens the Agents tab (already reconciled in Agreed
  decisions above); browser-confirmed in both round-2 flow reports.

Remaining resume steps, in order (file:line verified against source on 2026-09-16; adjust
if source has moved):

1. **Restore two literal NUL bytes in `monitor/session-domain-store.mjs`.** Lines 62
   (`function key(sessionId, domain) { return `${sessionId}<NUL>${domain}`; }`) and 224
   (`recordKey.lastIndexOf("<NUL>")`) contain a literal NUL byte where an escape sequence
   (for example `::`) was intended. Behavior is unaffected today because both sides use the
   same literal byte, but `git diff --numstat` reports `-\t-\t` (binary) for this file and
   `grep` reports "binary file matches", so the file is unreviewable as text. Restore a normal
   text separator and re-run the affected store tests.
2. **Store revision guard rejects every lower revision permanently after a monitor
   restart.** `app/session-domain-store.ts:110-111` treats any response with
   `value.revision < retained.revision` (or a `loading` response at or below the retained
   revision) as stale and keeps the old body forever. Per-domain revision clocks in
   `monitor/session-domain-store.mjs` restart at 0 on every monitor process start (for
   example `npm run dev`, the restart-pomegr skill, or a desktop monitor-worker restart), so
   a page left open across a restart receives revisions permanently below its retained one
   and never recovers — a live session can show a stale "In progress" state indefinitely with
   `connected: true` and no error. `app/live-events.ts`'s `connect()` already resets its
   `latestRevisions` map per connection epoch; the store does not use `epoch` at all. Fix
   direction: accept a lower revision after a live-events epoch change or reconnect recovery
   (or narrow the guard to reject only `loading`/revision-0 envelopes, never a resolved lower
   revision). Add a test simulating a monitor restart while an entry is retained. No test
   exists today.
3. **`AgentsTab.tsx` drops the roster List/Grid toggle and its persistence — a T05
   regression.** `app/components/dashboard/AgentsTab.tsx:35-49` renders
   `AgentActivityPanel`/`AgentRoster` without passing `viewMode` or `onViewModeChange`, so
   `AgentRoster.tsx:63` defaults to `viewMode="list"` with a no-op handler and the shipped
   Grid button (`AgentRoster.tsx:285`) does nothing. `HEAD:app/Dashboard.tsx` wired this and
   persisted `pomegr-agent-activity-view-<sessionId>` to `window.localStorage`; that
   persistence is gone from `app/`, and the deleted test
   `tests/ui/workflow-activity.test.tsx` ("coerces a stored Tree view to List and persists the
   Grid choice") was dispositioned as "not portable" instead of ported. Wire `viewMode` state
   (with the same storage key convention) through `AgentsTab.tsx` into `AgentRoster`, and port
   the deleted assertion. Record this as a recorded exception to T05 file ownership (T05 owns
   `AgentsTab.tsx`; this fix necessarily touches it after the T04 migration).
4. **Investigate the historical-session 503 stall that needed a reload.** In round 2's
   `reconfirm-navigation-r2.md` Flow 0, the historical session `claude:2eadb47d…` stalled on
   "Loading session… Reading the latest committed summary." on first navigation; a reload
   reached the tab bar in ~10s. Network capture showed a 200 on
   `GET /api/session-domain?...&domain=session-summary` followed by a 503 on the same query
   with `&revision=238`. The likely presentation gap is `app/Dashboard.tsx:131-132`: when a
   retained body has `readiness: "loading"` and no `session` yet, the page always renders
   `SessionLoading` and never checks `summaryResult.error`, even when a later poll actually
   failed (the `SessionConnectionIssue` branch on line 131 only fires when `summary` itself is
   null). Confirm this is the exact cause, then surface `summaryResult.error` on the
   loading-with-no-session branch too, and add a test for a resolved-then-failed sequence.
5. **Should-fix items** (not blockers, but recorded findings from round 2 that remain open):
   - `app/Dashboard.tsx:131-132` — see step 4; the same code location is both the reload-stall
     root cause and this general gap (loading body plus failing polls shows "Loading" with no
     error).
   - `app/components/dashboard/SessionTabs.tsx:39,44-46` — the tab filter requires
     `summary.resourceAvailability.hasData === true`, and the `useEffect` at line 44-46
     redirects to Overview whenever the active tab is not in `available`. On a live session
     whose `resourceAvailability.readiness` is still `loading`, `hasData` is `null`, so a
     `?tab=resources` deep link (or a user already on Resources) is redirected to Overview
     before evidence resolves; redirect only once readiness has resolved (`ready` with no data,
     or `unavailable`). `available` is also rebuilt on every render, so the effect can
     re-invoke `router.replace` on every render until the URL settles — memoize it or narrow
     the effect's dependency.
   - Port the remaining deleted `dashboard-session-navigation` assertions that still apply
     because `SessionDetailsPanel` still renders behind the Details tab: "omits Codex usage UI
     when the provider capability is disabled", "omits current Usage and missing Loaded values
     from a historical collapsed summary" (the new `transitional-session-tab.test.tsx:310` checks
     only the expanded heading, not the collapsed summary), and "omits Loaded context inventory
     entirely when the selected provider does not support it". Also add the report
     session-mismatch guard test: "does not export a different session returned by a refresh"
     (`app/Dashboard.tsx:116`) has no dedicated test.
   - `tests/ui/dashboard-t04.test.tsx`: no test proves an explicit `request` supplied together
     with an agent change is kept (`app/Dashboard.tsx:101-102` clears `request` only when none
     is explicitly supplied); no DOM-level privacy test asserts the summary-rendered Overview
     and header contain no path, prompt, tool-output, or provider-ID content.
   - `DESIGN.md:281-287` — the "Session detail uses the shared page header…" paragraph and the
     "Role tint is the only exception…" paragraph are each duplicated verbatim (281/285 and
     283/287). Delete one copy of each.
6. **Nits to fold into this checkpoint (done by this entry) and one doc update still
   needed:**
   - T05 ownership exceptions to record: `app/components/dashboard/agent-roster/AgentRoster.tsx`
     (a focus-restoration race fix around lines 270-276, made during T04 integration, verified
     correct — `agent-tree-focus` tests pass) and `app/components/dashboard/AgentsTab.tsx`
     (step 3 above, once fixed).
   - `docs/OBSERVATION_CACHE.md:1722-1727` (the "session-domain browser store" paragraph)
     still does not describe the step-2 regression guard or restart revision semantics; update
     it together with step 2's fix.
   - `app/session-domain-store.ts` — an entry created by a render that React later abandons
     (for example an interrupted concurrent-mode render) keeps `pendingSubscription: true`
     (set at line 243) and is never pruned (the prune-exemption check is at line 149). The leak
     is small and bounded by distinct query keys; prefer registering entries in `subscribe`
     rather than during render, or add an exemption timeout.
   - Activities ignoring `agent`/`request` scope from `LegacySessionTab.tsx` navigations
     (`AgentsTab` "Activities for this agent", Overview request bars) is intentionally
     deferred to T06, which owns Activities selection state per its task description ("Place
     agent scope in the chart header and apply it…"). No action needed in Session 2.
7. **User's manual 390px phone check**, still outstanding because the available browser
   automation tool cannot narrow `window.innerWidth` below roughly 2300px in this environment
   (confirmed across four resize attempts in two independent-acceptance rounds — not an app
   defect). The user will check manually on a phone over the LAN at port 3003: the More menu
   opens and closes, focus returns to More after choosing a menu item, there is no horizontal
   scroll at 390px, and all five/four+More tab targets are 44px. The phone tablist DOM and CSS
   changed in round 2 (`SessionTabs.tsx`'s `.sessionPhoneTabs`/`.sessionPhoneTablist`
   restructure), so the desktop-only browser confirmation from earlier in Session 2 does not
   cover this.
8. **Fresh independent acceptance on the actual diff**, then serial host `npm test`
   (includes the build) followed by `npm run verify:fast`. Mark Session 2 complete only after
   both pass and acceptance passes with no remaining blockers. Stop before Session 3.

What round 2's browser confirmation actually showed (for context, so a fresh session does not
re-run already-passed checks unnecessarily): on the live session, tab bar reached in ~5s;
Signals "Show agent" correctly opens Agents with the matching agent selected; a plain tab
switch preserves `agent`/`request`/`path`; changing the selected agent clears an unrelated
`request`; desktop arrow-key roving focus plus Enter/Space activation follows the WAI-ARIA APG
manual-activation tablist pattern and is not a defect. One side observation, not a defect: with
`request=684` pinned in the URL, the on-page selected-request panel live-tail-followed to a
newer request (#687) while the URL kept `request=684`; this is existing live-tail behavior,
distinct from the query-persistence contract, and belongs with the T06 deferral above.

Session-domain-store privacy is unaffected by the round-2 monitor change: the only new summary
fields are bounded recomputed counts (`idleAgents`, `finishedAgents`, `activeAgents`) and a
readiness/boolean pair (`resourceAvailability`); retention metadata and hydration dedupe never
leave the monitor.

2026-09-14 · **Stopped on explicit user instruction: “Ok stop and give a handoff.”**
Implementation and review workers were interrupted; no further implementation
or test runs were started after that instruction. Resume this same unchecked
Session 2, never Session 3. All changes are uncommitted on `main` at
`3b116ada46ca91667e7b7378ce974bd0337770b0`.

T03 remains accepted. Sol implemented the summary-only shell, domain browser
store, tabs and Overview; Terra implemented the scoped Agents roster/inspector.
T05 is independently accepted: 40 focused tests, TypeScript and diff checks pass;
actual phone checks confirm URL clearing, focus restoration, scroll unlock and
regular-weight context. T04 desktop/phone visual corrections are accepted:
1440px layout matches Main; 390px has 44px tabs and no horizontal overflow.
Its actual Overview is about 1666px with a long title and three active rows;
the extra height compared with the illustrative artboard preserves real evidence.
Existing Activities/Signals panels are restored and every mounted consumer now
receives Desktop Pause. No final T04 or full-session pass is claimed.

Changed T04 ownership:

- `app/Dashboard.tsx`, `app/sessions/[sessionId]/page.tsx`, and new
  `app/components/dashboard/{SessionOverview,SessionTabs,LegacySessionTab}.tsx`
  plus `session-route.ts`: summary-only persistent header/Overview, query-driven
  tabs, lazy existing panels, scoped navigation, and report export.
- New `app/session-domain-store.ts`: exact-query body/revision retention,
  shared events, current plus two recent sessions, historical/live cadence,
  cancellation and last-known-good data. This remains under final review.
- `monitor/session-domain-projection.mjs` and
  `shared/session-domain-contract.ts`: summary-native agent status counts and
  resource availability. No navigation-driven eager domain acquisition.
- New `app/role-family.ts`, role tokens, session styles, design-system samples,
  `DESIGN.md` and `docs/OBSERVATION_CACHE.md`. The nested role helper used
  explicit Luna; T04 and independent review used Sol, T05 used Terra.
- New browser store/Dashboard/route/role tests and summary fixture; obsolete
  `SessionCommandBar.tsx` removed. Dashboard test migration is unfinished.

T05 accepted ownership: `AgentsTab.tsx`, roster/inspector, `AgentEvidencePanel.tsx`,
`AgentsView.tsx`, `app/agents/page.tsx`, phone roster context styles, and focused
tests. Agents uses only `agents` plus the selected `agent` domain; unknown agent
links normalize to a valid selection. Model links preserve a sanitized functional
`?model=` filter. Phone Back/Escape clears the URL, restores row focus and unlocks
scroll. Inspector lineage, tasks, signals and historical evidence remain scoped.

Essential resume steps, in order:

1. Finish T04 on Sol. Both `app/session-domain-store.ts` and `LegacySessionTab.tsx`
   still independently initiate a fetch after subscribing to an already-connected
   event singleton, whose synchronous connection notification can initiate one
   first. Prevent the duplicate and test exactly one initial request with the
   real notification semantics.
2. Independently verify the late corrections already present in source: first
   response 204 requires a retained exact-query body; legacy error rendering keeps
   last-known-good state; retained loading plus 204 keeps one-second cadence;
   reconnect/failure uses five seconds; session changes reset revisions; aborted
   responses cannot commit; all mounted consumers honor Pause. Check hidden and
   in-flight invalidation, three-session eviction, and no historical timers.
3. Verify `InsightsPanel.tsx`'s newly added `preventDefault()` repair. Before that
   edit, an actual Show agent click stayed on Signals with `#agent-activity`;
   the correction has not yet had a browser confirmation. Test Activities agent
   scope and request navigation too. Simple tab changes retain agent/request/path;
   changing agent clears an unrelated request unless explicitly replaced.
4. Finish the new `dashboard-t04.test.tsx` and `session-domain-store.test.tsx`
   suites. Audit removed Dashboard navigation/loading, desktop-controls,
   report-export and progressive-readiness tests: preserve their still-applicable
   behavior in replacements, including export failures, Pause, history/privacy,
   readiness and scope transitions. Do not treat deleted assertions as fixes.
5. Obtain final independent Sol acceptance, run focused regressions, then run
   host/escalated `npm test` (includes build) and `npm run verify:fast` serially.
   Resolve every failure, run final diff/document checks, update this handoff,
   and only then mark Session 2 complete. Stop before Session 3.

Latest actual verification:

- T05: `npx vitest run tests/ui/agents-tab.test.tsx tests/ui/agent-roster.test.tsx
  tests/ui/agent-roster-groups.test.ts tests/ui/agents-view.test.tsx` passed
  40 tests in four files. TypeScript and diff check passed; independent Sol
  accepted the corrected source and its narrower 37-test selection.
- T04 reported TypeScript passing before the latest transport/test edits.
  Final T04 focused results have not been handed off. No integrated `npm test`
  or `verify:fast` ran after T04/T05 implementation; earlier full passes below
  certify T03 only.
- Parent `npm run lint` passed with zero errors and 16 existing warnings
  (`outputs/ia-session2-integration-lint.log`); architecture passed for 726
  source files; provider documentation check passed. The earlier boundary run
  failed only on orphan SessionCommandBar, since removed; rerun is required.
- Parent `node --test tests/session-domain-store.test.mjs` passed 10 tests
  (`outputs/ia-session2-domain-test.log`). All nine local Markdown file links
  across this plan, OBSERVATION_CACHE and DESIGN resolve.
- Main/Mobile and SessionAgents/Mobile comparisons passed after one correction
  batch. Phone context computed weight is 400; visible tab width equals scroll
  width and all five tab targets are 44px. T03 comparisons are recorded below.

Temporary browser tabs were closed, viewport reset, and owned dev/prototype
servers stopped. Logs and the prototype helper remain ignored under `outputs/`.
T04 experienced one temporary Sol-capacity error and successfully resumed before
this user-requested stop. No model above Sol was used by delegated workers.

2026-09-14 · Session 2 partially implemented under explicit authorization, then
checkpointed at the usage-guard handoff threshold. Terra implemented T03; Sol
performed a read-only T04 preparation and independently reviewed T03. No worker
used a model above Sol. At that earlier checkpoint T04 and T05 had no changes;
the active checkpoint above supersedes that implementation status.

Starting branch: `main`; HEAD: `3b116ada46ca91667e7b7378ce974bd0337770b0`.
Pre-existing edits in `docs/COMMERCIAL_STRATEGY.md`,
`docs/plans/mobile-pairing-cloudflare.md`, and
`docs/plans/remote-platform-and-orgs.md` are unrelated and must be preserved.
All changes remain uncommitted. The session checkbox stays unchecked until T04,
T05 and final integrated acceptance also pass. No commit or push was performed.

The baseline `npm run verify:fast` passed before implementation (zero lint errors,
16 warnings; 717-source architecture check; 476 modules / 1,455 dependencies).
Log: ignored `outputs/ia-session2-baseline.log`.

T03 behavior and ownership:

- `app/components/command-center/CommandPage.tsx` exports `CommandPageHeader`
  with breadcrumb, title, meta, actions and tabs slots; `CommandPage` remains the
  compatible wrapper. Shell breadcrumbs are removed. Session header adoption is
  deliberately left to T04.
- `CommandCenterShell.tsx` owns the 280px/200px/phone-icon palette trigger,
  normalized recent session/repository results, combobox/listbox keyboard
  selection, contained focus and Escape restoration. Both keyboard and pointer
  openers close other shell overlays. New buttons compose `commandQuietAction`.
- Sidebar limits use catalog sessions created in the last seven days and the
  tightest active provider window. Inactive-only windows are omitted. Text and
  bar fills share the 75/85-percent severity thresholds. This is shell data,
  separate from historical session evidence.
- `CommandViews.tsx`, `app/HomeDashboard.tsx`, `app/hooks/useHomePreferences.ts`,
  `app/components/agents/AgentsView.tsx`,
  `app/components/repositories/RepositoryDetailView.tsx` and
  `app/settings/SettingsPage.tsx` adopt the shared header/navigation. The
  Sessions filter segment occupies the actions slot; search remains below it.
  `app/dashboards/page.tsx` redirects to Home; old navigation, pins and
  `tests/ui/dashboards-view.test.tsx` are removed. LAN redirect access remains.
- `app/styles/shell.css`, `workspace.css`, `evidence.css`, and `design-system.css`
  implement responsive shared controls and transparent outline chips.
  `DESIGN.md`, `app/components/design-system/DesignSystemView.tsx`,
  `tests/rendered-html.test.mjs` and UI tests for app shell, design system,
  design contract, Home preferences, repository detail and Sessions were updated.

Visual verification: parent compared HeaderStandard against the
running app at 1440, 900 and 390 pixels; corrected misplaced desktop search,
missing phone search, and the overlapping tablet Sessions header. Light Settings
also rendered correctly; the original dark theme was restored. Keyboard smoke
covered Ctrl K, filtering, Enter navigation and Escape focus restoration;
the actual `/dashboards` route redirected to `/`. Accepted visual differences:
the incumbent painted brand, 220px rail, local-profile placeholder and page
descriptions remain under DESIGN.md; search stays below the Sessions header.
The prototype's explanatory labels and placeholder values were not added.

Verification and independent review:

- The initial full `npm test` passed its build, plugin, operations, inventory
  and Node stages (1,168 Node tests passed, one opt-in test skipped), then
  failed 11 UI tests across four files (725 passed).
  Log: `outputs/ia-session2-t03-test.log`. All eleven failures were repaired.
- After correction, `npm run test:ui` passed all 738 tests across 81 files;
  targeted app-shell passed 19 tests. `npm run verify:fast` passed with zero
  lint errors and 16 existing warnings. Parent `npm run build` passed on the
  corrected tree (`outputs/ia-session2-t03-final-build.log`).
- Sol re-reviewed its six initial findings against the frozen diff and found
  all resolved: tests, modal focus/ARIA, severity fills, common palette opener,
  button roles, and active-window selection. Normalized data sources,
  historical isolation, LAN redirect access and chip contracts also passed.
- The final full `npm test` passed against the corrected frozen tree: build,
  plugins, operations, inventory, 1,168 Node tests (one opt-in skip), and all
  738 UI tests in 81 files. Log: `outputs/ia-session2-t03-final-test.log`.
  T03 is verified and independently accepted; no T03 findings remain.
- `git diff --check` passed. The plan's local file link resolves; handoff anchors
  and ownership references were inspected. The baseline and final fast verifier
  retain the same 16 pre-existing lint warnings.

T04/T05 integration contracts: reuse `CommandPageHeader` with session tabs below
the KPIs. The browser store retains exact-query bodies and revisions, one shared
SSE listener and current plus two recent sessions under the canonical cadence.
Header/KPIs/Overview consume summary-native data only; transitional existing
panels mount only behind their selected tabs. T05 consumes `agents` and selected
`agent` domains. Status counts come from normalized summary metadata, never
inference from the bounded Right now rows. Tab changes preserve query scope;
changing agent scope clears an unrelated selected request.

Resume owners: Sol T04, separate Sol independent acceptance; Terra T05 is
accepted. The coordinator owns final integration checks. Workers are stopped;
the checkpoint above lists remaining corrections and completed preview cleanup.
Logs/scripts remain ignored under `outputs/`.

### Session 1 handoff

2026-09-14 · Post-acceptance runtime correction: PR #24 exposed a missing development
transport check. The proxy returned precompressed gzip without the Workers manual-body
option; the Cloudflare-backed dev server encoded it again and the browser received
unparseable catalog/state bodies. `encodeBody: "manual"` now prevents the second pass.
The actual `localhost:3003` catalog, live session dashboard/request chart and Usage limits
loaded successfully after the fix. A real Miniflare/workerd regression is wired into
`test:node`; removing the option reproduced the failure during test development.
The full `npm test` (including build and 738 UI tests), `verify:fast`, and production
gzip/identity/204 wire checks passed. The earlier Windows CI short-path assertion was
separately fixed in `b939370`; its Windows verifier and desktop smoke passed. These are
Session 1 corrections; no later implementation session has started.

2026-09-14 · **T02 and T01 complete.** Sol owned the domain foundation and independent
reviews; Terra owned browser transport and bounded supporting work. The coordinator
integrated T02 before T01 and ran the final checks. All delegated models stayed within
the Sol-or-cheaper ceiling. No Session 2 implementation started.

Changed ownership areas:

- Domain contracts and committed projections: `shared/session-domain-contract.ts`,
  `monitor/session-domain-projection.mjs`, `monitor/session-domain-store.mjs`,
  observation runtime, request handler and `app/api/session-domain/route.ts`.
- Request-range history and privacy: `shared/session-history-contract.ts`,
  `monitor/session-history-groups.mjs`, history store, dedicated repository-path
  validator, Git-root enrichment, and focused domain/history/path serialization tests.
- Transport: `app/live-events.ts`, history publications, AppShell, Dashboard,
  Activity/Requests hooks, request preload, shared repository inventory, JSON proxies
  and paired-LAN forwarding, with matching UI and HTTP regressions.
- Authorities and verification: `docs/OBSERVATION_CACHE.md`, `docs/ARCHITECTURE.md`,
  canonical test wiring in `package.json`, and generated-prototype exclusions in
  `eslint.config.mjs` and `scripts/check-architecture.mjs`. The reproduced baseline
  had 36 errors and 6,628 warnings in exported vendor/support scripts; only that
  generated boundary was excluded. Application rules remain enforced.

Contracts for the next UI session:

- `GET /api/session-domain?sessionId=&domain=&agentId=&revision=` exposes
  `session-summary`, `agents`, `agent`, `signals`, `repository`, `resources`
  and `details`. Use normalized `agentId` for the inspector. Each domain has an
  independent semantic revision and readiness; mixed domains also expose section
  readiness. The summary includes bounded header/Overview data, the inspector includes
  selected-agent evidence, and Signals includes readiness-qualified Flow inputs.
- Domains stage complete replacements atomically, retain last-known-good state, restore
  from committed checkpoints, and rebuild evicted projections asynchronously from
  committed state. Their cache retains 24 sessions with ten-minute idle eviction.
  File-history and retained-resource producers remain explicitly unavailable.
- `/api/session-history` preserves flat queries and adds five scoped request groups
  around `selected`. Optional `from`/`to` bound at most 64 request numbers;
  `scope`, one `workKind`, and opaque `continuation` preserve recorded associations.
  Limits are 50 nested calls per group and 200 per page; continuation makes progress
  without removing selected headers. History index version 3 upgrades old indexes.
- SSE publishes domain/session/revision and history totals. `catalog` events use
  domain `sessions`; repositories are global. Reuse the ref-counted singleton;
  subscribe only while mounted. It validates events, retains at most 256 revision
  keys per connection epoch, and treats only real stream open as connected.
- Matching revision or ETag returns bodyless 204. Send a revision only for an exact
  query with a retained body. JSON proxies support gzip and `Vary`; LAN forwarding
  preserves negotiation. Keep composed `/api/state` until the planned UI migration.
- Live consumers use event invalidation and 30-second connected/hidden fallback,
  five seconds reconnecting, and one second for unresolved foreground live data.
  Historical hydration uses events/reconnect without periodic timers. Hidden events,
  in-flight invalidations, unavailable recovery and cached navigation retain pending
  work; pinned viewports keep their selection while totals advance. Account/provider
  and global analytics store exceptions are listed in the canonical cadence table.

Verification and review:

- `npm test` passed, including the production build, plugin suites, 1,166 Node
  tests and 738 UI tests across 82 files. Default skips were two file-symlink
  cases unavailable on this host and the explicitly opt-in native Codex writer test.
- `npm run verify:fast` passed: zero lint errors (16 warnings), typecheck,
  provider/documentation checks, 716-source architecture check, and dependency
  boundaries (476 modules, 1,455 dependencies). `git diff --check` passed; all 13
  local file links in the plan and changed authority documents resolve.
- Independent Sol backend and browser acceptance passed with no remaining findings.
  Focused evidence includes 159 browser tests, 35 transport/history tests, per-domain
  allowlists, cache-only GETs, checkpoint/path privacy, atomic retention, historical
  isolation, real bodyless 204 recovery, event races and hidden/foreground recovery.
- The accepted production build, one live browser tab and a settled synthetic session
  made **11 HTTP requests in exactly sixty seconds**, below the target of fifteen.
  There was one active/maximum SSE stream. Breakdown: state 2, catalog 2, history 4,
  provider status 2, usage limits 1. Real web-route ETag/204 and gzip smoke checks passed.
  Ignored evidence: `outputs/ia-session1-accepted-test.log`,
  `outputs/ia-session1-accepted-verify-fast.log`, and
  `outputs/ia-quiet-accepted-measurement.json`. Temporary browser/server were closed.
- Artboards: none for T01/T02; no new visual controls or accepted visual deviations.

Verification branch `docs/ia-redesign-plan`, base HEAD `1b84bf02854312a9797736f5386916b7ffeaab82`.
Changes were uncommitted at acceptance; this handoff accompanies the Session 1 commit.
Pre-existing documentation and prototype-export work was preserved. There are no remaining Session 1 findings. Session 2 (T03, T04, T05)
is the next unchecked item and is intentionally left for a fresh user-started session.


- 2026-09-14 · Orchestration finalized: six ordered session checkboxes map every remaining task to one implementation session. Fresh sessions take the first unchecked item, preserve partial progress, use Sol-or-cheaper workers with bounded nested delegation, verify before checking completion, and stop before the next item. No implementation started; Session 1 is next. This update changes the plan only.
- Orchestration verification: all six session checkboxes are present, ordered 1–6 and unchecked; the plan's local Markdown link resolves; `git diff --check` passed. `npm run verify:fast` was rerun and still stops at lint with 36 errors in exported prototype runtime files (6,628 warnings overall). Session 1 owns resolving that baseline blocker. No implementation checks are marked complete.
- 2026-09-14 · Documentation reconciliation and T00 prerequisite policy complete: Activities/Signals and inspector decisions folded into tasks; former T04b absorbed by T06 and T06b added; phone rules, anchored selection, soft storage threshold and usage bar recorded. AGENTS.md, OBSERVATION_CACHE.md and METRICS.md now own the approved file-history privacy and historical repository prerequisites, explicitly marked as not shipped. Prototype README reconciled; artboards unchanged. Runtime implementation remains pending. User implementation/model constraints saved above.
- Verification for this documentation update: `git diff --check` passed; `npm run check:provider-docs` passed; all 14 local Markdown links in the plan and prototype README resolve. A bounded independent plan review found no remaining decision conflicts. `npm run verify:fast` failed at lint on 36 errors in the existing exported prototype vendor/support JavaScript; later stages did not run. Those generated exports were already present before this update and were not changed. No build, runtime privacy tests or visual comparison was claimed for this documentation-only task. Resolve the verifier blocker before accepting implementation tasks.

- 2026-09-15 · Canvas version 47: phone Activities call lines became thin 32px icon/target/duration rows; tapping one expands its details in place beneath the line (version 49 replaced the earlier bottom-sheet idea; version 50 trimmed the block to chips plus five rows and kept the pre-existing request selection on tap); a sixth phone frame shows the expanded state. Desktop call rows are unchanged. The phone rules in Agreed decisions and T06 now carry the row height exception and the sheet contents.
- 2026-09-14 · Design exports reached canvas version 46. Desktop Activities and Signals, the retained agent inspector, and five phone screens were approved; the current decisions and tasks above now own those rules. Existing exports were subsequently placed in the artboard folders linked by the prototype README. No exports regenerated in the documentation reconciliation.
- 2026-09-13 · Initial codebase/design validation established privacy pre-work, T02 before T01, the SQLite resource-history approach, full-height artboards, role-family tints, and usage-limit thresholds. The current plan supersedes earlier navigation and storage wording. No runtime implementation completed.
- Checkpoint format for implementation: task id, completion date, changed behavior and files, actual verification commands/results, artboard comparison with accepted deviations, and remaining work. Delete this plan and its temporary assets at T12 after enduring rules and follow-ups have owners.
