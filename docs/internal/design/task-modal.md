# Task modal design

> Scope: the task modal in modes new, edit, and promote, its frame, the shared task fields, the Feature modal, and the Promote issues page.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/components/tasks/`, `app/styles/`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

One task modal serves three modes, and the Feature modal uses its frame for a fourth form. The board and the cards are in [task-board.md](task-board.md). Board data, queue, dispatch, and privacy are in [Tasks](../architecture/tasks.md).

## Frame

`TaskModalFrame` (`app/components/tasks/TaskModalFrame.tsx`) is the shared frame of the one task modal, in the modes described below.

### Layout

- The frame is a native modal `<dialog>` that fills the viewport and is itself the scrim.
- The scrim is `--color-text` mixed to 40% over the page with `color-mix`, and uses no literal color.
- The scrim has no token of its own and is distinct from the Home dialog's `#0008`.
- The dialog's padding (32px above, 24px below, 16px at the sides) is the margin the panel keeps from the window.
- The panel sits in the dialog and is at most 640px wide.
- The panel is never taller than the window less that margin.
- The Task field keeps the height of its full text.
- The body scrolls when its content exceeds the available height, keeping the header and footer actions reachable.
- The panel has the panel fill, a one-pixel `--command-line` border, the panel radius, and the overlay shadow.
- The panel has no entrance or exit motion.
- The panel is centred in the window.
- The header (`.taskModalHeader`) has 8px/12px/8px/24px padding and a one-pixel rule.
- The title group (`.taskModalTitleGroup`) holds the 16px/650 `h2` that names the dialog and an optional extra.
- The optional extra is the task form's data-font task ID and state chip.
- The subtitle (`.taskModalSubtitle`) is muted 12px text, takes the remaining width, and truncates.
- In modes new and promote the subtitle reads “repository · in column”.
- In mode edit the subtitle reads the repository name alone, because the state chip already says where the task stands.
- The header ends with the [Icon](../../../DESIGN.md#buttons)-role **Close**.
- The body (`.taskModalBody`) is a 16px-gap column with 24px padding.
- The Review panel, the Task read view, and the Run settings are sections of the body: each sits 24px below the block above it.
- The footer bar (`.taskModalFooter`) has a one-pixel top rule, no fill, 12px/24px padding, and an 8px gap, and it wraps.
- `.taskModalSpacer` pushes the actions to the end.
- `.taskModalNotes` holds the notes of a task in mode edit.
- `.taskModalNotes` shares the footer row with the actions and takes the width they leave, at least 160px.
- `.taskModalResolve` is a full-width row at the top of the Feature modal's footer.
- `.taskModalNote` is quiet 12px text.
- Footer actions keep their roles and are never stretched.
- Footer actions are 36px high at 761px and wider with a fine pointer, and 44px otherwise.
- The 36px and 44px heights are local deviations from the role defaults, taken from the task-board design.

### Phone

- At 760px and narrower, the dialog has no scrim padding.
- At 760px and narrower, the panel is full width and full height, with 16px body and footer padding.

### Keyboard and focus

- Focus moves in on open, to the form's first field or to Close.
- Tab stays inside the dialog.
- Escape and Close dismiss the dialog, unless a control inside handled the key first.
- An open list, a feature name being edited, and an open GitHub issue confirmation handle the key first.
- A click on the scrim closes the dialog only while the form holds nothing to save.
- A form that holds nothing to save is an unchanged task, an empty New task, an empty New feature, or an unchanged Feature. The promote form never closes on a scrim click.
- This rule means a stray click never loses typed text.
- The opener takes focus back.
- A `CommandSelect` list opened inside renders inside the dialog.

### Footer actions by mode

| Mode | Footer actions |
| --- | --- |
| New | Quiet **Cancel**, primary **Create task** as a [split action](../../../DESIGN.md#buttons) |
| Edit | Quiet **Delete task**, then the notes and the actions of the task's state; see [Footer](#footer) |
| Promote | Quiet **Cancel**, primary **Promote issue** |
| New feature | Quiet **Cancel**, primary **Create feature** |
| Feature | Quiet **Delete feature**, Secondary **Mark done** or **Reopen**, primary **Save** |

## Task fields

The New task and Task forms share these fields. The Promote form shares all but Task. All fields are optional except Task, Run on, and Effort.

### Run settings

- The Run settings are a 12px/500 muted `h3` **Run settings** over a ruled label/value list (`dl.taskRows`).
- The list holds these rows in order: Feature, Run on, Effort, Remote Control, When done, Complete when, and, in mode edit, GitHub issue.
- Remote Control is a Claude Code row only.
- Mode new and mode promote draw the same rows, without GitHub issue.
- Mode new keeps its own checkbox for that.
- A row (`.taskRow`) is a label (`dt`) and a value (`dd`) in two columns: the label is 148px.
- The label is muted 12px text.
- A label of a control is a real `label` for it.
- A row has a one-pixel `--command-line` rule above it.
- The last row has a rule below it too.
- A row of text is 40px high.
- A row that holds a control is 44px high.
- Beside its value, the label of a row that starts with a control is as high as that control: 44px on a coarse pointer and at 760px and narrower.
- A value that is taller than one line aligns with the label's first line.
- A value that is not set reads in muted text: “No feature”, “Not set”, or “None”.
- At 520px and narrower, a row is one column: the label sits over its value.
- A row that ends with an action (`Create issue…`) holds it at the end of the value column.
- The same rows draw the controls of a task that has not started and the plain values of a task that has. See [Task, read view](#body-a-task-that-has-started).

#### Select as a value

- **Feature** and **Run on** are a `CommandSelect` in the value column.
- The select carries the task-modal modifier `.taskValueSelect`.
- It is the shared select drawn as the value, not a new role in [DESIGN.md](../../../DESIGN.md).
- The trigger has no border and no fill, and its value is 13px/400 text.
- The trigger's text lines up with the other values in the column.
- The chevron stays muted.
- Hover and the open list give the trigger a 6% ink fill.
- The focus ring, the list, the options, and the keyboard follow the shared `CommandSelect`.
- The values “No feature” and “Not set” are muted.
- The trigger is 44px high on a coarse pointer and at 760px and narrower.

### Task

- **Task** is a muted 12px/500 label and a `textarea` at least 150px tall in 13px type.
- The textarea grows with its text and has no resize handle.
- In the task modal, the textarea resizes on load, text changes, and width changes without an internal vertical scrollbar.
- The placeholder is “What should the session do?”.
- A right-aligned muted data-font counter reads “n / 4,000” under the field.

### Rich text and images

- In the desktop app, the Task field of the New task and Task forms is rich text (`TaskRichText`, `.taskRichText`).
- Rich text holds the task's images in the text itself.
- An editable region replaces the textarea.
- The region has the same 150px minimum height and placeholder.
- The editable region has 16px padding on every side.
- The first line of the text is the title line (`.taskRichTitle`).
- The title line is 16px/650 ink with a 1.35 line height.
- The rest of the text is 14px/1.6 ink.
- The title line is one node, not `::first-line`, so a long title keeps its type on every wrapped line.
- The title line is as wide as the field, so the line break after it stays in the text of the next node.
- The title line keeps a 12px gap below it while a line follows it.
- An empty title line keeps one line of height, so the caret has a place after the chips.
- In the task modal, the editable region grows and shrinks with its full text, inline images, and wrapping without an internal scrollbar.
- Outside the modal, the editable region scrolls past 480px.
- The region sits in one frame (`.taskComposer`) with a one-pixel `--command-line-strong` border, the panel radius, and the panel fill.
- The frame shows the focus ring while the editor has keyboard focus.
- Text is typed as plain text.
- A paste or a drop of formatted text keeps its words only.
- The field has no bold, list, or link.
- An image shows inline where it was put (`.taskInlineImage`).
- An inline image is at most the field's width and 180px tall.
- An inline image has a one-pixel `--command-line-strong` border and the control radius.
- An inline image is a 72px square on the ground fill until the image is read.
- Backspace or Delete removes an image like a character.
- A paste or a drop that holds an image puts it at the caret and types nothing.
- The foot of the frame (`.taskImagesHead`) is one strip above a one-pixel `--command-line` rule.
- The foot holds, on one line: the Quiet **Attach image** with a 14px image glyph, the muted hint “or paste one · up to 4, 5 MB each”, and the counter at the end.
- The hint names the image limits.
- The form has no separate helper paragraph about images.
- **Attach image** opens the native file picker and puts the chosen images at the caret.
- **Attach image** is described by the hint.
- An error line (`role="alert"`) sits under the frame.
- The counter counts each image as its marker and turns to the error color past 4,000.
- A task holds at most four images, and **Attach image** is disabled at four.
- An image is part of the text.
- In the New task form, an image is stored once the task exists.
- In the Task form, an image is part of the Save draft like the text.
- **Save** stores the image, and Close discards it.
- A browser keeps the textarea.
- A desktop build without the image bridge keeps the textarea.
- The textarea is plain text.
- The textarea draws no chips, no title line, and no foot strip, and keeps the counter under it.
- Cards, the Search bar, and the session's Task tab show the plain word “[image]” where the text holds one.

### Tags in rich text

- The tag run is the leading run of `[ word ]` tokens at the start of the first line.
- The shared parser (`splitTaskTags` in `app/components/tasks/task-tags.ts`) reads the run.
- The run is a display heuristic.
- The run is not a judgment about the task.
- A tag is display only.
- The text keeps its brackets.
- The editor's title line is the line right after the chips, as typed.
- Every other surface reads the title with `splitTaskTitle`, which skips blank lines and a heading mark.
- The editor's title line does not skip blank lines or a heading mark.
- The field draws the run as chips (`.taskRichTags`) in one wrapping row above the title line.
- The chips row has a 6px gap and 10px below it.
- Each chip is the shared neutral `.commandChip` (`.taskRichChip`).
- A chip has muted 11px text, no tone, and no per-tag color.
- A chip shows the word as typed, with no brackets and no spaces.
- A repeated word is no second chip.
- The chips row is not editable.
- The chips row stays part of the textbox.
- A textbox hides its children from a screen reader, so the tags are also named beside it.
- A visually hidden line (`.srOnly`) beside the textbox reads “Tags: backend, bug”.
- The textbox is described by that line.
- The line is empty while the field has no chip.
- The line follows each conversion and each removal of a chip.
- The row inside the textbox keeps its group name “Tags: backend, bug”.
- A stored text whose lines after the tag run are all blank, such as “[a] [b]”, is drawn as plain text with no chips.
- A card and the read view show that text as a bare title with no chips too.
- A stored text with any other text after the run draws its chips.
- While typing, whole tokens at the very start of the first line become chips when a space, a tab, or a line break follows the last one.
- Typing converts a token of a text that was drawn as plain text too.
- A token at the very end of the text stays text.
- The person may still be typing that token.
- A paste at the start converts every leading token.
- After a conversion the caret stays at the start of the title line.
- Typing inside a line that is already drawn does not touch the nodes and does not move the caret.
- The field changes its nodes only when typing changes where the chips, the title line, and the rest begin.
- It then moves and splits the text nodes the browser made.
- A conversion to a chip draws the field again from new nodes, because the token's text leaves the node the browser typed it into.
- The field also draws its nodes again when a text is set from outside, when Backspace removes the last chip, when undo or redo gives a step back, and when the browser leaves nodes that are not text and images.
- The selection is put back by its character offset only when a change moved it.
- A caret inside a chip goes to the start of the title line.
- While an IME composition is open, the field does not convert or change its nodes.
- The field does both when the composition ends.
- Backspace with the caret at the very start of the title line removes the last chip in one key press.
- Backspace at the start of the title line with no chip works as it does anywhere else.
- The field keeps its own undo history (`RichHistory` in `app/components/tasks/task-rich-history.ts`), because the browser's undo steps name the nodes the field moves and draws again.
- A step is the whole text with the caret, so undo and redo can only give back a text the field has held.
- A step holds the chips as their text, so undo brings a chip back that was removed, and takes a converted chip away.
- Ctrl+Z and Cmd+Z undo.
- Ctrl+Y, Ctrl+Shift+Z, and Cmd+Shift+Z redo.
- A shortcut is matched by the letter its key types.
- On a layout whose key types a letter of another script, the shortcut is matched by the physical key (`KeyZ`, `KeyY`, `KeyA`), so Ctrl+Я undoes on a Russian layout.
- The browser's own undo is not used.
- A context menu's Undo reaches the history, while the browser holds a step of its own to undo.
- A menu's Redo does not reach the history, because the browser's own redo list stays empty.
- Redo is by the keys.
- The desktop app has no Edit menu.
- A run of typing is one step, and so is a run of Backspace and a run of Delete.
- A run ends when the caret goes on from somewhere else, or when the kind of edit changes.
- An Enter, a paste, a cut, a drop, an image, a composition, a removed chip, and a deletion over a select all are one step each.
- Undo puts the caret back where the edit began, and redo puts it where the edit ended.
- An edit after an undo drops the steps that a redo would give back.
- A text set from outside the field starts a new history.
- The history holds at most 200 steps.
- The history holds at most 200 times 4,000 characters in all, and the oldest steps go first.
- A step that undoes nothing is not kept: a run of typing that ends on the text before it leaves no step.
- An edit that leaves the text as it was still ends the steps that a redo would give back.
- A read-only field ignores undo and redo.
- The history of a field that is read-only stays, and works again when the field is editable.
- After an Enter, the field sets the collapsed caret again where it is.
- Without that, the browser's own caret at the end of the title line takes the next typed text, and the text is glued to the title instead of starting the new line.
- A selection covers the chips when it starts before them.
- Ctrl+A and Cmd+A select the whole field, chips included, because the person means everything.
- The field does that itself, because a browser's select all stops at the start of the title line.
- A selection of the title line, or of the title line and all that follows, starts after the chips and keeps them.
- Deleting or retyping such a selection keeps the chips.
- The select all of a context menu is the browser's, and it selects the text without the chips.
- Copy and cut of a selection that covers the chips put the chips' text and the rest on the clipboard, as the stored text.
- The clipboard text leaves out an image, as it does when the browser copies.
- Cut, Delete, Backspace, and typing, pasting, or putting an image over a selection that covers the chips remove the chips with it.
- The value is then empty, the typed text, or the image.
- Undo brings those chips back.
- Copy and cut of a selection inside the text work as the browser does them.
- A line break the browser leaves where the last text of the title was deleted is dropped, when chips lead the line with a title line of their own.
- Deleting the whole title of a task that is only a title leaves its chips and an empty title line.
- A chip serializes to its token as typed, with the spaces and tabs after it.
- The field does not normalize the spacing.
- This exact text keeps the value, the counter, the Save draft, and every API value equal to the text as if the brackets had been typed.
- A repeated token keeps its text inside the chip it repeats, so the text reads back whole.
- Backspace removes a chip and the repeats it holds together.
- When the first line holds only tags, the line break after them belongs to the last chip.
- The next line is then the title line.
- A line break with only blank lines after it is Enter pressed after the tags, and stays with the chips.
- A line break with text after it belongs to the title line when the field already draws a title line under the chips.
- The person who empties a title keeps an empty title line, so the next line stays the next line and typing goes into the title.
- An image marker is never a tag.
- A pasted or attached image never goes before the chips.
- The read view of a started task draws the chips and the title line and edits nothing. See [Task, read view](#body-a-task-that-has-started).
- The Search bar, cards, and every other surface read the same text with `splitTaskTags` and `splitTaskTitle`. See [task-board.md](task-board.md) for the title they draw.

### Feature

- **Feature** is the first row of the Run settings.
- **Feature** is a `CommandSelect` that lists the features that are not done, No feature, and New feature…. A task keeps its own done feature in the list.
- New feature… reveals a one-line name field in place, under the select, in the same value.
- Enter or leaving the name field commits the name.
- Escape cancels the name.
- A feature gives a task context only. The forms have no step or order field.
- Once a created feature is chosen, a folded **In this feature** disclosure appears as the value's second line.
- The disclosure is a native `details` without rules of its own in this row.
- The disclosure summary is 32px high here with a fine pointer at 761px and wider, and 44px otherwise.
- The summary has a muted chevron and a “n tasks · m done” count in data-font numbers.
- The disclosure lists the feature's other tasks.
- Each title is clamped to two lines and has the whole title as its tooltip.

### Run on and Effort

- **Run on** and **Effort** are the next two rows.
- Run on is one `CommandSelect` grouped by provider.
- Run on lists each provider's observed models and a Default model entry.
- Run on has no clear state.
- Effort is a four-way segmented control with the segments Low, Medium, High, and Xhigh.
- The segmented control is 280px wide, with four equal segments.
- A pressed segment of Effort stays pressed when pressed again.
- Both fields are required, and neither can be cleared.
- A new task opens with both chosen: Claude Code, Default model, and Medium on an empty board.
- Only a task stored without them shows Not set in Run on or no pressed segment, until one is chosen.
- An amber notice follows the select inside the Run on value when the observed model differs from the planned one.
- The notice has an amber line, the amber-soft fill, and the words **Observed model differs**.

### Remote Control

- After Effort comes the **Remote Control** row (`.taskRemoteControl`).
- The value is one native checkbox with the muted hint “Open the session on your phone too”.
- The label of the row names the checkbox.
- The checkbox uses the Complete when checkbox row.
- The checkbox is unchecked by default.
- Choosing a Codex entry in Run on clears the choice and removes the row.
- Returning to Claude Code shows the row with the checkbox unchecked.
- A card's run line and the session's Task tab add the plain words “Remote Control” after the effort when it is on.

### When done

- After Remote Control comes the **When done** row (`.taskRemoveWorktree`).
- The value is one native checkbox labelled **Remove worktree and branch**, with the muted hint “Unpushed work is kept”.
- The checkbox uses the same checkbox row.
- The checkbox is checked by default on either provider.
- A new task never takes the choice from the newest task.
- Nothing else shows the choice but the read view of a started task: “Remove worktree and branch” or “Keep worktree and branch”.

### Complete when

- **Complete when** is a row whose value is a group named by its label.
- The value holds a wrapping row of six native checkboxes.
- The checkbox labels are “PR open”, “Tree clean”, “Commit on branch”, “PR merged”, “CI passed”, and “Validated with the user”.
- A checkbox row is 28px high, and 44px at 760px and narrower and on coarse pointers.
- Below the checkboxes sits one 36px text input named Own condition.
- The placeholder is “Own condition, judged by the agent (optional)”.
- A non-blank own condition is the agent-judged condition.
- A blank own condition means no agent-judged condition.
- The own condition has no checkbox.
- “Validated with the user” is agent-judged too.
- A muted helper closes the value: “Pomegr verifies the listed conditions. Validated with the user and your own condition are judged by the agent.”
- The results of the agent's report are in the [Review panel](#body-a-task-that-has-started), not here.

### GitHub issue

- **GitHub issue** is the last row of the Run settings in mode edit, for a task that has not started and for one that has.
- A task promoted from an issue shows the issue chip in the value (`taskIssueChip`), with no caption and no button.
- A task with no source shows “None” in muted text.
- On the desktop, a task with no source also has the Quiet **Create issue…** at the end of the row.
- **Create issue…** is disabled while the draft is unsaved, because the monitor sends the saved text.
- **Create issue…** has no helper paragraph.
- Selecting it opens the confirmation in the value, in place of “None”: a group named “Confirm GitHub issue”.
- The group has the raised fill, a one-pixel `--command-line-strong` border, the control radius, and 12px/16px padding.
- The group holds a 13px/600 line: “Create an issue in {repository}?”.
- The group then lists three muted 12px facts as bullets: “Title: the task's first line. Body: the whole text.”, “Anyone who can see the repository can read it.”, and “Sent once. Later edits here stay here.”
- The group ends with the Secondary **Create issue** and the Quiet **Cancel**.
- **Create issue** is described by the facts.
- Nothing is sent before **Create issue**.
- **Cancel** closes the group and sends nothing.
- Opening the group moves focus to **Cancel**, the action that sends nothing.
- The group is described by its question, so a screen reader reads “Create an issue in {repository}?” with the focus.
- **Cancel** returns focus to **Create issue…**.
- Escape closes the group, returns focus to **Create issue…**, and does not close the dialog.
- While a create runs, the group holds focus, so Escape still reaches it.
- Escape does nothing while a create runs.
- A failed create returns focus to **Cancel**.
- **Create issue** is disabled while the draft is unsaved or while a create runs, and then reads “Creating…”.
- A failure shows one fixed `role="status"` line under the group and keeps the group open, so the action is offered again.
- A failure remembered from the New task flow shows its line under “None” when the modal opens.
- “Save your changes first.” shows under the value while the draft is unsaved, unless the footer already says it.
- On success the board is read again and the row shows the chip.
- The facts keep the meaning of the New task checkbox helper.
- Both say that the text is sent once and that later edits are not sent.
- Both say that the first line is the title and that anyone who can see the repository can read it.
- The first fact is the monitor's own rule: the title is the first line and the body is the whole saved text.
- The first line is therefore in both the title and the body.
- Mode new keeps the **Also create a GitHub issue** checkbox and its helper under the Task field.

## Mode new

- In the desktop app, the first lane's **+ New task** action opens the task modal in mode new.
- The opener has `aria-haspopup="dialog"`.
- The heading is **New task**.
- The subtitle is “repository · in Backlog”, where Backlog is the first column's name.
- Focus starts in the Task field.
- The body holds the Task field with its foot strip.
- The **Also create a GitHub issue** checkbox follows where it is offered.
- Then come the Run settings rows: Feature, Run on, Effort, Remote Control, When done, and Complete when.
- The rows are the [Task fields](#task-fields).
- The footer is a flexible spacer, a Quiet **Cancel**, and the one primary **Create task**.
- **Cancel** closes the modal and writes nothing.
- **Create task** is disabled until the Task field holds text and a new feature has a name.
- **Create task** closes the modal, and the board shows the task in the first column.
- A failure keeps the modal open and keeps what was typed.
- A failure says so under the Task field.
- There is no “create and add another” action.
- There is no footer note.

### Create and queue, create and start

- **Create task** is a [split action](../../../DESIGN.md#buttons). Its caret is named “More ways to create”.
- The menu holds **Create and queue** and **Create and start session**, in that order.
- **Create and queue** has the line “Goes to the end of Ready.”
- **Create and start session** has the line “Opens a new terminal window now.”
- On a paired phone, that line is “Opens a new terminal on the computer running Pomegr.”
- The caret is disabled while **Create task** is disabled.
- Each item creates the task as **Create task** does, and then acts on it.
- **Create and queue** then adds the task to the queue, as **Add to queue** in mode edit does.
- **Create and start session** then starts the task, as **Start session** in mode edit does, with the same confirmation.
- While **Create and start session** runs, the primary reads “Starting…”. Any other running create reads “Creating…”.
- When the follow-up works, the modal closes.
- When the task exists but the follow-up did not happen, the modal becomes the Task modal of that task.
- That Task modal shows why: the queue failure under the Task field, or the start line in the footer with its usual recoveries.
- A start the owner cancels in the confirmation opens the Task modal with no line.
- A task that lost an image or its GitHub issue is not queued or started. Its Task modal opens, as after **Create task**.
- A failed create queues and starts nothing.
- The promote form has no split action.

## Mode edit

A card's title opens the task modal for one stored task. A task that has not started shows its fields as controls. A task that has started shows them read-only, because the session works from the task as it was when it started.

### Header

- The heading is **Task**.
- The header shows the task ID in the data font and the state chip.
- The subtitle is the repository name alone.

### Draft and Save

- Text, Run on, Effort, Complete when, and Feature are a local draft.
- Nothing is sent until **Save**, the one primary of a task that has not started.
- **Save** is disabled until the draft differs from the stored task.
- **Save** is also disabled while the text is empty or a new feature has no name.
- **Save** first creates a new feature when one is being named.
- **Save** then sends one patch that holds only what changed, and closes the modal.
- A failure keeps the draft and says so under the Task field.
- Close and Escape discard the draft without asking.
- While the draft is unsaved, **Start session**, **Add to queue** or **Remove from queue**, **Mark done**, **Requeue task**, and **Create issue…** are disabled.
- While the draft is unsaved, one muted line says “Save your changes first.”.
- A task can start while its modal holds an unsaved draft.
- The modal then drops the draft at once, because the monitor refuses a change to a started task.
- The modal then reads as clean: a click on the scrim closes it, and **Create issue…** is offered.
- One muted footer line says “This task started before your changes were saved.”
- The line goes when the task is requeued.

### Body, a task that has not started

- A task that waits in the queue starts the body with the **Queue** block (`.taskQueueWait`), a group named “Queue”.
- The block shows only for a Queued or Scheduled task that has not started and that the board's waits list.
- The block is a 4px-gap column: the 12px/500 ink label **Queue**, the place line, and the reason list.
- The place line (`.taskQueueWaitPlace`) is 13px ink: “Next to start”, “5th to start”, or “Not in the start order yet” for a scheduled task before its time.
- The reason list (`.taskQueueWaitReasons`) is muted 12px text with a 4px gap, one sentence for each reason, with no bullet.
- A reason names every task ID the board sent, at most eight, and then “and n more”.
- A task behind the cards above it reads “These are above it in Ready and start first: T-66, T-67, T-68, T-69.”
- A task behind running work reads “T-5 is running. The next card starts when that work is in Review or Done.”
- A task that runs after an unfinished task reads “It runs after T-13 and T-14, which are not done. It can start when they are Done.”
- A queue that is off reads “The queue is off, so Pomegr starts no task by itself.” It is not worded as a blocker.
- A blocked queue reads “The queue is blocked by T-2. Nothing starts until that task is resolved.” A paused queue reads “The queue is paused at T-3. Select On to retry.”
- A held gate reads “Start gate: …” in the Start gates words. A queue time reads “Schedule: …”.
- A missing reading reads “not known yet”, and a reason the monitor cannot name reads “The reason is not known yet.”
- A task with no known hold reads “Nothing known holds it. The queue starts it at its next check.”
- The block is text only. It has no tone, no control, and no link, and it changes nothing.
- The **Task** field follows, then the **Run settings** rows with controls in place: Feature, Run on, Effort, Remote Control, When done, Complete when, and GitHub issue.
- The rows are the [Task fields](#task-fields).
- In the Feature row, the folded list leaves out the open task.
- In the Feature row, the rows are in board order, and a row has no step number.
- **Runs after** follows the Run settings.
- Runs after is a fieldset with the 12px/500 legend **Runs after**, built like Sessions.
- Runs after lists one ruled row for each task the task runs after, in the order they were added.
- A row holds the task's title over the muted 12px role “T-13 · Backlog”, with the ID in the data font.
- A row ends with that task's state chip and the Quiet **Remove**. Its accessible name is “Remove T-13”.
- Under the rows is one wrapping row: a select of the board's other tasks that are not Done and not listed, and the Secondary **Add**.
- Each option reads “T-13 · title”. The placeholder is “Choose a task”, or “No other open task on this board” when it has no option.
- With 8 rows the select is disabled and reads “It runs after 8 tasks, the most it can”.
- One muted helper line follows: “This task starts only when every task here is Done or deleted. Pomegr starts and stops nothing for it.”
- A list that would make tasks wait for each other is refused with the one error line “These tasks would wait for each other, so nothing was changed.”
- Any other failure reads “The change could not be saved.”
- Add and Remove save by themselves. They are not part of the draft.
- Opened from the card's **Runs after…**, the select takes focus.
- **Sessions** follows Runs after. It is a fieldset with the 12px/500 legend **Sessions**.
- Sessions lists one ruled row for each session: the session Pomegr started first, then the assigned sessions in the order they were assigned.
- A row holds the session title as a Text link to the session, over the muted 12px role “Started by Pomegr” or “Assigned”.
- A session with no title reads “Untitled session”.
- A row ends with the session's own state chip, in the Sessions list words and tones.
- An assigned row then holds the Quiet **Unassign**. Its accessible name is “Unassign” and the session title.
- The row of the session Pomegr started has no Unassign.
- Under the rows is one wrapping row: a select of sessions and the Secondary **Assign session**.
- The select offers the ten newest sessions of the repository that are not Closed and not on the task. Each option reads “title · state”.
- The select placeholder is “Choose a session”, or “No other session in this repository” when it has no option, and then it is disabled.
- **Assign session** is disabled until a session is chosen.
- One muted helper line follows: “An assigned session can report this task complete or blocked. Pomegr does not start or stop it.”
- A failed assign or unassign shows one error line under the helper.
- Assign and Unassign save by themselves, so they are not part of the draft.
- A task that still waits for a session ends with **Start at**, its own start time.
- **Start at** is a `datetime-local` time field that saves by itself.
- The Schedule design owns the `datetime-local` field. See [task-board.md](task-board.md).

### Body, a task that has started

A task has started when it has a session or an outcome: Needs review, Stalled, Blocked by agent, or Done. The monitor refuses a change to it until it is requeued.

- The body has no Task field, no Save, no Attach image, no counter, and no control in the Run settings.
- The body order is the Review panel, the Task read view, the Run settings as values, Runs after, and Sessions.
- A started task has no Queue block and no Start at.
- The Review panel (`.taskReview`) shows when the task needs the user or has an agent report.
- A task needs the user in the states Needs review, Blocked by agent, and Stalled.
- The panel has the raised fill, the panel radius, 16px padding, and a 12px gap, and no border.
- The panel opens with a 14px/600 heading: **Ready for your review** for Needs review, and the state's own name for Stalled and Blocked by agent.
- A task that is done with a report reads **Agent report**.
- The report line follows the heading as 13px muted text, in the words of the report: “Agent reported complete (time).” or “Agent reported it cannot continue (time).”
- A Stalled task has no report, so its line reads “The session ended with no report.”
- An attention line or a block reason follows the report line in an amber notice: an amber line, the amber-soft fill, and 13px text in the text color.
- The report line ends with a colon when the notice follows, and with a period when it does not.
- The notice reads `**bold**` and `` `inline code` `` in the agent's words.
- A link in the notice stays the characters it was written with, and nothing navigates.
- Inline code in the notice is the data font at 12px on an amber tint.
- When the agent reported, the panel lists each checked condition (`ul`, named “Complete when”), then the own condition, as rows.
- A row is 28px high: a 14px glyph, the condition's label, and its result at the end.
- A result is **Passed** (green, with a check glyph), **Not passed** (error), **Not verified** (muted), or **Agent-reported** (muted).
- **Not verified** means that Pomegr had no current evidence for the condition; it never takes the error color.
- “Validated with the user” and the own condition are agent-judged, so they show **Agent-reported**.
- A condition that is not passed, not verified, or agent-reported has a muted ring glyph in place of the check.
- A task with no report has no list in the panel, because its conditions are the Complete when row of the Run settings.
- A task whose title comes from its session closes the panel with that title and a muted helper that reads “Title from the session · Open session”.
- **Open session** in that helper is a Text link.
- A started task that has no Review panel shows the same session title block first in the body.
- The Task read view (`.taskRead`) is a section named “Task”.
- It opens with a label row: the muted 12px/500 label **Task**, and at the end a 14px lock glyph with the muted 12px line.
- The lock line reads “Started, so read-only. Requeue to edit.” while Requeue is offered.
- The lock line reads “Started, so read-only.” for a task that is done.
- The lock glyph is decorative, and the line is its text.
- The tag chips follow as one wrapping row of the shared neutral `.commandChip` (`.taskTags`, a group named “Tags”).
- A text with no tag draws no row.
- The title follows as a 16px/650 ink `h3`: the first non-empty line of the text after its tags, with no heading mark.
- When the first line holds only tags, the next non-empty line is the title.
- A blank line never leads, also one that holds only spaces or a Windows line break.
- A text of only tags is its own bare title and draws no chips.
- The rest of the text is a document (`.taskDocument`): 14px/1.6 ink in a 14px-gap column.
- Paragraphs split on blank lines.
- Consecutive lines that start with one to three digits, a period or a parenthesis, and a space are an ordered list that starts at the first number.
- A year such as “2026. Then” is a paragraph, not a list.
- Consecutive lines that start with `- ` or `* ` are a bulleted list.
- An indented line goes on with the list item above it.
- Other single line breaks are kept.
- The leading spaces of a body line are kept.
- A list that follows a line with no blank line between them sits 8px closer to it than a paragraph would.
- A `` `code` `` span is data-font text at 12px.
- A UUID and an ISO date or time, with an optional `UTC`, are muted data-font text at 12px.
- Code, UUIDs, and dates are a display heuristic, not a judgment about the task.
- An inline image shows where the text names it, at the sizes of the Task field's inline images (`.taskInlineImage`).
- The image reads “Image n” to assistive technology.
- The text is drawn as React text, never as HTML or Markdown.
- A link or a tag in it stays the characters written.
- The failure line of the modal (`role="alert"`) sits under the read view.
- The Run settings of a started task are the same rows as values: Feature, Run on, Effort, Remote Control, When done, Complete when, and GitHub issue.
- Feature shows the feature's name with the folded **In this feature** list, or the muted “No feature”.
- Run on shows “provider · model”, or the muted “Not set”.
- Effort shows its word, or the muted “Not set”.
- Remote Control shows “On” or “Off”, and only for a task that is not on Codex.
- When done shows “Remove worktree and branch” or “Keep worktree and branch”.
- Complete when shows the checked conditions as one comma list, then the own condition, or the muted “None”.
- The Complete when row is left out when the Review panel lists the conditions with their results.
- GitHub issue is the [row](#github-issue) of the task modal.
- An amber notice follows the Run on value when the observed model differs from the planned one.
- **Runs after** draws its rows only, with no Remove and no select.
- With no row it draws no Runs after block.
- **Sessions** lists its rows, and Assign and Unassign still work on a started task.
- A Done task shows its rows and Unassign, and no select.
- A client that cannot assign draws the rows only.
- A task with no session then draws no Sessions block.

### Footer

- The footer is one row that a narrow window wraps.
- Quiet **Delete task** starts the row.
- **Delete task** swaps in an inline confirmation.
- The confirmation holds a Secondary delete and a Quiet Keep task.
- The confirmation uses no native dialog.
- The notes follow in `.taskModalNotes`, which takes the width the actions leave.
- Without a note, a spacer pushes the actions to the end.
- The notes are the start-status line, “Save your changes first.”, the folder line, and, for a linked task that has not reported, the line that neither exit stops the session.
- A modal whose task started while it held an unsaved draft adds the line “This task started before your changes were saved.”
- Then the actions, in this order: **Open folder**, **Start in separate worktree**, **Add to queue** or **Remove from queue**, **Start session**, **Requeue task**, **Mark done**, and **Save**.
- A state shows only the actions it has.
- A task needs the user in the states Needs review, Blocked by agent, and Stalled.
- The **Mark done** of a task that needs the user is the one primary.
- A task that needs review reads **Mark done**, or **Mark done and resume queue** when the queue still names its earlier block.
- A task that is Blocked by agent or Stalled reads **Mark done and resume queue**.
- A linked task that has not reported offers **Requeue task** and a Secondary **Mark done**.
- That task has no primary.
- A linked task that has not reported shows a line that neither action stops the session.
- A **Mark done** that works closes the modal, under either of its names.
- **Requeue task** keeps the modal open and turns it into the form of a task that has not started.
- **Add to queue** and **Remove from queue** are disabled while the draft is unsaved or a change runs.
- A queued task whose session has started has left the queue, so it shows no **Remove from queue** and no **Add to queue**.
- A started task shows no **Start session**.
- Its start-status line stays when there is one: “A session is already linked to this task.” or “This task is done.”
- While the task runs after an unfinished task, **Start session** is disabled and the note reads “It runs after T-13, which is not done, so it cannot start yet.”
- **Start session** asks for a native confirmation in the desktop app, or a browser confirmation on a paired phone that names the task and says the session runs on the computer running Pomegr.
- A paired phone's **Start in separate worktree** confirmation says that uncommitted changes are left out and remain untouched.
- A start that works closes the modal, from **Start session** or from **Start in separate worktree**.
- A start that does not happen keeps the modal open with its start-status note.
- After a dirty-worktree start, the footer also holds **Open folder**.
- An unknown-tree hold adds “The Git check is pending or unavailable. Wait 15 seconds, then select Start session again.”
- A held start keeps **Start session** enabled unless the task itself cannot start.
- **Save** is the last action, for a task that has not started.
- Footer action height follows the [Frame](#layout).

| State of the task | Footer, left to right |
| --- | --- |
| Not started | **Delete task**, the notes, **Add to queue** or **Remove from queue**, **Start session**, primary **Save** |
| Needs review | **Delete task**, **Requeue task**, primary **Mark done** |
| Stalled, Blocked by agent | **Delete task**, **Requeue task**, primary **Mark done and resume queue** |
| Linked, has not reported | **Delete task**, the notes, **Add to queue** (a Not queued task only), **Requeue task**, **Mark done** |
| Done | **Delete task** and its note |

## Mode promote

The Promote issues page's **Promote** opens the task modal for that one issue. The modal never lists issues.

### Header and body

- The heading is **New task**.
- The subtitle is “repository · in Backlog”.
- The body starts with the issue content, a 12px-gap column.
- The **Source** group holds the label **Source**, the issue chip, and the one status chip of the page's row.
- Under them, the issue title shows as a 14px/650 `h3`.
- The notices follow in the page's order: outside contributor, hidden comments, too long. They use the shared `.taskNotice`.
- The page's read-only raw body follows as a focusable 150px region.
- The right-aligned count “n / 4,000 characters” sits under the raw body.
- There is no Task field.
- The modal shows the issue text but never sends it.
- A promote carries only the issue number and the digest of the version shown.
- The Run settings rows follow as in mode new, with the same defaults.

### Footer

- The footer starts with the muted line “The pull request will say Closes #n.”.
- The reference in that line is in the data font.
- Then comes the Quiet **Cancel** and the one primary **Promote issue**.
- **Promote issue** is disabled while a promote runs.
- **Promote issue** is disabled for a too long or an already promoted issue.
- **Promote issue** is disabled while a notice below holds it.

### After Promote

- Promote makes the task in the first column.
- Promote then sends one update that holds only what differs from the task the monitor made.
- The task the monitor made has no feature, nothing planned to run, and no complete-when condition.
- So the default Pull request open and Working tree clean checks are sent, unless they were cleared.
- Promote sends no update when nothing differs.
- Promote refreshes the board.
- Promote asks the page to read the issues again, so the row reads **Promoted · T-n**.
- Promote closes the modal.
- Focus returns to the page's Promote button.
- When that button is disabled by then, focus returns to the chosen row.

### Notices after an attempt

- A notice that follows an attempt joins the issue's own notices.
- Each such notice is a `role="alert"` and uses fixed words.

| Condition | Notice words | Action |
| --- | --- | --- |
| Conflict | “This issue changed on GitHub or was already promoted.” | Secondary **Show new version** |
| Issue gone after Show new version | Page line “Issue #n is no longer open.” | The modal closes |
| Too long answer | Names the limit | **Promote issue** stays disabled |
| Issue no longer open | “This issue is no longer open.” | **Promote issue** stays disabled |
| Any other failure | “The issue could not be promoted.” | Another try is allowed |
| Task made, update failed | “The issue was promoted to T-n, but the run settings could not be saved. Open the task to set them.” | The modal drops the fields and offers only a Secondary **Close** |

- **Show new version** reads the issues once more and keeps the chosen fields.
- The conflict notice clears when the new version arrives.
- The Secondary **Close** means an issue is never promoted twice.
- Promotion rules and the reads that follow are in [Tasks](../architecture/tasks.md).

## Feature modal

`FeatureModal` (`app/components/tasks/FeatureModal.tsx`) is a form on the task modal's frame. It has the modes New feature and Feature. It is for the desktop app only.
The [Feature filter](task-board.md#feature-filter) opens it. A paired device and a browser draw no action that opens it.

### Fields

- The body holds three fields in this order: **Title**, **Description**, and **App version**.
- Each field is a `.newTaskField.featureField` with a label, the control, and a foot.
- **Title** is a one-line input with `maxlength` 80 and the placeholder “What is this feature?”.
- The **Title** foot holds the muted helper “One line. It names the feature on the board and in the session's prompt.” and a live counter on its right.
- **Description** is a `textarea` at least 150px tall, with no `maxlength` and the placeholder “What should every task of this feature know?”.
- The **Description** foot holds the muted helper “The context its tasks share, so each task's own text stays short. An agent reads it when its task needs it.” and a live counter.
- **App version** is an input with `maxlength` 40, at most 240px wide, in the data font, with the placeholder “1.4.0”.
- The **App version** helper reads “The version the feature is planned for. Optional, and it gates nothing.” and the field has no counter.
- A counter (`.featureCounter`) reads “n / 80” or “n / 2,000” in the muted 12px data font, with a thousands separator.
- Past 2,000, the **Description** counter takes the error color (`.isOver`) and the primary is disabled.
- A text input is 36px high with a fine pointer at 761px and wider, and 44px otherwise.
- The header and the footer are the [frame](#frame)'s. The subtitle is the repository name.
- The close is the Icon-role **Close**.

### New feature

- The heading is **New feature**.
- Focus starts in **Title**.
- The footer is a spacer, a Quiet **Cancel**, and the one primary **Create feature**.
- **Create feature** is disabled until the trimmed title holds text, while a description is over its bound, and while a create runs.
- **Create feature** sends the title, and the description and the app version only when they hold text. Values are trimmed.
- **Create feature** closes the modal and the board reads again. The filter keeps its choice.
- **Cancel**, **Close**, and Escape discard the form without asking.
- A click on the scrim closes the modal only while the three fields are empty.

### Feature

- The heading is **Feature**, followed by the chip `.commandChip.taskCardChip.neutral` “n of m done”.
- A feature with no task has no chip and no **Tasks** list.
- The fields hold a local draft of the stored feature. The title comes from the board.
- The description and the app version come from the desktop read when the modal opens.
- Until the read answers, the two fields are disabled and empty. The title stays editable.
- If the read fails, the two fields stay disabled, and the line “The description and app version could not be read.” (`p.newTaskError`, `role="alert"`) follows them.
- After the fields comes the folded **Tasks** list (`details.taskFeatureDetails`).
- The summary is the chevron (`.taskFeatureChevron`), the label **Tasks** (`.taskFeatureLabel`), and the count “n tasks · d done” (`.taskFeatureCount`) with data-font numerals.
- The list is the task modal's In this feature list. Each row has its ID, its title button, and its state chip.
- A row's title button opens that task's modal in place of this one. The draft is discarded.
- The footer is a Quiet **Delete feature**, a spacer, a Secondary **Mark done** or **Reopen**, and the one primary **Save**. It has no **Cancel**.
- **Save** is disabled until the draft differs from the stored feature, the title holds text, and no field is over its bound.
- **Save** sends one update that holds only the changed fields. A cleared description or app version is sent as `null`.
- **Save** closes the modal and the board reads again.
- **Close** and Escape discard the draft without asking.
- A click on the scrim closes the modal only while the draft equals the stored feature.

### Delete feature

- **Delete feature** is in the Feature mode only. The New feature mode has no such action.
- **Delete feature** swaps the footer for an inline confirmation. No native dialog opens.
- The confirmation is a `div.taskModalConfirm` with `role="group"` and `aria-label="Confirm delete"`.
- The confirmation holds the note (`span.taskModalNote`), a spacer, a Secondary **Delete feature**, and a Quiet **Keep feature**, in that order.
- The confirmation has no **Save**.
- **Keep feature** takes focus when the confirmation opens. It returns to the idle footer and sends nothing.
- A feature with no task: “Delete this feature? This cannot be undone.”
- A feature with n tasks: “Delete this feature? Its n tasks stay on the board with no feature. This cannot be undone.”
- A feature with one task: “Delete this feature? Its 1 task stays on the board with no feature. This cannot be undone.”
- n counts every task of the feature, done tasks included.
- A task that has started and is not done blocks the delete. The task modal's rule for a started task decides this.
- While one blocks, a `div.taskModalResolve` holds a muted note above the footer actions: “T-n is running. Delete the feature after its tasks finish.”
- T-n is the first such task, by ID.
- While one blocks, **Delete feature** is disabled and opens no confirmation. **Save** keeps its own rule.
- The Secondary **Delete feature** is disabled while the delete runs.
- A successful delete closes the modal and the board reads again.
- A filter that named the feature returns to All, and focus goes to the filter. With no feature left, the filter is gone, and focus goes to **New task**.
- A failed delete, a `conflict` from a task that started in the meantime included, keeps the modal open and returns to the idle footer.
- A failed delete shows one fixed line under the fields.
- **Delete feature** is not available on a paired device or in a browser.

### Mark done and Reopen

- The Secondary reads **Mark done** while the feature is not done, and **Reopen** while it is.
- It sends one `feature_update` that holds the ID and `done` alone, at once. The draft is not saved with it.
- A successful one keeps the modal open, flips the label, and the board reads again.
- A done feature takes no new task. Its tasks keep their column, state, and queue place.
- It is disabled while a save, a mark, or a delete runs, and while the delete confirmation shows.
- A failed one shows “The feature could not be saved.” under the fields.
- A done feature looks the same on the board. The Feature fields of the task forms do not offer it.
- **Mark done** and **Reopen** are not available on a paired device or in a browser.

### Failures

- A failure keeps the modal open and keeps what was typed.
- Each failure is one fixed `p.newTaskError` with `role="alert"`.
- The next attempt clears it. Typing in the title also clears the duplicate-title line.

| Failure | Line | Where |
| --- | --- | --- |
| Title already used | “Another feature already has this title.” | Under the **Title** input, which names it with `aria-describedby` |
| Board holds 50 features | “This board already holds 50 features. Delete one first.” | Under the fields |
| Any other failure | “The feature could not be saved.” | Under the fields |
| Failed delete | “The feature could not be deleted.” | Under the fields |

## Promote issues page

`/tasks/issues?repository=<repositoryId>` is where the owner chooses a GitHub issue to promote into a task. It sits below the Tasks root item, so Tasks stays current.

### Layout

- The page is the shared page header over one panel.
- The panel has the panel fill, a one-pixel `--command-line` border, and the panel radius.
- The Quiet **Tasks** back link is the header's breadcrumb. It is muted, with a 14px chevron-left.
- The h1 is **Promote issues**.
- The header meta is a muted 12px count line “repository · n open issues, m not promoted”.
- The count line reads “n+” when the list was cut at 100.
- The Quiet **Refresh** is the header action.
- Inside the panel, a muted 12px caption sits over a rule.
- The caption reads “Promoting copies the issue title and body into a task once. Later edits and comments are never read.”
- The split body follows the rule.

### List

- The list is flex `1 1 340px` and at most 420px wide.
- The list has a rule on its right.
- At 760px and narrower, the list stacks above the detail.
- The list holds one full-width row button per issue (`.promoteIssueRow`, `aria-pressed`).
- A row shows the number in the data font and the 13px/500 title.
- Under them, a row shows one chip and “Updated 8 Oct”.
- The date shows the year only when it is not the current one.
- No opened date is served.
- Hover tints the row with 6% ink.
- The chosen row takes the raised fill.
- The focus ring of a row is inset (offset −2px) because the rows touch.

| Condition | Chip | Tone |
| --- | --- | --- |
| Too long | **Too long** | Negative |
| Already promoted | **Promoted · T-n** | Positive |
| Author association owner | **Owner** | Neutral |
| Author association member | **Member** | Neutral |
| Author association collaborator | **Collaborator** | Neutral |
| Outside contributor | **Outside contributor** | Warning |

- The chip shows the first matching condition from the top of the table.

### Detail

- The detail is flex `999 1 480px`, with 24px padding and a 12px gap.
- The detail holds, in order: the data-font number, the title, the chip and date, the notices, the raw body, and a footer.
- The title is a 16px/650 `h2`.
- The footer holds the data-font count “n / 4,000 characters”.
- The count shows in the error color over the limit.
- The footer holds the page's one Primary **Promote**.
- **Promote** has `aria-haspopup="dialog"` and opens the task modal in mode promote.
- **Promote** is disabled for a too long or an already promoted issue.

### Notices

- A notice (`.taskNotice`) is shared with the task modal.
- A notice is a soft-filled box with 8px/12px padding, a one-pixel line in its tone, and the control radius.
- A notice has 12px/1.5 text in its tone.
- A notice is never a side stripe.
- The detail shows the notices in the order of the table.

| Notice | Tone | Content |
| --- | --- | --- |
| Outside contributor | Warning | Fixed words |
| Hidden comments | Warning | Fixed words |
| Too long | Error | Fixed words |
| Already on the board | Positive | “Already on the board as T-n.” and a Text link **Open task** |

### Raw body

- The raw body (`.taskIssueBodyBox`) is a focusable region.
- It sits under a “Raw body” label and the caption “Exactly what the agent will read”.
- It shows the issue text in the data font at 12px/1.4, with `pre-wrap`.
- It has the canvas fill, a one-pixel line, and the control radius.
- It is at least 240px and at most 560px tall, and scrolls inside.
- A hidden HTML comment is a struck-through segment in amber on the amber-soft fill.
- A hidden comment has a visually hidden “Hidden comment:” prefix.
- Issue titles and bodies are third-party text.
- The page draws them as React text only.
- The page never draws them as Markdown, a link, an image, or browser storage.

### States

- A state replaces the list with a fixed title and detail.
- A state never shows issue text.
- A failed Refresh keeps the last list and adds one error line.

| State | Extra |
| --- | --- |
| Loading | None |
| No open issues | None |
| GitHub not signed in | Text link to Settings → GitHub |
| GitHub CLI missing | Text link to Settings → GitHub |
| No access | None |
| Issues turned off | None |
| Repository not found | None |
| Failed read | One generic message |
| Browser, or desktop build without the issues bridge | “GitHub issues are read in the Pomegr desktop app.” and no read |

### Reads

- The page reads once when it opens and once per Refresh.
- The page never reads on a timer, on focus, or on a GET.
- While the page reads, the section is `aria-busy`.
- While the page reads, Refresh is disabled and the last list stays on screen.
- The chosen issue stays chosen by its number across a refresh.
- The task modal's **Show new version** and a finished promote each ask for one more read.
- No other action reads.
- The issue chip (`taskIssueChip`) is defined in [task-board.md](task-board.md).

## Samples

- `/design-system` renders the task fields as Run settings rows, including Feature, Remote Control, and When done.
- `/design-system` renders the Review panel for Needs review, Stalled, and Blocked by agent, and for a Done task with a report, headed **Agent report**.
- `/design-system` renders the Task read view with a tag run, a numbered list, code, a UUID, and a date, and again with an inline image.
- `/design-system` renders the Run settings of a started task, and again with the **Observed model differs** notice under Run on.
- `/design-system` renders the Queue block for a task behind earlier cards, a queue that is off, a held start, a scheduled task, and no known hold.
- `/design-system` renders the Runs after block with rows, with the loop line, and read-only for a started task.
- `/design-system` renders the rich text Task field with no image, with tags and a title line, with an image in the text, and full with an error line.
- `/design-system` renders the task modal chrome (`TaskModalChrome`) in modes new, promote, and edit.
- The edit samples are a task that has not started, a task that needs review, a started task that has not reported, and the GitHub issue confirmation open.
- The first edit sample holds long text and an inline image to exercise full-height editing and body scrolling.
- `/design-system` renders the GitHub issue row closed, disabled until the draft is saved, and after a failure, and the confirmation open, creating, and disabled.
- The mode new sample ends with the split action.
- `/design-system` renders the Feature modal chrome in New feature, in Feature with Save disabled and enabled, with the delete confirmation, with Delete feature blocked by a started task, with the details not read, and with each failure line.
- The chrome is static markup over a static scrim, without the dialog behavior.
- `/design-system` renders the Promote issues parts: the header action, row chips, page header, list and detail, and notices.
- `/design-system` also renders the raw body with a hidden comment, the character count, and every state.
- All samples use invented static issues.
- The modals' dialog behavior and their saves through the desktop are specified here but not rendered there.
