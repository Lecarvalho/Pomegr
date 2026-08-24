---
name: Pomegr
description: A local-first operations wall for coding-agent sessions.
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
typography:
  display:
    fontFamily: "Rokkitt Pomegr, Rockwell, Georgia, serif"
    fontSize: "clamp(48px, 4.3vw, 74px)"
    fontWeight: 690
    lineHeight: 0.86
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Inter, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.55
  label:
    fontFamily: "Geist Mono, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "0.06em"
rounded:
  square: "0px"
  signal: "1px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "18px"
  lg: "28px"
  xl: "42px"
components:
  button-primary:
    backgroundColor: "{colors.pomegranate-red}"
    textColor: "{colors.drafting-paper}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0 18px"
    height: "48px"
  signal-panel:
    backgroundColor: "{colors.monitor-panel}"
    textColor: "{colors.drafting-paper}"
    rounded: "{rounded.signal}"
    padding: "12px 13px"
---

# Design System: Pomegr

## Overview

**Creative North Star: "The Drafting-Paper Operations Wall"**

Pomegr should feel like a precise field instrument assembled on warm drafting paper: a dense near-black observer surface, restrained annotation, and a torn paper message pinned across the machinery. The world is tactile without becoming nostalgic, and technical without resembling a generic developer dashboard.

Depth is flat and tonal by default. Texture, clipped paper edges, ink rules, and a few structural shadows communicate material; they never compete with the session evidence. The official Pomegr mark and wordmark are binding identity assets.

**Key Characteristics:**

- Warm paper against a near-black operations wall.
- Dense, legible metadata with color reserved for signal semantics.
- Torn, taped, stamped, and pressed-ink details used sparingly.
- Local-first and read-only boundaries stated plainly.
- Responsive compositions that reorder the story instead of shrinking it.

## Colors

The palette combines archival paper and black drafting ink with one brand red and three tightly scoped signal colors.

### Primary

- **Pomegranate Red:** brand marks, persuasive emphasis, primary actions, and the underlined verb in the hero.

### Secondary

- **Acid Green:** live state, safe status, and read-only assurance.
- **Context Lavender:** context snapshots and their plots only.
- **Git Amber:** Git activity and transitional work states only.

### Neutral

- **Drafting Paper:** the page, tickets, tape-adjacent surfaces, and light text on red.
- **Monitor Black and Monitor Panel:** the operations wall and its nested evidence panels.
- **Ink and Monitor Line:** light-surface type, rules, connectors, and quiet structure.

**The Signal-Color Rule.** Green, lavender, and amber carry meaning; do not use them as decorative accents.

**The Red Rarity Rule.** Pomegranate red is persuasive ink, not a general surface fill.

## Typography

**Display Font:** Rokkitt Pomegr (with Rockwell and Georgia fallbacks)<br>
**Body Font:** Inter (with Arial and sans-serif fallbacks)<br>
**Label/Mono Font:** Geist Mono (with Consolas and monospace fallbacks)

**Character:** Rokkitt gives the large statements compressed, typewriter-slab authority. Inter keeps explanatory copy quiet, while Geist Mono makes all execution metadata feel measured and exact.

### Hierarchy

- **Display** (weight 690, responsive 48–74px, line-height .86): torn-paper hero and major editorial statements.
- **Headline** (weight 680–700, responsive 28–96px, line-height .82–.94): section propositions.
- **Body** (weight 500, 13px, line-height 1.55): explanatory copy, generally held below 65ch.
- **Label** (weight 650, 8–12px, tracked and often uppercase): metadata, controls, status, and navigation.

**The Instrument-Type Rule.** Use display type for promises and mono type for evidence; never swap their roles.

## Layout

The landing page uses a full-width paper field and an inset operations wall capped around 1600px. Desktop places a session rail at the left, a source card and branching connectors in the center, a vertical output stack, and a handwritten legend at the right. The torn headline card overlaps the lower-left wall boundary so the persuasive message and product proof share one composition.

