# Agent chat design

> Scope: the Aril chat, its launcher, panel, repository choice, messages, answer text, proposal card, composer, and conversation list.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/components/agent-chat/`, `app/styles/agent-chat.css`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

The **Aril** chat is a floating panel at the bottom right of the window where the owner talks to Aril, the Pomegr task-board agent.

The runs, the proposals, and the privacy rules of the chat are in [Agent chat](../architecture/agent-chat.md).
The task board is in [Task board design](task-board.md).

## Composition

- The chat is `AgentChatDock` and its siblings in `app/components/agent-chat/`, with styles in `app/styles/agent-chat.css`.
- The chat is a composition of the existing roles, chips, `CommandSelect`, notices, and tokens.
- The chat adds no button role.
- `AppShell` mounts the chat once, after the shell.
- The chat is drawn only where it can be reached: the desktop app and a paired phone.
- That decision is made before anything is drawn.
- A client that is still being identified draws nothing.
- A browser on the same computer draws nothing.
- So the launcher is never drawn and then taken away.
- The chat holds no data of its own.
- The conversations and the answer being written come from `useAgentChat`.
- The board rows come from `useTasks`.
- The repositories come from the inventory.
- The only thing the chat writes to browser storage is the last repository ID (`pomegr.agentChat.repository`), never a message.

## Launcher

- `.agentChatLauncher` is shell chrome like the header icon buttons (`.commandIconButton`), not a seventh role.
- The launcher is `position: fixed`, 16px from the right and bottom edges, and clear of the safe area.
- The launcher is 36px high, and 44px at 760px and narrower and on coarse pointers.
- The launcher has the panel fill, a one-pixel `--command-line-strong` border, the control radius, and the overlay shadow.
- The launcher holds a 16px `spark` glyph in the brand text color and the name **Aril** at 13px/500.
- The accessible name is “Open Aril, the Pomegr agent”.
- `aria-expanded` and `aria-controls` name the panel.
- The launcher is hidden while the panel is open.
- The z-index of the launcher and of the panel is 85: above the sidebar and the header, below the agent inspector sheet (90) and the select list (120).

| State | Label | Accessible name |
| --- | --- | --- |
| An answer is being written and the panel is minimized | The label reads “Aril · answering…” | Adds “answering” |
| An answer finished while the panel was minimized | A 7px `--command-brand` dot follows the name | Adds “new answer” until the panel is opened |

- Both states follow a turn of the open conversation that another device started, once the open panel has seen it.
- A turn that another device starts while the panel is minimized and idle does not change the launcher, because that panel asks nothing.

## Panel

### Layout

- `.agentChatPanel` is a non-modal `<section aria-label="Aril, the Pomegr agent">`.
- The panel is fixed 16px from the right and bottom edges.
- The panel is 420px wide and `min(640px, calc(100dvh - 92px))` tall.
- The panel has the panel fill, a one-pixel `--command-line-strong` border, the panel radius, and the overlay shadow.
- The panel is a column of header, optional repository row, body, and composer.
- At 760px and narrower, the panel is a full-screen sheet (`inset: 0`, no radius, border, or shadow, padded by the safe area) with 44px targets.
- The only motion is a 140ms opacity fade when the panel opens, removed under `prefers-reduced-motion`.
- The panel is built the first time it opens and is then kept, hidden, while minimized.
- So the draft and the scroll position survive.
- The chat asks the desktop only while the panel is open or an answer is being written.
- A minimized, idle panel asks nothing.
- An open panel that follows no answer asks for the conversation list every five seconds, on the desktop and on a paired device.
- So a message sent from another device, and the turn it starts, reach an open panel without reopening it.
- A turn started elsewhere in the open conversation shows as the panel's own: the answer text, the activity line, Stop in place of Send, then the stored messages.
- A newer stored open conversation in that list is read again, so a turn that ended between two asks still shows.
- A conversation started elsewhere joins the conversation list, and the busy line disables Send while it is answered.

### Header

- The header (`.agentChatHeader`) has a one-pixel rule below it.
- The header holds the `spark` glyph, the 16px/650 `h2` **Aril**, and the muted 12px caption “Task-board agent”.
- The header ends with three [Icon](../../../DESIGN.md#buttons)-role actions, each with an `aria-label` and a `title`.
- **Conversations** has a `history` glyph and `aria-pressed`.
- The pressed state of **Conversations** takes the raised fill, a local toggle state of the role.
- **New conversation** has a `plus` glyph.
- **Minimize** has a `collapse` glyph.

### Repository

- The chat belongs to one repository.
- A compact `CommandSelect` named **Repository** sits under the header.
- The select is 32px high with 12px text, and 44px on phone and coarse pointers.
- The select appears only when more than one repository is listed.
- Choosing a repository remounts the body, so no conversation is shown under another repository.
- Focus stays on the menu after a choice.
- Each opening chooses the repository from these sources, in this order.

| Order | Source |
| --- | --- |
| 1 | The validated `repository` parameter of a `/tasks…` page |
| 2 | The ID in a `/repositories/repo-<24 hex>` path |
| 3 | The last repository used |
| 4 | The first repository listed |

- Each opening keeps the repository of an answer that is being written.
- With no repository, the body reads “No repositories observed yet.”, or “Loading…” while the inventory loads.
- With no repository, the composer is disabled.

### Keyboard and focus

- Opening moves focus to the message field, or to Minimize when the field is disabled.
- Minimize and Escape close the panel and return focus to the launcher.
- Escape first belongs to a layer inside the panel: an open `CommandSelect` list, or an inline delete question.
- The panel never traps focus.
- Nothing moves focus while an answer is written.

## Messages

### Log

- The body is a `role="log"` region named “Conversation with Aril”.
- The log is itself a focusable scroller with 16px padding and a 16px gap.
- The log keeps the newest line in view only while the owner is at the bottom.
- Once the owner scrolls up, the log stays where they are.
- A Quiet **Jump to latest** brings the log back to the newest line.
- **Jump to latest** has the panel fill and a one-pixel line, and sits at the bottom right of the log.

### Owner and Aril

- The owner's message is a block at the right, at most 85% wide.
- The owner's message has the raised fill (`--command-panel-2`), the control radius, and 13px text, with its line breaks kept.
- The images of the owner's message follow its text as an image strip named “Images you sent”. See [Image strip](#image-strip).
- Aril's message is full width with no fill.
- Aril's message starts with a head line of the 12px/600 name and a muted data-font caption “provider · model”.
- The caption reads “Claude Code · default model” when no model was chosen.
- The answer follows as Markdown.
- An answer that did not complete ends with one muted line of fixed words.
- Aril's follow-up after an applied or dismissed proposal is drawn as any message of Aril, with no message of the owner before it.
- A follow-up draws no proposal card.
- A follow-up that could not be written is drawn as an answer that did not complete, with the same fixed words.

| Fixed words of an answer that did not complete |
| --- |
| “Stopped.” |
| “Aril could not finish this answer. Check that the provider's CLI is installed, signed in, and up to date.” |
| “This answer took too long and was stopped.” |
| “Pomegr closed before this answer was finished.” |

### Image strip

- `AgentChatImageStrip` is a list (`.agentChatImages`) that wraps, with an 8px gap.
- The image strip draws the images in the order the owner added them.
- A picture (`.agentChatImagePicture`) is 72px square, cropped to cover, with a one-pixel `--command-line-strong` border, the control radius, and the canvas fill.
- A picture is 96px square at 760px and narrower and on coarse pointers.
- The alternative text of a picture is “Image n”.
- An image whose bytes have not arrived is an empty frame of the same size with the same name, so nothing moves when the picture arrives.
- A picture opens nothing and cannot be dragged.
- The image strip is drawn in three places: under an owner message, in a proposal row, and in the composer.
- Only the composer's image strip has a remove action.

### While a turn runs

- The pending message of the owner is drawn once, and never again when it reaches the stored conversation.
- The pending message shows its images from the files the owner added, so they do not load again.
- An agent block then holds the partial text.
- The agent block is in an `aria-live="off"` wrapper, so the log announces each stored message and not each chunk.
- A `role="status"` line holds one fixed word.
- After **Apply changes**, **Start session**, a queue Primary, or **Dismiss**, the agent block of the follow-up is drawn the same way, with no pending message.
- A follow-up that waits for an answer in another conversation reads “Starting…”.
- The panel asks for no follow-up: it reads the turn that the desktop app started.
- The fixed word is “Starting…”, “Thinking…”, “Reading repository files…”, “Reading sessions…”, “Reading usage limits…”, or “Writing…”.

### Loading and empty states

- Before the first list has answered, the log reads a quiet “Loading…”.
- A saved conversation that is being read reads the same.
- The log never shows an empty state that is then replaced.
- The empty state shows when no conversation is open and the list is ready.
- The empty state starts with a 14px/650 “Ask Aril about this board” and one muted 12px sentence.
- Four full-width Secondary rows follow, and they only fill the message field.
- The rows read “Break this feature into tasks: ”, “Which task should run first, and why?”, “Is any task too big for one session?”, and “Which model fits this kind of task: ”.
- A muted caption reads “Aril can be wrong. Check a proposal before you apply it.”

### Answer text

- `AgentChatMarkdown` builds React elements from the answer and sets no HTML.
- So HTML, a link, and an image stay the literal characters they were written with, and nothing navigates.
- It reads paragraphs, `-`, `*`, and `1.` lists, `**bold**`, `` `inline code` ``, fenced code blocks, and `#` headings.
- A blank line separates paragraphs, and a single line break is kept.
- Text is 13px/1.55.
- A heading is a 13px/650 line, not a heading element.
- Code is the data font at 12px (`--font-data`).
- Inline code is on the raised fill.
- A code block is on the canvas fill with a one-pixel line and horizontal scroll.
- A fence that is still open holds the rest of the text while the answer is written.

