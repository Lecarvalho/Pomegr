# IA redesign prototype

Standalone exports of the approved design canvas (version 46, 2026-09-14; `Mobile` regenerated from version 50, 2026-09-15) for the
[information architecture redesign plan](../../ia-redesign.md). Serve an artboard folder and open its `.dc.html` file in a browser (see its local README); each is a full-height artboard using the dark theme values from
`app/styles/tokens.css`. Sample data comes from one real session and invented file
names; treat every number as placeholder.

The plan owns implementation decisions within the repository's current contracts.
Where a drawing differs, follow the plan and the explicit overrides below.
Only the `Mobile` export was regenerated for version 50 (thin 32px phone call lines that expand in place). On 2026-09-20 the `Main`, `SignalsTab`, `RepositoryTab` and `Mobile` exports were regenerated from version 53 and `OverviewSparse` was added, for the [overview sparse state and link rule plan](../../overview-sparse-and-links.md); their only drawing changes are the link treatment described under [Links](#links) and the new sparse artboard. The remaining exports are version 46.

Live canvas (editable, requires claude.ai access): https://claude.ai/code/artifact/eb54dd04-0c68-450d-8c04-ab4776816fd9

## Artboards

- [0 · Header standard](HeaderStandard-html/HeaderStandard.dc.html)
- [1 · Proposed sitemap](Sitemap-html/Sitemap.dc.html)
- [2 · Session overview (L1)](Main-html/Main.dc.html)
- [2b · Session overview (L1): sparse state, session just started](OverviewSparse-html/OverviewSparse.dc.html)
- [3 · Session › Agents tab (L2): roster and selected-agent pane](SessionAgents-html/SessionAgents.dc.html)
- [5 · Session › Signals tab (L2)](SignalsTab-html/SignalsTab.dc.html)
- [6 · Phone: Overview, Agents, agent sheet, Activities, expanded call, More sheet](Mobile-html/Mobile.dc.html)
- [7 · Session › Repository tab (L2)](RepositoryTab-html/RepositoryTab.dc.html)
- [8 · Repository › Files tab (file history)](RepoFiles-html/RepoFiles.dc.html)
- [9 · Session › Resources tab (L2)](ResourcesTab-html/ResourcesTab.dc.html)
- [10 · Session › Details tab (L2)](DetailsTab-html/DetailsTab.dc.html)
- [11 · Settings › Storage (T13)](SettingsStorage-html/SettingsStorage.dc.html)
- [12 · Session › Activities tab (L2): requests and their tool calls](ActivityTab-html/ActivityTab.dc.html)

## Implementation notes

These notes reconcile the canvas with the decisions approved on 2026-09-14.
The exported drawings remain unchanged; this text records behavior they cannot show.

### Baseline observed 2026-09-13

At that baseline: /sessions/:id stacks 12 panels with no tabs. Cache badges render in 4 places, agent status in 4, context in 4. Session page never links to an agent page; /agents drops agentId when linking back.

This canvas: same tokens as app/styles/tokens.css (dark theme), same six button roles, the intended outline-chip treatment (the app's base fill changes in T03).

### Traffic

Traffic today, one live tab, 60s: about 85 requests. state 30, activity 20, requests 20, sessions catalog 12, plus 2 SSE streams. Every /api/state carries every section whether visible or not. Domain responses and the shared event stream reduce this traffic: mounted views subscribe to their domains, with explicit fallback polling. The persistent header and shell keep independent subscriptions.

### Lanes

Agent lanes: one row per agent, bars share the request order so the window and minimap stay one control. Each lane uses its own scale (max printed top right) so small subagent requests stay readable; hovering a bar shows the absolute count. Beyond 8 lanes: collapse to one lane per workflow group, expand on click, or click a lane name to focus it. Minimap is neutral grey.

Desktop has Lanes / Single chart; single chart includes the role-family track. Phone always uses single chart with no lane toggle. Lane labels are 220px with ellipsis and a full name/role/model tooltip; no role-colored dots beside agent names.

### Header

Session header = hero + KPI strip, identical on every tab (no collapsed variant). Overview is the first tab and holds Right now, signals, repository one-liner, request strip and progress. Nothing session-specific sits above the tab bar except the header.

### Sparse overview

The overview does not reserve space for evidence that does not exist yet (artboard 2b). The Requests strip always has the same number of slots as the full state, so a bar is the same width with 5 requests as with 48; unused slots show only the baseline and an empty role-track cell. With one or two agents, Right now spans the full width and sizes to its rows, with signals and repository side by side below; from three agents up the two-column layout of artboard 2 returns. A panel with no evidence is not rendered: without a progress estimate or plan tasks there is no Progress panel, and Work by kind and Cost share the row. Sub-minute medians are omitted. The latest-context meter drawn on the 2b agent row is not approved for implementation: the session summary exposes no context-window size for its Right now agents, so the app prints the latest context count only.

### Links

Decision 2026-09-20. A panel whose content continues on a tab uses its heading as the link (title plus a muted chevron, ink on hover) with no header-right link; a count the old link carried moves next to the title. Evidence rows are the link: the whole row opens its events in Activities and ends in a muted chevron, request numbers inside a row are plain mono ink, and a second destination is a quiet action (**Show agent**). Leaving the session for another page is a quiet action with a chevron. The brand text link stays for expanders and at most one in-content pointer per panel. On phone the heading link keeps a 44px tap box.

### Limits

Sidebar limits: one line per provider that has sessions this week, showing only its tightest window. Colors follow the METRICS.md usage-limit rule: normal to 74%, warning 75 to 84%, critical 85% and up. Cursor appears the same way once its adapter reports windows. Full windows live on the Usage limits page. Historical sessions never render this widget as session data; it is shell chrome.

### Repository

Session Repository tab reuses the Files layout: same tree component scoped to files this session touched, same file history panel on the right. The session tree shows only a status chip and the file name, with no edit counts and no agent dots; agent names appear in the file history panel entries. Uncommitted files nobody here touched sit under Changed elsewhere. Branch, comparison, PR and git-task counts collapse into one bar; commit lists and repo-wide history live on the repository Git tab.

### File history

One file-change record: repository, path, session, agent, kind, time. Repository Files tab groups it by file (tree with distinct session counts). Session Repository tab groups it by session (tree with status chip and name only). The right-hand File history panel is the same component in both, with the current session highlighted on the session side.

Deep links: /repositories/:id?tab=files&path=... and /sessions/:id?tab=repository&path=... so each side can open the other on the same file.

### Live window and correlation

History and minimap totals keep growing as requests arrive. The viewport may advance only while keeping the selected request visible; once it reaches the left edge, anchor the viewport. Never draw that request at a false position or leave details for a bar outside the viewport. The selected bar, request details and Activities feed stay correlated.

Dragging past selection hands it to the nearest visible bar (left edge when moving right), and the details and feed update together. Jump to latest reveals and selects the latest request. Paging, filtering and keyboard navigation obey the same rule. Keep the old correlated view while a new range loads, or use a coordinated loading state. Anchoring the viewport does not pause observation.

### Activities, Signals and agent inspection

Activities combines the Requests chart, Largest strip and five request groups around selection, with calls nested under each request. Agent scope applies to the whole tab. Desktop puts Actions by kind, Shell tasks and Failed shell runs in the left rail as read-only summaries. Previous / Next / Jump to latest keep the chart and feed aligned. Fed by / Called tallies are removed.

Signals owns efficiency signals, cache evidence, flow score with its inputs, per-agent cache lifetime and agent-reported MCP signals. Preserve observed/inference/attributed qualifiers and distinguish agent reports from deterministic rules. Signals links to the matching request in Activities, never to a separate Requests tab.

Agents keeps the roster and selected-agent inspector. Deep links are `/sessions/:id?tab=agents&agent=<id>` and `/sessions/:id?tab=activities&agent=<id>&request=<n>`. There is no agent detail route or separate agent chart. Models & delegation links retain the agent id.

### Resources

Resources: three sparklines with current and peak, window 5 min / 30 min / Session, and a peaks table matched to activity by time overlap. Clicking a peak zooms into its stored full-resolution window (2 min either side of the top peaks). Link an unambiguously associated request with its request-local uncached-input count, labeled as a nearby observation, never task cost or proof that the request was executing at that instant. No process table: no per-process data source exists. Historical sessions read retained Session curves and peaks from the monitor store. If age or size cleanup removed curves, show the peaks and the correct retention explanation; hide the tab only if no live samples or stored rows exist.

### Details

Details contains session facts, one-shot transcript path copy, cost estimate, and inline context inventory. Flow score and its inputs are on Signals; usage limits are shell chrome.

### Phone

Phone (2026-09-14 tab set): five tabs fit 390px without scrolling: Overview, Agents, Activities, Repo, More. More is a bottom sheet holding Signals, Resources and Details; each entry is the same ?tab= URL as on desktop. Tab bar sticks under the three KPIs. Agents: the roster only, List / Grid segment (no Tree), no column header row; the Direct subagents group is one 48px line with its values (count · context · active) at the right, as today; tapping a row opens the agent inspector as a full-viewport sheet with a Back header, as the app does today (no side pane, no agent route). Context counts are regular weight in the primary text color. Activities: always the single chart on phone (no lanes, no Lanes / Single chart toggle) with the agent track and role legend under the bars, minimap, Largest strip, then the feed, with Actions by kind and Shell tasks below it; the feed shows five requests around the selection, one quiet 44px line per request (agent, role, uncached input, time) and one thin 32px line per tool call (kind icon, target, duration; version 50). Tapping a call line still selects its request as before and additionally expands a detail block in place beneath it (kind/status chips, Kind, Wall duration, Called, Result, Agent), one open at a time, with no sheet or popover; the other request counts live in the request detail. Hit targets 44px except the 32px full-width call line, the single documented dense-list exception.

### Storage

T13 adds a usage bar beside **Resource history cleanup threshold**, with used/threshold and percentage (illustrative: **380 MB / 500 MB · 76%**). Fixed threshold choices are 250 MB, 500 MB, 1 GB and 2 GB; default 500 MB. The bar is informational. Values are read-only in browser/LAN; desktop changes use native confirmation.

At 100%, the next prune cycle can remove older resource curves and detailed sample windows. File history and recorded peaks remain while the session is cataloged. This is a soft threshold: if protected records alone exceed it, keep writing and preserving them. Cap the bar fill at 100% but print the true percentage (illustrative: **550 MB / 500 MB · 110%**); use **Cleanup pending** until the monitor confirms **Preserved history exceeds the cleanup threshold**.

Age retention (30/90/180/365 days or keep all, default 90) independently removes curves and detailed windows. Missing readiness is unavailable, never 0%. The usage bar and soft-threshold wording are approved additions to the existing SettingsStorage export, not a claim that the drawing was regenerated.

### Role tints

Agent track colors by role family, not by agent: primary neutral grey, reading (explore, researcher) blue, planning teal, writing ochre, reviewing rose, generic and system grey. Fixed palette from the bounded role enum; same-role agents share a tint; legend shows families with counts; hover names the agent. Status dots stay status colors.

## Accepted drawing differences

- Use Activities and Signals, the existing Agents inspector, and the current phone More sheet. Follow the plan if any label, link or sitemap still implies a separate Requests tab or agent page.
- Remove role-colored dots from lists; role tints belong only in the agent tracks and legends. Status dots keep their lifecycle meaning.
- Phone's selected request has the approved brand-colored left rule; retain the reserved compaction-label band and the short caveat popover.
- Historical Resources can show retained curves, not only peaks. The process table remains deferred.
- Storage gains the usage bar and soft-threshold wording above. No new artboard is required before using the existing controls and design contract.
