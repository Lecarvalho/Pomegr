# Activities design

> Scope: the session Activities tab, which holds the Requests chart, the Largest strip, the grouped request feed, and the phone Activities feed.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/components/dashboard/`, `app/styles/`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

The Activities tab shows session evidence with one bar per request and a grouped feed of the calls linked to each request.

Use Inter for panel language and controls. Use the data font (Geist Mono) for request counts, ordinals, timestamps, and other execution data.

Metric definitions, ranking rules, and counting rules are in [Metrics](../architecture/metrics.md#request-snapshots). The privacy rules are in [Session evidence](../architecture/privacy/session-evidence.md).

## Evidence meaning

- Activity is a separate evidence panel. It is not content inside Session details.
- Requests presents session evidence with one bar per request and a numeric **Full prompt** in the selected-request details.
- Context is the latest non-zero actual level, carried to bucket boundaries.
- A request snapshot is an independent request-local observation. Pomegr never carries it forward, differences it, buckets it, or sums it.
- Requests replaces the former Context history and Request snapshots panels. Settings Data display keeps only the API list-rate estimate toggle.
- Deterministic insights stay traceable to concrete events. They are never presented as AI judgments.

## Requests chart

### Layout

- Requests is the shipped SP05 session evidence panel. It has one bar per model request.
- The window is a fixed 60 requests on desktop and 20 on phone.
- A minimap shows on desktop and on phone. Phone also supports direct chart dragging.
- The Largest strip is scoped to the agent scope. It sits under the minimap.
- Each layout shows its numeric scale on the chart itself. Lanes show the lane maxima. The single chart shows axis ticks.
- Compaction boundaries appear as dashed ticks.
- Agent scope applies to the chart, the strip, the groups, and the aggregates.
- Rankings and scale are computed over the selected agent scope. Every displayed number stays request-local.

### Modes

- The default **Fresh tokens** mode draws uncached input, cache write, and output bars. It has no prompt outline. Its scale excludes cache reads.
- **Full breakdown** adds cache read.
- The minimap follows the token categories of the selected mode, including output.

### Range line

- Above the chart, a caption-size muted range line reads `Showing #first–#last of total`.
- A single-agent scope adds `· N of M for this agent`. Session request numbers skip other agents.
- The recent-request preview omits the range line.

### Desktop header and scrollbar

- The request header keeps its title and one-bar explanation inline.
- The legend and controls sit alongside the title when space permits.
- The chart keeps its scale explanation and a slim minimap without a loaded-count label.
- The scrollbar spans the full scoped request history. Its thumb is proportional to the visible window.
- Dragging, clicking the track, the arrow keys, Page Up/Down, and Home/End navigate committed history windows.
- Miniature bars show every scoped request from the committed overview. They do not depend on the loaded detail window.
- The miniature bars use a stable full-history scale for the selected mode.
- An older monitor without an overview shows only the loaded evidence, at its actual positions.
- An empty track is not a zero-token observation.
- The panel omits the normal request-count status and the separate First / Older / Newer / Latest row.
- Loading and unavailable states stay explicit.
- Desktop Prev/Next selection crosses request-page boundaries.
- After the initial page, the panel preloads committed request pages for the viewed scope.
- Dragging renders each resident window at once, before pointer release, and does not fetch it again.
- The chart stays visible while a window loads.
- The overview bars and the full-scope chart scale stay stable while the thumb and detail window move.

### Preview before full history

- Before full history arrives, the panel renders the available recent request snapshots at once.
- The preview uses observation times instead of stable request numbers.
- The retention line explains the preview.
- The full-history minimap waits until its page is ready.
- The preview stays visible through loading and retries.

### Following

- Click or step to the newest bar, or to its linked Activity row, on the latest live page. This resumes following in both panels.
- Following also resumes after a linked request window loads.
- Older selections stay anchored.
- Historical sessions never follow live appends.

### Loading