## Proposal card

### Layout

- `.agentChatProposal` sits under the message that carries it.
- The card has a one-pixel `--command-line` border, the panel radius, 12px padding, and an 8px gap.
- The head is the 13px/600 summary.
- Once the proposal was answered, the head adds a standard `.commandChip`.
- The chip is positive **Applied**, warning **Partly applied**, or neutral **Dismissed**.
- A pending proposal has no chip.
- A session start that launched has the positive chip **Session started** in place of **Applied**.
- The card is a region named “Proposed board changes”, or “Proposed session start” for a session start.
- The card of a queue change is a region named “Proposed queue change”.
- A queue change that was applied has the standard positive chip **Applied**.

### Operations

- An ordered list follows the head, with one row for each operation.
- Each row is a fixed verb and a target set as text.
- Task IDs are in the data font.

| Operation | Row |
| --- | --- |
| **Create feature** | The name of the feature |
| **Create task** | The first line of its text clamped to two lines, with the whole text as its tooltip, and one muted 12px line of what is set |
| **Create task below T-n** | The **Create task** row, for a new task placed right under T-n |
| **Create task in column** | The **Create task** row, for a new task placed in that column; the line of what is set adds “position n” when the proposal names one |
| **Update T-n** | The board's current first line of that task in muted text, a muted line naming the changed fields, and, when the text changes, “New text:” and its first line |
| **Delete T-n** | The current first line, and “Cannot be undone” in the error color (text only, never a fill) |
| **Move T-n to column** | A muted “position n” follows |
| **Add T-n to queue** | Nothing more |
| **Remove T-n from queue** | Nothing more |
| **Run T-n, T-n, and T-n in parallel** | Nothing more |
| **Take T-n out of its parallel group** | Nothing more |
| **Attach n images to T-n** | The board's current first line of that task in muted text, and the image strip named “Images for this task” |
| **Start a session for T-n** | The board's current first line of that task in muted text |
| **Turn the queue on** | Nothing more |
| **Turn the queue off** | Nothing more |

