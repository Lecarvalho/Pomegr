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

The app shell uses a 60px global header, a 220px desktop route rail, and a flexible evidence workspace. It does not reserve a persistent footer row, and session pages end with their final evidence panel rather than repeating observer, update, source, license, or version metadata. That supporting information belongs in Settings or About. Main content stays bounded by the shell while panels use a 4px/8px/16px/24px/32px rhythm. The header holds the compact pomegranate product mark, destination search, monitor state, notifications, and local profile control. Session routes place the Sessions › project breadcrumb in this header; on phones, the mark retains its accessible Pomegr home name while the visible wordmark gives that space to the breadcrumb. Long project names truncate within the header. The brand mark keeps the same position on routes with and without breadcrumbs. On phones, the breadcrumb and Pomegr wordmark share the same text origin, baseline, typography, and muted color. The Settings About pane presents the painted mark beside the product name and purpose before operational metadata.

At compact widths the rail reduces to an icon rail and controls may use the 32px compact height. At mobile widths navigation becomes an off-canvas labelled drawer and touch targets are at least 44px. Agent activity controls wrap below the section heading at widths of 640px or less so the heading and filters remain readable. Requests & actions presents session evidence with one bar per request and numeric Full prompt in the selected-request details; Activity is a separate evidence panel rather than content inside Session details. The retained evidence meanings remain unchanged: context is latest non-zero actual level carried to bucket boundaries, while request snapshots are independent request-local observations and are never carried forward, differenced, bucketed, or summed.

Home remains a personal starting point for last-viewed and pinned destinations. Its sections collapse to one column while preserving reading order, bounded identity-only local preferences, and honest unavailable/coming-soon content.

## Elevation & Depth

Operational surfaces are flat at rest. Depth comes from charcoal/light tonal steps, one-pixel rules, and ownership boundaries. The only routine shadow is the tokenized overlay shadow for menus and trays; landing shadows remain landing-only.

### Shadow Vocabulary

- **Overlay:** `0 12px 32px #20252b20` in light mode and the theme override in dark mode, for profile and notification overlays.

**The Flat Evidence Rule.** Panels, tables, metrics, and settings panes use tone and rules instead of decorative floating shadows. Give each meaningful transition one boundary: use proximity and spacing within a group, avoid adjacent full-width dividers, and soften supporting rules so section boundaries retain hierarchy. Content beside a divided evidence or settings row keeps at least 12px of block inset through the shared divider-gap token.

## Shapes

Controls use a restrained 4px radius. Evidence panels use a 6px radius. Borders are one-pixel and rectangular; avoid pills, ornamental clipping, or irregular silhouettes in the application. Touch sizing is separate from shape: default controls are 36px high, compact controls 32px, and coarse-pointer/mobile controls at least 44px.

## Components

### Buttons

Every button in the application belongs to one of six roles, implemented as shared classes in `app/styles/shell.css`. All six share the 4px control radius, one focus ring (2px `--focus-ring`, offset 2px; inset inside segmented frames), and one disabled treatment (opacity .48). Borders use the panel line token; the stronger control line appears only on hover and on form fields such as selects. Evidence chips stay flat fills with no border so they never read as buttons.

- **Primary** (`.commandPrimaryAction`): 36px, pomegranate fill, white text, 13px/500. One per view, for real commitments only: install, reconnect, confirm.
- **Secondary** (`.commandSecondaryAction`): 32px, one-pixel panel-line rule, application text at 12px/500, transparent background. Hover, pressed, and selected all move to the raised panel tone with the stronger line. Used for Prev/Next, Copy, toolbar actions, and independent toggles such as Group by workflow.
- **Segmented** (`.commandSegmented` with `> button`): mutually exclusive views share one frame with a panel-line border and 4px radius; segments are 30px, borderless, muted 12px/500, divided by one-pixel lines, and the segment with `aria-pressed="true"` takes the raised tone and application text. Used for Fresh tokens / Full breakdown, List / Grid, Ancestors / Whole session, and the tile-bar metric.
- **Quiet** (`.commandQuietAction`): no border, no fill, muted 12px/500, 28px minimum height, 6px horizontal padding, optional 14px icon. Hover tints the background with 6% ink and lifts the text to application ink; pressed uses 10%. Used for optional actions such as Download report and sort cycling ("by uncached input").
- **Text link** (`.commandTextLink`): brand-text color, 12px/400, inline with content, no border or fill. Hover underlines with a 3px offset. Used for "Show 20", "Show more", "Expand all", and other section expanders; never a standalone action.
- **Icon** (`.commandIconAction`): 32px square quiet button with a 16px stroke icon. Requires a `title` or `aria-label`. Same hover as quiet.

