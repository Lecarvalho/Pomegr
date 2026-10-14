# Task board design

> Scope: the Tasks home, the Tasks page (page header, Board, Queue settings panel with its Start gates, Schedule, and blocking-rule sections), the task card and its chips, and the session surfaces for a task session.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/components/tasks/`, `app/styles/tasks.css`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

The Tasks page draws committed board facts. The task modal and the task fields are in [task-modal.md](task-modal.md). The data, queue, and gate rules are in [Tasks](../architecture/tasks.md).

## Tasks home

### Layout

- The route is `/tasks` with no `repository` parameter. The rail and the palette open it.
- The home is a composition of the existing roles, chips, and tokens. It adds no button role and no shared control.
- The header is `CommandPageHeader` with the h1 **Tasks** and a muted description. It has no action.
- The page holds two `.panel` sections in order: **Needs you**, then **Boards**.
- Each panel head is a 16px/650 heading with a muted data-font count beside it.
- Every element draws committed board facts. A state is never shown and then retracted.

### Needs you

- The panel lists the tasks that wait for the owner on any board: Needs review, Stalled, and Blocked by agent.
- The newest change is first. At most 50 tasks are listed.
- Each row is one link to the task's board, at least 44px tall.
- A row shows the repository name (12px muted), the task ID (data font, muted), one title line (13px/500), the state chip, and a muted 14px chevron.
- The title is the session title when the session has one, otherwise the first line of the task text. It is one line with an ellipsis.
- The state chip is the shared `.commandChip` in the warning tone.
- With no such task, the panel reads “Nothing waits for you.”
- When more than 50 tasks wait, a muted line reads “Showing the newest 50 of n.”
- A task of a repository that the inventory does not list is not drawn or counted.

### Boards

- The panel is one table with one row for each repository in the inventory.
- The columns are Repository, Queue, the five board columns, and Last change.
- Boards that changed last come first. The other repositories keep the inventory's order.
- The repository name (13px/600 ink) is the row's one link. It opens `/tasks?repository=<repositoryId>`.
- Under the name, a muted 12px line reads “n open features”, “No open feature”, “No tasks yet”, or “Board unavailable”.
- The five counts and the last change use the data font and are right-aligned. A zero is muted.
- Last change is the relative time of the board's newest task change, or an em dash.
- A repository with no stored board reads zero counts, **Off**, and “No tasks yet”. Its name is muted.
- A board that is unavailable reads an em dash in every cell. It never reads a count.
- The table scrolls sideways in its panel when the window is narrow.

| Queue | Chip |
| --- | --- |
| Off | Neutral and muted. |
| On | Neutral, in ink. |
| Blocked | Negative. It reads “Blocked by T-n”. |
| Paused | Warning. |

### States

| State | Draw |
| --- | --- |
| Loading | Two placeholder blocks with the label **Loading tasks**. |
| Unavailable | A panel notice with a status role. |
| A client that is not on this computer | Only the **Desktop only** notice. |
| No repository observed | The shared empty state. |

### Phone

- At 760px and narrower, a Needs you row stacks: the repository and the ID, then the title on its own wrapping line, then the chip and the chevron.
- At 760px and narrower, each board row is a card: the name and the queue chip, then the five counts under their caption labels, then the last change.
- The table header is not drawn there. Each count carries its column name as its label.
- The repository link is at least 44px tall there.

## Tasks page

### Layout

- The route is `/tasks?repository=<repositoryId>`. It is a root route. The repository detail's Tasks tab only links to it.
- The route takes an optional `feature=<featureId>` beside the repository. A session's feature link adds it. See [Feature link](#feature-link).
- The page is a composition of the existing roles, chips, and tokens. It adds no button role.
- The page holds these parts in order: the shared page header, the **Queue status** banner, and then the Board.
- The **Queue status** banner shows only while the queue is blocked or paused.
- The Board holds the capacity strip, the feature filter, and the lanes of task cards. Its **Queue settings** action opens the [Queue settings panel](#queue-settings-panel).
- One desktop-only modal holds the task fields, in three modes: new, promote, and edit. See [task-modal.md](task-modal.md).
- A session started for a task adds the session surfaces at the end of this page.
- Every element draws committed board facts. A state is never shown and then retracted.

### Page header

- The header is `CommandPageHeader` with the h1 **Tasks**, a muted description, and the head actions at its end.
- The description reads “Work for this repository. Ready is the queue: cards start from the top.”
- The breadcrumb is **Tasks**, a chevron separator, and the repository name. **Tasks** links to the Tasks home, and the name carries `aria-current`.
- The head actions (`.taskHeadActions`) wrap and use a 12px gap.
- The header has no primary action: **New task** lives in the first lane.

The head actions appear in this order:

| Order | Action | Shown when |
| --- | --- | --- |
| 1 | **Repository** `CommandSelect` | Always. 32px high, 12px text, at most 240px wide. 44px high on phone and coarse pointers. |
| 2 | The [queue switch](#queue-switch) | The desktop app or a paired device. |
| 3 | **+ New feature** | The desktop app, while the board has no feature. It opens the [Feature modal](task-modal.md#feature-modal). Once the board has a feature, the filter row carries it. |
| 4 | The Secondary **Promote issues** link | The desktop issues bridge exists. |

- The **Promote issues** link has a 14px circle-dot glyph and opens the Promote issues page.
- Like the other desktop-only actions, the **Promote issues** link is decided at first render.

### Repository selection

- The repository comes from the validated `repository` URL parameter.
- With no parameter, the page is the [Tasks home](#tasks-home).
- With a repository the inventory does not list, the page is the Tasks home too. The URL is replaced once with `/tasks`.
- While the repository inventory loads, a URL that names a repository draws the five-lane placeholder. It never draws a board that it then withdraws.
- Choosing a repository replaces the URL and remounts the board. No panel state carries over.
- Focus stays on the switcher after a repository change.

### Non-desktop clients

- An unpaired same-computer browser reads one muted line that says tasks are created and edited in the desktop app or on a paired device. The page decides this at first render.
- A paired phone's board note says “Sessions start on the computer running Pomegr.”
- A paired phone uses the same Queue **Off / On** control as the desktop app, including retry after a pause.
- Every client reads one muted line that says whether the queue is off or on.
- An unpaired client that is not on this computer reads only a **Desktop only** notice.

### Palette on a task board

- While a ready task board is in view, the palette trigger reads “Search tasks”.
- The board's tasks come before the destinations. At most 20 tasks match.
- Each result row has the `grid` glyph, the first line of the card title, and a detail line.
- The detail line holds the ID, the column, the chip, and the feature.
- Choosing a task opens its task modal in the desktop app.
- Choosing a task anywhere else focuses its card on the Board.

## Board

### Layout

- The columns sit in `.taskBoardGrid`, which is `repeat(var(--task-columns, 5), minmax(220px, 1fr))` with a 12px gap.
- The grid is inside a focusable **Task board** region. The region scrolls sideways and never shrinks a column below 220px.
- The region is positioned. It clips everything in its lanes, including visually hidden text, so the page is never wider than the window.
- At 760px and narrower, a lane is 86% of the region's width and at most 320px. One lane is read at a time and the next lane shows at the edge.
- At 760px and narrower, a sideways swipe stops on a lane (`scroll-snap-type: x mandatory`) and ends at the board.
- At 760px and narrower, the lanes grow with their cards and the page scrolls. A lane's card list is not a scroll container, so a swipe that starts on a card moves the page.
- The loading placeholder uses the same lane width.

### Lanes

- A column is a **lane** (`.taskColumn`).
- The lane has the raised fill (`--command-panel-2`) and a one-pixel `--command-line` border.
- The lane has the panel radius, 8px padding, and an 8px gap. Its cards use the panel fill.
- The lane is at least 240px tall.
- Above 760px, the lane is exactly as tall as the window leaves under the page header, gates, and filter. The page itself does not scroll.
- Above 760px, each lane scrolls its own cards under a thin scrollbar. Its header and **+ New task** stay in view.
- The lane under a dragged card cannot take the raised fill, so it takes the strong line (`--command-line-strong`) on its border.
- The drop-target border is two pixels wide, drawn as an inset one-pixel ring, in both themes.

### Column header

- The board has five fixed columns: Backlog, Ready, In progress, Review, Done.
- The column header is the name (13px/650, ink) and a data-font count (12px, muted) over a one-pixel `--command-line` rule.
- The column header has no control in the desktop app or a browser.
- Columns are never added, renamed, moved, or deleted.
- The count counts cards. A step group of the Ready lane is not counted.

### Ready step groups

- Groups are drawn in Ready only. No other lane groups its cards.
- A group holds the waiting cards of Ready that sit next to each other and share a feature step, or that have no feature step.
- A waiting card is a Queued or Scheduled card with no session. Any other card of Ready is a plain board card where it is.
- The grouping reads only the lane's card order and each task's feature and step. It reorders no card and stores no value.
- A card that does not wait, between two waiting cards of one step, splits the step into two groups.
- A group (`.taskReadyGroup`) is its caption and then its cards, with a 6px gap.
- A **parallel step group** (`.taskReadyGroup.isParallel`) is a frame around a step's two or more waiting cards.
- The frame is a one-pixel `--command-line-strong` border with the panel radius, 6px padding, and no fill.
- Any other group has no frame. Its caption and cards are inset 6px on each side, plus one transparent pixel, so they line up with framed cards.
- The caption (`.taskReadyCaption`) is the first row, with 2px/4px padding and its two parts at the ends.
- The left part is the feature name (12px, muted), “ · ”, and “Step k of n” (12px/650, ink).
- The right part of a step that holds one task is “One task” (11px, muted).
- The right part of a step that holds more tasks, in any lane, is the parallel glyph, a 4px gap, and “Parallel · n” (11px/500, ink), with the count in the data font.
- The count is the number of tasks of the step in any lane.
- The parallel glyph is 12px: two vertical 1.5px strokes in the current color. In a caption it is hidden from assistive technology.
- The waiting cards with no feature step come under the caption “Single tasks” (12px/650, ink) with “One at a time” (11px, muted).
- A grouped card (`.taskReadyCard`) is the board card at 10px/12px padding with a 6px gap.
- A grouped card shows the ID and chip, the title, the provider badge with “model · effort” at 11px, and its Starts or Waiting line.
- A grouped card shows no Complete when line and no feature line. Its caption carries the feature and the step.
- The card the monitor lists first keeps the chip **Queued · next**.
- That card adds one muted 12px “Waiting: …” line while a gate holds it and the queue is on.
- The drop line and the move toolbar work on a grouped card as on any card.
- A waiting card of a feature changes step here. See [Changing a step](#changing-a-step).

### + New task

- In the desktop app, the **first lane only** ends with the [Quiet](../../../DESIGN.md#buttons) **+ New task** (`.commandQuietAction.taskColumnAdd`).
- It has a 14px plus glyph and the label. It is 32px tall with 8px side padding.
- It is left-aligned under the last card, also in an empty lane.
- It is invisible (opacity 0, never `display: none`, so it stays keyboard-reachable) until the lane is hovered or holds focus.
- It is always visible on a coarse pointer and at 760px and narrower. It is 44px tall there.
- It has no transition.
- It opens the New task modal and has `aria-haspopup="dialog"`. Focus returns to it when the modal closes.

### Feature filter

- The feature filter (`.taskFeatureFilter`) appears once the board has a feature.
- It is one row with a muted caption eyebrow **Feature** and one `CommandSelect` (`.taskFeatureSelect`).
- The select is 32px high, 12px text, at most 320px wide. It is 44px high on phone and coarse pointers.
- The options carry the task count in parentheses. **All** is first and **No feature** is last.
- The row stays one control however many features a board holds.
- The desktop app adds a Quiet **Edit feature** and a Quiet **+ New feature** after the select.
- **Edit feature** shows only while one feature is chosen. **All** and **No feature** show no **Edit feature**.
- **Edit feature** opens the [Feature modal](task-modal.md#feature-modal) in mode Feature for the chosen feature.
- **+ New feature** opens the Feature modal in mode New feature. The row draws no inline name form.
- **+ New feature** is disabled while the board holds 50 features.
- With no feature yet, **+ New feature** sits in the page header and opens the same modal.
- A browser and a paired device draw neither action.
- Both actions have `aria-haspopup="dialog"`. Focus returns to the one that opened the modal.
- The order in the row is the eyebrow, the select, **Edit feature**, **+ New feature**, the progress line, and the helper line.
- While a feature is selected, the row shows its progress (`.taskFeatureProgress`), in any client: muted 12px “0 of 7 tasks done · step 1 of 4 running”.
- The counts of that line use the data font and ink.
- The step clause names the lowest step with a task that has a session and is not done, and the feature's last step. With no such step, the line is the done count only.
- **All** and **No feature** show no progress line.
- While a filter is on, the desktop app's row then shows the line “Moving cards is off while a feature filter is on.”

### Feature link

- The address `/tasks?repository=<repositoryId>&feature=<featureId>` opens the board of that repository with that feature chosen in the feature filter.
- The desktop app also opens the [Feature modal](task-modal.md#feature-modal) in mode Feature for that feature.
- A paired device and a browser on the same computer open no modal. The chosen filter and its progress line are their view of the feature.
- A client that gets the Desktop only notice gets only that notice.
- The board answers the parameter once, when the board is ready and the client is known. A later board read opens nothing again.
- A feature the board does not hold opens the whole board: the filter stays **All**, no modal opens, and no message is drawn.
- A value that is not a feature ID is ignored the same way. The address is not rewritten.
- A `feature` with no `repository` is ignored: the page is the Tasks home.
- When that modal closes, focus returns to the feature filter's select.

### Capacity strip

- The capacity strip is above the feature filter. It is one muted 12px row.
- The row starts with a **Start gates** eyebrow.
- It then shows each provider with its two percentages in the data font.
- It then shows “A task starts only when its provider has capacity.”
- On the Board, the strip's end (`.taskCapacityEnd`, `margin-left: auto`) reads “Do not start above 80% · stops starting after 23:00”.
- The threshold and the time of that line use the data font and ink. The stop clause shows only when a stop time is set.
- **Queue settings** (`.taskQueueSettingsAction`) is last in the strip, in any client. It is the [Quiet](../../../DESIGN.md#buttons) role, 32px high, 12px/500 ink, underlined.
- It is 44px high on phone and coarse pointers.
- It has `aria-haspopup="dialog"` and opens the [Queue settings panel](#queue-settings-panel).
- A board that sends no gates draws only the **Queue settings** action in the strip.

### States

| State | Draw |
| --- | --- |
| Loading | Five placeholder lanes. Each lane frame holds a 40% title bar and a 64px card block. |
| Unavailable | A panel notice with a status role. |
| No task | The muted “No tasks on this board yet.” is added. |

## Task card

### Layout

- The card (`.taskCard`) has the panel fill, a one-pixel `--command-line` border, a 6px radius, 12px padding, and an 8px gap.
- The top row is the task ID (data font, 12px, muted) and the state chip.
- The title is 13px/500 ink, clamped to three lines.
- The title is the first sentence of the first line of the task text until its session has a title. The split is a heuristic.
- A first line of one sentence is the whole title, and a Markdown heading mark is left out.
- The rest of the task text follows as one muted 12px excerpt (`.taskCardExcerpt`), on one run of text clamped to two lines.
- A card with a session title, and a grouped card, shows no excerpt.
- A backtick span in the title or the excerpt is drawn in the data font, without its backticks.
- The tooltip of the title is the whole task text, or the session title.
- A Done card's title is muted.
- In the desktop app, the title is the Quiet role drawn as plain title text, with no underline and no fill on hover or press. It opens the task modal.
- A click anywhere on a card that opens, except on another control of the card, opens the task modal too. Focus returns to the title.
- A card that opens shows the pointer cursor.

### Content

Each row below the title shows only when it is set, in this order:

- The provider badge with the planned “model · effort” in the data font.
- The muted **Observed model:** line.
- When the planned model and the observed model differ, the single amber line “Planned x, observed y”. It is a text color, never a fill.
- The muted **Starts** line of a scheduled task, until its session is linked. It reads “Starts today 22:00”, or “Starts Oct 9, 22:00” on another day, with the time in the data font.
- One muted **Complete when** line.
- The feature line “Feature · step k of n”, on a card that is not in a Ready group.
- When other tasks share the step, the line opens with the muted 12px parallel glyph, named “Parallel”, and a 6px gap.
- That line then ends “ · parallel with T-55, T-57”: the other tasks of the step, in any lane, by number, in the data font.
- The sessions line: **Open session**, a Text link that is not stretched, for the first session.
- The first session is the one Pomegr started, or else the first assigned session.
- When the task has more sessions, the muted “+N more” follows the link.
- When Pomegr started none, the muted word “Assigned” ends the line.
- The line is 12px text in a wrapping row with an 8px gap.

### States

- The border turns green while the bound session works.
- An assigned session never changes the chip or the border.
- The border turns amber for Needs review, Stalled, and Blocked by agent.

## State chips

- A state chip is the shared [`.commandChip`](../../../DESIGN.md#chips) outline label. A tone recolors only the text.

| State | Tone and notes |
| --- | --- |
| Not queued | Neutral and muted. |
| Queued | Neutral, in ink on the raised fill, with no border. It differs from Not queued. |
| **Queued · next** | The label of the one task the monitor lists first. |
| Scheduled | Info. The card's Starts line carries its time. |
| Needs review | Warning. |
| Stalled | Warning. |
| Blocked by agent | Warning. |
| Done | Neutral. |

- While a session is bound and the task has no outcome, the chip is the session's own state. It uses the Sessions list words and tones.
- In that case, In progress is positive, Needs input is warning, and the rest are neutral.
- There is no Running task state.
- A session state that the monitor has not committed leaves the task's own chip.

### Issue chip

- The **issue chip** is the same outline `.commandChip` with the class `taskIssueChip`.
- It has an 11px circle-dot glyph (1.7 stroke, current color) and `#N` in the data font.
- The text is 400 `--text-caption` 11px/1.3. The gap is `--space-1`.
- The text is muted on the panel line.
- It is a label and never a link.
- Its accessible name is “GitHub issue #N”.
- It shows right after the task ID on a card, on the Board.
- It shows in the Source line of the Task tab (“Source”, the chip, “GitHub issue”).
- It shows only for a task with a source.