- The line of what is set holds “in feature”, provider, model, and effort, “Complete when: PR open, CI passed”, and “then add to queue”.
- The line of what is set of **Create task** adds “with 1 image” or “with n images”, and the image strip follows it.
- **Attach n images to T-n** reads “Attach 1 image to T-n” for one image.
- **Update T-n** leaves the current first line out when the board does not hold the task.
- **Start a session for T-n** is the only row of its card.
- **Turn the queue on** or **Turn the queue off** is the only row of its card.

### Results

- Once the proposal ran, each row ends with its result in 12px/500 text.

| Result | Tone |
| --- | --- |
| “Done”, or “Created T-n” for a new task | Green |
| “Not valid”, “Not found”, “Board is full”, “No longer possible”, “Not supported”, or “Pomegr did not answer” | The error color |
| “Created T-n, but it could not be queued”, for a task that was created and could not be queued | The error color |
| “Created T-n, but it could not be placed”, for a task that was created and could not be moved to its place | The error color |
| “Created T-n, but its images could not be attached”, for a task that was created and did not take an image | The error color |
| “Not attached.” and one fixed sentence, for an image that a task on the board did not take | The error color |
| “Not run”, for an operation after the one that failed | Muted |
| “Session started in a new terminal window.”, for a session start that launched | Green |
| “Not started.” and one fixed sentence for the start status, for a session start that launched nothing | The error color |
| “Queue turned on.” or “Queue turned off.”, for a queue change that was made | Green |
| “Queue turned on. A stalled or blocked task holds it, so nothing starts until you resolve that task.” | Muted |
| “Queue not changed. Pomegr refused this change.”, for a queue change the monitor refused | The error color |
| “Queue not changed. Pomegr did not answer. Try again.”, for a queue change that did not reach the monitor | The error color |

