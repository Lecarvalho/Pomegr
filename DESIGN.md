---
name: Pomegr
description: A local-first Command Center for observing coding-agent sessions.
colors:
  charcoal-canvas-dark: "#111315"
  charcoal-panel-dark: "#191c20"
  charcoal-raised-dark: "#23272d"
  light-canvas: "#f3f4f5"
  light-panel: "#ffffff"
  light-raised: "#e9edf1"
  text: "#20252b"
  muted: "#525b66"
  line: "#d4d9df"
  control-line: "#7b8592"
  brand-fill: "#a63c32"
  brand-text: "#994238"
  green: "#376e4b"
  amber: "#815710"
  context: "#6d6099"
  semantic-error: "#a43440"
  focus: "#255fa1"
typography:
  title:
    fontFamily: "Inter, sans-serif"
    fontSize: "26px"
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  section:
    fontFamily: "Inter, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.35
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "Inter, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
  metadata:
    fontFamily: "Inter, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  caption:
    fontFamily: "Inter, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
  data:
    fontFamily: "Geist Mono, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  control: "4px"
  panel: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  primary-action:
    backgroundColor: "{colors.brand-fill}"
    textColor: "#ffffff"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "36px"
  secondary-action:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    border: "1px solid {colors.line}"
    typography: "{typography.metadata}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  segmented-action:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    border: "1px solid {colors.line}"
    typography: "{typography.metadata}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "30px"
  quiet-action:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.metadata}"
    rounded: "{rounded.control}"
    padding: "0 6px"
    height: "28px"
  text-link:
    backgroundColor: "transparent"
    textColor: "{colors.brand-text}"
    typography: "{typography.metadata}"
    padding: "0"
  icon-action:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "0"
    height: "32px"
  evidence-panel:
    backgroundColor: "{colors.light-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "16px"
---

# Design System: Pomegr

## Overview

Settings includes a **Providers** section before **Data display** in the desktop
app and browser.
Compose the existing settings rows, button roles, and native Advanced disclosure:
Claude configuration first, its optional session override inside Advanced, then
Codex home. Show only bounded source selection and folder availability in the
renderer; native folder and confirmation dialogs display the paths. The sole
primary commitment is **Save and restart Pomegr**; choosing, resetting, and
discarding remain secondary/quiet actions. Folder settings are independent of the
header's display-preference reset. This is a feature composition of existing
controls, not a new shared control or visual authority.

The browser view shows effective provider folder roots in read-only text fields
with no choose, default, discard, or save actions. Fields support selection and
copying. Explain that changes require the desktop app. Missing roots show
**Path unavailable**; temporary read failures offer **Retry**. Denied browser reads
show **Use paired LAN access to view provider folders.** without a retry action.
Local browsers and authenticated,
paired LAN browsers may view these paths. This replaces the temporary synthetic web preview. Desktop path
display remains in native dialogs.

Settings includes a **Storage** section directly after **Providers** and before **Data display**,
always present in desktop, browser, and paired LAN — unlike Providers and Phone access, it is never
conditionally hidden. It reuses the settings-row geometry inside one bordered panel: a five-way
`.commandSegmented` retention-age control (`30 days`, `90 days`, `180 days`, `365 days`, `Keep all`), a
`CommandSelect` cleanup-threshold field (`250 MB`, `500 MB`, `1 GB`, `2 GB`), the shared storage usage
meter described below, and a read-only storage-status line sourced from `GET /api/storage`. Retention and
threshold are desktop-only edits through the native storage-settings bridge, applied on the monitor's next
prune cycle; the browser and paired LAN views render the identical controls disabled, showing the
monitor's current values, with the existing `.providerSettingsGuidance` read-only note and no footer. The
desktop footer reuses `.providerSettingsFooter`'s **Discard changes** / **Save and restart Pomegr** roles
and messaging exactly as Providers does. This is a feature composition of existing controls, not a new
shared control or visual authority.

The storage usage meter (`StorageUsageBar`, `.storageUsageBar`) is a small shared informational pattern
also rendered at `/design-system`: a `--font-data` numeric line reading `<used> / <threshold> · <pct>%`, a
6px `--command-panel-2` track (`.storageUsageTrack`) with its fill clamped to 0–100%, and a muted
explanatory line. The track carries `role="meter"` with `aria-valuemin`, `aria-valuemax`, and
`aria-valuenow` all clamped to 100, and `aria-valuetext` equal to the numeric line; it is informational
only, never focusable and never a slider. A store over its threshold still prints its real percentage in
text (`550 MB / 500 MB · 110%`) while the fill visually clamps at 100%. When readiness is missing,
`loading`, `unavailable`, or the byte/percent fields are `null`, the meter reads **Storage usage
unavailable** with an empty track, no `role="meter"`, and no `aria-valuenow` — it never renders `0%` for
missing evidence. A `role="status"` line beneath it names `cleanupStatus`: **Cleanup pending** or
**Preserved history exceeds the cleanup threshold.**; the ordinary state renders nothing.

**Creative North Star: "The Measured Command Center"**

