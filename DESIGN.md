---
name: Pomegr
description: A local-first Command Center for observing coding-agent sessions.
colors:
  pomegranate-red: "#a63c32"
  drafting-paper: "#f0ece2"
  monitor-black: "#111112"
  monitor-panel: "#18181a"
  ink: "#171715"
  acid-green: "#b6d95f"
  context-lavender: "#bbb3d3"
  git-amber: "#d1a343"
  monitor-line: "#3a3838"
  landing-faint: "#8f8983"
  command-ground-dark: "#0b0b0e"
  command-sidebar-dark: "#0f0f12"
  command-header-dark: "#0d0d10"
  command-panel-dark: "#121216"
  command-panel-2-dark: "#17171c"
  command-panel-3-dark: "#1d1c22"
  command-line-dark: "#2d292f"
  command-line-strong-dark: "#464047"
  command-ink-dark: "#f2edef"
  command-muted-dark: "#a49ca1"
  command-faint-dark: "#8b8389"
  command-brand-dark: "#a63c32"
  command-brand-text-dark: "#e58b80"
  command-green-dark: "#b6d95f"
  command-amber-dark: "#d1a343"
  command-lavender-dark: "#bbb3d3"
  command-ground-light: "#f2f0eb"
  command-sidebar-light: "#e9e6df"
  command-header-light: "#f7f5f0"
  command-panel-light: "#fbfaf7"
  command-panel-2-light: "#f1eee8"
  command-panel-3-light: "#e7e3dc"
  command-line-light: "#d4cfc6"
  command-line-strong-light: "#aaa39a"
  command-ink-light: "#24211f"
  command-muted-light: "#68615d"
  command-faint-light: "#6f6863"
  command-brand-light: "#994238"
  command-brand-text-light: "#994238"
  command-green-light: "#547a64"
  command-amber-light: "#9b662d"
  command-lavender-light: "#6d6591"
typography:
  display:
    fontFamily: "Rokkitt, Rockwell, Georgia, serif"
    fontSize: "clamp(27px, 3vw, 34px)"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Rokkitt, Rockwell, Georgia, serif"
    fontSize: "clamp(36px, 5vw, 64px)"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.55
  label:
    fontFamily: "Geist Mono, Consolas, monospace"
    fontSize: "9px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "0.06em"
rounded:
  square: "0px"
  signal: "1px"
  control: "6px"
  rail: "7px"
  search: "8px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "18px"
  lg: "28px"
  xl: "42px"
components:
  command-primary-action:
    backgroundColor: "{colors.command-brand-dark}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "36px"
  command-secondary-action:
    backgroundColor: "transparent"
    textColor: "{colors.command-ink-dark}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "36px"
  command-search:
    backgroundColor: "{colors.command-ground-dark}"
    textColor: "{colors.command-muted-dark}"
    rounded: "{rounded.search}"
    padding: "0 10px"
    height: "38px"
  command-nav-active:
    backgroundColor: "{colors.command-panel-3-dark}"
    textColor: "{colors.command-ink-dark}"
    rounded: "{rounded.rail}"
    padding: "0 10px"
    height: "40px"
  command-signal-panel:
    backgroundColor: "{colors.command-panel-dark}"
    textColor: "{colors.command-ink-dark}"
    rounded: "{rounded.signal}"
    padding: "14px"
---

# Design System: Pomegr

## Overview

**Creative North Star: "The Measured Command Center"**

Pomegr is a local-first operations instrument for making coding-agent activity legible without exposing the work itself. The application shell is a dark, precise evidence wall: warm near-black surfaces, one-pixel rules, compact labels, and semantic color marks give the operator a stable scan order. Light mode keeps the same measured geometry on paper-like neutrals rather than becoming a separate visual language.

The landing/marketing surface remains the expressive companion to this instrument: drafting paper, clipped edges, tape, handwriting, and the full Pomegr mark are valid there when used sparingly. The application shell is intentionally quieter and more operational. Its identity is the POMEGR wordmark only; it does not place a pomegranate icon beside the wordmark. The full logo asset is a landing/marketing exception and may remain where that surface uses it.

**Key Characteristics:**

- Near-black or warm-paper operational surfaces with flat one-pixel evidence boundaries.
- Rokkitt propositions, Inter explanation, and Geist Mono execution metadata.
- Pomegranate brand ink plus semantic green, amber, and lavender signals.
- A 220px desktop rail that becomes a 54px icon rail at compact widths and an off-canvas drawer on mobile.
- Honest unavailable and coming-soon states that never imply unsupported evidence.
- Read-only, provider-neutral language with local monitor status always visible.