- A start that a gate held reads “Not started. A start gate held this task.”
- While that card is pending, one muted 12px line follows with the Task modal's own held line, “This task is held: ...”, from the board's current gate readings.
- The held line is left out when the board reads no hold now.
- The other start sentences name Windows only, a missing command-line tool, a missing plugin, a task that could not be started, an unsupported provider, a task that no longer exists, another start under way, a start that could not be made, a dirty task worktree, and a dirty repository.
- The sentences after “Not attached.” name a task that holds four images, a task that has started, an image that is no longer on this computer, an image that could not be read, and no answer from Pomegr.
- A session start that launched nothing keeps its result and stays pending.
- A queue change that was not made keeps its result and stays pending.
- No result of a queue change says that a task started.

### Footer

- Only a pending proposal has a footer: the Primary **Apply changes** and the Quiet **Dismiss**.
- Both actions are disabled and the card is `aria-busy` while the answer is in flight.
- The footer holds the muted line “Nothing changes until you apply.”
- The line adds “Deleting cannot be undone.” when the proposal deletes a task.
- Each pending card has its own Primary, so a conversation may hold more than one.
- After a successful apply, the board is read again.
- After an Apply or a Dismiss that was stored, the conversation is read until Aril's follow-up is stored.
- The Primary of a session start reads **Start session**.
- The footer line of a session start reads “Nothing starts until you select Start session and confirm in the desktop dialog. Pomegr then checks the start gates and opens a terminal on this computer.”
- **Start session** approves the proposal and opens the manual start's native confirmation.
- On a paired device a session start has no Primary, only **Dismiss**.
- On a paired device the footer line of a session start reads “Aril's start can be applied only in the Pomegr desktop app. To start from this device, open the task and select Start session.”
- The Primary of a queue change reads **Turn queue on** or **Turn queue off**, on a paired device too.
- The Primary names the state the proposal asks for, never the opposite of the queue's current state.
- The footer line of a queue change that turns the queue on reads “Nothing changes until you select Turn queue on. Pomegr may then start queued tasks by itself on the computer that runs Pomegr, in Ready order, as each passes the start gates.”
- The footer line of a queue change that turns the queue off reads “Nothing changes until you select Turn queue off. No new task starts then, and running sessions continue.”
- No native dialog follows the Primary of a queue change.

### Unreadable proposal

- A proposal that could not be read draws no card.
- It draws only the shared warning notice (`.taskNotice.warning`).
- The notice reads “Aril wrote a proposal that Pomegr could not read, so there is nothing to apply. Ask for it again.”

## Composer

### Layout

- `.agentChatComposer` has a one-pixel rule above it.
- The composer holds these parts, from the top.

| Part | Contract |
| --- | --- |
| Alert line | One `role="alert"` line of fixed words for the last refused operation, in error-colored text, never a fill |
| Busy line | The muted line “Aril is answering in another conversation.”, while that is so |
| Image alert line | One `role="alert"` line of fixed words for the last image that was not added |
| Message field | A `textarea` named “Message Aril” with the placeholder “Ask about this board…” |
| Image strip | The images of the message being written, named “Images to send”, each with a **Remove image n** Icon action |
| Adding line | The muted `role="status"` line “Adding image…”, while an image is on its way to the desktop app |
| Action row | The **Attach image** Icon action, the **Run on** `CommandSelect`, the counter, and the Secondary **Send** |