Pomegr is a local-first, read-only observer that makes coding-agent activity legible without exposing the underlying conversation. The application is a calm evidence workspace: a compact branded header, persistent route rail, flat panels, one-pixel rules, and restrained semantic color give the operator a reliable scan order. The approved HTML preview in `docs/design/pomegr-ui-preview.html` is the code-led authority for this application refresh; no generated component or seed is required.

The application shell keeps its identity provider-neutral and preserves the existing normalized content, privacy boundary, and metric semantics. Landing/marketing remains independently scoped and may retain its own typography and brand treatments; do not promote landing decisions into the app shell.

**Key Characteristics:**

- Charcoal dark mode with light neutral mode using the same layout and semantic roles.
- Inter for all UI hierarchy; Geist Mono for data and execution metadata.
- Flat evidence surfaces with 4px controls, 6px panels, and restrained borders.
- A 60px header and 220px desktop rail, with compact and mobile adaptations.
- Neutral idle states; semantic error red is reserved for actual error states.
- Provider-neutral, read-only language and honest unavailable/coming-soon states.

## Colors

The app palette is a quiet neutral field with pomegranate identity ink and semantic signals taken directly from `app/styles/tokens.css`.

### Primary

- **Pomegranate fill** (`#a63c32`): primary action surfaces.
- **Pomegranate text** (`#994238` light, `#e58b80` dark): links, selected emphasis, and compact text actions.

### Secondary

- **Green** (`#376e4b` light, `#91c5a4` dark): monitor readiness and affirmative evidence.
- **Amber** (`#815710` light, `#e3b575` dark): attention and warnings.
- **Context lavender** (`#6d6099` light, `#bbb3d3` dark): context metrics only.

### Neutral

- **Charcoal canvas / panel / raised** (`#111315`, `#191c20`, `#23272d`): dark application surfaces.
- **Light canvas / panel / raised** (`#f3f4f5`, `#ffffff`, `#e9edf1`): light application surfaces.
- **Text and quiet copy** (`#20252b` / `#edf0f3`, `#525b66` / `#a8afb9`): primary and supporting content by theme.
- **Rules and controls** (`#d4d9df` / `#333941`, `#7b8592` / `#697482`): boundaries and affordances.
- **Semantic error** (`#a43440` light, `#f09a9f` dark): actual failures only.

**The Semantic Signal Rule.** Green, amber, lavender, and error communicate recorded state. Neutral styling represents idle, unavailable, and ordinary resting states; semantic error is never used as decoration.

## Typography

**UI Font:** Inter (with sans-serif fallback)<br>
**Data Font:** Geist Mono (with Consolas and monospace fallbacks)

Inter keeps the dense monitoring workspace readable and direct. Geist Mono is reserved for values, timestamps, counts, identifiers, and other execution metadata so evidence remains distinguishable from explanatory UI copy.

### Hierarchy

- **Title** (650, 26px, line-height 1.1): route and page titles.
- **Section** (650, 16px, line-height 1.35): panel headings and major section labels.
- **Body** (400, 14px, line-height 1.5): explanations and ordinary UI text.
- **Control** (500, 13px, line-height 1.4): buttons, filters, navigation, and compact labels.
- **Metadata** (400, 12px, line-height 1.4, Inter): quiet labels and supporting status details.
- **Caption** (500, 11px, line-height 1.4, Inter, `--text-caption`): the smallest step, reserved for uppercase eyebrows, evidence chips, chart axis ticks, and tiny counts; never running text.
- **Data** (400, 12px, line-height 1.4, Geist Mono): timestamps, counts, IDs, and execution values.

**The Two Voice Rule.** Use Inter for interface language and Geist Mono for data. Landing typography is a separate surface decision.

## Layout

The app shell uses a 60px global header, a 220px desktop route rail, and a flexible evidence workspace. It does not reserve a persistent footer row, and session pages end with their final evidence panel rather than repeating observer, update, source, license, or version metadata. That supporting information belongs in Settings or About. Main content stays bounded by the shell while panels use a 4px/8px/16px/24px/32px rhythm. The app bar never carries breadcrumbs: it holds the compact pomegranate product mark, a 280px desktop / 200px tablet search trigger, monitor state, notifications, and local profile control; the phone trigger is icon-only. The trigger opens the Ctrl K palette. Every page instead uses `CommandPageHeader` with an optional breadcrumb trail (12px muted sentence case, brand-text links, 12px chevron separators from `CommandBreadcrumbSeparator`, current page marked `aria-current`), title, optional meta line, bottom-aligned actions, and optional tab bar. The Settings About pane presents the painted mark beside the product name and purpose before operational metadata.

At compact widths the rail reduces to an icon rail and controls may use the 32px compact height. At mobile widths navigation becomes an off-canvas labelled drawer and touch targets are at least 44px. The Agents panel keeps its title, observed count, and content-width List / Grid switch on one heading row at every width; its filters sit below the status distribution. Requests presents session evidence with one bar per request and numeric Full prompt in the selected-request details; Activity is a separate evidence panel rather than content inside Session details. The retained evidence meanings remain unchanged: context is latest non-zero actual level carried to bucket boundaries, while request snapshots are independent request-local observations and are never carried forward, differenced, bucketed, or summed.

Home remains a personal starting point for last-viewed and pinned destinations. Its sections collapse to one column while preserving reading order, bounded identity-only local preferences, and honest unavailable/coming-soon content.