- Foreground request-window loading keeps the last committed chart and feed visible under a local neutral veil and an announced loading status.
- The chart and feed never mix selections.
- Failed or loading work keeps the last-known-good evidence and never invents counts.
- A newer navigation cancels an older pending request window.
- An older selection stays anchored while live history grows.

### Phone

- Phone controls are at least 44px high.
- The chart omits Prev/Next and keeps a slim minimap.
- The minimap histogram is 26px high inside a 44px touch area, with transparent vertical padding.
- A tap on the minimap jumps to that part of history. Its window stays synchronized with chart swipes.
- Dragging directly on the bars moves the 20-request window. A drag to the right reveals older requests. A drag to the left reveals newer requests.
- A tap selects a bar. Vertical page scrolling and pinch zoom stay native.
- Horizontal dragging takes pointer capture after a movement threshold. It suppresses selection on release.
- Cancellation releases the gesture. A second finger cannot replace an active drag.
- Keyboard bar navigation stays available.
- When a new chart window is ready, Activity reveals the linked rows for its selected request.
- Manual Activity paging stays independent between chart navigation actions.

### How to read this

- The Requests title and the range line stay plain text.
- Their explanations share one quiet **How to read this** dotted popover at the bottom right of the panel, beside the Largest strip.
- The explanations cover why Fresh tokens leaves out cache reads, request numbering, and in lanes the per-lane scales.
- The trigger is caption size and muted, with a faded dotted underline.
- Phone drops this popover. The strip is the whole footer there.
- The Tool calls by kind rail caveat uses the same quiet treatment.
- Popover text states only what a technical reader cannot discover from the controls.
- A popover has one or two short sentences. It has no walkthrough of clicks or privacy boundaries.

## Request lanes and single chart

### Controls

- Desktop Activities defaults to lanes.
- Two segmented groups sit in `.requestsActionsModes`: Chart mode (Fresh tokens / Full breakdown) and Chart layout (Lanes / Single chart).
- The layout has no URL parameter. It does not render on phone, where only the single chart is drawn.
- Both layouts share request order, the window, selection, arrow-key stepping, and the minimap.

### Lanes

- There is one lane per agent with loaded requests, in roster order. Every request is drawn exactly once.
- Requests from compaction agents share one Compactions lane, placed last.
- The primary lane is taller, with a 22px band and a 96px plot. Other lanes have an 18px band and a 34px plot.
- Each lane prints its own `max N` in a 72px right gutter. The text is caption size, in the data font, and faint.
- Bars and evidence icons never reach the gutter.
- In lanes, the Largest strip starts under the plots, level with the first bar. It does not start under the label column.
- Lane evidence icons are 14px.
- Band text is placed in priority order: the hovered, focused, or selected cache-evidence label, then the selected request number, then compaction text.
- The chart drops any label that would overlap. It never draws one.

### Labels

- The label column is 220px wide. It has a 1px `--command-line` right rule.
- The name is 12px/500 ink.
- The meta line is caption muted. It reads `role · model`, `compaction · N agents`, or `not in the agent roster`.
- The name and the meta line are each ellipsized on one line.
- The full `name · meta` is the title tooltip and the accessible name.
- Labels never carry role dots or role tints.

### Focus and collapse

- Lane names of roster agents are `.commandQuietAction.requestLaneLabel` buttons. They bleed 20px into the plot padding.
- Pressing a lane name focuses that agent's scope across the tab. The button sets `aria-pressed` and shows a 6% ink tint.
- Pressing it again returns to all agents.
- A collapse applies with more than eight roster lanes (roster agents plus the Compactions lane) and no focus.
- Then Direct subagents, and each workflow with two or more agents, collapse into one group row.
- The group row draws every member request on one group maximum.
- Its label button sets `aria-expanded`. A 12px chevron rotates 90°.
- Expanding the group shows a header plus member lanes, indented one `--space-4` step.
- Primary and Compactions never collapse.
- Selecting a request inside a collapsed group does not expand it.

### Single chart

