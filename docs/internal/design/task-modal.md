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
- The Task field gives up height first.
- The body scrolls only when the window is too short for the rest.
- The panel has the panel fill, a one-pixel `--command-line` border, the panel radius, and the overlay shadow.
- The panel has no entrance or exit motion.
- The panel is centred in the window.
- The header (`.taskModalHeader`) has 8px/12px/8px/24px padding and a one-pixel rule.
- The title group (`.taskModalTitleGroup`) holds the 16px/650 `h2` that names the dialog and an optional extra.
- The optional extra is the task form's data-font task ID and state chip.
- The subtitle (`.taskModalSubtitle`) is muted 12px text, reads “repository · in column”, takes the remaining width, and truncates.
- The header ends with the [Icon](../../../DESIGN.md#buttons)-role **Close**.
- The body (`.taskModalBody`) is a 16px-gap column with 24px padding.
- The footer bar (`.taskModalFooter`) has a one-pixel top rule, no fill, 12px/24px padding, and an 8px gap, and it wraps.
- `.taskModalSpacer` pushes the actions to the end.
- `.taskModalResolve` is a full-width row at the top of the footer.
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
- An open list and a feature name being edited handle the key first.
- A click on the scrim closes the dialog only while the form holds nothing to save.
- A form that holds nothing to save is an unchanged task, an empty New task, an empty New feature, or an unchanged Feature. The promote form never closes on a scrim click.
- This rule means a stray click never loses typed text.
- The opener takes focus back.
- A `CommandSelect` list opened inside renders inside the dialog.

### Footer actions by mode

| Mode | Footer actions |
| --- | --- |
| New | Quiet **Cancel**, primary **Create task** as a [split action](../../../DESIGN.md#buttons) |
| Edit | Quiet **Delete task**, Secondary **Add to queue** or **Remove from queue**, Secondary **Start session**, primary **Save** |
| Promote | Quiet **Cancel**, primary **Promote issue** |
| New feature | Quiet **Cancel**, primary **Create feature** |
| Feature | Quiet **Delete feature**, primary **Save** |

## Task fields

The New task and Task forms share these fields. The Promote form shares all but Task. All fields are optional except Task, Run on, and Effort.

### Task

- **Task** is a label and a `textarea` at least 150px tall in 13px type.
- The textarea grows with its text and has no resize handle.
- The placeholder is “What should the session do?”.
- A right-aligned muted data-font counter reads “n / 4,000” under the field.

### Rich text and images

- In the desktop app, the Task field of the New task and Task forms is rich text (`TaskRichText`, `.taskRichText`).
- Rich text holds the task's images in the text itself.
- An editable region replaces the textarea. It has the same type, padding, 150px minimum height, and placeholder.
- In the task modal, the textarea and the editable region grow until the panel is as tall as the window allows.
- Then the text scrolls inside the field.
- Outside the modal, the editable region scrolls past 480px.
- The region sits in one frame (`.taskComposer`) with a one-pixel `--command-line-strong` border, the control radius, and the panel fill.
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
- The foot of the frame (`.taskImagesHead`) sits above a one-pixel `--command-line` rule.
- The foot holds the Quiet **Attach image**.
- **Attach image** opens the native file picker and puts the chosen images at the caret.
- The counter, one muted helper line, and an error line (`role="alert"`) sit under the frame.
- The counter counts each image as its marker and turns to the error color past 4,000.
- A task holds at most four images, and **Attach image** is disabled at four.
- An image is part of the text.
- In the New task form, an image is stored once the task exists.
- In the Task form, an image is part of the Save draft like the text. **Save** stores it and Close discards it.
- A browser keeps the textarea.
- A desktop build without the image bridge keeps the textarea.
- Cards, the Search bar, and the session's Task tab show the plain word “[image]” where the text holds one.

### Feature

- **Feature** fills a one-column row.
- **Feature** is a `CommandSelect` that lists unfinished features, No feature, and New feature….
- New feature… reveals a one-line name field in place.
- Enter or leaving the name field commits the name.
- Escape cancels the name.
- The forms have no Step field.
- A task that joins a feature takes a new last step.
- The Board moves a task to another step.
- Once a created feature is chosen, a folded **In this feature** disclosure appears.
- The disclosure is a native `details` between two rules.
- The disclosure summary is 44px high, with a muted chevron and a “n tasks · m done” count in data-font numbers.
- The disclosure lists the feature's other tasks.
- Each title is clamped to two lines and has the whole title as its tooltip.

### Run on and Effort

- **Run on** and **Effort** share the next two-column row.
- Run on is one `CommandSelect` grouped by provider.
- Run on lists each provider's observed models and a Default model entry.
- Run on has no clear state.
- Effort is a four-way segmented control with the segments Low, Medium, High, and Xhigh.
- A pressed segment of Effort stays pressed when pressed again.
- Both fields are required, and neither can be cleared.
- A new task opens with both chosen: Claude Code, Default model, and Medium on an empty board.
- Only a task stored without them shows Not set in Run on or no pressed segment, until one is chosen.

### Remote Control

- Under Run on and Effort, across the whole row, sits one native checkbox, **Remote Control** (`.taskRemoteControl`).
- The checkbox uses the Complete when checkbox row.
- One muted helper line reads “Starts the session with Remote Control, so you can also open it on your phone.”
- The checkbox is unchecked by default.
- Choosing a Codex entry in Run on clears the choice and hides the checkbox and its helper.
- Returning to Claude Code shows the checkbox unchecked.
- A card's run line and the session's Task tab add the plain words “Remote Control” after the effort when it is on.

### Remove worktree and branch when done

- Under Remote Control, across the whole row, sits a second native checkbox, **Remove worktree and branch when done** (`.taskRemoveWorktree`).
- The checkbox uses the same checkbox row.
- One muted helper line reads “For a task that runs in its own worktree. Uncommitted or unpushed work is never removed.”
- The checkbox is checked by default on either provider.
- A new task never takes the choice from the newest task.
- Nothing else shows the choice.

### Complete when

- **Complete when** is a fieldset with a legend.
- The fieldset holds a wrapping row of six native checkboxes.
- The checkbox labels are “PR open”, “Tree clean”, “Commit on branch”, “PR merged”, “CI passed”, and “Validated with the user”.
- A checkbox row is 28px high, and 44px at 760px and narrower and on coarse pointers.
- Below the checkboxes sits one 36px text input named Own condition.
- The placeholder is “Own condition, judged by the agent (optional)”.
- A non-blank own condition is the agent-judged condition.
- A blank own condition means no agent-judged condition.
- The own condition has no checkbox.
- “Validated with the user” is agent-judged too.
- After a report, the row of “Validated with the user” shows the muted “Agent-reported” in place of a result.

## Mode new

- In the desktop app, the first lane's **+ New task** action opens the task modal in mode new.
- The opener has `aria-haspopup="dialog"`.
- The heading is **New task**.
- The subtitle is “repository · in Backlog”, where Backlog is the first column's name.
- Focus starts in the Task field.
- The body holds the Task field with its counter, then Feature, then Run on and Effort, then Complete when. These are the [Task fields](#task-fields).
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

A card's title opens the task modal for one stored task.

### Header

- The heading is **Task**.
- The header shows the task ID in the data font and the state chip.
- The subtitle is “repository · in column”.

### Draft and Save

- Text, Run on, Effort, Complete when, and Feature are a local draft.
- Nothing is sent until **Save**, the one primary.
- **Save** is disabled until the draft differs from the stored task.
- **Save** is also disabled while the text is empty or a new feature has no name.
- **Save** first creates a new feature when one is being named.
- **Save** then sends one patch that holds only what changed, and closes the modal.
- A failure keeps the draft and says so under the Task field.
- Close and Escape discard the draft without asking.
- While the draft is unsaved, **Start session**, **Add to queue** or **Remove from queue**, **Mark done**, and **Requeue task** are disabled.
- While the draft is unsaved, one muted line says “Save your changes first.”.

### Body

- A task promoted from a GitHub issue starts the body with a **Source** block.
- The **Source** block is one wrapping row.
- The row holds the 12px/500 label **Source**, the issue chip, and the muted caption “GitHub issue”.
- The block shows no promoted-at time, because none is stored.
- The text of a promoted task stays editable like any task's.
- A task whose title comes from its session follows with that title.
- A muted helper under that title links **Open session**.
- An amber notice follows Run on when the observed model differs from the planned one.
- The notice has an amber line, the amber-soft fill, and the words **Observed model differs**.
- Complete when lists each checked condition's **Passed** (green), **Not passed** (error), or **Not verified** (muted) from the agent's report.
- **Not verified** means that Pomegr had no current evidence for the condition; it never takes the error color.
- The report line shows below each condition.
- In the Feature fields, the folded list leaves out the open task.
- In the Feature fields, each row leads with its step number.
- **Sessions** follows Complete when. It is a fieldset with the 12px/500 legend **Sessions**.
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
- Assign and Unassign save by themselves. They are not part of the draft, and they work on a started task.
- A Done task shows its rows and Unassign, and no select.
- A client that cannot assign draws the rows only. A task with no session then draws no Sessions block.
- A task that still waits for a session ends with **Start at**, its own start time.
- **Start at** is a `datetime-local` time field that saves by itself.
- The Schedule design owns the `datetime-local` field. See [task-board.md](task-board.md).

### Footer

- The footer's top row (`.taskModalResolve`) holds the muted start-status note.
- After a dirty-worktree start, the top row also holds **Open folder**.
- For a task that needs the user, the top row also holds the Secondary **Mark done and resume queue** and **Requeue task**.
- A task needs the user in the states Needs review, Blocked by agent, and Stalled.
- A task that needs review holds no queue, so its first action reads **Mark done**.
- A linked task that has not reported offers **Mark done** and **Requeue task**.
- A linked task that has not reported shows a line that neither action stops the session.
- Below the top row, from the left, comes the Quiet **Delete task**.
- **Delete task** swaps in an inline confirmation.
- The confirmation holds a Secondary delete and a Quiet Keep task. It uses no native dialog.
- Then a spacer, a Secondary **Add to queue** or **Remove from queue**, and a Secondary **Start session**.
- **Remove from queue** is disabled on a queued task whose session has started.
- **Start session** asks for a native confirmation in the desktop app, or a browser confirmation on a paired phone that names the task and says the session runs on the computer running Pomegr.
- A paired phone's **Start in separate worktree** confirmation says that uncommitted changes are left out and remain untouched.
- A paired phone's successful start says “Session started in a new terminal on the computer running Pomegr.”
- The footer ends with the primary **Save**.
- Footer action height follows the [Frame](#layout).

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
- Feature, Run on and Effort, and Complete when follow as in mode new, with the same defaults.

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
- The list is the task modal's In this feature list. Each row leads with its step, its ID, its title button, and its state chip.
- A row's title button opens that task's modal in place of this one. The draft is discarded.
- The footer is a Quiet **Delete feature**, a spacer, and the one primary **Save**. It has no **Cancel**.
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

- `/design-system` renders the task fields, including Feature.
- `/design-system` renders the task modal chrome (`TaskModalChrome`) in modes new, promote, and edit.
- The mode new sample ends with the split action.
- `/design-system` renders the Feature modal chrome in New feature, in Feature with Save disabled and enabled, with the delete confirmation, with Delete feature blocked by a started task, with the details not read, and with each failure line.
- The chrome is static markup over a static scrim, without the dialog behavior.
- `/design-system` renders the Promote issues parts: the header action, row chips, page header, list and detail, and notices.
- `/design-system` also renders the raw body with a hidden comment, the character count, and every state.
- All samples use invented static issues.
- The modals' dialog behavior and their saves through the desktop are specified here but not rendered there.