## Colors

The Command Center uses two tonal themes with one shared semantic vocabulary. The frontmatter is normative; the values below describe where each real implementation token belongs.

### Primary

- **Pomegranate brand ink** (`command-brand-dark` `#a63c32`; `command-brand-light` `#994238`): primary actions, the active navigation glyph, and selected emphasis. The accessible command text accent is `command-brand-text-dark` (`#e58b80`) in dark mode and `command-brand-text-light` (`#994238`) in light mode; use it for compact text actions and cache-evidence links where brand color needs to remain legible against the shell.

### Secondary

- **Signal green** (`command-green-dark` `#b6d95f`; `command-green-light` `#547a64`): monitor connectivity, active/ready state, and read-only assurance.
- **Signal amber** (`command-amber-dark` `#d1a343`; `command-amber-light` `#9b662d`): needs-input attention, warnings, and provider-unavailable cautions.
- **Context lavender** (`command-lavender-dark` `#bbb3d3`; `command-lavender-light` `#6d6591`): context snapshots and context metrics only.

### Neutral

- **Dark ground / sidebar / header:** `#0b0b0e`, `#0f0f12`, and `#0d0d10` establish the dark operating field.
- **Dark panels:** `#121216`, `#17171c`, and `#1d1c22` create nested tonal steps for evidence, hover, and selected states.
- **Dark rules and text:** `#2d292f` and `#464047` are quiet and strong dividers; `#f2edef`, `#a49ca1`, and `#8b8389` are ink, muted copy, and faint metadata.
- **Light ground / sidebar / header:** `#f2f0eb`, `#e9e6df`, and `#f7f5f0` preserve the same shell hierarchy on a warm neutral field.
- **Light panels:** `#fbfaf7`, `#f1eee8`, and `#e7e3dc` are the panel, hover, and selected tonal steps.
- **Light rules and text:** `#d4cfc6` and `#aaa39a` are dividers; `#24211f`, `#68615d`, and `#6f6863` are ink, muted copy, and faint metadata.

The landing surface adds a quieter `landing-faint` (`#8f8983`) for low-emphasis paper/monitor annotations. Landing paper, monitor, red, green, lavender, and amber remain scoped to that expressive surface rather than becoming application-shell primitives.

**The Semantic Color Rule.** Green, amber, and lavender carry operational meaning; never spend them as decoration.

**The Theme-Pair Rule.** Dark and light tokens preserve the same role and contrast hierarchy; switching theme must not change the meaning of a signal.

**The Red Rarity Rule.** Pomegranate ink is identity and action emphasis, not a general surface fill.

## Typography

**Display Font:** Rokkitt (with Rockwell and Georgia fallbacks)<br>
**Body Font:** Inter (with Arial and sans-serif fallbacks)<br>
**Label/Mono Font:** Geist Mono (with Consolas and monospace fallbacks)

Rokkitt gives route headings and major propositions a compressed slab authority. Inter carries descriptions and readable controls. Geist Mono is reserved for execution metadata, timestamps, counts, status labels, and the persistent footer so evidence reads as measured rather than promotional.

### Hierarchy

- **Display** (650, `clamp(27px, 3vw, 34px)`, line-height .98): Command Center route titles and compact operating propositions.
- **Headline** (650, `clamp(36px, 5vw, 64px)`, line-height .98): large About or landing statements; use sparingly inside the application.
- **Body** (500, 13px, line-height 1.55): explanations and supporting copy, usually below 66ch.
- **Label** (650, 8–10px, tracked): navigation, filters, status, controls, and metadata; Geist Mono is the default when values or state need instrument-like precision.

**The Instrument-Type Rule.** Use Rokkitt for propositions, Inter for explanation, and Geist Mono for evidence; never swap their roles to create novelty.

Home uses the same families with a slightly more personal scale: the route title is Rokkitt at `clamp(32px, 3vw, 38px)`, the Session coach subordinate proposition is Rokkitt at `clamp(28px, 3.2vw, 38px)`, headings are `14–18px`, and body/detail copy is `11–13px`. These are hierarchy adjustments within the Command Center system, not new typography tokens.

## Layout