## Moving cards

### Drag

- Moving cards is a desktop-app action. A movable card that does not open shows the grab cursor.
- A press that moves drags the card. A press that does not move is a click, which opens the card.
- While a card is dragged over a lane, a **drop line** shows where it will land.
- The drop line (`.taskCard.isDropBefore`, `.isDropAfter`) is a two-pixel `--command-ink` rule as wide as the card, in the gap between cards.
- The line is before a card when the pointer is over the upper half of that card.
- The line is after a card when the pointer is over the lower half of that card.
- The line is under the last card anywhere else in the lane.
- An empty lane draws no line. A drop that would leave the card where it is draws no line.
- The dragged card itself does not change.

### Auto-scroll

- Holding the dragged card near the top or bottom of a lane's card list scrolls that list. The scroll is faster the closer the card is to the end.
- At 760px and narrower, the list does not scroll. Holding the card near the bottom of the window or just under the sticky header scrolls the page the same way.
- The page scroll uses instant steps. The root scrolls smoothly, and a smooth step replaced on each frame would crawl.
- The speed is measured per sixtieth of a second, not per drawn frame. A browser that draws fewer frames during a drag scrolls as far.

### Keyboard and focus

- The keyboard alternative is a `toolbar` named Move T-n of four [Icon](../../../DESIGN.md#buttons)-role arrow actions.
- The four arrows are one tab stop. The arrow keys and Home/End work inside the toolbar.
- The toolbar is drawn only while the card holds keyboard focus.
- The toolbar is always drawn on a coarse pointer.
- Otherwise the toolbar stays in the accessibility tree.

### Changing a step

- In the desktop app, a waiting card of a feature in Ready changes step by drag. A waiting card is a Queued or Scheduled card with no session.
- The **Move to step…** select changes the step of every card of a feature that has not started, queued or not. A Not queued card in Backlog changes step too.
- A step move is the board's step action. It joins the card to an existing step or gives it a new last step.
- While the card is dragged over a step group of its own feature, the group (`.taskReadyGroup.isStepTarget`) takes the panel fill.
- That group also takes a two-pixel border, drawn as an inset one-pixel ring, in `--command-line-strong`.
- Dropping the card on the group gives it that step. No drop line is drawn over a step target.
- While the card is over the gap after the last step group of its feature in Ready, the **new-step zone** (`.taskReadyNewStep`) is drawn in that gap.
- The zone has a one-pixel dashed `--command-ink` border, the panel radius, and 10px/12px padding.
- The zone's text is centered 12px ink and reads “New step 3 · after step 2”, in the step numbers drawn now.
- Dropping the card on the zone gives it a new last step. The zone is drawn only while the card is over that gap.
- A step cannot be inserted between two steps. No zone is drawn between two steps.
- The card's own step is no target. The only card of the last step has no zone.
- A step whose tasks are all done accepts nothing. A card never drops on a step of another feature.
- A single task has no step target and no select.
- Nothing moves while a feature filter is on. No card changes step then, by drag or by select.
- The move toolbar of such a card gains the **Move to step…** `CommandSelect` (`.taskMoveStep`) after the four arrows.
- The select is 32px high with 12px text. It is 44px high on phone and coarse pointers. It is its own tab stop.
- Its options are one for each unfinished step except the card's own, then **New last step**.
- A step option reads “Step 2 · parallel with T-59, T-60”: the tasks of that step, by number.
- A step with a task that has a session reads “Step 1 · running”. That option is disabled.
- The toolbar stays drawn while the select's list is open.
- After a change of step, a status line reads “T-n moved to step k.”

### Copy

- A muted 12px footnote under the board reads “Drag a card to move it. In Ready, drop a card on a step to run it in parallel with that step, or after its feature's last step to give it a step of its own.”

## Queue

### Queue switch

- The queue switch is a two-way [Segmented](../../../DESIGN.md#buttons) control (Off, On) named Queue.
- A muted Queue eyebrow comes before it.
- On stays pressed while the queue is blocked or paused.
- Pressing On while paused is the retry.

### Queue status banner

- The banner shows while the queue is blocked or paused. It sits above the Board.
- It has the error-soft fill with the error line.
- The title is in the error color. The body text is in ink.
- The actions are on the right. They wrap under the text when narrow.
- On phone, the actions take their own row, and the secondary actions share it equally.
- The secondary actions use the strong line on the panel fill. This is a local deviation taken from the task-board design.

| Banner | Desktop app actions | Browser |
| --- | --- | --- |
| Blocked | A secondary **Open T-n**, a secondary **Mark done and resume**, and a quiet **Requeue T-n** drawn in ink | Text only |
| **Queue paused** | **Open T-n**, and **Open folder** for a dirty worktree. The banner states one fixed reason. | Text only |

- The actions are 32px high with an 8px gap.
- **Mark done and resume** and **Requeue T-n** show only for a task that stalled or was blocked by its agent.

### Queue settings panel

- The panel is a side panel, not a popover. The Board's **Queue settings** action opens it.
- It is the task modal's native modal `<dialog>` frame (`TaskDialog`), named “Queue settings”, with no scrim fill.
- The panel (`.taskQueueSettings`) is at the right edge of the Tasks page, 400px wide and full height. It scrolls its own content.
- It has the panel fill, a one-pixel `--command-line-strong` left border, 20px padding, and a 20px gap between its sections.
- The head is the h2 **Queue settings** (16px/650) and a 32px [Icon](../../../DESIGN.md#buttons) close button named “Close”.
- Focus starts on **Close**. Escape, **Close**, and a click outside the panel close it. Focus returns to the **Queue settings** action.
- The sections are **Start gates**, **Schedule**, and **When the queue blocks**: three sections with no frame of their own. They exist nowhere else.
- A section heading is an h3 at 13px/650.
- **Start gates** holds the caption “Checked before every session Pomegr starts.” and the five rows.
- The five rows have 8px block padding and are divided by one-pixel `--command-line` rules. The reading is right-aligned, in its usual color.
- **Do not start above** is one row: a muted 12px label on the left and the 32px `CommandSelect` on the right. A browser reads plain text there.
- **Schedule** and **When the queue blocks** each sit over a one-pixel `--command-line` rule with 20px top padding.
- **Schedule** holds the **Run now** / **Start at a time** pair, the **Stop starting tasks after** time field, the day line, and the fixed note.
- A browser reads the two schedule values as a two-row definition list.
- **When the queue blocks** holds a two-item list and one closing line. The state words Stalled and Blocked by agent carry the error color. The closing line says that Needs review, in amber, does not block the queue.
- The panel reads only what the board already serves. Without the desktop app or a paired device, it is read-only.

## Start gates section

- The **Start gates** section of the Queue settings panel holds the heading, one caption, and a definition list of five rows.
- Each row has the label on the left and the reading on the right.
- The two capacity readings are mono. They print only the percentages the board sent. They append “· above threshold” when they hold.
- Below the rows, the **Do not start above** field is a `CommandSelect` with the three fixed thresholds in the desktop app. A browser reads plain text.
- The Board's capacity strip shows the same two capacity readings.
- A qualified weekly-only Codex reading shows only `7d`; its hold message names the seven-day window.
- The threshold options say “of the usage window”; the caption explains the weekly-only Codex case.
- The gates section, the capacity strip, and the Waiting line are local to the Tasks tab. They use the `taskGate*` classes in `app/styles/tasks.css`.

| Reading | Color |
| --- | --- |
| The gate passes | Green |
| The gate holds | Error |
| The gate is unknown, or no task is queued | Muted |

## Schedule section

- The **Schedule** section follows the gates section in the Queue settings panel.
- It shares the gates section's heading, field, and caption classes.
- A browser reads the same two values as a two-row definition list.

In the desktop app the section holds these parts:

- A `.commandSegmented` pair, **Run now** and **Start at a time**.
- A **Start at** time field, shown only for **Start at a time**.
- A **Stop starting tasks after** time field.
- One muted line under a field. It names the day of its stored time or says that it has passed.
- The fixed note that a running session is never stopped and Pomegr must be open.

### Time field

- A time field (`.taskTimeInput`) is a native `time` or `datetime-local` input.
- It is at control height with the stronger control line, the control radius, and the data font.
- The task modal's **Start at** field uses it for a task's own start time.

### Scheduled task

- A scheduled task's chip reads **Scheduled** in the info tone.
- The card adds one muted **Starts** line until its session is linked.

## Session task surfaces

A session started for a task gains four surfaces. See [Tasks](../architecture/tasks.md) for the task reference that the monitor joins at serving time.

- Only same-computer clients see the surfaces. Any other client sees none of them.
- Without a ready board, or when the board does not hold the task, each surface draws only the reference's own fields and one quiet sentence.
- None of the surfaces edits a task.

### Sessions list Task column

- The **Task** column is second and 200px wide. On phone, it spans the card.
- The cell shows the task ID as a Text link in the data font. The link goes to the repository's board on the Tasks page.
- Beside the ID, an outcome chip shows only for what the session's own State cannot show.
- Needs review and Stalled use the warning tone. Done is neutral.
- Blocked by agent is served but has no chip.
- Under them is a muted 12px “Feature · step n” line. Under a Feature group header, the line is just “Step n”.
- For a task promoted from a GitHub issue, the number follows the ID as plain muted `--text-xs` data-font text (“#128”, no chip, border, icon, or link).
- The ID stays the one prominent identifier.
- Assistive technology reads “GitHub issue #128”.
- The issue number sits before the outcome chip.
- A session that is assigned to one task, and started for none, shows that task in the same form with the muted word “Assigned”.
- Any other assigned tasks are one line: the muted word “Assigned”, then each task ID as a Text link to its board.
- That line has no chip and no feature line, and it follows the started task.
- A session with no task shows an em dash.
- One muted footnote under the table explains the column.
- Grouping by **Feature** is the fourth Group by option. It lists only sessions started for a feature's task.

### Session header meta

- The meta row adds **Task**, with the ID as a Text link to the Task tab. On that tab, the ID is plain ink text.
- It then adds **Feature**, with the name as a [feature link](#feature-link) and the data-font “step n of N”.
- The row uses muted 12px text.
- The row stays on phone.
- The Overview tab has no task panel. The header meta and the Task tab carry the task.

### Task tab

- The **Task** tab is last. It is listed only for a task session and is read-only.
- The tab holds a task panel (flex `999 1 480px`, at most 960px) and a rail of panels (flex `1 1 300px`, at most 340px).
- On phone, the task panel and the rail are full width, and the rail is under the panel.
- Every field name in the tab is the 11px uppercase caption eyebrow in the muted color. Every value is ink.
- The tab's only buttons are its **Show all** and **Show less** Text links, which change no task.

The task panel holds these parts in order:

- The head with the heading and a muted “Started by Pomegr”. A Secondary **Open on board** is at the end of the head.
- The head has no state chip. The session header shows the state.
- Any block reason, in the error color under a **Block reason** eyebrow.
- The Source line of a task promoted from an issue. See Issue chip above.
- The task text in a well: the ground color, a one-pixel line, the 4px control radius, and 12px padding.
- The first line of the text leads the well at 14px/500 when more text follows it.
- The rest of the text is cut to ten lines, with a fade into the ground color while it is cut.
- **Show all** is under a text that does not fit. **Show less** closes it again.

The rail holds these panels in order: **Complete when**, **Run**, and the Feature aside.

The **Complete when** panel holds these parts:

- The head with the heading, the outcome chip, and a muted summary such as “Not yet reported” or “1 check did not pass”.
- The summary counts unverified checks apart from failed ones: “2 checks not verified”, or “1 check did not pass, 1 not verified”.
- The outcome chip shows only for Needs review, Stalled, Blocked by agent, and Done.
- The checks, as 36px rows: a 14px glyph, the condition, and a right-aligned result.
- A ruled **Definition of done**, cut to three lines, over the agent-reported status and its own **Show all**.
- With no check and no definition of done, one muted sentence says that the agent reports when the task is complete.

| Check result | Color | Glyph |
| --- | --- | --- |
| Passed, Holds now | Green | Tick |
| Did not pass | Error | Cross |
| Not verified | Muted | Ring |
| Any other result | Muted | Ring |

The **Run** panel holds these parts:

- **Planned** and **Observed** as rows with an 88px label column.
- Observed shows the model in the data font over a muted “Latest recorded for the main agent”.
- Observed is amber when it differs, and its line ends with “differs from planned”.

The Feature aside holds these parts:

- The feature name as an ink Text link. It is a [feature link](#feature-link) to the feature the board holds the task in.
- The data-font “n of m done”.
- **Same step as this session** and **Next** rows.
- While the queue is blocked, one error-colored note.

Each row of the aside shows the ID, a title, and its chip. The title is clamped to two lines and linked to that task's session or the board. The whole title is its tooltip.

## Samples

`/design-system` renders these parts from synthetic tasks:

- The cards in every state.
- Column headers.
- Lanes: the first lane with its + New task forced visible, an empty lane, and a lane in the drop-target state.
- The Ready lane with its step groups, and a card outside Ready in a parallel step.
- The Ready lane with a step target and with the new-step zone, and a card with its Move to step select.
- The feature filter and the capacity strip, with the strip's Board form.
- Whole boards in their browser and desktop forms.
- Under **Queue controls**: the queue switch (off, on, busy), the banner (blocked, paused, browser), and the Queue settings panel (desktop app, browser).
- Under **Start gates and schedule**: the Start gates and Schedule sections in each state.
- The Sessions list Task cell.
- Under **Assigned sessions**: the card's sessions line, the Task modal's Sessions block, and the Task cell of an assigned session.

The session header meta and the Task tab read the board through the task store. This page specifies them, and `/design-system` does not render them.

The Tasks home reads its summary through its own store. This page specifies it, and `/design-system` does not render it.