On phone widths and coarse pointers the roles do not change, only their size: every target reaches 44px, primary and segmented stretch to the full row width (segments flex evenly), secondary pairs split the row, quiet actions become full-width rows, icon buttons become 44px squares, and text links keep a 44px tap box. Local layouts may reset a full-width role back to `auto` where a header keeps two controls on one line.

Shell chrome and stateful controls keep their own contracts on purpose and are not counted among the six roles: the 36px header icon and profile buttons (`.commandIconButton`, `.commandProfileButton`, borderless until hover), the 36px toolbar filter chips (`.commandFilterChip`, `aria-pressed` toggles), the Settings tab list (`.commandSettingsNav`, `role="tab"`), the theme toggle, and the copy-transcript button whose copied/error states carry meaning. Everything else that was still bespoke has been folded into the roles: table pagination (Previous, page numbers with `aria-current="page"`, Next) and the agent tree camera controls (Fit, Zoom in, Zoom out) are secondary actions; panel-header Refresh and the notification tray's Mark all read are quiet actions.

A live reference of all six roles and their states, plus selects, chips and pills, panels, and the token scale, renders at `/design-system` on the web development server (`app/design-system/page.tsx`, `app/components/design-system/DesignSystemView.tsx`). It uses the real shared classes with static sample data only, is absent from every navigation menu and the LAN allowlist, renders the not-found view inside the desktop app, and the desktop shell refuses to navigate to it (`desktop/security-policy.mjs`).

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

The branded header is 60px high. Desktop and mobile share a compact raster-derived pomegranate brush mark. The Pomegr wordmark accompanies it except on phone session routes, where the breadcrumb takes that space. On mobile, the mark sits immediately after the menu control. The mark uses the generated artwork as a mask so its visible color remains the theme-aware application brand token. The desktop rail is 220px with labelled route links and live status context; compact and mobile modes preserve accessible names and current-route state. Provider names stay in adapter-specific content, never in product identity.

### Agent Activity

Unmapped agent roles display `custom: <type>` when the monitor supplies a validated
custom type label. Reuse the existing role metadata text in the roster, inspector,
and tree, including its accessible label. Missing labels remain `unknown`, and
role glyphs and aggregate summaries retain the normalized role. This is a copy
change within existing controls and typography.