## Elevation & Depth

Operational surfaces are flat at rest. Depth comes from charcoal/light tonal steps, one-pixel rules, and ownership boundaries. The only routine shadow is the tokenized overlay shadow for menus and trays; landing shadows remain landing-only.

### Shadow Vocabulary

- **Overlay:** `0 12px 32px #20252b20` in light mode and the theme override in dark mode, for profile and notification overlays.

**The Flat Evidence Rule.** Panels, tables, metrics, and settings panes use tone and rules instead of decorative floating shadows. Give each meaningful transition one boundary: use proximity and spacing within a group, avoid adjacent full-width dividers, and soften supporting rules so section boundaries retain hierarchy. Content beside a divided evidence or settings row keeps at least 12px of block inset through the shared divider-gap token.

## Shapes

Controls use a restrained 4px radius. Evidence panels use a 6px radius. Borders are one-pixel and rectangular; avoid pills, ornamental clipping, or irregular silhouettes in the application. Touch sizing is separate from shape: default controls are 36px high, compact controls 32px, and coarse-pointer/mobile controls at least 44px. The one documented exception to the touch minimum is the 32px phone Activities call line; see Session Evidence.

## Components

### Buttons

Every button in the application belongs to one of six roles, implemented as shared classes in `app/styles/shell.css`. All six share the 4px control radius, one focus ring (2px `--focus-ring`, offset 2px; inset inside segmented frames), and one disabled treatment (opacity .48). Borders use the panel line token; the stronger control line appears only on hover and on form fields such as selects. Evidence chips are transparent outline labels so they never read as buttons.

- **Primary** (`.commandPrimaryAction`): 36px, pomegranate fill, white text, 13px/500. One per view, for real commitments only: install, reconnect, confirm.
- **Secondary** (`.commandSecondaryAction`): 32px, one-pixel panel-line rule, application text at 12px/500, transparent background. Hover, pressed, and selected all move to the raised panel tone with the stronger line. Used for Prev/Next, Copy, toolbar actions, and independent toggles such as Group by workflow.
- **Segmented** (`.commandSegmented` with `> button`): mutually exclusive views share one frame with a panel-line border and 4px radius; segments are 30px, borderless, muted 12px/500, divided by one-pixel lines, and the segment with `aria-pressed="true"` takes the raised tone and application text. Used for Fresh tokens / Full breakdown, List / Grid, Ancestors / Whole session, and the tile-bar metric.
- **Quiet** (`.commandQuietAction`): no border, no fill, muted 12px/500, 28px minimum height, 6px horizontal padding, optional 14px icon. Hover tints the background with 6% ink and lifts the text to application ink; pressed uses 10%. Used for optional actions such as Download report and sort cycling ("Largest by uncached input"). A panel heading that opens the tab continuing its evidence composes this role as `.panelHeadingLink`: heading type and ink color, a 14px muted chevron after the title, no hover fill, chevron lifts to ink on hover, 44px tap box on phone. It is not a seventh role.
- **Text link** (`.commandTextLink`): brand-text color, 12px/400, inline with content, no border or fill. Hover underlines with a 3px offset. Used for "Show 20", "Show more", "Expand all", and other section expanders; never a standalone action. Use it for at most one in-content pointer per panel. Panel-to-tab navigation uses the panel heading link, and a row's second destination uses the quiet role; never place a text link on the right of a panel header.
- **Icon** (`.commandIconAction`): 32px square quiet button with a 16px stroke icon. Requires a `title` or `aria-label`. Same hover as quiet.

On phone widths and coarse pointers the roles do not change, only their size: every target reaches 44px, primary and segmented stretch to the full row width (segments flex evenly), secondary pairs split the row, quiet actions become full-width rows, icon buttons become 44px squares, and text links keep a 44px tap box. Local layouts may reset a full-width role back to `auto` where a header keeps two controls on one line.

Shell chrome and stateful controls keep their own contracts on purpose and are not counted among the six roles: the 36px header icon and profile buttons (`.commandIconButton`, `.commandProfileButton`, borderless until hover), the 36px toolbar filter chips (`.commandFilterChip`, `aria-pressed` toggles), the Settings tab list (`.commandSettingsNav`, `role="tab"`), the theme toggle, the copy-transcript button whose copied/error states carry meaning, and the desktop session-header ID chip (`button.sessionIdChip`), which keeps the chip look, copies the full session ID on click, shows the stronger line on hover, and turns positive once copied or negative on failure. The global palette trigger and palette result rows compose `.commandQuietAction` with their shell classes; they retain the quiet-action interaction contract and do not create a seventh role. Everything else that was still bespoke has been folded into the roles: table pagination (Previous, page numbers with `aria-current="page"`, Next) and the agent tree camera controls (Fit, Zoom in, Zoom out) are secondary actions; panel-header Refresh and the notification tray's Mark all read are quiet actions.

A live reference of all six roles and their states, plus selects, chips and pills, page headers, tab bars, sidebar limits, panels, and the token scale, renders at `/design-system` on the web development server (`app/design-system/page.tsx`, `app/components/design-system/DesignSystemView.tsx`). It uses the real shared classes with static sample data only, is absent from every navigation menu and the LAN allowlist, renders the not-found view inside the desktop app, and the desktop shell refuses to navigate to it (`desktop/security-policy.mjs`).