The Command Center is a three-row shell: a 58px global header, a flexible evidence workspace, and a 38px read-only footer. Desktop uses a 220px left rail and a main view capped at 1480px; individual session views cap at 1400px. The header holds the wordmark, a 38px search field, local-monitor status, notifications, and the local-profile control. Main route pages use a 14px working offset, compact 8/12/18/28/42px spacing, and one-pixel boundaries instead of floating card stacks.

At widths up to 1080px the rail compacts to 54px, the header becomes 56px, and navigation labels, counts, and sidebar footnotes collapse to icons. At 760px the rail leaves the layout and becomes an off-canvas drawer opened from the header; the main workspace and footer use the full viewport width. The drawer restores labels and counts, sits above a dismissible backdrop, closes on Escape or route selection, and returns focus to its trigger. At the same breakpoint toolbars wrap, metric grids become one column, settings navigation becomes a horizontal tab strip, and repository/session rows hide low-priority columns. At 520px coming-soon content stacks and tables remove additional secondary columns. Notification trays become fixed to the viewport edge. Compact task/text actions may use a 24px minimum on precision-pointer surfaces; coarse-pointer and mobile controls expand to at least 44px.

Landing composition remains responsive editorial recomposition: the paper field, operations wall, torn headline ticket, source card, output stack, and legend reorder rather than uniformly shrink. Landing-only navigation and paper artifacts must not be promoted into the operational shell.

Home is the personal starting point within this shell. Its desktop composition starts with a bounded Welcome to Pomegr header, then a wide Sessions panel grouping last-viewed navigation and subordinate Pinned destinations beside a narrower Understand your sessions guide. Concrete context-history and report instructions replace generic discovery copy. Session coach, Saved views, and Session comparison share one Coming soon background; What’s new is a prominent dismissible panel directly below the welcome header. Dismissal is remembered in browser-local preferences for the current update only. Monitoring activity, counters, usage, and polling remain on their dedicated routes. At mobile widths these sections become one column in reading order; picker fields and other Home controls use 44px minimum touch targets.

## Elevation & Depth

Operational surfaces are flat at rest. Depth comes from tonal steps, one-pixel rules, and clear ownership boundaries; evidence panels do not use decorative shadows. The profile menu and notification tray are the intentional overlay exceptions: they sit above the shell with a border and a restrained theme-specific shadow. The landing surface may retain its structural monitor and paper-ticket shadows because those are part of its separate marketing expression.

### Shadow Vocabulary

- **Command overlay dark:** `0 22px 58px rgba(0, 0, 0, .52)` for profile and notification overlays.
- **Command overlay light:** `0 18px 46px rgba(38, 31, 28, .16)` for the same overlays in light mode.
- **Landing monitor ambient:** `0 24px 70px rgba(28, 23, 20, .18)` remains a landing-only structural separation.
- **Landing paper lift:** `0 28px 70px rgba(0, 0, 0, .28)` remains reserved for the overlapping hero ticket.

**The Flat-Evidence Rule.** Panels, tables, metrics, and settings panes use tone and a one-pixel rule; shadows belong to overlays or the landing composition.

## Shapes

The Command Center is square and technical: evidence boundaries are one pixel with a 0–1px radius, while actionable controls use restrained 6–8px corners for recognition and hit-area grouping. Status counters and semantic dots may be compactly rounded because their silhouette communicates state; a rounded switch is an interaction affordance, not a general-purpose pill treatment. Search, profile, and navigation controls stay rectangular and quiet.

Landing irregularity is deliberately scoped to paper: clipped/torn silhouettes, tape, stamps, and handwritten labels can appear on the marketing surface, but never on application evidence panels or data tables.

## Components

### Buttons

- **Primary:** 36px minimum height, 6px corner, pomegranate brand background, white text, and Geist Mono scale. Disabled actions are visibly muted and honest about unavailable capabilities.
- **Secondary:** transparent or tonal panel background with a one-pixel strong rule and application ink; hover moves to the next panel tone without a lift.
- **Hover / Focus:** state changes are restrained; every interactive shell control receives a 2px green `:focus-visible` outline with a 2px offset. Compact task triggers and text actions are at least 24px high for precision pointers and 44px for coarse/mobile pointers. Do not rely on color alone.

### Inputs / Fields

- **Global and route search:** 38px high, dark/light ground fill, one-pixel rule, 8px corner, search glyph, and an optional platform-appropriate Geist Mono `Ctrl K` or `⌘ K` hint. Focus strengthens the rule and keeps the caret green.
- **Filters:** compact rectangular controls with `aria-pressed` state; counts use mono numerals and remain readable when filters wrap on mobile.