- The message field has 13px text, and is one row that grows to six and then scrolls.
- The message field has a one-pixel `--command-line-strong` border, the control radius, the panel fill, and the shared focus ring.
- The options and defaults of **Run on** are the Task modal's. See [Run on and Effort](task-modal.md#run-on-and-effort).
- **Run on** starts from the open conversation's provider and model, else from Claude Code's default model.
- **Run on** leaves effort out.
- The counter is muted data-font text that reads “n / 4,000”.
- The counter appears only past 3,600 and takes the error color past 4,000.

### Images

- **Attach image** is an Icon action with the `plus` glyph that opens the file chooser for PNG, JPEG, GIF, and WebP.
- **Attach image** keeps the focus in the message field.
- **Attach image** is disabled with no repository and when the message holds four images.
- An image pasted into the message field is attached, and no text is pasted then.
- An image dropped on the composer is attached, and a dropped file is never opened or typed as its path.
- **Remove image n** is a 24px Icon action at the top right of its picture, with the panel fill and a one-pixel `--command-line-strong` border.
- **Remove image n** is 44px at 760px and narrower and on coarse pointers.
- An image that is not accepted is not sent to the desktop app.

| Fixed words of the image alert line | When |
| --- | --- |
| “Only PNG, JPEG, GIF and WebP images can be attached.” | The file is another type, or the desktop app found no image in it |
| “An image can be at most 5 MB.” | The file is empty or over the bound |
| “A message holds at most 4 images.” | The message holds four |
| “The image could not be attached.” | The desktop app did not answer |

### Keys and Send

- Enter sends.
- Shift+Enter makes a new line.
- The key that confirms an IME composition never sends.
- **Send** is disabled for an empty or over-long message, while a message or an image is on its way, while an answer is written elsewhere, and with no repository.
- A message that holds only images cannot be sent.
- While an answer is written in the open conversation, the Secondary **Stop** takes the place of **Send**.
- **Stop** also ends a follow-up, and takes back one that has not started.
- A message that was refused stays in the field, with its images.

### Fixed words of the alert line

| Fixed words | Note |
| --- | --- |
| “Aril is already answering. Wait for it to finish.” | None |
| “Claude Code is not installed on this computer.” | The line names the provider that was asked |
| “This repository holds 50 conversations. Delete one to start another.” | None |
| “This conversation is full. Start a new one.” | It replaces the line above when a conversation is open |
| “That conversation is no longer there.” | None |
| “That proposal was already answered.” | None |
| “That message could not be sent.” | None |
| “Aril could not be reached. Try again.” | None |
| “A session can be started from this chat only in the Pomegr desktop app.” | A session start that was applied outside the desktop window |

## Conversations

- The **Conversations** action replaces the message list with the conversation list.
- The list has a heading, the caption eyebrow “Conversations”.
- The list shows the saved conversations of the repository, newest first.
- A muted footnote reads “Conversations are kept on this computer until you delete them.”
- A row is a full-width button.
- A row holds a 13px/500 title that ends in an ellipsis and a muted data-font “n messages · date”.
- The open conversation is marked `aria-current="true"` on the raised fill.
- Choosing a row opens it and leaves the list.
- Each row ends with an Icon-role **Delete conversation** (a `trash` glyph).
- **Delete conversation** swaps in an inline question, a Secondary **Delete** and a Quiet **Keep**, and no native dialog.
- Focus starts on **Keep**, and Escape answers the question.
- **Delete conversation** is disabled for the conversation whose answer is being written.
- An empty list reads “No conversations yet.”
- **New conversation** opens an empty conversation, leaves the list, and focuses the field.

## Samples

- `/design-system` renders the Aril launcher in its three states.
- It renders the panel from invented conversations: empty, with a pending proposal holding all eight operations, with an answer being written, as the conversation list, with the notes under an answer and the unreadable-proposal notice, and with no repository.
- It renders the proposal card pending, with a delete, in flight, applied, partly applied, with a task that was not found, with every result word, and dismissed.
- It renders the session start proposed, held, failed, launched, and on a paired device.
- It renders the queue change proposed for on and for off, on a paired device, turned on, turned on and held, turned off, and not changed.
- It renders the composer with an error, over the limit, and while an answer is written elsewhere.
- It renders the answer text, including HTML and a link shown as literal text.
- The panel's own behavior (focus, Escape, the repository choice, polling, and the desktop bridge) is specified here but is not rendered there.
