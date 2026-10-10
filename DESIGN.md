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

Settings includes a **GitHub** section directly after **Providers** and before **Storage**, always present. It reuses the Storage panel geometry: one bordered panel of `.commandSettingRow`s with a connection row (the **GitHub CLI** title, one fixed state line, a standard `.commandChip` reading **Connected** with a green dot, **Not signed in** with an amber dot, or **Not installed**, the Secondary **Sign in with GitHub CLI** only when signed out, and the Quiet **Check again**) and, only when connected, a **Repositories** row followed by one row per known repository: the data-font display name, a neutral **Private** or **Public** chip (none when unknown), and fixed capability chips (**Can read issues** and **Can create issues** positive, **Issues are turned off** warning, **No access** neutral). A repository that could not be checked reads **Could not be checked.** The section reads only in the desktop app, once when opened and again on **Check again**, for at most the first 16 known repositories, and says so in a quiet line when more exist; it is busy (`aria-busy`, Check again disabled, previous rows kept) while reading. A browser or paired LAN client sees one desktop-only row and reads nothing. It never shows a username, path, URL or error text, and the sign-in opens the GitHub CLI's own sign-in in a terminal after a native confirmation. `/design-system` renders every state from static data.

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

Pomegr is a local-first, read-only observer that makes coding-agent activity legible without exposing the underlying conversation. The application is a calm evidence workspace: a compact branded header, persistent route rail, flat panels, one-pixel rules, and restrained semantic color give the operator a reliable scan order. The `/design-system` page (`app/design-system/page.tsx`, rendered by `app/components/design-system/`) is the code-led visual authority, and this document is its written contract; no HTML preview, generated component, or seed is required.

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

Home's What's new card (`HomeUpdateCard`) is a teaser, not the announcement itself: a 132×84 thumbnail, a brand-text uppercase caption eyebrow, a 14px/650 title, one muted 12px summary line, a secondary **See what's new** action, and an icon dismiss. The action opens a modal `<dialog>` (560px centered panel with the overlay shadow over a `#0008` backdrop, the same scrim as the phone agent-filter sheet; a bottom sheet at 760px and narrower) holding the illustration on the raised tone, the same eyebrow, a 16px/650 title, the description, short muted highlights, a quiet **Close**, and the primary **Got it**. Got it dismisses the announcement and is that dialog's one commitment; Close, Escape, and a backdrop click keep the card and return focus to the trigger. The dialog opens by itself once per announcement, the first time Home renders it, and that is recorded when it opens; after that, whether it was closed or the page reloaded, it opens only on that action. The illustration (`HomeUpdateIllustration`) is decorative static artwork built from tokens and sample data, authored 408px wide; the card thumbnail scales the same node down, both copies are inert and hidden from assistive technology, and an announcement without one renders text only. It never reads session state or ships a screenshot. The dialog's entrance is one unhurried ease-out moment, removed under reduced motion: the panel fades in and rises 12px over 600ms while the backdrop dims on the same gentle curve, with no scale; the phone sheet rises 32px. The automatic opening waits 300ms after Home renders so the entrance does not compete with first paint. `/design-system` renders both forms.

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

Shell chrome and stateful controls keep their own contracts on purpose and are not counted among the six roles: the 36px header icon and profile buttons (`.commandIconButton`, `.commandProfileButton`, borderless until hover), the 36px toolbar filter chips (`.commandFilterChip`, `aria-pressed` toggles), the Settings tab list (`.commandSettingsNav`, `role="tab"`, rendered with its pane at `/design-system`), the theme toggle, the copy-transcript button whose copied/error states carry meaning, and the desktop session-header ID chip (`button.sessionIdChip`), which keeps the chip look, copies the full session ID on click, shows the stronger line on hover, and turns positive once copied or negative on failure. The global palette trigger and palette result rows compose `.commandQuietAction` with their shell classes; they retain the quiet-action interaction contract and do not create a seventh role. Everything else that was still bespoke has been folded into the roles: table pagination (Previous, page numbers with `aria-current="page"`, Next) and the agent tree camera controls (Fit, Zoom in, Zoom out) are secondary actions; panel-header Refresh and the notification tray's Mark all read are quiet actions.

A live reference of all six roles and their states, plus selects, chips and pills, page headers, tab bars, sidebar limits, panels, the agent roster and inspector, the command table, the settings tab rail, and the token scale, renders at `/design-system` on the web development server (`app/design-system/page.tsx`, `app/components/design-system/`). It uses the real shared classes with static sample data only, is absent from every navigation menu and the LAN allowlist, renders the not-found view inside the desktop app, and the desktop shell refuses to navigate to it (`desktop/runtime/security-policy.mjs`).

- **Hover / focus:** move between neutral tones without lift; every interactive control receives the visible focus ring. Preserve reduced-motion behavior.

### Inputs / Fields

Search and filters use neutral backgrounds, one-pixel control rules, 4px corners, Inter control text, and an accessible focus ring. Inputs expand to 44px on coarse/mobile surfaces.

Every single-select dropdown uses `CommandSelect` (`app/components/command-center/CommandSelect.tsx`, re-exported from `CommandPage.tsx`); do not add a native `<select>`. It is a select-only combobox: the trigger keeps a muted chevron inset 14px from the edge, reserved end padding, and shared hover/focus/disabled states, and the stronger line also marks it open. The listbox opens in a fixed `--command-panel` overlay (one-pixel strong line, control radius, overlay shadow, at most 320px tall, flipped above when the space below is short) portaled to the body, or into the enclosing modal `<dialog>`. Options are 32px rows (44px on coarse pointers); the active option takes the raised tone and the selected option the brand text at 600. Focus stays on the trigger with `aria-activedescendant`; arrows, Home/End, Page Up/Down, typeahead, Enter/Space, Escape, and Tab follow the native select. An option may name a `group`: consecutive options that share one sit under a muted `--text-xs` heading that is not selectable, the closed control reads “group · label”, and each option appends the group to its accessible name (the task Run on field groups models by provider). An option may carry a decorative glyph with a visually hidden `iconLabel`; the Activities agent scope uses the green status dot with “running” for agents whose wall time is still advancing in a live session.

### Inline Explanations

