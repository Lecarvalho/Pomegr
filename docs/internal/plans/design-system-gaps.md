# Design system gaps

> Status: active; DSG-1, DSG-2, DSG-4, DSG-5, DSG-8a, and DSG-9 are complete. DSG-3, DSG-6, DSG-7, and DSG-8b remain open.
> Created: 2026-09-30.
> Scope: accepted reusable UI patterns whose shipped components have no static sample on `/design-system`, plus two critique findings that were still open. It adds no feature and no new component.
> Continuation owner: Pomegr maintainers.
> Authority: working checklist. [DESIGN.md](../../../DESIGN.md) and the `/design-system` page (`app/design-system/page.tsx`, `app/components/design-system/`) stay the visual authority; the [style guide](../../STYLE_GUIDE.md) governs this plan's lifecycle.
> Next task: decide whether to keep DSG-3 before sampling it. Mark a rejected pattern with its reason.
> Completion criteria: every listed pattern is promoted to `/design-system` or explicitly rejected, and every carried-over critique finding is fixed or explicitly rejected.
> Permanent destinations: `DESIGN.md` for the written contract, `/design-system` for the working sample, and `tests/ui/design-system-*.test.tsx` with `tests/ui/pomegr-design-contract.test.tsx` for their guards.
> Lifetime: temporary; delete this file in the change that completes the last item, after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact). Do not keep an archive copy.

## Background

The design promotion gate of the documentation migration (closed 2026-09-30) replaced every HTML preview and mockup with `/design-system`. Part 14 of that migration compared the retired artifacts with the page and promoted four missing samples: the agent roster (which also draws the tile grid through its List / Grid switch), the agent inspector column, the command table (sortable header, pagination footer, empty states), and the Settings tab rail. The list below is what remained. The page stays static-data-only and web-development-only, so a sample must render a shipped component with synthetic props and read no store, route, or network.

## How to promote a pattern

1. Add a section to `app/components/design-system/` beside the existing samples, using `Section`, `Sample`, and `sampleAgent` from `DesignSystemKit.tsx` and fixed display strings so server and client markup match in every time zone.
2. Keep the change to the real shared classes and tokens. Sample-only layout goes in `app/styles/design-system.css`; a new literal color, radius, or off-ramp font size is not allowed (see DESIGN.md).
3. Change `DESIGN.md`, `tests/ui/pomegr-design-contract.test.tsx`, and the `DesignSystemView` section list together, and test the section in the `tests/ui/design-system-*.test.tsx` file of its area. Mount only that section, as the other files do, and use the helpers of `tests/ui/design-system-helpers.ts`.
4. Run the Impeccable hook on the edited styles, then `npm run verify:fast` and `npm run test:ui`.

## Patterns still missing

- [x] **DSG-1 Inspector sheet frame.** Promoted 2026-10-25 in `DesignSystemAgentSamples.tsx`. The bounded static frame uses the shipped sheet header, Back action, and 44px body action classes. It has no portal, focus trap, or body lock.
- [x] **DSG-2 Agent grid tile states.** Promoted 2026-10-25 in `DesignSystemAgentGridSample.tsx`. The shipped grid shows finished, idle, active, stopped, warning, and selected tiles across all three metrics. Lane headers, metric labels, and relative bars use shared classes with fixed data and time.
- [ ] **DSG-3 Agent tree cards, and a keep or remove decision.** `agent-tree/{AgentTreeView,ClusterCard,RoleGlyph,FocusPath}.tsx`, `agent-tree-focus.css`, and the `.agentTree*` rules in `evidence.css`. Missing: focus and attention cards, the dashed cluster card, the group card, the hot connector, and the rail form below 640px. `RoleGlyph` is already shared with the roster. Decision needed first: production mounts only the focused tree (`AgentRoster.tsx` always passes `focusId`), so the unfocused form (role key, persisted folds and camera) renders only in `tests/ui/workflow-activity.test.tsx`. Keep it and sample it, or remove the branch and its two `localStorage` keys (`pomegr-agent-tree-folds-*`, `pomegr-agent-tree-camera-*`) with its tests. The retired unfocused-tree specification is recoverable from Git history (`docs/plans/agent-tree-view.md` before commit `c8ab944`) if the form is kept; it recorded fixed approximately 156x140 column tiles at 640px and above and 48px rail rows below, initial folding (live trees of ten or fewer agents expand fully, larger live trees reveal roots and paths with active, waiting, warm, or needs-input agents, historical trees reveal roots and direct children), a width-only initial fit clamped to 40-100% with manual zoom of 25-300%, and role shape for role with status carried by text and color (active green, needs input amber, waiting or warm blue, stopped red, idle or finished muted). Those values were not re-verified against the code. Rating: medium.
- [x] **DSG-4 Repository setup row states.** Promoted 2026-10-25 in `DesignSystemRepositorySamples.tsx`. Shipped rows and capture controls show updates, all feedback tones, five capture states, and inline confirmation. The provider section head uses shared classes and a fixed capture string.
- [x] **DSG-5 Revision evidence.** Promoted 2026-10-25 in `DesignSystemRepositorySamples.tsx`. Fixed strings show the hairline fact grid, setup cards, and revision summary. The shipped `ContextAllocationBreakdown` shows loaded, deferred, and reserved evidence from synthetic props.
- [ ] **DSG-6 Linked repository index row.** `.commandRepositoryRow` and `.commandRepositoryHead` in `RepositoryInventoryView.tsx`, with the setup-chip tones and the chevron. One caller. Rating: low; reject unless a second list adopts it.
- [ ] **DSG-7 Command table static sort states.** The `/design-system` command table sorts when clicked, but the page cannot show the unsorted, descending, and ascending headers side by side, or a focused header, without interaction. A static view needs an `initialSort` prop on `CommandTable`, a small API addition, so weigh it against a note that already describes the three states. No production caller enables sorting or built-in pagination today; these states exist in `tests/ui/command-table.test.tsx`. Rating: low.