Agent activity shows normalized roles and evidence with the existing privacy bounds. The session roster fits its content up to 560px on desktop, with a sticky primary row and sticky group headers. On all screen sizes, vertical scrolling continues to the page at either roster edge, including when collapsed groups or filters leave no inner overflow. Groups organize primary, direct, and workflow agents; open groups persist per session. Rollups sum latest snapshots and label the result as context. Controls include workflow grouping, search, status and model filters, Hide finished, and within-group sorting. On phone, search stays visible and the other controls move into a filter sheet. Phone rows are 56px high and the region fits its content up to 60vh. Use the existing Inter UI and Geist Mono data tokens. The selected-agent inspector occupies a 340px desktop column, stacks below the roster at 761–900px, and opens as a full-screen sheet at 760px and below. Selection persists per session and navigation reveals the target group. The inspector shows normalized lineage, latest context, skills, signals, shell tasks, approval reviews, and the primary plan checklist. Its copy action retains the local-client gate and one-shot path request. Phone Back and Escape restore the opener, with body scroll locked while the sheet is open. The shipped grid uses bounded workflow lanes with a shared tile-bar preference for latest context (or final context in history), wall time, or tool calls; every bar uses one maximum scale across the session. Responsive lanes show six, four, or two tiles, and selecting a tile reuses the inspector. The shipped focused tree uses compact 220×74 agent, workflow, and phase cards, 58px collapsed groups, curved connectors, and a combined header with scope and fit controls. Fit frames the complete visible focused tree. The desktop layout keeps the canonical provider-recorded ancestry unchanged: workflow and phase presentation groups are added only for canonical sibling sets, and groups describe provenance without becoming spawn parents. Large no-workflow sibling sets show the focused target, a nearby sibling, and a bounded cluster for the remaining siblings. Card and cluster totals use the latest context snapshots across the represented subtree. Desktop exposes Ancestors and Whole session scopes, preserves the focus-path camera and local focus state, marks focus in coral and warnings in amber, and distinguishes provider-recorded spawn ancestry from workflow provenance. On phone, the tree uses the InspectorSheet rail with readable status and cluster summaries; Back to inspector returns to the inspector, then closing it restores the opener. Workflow navigation clears active filters before expanding the destination group. Caret motion respects reduced motion.

At intermediate widths, the roster omits the Calls and Cache TTL columns from 761–1250px; both remain available in the inspector. Phone group tree controls have a 44px target. The roster owns its compact column rules so stacking the inspector at 900px does not restore columns prematurely.

At intermediate widths, the roster omits the Calls and Cache TTL columns from 761–1250px; both remain available in the inspector. Phone group tree controls have a 44px target. The roster owns its compact column rules so stacking the inspector at 900px does not restore columns prematurely.

Session headers show recorded or live lifecycle state in the status card without a duplicate identity badge. The provider row omits the repository name already shown in the breadcrumb, including while session evidence loads. Live and historical views omit the redundant status row; connection failures remain visible. The live status card uses the shared activity labels, including In progress for working sessions. Phone summary disclosures identify the summary source once in their toggle, with agent-reported signals retained below. Session toolbars offer report download without a pause action.

### Session Evidence

Activity follows Requests & actions, then Cache evidence precedes session summary
cards and the agent roster. A 360px by-kind rail precedes the feed; compact
desktop widths stack the rail above it. The six feed columns are Time, Agent,
Action, Target, Duration, and Request. Linked rows use the quiet button role,
raised tone for the selected request, and error-soft tone for failed rows.
Request numbers use the text-link treatment; the selected request number is the
only brand accent in the feed. Missing links and durations use an em dash.
Eight-row paging uses secondary Previous, numbered, and Next controls. Only one
activity page is displayed; the current page and its two neighbors are cached.
Request numbers are stable session labels, independent of page and agent scope.
Selecting a request reveals its activity page; selecting a linked activity row
loads the corresponding request window. Selection highlights linked rows without
filtering away other events. Omit the explanatory request-link strip. Older live
pages retain their first visible event and offer View latest
when new events arrive. Loading preserves the last committed page.
On phones, 64px two-line rows preserve target and duration, with 44px touch
targets and a 48px per-session breakdown disclosure closed by default. Agent
scope applies to the feed; by-kind totals and the other activity aggregates
cover the full retained session feed. Activity rows and Requests & actions
share request selection and links. Linked assistant replies show the same
request number and selected state as linked tool calls. The request detail shows Before and Issued
chips in one wrapping line separated by a vertical rule, with one shared
evidence caveat below the panel. These compositions remain panel-local.

Repositories use a flat, linked index of observed projects. Each row shows the
repository name, observed provider badges, live and history session counts, last
activity, and one bounded Pomegr setup summary. The toolbar combines repository
search with All, Needs attention, and Live now filters; on phones the rows reflow
into a compact layout while search and filters retain at least 44px targets.
Repository detail is a linked `/repositories/<repositoryId>` route. Its header
uses a 42px outlined repository icon, the repository's live and history counts,
observed provider badges, and the existing secondary-button role for View
sessions. The shell uses the shared session breadcrumb for
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
symbol and label lane sits above compaction labels. Show marker labels on selection,
focus, or hover, with matching minimap ticks and request-local evidence in
the selected-request details. Match only unambiguous normalized agent/timestamp pairs.