Repository detail setup rows use `RepositoryRow` with `.commandSettingRow.repositoryRow`: the existing settings grid and divider spacing, a 13px/600 title beside a standard `.commandChip`, a muted 12px detail, and actions on the right. Versions and checked times use the data font. On phone, actions stack below the detail and split the available width with 44px targets. Each independent row has at most one primary commitment (Install plugin, Update plugin, or the inline confirmation's Run diagnostic). The web design-system reference includes a static row sample.

Explanatory inline text may use a quiet dotted underline to disclose a tooltip or popover. The underline follows the text color and is reserved for text only; icons, buttons, and chips retain their own established interaction affordances.

### Cards / Containers

Evidence panels use the theme panel token, a one-pixel line, 6px radius, and 16px base padding. Rows and tables use rules and neutral hover tones. `CommandTable` adds opt-in states: a sortable header (unsorted two-arrow glyph, then descending and ascending with ink text and `aria-sort`), a pagination footer of secondary actions (stacked with a page status on phone), caller-ordered row groups with a full-width header cell and optional footer row, and a caller-supplied empty state; `/design-system` renders all four. Missing data remains unavailable or an em dash; it is never replaced with a plausible value.

### Navigation

Tasks is a root item of the primary rail, directly after Sessions (the `grid` glyph, current on `/tasks` and below it), and a palette destination with the detail “Repository task boards”. The palette leads with the module in view: on Sessions the recent sessions come first, on Repositories the repositories, and while a ready task board is in view the trigger reads “Search tasks” and the board's tasks (at most 20 matches, each a result row with the `grid` glyph, the first line of the card title, and an ID, column, chip, and feature detail line) come before the destinations. Choosing a task opens its Task modal in the desktop app and focuses its card on the Board anywhere else.

The painted divided pomegranate is also the favicon, landing header/footer mark, Windows application icon, tray icon, and notification icon. `npm run build:brand` exports transparent Pomegr-red assets from the application luminance mask in `public/pomegr-mark-painted.png`; the app build runs this export automatically.

The branded header is 60px high. Desktop and mobile share a compact raster-derived pomegranate brush mark. The Pomegr wordmark accompanies it; on mobile, the mark sits immediately after the menu control. The mark uses the generated artwork as a mask so its visible color remains the theme-aware application brand token. The desktop rail is 220px with labelled route links and live status context; compact and mobile modes preserve accessible names and current-route state. The rail’s Usage limits widget shows only providers with sessions created in the last seven days and their tightest available account window, selected by highest percentage regardless of the provider's active or reached state. It uses the shared normal (0–74), warning (75–84), and critical (85–100) colors and links to Usage limits; it is shell chrome and never session state. Provider names stay in adapter-specific content, never in product identity.

### Agent Activity

Unmapped agent roles display `custom: <type>` when the monitor supplies a validated
custom type label. Reuse the existing role metadata text in the roster, inspector,
and tree, including its accessible label. Missing labels remain `unknown`, and
role glyphs and aggregate summaries retain the normalized role. This is a copy
change within existing controls and typography.

Agent activity shows normalized roles and evidence with the existing privacy bounds. The session roster fits its content up to 560px on desktop, with a sticky primary row and sticky group headers. On all screen sizes, vertical scrolling continues to the page at either roster edge, including when collapsed groups or filters leave no inner overflow. Groups organize primary, direct, and workflow agents; open groups persist per session. Rollups sum latest snapshots and label the result as context. Controls include workflow grouping, search, status and model filters, Hide finished, and within-group sorting. On phone, search stays visible and the other controls move into a filter sheet. Phone rows are 56px high and the region fits its content up to 60vh. Use the existing Inter UI and Geist Mono data tokens. The selected-agent inspector occupies a 340px desktop column, stacks below the roster at 761–900px, and opens as a full-screen sheet at 760px and below. Selection persists per session and navigation reveals the target group. The inspector shows normalized lineage, latest context, skills, signals, shell tasks, approval reviews, and the primary plan checklist. Its copy action retains the local-client gate and one-shot path request. Its exits, Activities for this agent and the model across sessions, are full-width secondary rows with a trailing chevron, and Copy transcript path is a quiet left-aligned action; the desktop column and the phone sheet share this stack, and only the sheet grows it to 44px. Approval-review outcomes are sentence-case evidence chips, positive for Allowed and negative for Denied, and review rows carry no separate leading mark, so their text aligns with the section heading. Phone Back and Escape restore the opener, with body scroll locked while the sheet is open. `/design-system` renders the shipped `AgentActivityPanel` from static agents (a pinned, selected primary row, an open workflow group, a collapsed Direct subagents group, the distribution strip, filters, the inline inspector, and the List / Grid switch) and a standalone inline `AgentInspector` with lineage; tapping a roster row at 760px and narrower opens the real sheet there. The shipped grid uses bounded workflow lanes with a shared tile-bar preference for latest context (or final context in history), wall time, or tool calls; every bar uses one maximum scale across the session. Responsive lanes show six, four, or two tiles, and selecting a tile reuses the inspector. The shipped focused tree uses compact 220×74 agent, workflow, and phase cards, 58px collapsed groups, curved connectors, and a combined header with scope and fit controls. Fit frames the complete visible focused tree. The desktop layout keeps the canonical provider-recorded ancestry unchanged: workflow and phase presentation groups are added only for canonical sibling sets, and groups describe provenance without becoming spawn parents. Large no-workflow sibling sets show the focused target, a nearby sibling, and a bounded cluster for the remaining siblings. Card and cluster totals use the latest context snapshots across the represented subtree. Desktop exposes Ancestors and Whole session scopes, preserves the focus-path camera and local focus state, marks focus in coral and warnings in amber, and distinguishes provider-recorded spawn ancestry from workflow provenance. On phone, the tree uses the InspectorSheet rail with readable status and cluster summaries; Back to inspector returns to the inspector, then closing it restores the opener. Workflow navigation clears active filters before expanding the destination group. Caret motion respects reduced motion.

The agent tree chooses its form from its own observed container width, not the viewport. At 640px and above it draws fixed-size cards in columns: dragging pans, pinching or a modifier-wheel zooms from 25% to 300%, the plain wheel pans, and a double-click, double-tap, or `0` fits the tree. Below 640px, and on phones, it becomes a rail of fixed 48px indented rows that scrolls natively and never intercepts wheel, pinch, or touch gestures. Folding a branch moves the camera only enough to keep the activated card in place and reveal its children; it never changes card size or scale. Focus is one roving tree stop: Up and Down move through visible nodes, Right and Left expand, collapse, or step to a child or parent, Enter and Space fold a branch, and in column form Shift with an arrow pans while `+`, `-`, and `0` zoom and fit. Tree cards have no detail popovers; a persistent note sends readers to the List view for tasks, skills, execution, and plan details. Connector lines are decorative, so document order carries the hierarchy, and each node's accessible name states its role and status instead of relying on color.

At intermediate widths, the roster omits the Calls and Cache TTL columns from 761–1250px; both remain available in the inspector. Phone group tree controls have a 44px target. The roster owns its compact column rules so stacking the inspector at 900px does not restore columns prematurely.

The Agents route, titled **Models & delegation**, has two tabs (arrow keys and Home/End move between them). **Models & work** reads in one order: compact run, session, and reported-model counts; the Models used ranking and the Models by role matrix; Observed work and Patterns in this selection; then a "How are these numbers counted?" disclosure. Main and delegated agents keep distinct fills in the ranking, and its percentages use every run in the selection as the denominator, so rounded values need not sum to 100. Every count is a real button that opens the contributing runs in one evidence drawer, dismissed by Close or Escape with focus returning to the trigger, and each run links to its agent in the parent session. **Live agents** is the shared `CommandTable` roster in backend parent-first order, never locally sorted or regrouped. Loading, partial coverage, delayed updates, and missing evidence are quiet notices that keep the retained summary visible; a known zero reads as zero and missing evidence reads as unavailable. Counting rules live in [Agents model and work analytics](docs/internal/architecture/metrics.md#agents-model-and-work-analytics).

Provider names are words, never logos: `ProviderBadge` renders the product name in a standard `.commandChip`, or as plain inherited text (`variant="text"`) inside headings and inline list metadata. Provider logos are third-party trademarks and do not ship in the application; Settings → About states that Pomegr is not affiliated with the providers.

The Sessions directory toolbar ends with a **Group by** `.commandSegmented` control (**Recent**, **Repository**, **Provider**, **Feature**), labeled by muted 12px text and remembered per browser. **Recent** keeps the newest-created page and its Previous/Next footer, split under creation-day sections: **Started today**, **Started yesterday**, **Started in the previous 7 days**, and **Started earlier**; a section header carries no count, because it covers one page. **Repository**, **Provider**, and **Feature** list groups by their newest-created session, so live updates never reorder them, each with its newest-created sessions and, when more exist, one text link **Show all N in <group>** that narrows the list to that group with a **Repository:**, **Provider:**, or **Feature:** filter chip and ordinary paging. Group headers are `CommandTable` row groups: a full-width header cell on the canvas tone holding one quiet toggle (`.commandQuietAction.commandSessionGroupToggle`, not a seventh role, 40px, 44px on phone) with a 12px chevron that turns 90° when open, the 13px/600 group name, a data-font session count, green **N live** and amber **N needs input** status only when present (and never the one the selected **Live** or **Needs input** scope already implies), and a right-aligned data-font **Updated** time. A row under a repository or provider header omits that field from its metadata line, and under a Feature header its Task cell prints only the step. **Feature** lists only sessions started for a feature's task, and a client that cannot read tasks gets an explanatory empty state instead. The grouped footer is one muted line (**N repositories · M sessions**, or **Showing the N most recent of M repositories. Filter sessions to reach the others.**) with no pagination. On phone the control stretches to the full toolbar width. `/design-system` renders an open and a collapsed group.

The Sessions directory is a `CommandTable` whose rows stay neutral within a cache lifetime. The primary agent's cache timing adds one 12px `timer` glyph after the Updated time as the shared dotted disclosure (`.commandSessionCacheTiming`), with no visible text: amber while a `5m` or `1h` lifetime is nearing its threshold (accessible name **Cache ~Nm left**), then muted at 55% once it has passed (**Cache lifetime elapsed**), on live and historical rows alike. Its trigger keeps a 20px box on desktop and 28px on phone. It is a composition of `DottedInfoPopover`, `CommandIcon`, and the existing cache-timing popover rows, never a chip, badge, or seventh button role, and it never describes subagent caches.

Session headers show recorded or live lifecycle state in the status card without a duplicate identity badge. The provider row omits the repository name already shown in the breadcrumb, including while session evidence loads. Live and historical views omit the redundant status row; connection failures remain visible. The live status card uses the shared activity labels, including In progress for working sessions. Phone summary disclosures identify the summary source once in their toggle, with agent-reported signals retained below. Session toolbars offer report download without a pause action.

Session detail uses the shared page header, followed by five persistent KPIs on desktop and three on phone: Agents (active count), Context (labelled as the sum of latest agent snapshots), and Calls (repeated count), each a padded cell with one sub-line. On phone the header meta keeps only the provider, status, and branch chips and, for a session started for a task, its task meta; the session ID, start time, and Download report action are desktop-only. Its tab rule sits directly below the KPI strip. Desktop exposes Overview, Agents, Activities, Repository, Signals, Resources, and Details, then Task for a session started for a task; phone exposes Overview, Agents (with its count badge), Activities, Repo, and More (with a chevron) as content-width tabs spread across the row without horizontal scrolling. More opens the remaining real tab destinations. A tab switch preserves the `agent`, `request`, and `path` query selections. Overview orders Right now, Events, Requests, Repository, Progress, Tool calls by kind, and Cost on phone, each in its own bordered panel; Right now rows stack the agent name over its latest action with context on the right, and the whole row opens the agent. Missing readiness stays unavailable. Request preview bars show request-local fresh tokens (uncached input, cache write, and output) and exclude cache reads, in a fixed window of the latest 48 requests on desktop and 24 on phone.

Role tint is the only exception that colors normalized agent roles. It appears only in agent tracks and their legends: orchestrator uses neutral track grey; explore and researcher use reading blue; plan uses planning teal; builder and tester use writing ochre; reviewer uses reviewing rose; general-purpose, workflow-worker, and fork use generic grey; compaction, unknown, and validated custom roles use lighter system grey. `app/role-family.ts` owns the mapping. Same-role agents share one tint. Roster rows, trees, lanes, and agent-name dots do not use these colors; status dots keep their lifecycle meaning.

### Session Evidence

Overview and Signals follow the link rule: panel headings open their tab, and Show agent is a quiet action. On Overview every heading link (Right now, Requests, Repository) is the eyebrow: uppercase 11px/500 caption in ink with the muted chevron, the form Repository introduced; headings that are not links (Events, Progress, Tool calls by kind, Cost) use the muted `.sessionEyebrow`. Efficiency signals appear only on the Signals tab, not on Overview. On desktop Overview is a 4/6 + 2/6 split above one bottom row. The left column stacks Right now, then Requests, which grows to fill the remaining height; the Events panel fills the right column for the full height of both. Below 1181px a 2/6 rail is too narrow to read a row, so Events drops under Requests at full width and the bottom row becomes two columns. The bottom row holds Repository, Progress, Tool calls by kind, and Cost as equal-width columns in that order; Repository always renders, and the others render only when they have evidence or a readiness message to show. The request strip always draws 48 slots so a bar keeps its width in a new session, with a separate 6px role-track row beneath the bars. Tool calls by kind omits medians under one minute. Repository is a compact tile: its heading link (an eyebrow on desktop, the 16px heading on phone), then the branch beside a comparison chip toned green only for Up to date or integrated comparisons, then a muted changes/pull-request line. Repository, Progress, Tool calls by kind, and Cost use compact 12px/16px padding, and all but Repository use eyebrow headings.

The Events panel (`SessionEventsPanel`) is a fetch-free list of high-level session transitions, newest first, under a plain eyebrow heading (`Events · newest first`, the same eyebrow as Tool calls by kind); the heading is not a link, because each row opens its own tab. Each row is one real button composing the quiet role (`.commandQuietAction.sessionEventRow`, not a seventh role) with four parts: the recorded local time as 24-hour `HH:mm` in the data font, a 16px stroke glyph, a label with a muted detail, and a trailing 12px chevron in the strong line tone. Glyphs are neutral and muted for every kind; no row uses a tone color, amber, or green, because the label names the transition. On desktop the label and detail share one ellipsized line in 40px rows; on phone they stack as two lines in rows at least 48px. A row prints only what its kind owns (an agent label, a wall time, a signal label marked agent-reported, a progress percent and phase, a resource name, a pull-request number) and never prompt, command, file, or tool content. Each row opens the tab that continues its evidence: Agents with the agent selected, Signals, Activities, Resources, or Repository. The progress-estimate row is the exception: no tab owns the estimate, so it is plain text (`.sessionEventRow.isStatic`) on the same grid, with no button, chevron, hover, or pointer. Desktop shows 9 rows and phone 5. When more loaded events exist, the footer expander reads **Show N earlier**, then **Show fewer**, as a text link; it is the panel's one in-content pointer. On desktop (761px and wider) the expanded list keeps the collapsed nine-row height and scrolls inside it (`.sessionEventList[data-expanded="true"]` caps `max-height` at `--event-row-height` times `--event-collapsed-rows`), so the panel and the Requests panel sharing its row never grow; phone leaves the expanded list unbounded for page scroll. The panel collapses again when the session changes. The muted footer total reads `N events` (`1 event`), with `en-US` digit grouping on every locale; it counts the events derivable from retained evidence, never a complete session history, so it carries no session claim. The footer is omitted when there are no rows. A feed that is not ready shows the shared unavailable line (**Event evidence unavailable.** or **Loading Event evidence…**); a ready feed with no events reads **No events recorded.** The panel always renders so the layout stays stable. `/design-system` renders every state from static data.

Consecutive Overview events with the same kind, detail, and agent collapse before
the row limit into one row. A muted data-font `×N` count stays visible beside the
text on desktop and phone. The row retains the newest event's time and destination;
its accessible count explains that the newest event is shown. Different details,
agents, or intervening events break a group. The footer total still counts events,
while Show N earlier counts hidden rows.

Activities is a grouped request feed below the Requests chart and its scoped
Largest strip. The strip is one wrapping line under the minimap, with no request
detail panel below it. Its quiet **Largest by uncached input** button cycles the
metric through uncached input, cache write (only when the provider records it),
total, and output. Up to three requests with a non-zero value follow, each a quiet
action showing `#n`, the agent name, and the request-local count; selecting one
selects its request. Counts use the shared request-token format: `compactNumber`
text (139.7K), the exact value in the hover title (`requestTokenTitle`), and the
exact value in the accessible name, matching the feed's token cells. A 360px Tool calls by kind rail with
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
prints the same counts in the same colors, tightened to an 8px gap, ahead of its muted
request time, and a tap opens the four exact counts. One rule separates
request groups; a request line and its calls carry no rule between them. Desktop request
lines are 34px and their call rows 30px, so each request reads as the header of a compact group.

Foreground request-window loading keeps the last committed chart and feed visible
under a local neutral veil and announced loading status. The chart and feed never
mix selections, and failed or loading work retains last-known-good evidence rather
than inventing counts. Historical sessions do not follow live appends. Request
links are recorded associations, not token or cost attribution; activity without
a proven request association is omitted from this grouped presentation. Its tool calls
are listed in a separate "Actions without a recorded request" section below the request
groups, ruled apart from them and never attributed to a request, with no request number or
token value; it is built from existing roles and tokens, with its static samples on
`/design-system`.

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
layout: a 210px seven-tab rail (Overview, Files, Git, Tasks, Plugin, Context inventory, Reporting) on desktop and its horizontal mobile strip, with
the active tab backed by `?tab=` in the URL. Overview shows snapshot facts,
linked setup summaries, and the five most recent associated sessions. Plugin
groups plugin installation instructions and native actions by provider.
Reporting shows the shared policy state with always-visible setup guidance.
Tasks holds one short pane: a heading, one sentence, and the Secondary **Open task board** link to `/tasks?repository=<repositoryId>`. The board itself lives on the Tasks page, specified under Task board and queue below.
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

### Task board and queue

The **Tasks** page (`/tasks?repository=<repositoryId>`, a root route; the repository detail's Tasks tab only links to it) is a composition of the existing roles, chips, and tokens; it adds no button role. In page order it holds the shared page header, the **Queue status** banner (only while the queue is blocked or paused), and then either the **Board** (capacity strip, feature filter, lanes of task cards) or the **Queue** view (feature panels with steps, **Single tasks**, **When the queue blocks**, and a right column with the **Start gates** and **Schedule** panels). One desktop-only modal, the task modal in its three modes (new, promote, and edit), holds the task fields. A session started for a task adds the session surfaces at the end of this section. Every element draws committed board facts, so a state is never shown and then retracted, and a client that is not on this computer reads only a **Desktop only** notice. The page header is `CommandPageHeader` with the h1 **Tasks**, a muted description, and the head actions (`.taskHeadActions`) at its end: they wrap, use a 12px gap, and start with the **Repository** `CommandSelect` (32px, 12px text, 44px on phone and coarse pointers, at most 240px wide), then a **Tasks view** `.commandSegmented` switch (**Board**, **Queue**) once the board is ready, then in the desktop app the queue switch and **+ New feature** on the Queue (on the Board once it has a feature, its filter row carries it), and last, where the desktop issues bridge exists, the Secondary **Promote issues** link (a 14px circle-dot glyph; it opens the Promote issues page and, like the other desktop-only actions, is decided at first render). The header has no primary action: **New task** lives in the first lane. The repository comes from the validated `repository` URL parameter; with none, or one the inventory does not list, the first listed repository is shown and the URL is replaced once with its canonical form, and while the repository inventory loads the page draws the five-lane placeholder, never a board that is then withdrawn. Choosing a repository replaces the URL, remounts the board (so no panel state carries over), and keeps focus on the switcher. A browser instead reads one muted line saying tasks are created and edited in the desktop app, decided at first render, and every client reads one muted line saying whether the queue is off or on.

**Board.** Columns sit in `.taskBoardGrid`, `repeat(var(--task-columns, 5), minmax(220px, 1fr))` with a 12px gap, inside a focusable **Task board** region that scrolls sideways instead of shrinking a column below 220px. A column is a **lane** (`.taskColumn`): at least 240px tall, and on the Tasks page (wider than 760px) exactly as tall as the window leaves under the page header, gates and filter, so the page itself does not scroll: each lane scrolls its own cards under a thin scrollbar (the Queue view fits the window the same way from 1100px wide, where the queue and the settings column each scroll on their own) while its header and **+ New task** stay in view, the raised fill (`--command-panel-2`), a one-pixel `--command-line` border, the panel radius, 8px padding and an 8px gap, with its cards on the panel fill. The lane under a dragged card cannot take the raised fill, so it takes the strong line (`--command-line-strong`) on its border, drawn two pixels wide (an inset one-pixel ring), in both themes. The board has five fixed columns (Backlog, Ready, In progress, Review, Done), and the column header is the name (13px/650, ink) and a data-font count (12px, muted) over a one-pixel `--command-line` rule, with no control in the desktop app or a browser: columns are never added, renamed, moved, or deleted. In the desktop app the **first lane only** ends with the Quiet **+ New task** (`.commandQuietAction.taskColumnAdd`: a 14px plus glyph and the label, 32px tall, 8px side padding, left-aligned under the last card, also in an empty lane). It is invisible (opacity 0, never `display: none`, so it stays keyboard-reachable) until the lane is hovered or holds focus, always visible and 44px tall on a coarse pointer and 44px tall at 760px and narrower, and has no transition. It opens the New task modal (`aria-haspopup="dialog"`) and takes focus back when the modal closes. The Queue view has no lanes, so the action is on the Board only. The feature filter (`.taskFeatureFilter`) appears once the board has a feature: a row with a muted caption eyebrow **Feature** and one `CommandSelect` (`.taskFeatureSelect`, 32px, 12px text, 44px on phone and coarse pointers, at most 320px wide) whose options carry the task count in parentheses, **All** first and **No feature** last, chosen so the row stays one control however many features a board holds. The desktop app adds the Quiet **+ New feature** (an inline name form; with no feature yet it sits in the head) and, while a filter is on, the line “Moving cards is off while a feature filter is on.” Above it, the capacity strip is one muted 12px row: a **Start gates** eyebrow, each provider with its two percentages in the data font, and “A task starts only when its provider has capacity.” A loading board draws five placeholder lanes (the lane frame holding a 40% title bar and a 64px card block); an unavailable one draws a panel notice with a status role; a board with no task adds the muted “No tasks on this board yet.”

**Task card** (`.taskCard`): panel fill, one-pixel `--command-line`, 6px radius, 12px padding, 8px gap. The top row is the task ID (data font, 12px, muted) and the state chip. The title is 13px/500 ink clamped to six lines (the task text until its session has a title; a Done card's title is muted), and in the desktop app it is the Quiet role drawn as plain title text, underlined on hover, that opens the Task modal. Below it come, each only when set: the provider badge with the planned “model · effort” in the data font; the muted **Observed model:** line or, when a planned model and the observed one differ, the single amber line “Planned x, observed y” (a text color, never a fill); the muted **Starts** line of a scheduled task until its session is linked; one muted **Done when** line; the feature line “Feature · step k of n · parallel”; and last **Open session**, a Text link that is not stretched. The border turns green while the bound session works and amber for Needs review, Stalled, and Blocked by agent.

**State chips** are the shared `.commandChip` outline label, and a tone recolors only the text. Not queued is neutral and muted; Queued is neutral in ink on the raised fill with no border, so it differs from Not queued, and reads **Queued · next** for the one task the monitor lists first; Scheduled is info and, in the Queue view's single-task row, carries its time; Needs review, Stalled, and Blocked by agent are warning; Done is neutral. While a session is bound and the task has no outcome, the chip is the session's own state with the Sessions list words and tones (In progress positive, Needs input warning, the rest neutral). There is no Running task state, and a session state the monitor has not committed leaves the task's own chip. The **issue chip** is the same outline `.commandChip` with the class `taskIssueChip`: an 11px circle-dot glyph (1.7 stroke, current color) and `#N` in the data font at 400 `--text-caption` 11px/1.3, gap `--space-1`, muted text on the panel line. It is a label, never a link, and its accessible name is “GitHub issue #N”. It appears right after the task ID on a card (board and queue step cards), in the Source line of the session view's Task tab (“Source”, the chip, “GitHub issue”) and as the Source cell of the Overview Task panel. It is shown only for a task with a source.

**Moving cards** is a desktop-app action. A movable card shows the grab cursor; dropping on a column appends, dropping on a card places the dragged card before it, and the dragged card itself does not change. The keyboard alternative is a `toolbar` named Move T-n of four Icon-role arrow actions (one tab stop, arrow keys and Home/End inside) drawn only while the card holds keyboard focus, always drawn on a coarse pointer, and otherwise kept in the accessibility tree. A muted footnote under the board explains dragging, and nothing moves while a feature filter is on.

**New task modal.** In the desktop app the first lane's **+ New task** action opens the task modal in mode new (`aria-haspopup="dialog"`). The heading is **New task**, the subtitle “repository · in Backlog” (the first column's name), and focus starts in the Task field. The body holds the Task field with its counter, then Feature and Step, Run on and Effort, and Done when (the shared task fields, described under **Task fields** below). The footer is a flexible spacer, a Quiet **Cancel** that closes and writes nothing, and the one primary **Create task**, which is disabled until the Task field holds text and a new feature has a name. Create closes the modal and the board shows the task in the first column; a failure keeps the modal open, keeps what was typed, and says so under the Task field. There is no “create and add another” and no footer note.

**Task modal, mode edit.** A card's title opens the task modal for one stored task. The header holds the heading **Task**, the task ID in the data font, the state chip, and the subtitle “repository · in column”. Text, Run on, Effort, Done when, Feature, and Step are a local draft: nothing is sent until **Save**, the one primary, which is disabled until the draft differs from the stored task (and while the text is empty or a new feature has no name). Save creates a new feature first when one is being named, then sends one patch holding only what changed, and closes the modal; a failure keeps the draft and says so under the Task field. Close and Escape discard the draft without asking. While the draft is unsaved, **Start session**, **Add to queue** or **Remove from queue**, **Mark done**, and **Requeue task** are disabled and one muted line says “Save your changes first.”. A task promoted from a GitHub issue starts the body with a **Source** block: the 12px/500 label **Source**, the issue chip, and the muted caption “GitHub issue” in one wrapping row (no promoted-at time is shown, because none is stored); its text stays editable like any task's. A task whose title comes from its session follows with that title and a muted helper that links **Open session**. An amber notice (amber line, amber-soft fill, **Observed model differs**) follows Run on when the observed model differs from the planned one. Done when lists each checked condition's **Passed** (green) or **Not passed** (error) from the agent's report with the report line below it, and in the Feature fields the open task is left out of the folded list while each row leads with its step number. A task that still waits for a session ends with **Start at**, its own start time, a `datetime-local` time field (see Schedule below) that saves by itself. The footer's top row (`.taskModalResolve`) holds the muted start-status note, **Open folder** after a dirty-worktree start, and, for a task that needs the user (Needs review, Blocked by agent, Stalled), the Secondary **Mark done and resume queue** and **Requeue task** (a task that needs review holds no queue, so its first action reads **Mark done**; a linked task that has not reported offers **Mark done** and **Requeue task** with a line that neither stops the session). Below it, from the left, the Quiet **Delete task**, which swaps in an inline confirmation with a secondary delete and a quiet Keep task and no native dialog, then a spacer, a Secondary **Add to queue** or **Remove from queue**, a Secondary **Start session** (native confirmation first), and the primary **Save**. Footer actions are drawn at 36px at 761px and wider with a fine pointer, a local deviation taken from the task-board design.

**Task modal, mode promote.** The page's **Promote** opens the task modal for that one issue (the modal never lists issues). The heading is **New task** and the subtitle “repository · in Backlog”. The body starts with the issue content, a 12px-gap column: the **Source** group (the label **Source**, the issue chip, the one status chip of the page's row, and under them the issue title as a 14px/650 `h3`), then the notices in the page's order (outside contributor, hidden comments, too long; the shared `.taskNotice`), then the page's read-only raw body as a focusable 150px region with the right-aligned count “n / 4,000 characters” under it. There is no Task field: the issue text is shown but never sent, and a promote carries only the issue number and the digest of the version shown. Feature and Step, Run on and Effort, and Done when follow as in mode new, with the same defaults. The footer starts with the muted line “The pull request will say Closes #n.” (the reference in the data font), then the Quiet **Cancel** and the one primary **Promote issue**, which is disabled while a promote runs, for a too long or an already promoted issue, and while a notice below holds it. Promote makes the task in the first column, then sends one update holding only what differs from the task the monitor made (no feature, nothing planned to run, no done-when condition, so the default Pull request open and Working tree clean checks are sent unless they were cleared) or no update when nothing differs, refreshes the board, asks the page to read the issues again so its row reads **Promoted · T-n**, and closes. A notice that follows an attempt joins the issue's own, is a `role="alert"`, and uses fixed words: a conflict reads “This issue changed on GitHub or was already promoted.” with a Secondary **Show new version** that reads the issues once more and keeps the chosen fields (the notice clears when the new version arrives, and the modal closes with the page line “Issue #n is no longer open.” when the issue is gone); a too long answer and “This issue is no longer open.” leave Promote issue disabled; any other failure reads “The issue could not be promoted.” and allows another try. When the task was made but its update failed, the modal drops the fields, says “The issue was promoted to T-n, but the run settings could not be saved. Open the task to set them.”, and offers only a Secondary **Close**, so an issue is never promoted twice. Focus returns to the page's Promote button, or to the chosen row when that button is disabled by then.

**Task modal frame.** `TaskModalFrame` (`app/components/tasks/TaskModalFrame.tsx`) is the shared frame of the one task modal, in the modes described above. It is a native modal `<dialog>` that fills the viewport and is itself the scrim: `--color-text` mixed to 40% over the page (`color-mix`, no literal color; the scrim has no token of its own and is distinct from the Home dialog's `#0008`), scrolling when the panel is taller. The panel sits top-aligned in it, 32px from the top, at most 640px wide, with the panel fill, a one-pixel `--command-line` border, the panel radius, and the overlay shadow; there is no entrance or exit motion. Its header (`.taskModalHeader`, 8px/12px/8px/24px padding, a one-pixel rule) holds a title group (`.taskModalTitleGroup`: the 16px/650 `h2` that names the dialog and an optional extra, the task form's data-font task ID and state chip), a muted 12px subtitle (`.taskModalSubtitle`, “repository · in column”) that takes the remaining width and truncates, and the Icon-role **Close**. The body (`.taskModalBody`) is a 16px-gap column with 24px padding. The footer bar (`.taskModalFooter`) has a one-pixel top rule, no fill, 12px/24px padding, an 8px gap, and wraps: `.taskModalSpacer` pushes the actions to the end, `.taskModalResolve` is a full-width row at its top, and `.taskModalNote` is quiet 12px text. Footer actions keep their roles, are never stretched, and are drawn at the control height (36px) at 761px and wider with a fine pointer and at 44px otherwise, local deviations from the role defaults taken from the task-board design. At 760px and narrower the dialog has no scrim padding and the panel is full width and full height, with the 16px body and footer padding. Focus moves in on open (the form's first field, or Close), Tab stays inside, Escape and Close dismiss it unless a control inside handled the key first (an open list, a feature name being edited), and a click on the scrim closes it only while the form holds nothing to save (an unchanged task, an empty New task; never the promote form), so typed text is never lost to a stray click. The panel is centred in the window. The opener takes focus back. A `CommandSelect` list opened inside renders inside the dialog. `/design-system` draws the chrome (`TaskModalChrome`) from static data over a static scrim, without the dialog behavior.

**Task fields.** The New task and Task forms share these fields, all optional except Task; the Promote form shares all but Task. **Task** is a label, a `textarea` at least 150px tall in 13px type with the placeholder “What should the session do?”, and under it a right-aligned muted data-font counter, “n / 4,000”. In the desktop app the New task and Task forms follow it with the task's **images** (`TaskImageField`, `.taskImages`): the Quiet **Attach image** (it opens the native file picker and reads **Attaching…** while an image is stored), a wrapping 12px-gap row with one item per image, a 72px square thumbnail (`.taskImageThumb`: one-pixel `--command-line-strong`, the control radius, `object-fit: cover`, on the ground fill until the image is read) with its Icon-role **Remove Image n** beside it, one muted helper line, and an error line as a `role="alert"`. A paste into the Task field that holds an image adds it and types nothing. A task holds at most four images, and Attach image is disabled at four. In the New task form the images wait in the form until the task exists; in the Task form attach and remove act at once and are not part of the Save draft. A browser draws none of it. **Feature** and **Step** share a two-column row (one column at 760px and narrower): Feature is a `CommandSelect` listing unfinished features, No feature, and New feature…, which reveals a one-line name field in place (Enter or leaving it commits, Escape cancels); Step offers Last or an existing step. Once a created feature is chosen, a folded **In this feature** disclosure (a native `details` between two rules, a 44px summary with a muted chevron and a “n tasks · m done” count in data-font numbers) lists the feature's other tasks. **Run on** and **Effort** share the next two-column row: Run on is one `CommandSelect` grouped by provider that lists each provider's observed models and a Default model entry, with Not set as its clear state; Effort is a four-way segmented control (Low, Medium, High, Xhigh) whose pressed segment clears when pressed again. **Done when** is a fieldset with a legend: a wrapping row of five native checkboxes with the short labels “PR open”, “Tree clean”, “Commit on branch”, “PR merged”, and “CI passed” (28px rows, 44px at 760px and narrower and on coarse pointers), then one 36px text input named Own condition with the placeholder “Own condition, judged by the agent (optional)”. A non-blank own condition is the agent-judged condition and a blank one is none; there is no checkbox for it.

**Promote issues page.** `/tasks/issues?repository=<repositoryId>` (below the Tasks root item, so Tasks stays current) is where the owner chooses a GitHub issue to promote into a task. It is the shared page header over one panel (panel fill, one-pixel `--command-line`, panel radius): the Quiet **Tasks** back link is the header's breadcrumb (muted, a 14px chevron-left), the h1 is **Promote issues**, its meta is a muted 12px count line “repository · n open issues, m not promoted” (“n+” when the list was cut at 100), and the Quiet **Refresh** is its action. Inside the panel a muted 12px caption (“Promoting copies the issue title and body into a task once. Later edits and comments are never read.”) sits over a rule, then the split body. The list (flex `1 1 340px`, at most 420px, a rule on its right; stacked above the detail at 760px and narrower) holds one full-width row button per issue (`.promoteIssueRow`, `aria-pressed`): the number in the data font and the 13px/500 title, over one chip and “Updated 8 Oct” (the year only when it is not the current one; no opened date is served). The chip is **Too long** (negative), else **Promoted · T-n** (positive), else the author association, **Owner**, **Member**, or **Collaborator** in the neutral tone and **Outside contributor** in the warning tone. Hover tints the row with 6% ink, the chosen row takes the raised fill, and its focus ring is inset (offset −2px) because the rows touch. The detail (flex `999 1 480px`, 24px padding, 12px gap) holds the data-font number, the 16px/650 title as an h2, the chip and date, the notices, the raw body, and a footer with the data-font count (“n / 4,000 characters”, in the error color over the limit) and the page's one Primary **Promote** (`aria-haspopup="dialog"`; it opens the task modal in mode promote), a button disabled for a too long or an already promoted issue. A **notice** (`.taskNotice`, shared with the task modal) is a soft-filled box with 8px/12px padding, a one-pixel line in its tone, the control radius, and 12px/1.5 text in that tone, never a side stripe: warning for an outside contributor and for hidden comments, error for too long, positive for “Already on the board as T-n.” with a Text link **Open task**, in that order. The **raw body** (`.taskIssueBodyBox`) is a focusable region under a “Raw body” label and the caption “Exactly what the agent will read”: the issue text in the data font (12px/1.4), `pre-wrap`, on the canvas fill with a one-pixel line and the control radius, at least 240px and at most 560px tall, scrolling inside. A hidden HTML comment is a struck-through segment in amber on the amber-soft fill with a visually hidden “Hidden comment:” prefix. Issue titles and bodies are third-party text: React text only, never Markdown, a link, an image, or browser storage. A state replaces the list with a fixed title and detail and never issue text: loading, no open issues, GitHub not signed in and GitHub CLI missing (each with a Text link to Settings → GitHub), no access, issues turned off, repository not found, and one generic message for a failed read (a failed Refresh keeps the last list and adds one error line). A browser, or a desktop build without the issues bridge, reads “GitHub issues are read in the Pomegr desktop app.” and attempts no read. The page reads once when it opens and once per Refresh, never on a timer, on focus, or on a GET; while it reads the section is `aria-busy`, Refresh is disabled, and the last list stays on screen, and the chosen issue stays chosen by its number across a refresh. The task modal's **Show new version** and a finished promote each ask for one more read, and no other action reads.

**Queue.** The queue switch is a two-way segmented control (Off, On) named Queue, with a muted Queue eyebrow before it; On stays pressed while the queue is blocked or paused, and pressing On while paused is the retry. While the queue is blocked or paused, a **Queue status** banner sits above the Board and above the Queue: the error-soft fill with the error line, a title in the error color, body text in ink, and its actions on the right, wrapping under the text when narrow (on phone they take their own row, the secondary actions sharing it equally). In the desktop app the Board banner has one secondary **Open T-n** and the Queue banner adds a secondary **Mark done and resume** and a quiet **Requeue T-n** drawn in ink; a paused banner (**Queue paused**, with one fixed reason) offers only Open T-n, and a browser's banner is text only. The banner's secondary actions use the strong line on the panel fill, a local deviation taken from the task-board design. The Queue view is `.taskQueueRow`: a left column (`.taskQueueView`, `flex: 999 1 480px`) with one `.panel` per unfinished feature, **Single tasks**, and the **When the queue blocks** panel, a two-item list whose state words carry the error color (Stalled, Blocked by agent), closed by one muted line that says Needs review, in amber, does not block the queue; and the right column below. A feature panel has 16px padding and gap: the feature name as a 16px/650 heading, a muted 12px “n of m tasks done” with data-font counts, then its steps as rows divided by one-pixel rules. A step has a 96px label column (“Step n” 12px/650 ink; “One task” or “Parallel · n” in 11px muted; “One worktree each” when parallel) and its cards in a three-column grid (one column, label above, at 760px and narrower). A queue card is the board card at compact padding (8px/12px, 4px gap) without the Done when and feature lines, plus the muted **Waiting:** line on the next task while a gate holds it. In the desktop app a queued task of a feature drags to another step (the step takes the raised fill; a step whose tasks are all done accepts nothing) or onto the one-pixel dashed **new last step** zone, and its **Move to step…** `CommandSelect` is the keyboard alternative, drawn like the move toolbar. A muted note ends the panel, and the read-only copy drops its drag sentence. **Single tasks** has the muted caption “Run after features, one at a time” and one wrapping row per task: ID, title, planned run, state chip, and any Waiting line; a queue with nothing in it reads “Nothing is in the queue yet.”

The right column (`.taskQueueAside`, `flex: 1 1 280px`, at most 360px, wrapping under the queue when narrow) starts with the **Start gates** panel: the heading, one caption, and a definition list of five rows with the label left and the reading right. A reading is green when the gate passes, error when it holds, and muted when it is unknown or no task is queued; the two capacity readings are mono, print only the percentages the board sent, and append “· above threshold” when they hold. Below the rows the **Do not start above** field is a `CommandSelect` with the three fixed thresholds in the desktop app and plain text in a browser. The Board's capacity strip shows the same two capacity readings, and the next queued task's card adds one muted **Waiting:** line while a gate holds it and the queue is on. All three are local to the Tasks tab and use the `taskGate*` classes in `app/styles/tasks.css`.

Under it, in the same column, the **Schedule** panel shares the gates panel's frame, heading, field, and caption classes. In the desktop app it holds a `.commandSegmented` pair, **Run now** and **Start at a time**, a **Start at** time field shown only for the second, a **Stop starting tasks after** time field, one muted line under a field that names the day of its stored time or says that it has passed, and the fixed note that a running session is never stopped and Pomegr must be open. A browser reads the same two values as a two-row definition list. A time field (`.taskTimeInput`) is a native `time` or `datetime-local` input at control height with the stronger control line, the control radius, and the data font; the Task modal's **Start at** field uses it for a task's own start time. A scheduled task's chip reads **Scheduled** in the info tone, with its time in the Queue view's single-task row, and its card adds one muted **Starts** line until its session is linked.

**Session task surfaces.** A session started for a task gains four surfaces from the task reference the monitor joins at serving time (same-computer clients only; any other client sees none of them). The Sessions list **Task** column is second, 200px wide, and spans the card on phone: the task ID as a Text link in the data font to the repository's board on the Tasks page, beside an outcome chip only for what the session's own State cannot show (Needs review and Stalled in the warning tone, Done neutral; Blocked by agent is served but has no chip), then a muted 12px “Feature · step n” line, or just “Step n” under a Feature group header. For a task promoted from a GitHub issue, the number follows the ID as plain muted `--text-xs` data-font text (“#128”, no chip, border, icon or link), so the ID stays the one prominent identifier; assistive technology reads “GitHub issue #128”. It sits before the outcome chip. A session you started shows an em dash, and one muted footnote under the table explains the column. Grouping by **Feature** is the fourth Group by option; it lists only sessions started for a feature's task. The session header's meta row adds **Task** with the ID as a Text link to the Task tab (plain ink text on that tab), then **Feature** with the name linked to the board and the data-font “step n of N”, in muted 12px text; it stays on phone. On Overview, a **Task** panel opens the page above Right now: a `.panel` with 12px/16px padding in a wrapping row, headed by the panel heading link “Task T-14” (16px/650, the ID in the data font, a muted trailing chevron) to the Task tab, an outcome chip, and up to four cells (11px caption eyebrow over a 13px value): **Feature**, **Done when** (“2 checks + agent report · not yet reported”), **Model** (“Planned x · observed y”, data-font identifiers), and **Next** (the next step's task numbers, or “Queue blocked by T-n” in the error color). The **Task** tab is last, listed only for a task session, and read-only: a task panel (flex `999 1 480px`) with the heading, chip, a muted “Started by Pomegr”, and a Secondary **Open on board** at the end of its head; the task text; Planned and Observed side by side (one column on phone; Observed in amber when it differs); a ruled **Definition of done** with the agent-reported status; **Checks when the agent reports complete** as 36px rows with a right-aligned result (Passed green, Did not pass error, otherwise muted); and any block reason. A Feature aside (at most 480px) shows the feature name as an ink Text link, the data-font “n of m done”, **Same step as this session** and **Next** rows (ID, a title linked to that task's session or the board, and its chip), and, while the queue is blocked, one error-colored note. Without a ready board, or when the board does not hold the task, each surface draws only the reference's own fields and one quiet sentence, and none of them edits a task.

`/design-system` renders the task fields (including Feature and Step), the task modal's chrome in modes new, promote, and edit as static markup, the cards in every state, column headers, lanes (the first lane with its + New task forced visible, an empty one, and one in the drop-target state), the feature filter, the capacity strip, whole boards and Queue views in their browser and desktop forms, the queue switch, banners, step cards, feature panels, single tasks, the blocking rules, Start gates, Schedule, and the Sessions list Task cell, all from synthetic tasks, and the Promote issues parts (the header action, row chips, page header, list and detail, notices, raw body with a hidden comment, character count, and every state) from invented static issues. The modals' dialog behavior and their saves through the desktop, and the session header meta, Overview Task panel, and Task tab (which read the board through the task store), are specified here but not rendered there.

### File tree and file history panel

FileTree (`app/components/repositories/FileTree.tsx`) is a shared, fetch-free
presentation control behind the session Repository tab's Touched here / Uncommitted /
Changed elsewhere tree and the repository Files tab. FileHistoryPanel
(`FileHistoryPanel.tsx`) serves the repository Files tab; the session tab pairs the tree
with SessionFilePanel instead. The session Repository tab's file toolbar ends with a neutral **Beta** `.commandChip`
(right-aligned on desktop, left-aligned below the segments on phone, `title` **File coverage is
still being expanded.**) while file coverage is still in progress. FileTree is a `panel` (1px border, 6px radius) in a column with overflow
hidden: an 8px/14px header row shows the repository name as a muted 11px uppercase
eyebrow, with a right eyebrow **Sessions** in repository scope. Rows are 13px with
6px/14px padding and indent 14/30/46/62px per depth (folders first, then files,
alphabetical); folder rows carry a 12px chevron (right collapsed, down expanded) and a
mono folder name, file rows carry no chevron. Rows are keyboard-reachable buttons;
Enter/Space selects. Folders default collapsed except ancestors of the current
selection and top-level folders with 12 or fewer files total; `expandAll` (search
active) opens every folder. The selected row alone takes the raised surface and ink
text — nothing else marks selection. Session scope shows an editor-style working-tree
status letter right-aligned at the end of the row (`.fileTreeStatusLetter`: 11px
semibold mono, no chip frame, tone in text only, with the full word as its `title` and
accessible name) — amber **M** (Modified), green **U** (Untracked) and **A** (Added),
neutral **D**/**R** (Deleted/Renamed). When the working tree reports no status (committed
or reverted), a touched row falls back to this session's recorded kind as a neutral
muted letter — **C** (**Created in this session**) or **M** (**Edited in this session**),
never amber because nothing is pending; deleted and moved kinds show no letter. A
Git-observed row without a recorded kind uses its Git net change the same neutral way:
**A** (**Added in a commit by this session**), **M** (**Modified in a commit by this
session**), or **D** (**Deleted in a commit by this session**) —
and, after the tree, an eyebrow **Changed elsewhere** group of flat uncommitted rows
(full path, indent 14, their own status letter) that is hidden when empty. A touched row
one of the session's own Git commands committed but no tool ever recorded carries a
quiet 14px git glyph after the file name:
muted text color, never amber, shown on historical rows too, with `title` and an
accessible name reading **Committed by this session - not a recorded tool edit**;
selecting the row still opens file history as
usual. Repository scope shows each file and folder's distinct-session count
right-aligned in muted 11px mono from the monitor's rollup; files with no recorded
session history show no count and render muted. A pinned footer rule reads **Status from the working tree · select a
file for its history** in session scope, with a quiet **How to read this** popover
appearing only when a Git-observed row is visible (*Rows with the Git glyph come from
commits made while this session ran a Git command. Matched by time, so they have no
agent or request.*), and
**Folders roll up distinct sessions** in repository scope.

FileHistoryPanel renders the selected file's committed session history on the repository
Files tab, never fetching it itself. Its header holds a muted 11px mono breadcrumb (`<repository> / <dir>/`),
then a row with a file glyph, the mono 14px bold file name, and — only when the file
currently has a working-tree status — a working-tree chip spelling the status out
(**Modified in working tree** amber, **Untracked in working tree** or **Added in
working tree** green), plus a right-aligned header action **Copy path**
(secondary action) that copies the repository-relative path and shows a brief
**Copied** state. A third row reads **N recorded sessions · newest first** beside a
`.commandSegmented` provider filter that appears only when more than one provider is
present among the sessions. Each entry leads with the session title in regular-weight
ink, linking to `/sessions/<id>?tab=repository&path=<path>`, so the bold file name stays
the panel's heading. A single meta line below it holds a kind chip only for the rarer
kinds (**Created** the context/lavender tone, **Deleted** amber, **Moved** neutral —
edited is the common case and gets no chip), the provider chip, one muted text run
joining **N edits** (or **Edited** when an edit recorded no count) and the agent names
(or **N agents** when names are not individually known) with ` · `, and a green
**live** chip for a live session; there are no per-agent role dots; a moved entry
additionally shows a muted mono **as `<old path>`** line. A footer states the honest
Write/Edit coverage caveat with a **How to read this** dotted info popover holding the
longer Git-move and retention explanation. The panel shares one frame across its
states: no file selected, a loading skeleton, **File history is rebuilding.**, **File
history is unavailable.**, **No recorded sessions changed this file.**, and — whenever
evidence includes changes with no session attribution — a muted **N changes without
session attribution (moves seen in Git)** line.

SessionFilePanel (`app/components/dashboard/SessionFilePanel.tsx`) is the session
Repository tab's right panel. It shows only what this session did to the selected file,
built from the repository domain the tab already holds, so selecting a file never waits
on a fetch; the file's history across sessions stays on the repository page. It shares
FileHistoryPanel's frame and header (breadcrumb, file name, working-tree or **at last
live check** chip), with the header action **All history on repository page** (quiet
action, trailing chevron) linking to `/repositories/<id>?tab=files&path=<path>`. One entry
follows: **Recorded in this session** with the kind chip (**Edited**, **Created**,
**Deleted**, or **Moved**, always shown here), a muted
**N changes** run, and the latest change time; or, for a file only a session commit changed, **Committed
by this session · no recorded agent edit** with **Added in the commit**, **Modified in the
commit**, **Deleted in the commit**, or **Net change not recorded**, then a muted caption
**Matched by time to a Git command this session ran. Pomegr can't tell which agent changed
the file.** It never names who changed the file.
Otherwise it reads **No
recorded change in this session.**, shows the loading skeleton while recorded changes
load, or **Recorded changes are unavailable.**

`/design-system` renders both components with static data: a session-scope tree with a
Changed elsewhere group, a selected row, and a Git-observed row, a repository-scope
tree with counts and a muted no-history file, a file history panel sample for the
repository side plus the empty/loading state, and session file panel samples for a
recorded and a Git-observed file.

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
Tool calls by kind rail caveat uses the same quiet treatment. Popover text states only
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