### Cards / Containers

- **Evidence panel:** flat `command-panel` tone, one-pixel `command-line` boundary, 0–1px corner, compact internal padding, and no decorative shadow.
- **Metric panel:** three equal columns on desktop, 142px minimum height, with lavender reserved for context values and muted labels for provenance.
- **Table/list:** rows are separated by one-pixel rules; hover changes tonal background only. Missing evidence is shown as an em dash or explicit unavailable copy, never fabricated.

### Navigation

The primary rail is 220px on desktop with 40px navigation rows, 7px corners, a quiet icon-label-count grid, and a selected panel tone. The active icon uses brand ink while status meaning remains semantic. At compact widths the rail is 54px and keeps only centered icons with accessible labels and current-page state. On mobile it becomes a labelled off-canvas drawer so no permanent rail consumes the evidence viewport. The footer persists connected/offline and read-only normalized-metadata language.

Home navigation is personal and destination-focused: pinned sessions, projects, and views plus a last-viewed session are the primary content. The inline picker is searchable and bounded to six browser-local pins. Missing catalog destinations remain visibly unavailable, and monitor reconnection copy must not erase saved identity or turn Home into a live metrics dashboard.

### Home Starting Point

Home may introduce the existing report feature, What’s new copy, and honest Coming soon previews while preserving flat shell geometry and semantic color roles. Session coach is the prominent preview; Saved views and Session comparison stay quieter. Keep planned guidance clearly separate from recorded evidence, avoid fake counters or activity summaries, and require explicit future opt-in before any model transmission.

### Overlays

- **Notification tray:** a border-bounded, square-edged panel up to 390px wide, with grouped local events, unread counts, explicit empty state, close control, and an honest connection explanation. It receives the overlay shadow and returns focus to its trigger.
- **Local profile menu:** a 250px panel with an explanatory “Coming soon” state, settings/about links, and the theme control. It is a preview of local identity, not an account claim.

### Settings Controls

The settings view uses a flat bordered layout with a 210px sub-navigation rail on wide screens and horizontal tabs on mobile. Rows pair a concise label and effect description with a native switch or bounded state label. Enabled state uses semantic green; disabled, desktop-managed, and coming-soon states are named plainly. Keyboard tabs support arrow/Home/End movement, and each panel is labelled by its tab.

### Empty / Unavailable States

`CommandEmpty` explains what is missing and what Pomegr will do next. `CommandComingSoon` names planned functionality without simulating it. Monitor disconnects preserve the last known-good state and say that the monitor is reconnecting; account-level usage remains provider-reported and is never attributed to a session, agent, or repository.

### Brand Identity

The application shell uses the inline POMEGR wordmark from `PomegrBrand` only—no pomegranate icon is paired with it. The full `pomegr-logo.png` mark is a landing/marketing exception and remains valid in the landing header/footer and its favicon treatment when that surface uses it. Do not substitute the full mark into the Command Center header.

## Do's and Don'ts

### Do:

- **Do** keep the Command Center shell wordmark-only; reserve the full pomegranate logo asset for landing/marketing expression.
- **Do** preserve the 220px desktop rail, 54px compact rail, mobile off-canvas drawer, 58px desktop header, 56px compact header, and 38px footer rhythm.
- **Do** use semantic green, amber, and lavender only where their operational roles are truthful.
- **Do** keep evidence surfaces flat with one-pixel boundaries and put depth only on profile/notification overlays or landing artifacts.
- **Do** label provider-reported estimates, agent-reported signals, deterministic heuristics, unavailable data, and coming-soon work honestly.
- **Do** maintain visible focus, keyboard tab behavior, reduced motion, accessible names, 24px precision-pointer minimums, and 44px coarse/mobile targets.
- **Do** preserve the landing surface’s drafting-paper, torn, taped, and stamped details when working on landing/marketing components.

### Don't:

- **Don't** add the pomegranate icon to the Command Center header or treat the full logo as required application-shell identity.
- **Don't** turn operational panels into glossy gradients, glass cards, soft pill controls, or floating shadow stacks.
- **Don't** use torn edges, tape, handwriting, or stamps on application evidence panels; those are landing-only irregularities.
- **Don't** use signal colors as decoration or imply that a heuristic, estimate, or illustrative value is authoritative.
- **Don't** expose prompts, responses, commands, credentials, raw transcript content, or unsupported repository/agent detail.
- **Don't** replace a missing or unavailable value with a plausible-looking number or a generic success state.