Requests & actions is the shipped SP05 session evidence panel: one bar per model request in a fixed 60-request desktop window (20 on phone), with a minimap on desktop and phone, selected-request detail and action labels, and a scoped Largest requests ranking. The default Fresh tokens mode uses request-local uncached input, cache write, and output bars, with no prompt outline and a scale excluding cache reads; Full breakdown adds cache read. Show each mode's numeric scale and label Fresh as rescaled with cache reads excluded. Full prompt in request details represents uncached input + cache write + cache read, excluding output. The minimap follows the selected mode's token categories, including output. Compaction boundaries appear as dashed ticks. Rankings and scale are computed over the selected agent scope, while every displayed number remains request-local.

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
unavailable states remain explicit. Prev/Next selection crosses request-page
boundaries. After the initial page, preload committed request pages for the viewed
scope. Dragging renders each resident window immediately, before pointer release,
without fetching it again. Keep the last chart visible if a window is still loading.
The overview bars and full-scope chart scale remain stable while the thumb and detail window move.
Before full history arrives, render available recent request snapshots immediately,
using observation times instead of stable request numbers. Explain the preview in
the retention line and defer the full-history minimap until its page is ready.
Keep this preview visible through loading and retries. Clicking or stepping to the
newest bar on the latest live page resumes following; older-page selections and
explicit Activity links remain anchored.
The compact detail region aligns request facts with five ranked rows:
request number, neutral bar, and request-local value. Its heading identifies the
scope, and the ranking metric remains accessible. Omit repeated agent and Before
metadata, expansion controls, and the ranking footer. Phone omits the ranking rail.

Use Inter for panel language and controls, and Geist Mono for request counts, ordinals, timestamps, and other execution data. Phone controls are at least 44px high; the chart keeps Prev/Next navigation and a full-history minimap with a 44px touch area. Dragging or tapping the minimap moves its 20-request window. The minimap owns pointer capture and suppresses page scrolling only within its touch area; cancellation releases the gesture, and a second finger cannot replace an active drag. Keep the Cache evidence disclosure after Activity, closed by default, with its saved disclosure state and event count. Requests & actions replaces the former Context history and Request snapshots panels; Settings Data display retains only the API list-rate estimate toggle. Their existing meanings remain intact: context is the latest non-zero actual level carried to bucket boundaries, while request snapshots are independent request-local observations and are never carried forward, differenced, bucketed, or summed. Deterministic insights remain traceable to concrete events and are never presented as AI judgments.

## Do's and Don'ts

### Do:

- **Do** use the committed tokens in `app/styles/tokens.css` as the source of truth.
- **Do** use Inter at 26px titles, 16px sections, 14px UI/body, 13px controls, and 12px metadata; use Geist Mono for numeric and execution data.
- **Do** preserve the 60px header, 220px desktop rail, 36px default controls, 32px compact controls, and 44px touch targets.
- **Do** preserve provider-neutral identity, normalized privacy boundaries, and existing metric semantics.
- **Do** keep Requests & actions as the session evidence panel and explain request-local values separately from retained context history.
- **Do** keep landing typography, paper artifacts, and brand decisions scoped to landing/marketing.

### Don't:

- **Don't** reintroduce Rokkitt, square application geometry, nearly-black legacy token names, or landing typography as app-shell guidance.
- **Don't** use semantic colors for decoration; reserve semantic error for actual errors and keep idle states neutral.
- **Don't** expose prompts, responses, commands, credentials, raw transcript content, or unsupported provider detail.
- **Don't** turn context history into throughput, spend, or cumulative usage; don't aggregate request snapshots.
- **Don't** replace unavailable evidence with fake activity, counts, controls, or success states.
