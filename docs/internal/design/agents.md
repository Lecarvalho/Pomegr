# Agents design

> Scope: the session Agents panel, the agent inspector, the grid, the focused agent tree, the Agents route, `ProviderBadge`, and role tint.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/components/`, `app/role-family.ts`, `app/styles/`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

This page covers how agent activity looks and how the user operates it.
Agent activity shows normalized roles and evidence with the existing privacy bounds.

## Custom role labels

- An unmapped agent role displays `custom: <type>` when the monitor supplies a validated custom type label.
- The roster, the inspector, and the tree reuse the existing role metadata text, including its accessible label.
- A missing label stays `unknown`.
- Role glyphs and aggregate summaries keep the normalized role.
- This is a copy change inside existing controls and typography.

## Agents panel

### Layout

- The Agents panel keeps its title, observed count, and content-width List / Grid switch on one heading row at every width.
- The filters sit below the status distribution.
- The session roster fits its content up to 560px on desktop.
- The roster has a sticky primary row and sticky group headers.
- On all screen sizes, vertical scrolling continues to the page at either roster edge.
- This also holds when collapsed groups or filters leave no inner overflow.
- The panel uses the existing Inter UI and Geist Mono data tokens.

### Groups

- Groups organize primary, direct, and workflow agents.
- Open groups persist per session.
- Rollups sum latest snapshots and label the result as context.
- Workflow navigation clears active filters before it expands the destination group.
- Caret motion respects reduced motion.

### Controls

- The controls are workflow grouping, search, status and model filters, Hide finished, and within-group sorting.

### Intermediate widths

- From 761px to 1250px, the roster omits the Calls and Cache TTL columns.
- Both columns stay available in the inspector.
- The roster owns its compact column rules.
- Stacking the inspector at 900px therefore does not restore the columns early.

### Phone

- Search stays visible.
- The other controls move into a filter sheet.
- Phone rows are 56px high.
- The region fits its content up to 60vh.
- Phone group tree controls have a 44px target.

## Agent inspector

### Layout

- On desktop, the selected-agent inspector occupies a 340px column.
- From 761px to 900px, the inspector stacks below the roster.
- At 760px and narrower, the inspector opens as a full-screen sheet.
- Selection persists per session.
- Navigation reveals the target group.

### Content

- The inspector shows normalized lineage, latest context, skills, signals, shell tasks, approval reviews, and the primary plan checklist.
- The copy action keeps the local-client gate and the one-shot path request.
- The exits are Activities for this agent and the model across sessions.
- Each exit is a full-width [Secondary](../../../DESIGN.md#buttons) row with a trailing chevron.
- **Copy transcript path** is a [Quiet](../../../DESIGN.md#buttons) left-aligned action.
- The desktop column and the phone sheet share this stack.
- Only the sheet grows the stack to 44px.

### Approval reviews

- Approval-review outcomes are sentence-case evidence chips.
- The chip is positive for Allowed and negative for Denied.
- Review rows carry no separate leading mark.
- Their text therefore aligns with the section heading.

### Phone

- Back and Escape restore the opener.
- Body scroll stays locked while the sheet is open.

## Grid

- The grid uses bounded workflow lanes.
- The tile bars share one preference: latest context (or final context in history), wall time, or tool calls.
- Every bar uses one maximum scale across the session.
- Responsive lanes show six, four, or two tiles.
- Selecting a tile reuses the inspector.

## Focused agent tree

### Cards

- The tree uses compact 220×74 agent, workflow, and phase cards.
- Collapsed groups are 58px.
- Connectors are curved.
- The tree has a combined header with scope and fit controls.
- Fit frames the complete visible focused tree.
- Tree cards have no detail popovers.
- A persistent note sends readers to the List view for tasks, skills, execution, and plan details.

### Ancestry and clusters

- The desktop layout keeps the canonical provider-recorded ancestry unchanged.
- Workflow and phase presentation groups are added only for canonical sibling sets.
- Groups describe provenance.
- A group never becomes a spawn parent.
- A large no-workflow sibling set shows the focused target, a nearby sibling, and a bounded cluster for the remaining siblings.
- Card and cluster totals use the latest context snapshots across the represented subtree.

### Scopes and marks

- Desktop exposes the Ancestors and Whole session scopes.
- The tree preserves the focus-path camera and the local focus state.
- Focus is marked in coral.
- Warnings are marked in amber.
- The tree distinguishes provider-recorded spawn ancestry from workflow provenance.

### Form

- The tree chooses its form from its own observed container width, not the viewport.
- At 640px and above, it draws fixed-size cards in columns.
- Below 640px, and on phones, it becomes a rail of fixed 48px indented rows.
- The rail scrolls natively.
- The rail never intercepts wheel, pinch, or touch gestures.

### Camera

- These gestures apply to the column form.
- Dragging pans.
- Pinching or a modifier-wheel zooms from 25% to 300%.
- The plain wheel pans.
- A double-click, a double-tap, or `0` fits the tree.
- Folding a branch moves the camera only enough to keep the activated card in place and reveal its children.
- Folding never changes card size or scale.

### Keyboard and focus

- Focus is one roving tree stop.
- Up and Down move through visible nodes.
- Right and Left expand, collapse, or step to a child or parent.
- Enter and Space fold a branch.
- In column form, Shift with an arrow pans.
- In column form, `+` and `-` zoom, and `0` fits.

### Accessibility

- Connector lines are decorative.
- Document order carries the hierarchy.
- Each node's accessible name states its role and status instead of relying on color.

### Phone

- The tree uses the InspectorSheet rail with readable status and cluster summaries.
- Back to inspector returns to the inspector.
- Closing the inspector then restores the opener.

## Agents route

### Layout

- The Agents route is titled **Models & delegation**.
- The route has two tabs.
- Arrow keys and Home/End move between the tabs.
- **Live agents** is the shared `CommandTable` roster.
- **Live agents** keeps backend parent-first order and is never locally sorted or regrouped.

### Models & work

The tab reads in this order:

1. Compact run, session, and reported-model counts.
2. The Models used ranking and the Models by role matrix.
3. Observed work and Patterns in this selection.
4. A "How are these numbers counted?" disclosure.

- Main and delegated agents keep distinct fills in the ranking.
- The ranking percentages use every run in the selection as the denominator.
- Rounded values therefore need not sum to 100.
- Every count is a real button that opens the contributing runs in one evidence drawer.
- Close or Escape dismisses the drawer, and focus returns to the trigger.
- Each run links to its agent in the parent session.

### States

- Loading, partial coverage, delayed updates, and missing evidence are quiet notices.
- The notices keep the retained summary visible.
- A known zero reads as zero.
- Missing evidence reads as unavailable.
- Counting rules: [Agents model and work analytics](../architecture/metrics.md#agents-model-and-work-analytics).

## ProviderBadge

- Provider names are words, never logos.
- `ProviderBadge` renders the product name in a standard `.commandChip`.
- Inside headings and inline list metadata, it renders plain inherited text with `variant="text"`.
- Provider logos are third-party trademarks and do not ship in the application.
- Settings → About states that Pomegr is not affiliated with the providers.

## Role tint

- Role tint is the only exception that colors normalized agent roles.
- It appears only in agent tracks and their legends.
- `app/role-family.ts` owns the mapping.
- Agents with the same role share one tint.
- Roster rows, trees, lanes, and agent-name dots do not use these colors.
- Status dots keep their lifecycle meaning.

| Roles | Tint |
| --- | --- |
| orchestrator | neutral track grey |
| explore, researcher | reading blue |
| plan | planning teal |
| builder, tester | writing ochre |
| reviewer | reviewing rose |
| general-purpose, workflow-worker, fork | generic grey |
| compaction, unknown, validated custom roles | lighter system grey |

## Samples

- `/design-system` renders the shipped `AgentActivityPanel` from static agents.
- The panel sample has a pinned, selected primary row.
- It has an open workflow group and a collapsed Direct subagents group.
- It has the distribution strip, the filters, the inline inspector, and the List / Grid switch.
- `/design-system` also renders a standalone inline `AgentInspector` with lineage.
- At 760px and narrower, a tap on a roster row opens the real sheet there.
