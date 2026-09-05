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
  compact-action:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 10px"
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
- **Data** (400, 12px, line-height 1.4, Geist Mono): timestamps, counts, IDs, and execution values.

**The Two Voice Rule.** Use Inter for interface language and Geist Mono for data. Landing typography is a separate surface decision.

## Layout

The app shell uses a 60px global header, a 220px desktop route rail, and a flexible evidence workspace. It does not reserve a persistent footer row, and session pages end with their final evidence panel rather than repeating observer, update, source, license, or version metadata. That supporting information belongs in Settings or About. Main content stays bounded by the shell while panels use a 4px/8px/16px/24px/32px rhythm. The header holds the compact pomegranate product mark, destination search, monitor state, notifications, and local profile control. Session routes place the Sessions › project breadcrumb in this header; on phones, the mark retains its accessible Pomegr home name while the visible wordmark gives that space to the breadcrumb. Long project names truncate within the header. The brand mark keeps the same position on routes with and without breadcrumbs. On phones, the breadcrumb and Pomegr wordmark share the same text origin, baseline, typography, and muted color. The Settings About pane presents the painted mark beside the product name and purpose before operational metadata.

At compact widths the rail reduces to an icon rail and controls may use the 32px compact height. At mobile widths navigation becomes an off-canvas labelled drawer and touch targets are at least 44px. Agent activity controls wrap below the section heading at widths of 640px or less so the heading and filters remain readable. Context history appears before request snapshots in session evidence; their existing meanings remain unchanged: context is latest non-zero actual level carried to bucket boundaries, while request snapshots are independent request-local observations and are never carried forward, differenced, bucketed, or summed.

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

- **Primary:** 36px default height, 4px radius, pomegranate fill, white text, and Inter control typography.
- **Secondary / compact:** transparent or raised neutral surface, one-pixel rule, 32px compact height, and application text color.
- **Hover / focus:** move between neutral tones without lift; every interactive control receives the visible focus ring. Preserve reduced-motion behavior.

### Inputs / Fields

Search and filters use neutral backgrounds, one-pixel control rules, 4px corners, Inter control text, and an accessible focus ring. Inputs expand to 44px on coarse/mobile surfaces.

Native single-select dropdowns use `CommandSelect` from `app/components/command-center/CommandPage.tsx`. It preserves native selection and keyboard behavior, with a muted chevron inset 14px from the edge, reserved end padding, shared hover/focus/disabled states, and a native-arrow fallback in forced-colors mode.

### Inline Explanations

Explanatory inline text may use a quiet dotted underline to disclose a tooltip or popover. The underline follows the text color and is reserved for text only; icons, buttons, and chips retain their own established interaction affordances.

### Cards / Containers

Evidence panels use the theme panel token, a one-pixel line, 6px radius, and 16px base padding. Rows and tables use rules and neutral hover tones. Missing data remains unavailable or an em dash; it is never replaced with a plausible value.

### Navigation

The painted divided pomegranate is also the favicon, landing header/footer mark, Windows application icon, tray icon, and notification icon. `npm run build:brand` exports transparent Pomegr-red assets from the application luminance mask in `public/pomegr-mark-painted.png`; the app build runs this export automatically.

The branded header is 60px high. Desktop and mobile share a compact raster-derived pomegranate brush mark. The Pomegr wordmark accompanies it except on phone session routes, where the breadcrumb takes that space. On mobile, the mark sits immediately after the menu control. The mark uses the generated artwork as a mask so its visible color remains the theme-aware application brand token. The desktop rail is 220px with labelled route links and live status context; compact and mobile modes preserve accessible names and current-route state. Provider names stay in adapter-specific content, never in product identity.

### Agent Activity

Agent activity shows normalized roles and evidence with the existing privacy bounds. Controls sit beside the heading when space permits and wrap below it at 640px or less. The activity icon animation remains intact and respects reduced motion.

Session headers show recorded or live lifecycle state in the status card without a duplicate identity badge. The provider row omits the repository name already shown in the breadcrumb, including while session evidence loads. Live and historical views omit the redundant status row; connection failures remain visible. The live status card uses the shared activity labels, including In progress for working sessions. Phone summary disclosures identify the summary source once in their toggle, with agent-reported signals retained below. Session toolbars offer report download without a pause action.

### Session Evidence

Context history precedes request snapshots in the evidence flow. Context history displays bounded actual levels with its existing carry-forward semantics. Request snapshots display independent request-local observations without cross-request arithmetic. Deterministic insights remain traceable to concrete events and are never presented as AI judgments.

## Do's and Don'ts

### Do:

- **Do** use the committed tokens in `app/styles/tokens.css` as the source of truth.
- **Do** use Inter at 26px titles, 16px sections, 14px UI/body, 13px controls, and 12px metadata; use Geist Mono for numeric and execution data.
- **Do** preserve the 60px header, 220px desktop rail, 36px default controls, 32px compact controls, and 44px touch targets.
- **Do** preserve provider-neutral identity, normalized privacy boundaries, and existing metric semantics.
- **Do** keep context history before request snapshots and explain their separate meanings accurately.
- **Do** keep landing typography, paper artifacts, and brand decisions scoped to landing/marketing.

### Don't:

- **Don't** reintroduce Rokkitt, square application geometry, nearly-black legacy token names, or landing typography as app-shell guidance.
- **Don't** use semantic colors for decoration; reserve semantic error for actual errors and keep idle states neutral.
- **Don't** expose prompts, responses, commands, credentials, raw transcript content, or unsupported provider detail.
- **Don't** turn context history into throughput, spend, or cumulative usage; don't aggregate request snapshots.
- **Don't** replace unavailable evidence with fake activity, counts, controls, or success states.