- **Hover / focus:** move between neutral tones without lift; every interactive control receives the visible focus ring. Preserve reduced-motion behavior.

### Inputs / Fields

Search and filters use neutral backgrounds, one-pixel control rules, 4px corners, Inter control text, and an accessible focus ring. Inputs expand to 44px on coarse/mobile surfaces.

Native single-select dropdowns use `CommandSelect` from `app/components/command-center/CommandPage.tsx`. It preserves native selection and keyboard behavior, with a muted chevron inset 14px from the edge, reserved end padding, shared hover/focus/disabled states, and a native-arrow fallback in forced-colors mode.

### Inline Explanations

Repository detail setup rows use `RepositoryRow` with `.commandSettingRow.repositoryRow`: the existing settings grid and divider spacing, a 13px/600 title beside a standard `.commandChip`, a muted 12px detail, and actions on the right. Versions and checked times use the data font. On phone, actions stack below the detail and split the available width with 44px targets. Each independent row has at most one primary commitment (Install plugin, Update plugin, or the inline confirmation's Run diagnostic). The web design-system reference includes a static row sample.

Explanatory inline text may use a quiet dotted underline to disclose a tooltip or popover. The underline follows the text color and is reserved for text only; icons, buttons, and chips retain their own established interaction affordances.

### Cards / Containers

Evidence panels use the theme panel token, a one-pixel line, 6px radius, and 16px base padding. Rows and tables use rules and neutral hover tones. Missing data remains unavailable or an em dash; it is never replaced with a plausible value.

### Navigation

The painted divided pomegranate is also the favicon, landing header/footer mark, Windows application icon, tray icon, and notification icon. `npm run build:brand` exports transparent Pomegr-red assets from the application luminance mask in `public/pomegr-mark-painted.png`; the app build runs this export automatically.

The branded header is 60px high. Desktop and mobile share a compact raster-derived pomegranate brush mark. The Pomegr wordmark accompanies it; on mobile, the mark sits immediately after the menu control. The mark uses the generated artwork as a mask so its visible color remains the theme-aware application brand token. The desktop rail is 220px with labelled route links and live status context; compact and mobile modes preserve accessible names and current-route state. The rail’s Usage limits widget shows only providers with sessions created in the last seven days and their tightest available account window, selected by highest percentage regardless of the provider's active or reached state. It uses the shared normal (0–74), warning (75–84), and critical (85–100) colors and links to Usage limits; it is shell chrome and never session state. Provider names stay in adapter-specific content, never in product identity.

### Agent Activity

Unmapped agent roles display `custom: <type>` when the monitor supplies a validated
custom type label. Reuse the existing role metadata text in the roster, inspector,
and tree, including its accessible label. Missing labels remain `unknown`, and
role glyphs and aggregate summaries retain the normalized role. This is a copy
change within existing controls and typography.

Agent activity shows normalized roles and evidence with the existing privacy bounds. The session roster fits its content up to 560px on desktop, with a sticky primary row and sticky group headers. On all screen sizes, vertical scrolling continues to the page at either roster edge, including when collapsed groups or filters leave no inner overflow. Groups organize primary, direct, and workflow agents; open groups persist per session. Rollups sum latest snapshots and label the result as context. Controls include workflow grouping, search, status and model filters, Hide finished, and within-group sorting. On phone, search stays visible and the other controls move into a filter sheet. Phone rows are 56px high and the region fits its content up to 60vh. Use the existing Inter UI and Geist Mono data tokens. The selected-agent inspector occupies a 340px desktop column, stacks below the roster at 761–900px, and opens as a full-screen sheet at 760px and below. Selection persists per session and navigation reveals the target group. The inspector shows normalized lineage, latest context, skills, signals, shell tasks, approval reviews, and the primary plan checklist. Its copy action retains the local-client gate and one-shot path request. Its exits, Activities for this agent and the model across sessions, are full-width secondary rows with a trailing chevron, and Copy transcript path is a quiet left-aligned action; the desktop column and the phone sheet share this stack, and only the sheet grows it to 44px. Approval-review outcomes are sentence-case evidence chips, positive for Allowed and negative for Denied, and review rows carry no separate leading mark, so their text aligns with the section heading. Phone Back and Escape restore the opener, with body scroll locked while the sheet is open. The shipped grid uses bounded workflow lanes with a shared tile-bar preference for latest context (or final context in history), wall time, or tool calls; every bar uses one maximum scale across the session. Responsive lanes show six, four, or two tiles, and selecting a tile reuses the inspector. The shipped focused tree uses compact 220×74 agent, workflow, and phase cards, 58px collapsed groups, curved connectors, and a combined header with scope and fit controls. Fit frames the complete visible focused tree. The desktop layout keeps the canonical provider-recorded ancestry unchanged: workflow and phase presentation groups are added only for canonical sibling sets, and groups describe provenance without becoming spawn parents. Large no-workflow sibling sets show the focused target, a nearby sibling, and a bounded cluster for the remaining siblings. Card and cluster totals use the latest context snapshots across the represented subtree. Desktop exposes Ancestors and Whole session scopes, preserves the focus-path camera and local focus state, marks focus in coral and warnings in amber, and distinguishes provider-recorded spawn ancestry from workflow provenance. On phone, the tree uses the InspectorSheet rail with readable status and cluster summaries; Back to inspector returns to the inspector, then closing it restores the opener. Workflow navigation clears active filters before expanding the destination group. Caret motion respects reduced motion.

At intermediate widths, the roster omits the Calls and Cache TTL columns from 761–1250px; both remain available in the inspector. Phone group tree controls have a 44px target. The roster owns its compact column rules so stacking the inspector at 900px does not restore columns prematurely.

At intermediate widths, the roster omits the Calls and Cache TTL columns from 761–1250px; both remain available in the inspector. Phone group tree controls have a 44px target. The roster owns its compact column rules so stacking the inspector at 900px does not restore columns prematurely.

Provider names are words, never logos: `ProviderBadge` renders the product name in a standard `.commandChip`, or as plain inherited text (`variant="text"`) inside headings and inline list metadata. Provider logos are third-party trademarks and do not ship in the application; Settings → About states that Pomegr is not affiliated with the providers.

Session headers show recorded or live lifecycle state in the status card without a duplicate identity badge. The provider row omits the repository name already shown in the breadcrumb, including while session evidence loads. Live and historical views omit the redundant status row; connection failures remain visible. The live status card uses the shared activity labels, including In progress for working sessions. Phone summary disclosures identify the summary source once in their toggle, with agent-reported signals retained below. Session toolbars offer report download without a pause action.

Session detail uses the shared page header, followed by five persistent KPIs on desktop and three on phone: Agents (active count), Context (labelled as the sum of latest agent snapshots), and Calls (repeated count), each a padded cell with one sub-line. On phone the header meta keeps only the provider, status, and branch chips; the session ID, start time, and Download report action are desktop-only. Its tab rule sits directly below the KPI strip. Desktop exposes Overview, Agents, Activities, Repository, Signals, Resources, and Details; phone exposes Overview, Agents (with its count badge), Activities, Repo, and More (with a chevron) as content-width tabs spread across the row without horizontal scrolling. More opens the remaining real tab destinations. A tab switch preserves the `agent`, `request`, and `path` query selections. Overview orders Right now, Repository, Requests, Progress, Work by kind, and Cost on phone, each in its own bordered panel; Right now rows stack the agent name over its latest action with context on the right, and the whole row opens the agent. Missing readiness stays unavailable. Request preview bars show request-local fresh tokens (uncached input, cache write, and output) and exclude cache reads, in a fixed window of the latest 48 requests on desktop and 24 on phone.

Role tint is the only exception that colors normalized agent roles. It appears only in agent tracks and their legends: orchestrator uses neutral track grey; explore and researcher use reading blue; plan uses planning teal; builder and tester use writing ochre; reviewer uses reviewing rose; general-purpose, workflow-worker, and fork use generic grey; compaction, unknown, and validated custom roles use lighter system grey. `app/role-family.ts` owns the mapping. Same-role agents share one tint. Roster rows, trees, lanes, and agent-name dots do not use these colors; status dots keep their lifecycle meaning.

### Session Evidence

Overview and Signals follow the link rule: panel headings open their tab, and Show agent is a quiet action. Efficiency signals appear only on the Signals tab, not on Overview. On desktop Overview uses a six-column grid: Right now spans the full width, or four columns with Work by kind beside it while at most two agents are listed; Requests takes four columns with Repository beside it; and a bottom panel (Progress, Work by kind, Cost) renders only when it has evidence or a readiness message to show. The request strip always draws 48 slots so a bar keeps its width in a new session, with a separate 6px role-track row beneath the bars. Work by kind omits medians under one minute. Repository is one wrapping line with the branch, a comparison chip toned green only for Up to date or integrated comparisons, and a muted changes/pull-request summary. Progress, Work by kind, and Cost use eyebrow headings with compact 12px/16px padding.

Activities is a grouped request feed below the Requests chart and its scoped
Largest strip. The strip is one wrapping line under the minimap, with no request
detail panel below it. Its quiet **Largest by uncached input** button cycles the
metric through uncached input, cache write (only when the provider records it),
total, and output. Up to three requests with a non-zero value follow, each a quiet
action showing `#n`, the agent name, and the request-local count; selecting one
selects its request. Counts use the shared request-token format: `compactNumber`
text (139.7K), the exact value in the hover title (`requestTokenTitle`), and the
exact value in the accessible name, matching the feed's token cells. A 360px Actions by kind rail with
Shell tasks and Failed shell runs precedes the five request groups around the
selected request; compact desktop widths stack the rail above the groups. Groups
contain only request-linked calls and retain their stable session request numbers.
The range/window label appears before **Previous**, **Next**, and **Jump to
latest**; those controls navigate committed request groups rather than numbered
activity pages. Selecting a group, chart bar, Largest item, or supported call keeps
the chart, strip, and feed correlated. A newer navigation cancels an
older pending request window; an older selection remains anchored while live
history grows. The selected request uses the only brand accent and the scoped
selected-request left rule. Agent scope applies consistently to the chart, strip,
groups, and aggregates.

A request line, desktop or phone, stays quiet by printing only what changed from the
group above it. The agent and role appear on the page's first group and wherever the agent
changes; the recorded model, in the data font, appears wherever it changes, including
under an unchanged agent. Each line's accessible name still states the agent, role,
model, and exact counts. The request number is regular-weight muted data until the
row is hovered or selected. Desktop token counts keep their chart-legend colors, print
through `compactNumber`, and name their kind and exact value on hover; the phone line
keeps its compact uncached input and time, and a tap opens the four exact counts. One rule separates
request groups; a request line and its calls carry no rule between them. Desktop request
lines are 34px and their call rows 30px, so each request reads as the header of a compact group.

Foreground request-window loading keeps the last committed chart and feed visible
under a local neutral veil and announced loading status. The chart and feed never
mix selections, and failed or loading work retains last-known-good evidence rather
than inventing counts. Historical sessions do not follow live appends. Request
links are recorded associations, not token or cost attribution; activity without
a proven request association is omitted from this grouped presentation.

On phone, request-group targets remain at least 44px. A disclosed call line is
the documented 32px exception: its icon, target, and wall duration form one
compact line. Tapping it expands its already-bounded detail in place beneath the
line; only one disclosure is open, Escape collapses it, and it creates no sheet,
scroll lock, or URL state. The shared request-association caveat remains available
from the Requests panel. The feed footer carries the same quiet **Request-local
counts** popover on phone as on desktop; phone adds no walkthrough of what each
line holds.

Signals is a separate tab, reachable on phone through **More**, with three ordered
sections: **Efficiency**, **Cache lifetime**, and **Reported signals**. The first
two show deterministic recorded evidence or explicitly labeled inferences;
Reported signals are agent-reported updates and may be stale. The tab introduction
says **Not a quality assessment**.

Repositories use a flat, linked index of observed projects. Each row shows the
repository name, observed provider badges, live and history session counts, last
activity, and one bounded Pomegr setup summary. The toolbar combines repository
search with All, Needs attention, and Live now filters; on phones the rows reflow
into a compact layout while search and filters retain at least 44px targets.
Repository detail is a linked `/repositories/<repositoryId>` route. Its header
uses the shared breadcrumb as its only repository name, followed by the repository's
live and history counts, observed provider badges, and the existing secondary-button
role for View sessions. It does not repeat the repository name as a page title or
show a repository icon. The shell uses the shared session breadcrumb for
`Repositories › {displayName}`. Detail navigation uses the existing Settings
layout: a 210px five-tab rail on desktop and its horizontal mobile strip, with
the active tab backed by `?tab=` in the URL. Overview shows snapshot facts,
linked setup summaries, and the five most recent associated sessions. Plugin
groups plugin installation instructions and native actions by provider.
Reporting shows the shared policy state with always-visible setup guidance.
Git uses the shared neutral chip with an 8px gap before its placeholder title. The Context
inventory tab uses one section per provider, including an explicit not-yet-available
state for Codex, a revision select when
multiple saved revisions exist, four bounded evidence facts, a category grid,
expandable listed items and revision comparison, plus explicit loading,
unavailable, and sanitized failure states. Its capture action and inline
confirmation reuse the existing button roles and native confirmation boundary.
Repository-local classes compose the existing Settings geometry, `CommandSelect`,
chips, and button roles through `RepositoryRow`. On phones, row actions share
equal-width columns with 44px targets, and capture confirmation buttons stack.
Inventory capture times stay right-aligned; provider check times are omitted. Tabs support arrow keys and Home/End;
pane changes restore focus to the selected tab. Native action completion also
restores tab focus unless the user has moved to another control. Row links name
the repository and setup state, and the breadcrumb marks the current page.
Legacy repository query links redirect to the Context inventory tab. Setup
mutations require native confirmation, with browser clients receiving setup
instructions.

Only monitor-qualified possible full-refill transitions receive amber dotted lines
with the shared stack-refill icon and the label Possible full refill. Ordinary
cache growth and initial cache creation remain in the cache-write bars and details;
read-drop inferences use an open arrowhead and the label Possible refill. Their
model-change observations reuse the open arrowhead with the compact chart label
Reuse drop · model change. Agent occurrence popovers say
Cache reuse dropped across a model change and distinguish the observation from
refill or expiry inferences. Mixed agent counts describe cache-read drops, with
each occurrence explaining its own evidence. These reuse existing controls.
The cache-evidence
symbol and label lane sits above compaction labels. Show marker labels on selection,
focus, or hover, with matching minimap ticks; the bar's accessible name carries the
same label. Match only unambiguous normalized agent/timestamp pairs.

Requests is the shipped SP05 session evidence panel: one bar per model request in a fixed 60-request desktop window (20 on phone), with a minimap on desktop and phone plus direct chart dragging on phone, and a scoped Largest strip. The default Fresh tokens mode uses request-local uncached input, cache write, and output bars, with no prompt outline and a scale excluding cache reads; Full breakdown adds cache read. Each layout shows its numeric scale on the chart itself: lane maxima or the single chart's axis ticks. Above the chart, a caption-size muted range line reads `Showing #first–#last of total`; a single-agent scope adds `· N of M for this agent`, because session request numbers skip other agents. The recent-request preview omits the range line. The minimap follows the selected mode's token categories, including output. Compaction boundaries appear as dashed ticks. Rankings and scale are computed over the selected agent scope, while every displayed number remains request-local.

The desktop request header keeps its title and one-bar explanation inline, with
the legend and controls alongside when space permits. The chart retains its scale
explanation and a slim minimap without a loaded-count label. Its scrollbar spans
the full scoped request history, with a proportional visible-window thumb;
dragging, clicking the track, arrows, Page Up/Down, and Home/End navigate committed
history windows. Miniature bars show every scoped request from the committed
overview, independently of the loaded detail window, with a stable full-history
scale for the selected mode. Older monitors without an overview show only loaded
evidence at its actual positions; empty track is not a zero-token observation. Omit the normal
request-count status and separate First / Older / Newer / Latest row; loading and
unavailable states remain explicit. Desktop Prev/Next selection crosses request-page
boundaries. After the initial page, preload committed request pages for the viewed
scope. Dragging renders each resident window immediately, before pointer release,
without fetching it again. Keep the last chart visible if a window is still loading.
The overview bars and full-scope chart scale remain stable while the thumb and detail window move.
Before full history arrives, render available recent request snapshots immediately,
using observation times instead of stable request numbers. Explain the preview in
the retention line and defer the full-history minimap until its page is ready.
Keep this preview visible through loading and retries. Clicking or stepping to the
newest bar or its linked Activity row on the latest live page resumes following
in both panels, including after loading a linked request window. Older selections
remain anchored, and historical sessions never follow live appends.
The compact detail region aligns request facts with five ranked rows:
request number, neutral bar, and request-local value. Its heading identifies the
scope, with a quiet button cycling uncached input (default), output, cache write,
and total; skip cache write when unavailable. Omit repeated agent and Before
metadata, expansion controls, and the ranking footer. Phone keeps the strip under the minimap
as the same wrapping line, never a stacked list: the items stay inline instead of taking the
full-width phone quiet action, and they are a documented caption-size 32px exception to the phone
44px target so three ranked requests read as two short lines.

The Requests title and range line stay plain text. Their explanations (why Fresh
tokens leaves out cache reads, request numbering, and in lanes the per-lane scales)
share one quiet How to read this dotted popover at the bottom right of the panel,
beside the Largest strip: caption size, muted, with a faded dotted underline. Phone
drops that popover; the strip is the whole footer there. The
Actions by kind rail caveat uses the same quiet treatment. Popover text states only
what a technical reader cannot discover from the controls: one or two short
sentences, no walkthrough of clicks or privacy boundaries.

#### Request lanes and single chart

Desktop Activities defaults to lanes. Two segmented groups sit in `.requestsActionsModes`:
Chart mode (Fresh tokens / Full breakdown) and Chart layout (Lanes / Single chart). The
layout has no URL parameter and does not render on phone, where only the single chart is drawn.
Both layouts share request order, the window, selection, arrow-key stepping, and the minimap.

- **Lanes.** One lane per agent with loaded requests, in roster order, and every request drawn
  exactly once. Requests from compaction agents share one Compactions lane, placed last. The
  primary lane is taller (22px band, 96px plot; other lanes 18px and 34px). Each lane prints
  its own `max N` (caption, Geist Mono, faint) in a 72px right gutter that bars and evidence
  icons never reach. In lanes, the Largest strip starts under the plots, level with
  the first bar, rather than under the label column. Lane
  evidence icons are 14px. Band text is placed in priority order, dropping any label that would
  overlap rather than drawing it: the hovered, focused, or selected cache-evidence label, then
  the selected request number, then compaction text.
- **Labels.** A 220px column with a 1px `--command-line` right rule. The name is 12px/500 ink
  and the meta line is caption muted (`role · model`, `compaction · N agents`, or
  `not in the agent roster`), each ellipsized on one line. The full `name · meta` is the title
  tooltip and the accessible name. Labels never carry role dots or role tints.
- **Focus and collapse.** Lane names of roster agents are `.commandQuietAction.requestLaneLabel`
  buttons that bleed 20px into the plot padding. Pressing one focuses that agent's scope across
  the tab (`aria-pressed`, 6% ink tint), and pressing it again returns to all agents. With more
  than eight roster lanes (roster agents plus the Compactions lane) and no focus, Direct
  subagents and each workflow with two or more agents collapse into one group row. That row
  draws every member request on one group maximum. Its label button (`aria-expanded`, 12px
  chevron rotating 90°) expands the group into a header plus member lanes indented one
  `--space-4` step. Primary and Compactions never collapse. Selecting a request inside a
  collapsed group does not expand it.
- **Single chart.** On desktop and phone, the scale follows the requests currently visible so
  off-window requests cannot compress its bars as the window moves. The minimap retains its
  stable whole-history scale. Under the bars runs the role-family agent
  track: one `.requestRoleSegment` per visible bar, 4px high after a 3px gap (3px on phone).
  The `.sessionRoleLegend.requestRoleLegend` below lists the role labels in view,
  ordered by family, with distinct agent counts. It keeps each label's case, so `custom: <type>`
  and lowercase roles are not capitalized. The hovered or focused bar's agent, otherwise the
  selected request's agent, is named in text beside the legend (`#n`, name, role), never as SVG
  text.
- **Phone chart.** Phone always draws the single chart with its track and legend, then the
  minimap and the Largest strip. The inspected request's `#n`, agent name, and role occupy a
  dedicated full-width row between the legend and minimap so changing requests cannot move the
  minimap while it is being touched. Compaction, selected-number, and cache-evidence text share one
  reserved row just above the plot top, which bars never reach, placed with the lane band
  priority and dropped rather than overlapping. Evidence icons sit above that row. Its numeric
  scale recomputes from the visible window in both Fresh tokens and Full breakdown modes.
- **Role tint scope.** In Activities, role tints appear only on `.requestRoleSegment` and the
  legend swatches. Lanes, lane labels, group rows, and the minimap use no `roleFamily-*` classes
  and no `--session-role` or `--role-*` values.
- **Minimap.** Neutral grey: bars use `--command-line-strong`, and the window uses a
  `--command-muted` stroke with a 12% muted fill (the whole-history window uses
  `--command-line-strong`). No brand or role color appears. Only cache-evidence ticks keep
  amber, dotted when inferred. The slider's `aria-valuetext` reads `Request positions a to b
  of n`, because positions within the scope are not request numbers. The interaction hint is
  never rendered inline: it is the SVG title tooltip and the slider's `aria-describedby`
  description.

`/design-system` renders a static lanes sample (one expanded and one collapsed group, a
Compactions lane, the minimap) and a single-chart sample with the track and legend.
`tests/ui/pomegr-design-contract.test.tsx` enforces the label grid, pressed tint, member indent,
gutter and lane heights, collapse threshold, tint scope, and neutral minimap.

Use Inter for panel language and controls, and Geist Mono for request counts, ordinals, timestamps, and other execution data. Phone controls are at least 44px high; the chart omits Prev/Next and retains a slim minimap. Its histogram is 26px high inside a 44px touch area, with transparent vertical padding. Tapping the minimap jumps to that part of history, and its window stays synchronized with chart swipes. When a new chart window is ready, Activity reveals linked rows for its selected request; manual Activity paging remains independent between chart navigation actions. Dragging directly on the bars moves its 20-request window: right reveals older requests and left reveals newer requests. Taps select bars, while vertical page scrolling and pinch zoom remain native. Horizontal dragging takes pointer capture after a movement threshold and suppresses selection on release; cancellation releases the gesture, and a second finger cannot replace an active drag. Keyboard bar navigation remains available. Requests replaces the former Context history and Request snapshots panels; Settings Data display retains only the API list-rate estimate toggle. Their existing meanings remain intact: context is the latest non-zero actual level carried to bucket boundaries, while request snapshots are independent request-local observations and are never carried forward, differenced, bucketed, or summed. Deterministic insights remain traceable to concrete events and are never presented as AI judgments.

#### Phone Activities feed

On phone the feed puts the request groups and their range navigation first, with Actions by
kind, Shell tasks and Failed shell runs following below them behind one rule
(`.activityLayout.isPhone`). Desktop and compact-desktop order is unchanged: the 360px rail
precedes the feed. Two exceptions are scoped to this phone composition alone, and
`tests/ui/pomegr-design-contract.test.tsx` keeps each from spreading.

- **Selected-request brand rule.** The selected request group carries a brand-colored left rule
  and its call lines carry the same rule
  (`.activityLayout.isPhone .activityTableFrame.isSelectedRequest`). This is the only
  brand-colored left border in `app/styles/`; selection everywhere else stays on the raised tone.
- **32px call line.** The phone call line (`.activityCallLine`) is 32px high, the single
  documented dense-list exception to the 44px touch minimum: it is full-width, separated by 44px
  request lines, and the line itself is its disclosure target. No other `activity` selector may
  set a 32px row height.

## Do's and Don'ts

### Do:

- **Do** use the committed tokens in `app/styles/tokens.css` as the source of truth.
- **Do** use Inter at 26px titles, 16px sections, 14px UI/body, 13px controls, and 12px metadata; use Geist Mono for numeric and execution data.
- **Do** preserve the 60px header, 220px desktop rail, 36px default controls, 32px compact controls, and 44px touch targets.
- **Do** preserve provider-neutral identity, normalized privacy boundaries, and existing metric semantics.
- **Do** keep Requests as the session evidence panel and explain request-local values separately from retained context history.
- **Do** keep landing typography, paper artifacts, and brand decisions scoped to landing/marketing.

### Don't:

- **Don't** reintroduce Rokkitt, square application geometry, nearly-black legacy token names, or landing typography as app-shell guidance.
- **Don't** use semantic colors for decoration; reserve semantic error for actual errors and keep idle states neutral.
- **Don't** expose prompts, responses, commands, credentials, raw transcript content, or unsupported provider detail.
- **Don't** turn context history into throughput, spend, or cumulative usage; don't aggregate request snapshots.
- **Don't** replace unavailable evidence with fake activity, counts, controls, or success states.
