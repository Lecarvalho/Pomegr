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

**Creative North Star: "The Measured Command Center"**

This file is the written contract for the tokens, the shared controls, and the application shell.
Each product surface has its own page. See [Find the page](#find-the-page).

- Pomegr is a local-first, read-only observer of coding-agent sessions.
- The application is a calm evidence workspace.
- A compact branded header, a persistent route rail, flat panels, one-pixel rules, and restrained semantic color give a reliable scan order.
- The application shell stays provider-neutral.
- Landing and marketing have their own typography and brand treatments. Do not promote a landing decision into the application shell.
- [AGENTS.md](AGENTS.md#security-and-privacy) owns the privacy rules. [Metrics](docs/internal/architecture/metrics.md) owns the metric definitions. This file does not restate them.

**Key Characteristics:**

- Charcoal dark mode and light neutral mode use the same layout and the same semantic roles.
- Inter is the font for all interface hierarchy. Geist Mono is the font for data and execution metadata.
- Evidence surfaces are flat, with 4px controls, 6px panels, and restrained borders.
- The header is 60px high and the desktop rail is 220px wide. Compact and phone widths adapt them.
- Idle states are neutral. Semantic error red is only for an actual error.
- Language is provider-neutral and read-only. Unavailable and coming-soon states are honest.

### Find the page

| Subject | Owner |
| --- | --- |
| Tokens, button roles, chips, fields, panels, tables, shell, navigation | This file |
| Token values | `app/styles/tokens.css` |
| Settings sections and the storage usage meter | [Settings design](docs/internal/design/settings.md) |
| Home and the What's new card | [Home design](docs/internal/design/home.md) |
| Sessions directory, session header, Overview, Events, Signals | [Sessions design](docs/internal/design/sessions.md) |
| Agents panel, inspector, grid, tree, the Agents route, role tint | [Agents design](docs/internal/design/agents.md) |
| Activities feed and the Requests chart | [Activities design](docs/internal/design/activities.md) |
| Repositories index and detail, file tree, file history | [Repositories design](docs/internal/design/repositories.md) |
| Tasks page, board, cards, queue, session task surfaces | [Task board design](docs/internal/design/task-board.md) |
| Task modal, task fields, Promote issues page | [Task modal design](docs/internal/design/task-modal.md) |
| `CommandTable` integration | [Command table](docs/internal/development/command-table.md) |

### Visual reference

- The `/design-system` page is the code-led visual authority. This file and the surface pages are its written contract.
- `app/design-system/page.tsx` serves the page and `app/components/design-system/` renders it.
- The page uses the real shared classes with static sample data only.
- The page renders the six roles and their states, selects, chips and pills, page headers, tab bars, sidebar limits, panels, the agent roster and inspector, the command table, the settings tab rail, and the token scale.
- The page renders on the web development server only.
- The page is absent from every navigation menu and from the LAN allowlist.
- The desktop app renders the not-found view for it, and the desktop shell refuses to navigate to it (`desktop/runtime/security-policy.mjs`).
- No HTML preview, generated component, or seed is required.

### Change this contract

- Put a rule for one surface in the page of that surface, not in this file.
- Write one fact for each bullet or table row, on one line. Do not join rules in a paragraph.
- Add a new shared control to this file and add its sample to `/design-system`.
- Change the contract, `tests/ui/pomegr-design-contract.test.tsx`, and the samples together.
- A surface composes the shared controls. A composition is not a new role or a new visual authority.
- Follow the [style guide](docs/STYLE_GUIDE.md) for language.

## Colors

The application palette is a quiet neutral field with pomegranate identity ink and semantic signals.
`app/styles/tokens.css` is the source of each value.

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

**The Semantic Signal Rule.** Green, amber, lavender, and error communicate recorded state. Neutral styling represents idle, unavailable, and ordinary resting states. Semantic error is never decoration.

Role tint is the one exception that colors agent roles. [Agents design](docs/internal/design/agents.md) owns it.

## Typography

**UI Font:** Inter (with sans-serif fallback)<br>
**Data Font:** Geist Mono (with Consolas and monospace fallbacks)

- Inter keeps the dense monitoring workspace readable and direct.
- Geist Mono is for values, timestamps, counts, identifiers, and other execution metadata.
- The two fonts keep evidence distinct from explanatory interface copy.

### Hierarchy

- **Title** (650, 26px, line-height 1.1): route and page titles.
- **Section** (650, 16px, line-height 1.35): panel headings and major section labels.
- **Body** (400, 14px, line-height 1.5): explanations and ordinary UI text.
- **Control** (500, 13px, line-height 1.4): buttons, filters, navigation, and compact labels.
- **Metadata** (400, 12px, line-height 1.4, Inter): quiet labels and supporting status details.
- **Caption** (500, 11px, line-height 1.4, Inter, `--text-caption`): the smallest step, for uppercase eyebrows, evidence chips, chart axis ticks, and tiny counts. Never running text.
- **Data** (400, 12px, line-height 1.4, Geist Mono): timestamps, counts, IDs, and execution values.

**The Two Voice Rule.** Use Inter for interface language and Geist Mono for data. Landing typography is a separate surface decision.

## Layout

### Shell

- The global header is 60px high.
- The desktop route rail is 220px wide.
- The evidence workspace is flexible and stays bounded by the shell.
- Panels use a 4px, 8px, 16px, 24px, and 32px spacing rhythm.
- The shell has no persistent footer row.
- A session page ends with its final evidence panel. It does not repeat observer, update, source, license, or version metadata.
- That supporting information belongs in Settings or About.

### Header

- The header never carries breadcrumbs.
- The header holds the compact pomegranate product mark, the search trigger, the monitor state, notifications, and the local profile control.
- The search trigger is 280px wide on desktop and 200px wide on tablet. On phone it is icon-only.
- The search trigger opens the Ctrl K palette.

### Page header

Every page uses `CommandPageHeader`.

- It holds an optional breadcrumb trail, the title, an optional meta line, bottom-aligned actions, and an optional tab bar.
- The breadcrumb trail is 12px muted sentence case with brand-text links.
- `CommandBreadcrumbSeparator` draws the 12px chevron separators.
- The current page carries `aria-current`.

### Widths

| Width | Layout |
| --- | --- |
| Desktop | 220px rail with labelled route links and live status context |
| Compact | The rail becomes an icon rail. Controls may use the 32px compact height. |
| Phone (760px and narrower) | Navigation becomes an off-canvas labelled drawer. Touch targets are at least 44px. |

Compact and phone modes keep the accessible names and the current-route state.

## Elevation & Depth

- Operational surfaces are flat at rest.
- Depth comes from charcoal or light tonal steps, one-pixel rules, and ownership boundaries.
- The only routine shadow is the tokenized overlay shadow for menus and trays.
- Landing shadows stay on the landing page.

### Shadow Vocabulary

- **Overlay:** `0 12px 32px #20252b20` in light mode and the theme override in dark mode, for profile and notification overlays.

**The Flat Evidence Rule.** Panels, tables, metrics, and settings panes use tone and rules, not decorative floating shadows.

- Give each meaningful transition one boundary.
- Use proximity and spacing inside a group.
- Do not put two full-width dividers next to each other.
- Soften supporting rules so that section boundaries keep the hierarchy.
- Content beside a divided evidence or settings row keeps at least 12px of block inset through the shared divider-gap token.

## Shapes

- Controls use a 4px radius.
- Evidence panels use a 6px radius.
- Borders are one pixel and rectangular.
- Do not use pills, ornamental clipping, or irregular silhouettes in the application.

Touch size is separate from shape:

| Control | Height |
| --- | --- |
| Default | 36px |
| Compact | 32px |
| Coarse pointer and phone | At least 44px |

The documented exceptions to the 44px minimum are in [Activities design](docs/internal/design/activities.md).

## Components

### Buttons

Every button in the application has one of six roles. `app/styles/shell.css` implements them as shared classes.

| Role | Class | Size | Look | Use |
| --- | --- | --- | --- | --- |
| Primary | `.commandPrimaryAction` | 36px | Pomegranate fill, white text, 13px/500 | One for each view, for a real commitment only: install, reconnect, confirm |
| Secondary | `.commandSecondaryAction` | 32px | One-pixel panel-line rule, application text at 12px/500, transparent background | Prev/Next, Copy, toolbar actions, and independent toggles such as Group by workflow |
| Segmented | `.commandSegmented` with `> button` | 30px segments | One frame with a panel-line border and 4px radius. Segments are borderless, muted 12px/500, and divided by one-pixel lines | Mutually exclusive views, such as Fresh tokens / Full breakdown and List / Grid |
| Quiet | `.commandQuietAction` | 28px minimum | No border, no fill, muted 12px/500, 6px horizontal padding, optional 14px icon | Optional actions such as Download report, and sort cycling |
| Text link | `.commandTextLink` | Inline | Brand-text color, 12px/400, no border or fill | Section expanders such as "Show 20", "Show more", and "Expand all" |
| Icon | `.commandIconAction` | 32px square | Quiet button with a 16px stroke icon | An action that a glyph names. It must have a `title` or an `aria-label`. |

All six roles share these rules:

- The radius is the 4px control radius.
- The focus ring is 2px `--focus-ring` with a 2px offset. Inside a segmented frame the ring is inset.
- The disabled treatment is opacity .48.
- Borders use the panel line token. The stronger control line shows only on hover and on form fields such as selects.
- Hover and focus move between neutral tones without lift.
- Every interactive control shows the visible focus ring.
- Controls keep reduced-motion behavior.

States:

| Role | State | Look |
| --- | --- | --- |
| Secondary | Hover, pressed, selected | Raised panel tone with the stronger line |
| Segmented | `aria-pressed="true"` | Raised tone and application text |
| Quiet | Hover | 6% ink background tint, text lifts to application ink |
| Quiet | Pressed | 10% ink background tint |
| Text link | Hover | Underline with a 3px offset |
| Icon | Hover | Same as Quiet |

Rules for the Text link and the panel heading link:

- A Text link is never a standalone action.
- Use at most one Text link as an in-content pointer in each panel.
- Never put a Text link on the right of a panel header.
- A panel heading that opens the tab that continues its evidence uses `.panelHeadingLink`, a composition of the Quiet role.
- `.panelHeadingLink` has heading type and ink color, a 14px muted chevron after the title, and no hover fill.
- The chevron lifts to ink on hover. The tap box is 44px on phone.
- `.panelHeadingLink` is not a seventh role.
- Panel-to-tab navigation uses the panel heading link.
- The second destination of a row uses the Quiet role.

On phone widths and coarse pointers the roles keep their look and change only their size:

| Role | Phone and coarse pointer |
| --- | --- |
| All | Every target reaches 44px |
| Primary, Segmented | Stretch to the full row width. Segments flex evenly. |
| Secondary | A pair splits the row |
| Quiet | Becomes a full-width row |
| Icon | 44px square |
| Text link | Keeps a 44px tap box |

A local layout may reset a full-width role to `auto` where a header keeps two controls on one line.

#### Controls outside the six roles

These controls keep their own contracts on purpose. They are not counted among the six roles.

| Control | Class | Contract |
| --- | --- | --- |
| Header icon and profile buttons | `.commandIconButton`, `.commandProfileButton` | 36px, borderless until hover |
| Toolbar filter chips | `.commandFilterChip` | 36px, `aria-pressed` toggles |
| Settings tab list | `.commandSettingsNav`, `role="tab"` | Rendered with its pane at `/design-system` |
| Theme toggle | | Its own contract |
| Copy-transcript button | | Its copied and error states carry meaning |
| Desktop session-header ID chip | `button.sessionIdChip` | Keeps the chip look and copies the full session ID on click. It shows the stronger line on hover. It turns positive after a copy and negative after a failure. |

Compositions that are not a seventh role:

- The global palette trigger and the palette result rows compose `.commandQuietAction` with their shell classes. They keep the Quiet interaction contract.
- Table pagination (Previous, page numbers with `aria-current="page"`, Next) uses Secondary actions.
- The agent tree camera controls (Fit, Zoom in, Zoom out) use Secondary actions.
- The panel-header Refresh and the notification tray's Mark all read use Quiet actions.

### Chips

- `.commandChip` is the one chip. It is a transparent outline label, so it never reads as a button.
- The chip is at least 20px high with 2px 7px padding, a one-pixel panel line, and the control radius.
- The chip text is the Caption step: 500, 11px, line-height 1.3, Inter, with no uppercase transform.
- An optional status dot is 6px.
- A tone recolors only the text. A tone never adds a fill.

| Tone | Class | Text color |
| --- | --- | --- |
| Neutral | none | Muted or ink |
| Info | `.info` | Blue |
| Positive | `.positive` | Green |
| Warning | `.warning` | Amber |
| Negative | `.negative` | Semantic error |

- `.agentChip` shares the same contract.
- `ProviderBadge` renders a provider name in a `.commandChip`. See [Agents design](docs/internal/design/agents.md).

### Fields

- Search and filters use neutral backgrounds, one-pixel control rules, 4px corners, Inter control text, and an accessible focus ring.
- Inputs grow to 44px on coarse pointers and phone.

Every single-select dropdown uses `CommandSelect`. Do not add a native `<select>`.

- `CommandSelect` is in `app/components/command-center/CommandSelect.tsx`, re-exported from `CommandPage.tsx`.
- It is a select-only combobox.

| Part | Rule |
| --- | --- |
| Trigger | A muted chevron inset 14px from the edge, reserved end padding, and the shared hover, focus, and disabled states |
| Trigger, open | The stronger line also marks it open |
| Listbox | A fixed `--command-panel` overlay with a one-pixel strong line, the control radius, and the overlay shadow |
| Listbox size | At most 320px tall. It flips above the trigger when the space below is short. |
| Listbox parent | Portaled to the body, or into the enclosing modal `<dialog>` |
| Option | 32px row, 44px on coarse pointers |
| Active option | Raised tone |
| Selected option | Brand text at 600 |

- Focus stays on the trigger with `aria-activedescendant`.
- Arrows, Home/End, Page Up/Down, typeahead, Enter/Space, Escape, and Tab follow the native select.
- An option may name a `group`. Consecutive options that share a group sit under a muted `--text-xs` heading that is not selectable.
- For a grouped option, the closed control reads “group · label”, and the option appends the group to its accessible name.
- An option may carry a decorative glyph with a visually hidden `iconLabel`.

### Inline Explanations

- Explanatory inline text may use a quiet dotted underline to disclose a tooltip or popover.
- The underline follows the text color.
- The underline is for text only. Icons, buttons, and chips keep their own interaction affordances.
- Popover text states only what a technical reader cannot discover from the controls.
- Popover text is one or two short sentences, with no walkthrough of clicks or privacy boundaries.

### Panels and tables

- Evidence panels use the theme panel token, a one-pixel line, a 6px radius, and 16px base padding.
- Rows and tables use rules and neutral hover tones.
- Missing data stays unavailable or an em dash. Never replace it with a plausible value.

`CommandTable` adds opt-in states. `/design-system` renders all four.

| State | Rule |
| --- | --- |
| Sortable header | An unsorted two-arrow glyph, then descending and ascending with ink text and `aria-sort` |
| Pagination footer | Secondary actions. On phone they stack with a page status. |
| Row groups | Caller-ordered, with a full-width header cell and an optional footer row |
| Empty state | Supplied by the caller |

### Navigation

Rail:

- Tasks is a root item of the primary rail, directly after Sessions.
- The Tasks item uses the `grid` glyph and is current on `/tasks` and below it.
- Tasks is also a palette destination with the detail “Repository task boards”.
- The desktop rail has labelled route links and live status context.

Palette:

- The palette leads with the module in view.
- On Sessions the recent sessions come first. On Repositories the repositories come first.
- [Task board design](docs/internal/design/task-board.md) owns the palette while a task board is in view.

Brand:

- Desktop and phone share a compact raster-derived pomegranate brush mark, with the Pomegr wordmark beside it.
- On phone the mark sits immediately after the menu control.
- The mark uses the generated artwork as a mask, so its visible color stays the theme-aware application brand token.
- The painted divided pomegranate is also the favicon, the landing header and footer mark, the Windows application icon, the tray icon, and the notification icon.
- `npm run build:brand` exports transparent Pomegr-red assets from the application luminance mask in `public/pomegr-mark-painted.png`.
- The application build runs this export automatically.
- Provider names stay in adapter-specific content, never in product identity.

Usage limits widget in the rail:

- It shows only providers with sessions created in the last seven days.
- For each provider it shows the tightest available account window: the highest percentage, whatever the active or reached state of the provider.
- It uses the shared colors: normal (0–74), warning (75–84), and critical (85–100).
- It links to Usage limits.
- It is shell chrome and never session state.

## Do's and Don'ts

### Do:

- **Do** use the committed tokens in `app/styles/tokens.css` as the source of truth.
- **Do** use the type steps in [Typography](#typography) and the control heights in [Shapes](#shapes).
- **Do** keep the 60px header and the 220px desktop rail.
- **Do** keep the identity provider-neutral, and keep the normalized privacy boundaries and the metric meanings.
- **Do** keep landing typography, paper artifacts, and brand decisions on the landing and marketing pages.

### Don't:

- **Don't** reintroduce Rokkitt, square application geometry, nearly-black legacy token names, or landing typography as app-shell guidance.
- **Don't** use semantic colors for decoration. Keep semantic error for actual errors and keep idle states neutral.
- **Don't** expose prompts, responses, commands, credentials, raw transcript content, or unsupported provider detail.
- **Don't** turn context history into throughput, spend, or cumulative usage. Don't aggregate request snapshots.
- **Don't** replace unavailable evidence with fake activity, counts, controls, or success states.