- On desktop and phone, the scale follows the requests currently visible. Off-window requests cannot compress the bars as the window moves.
- The minimap keeps its stable whole-history scale.
- The role-family agent track runs under the bars. It has one `.requestRoleSegment` per visible bar.
- Each segment is 4px high after a 3px gap. The gap is 3px on phone.
- The `.sessionRoleLegend.requestRoleLegend` below the track lists the role labels in view, ordered by family, with distinct agent counts.
- The legend keeps each label's case. `custom: <type>` and lowercase roles are not capitalized.
- Text beside the legend names the agent as `#n`, name, role. It is never SVG text.
- That text names the hovered or focused bar's agent. Otherwise it names the selected request's agent.

### Phone chart

- Phone always draws the single chart with its track and legend, then the minimap and the Largest strip.
- A dedicated full-width row sits between the legend and the minimap. It shows the inspected request's `#n`, agent name, and role.
- The dedicated row stops the minimap from moving while a touch is on it.
- Compaction, selected-number, and cache-evidence text share one reserved row just above the plot top.
- Bars never reach that row.
- The row uses the lane band priority. It drops a label rather than overlapping it.
- Evidence icons sit above that row.
- The numeric scale recomputes from the visible window in both Fresh tokens and Full breakdown modes.

### Role tint scope

- In Activities, role tints appear only on `.requestRoleSegment` and the legend swatches.
- Lanes, lane labels, group rows, and the minimap use no `roleFamily-*` classes.
- They also use no `--session-role` or `--role-*` values.

## Minimap

- The minimap is neutral grey.
- Bars use `--command-line-strong`.
- The window uses a `--command-muted` stroke with a 12% muted fill. The whole-history window uses `--command-line-strong`.
- No brand or role color appears.
- Only cache-evidence ticks keep amber. They are dotted when inferred.
- The slider's `aria-valuetext` reads `Request positions a to b of n`. Positions within the scope are not request numbers.
- The interaction hint is never rendered inline. It is the SVG title tooltip and the slider's `aria-describedby` description.
- Matching ticks show for cache-evidence markers.

## Cache-evidence markers