At 1220px the legend yields first. At 980px the session rail becomes a horizontal strip. At 720px the wall is recomposed as: session context, source card, overlapping headline ticket, stacked outputs, then a horizontally scrollable legend. The primary waitlist action remains visible in the first 390×844 viewport. Mobile touch targets are at least 44px, and nonessential desktop navigation labels collapse.

Spacing follows an 8/12/18/28/42px working rhythm, with deliberate one-off offsets only where paper overlaps the monitor.

## Elevation & Depth

The system is flat and tonal by default. Paper texture, ink rules, torn silhouettes, and contrast between the paper field and monitor establish depth. Structural shadows are reserved for the entire monitor, the torn headline ticket, and tape-like legend labels; dashboard evidence panels remain flat.

### Shadow Vocabulary

- **Monitor ambient:** `0 24px 70px rgba(28, 23, 20, .18)` separates the wall from paper.
- **Paper lift:** `0 28px 70px rgba(0, 0, 0, .28)` supports the overlapping hero ticket.
- **Pressed action:** a small offset ink shadow plus an inset highlight gives the CTA a printed, handled edge.

**The Flat-Evidence Rule.** Evidence panels use border and tone, not card shadows.

## Shapes

The base geometry is square and technical: one-pixel rules, near-zero radii, rectangular evidence panels, and diagrammatic connectors. Organic form is limited to paper boundaries made with asymmetric polygon clips. Circles appear only for live dots, task states, and the local-first stamp.

**The Paper-Only Irregularity Rule.** Torn or skewed silhouettes belong to paper and ink artifacts, never to metadata panels.

## Components

### Buttons

- **Primary:** pomegranate ink on a paper-textured, irregular rectangular ticket with visible vertical press variation.
- **Hover / Focus:** a slight upward shift and restrained rotation on hover; a three-pixel acid-green focus ring with four-pixel offset.
- **Repository action:** an underlined text action with the GitHub mark, used whenever the free public source is the alternate path.

### Cards / Containers

- **Signal panels:** near-black flat surfaces, one-pixel semantic border, compact mono headings, and no decorative shadow.
- **Source session:** a larger evidence card with project, branch, wall time, and bounded status.
- **Pitch ticket:** warm paper, torn clip-path edges, one tape strip, slab headline, and the primary action.

### Navigation

The paper header uses the official Pomegr mark and wordmark, understated mono links, and a directional dashboard action. On mobile the product lockup remains intact while secondary links disappear.

### Brand Mark

The canonical product mark is `assets/brand/pomegr-logo.png`, exported as `/pomegr-logo.png` for the app and public landing site. Preserve its transparent exterior, red pomegranate silhouette, five-node session topology, opaque white seeds, and broken sketch highlight. Do not substitute the retired outline SVG marks on product surfaces or recolor the white internal details for dark mode.

### Observer Legend

The legend explains every output and privacy boundary. It is a vertical handwritten rail on wide screens and a horizontally scrollable sequence on mobile.

## Do's and Don'ts

### Do:

- **Do** use the official Pomegr logo assets without redrawing or regenerating them.
- **Do** preserve the source-to-output story and label illustrative data visibly.
- **Do** keep privacy claims exact: local-first, read-only, normalized metadata, and no conversation content.
- **Do** treat responsive layout as editorial recomposition, not uniform scaling.
- **Do** honor reduced-motion preferences and maintain visible keyboard focus.

### Don't:

- **Don't** introduce glossy gradients, glass cards, soft pill controls, or a centered generic SaaS hero.
- **Don't** turn heuristic or illustrative data into an authoritative measurement claim.
- **Don't** expose prompts, responses, commands, credentials, or raw transcript content in product examples.
- **Don't** use torn edges, tape, handwriting, or stamps on every component; their rarity is part of the system.
- **Don't** use signal colors outside their defined semantic roles.