## Carried-over critique findings

Two Impeccable critiques (2026-08-15 and 2026-09-01) of the old session page were triaged against the current tabbed session page and then deleted. Of their nine findings, eight are resolved or superseded; the ninth (dense chart interaction on keyboard and phone) remains in part, as these two items.

- [x] **DSG-8a Duplicate close names in the phone navigation.** Completed 2026-10-25. The scrim has no accessible name or tab stop and stays hidden from assistive technology. The header button keeps "Close primary menu" while the drawer is open. Tap dismissal, keyboard activation, Escape, and focus return remain available. `tests/ui/app-shell.test.tsx` checks unique accessible names for the open-menu shell controls and the dismissal behavior.
- [ ] **DSG-8b Per-request tab stops in Request charts.** The first critique asked for one keyboard-inspectable chart surface instead of one focus stop per bucket. The old context chart is gone, but every request bar in `RequestBarsChart.tsx` is still `tabIndex={0}` (up to 60 stops on desktop and 20 on phone) even though arrow-key stepping exists. Decide whether a roving tab stop would keep selection and the minimap predictable, and confirm phone bar sizes against the 44px rule in DESIGN.md. Not re-measured in a browser, and neither are the other phone targets that may be under 44px (agent chips, text actions, and footer links).
- [x] **DSG-9 Non-persisting roster sample.** Completed 2026-10-25. `persistPreferences={false}` keeps roster selection, open groups, Hide finished, and grid metric in memory. The sample neither reads nor writes localStorage. Real sessions retain persistence by default.

## Continuation checkpoint - 2026-10-25

- DSG-1 and DSG-5 now have static sections, shared classes, fixed strings, and matching design-contract guards.
- DSG-9 disables every roster preference read and write for the sample; production defaults remain unchanged.
- Tests first: the missing sections, saved roster choices, and written-contract guards failed before implementation.
- New tests mount sections directly and use a five-second limit.
- Verification: the style hook, all 80 focused tests, `npm run verify:fast`, and `npm run build` pass.
- `npm run test:ui` passes all 2,473 tests across 169 files; the three new behavior tests take 47–302 ms individually.
- `npm run test:node` reports 4,046 passes, four skips, and two failures; both failing files pass individually on rerun.
- The reruns cover `tests/desktop-terminal-host-client.test.mjs` and `tests/server/providers/codex/session-discovery.test.mjs`.
- Browser inspection is unavailable because no browser is connected.
- Build-generated legal and favicon changes contain only line endings and are restored.
- DSG-2, DSG-4, and DSG-8a remain complete.
- DSG-3, DSG-6, DSG-7, and DSG-8b remain open. Continue with the DSG-3 keep-or-remove decision.

### Open questions

- The category grid has shared CSS at `app/styles/workspace.css:469` but no production component caller. The sample uses that markup without changing production.
- `DesignSystemKit.tsx` contains no persistence caveat in this checkout; only the roster sample note needed updating.
- Both existing design-system test files already contain 800 lines. The new `tests/ui/design-system-evidence.test.tsx` holds focused behavior checks.
- `tests/ui/design-system.test.tsx:87` now scopes the status-pill assertion to Chips and pills because the sheet repeats the same status text.

## Owned elsewhere

- Desktop Activities feed (`ActivityFeedPanel`, `ActivityKindRail`, `LargestRequestsList`) has only phone exceptions on `/design-system`. [Session Activity panel redesign](session-activity-panel.md) already decides whether the breakdown row and the highlighted feed row become shared samples; do not track them twice.
- The Home guide in `app/HomeDashboard.tsx` still tells readers to open a session's Context history, a panel the session-page redesign removed. It is recorded as a follow-up of task T12 in [the information architecture redesign](ia-redesign.md#t12-closure).