- A monitor-qualified possible full-refill transition gets an amber dotted line with the shared stack-refill icon and the label Possible full refill.
- A read-drop inference uses an open arrowhead and the label Possible refill.
- A model-change observation reuses the open arrowhead. Its compact chart label is Reuse drop · model change.
- Agent occurrence popovers say Cache reuse dropped across a model change. They distinguish the observation from refill or expiry inferences.
- Mixed agent counts describe cache-read drops. Each occurrence explains its own evidence.
- Ordinary cache growth and initial cache creation stay in the cache-write bars and details.
- The cache-evidence symbol and label lane sits above the compaction labels.
- Marker labels show on selection, focus, or hover, with matching minimap ticks.
- The bar's accessible name carries the same label.
- The markers reuse existing controls.
- The qualification and matching rules are in [Metrics: Cache-read drops](../architecture/metrics.md#cache-read-drops).

## Largest strip

- The strip is one wrapping line under the minimap. No request detail panel sits below it.
- A heading identifies the scope.
- A quiet **Largest by uncached input** button cycles the metric through uncached input (the default), cache write, total, and output.
- The button skips cache write when the provider does not record it.
- Up to three requests with a non-zero value follow. The ranking rule is in [Metrics: Request snapshots](../architecture/metrics.md#request-snapshots).
- Each item is a quiet action that shows `#n`, the agent name, and the request-local count.
- Selecting an item selects its request.
- Counts use the shared request-token format: `compactNumber` text (139.7K), the exact value in the hover title (`requestTokenTitle`), and the exact value in the accessible name.
- These counts match the token cells of the feed.
- The compact detail region aligns request facts with five ranked rows: request number, neutral bar, and request-local value.
- Phone keeps the strip under the minimap as the same wrapping line. It is never a stacked list.
- The phone items stay inline. They do not take the full-width phone quiet action.
- The phone items are a documented caption-size 32px exception to the phone 44px target. Three ranked requests read as two short lines.
- The strip omits repeated agent and Before metadata, expansion controls, and a ranking footer.

## Grouped request feed

### Layout

- Activities is a grouped request feed below the Requests chart and its Largest strip.
- A 360px Tool calls by kind rail precedes the five request groups around the selected request. The rail holds Shell tasks and Failed shell runs.
- Compact desktop widths stack the rail above the groups.
- Groups contain only request-linked calls. They keep their stable session request numbers.
- The range or window label appears before **Previous**, **Next**, and **Jump to latest**.
- Those controls navigate committed request groups. They do not navigate numbered activity pages.
- Selecting a group, a chart bar, a Largest item, or a supported call keeps the chart, strip, and feed correlated.
- The selected request uses the only brand accent and the scoped selected-request left rule.

### Request lines

- A request line prints only what changed from the group above it.
- The agent and role appear on the first group of the page and wherever the agent changes.
- The recorded model, in the data font, appears wherever it changes, including under an unchanged agent.
- The accessible name of each line states the agent, role, model, and exact counts.
- The request number is regular-weight muted data until the row is hovered or selected.
- Desktop token counts keep their chart-legend colors and print through `compactNumber`. They name their kind and exact value on hover.
- One rule separates request groups. A request line and its calls carry no rule between them.
- Desktop request lines are 34px high and their call rows are 30px high. Each request reads as the header of a compact group.
- The phone line prints the same counts in the same colors, with an 8px gap, ahead of its muted request time.
- A tap on a phone line opens the four exact counts.

### Actions without a recorded request

- The feed lists tool calls with no proven request association in a separate "Actions without a recorded request" section.
- The section sits below the request groups and is ruled apart from them.
- It shows no request number and no token value.
- It is built from existing roles and tokens.
- The request groups omit these calls. Request links are recorded associations, not token or cost attribution. See [Session evidence](../architecture/privacy/session-evidence.md).

### Footer

- The feed footer carries the quiet **Request-local counts** popover on desktop and on phone.
- Phone adds no walkthrough of what each line holds.
- The shared request-association caveat stays available from the Requests panel.

## Phone Activities feed

- On phone, the feed shows the request groups and their range navigation first.
- Actions by kind, Shell tasks, and Failed shell runs follow below them behind one rule (`.activityLayout.isPhone`).
- The desktop and compact-desktop order is unchanged. The 360px rail precedes the feed.
- Request-group targets stay at least 44px.
- Two exceptions apply to this phone composition alone. `tests/ui/pomegr-design-contract.test.tsx` keeps each from spreading.

### Selected-request brand rule

- The selected request group carries a brand-colored left rule. Its call lines carry the same rule (`.activityLayout.isPhone .activityTableFrame.isSelectedRequest`).
- This is the only brand-colored left border in `app/styles/`.
- Selection everywhere else stays on the raised fill (`--command-panel-2`).

### 32px call line

- The phone call line (`.activityCallLine`) is 32px high. It is the single documented dense-list exception to the 44px touch minimum.
- The call line is full-width and sits between 44px request lines.
- Its icon, target, and wall duration form one compact line.
- The line itself is its disclosure target.
- A tap expands its already-bounded detail in place, beneath the line.
- Only one disclosure is open.
- Escape collapses the open disclosure.
- The disclosure creates no sheet, no scroll lock, and no URL state.
- No other `activity` selector may set a 32px row height.

## Samples

- `/design-system` renders a static lanes sample with one expanded and one collapsed group, a Compactions lane, and the minimap.
- `/design-system` renders a single-chart sample with the track and legend.
- `/design-system` renders static samples of the "Actions without a recorded request" section.
- `tests/ui/pomegr-design-contract.test.tsx` enforces the label grid, the pressed tint, the member indent, the gutter and lane heights, the collapse threshold, the tint scope, and the neutral minimap.
