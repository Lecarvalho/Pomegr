# IA redesign prototype

Standalone exports of the approved design canvas (version 38, 2026-09-14) for the
[information architecture redesign plan](../../ia-redesign.md). Open any file in a
browser; each is a full-height artboard using the dark theme values from
`app/styles/tokens.css`. Sample data comes from one real session and invented file
names; treat every number as placeholder.

The plan is authoritative. Where a drawing or a note below differs from it, follow
the plan, including its list of prototype-only elements that must not ship.

Live canvas (editable, requires claude.ai access): https://claude.ai/code/artifact/eb54dd04-0c68-450d-8c04-ab4776816fd9

## Artboards

- [0 · Header standard](HeaderStandard.html)
- [1 · Proposed sitemap](Sitemap.html)
- [2 · Session overview (L1)](Main.html)
- [3 · Session › Agents tab (L2): roster and selected-agent pane](SessionAgents.html)
- [5 · Session › Signals tab (L2)](SignalsTab.html)
- [6 · Phone overview](Mobile.html)
- [7 · Session › Repository tab (L2)](RepositoryTab.html)
- [8 · Repository › Files tab (file history)](RepoFiles.html)
- [9 · Session › Resources tab (L2)](ResourcesTab.html)
- [10 · Session › Details tab (L2)](DetailsTab.html)
- [11 · Settings › Storage (T13)](SettingsStorage.html)
- [12 · Session › Activities tab (L2): requests and their tool calls](ActivityTab.html)

## Canvas notes

These notes sat beside the artboards on the canvas and carry decisions the drawings cannot show.

### Today

Today: /sessions/:id stacks 12 panels with no tabs. Cache badges render in 4 places, agent status in 4, context in 4. Session page never links to an agent page; /agents drops agentId when linking back.

This canvas: same tokens as app/styles/tokens.css (dark theme), same six button roles, same chip contract.

### Traffic

Traffic today, one live tab, 60s: about 85 requests. state 30, activity 20, requests 20, sessions catalog 12, plus 2 SSE streams. Every /api/state carries every section whether visible or not. Tabs fix this structurally: only the mounted tab polls.

### Lanes

Agent lanes: one row per agent, bars share the request order so the window and minimap stay one control. Each lane uses its own scale (max printed top right) so small subagent requests stay readable; hovering a bar shows the absolute count. Beyond 8 lanes: collapse to one lane per workflow group, expand on click, or click a lane name to focus it. Minimap is neutral grey.

Single chart stays as a toggle for people who want the old view; it gets the agent track from the overview.

### Header

Session header = hero + KPI strip, identical on every tab (no collapsed variant). Overview is the first tab and holds Right now, signals, repository one-liner, request strip and progress. Nothing session-specific sits above the tab bar except the header.

### Limits

Sidebar limits: one line per provider that has sessions this week, showing only its tightest window. Colors follow the METRICS.md usage-limit rule: normal to 74%, warning 75 to 84%, critical 85% and up. Cursor appears the same way once its adapter reports windows. Full windows live on the Usage limits page. Historical sessions never render this widget as session data; it is shell chrome.

### Repository

Session Repository tab reuses the Files layout: same tree component scoped to files this session touched, same file history panel on the right. The session tree shows only a status chip and the file name, with no edit counts and no agent dots; agent names appear in the file history panel entries. Uncommitted files nobody here touched sit under Changed elsewhere. Branch, comparison, PR and git-task counts collapse into one bar; commit lists and repo-wide history live on the repository Git tab.

### File history

One file-change record: repository, path, session, agent, kind, time. Repository Files tab groups it by file (tree with distinct session counts). Session Repository tab groups it by session (tree with status chip and name only). The right-hand File history panel is the same component in both, with the current session highlighted on the session side.

Deep links: /repositories/:id?tab=files&path=... and /sessions/:id?tab=repository&path=... so each side can open the other on the same file.

### Live window

Live behavior (spec, not drawable): the chart keeps advancing while live even with a selection. A selected bar drifts left as new requests arrive, stops at the left edge of the window and stays selected there. The minimap window stays put while its right side keeps growing, so the user sees there is newer data to drag towards. Dragging the window right hands the selection to the nearest bar on the left edge of the viewport, as today. No pinning that freezes the chart.

### Agent chart

Agent detail mounts the same request chart in single-chart mode with the scope fixed to this agent: one lane, own scale, minimap, request detail. Nothing new to build once the session tab exists.

### Resources

Resources: three sparklines with current and peak, window 5 min / 30 min / Session, and a peaks table matched to activity by time overlap. Clicking a peak zooms into its stored full-resolution window (2 min either side of the top peaks). The request active at the peak links with its uncached-input count, worded as adjacency, never as task cost. No process table: no per-process data source exists. Historical sessions read the Session window and peaks from the monitor store.

### Details

Details: session facts, one-shot transcript path copy, flow score with its two inputs, cost estimate, and the context inventory inline instead of a popover. Usage limits left this tab for the sidebar.

### Phone

Phone: five tabs fit without scrolling. Requests, Resources and Details sit behind More. Tab bar sticks under the KPIs.

### Storage

Storage (T13): one SQLite store owned by the monitor holds file history and resource history. Minute aggregates keep min/avg/max plus the exact time of the max; raw samples survive only around the top peaks. Retention: fixed age choices (30/90/180/365/keep all, default 90) and a size cap (default 500 MB). Past the age, curves and peak windows go; peaks and file changes stay while the session is in the catalog. Desktop-only edit, native confirmation, never from the browser or LAN.

### Role tints

Agent track colors by role family, not by agent: primary neutral grey, reading (explore, researcher) blue, planning teal, writing ochre, reviewing rose, generic and system grey. Fixed palette from the bounded role enum; same-role agents share a tint; legend shows families with counts; hover names the agent. Status dots stay status colors.
