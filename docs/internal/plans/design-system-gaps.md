# Design system gaps

> Status: active; four samples were promoted by the documentation migration and the patterns below are still missing from the page.
> Created: 2026-09-30.
> Scope: accepted reusable UI patterns whose shipped components have no static sample on `/design-system`, plus two critique findings that were still open. It adds no feature and no new component.
> Continuation owner: Pomegr maintainers.
> Authority: working checklist. [DESIGN.md](../../../DESIGN.md) and the `/design-system` page (`app/design-system/page.tsx`, `app/components/design-system/`) stay the visual authority; the [style guide](../../STYLE_GUIDE.md) governs this plan's lifecycle.
> Next task: pick DSG-2 (agent grid tile states) or DSG-4 (repository setup row states), the two rated medium, promote it as a static sample, and tick it below. If a pattern is not worth a sample, mark it rejected with the reason.
> Completion criteria: every listed pattern is promoted to `/design-system` or explicitly rejected, and every carried-over critique finding is fixed or explicitly rejected.
> Permanent destinations: `DESIGN.md` for the written contract, `/design-system` for the working sample, and `tests/ui/design-system.test.tsx` with `tests/ui/pomegr-design-contract.test.tsx` for their guards.
> Lifetime: temporary; delete this file in the change that completes the last item, after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact). Do not keep an archive copy.

## Background

The design promotion gate of the [documentation migration](documentation-migration.md) replaced every HTML preview and mockup with `/design-system`. Part 14 of that migration compared the retired artifacts with the page and promoted four missing samples: the agent roster (which also draws the tile grid through its List / Grid switch), the agent inspector column, the command table (sortable header, pagination footer, empty states), and the Settings tab rail. The list below is what remained. The page stays static-data-only and web-development-only, so a sample must render a shipped component with synthetic props and read no store, route, or network.

## How to promote a pattern

1. Add a section to `app/components/design-system/` beside the existing samples, using `Section`, `Sample`, and `sampleAgent` from `DesignSystemKit.tsx` and fixed display strings so server and client markup match in every time zone.
2. Keep the change to the real shared classes and tokens. Sample-only layout goes in `app/styles/design-system.css`; a new literal color, radius, or off-ramp font size is not allowed (see DESIGN.md).
3. Change `DESIGN.md`, `tests/ui/pomegr-design-contract.test.tsx`, and the `DesignSystemView` section list together, and add the section to `tests/ui/design-system.test.tsx`.
4. Run the Impeccable hook on the edited styles, then `npm run verify:fast` and `npm run test:ui`.

## Patterns still missing

- [ ] **DSG-1 Inspector sheet frame.** `InspectorSheet` (`app/components/dashboard/agent-roster/InspectorSheet.tsx`, styles in `agent-inspector.css`) is the phone form of the inspector and is shared with the focused tree. It is a portaled, fixed, modal dialog opened by tapping a roster row at 760px and narrower, so it cannot sit inline in the page. A sample needs a static frame (a bounded container that applies the sheet's header, back action, and 44px body without the portal, focus trap, or body lock) or an explicit rejection that keeps the roster note as the only description. Rating: medium.
- [ ] **DSG-2 Agent grid tile states.** `AgentGridView.tsx` and `agent-grid.css`. The roster sample reaches the grid only through its List / Grid switch and shows one arrangement. Missing: a matrix of finished, idle, active, and stopped tiles, the amber warning and coral selected borders, the metric bar, the lane header, and the metric chips. Rating: medium.
- [ ] **DSG-3 Agent tree cards, and a keep or remove decision.** `agent-tree/{AgentTreeView,ClusterCard,RoleGlyph,FocusPath}.tsx`, `agent-tree-focus.css`, and the `.agentTree*` rules in `evidence.css`. Missing: focus and attention cards, the dashed cluster card, the group card, the hot connector, and the rail form below 640px. `RoleGlyph` is already shared with the roster. Decision needed first: production mounts only the focused tree (`AgentRoster.tsx` always passes `focusId`), so the unfocused form (role key, persisted folds and camera) renders only in `tests/ui/workflow-activity.test.tsx`. Keep it and sample it, or remove the branch and its two `localStorage` keys (`pomegr-agent-tree-folds-*`, `pomegr-agent-tree-camera-*`) with its tests. Rating: medium.
- [ ] **DSG-4 Repository setup row states.** `RepositoryRow.tsx`, `PluginSetupRow.tsx`, and `InventoryCapture.tsx`. The page shows one row. Missing: update available with its primary action, the `.repositorySetupFeedback` tones, the inline `.repositoryCaptureConfirm` strip, the capture statuses (current, unavailable, not captured, capturing, failed), and the provider section head. Rating: medium.
- [ ] **DSG-5 Revision evidence.** `RevisionEvidence.tsx` and `RepositoryOverviewTab.tsx`. Missing: the hairline fact grid (`.repositoryOverviewFacts`), the summary cards (`.repositoryOverviewCards`, `.repositoryInventorySummary`), the category grid (`.repositoryCategoryGrid`), and `ContextAllocationBreakdown` (loaded initially, deferred, reserved). The allocation breakdown has one caller, so reject it if the fact grid and cards are promoted without it. Rating: low to medium.
- [ ] **DSG-6 Linked repository index row.** `.commandRepositoryRow` and `.commandRepositoryHead` in `RepositoryInventoryView.tsx`, with the setup-chip tones and the chevron. One caller. Rating: low; reject unless a second list adopts it.
- [ ] **DSG-7 Command table static sort states.** The `/design-system` command table sorts when clicked, but the page cannot show the unsorted, descending, and ascending headers side by side, or a focused header, without interaction. A static view needs an `initialSort` prop on `CommandTable`, a small API addition, so weigh it against a note that already describes the three states. No production caller enables sorting or built-in pagination today; these states exist in `tests/ui/command-table.test.tsx`. Rating: low.

## Carried-over critique findings

Two Impeccable critiques (2026-08-15 and 2026-09-01) of the old session page were triaged against the current tabbed session page and then deleted. Of their nine findings, eight are resolved or superseded; the ninth (dense chart interaction on keyboard and phone) remains in part, as these two items.

- [ ] **DSG-8a Duplicate close names in the phone navigation.** The first critique found two controls sharing one accessible name. Today the header menu button (`CommandCenterShell.tsx`, label "Close primary menu" while the drawer is open) and the drawer scrim button (same file, same label, focusable) still share one. Give the scrim no tab stop and no accessible name, or give the two distinct roles. Verify with the phone drawer open.
- [ ] **DSG-8b Per-request tab stops in Request charts.** The first critique asked for one keyboard-inspectable chart surface instead of one focus stop per bucket. The old context chart is gone, but every request bar in `RequestBarsChart.tsx` is still `tabIndex={0}` (up to 60 stops on desktop and 20 on phone) even though arrow-key stepping exists. Decide whether a roving tab stop would keep selection and the minimap predictable, and confirm phone bar sizes against the 44px rule in DESIGN.md. Not re-measured in a browser.

## Owned elsewhere

- Desktop Activities feed (`ActivityFeedPanel`, `ActivityKindRail`, `LargestRequestsList`) has only phone exceptions on `/design-system`. [Session Activity panel redesign](session-activity-panel.md) already decides whether the breakdown row and the highlighted feed row become shared samples; do not track them twice.
- The Home guide in `app/HomeDashboard.tsx` still tells readers to open a session's Context history, a panel the session-page redesign removed. It is recorded as a follow-up of task T12 in [the information architecture redesign](ia-redesign.md#t12-closure).
