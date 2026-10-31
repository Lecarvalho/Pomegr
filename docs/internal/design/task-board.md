# Task board design

> Scope: the Tasks home, the Tasks page (page header, Board, Queue settings panel with its Start gates, Schedule, and blocking-rule sections), the task card and its chips, and the session surfaces for a task session.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/components/tasks/` (the Tasks home is `TasksHome.tsx` and the `TasksOverview*` files), `app/styles/tasks.css`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

The Tasks page draws committed board facts. The task modal and the task fields are in [task-modal.md](task-modal.md). The data, queue, and gate rules are in [Tasks](../architecture/tasks.md).

## Declared reworks

- Existing task windows show a quiet **Reworks** row in the settings list.
- Each declaration uses the neutral shared chip, such as **Reworks #336 · missed wiring**.
- Desktop and paired owners add a reference and select its cause with the existing field, select, and Secondary action.
- The current task is always the fix.
- Each declaration has a Quiet **Remove** action for desktop and paired owners.
- Same-computer browsers show declarations without mutation controls.
- A failed mutation keeps the reference and shows a fixed error below the controls.

## Tasks home

### Layout

- The route is `/tasks` with no `repository` parameter. The rail and the palette open it.
- The page is the Tasks overview: the totals of every board, what waits for the owner, and one card for each board with tasks.
- The overview is a composition of the existing chips, the shared [switch](../../../DESIGN.md#switch), and the tokens. It adds no button role and no shared control.
- The header is `CommandPageHeader` with the h1 **Tasks** and the muted description “What waits for you, then every repository's board at a glance.”
- The header ends with the [totals](#header-totals).
- The page holds two blocks in order: **Needs you**, then **Boards**.
- Each block fades in once, 60ms after the one before, over 420ms, when the home is first drawn. A poll that changes a count moves nothing. Reduced motion removes the fade.
- Every element draws committed board facts. A state is never shown and then retracted.
- [Task board contract](../architecture/tasks.md#tasks-home) lists the values the page may read. The page reads nothing else.

### Header totals

- The totals are three numbers with a caption each, at the end of the header: **open**, **in review**, and **done**.
- A number is 18px/650 in a tabular figure. Its caption is muted 12px.
- **Open** is every task that is not Done: the Backlog, Ready, In progress, and Review columns. Its number is in ink.
- **In review** is the Review column. Its number is amber.
- **Done** is the Done column. Its number is green.
- Each is summed over the boards that answered and that the repository inventory lists.
- A board that is unavailable adds no count. A muted line under the totals reads “Without n board that is unavailable.”
- With no task on any board, the totals read zero. They are not drawn before the home is ready.
- On phone, the totals sit under the description, at the left edge.

### Needs you

- The card is Home's card: it shares `HomeCard.module.css` and `HomeNeedsYou.module.css` with [Home](home.md#needs-you), and has no hairline between rows.
- It lists the tasks that wait for the owner on any board: Needs review, Stalled, and Blocked by agent. The newest change is first. At most 50 tasks are listed.
- The heading carries no count.
- The rows are in two columns on a wide screen and in one on phone.
- Each row is one link to the task's board, at least 44px tall, with a hover fill and no chip.
- A row shows the amber glyph tile Home draws for the kind (a check for Needs review, a timer for Stalled, a stop for Blocked by agent), then two lines, then a muted 14px chevron.
- The first line is the title (14px, ink, one line with an ellipsis). The second is a muted 12px line: the task ID in the data font, the repository, and the state in amber.
- The title is the session title when the session has one, otherwise the first line of the task text.
- The first line is read after the task's [tags](#tags).
- A first line of only tags lets the next non-empty line lead.
- With no such task, the card reads “Nothing waits for you.”
- When more than 50 tasks wait, a muted closing line reads “Showing the newest 50 of n.”
- A task of a repository that the inventory does not list is not drawn or counted.

### Boards

- The block is a section headed **Boards** (16px/650). The legend of the stage colors sits once at the end of that header, and wraps under the heading on phone.
- The legend has five 8px swatches with the stage names. It is drawn only when a card is.
- A board with at least one task is a card. Cards are in two columns on a wide screen and in one on phone. The board that changed last is first. The rest keep the inventory's order.
- A card has the panel fill, a one-pixel `--command-panel-2` border, the panel radius, and 16px padding. The border takes `--command-line` on hover.
- A card holds, top to bottom: the head, the flow bar, the counts, and the foot.
- The card's heading is the repository name (16px/650). Under it, a muted 12px line reads “n open features” or “No open feature”, then “ · changed” and the relative time of the board's newest task change.
- The card is not a link. Its one link is **Open board →** in the foot.

#### Board queue

- The head ends with the queue: its word, then the shared small switch.
- The word is muted 12px: **Queue off** is muted, **Queue on** is green, **Paused** is amber, and **Blocked by T-n** is in the error color.
- The switch is the shared [Switch](../../../DESIGN.md#switch), small, named “Queue of <repository>”. It is checked in every status but off.
- Pressing it sends the action the Board's [queue switch](#queue-switch) sends, `queue_settings` with `{ on }`, through the same desktop bridge or paired-device route. It asks for no confirmation, as the Board's does not.
- A paired device may use it only while the Board lets it. A client that may not change a board reads the word only, with no switch.
- A client that does not yet know which it is gets no switch, so a switch never appears and goes.
- A paused queue also offers a quiet **Retry** beside the word, which sends the same action with `{ on: true }`, as pressing **On** does on the Board. No other status has it.
- The switch changes only when the committed home says so. It is disabled while the action runs and the home is read again, and it keeps its state when the action fails.
- A failed action adds a fixed error line, “The queue setting could not be changed.”, under the head.

#### Flow bar

- The flow bar is a 10px bar on the raised fill with a 2px gap and the control radius.
- It has one segment for each of the five stages that holds a task, in board order: Backlog, Ready, In progress, Review, Done. A stage with no task has no segment.
- A segment is as wide as its share of the board's tasks, and never under 1.5%. The bar shrinks its segments evenly to fit. A width change moves over 520ms, and never under reduced motion.
- The colors name stages and mean nothing else:

| Stage | Token |
| --- | --- |
| Backlog | `--command-line-strong` |
| Ready | `--command-lavender` |
| In progress | `--command-brand-text` |
| Review | `--command-amber` |
| Done | `--command-green` |

- The bar is an image whose name lists all five counts, such as “243 Backlog, 0 Ready, 1 In progress, 2 Review, 122 Done”.

#### Counts

- Under the bar, five counts sit in five equal columns: the count (18px/650, tabular), and the stage name under it (muted 12px).
- A count of zero is dimmed to 75% of the muted ink and drops to weight 400. A Review count above zero is amber. Any other count is in ink.
- The counts are a description list, so a screen reader reads the stage, then the count.

#### Foot

- The foot sits under a one-pixel `--command-panel-2` rule and holds, in a row: the moving line, then **Open board →**.
- The moving line is one muted 14px line with an ellipsis. It is built only from the five counts and the queue, which are all the Tasks home carries.
- It starts with “n in progress” or “Nothing running”. Then, each only when it holds: “Queue blocked by T-n”, or “Queue paused: <reason>”, then “n in review”, then “n ready to start”. The last appears only while nothing runs and the queue is not blocked or paused. The parts are joined by “ · ”.
- It names no task: the Tasks home carries no title or ID of a task that is running.
- A pulse (an 8px brand dot, 1.8s) leads the line while a task is in progress. Reduced motion removes the pulse and leaves the dot.
- **Open board →** is a link to `/tasks?repository=<repositoryId>`. Its name adds the repository, such as “Open board of Clapline”.

#### Boards with no task

- A repository with no stored board, a board with no task, and a board that is unavailable are not cards. Each is one compact row with a dashed one-pixel `--command-line` border, in two columns on a wide screen and in one on phone.
- A row holds the name (14px, ink), then the muted note **No tasks yet** or **Board unavailable**, then **+ New task** in the brand text.
- **+ New task** is a Quiet action. It opens the same new-task dialog the Board's first lane opens, for that repository, in the desktop app and on a paired device. Any other client, and a client that does not yet know which it is, is not drawn the action.
- The board is read only once the owner asks for the dialog, and the dialog opens when it answers, so its subtitle never changes. When a start after creation fails, the page opens that repository's board.
- A board that is unavailable has no action and reads no count.

### States

| State | Draw |
| --- | --- |
| Loading | Two placeholder blocks with the label **Loading tasks**. |
| Unavailable | A panel notice with a status role. |
| A client that is not on this computer | Only the **Desktop only** notice, and no total. |
| No repository observed | The shared empty state. |

### Phone

- At 760px and narrower, every block is one column: the Needs you rows, the cards, and the compact rows.
- Nothing is wider than the window at 390px.
- A Needs you title may wrap to two lines.
- A card keeps its five counts on one line across, with a 4px gap. A stage name wraps rather than truncates.
- The foot wraps: the moving line takes its own line, and **Open board →** follows it.
- **Open board →**, **Retry**, **+ New task**, and the switch each reach a 44px target. The switch keeps its track and widens its hit area.
- A compact row puts the name on its own line, then the note and the action.
- The page ends with clearance under its last card, so the Aril launcher never covers it.

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
- The card title leaves out the task's [tags](#tags).
- The search still matches the whole stored text, so a tag word finds its task.
- The detail line holds the ID, the column, the chip, and the feature.
- The chip there is the task's state, even where its lane leaves the chip out.
- The next task reads **Queued · next**.
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
- A lane has no fill and no border at rest.
- A lane draws only its header over its rule, and its cards.
- The lane keeps a one-pixel transparent border, so the drop target below shifts nothing.
- The lane has the panel radius, 8px padding, and an 8px gap. Its cards use the panel fill.
- The lane is at least 240px tall.
- Above 760px, the lane is exactly as tall as the window leaves under the page header, gates, and filter. The page itself does not scroll.
- Above 760px, each lane scrolls its own cards under a thin scrollbar. Its header and **+ New task** stay in view.
- While a card is dragged over a lane, the lane takes the raised fill (`--command-panel-2`) and the strong line (`--command-line-strong`) on its border.
- The drop-target border is two pixels wide, drawn as an inset one-pixel ring, in both themes.
- The loading placeholder lanes keep the raised fill and the line. See [States](#states).

### Column header

- The board has five fixed columns: Backlog, Ready, In progress, Review, Done.
- The column header is the name (13px/650, ink) and a data-font count (12px, muted) over a one-pixel `--command-line` rule.
- The column header has no control in the desktop app or a browser.
- Columns are never added, renamed, moved, or deleted.
- The count counts cards. A parallel group of the Ready lane is not counted.

### Ready parallel groups

- Ready is the queue's lane. Its waiting cards start from the top, one at a time, whatever their feature.
- A waiting card is a Queued or Scheduled card with no session. Any other card of Ready is a plain board card where it is.
- A waiting card of Ready is the compact card (`.taskReadyCard`): the board card at 10px/12px padding with a 6px gap.
- A compact card shows the same parts as any card. See [Task card](#task-card).
- A **parallel group** (`.taskReadyGroup`) is drawn in Backlog and Ready only. It holds the cards that share one group, have not started, and sit together.
- In Backlog a group is a plan: its cards are Not queued and keep their full card. The frame, caption, and count are the same as in Ready.
- A Not queued card of Ready is a planned card too: it is drawn in its group's frame like a waiting card.
- Only the owner makes a group. Two cards that sit next to each other draw no frame and run one after the other.
- A group may hold cards of different features and cards with no feature.
- The frame is a one-pixel `--command-line` border with the panel radius, 6px padding, a 6px gap, and no fill.
- The grouping reads only the lane's card order and each task's group. It reorders no card and stores no value.
- A card that has started, between two cards of one group, splits the frame into two.
- The caption (`.taskReadyCaption`) is the first row, with 2px/4px padding and its two parts at the ends. It wraps when narrow.
- The left part is the parallel glyph, a 4px gap, and “Parallel · n” (11px/500, ink), with the count in the data font.
- The count is the number of members that have not started. A member that started is not counted.
- When members started, the left part adds “ · T-4 and T-5 started” (11px/400, muted), with the IDs in the data font, by number.
- The parallel glyph is 12px: two vertical 1.5px strokes in the current color. It is hidden from assistive technology.
- The card the monitor names as next keeps the chip **Next**: a waiting card of the group that runs, otherwise the top waiting card.
- A waiting card adds one muted 12px wait line (`.taskCardWaiting`) from the monitor's reading of why it has not started.
- The line of a card past the first place opens with its place in the start order, such as “5th in queue”.
- Then comes “Waiting: ” and one clause for each reason, joined by “; ”. A place and a reason are joined by “ · ”.
- A clause names at most three task IDs and then “and n more”.
- A card behind the cards above it reads “3rd in queue · Waiting: earlier tasks start first (T-2, T-3)”.
- A card behind a running task reads “Waiting: T-n is running”.
- A card that runs after an unfinished task reads “Waiting: runs after T-21, which is not done”. It has no place in the order, so its line has no place.
- The cards of a card's own group are never named as ahead of it or as running before it.
- A held member of a group whose siblings started ends its line “ · T-4 started”.
- A queue that is off reads “the queue is off”. A blocked or paused queue names its task: “the queue is blocked by T-2”, “the queue is paused at T-3”.
- A held gate reads as on the Start gates section, and a missing reading reads “not known yet”. It never reads as passed.
- A reason the monitor cannot name reads “the reason is not known yet”.
- The line has no tone: it is muted for every reason, and the Queue status banner carries a blocked or paused queue.
- A scheduled card's own time is its Starts line. The wait line does not repeat it.
- The next card with no known hold draws no wait line. Its chip says that it is next.
- A board that sends no waits keeps the earlier line: “Waiting: …” on the next card while a gate holds it and the queue is on.
- The drop line and the move toolbar work on a card of a group as on any card.
- The owner changes a group in the desktop app or on a paired device. See [Parallel groups](#parallel-groups).

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
- The options carry the task count in parentheses. **All** is first, then the open features, then **No feature**.
- Done features follow **No feature**, last, as muted options whose accessible name ends in “done”.
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
- While a feature is selected, the row shows its progress (`.taskFeatureProgress`), in any client: muted 12px “0 of 7 tasks done · 2 running”.
- The counts of that line use the data font and ink.
- The running clause counts the feature's tasks that have a session and no outcome. With no such task, the line is the done count only.
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
- In the desktop app only, **Scorecard** comes just before **Queue settings**, in the same Quiet role. It opens the [Scorecard panel](#scorecard-panel).
- In the desktop app and on a paired device, **Log** comes before **Scorecard** when present, otherwise before **Queue settings**, in the same Quiet role and sizes, with `aria-haspopup="dialog"`, and opens the [Task log panel](#task-log-panel).
- Every client showing the board has **Aril settings** immediately before **Log**, when present. It is a link in the same Quiet role, sizes, and underline, with no `aria-haspopup`, and it opens the [Aril section of Settings](settings.md#aril) for the board's repository. The Board has no Aril dialog.
- **Queue settings** (`.taskQueueSettingsAction`) is last in the strip, in any client. It is the [Quiet](../../../DESIGN.md#buttons) role, 32px high, 12px/500 ink, underlined.
- It is 44px high on phone and coarse pointers.
- It has `aria-haspopup="dialog"` and opens the [Queue settings panel](#queue-settings-panel).
- A board that sends no gates draws the available panel actions without capacity readings.

### States

| State | Draw |
| --- | --- |
| Loading | Five placeholder lanes. Each lane frame holds a 40% title bar and a 64px card block. |
| Unavailable | A panel notice with a status role. |
| No task | The muted “No tasks on this board yet.” is added. |

## Task card

### Layout

- The card (`.taskCard`) has the panel fill, a one-pixel transparent border, a 6px radius, 12px padding, and a 6px gap.
- The card draws these parts in order: the meta row, the title, the tags, the run line, and its other lines.
- Each part shows only when it is set.
- The card draws no excerpt of the rest of the task text.
- The card draws no **Complete when** line, because the task modal shows it.
- The meta row (`.taskCardTop`) is at least 20px tall, with a 6px gap.
- The meta row wraps.
- When the ID, the issue chip, the feature name, and the state chip do not fit one line, the state chip moves to a second line, at the end.
- The feature name keeps at least 64px on the first line, so the state chip wraps before the name is cut shorter.
- The meta row starts with the task ID (data font, 12px, muted).
- The issue chip follows the ID when the task has a source.
- The feature name follows as `· Feature name` (`.taskCardFeature`): 12px, muted, on one line with an ellipsis.
- The whole feature name is the tooltip of that part.
- The dot is hidden from assistive technology.
- The state chip ends the row when the board draws it. See [State chip on a card](#state-chip-on-a-card).
- The title is 13px/500 ink, clamped to three lines.
- The title is the first sentence of the first line of the task text until its session has a title. The split is a heuristic.
- The first line is read after the task's [tags](#tags).
- A first line of one sentence is the whole title, and a Markdown heading mark is left out.
- A backtick span in the title is drawn in the data font, without its backticks.
- The tooltip of the title is the task text from its title line on, or the session title.
- The tooltip never starts with a blank line.
- A Done card's title is muted.
- In the desktop app, the title is the Quiet role drawn as plain title text, with no underline and no fill on hover or press. It opens the task modal.
- A click anywhere on a card that opens, except on another control of the card, opens the task modal too. Focus returns to the title.
- A card that opens shows the pointer cursor.

### Tags

- The tags are the run of tokens at the very start of the task text.
- A token is `[`, optional spaces, a word, optional spaces, and `]`.
- A word has 1 to 24 letters, digits, `.`, `_`, or `-`.
- A word starts with a letter or a digit.
- Any whitespace separates the tokens, line breaks included.
- Leading lines that hold only tags all join the run.
- A token that touches other text ends the run.
- Blank lines between tokens do not end the run, so the tokens at the start of the title line are always tags.
- A body paragraph that starts with a bracket, such as “[TODO] write tests” below a tags line, has that token as a tag.
- The run starts at the very start of the text, after any whitespace that is not a line break.
- The run stops at the first thing that is not a token.
- Brackets anywhere else stay text.
- A run holds at most 8 tags.
- A repeated word is dropped, and the comparison ignores case.
- The first spelling of a repeated word stays.
- The word `image` is never a tag, so the `[image]` marker of an inline image stays text.
- The run is removed from the title.
- The first text after the run leads, so lines of only tags at the start never lead.
- A blank line never leads, also one that holds only spaces or a Windows line break.
- The first non-empty line after the run is the title line.
- A leading Markdown heading mark (`#` to `######` and a space) is left out of the title line on every surface.
- A text of only tags keeps them as its title, its lines joined on one line, and draws no chips.
- The rich Task field is the exception: it draws the tags of such a text as chips over an empty title line, see [task-modal.md](task-modal.md#tags-in-rich-text).
- Tags are display only.
- The stored task text keeps its brackets.
- No stored field or request shape changes because of a tag.
- The tag split is a display heuristic, like the title split.
- The tag split is not a stored field and not a judgment.
- The parser is `splitTaskTags` in `app/components/tasks/task-tags.ts`.
- The Tasks home title uses its server twin in `server/tasks/task-tags.mjs`.
- The title rule is `splitTaskTitle` in the same files.
- The title rule returns the tags, the title line, and the rest.
- A parity test runs the same cases against both parsers and both title rules.
- Every surface that names a task by its title uses the title without tags: the card, the search result, the feature task list, the Runs after rows, the related rows and the lead line of the Task tab, the read view of a started task, and the Tasks home.
- The Aril chat shows the first line as stored.
- A card draws its tags as one wrapping row (`.taskTags`) under the title, with a 4px gap.
- The row shows only when the task has tags.
- A tag is the shared neutral [`.commandChip`](../../../DESIGN.md#chips) (`.taskTag`): muted text, no tone, and no color for each tag.
- The row is a group named Tags.
- A card with a session title draws its tags too.

### Content

Each row below the tags shows only when it is set, in this order:

- The run line (`.taskCardPlanned`) is the planned “model · effort” in the data font, 11px, muted.
- The run line has no provider badge, because a model names its provider.
- When the model is the provider's default, the run line leads with the provider's name, such as “Claude Code · medium”.
- The muted **Observed model:** line.
- After the model lines, the muted **Observed effort:** line shows the primary agent's reported effort when no planned effort differs.
- When the planned and observed effort differ, the amber line “Planned effort x, observed y” replaces the observed effort line; neither line appears without observed effort.
- When the planned model and the observed model differ, the single amber line “Planned x, observed y”. It is a text color, never a fill.
- The muted **Starts** line of a scheduled task, until its session is linked. It reads “Starts today 22:00”, or “Starts Oct 9, 22:00” on another day, with the time in the data font.
- The muted wait line of a waiting card. See [Ready parallel groups](#ready-parallel-groups).
- A card that is not waiting in the queue and runs after an unfinished task adds one muted 12px line (`.taskCardWaiting.taskCardAfter`), “Runs after T-13 and T-14”, before the sessions line.
- The line names only the tasks that are not Done. A card whose tasks are all Done draws no line.
- The sessions line: **Open session**, a Text link that is not stretched, for the first session.
- A started task without a bound session shows **Waiting in terminal** as a Text link to its Terminal start view.
- A queue start never navigates to the Terminal tab or changes the selected page.
- **Open session** is muted 12px text with a 12px arrow-up-right glyph.
- The glyph is hidden from assistive technology.
- **Open session** turns ink on hover, with no underline.
- **Open session** never takes the brand link color.
- The first session is the one Pomegr started, or else the first assigned session.
- When the task has more sessions, the muted “+N more” follows the link.
- When Pomegr started none, the muted word “Assigned” ends the line.
- The line is 12px text in a wrapping row with an 8px gap.

### States

- The border is the only colored chrome of a card.
- At rest the border is transparent, so a border that appears shifts nothing.
- A card that opens shows the `--command-line` border on hover and on focus within.
- The border turns green while the bound session works.
- An assigned session never changes the chip or the border.
- The border turns amber for Needs review, Stalled, Blocked by agent, and Needs input.
- Needs input is the bound session's state, which the card borrows. See [State chips](#state-chips).
- The green and amber borders stay while the card is hovered.
- The border follows the state whether or not the lane leaves the chip out.

## State chips

- A state chip is the shared [`.commandChip`](../../../DESIGN.md#chips) outline label. A tone recolors only the text.

| State | Tone and notes |
| --- | --- |
| Not queued | Neutral and muted. |
| Queued | Neutral, in ink on the raised fill, with no border. It differs from Not queued. |
| **Queued · next** | The label of the one task the monitor names as next, on every surface but the board. |
| **Next** | The board's label for that task. |
| Scheduled | Info. The card's Starts line carries its time. |
| Needs review | Warning. |
| Stalled | Warning. |
| Blocked by agent | Warning. |
| Done | Neutral. |

- While a session is bound and the task has no outcome, the chip is the session's own state. It uses the Sessions list words and tones.
- In that case, In progress is positive, Needs input is warning, and the rest are neutral.
- There is no Running task state.
- A session state that the monitor has not committed leaves the task's own chip.

### State chip on a card

- A card on the board draws its state chip only when its lane does not already say that state.
- The rule compares the chip's words with the lane's.
- Backlog says Not queued, Ready says Queued, In progress says In progress, Review says Needs review, and Done says Done.
- The lane is the column's role: In progress, Review, or Done.
- The first column is Backlog and the second is Ready.
- A card without a known lane always draws its chip.
- The border of the card follows the state whether or not the chip is drawn.

| Lane | No chip for | Chip for |
| --- | --- | --- |
| Backlog | Not queued | Every other state |
| Ready | Queued, when the card is not next | **Next**, Scheduled, Not queued, and every other state |
| In progress | The borrowed session state In progress | Needs input, Idle, Open, Stopped, Closed, and every task state |
| Review | Needs review | Stalled, Blocked by agent, and every other state |
| Done | Done | Every other state |

- **Next** replaces **Queued · next** on the board only.
- The task modal header and the feature task list keep **Queued · next**.
- A queued card with no chip relies on the lane order and on its wait line.

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
- Dropping or moving a card into Done accepts its task and shows the Done chip, including a move within Done.
- On the desktop, a move into Done first asks which sessions Pomegr started for the task still work, and the card stays where it is until that is answered.
- With a session working, the board draws the question above the capacity strip, below any failure line: “Its session is still working. End it?”
- The question is the same group as the modal's: a Secondary **End session** and a Quiet **Keep it running**, which has the focus. Both answers move the card; only **End session** ends the working session.
- **Mark done and resume** in the Queue banner asks the same question. One question is open at a time, and a later Done action waits for the answer.
- With no session working, the card moves at once and its idle sessions end. A browser or paired device draws no question.
- Other column moves preserve the task state. Moving a Done card elsewhere does not reopen it.

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

### Parallel groups

- The owner puts cards of Backlog or Ready that have not started in a parallel group, and takes them out, in the desktop app or on a paired device.
- **Run in parallel** (`.taskReadyLinkAction`) is one [Quiet](../../../DESIGN.md#buttons) action in the gap between two cards that have not started, or groups, that sit next to each other in Backlog or Ready.
- It has the parallel glyph and the label, 11px ink on the panel fill, with a one-pixel `--command-line-strong` border and the panel radius. It is 20px tall.
- It takes no room of its own (`.taskReadyLink`). It is invisible (opacity 0, never `display: none`, so it stays keyboard-reachable) until the lane is hovered or the action holds focus.
- On a coarse pointer and at 760px and narrower it is always visible, 44px tall, in a row of its own.
- Pressing it puts the cards of both sides in one group: the group one side already has, the upper side's first, or a new one.
- It is not drawn beside a card that has started, or when both sides together would hold more than 16 tasks.
- Its accessible name is “Run T-4 and T-5 in parallel”.
- While a card that has not started is dragged over a group it is not in, the group (`.taskReadyGroup.isJoinTarget`) takes the panel fill.
- That group also takes a two-pixel border, drawn as an inset one-pixel ring, in `--command-line-strong`.
- Dropping the card on the group puts it in that group, after the group's last waiting card. No drop line is drawn over a join target.
- A card that has started never joins a group. Over a group it draws the drop line of a card move.
- Dragging a card of a group and dropping it outside the group's frame takes it out of the group. It lands where the drop line is.
- Dropping it inside its own frame reorders it in the group.
- The frame of a group is draggable from its caption and its padding. The whole group then moves as one block, also from Backlog to Ready.
- A group with a queued card cannot be dragged out of Ready.
- The caption's toolbar (`.taskReadyActions`) holds two [Icon](../../../DESIGN.md#buttons) arrows, “Move the group up” and “Move the group down”, and the Quiet **Ungroup**.
- The toolbar sits at the end of the caption row.
- The toolbar is invisible (opacity 0, never `display: none`, so it stays keyboard-reachable) until the group is hovered or holds focus.
- The toolbar is always visible on a coarse pointer and at 760px and narrower.
- Its actions are 44px high there.
- The toolbar has no transition.
- An arrow moves the group past the card, or the whole group, beside it. An arrow that cannot move is disabled.
- A group with a Not queued card adds the Quiet **Queue group** (`.taskReadyQueue`) before **Ungroup**.
- **Queue group** queues every Not queued card of the group. The group's cards move to the end of Ready in the order they had.
- Queueing one card of a group from its Task modal brings the group's other cards to Ready beside it. They stay Not queued.
- **Ungroup** (`.taskReadyUngroup`) takes every card of the group out of it. The cards keep their places.
- The move toolbar of a waiting card of a group gains the Quiet **Take out of group** (`.taskMoveLeave`) after the four arrows.
- **Take out of group** takes that card out. Its accessible name is “Take T-n out of its parallel group”.
- A card taken out keeps its place. A card that stood between two cards that stay in the group lands right after the group.
- **Queue group**, **Ungroup**, and **Take out of group** are 32px high with 12px underlined ink. They are 44px high on phone and coarse pointers.
- The up and down arrows of a card step inside its group. At the group's edge they take the card out, past the card or group beside it.
- The up and down arrows of a card outside a group step past a whole group.
- A group left with one card is no group: its frame goes.
- Nothing moves while a feature filter is on. No group changes then, and no **Run in parallel** is drawn.
- After a change, a status line reads “T-4 and T-5 run in parallel.”, “T-4 taken out of its parallel group.”, “T-4 and T-5 no longer run in parallel.”, or “T-4 and T-5 added to the queue with their parallel group.”

### Runs after

- The move toolbar of a card that has not started ends with the Quiet **Runs after…** (`.taskMoveLeave.taskMoveAfter`), after **Take out of group**.
- **Runs after…** is 32px high with 12px underlined ink, 44px high on phone and coarse pointers. It has `aria-haspopup="dialog"`.
- Its accessible name is “Choose what T-n runs after”.
- It opens the Task modal with focus on the Runs after select. See [Task modal design](task-modal.md#body-a-task-that-has-not-started).
- A browser on the same computer draws the Runs after line and no action.
- A browser on the same computer draws the frames and captions and no action.

### Copy

- A muted 12px footnote under the board reads “Drag a card to move it. Ready starts from the top, one card at a time. To run cards together, in Backlog or Ready, choose Run in parallel between them or drop a card on a group. Drag a card out of a group to take it out.”

## Queue

### Queue switch

- The queue switch is a two-way [Segmented](../../../DESIGN.md#buttons) control (Off, On) named Queue.
- A muted Queue eyebrow comes before it.
- The Tasks home carries the same queue on each board card as the shared small [Switch](../../../DESIGN.md#switch), with the same action and the same rules. See [Board queue](#board-queue).
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
- **Mark done and resume** and **Requeue T-n** show for a stalled or blocked task, or a task in Review with an unresolved earlier block.
- For a task in Review that still holds the queue, the banner states that the latest report is complete and an earlier block needs resolution.

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

### Aril settings section

- The section lives in Settings (`app/settings/ArilSettings.tsx`); its cards and states are in [Settings design](settings.md#aril). It was the Queue settings side panel opened from the Board until 2026-10-29.
- A grant's own sections (**Grant**, **Actions under a grant**, **Limits**, **Work rules**) left it on 2026-10-30. Phase 5 of the [Aril agent plan](../plans/aril-agent.md) replaces grants with agreements. The grant runtime is unchanged, and a grant that is still running keeps one line in the section with its end time and **Stop grant**.
- While a grant is active, the capacity strip shows “Aril grant until HH:MM” as muted caption-size text immediately before **Aril settings**, with no button behavior.
- The Board keeps one quiet **Aril settings** link to the section for the board's repository, in its capacity strip. The link opens the memory at that repository's tab.
- The design-system samples of the section are in [Settings design](settings.md#samples).

### Scorecard panel

- **Rework rate** (S8) follows First-pass acceptance with the same current percentage, sample, and baseline row pattern; the pending rows stay unchanged.
- Its caption reads “Merged tasks sent back, failed a review, requeued, or named by a rework link. Lower is better.”
- Only the desktop app draws **Scorecard**. Like the other desktop-only actions, it is decided at first render.
- The panel is the Queue settings side panel: the same frame, width, head, close button, and focus rules. Focus returns to **Scorecard**.
- It reads the scorecard once, when it opens, through the desktop bridge. Reopening it reads again.
- While it reads, it says “Reading the scorecard…”. A failed or malformed read says “The scorecard could not be read.” as an alert.
- A muted caption says the values are heuristic proxies from this board's Done tasks and that a dash means not measured yet.
- A caption-style column head reads **Now · version** and **Baseline · version**, or **Baseline · none yet**.
- Each row holds the measure's ID and name, its one-line definition, the value now with its sample (“n 8”), and the baseline value.
- S1 has two rows: owner turns after Review and Review to Done. S2 is first-pass acceptance.
- Values use the data font. A sample uses the caption size in the muted color.
- A measured row with no merged task says “No data”, never 0. A row with no source yet shows a dash in both columns and says which gap will measure it.
- No value carries a good or bad color: every measure is a heuristic proxy.
- The closing caption names when and in which version the baseline was saved, or says that this version's values become the baseline. It ends with “Scorecard values stay on this computer.”
- [Metrics](../architecture/metrics.md) defines the measures, and [Tasks](../architecture/tasks.md) owns the snapshots and their privacy rules.

### Task log panel

- The desktop app and a paired device draw **Log** when their access is known; an absent or unknown client never draws a temporary action.
- The panel uses the Queue settings side panel frame, with the title **Task log** and a close button.
- Closing the panel returns focus to **Log**.
- It reads once on opening through the desktop bridge or the paired-device log route; reopening reads again.
- Viewing never acknowledges entries or moves Aril's cursor.
- While reading, it says “Reading the task log…”.
- A failed or malformed read says “The task log could not be read.” as an alert.
- The muted caption reads “Task starts, reports, stalls, CI results, and merges on this board, newest first. Aril reads the entries after its last answer.”
- Entries appear newest first, one row each, with local time, task ID, event label, and muted “PR #n” when set.
- A usage pause or resume has no task ID and adds the provider ID to its label, as “Paused for provider usage (codex)”.
- Time and task and PR identifiers use the data font.
- Today's times use HH:MM; older entries use the existing short date and time format.
- Labels are Started, Assigned to a session, Reported complete, Blocked, Requeued, Marked done, Session ended without a report, Session working again, CI passed, CI failed, Merged, Review started, Review passed, Review failed, Started by Aril under a grant, Review started by Aril under a grant, Sent back by Aril under a grant, Merged by Aril under a grant, Merge refused, Auto-merge enabled by Aril, Branch deleted by Aril, Branch delete refused, Written by Aril from a plan, Paused for provider usage, and Resumed after provider usage.
- A thin divider row says “Aril has read up to here” after the newest entry at or below the cursor, only when entries appear both above and at or below the cursor.
- No row carries a good or bad color, including CI failed.
- An empty log says “Nothing logged yet.”.
- When older entries exist, the closing caption says “Showing the newest 200 entries.”.
- In the desktop app, the panel ends with “The task log stays on this computer.”.
- On a paired device, the panel ends with “The task log stays on the computer that runs Pomegr.”.

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
- The task modal's **Start at** row uses it for a task's own start time.
- In that row the field is compact: 32px high on a fine pointer, 44px on a coarse pointer and at 760px and narrower, about 220px wide, and never wider than the row's value. See [Start at](task-modal.md#start-at).

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
- Under them is a muted 12px feature-name line (“Tasks”). Under a Feature group header, there is no feature line.
- For a task promoted from a GitHub issue, the number follows the ID as plain muted `--text-xs` data-font text (“#128”, no chip, border, icon, or link).
- The ID stays the one prominent identifier.
- Assistive technology reads “GitHub issue #128”.
- The issue number sits before the outcome chip.
- A review session Pomegr started shows the task it reviewed in the same form with the muted word “Review”, after the review ends too.
- A session that is assigned to one task, and started for none, shows that task in the same form with the muted word “Assigned”.
- Any other assigned tasks are one line: the muted word “Assigned”, then each task ID as a Text link to its board.
- That line has no chip and no feature line, and it follows the started task.
- A session with no task shows an em dash.
- One muted footnote under the table explains the column.
- Grouping by **Feature** is the fourth Group by option. It lists only sessions started for a feature's task.

### Session header meta

- The meta row adds **Task**, with the ID as a Text link to the Task tab. On that tab, the ID is plain ink text.
- For a review session, the label is **Review** instead of **Task**.
- It then adds **Feature**, with the name as a [feature link](#feature-link), and nothing after it.
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
- **Running with this session** rows: the other tasks of this session's parallel group that are in the queue. With no group, the block is not drawn.
- A **Next** row: the first task of the queue that belongs to this feature, when there is one.
- While the queue is blocked, one error-colored note.

Each row of the aside shows the ID, a title, and its chip. The title is clamped to two lines and linked to that task's session or the board. The whole title is its tooltip.

## Samples

`/design-system` renders these parts from synthetic tasks:

- One card for each state a lane can draw, with the chip each lane leaves out.
- Cards with tags and with a long text.
- A card promoted from a GitHub issue with an attention chip, in a lane of the narrowest width, where the chip wraps to a second line.
- Column headers.
- Lanes: the first lane with its + New task forced visible, an empty lane, and a lane in the drop-target state.
- The Ready lane with a parallel group and the wait line of each waiting card, in its browser and desktop forms, the group at rest, and a card outside Ready with its feature name.
- The Ready lane with a join target and with a held member, and a card with its Take out of group action.
- Under **Planning and runs after**: the Backlog lane with a plan, in its browser and desktop forms, the Ready lane with a card that runs after an unfinished task, and a card with its Runs after… action.
- The feature filter and the capacity strip, with the strip's Board form.
- Whole boards in their browser and desktop forms.
- Under **Queue controls**: the queue switch (off, on, busy), the banner (blocked, paused, browser), and the Queue settings panel (desktop app, browser).
- Under **Start gates and schedule**: the Start gates and Schedule sections in each state.
- Under **Scorecard**: the capacity strip with **Scorecard**, a desktop board with it, and the panel for a later version, the first version, no Done task yet, reading, and a failed read.
- Under **Scorecard**: the strip with **Log**, and task log panels with entries and the Aril divider, empty, reading, failed, more, and the paired-device caption.
- The Sessions list Task cell.
- Under **Assigned sessions**: the card's sessions line, the Task modal's Sessions block, and the Task cell of an assigned session.
- Under **Terminal start**: the manual start view before binding and an unbound task card with its **Waiting in terminal** link.

The session header meta and the Task tab read the board through the task store. This page specifies them, and `/design-system` does not render them.

The Tasks home reads its summary through its own store. This page specifies it, and `/design-system` does not render it. It adds no shared control: its queue is the shared Switch, which `/design-system` renders, and its flow bar and counts belong to the board card only.
