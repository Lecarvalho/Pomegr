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
- Aril's message is full width with no fill.
- Aril's message starts with a head line of the 12px/600 name and a muted data-font caption “provider · model”.
- The caption reads “Claude Code · default model” when no model was chosen.
- The answer follows as Markdown.
- An answer that did not complete ends with one muted line of fixed words.

| Fixed words of an answer that did not complete |
| --- |
| “Stopped.” |
| “Aril could not finish this answer. Check that the provider's CLI is installed, signed in, and up to date.” |
| “This answer took too long and was stopped.” |
| “Pomegr closed before this answer was finished.” |

### While a turn runs

- The pending message of the owner is drawn once, and never again when it reaches the stored conversation.
- An agent block then holds the partial text.
- The agent block is in an `aria-live="off"` wrapper, so the log announces each stored message and not each chunk.
- A `role="status"` line holds one fixed word.
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

### Operations

- An ordered list follows the head, with one row for each operation.
- Each row is a fixed verb and a target set as text.
- Task IDs are in the data font.

| Operation | Row |
| --- | --- |
| **Create feature** | The name of the feature |
| **Create task** | The first line of its text clamped to two lines, with the whole text as its tooltip, and one muted 12px line of what is set |
| **Update T-n** | The board's current first line of that task in muted text, a muted line naming the changed fields, and, when the text changes, “New text:” and its first line |
| **Delete T-n** | The current first line, and “Cannot be undone” in the error color (text only, never a fill) |
| **Move T-n to column** | A muted “position n” follows |
| **Add T-n to queue** | Nothing more |
| **Remove T-n from queue** | Nothing more |
| **Move T-n to step n** | Nothing more |

- The line of what is set holds “in feature · step n”, provider, model, and effort, “Complete when: PR open, CI passed”, and “then add to queue”.
- **Update T-n** leaves the current first line out when the board does not hold the task.

### Results

- Once the proposal ran, each row ends with its result in 12px/500 text.

| Result | Tone |
| --- | --- |
| “Done”, or “Created T-n” for a new task | Green |
| “Not valid”, “Not found”, “Board is full”, “No longer possible”, “Not supported”, or “Pomegr did not answer” | The error color |
| “Created T-n, but it could not be queued”, for a task that was created and could not be queued | The error color |
| “Not run”, for an operation after the one that failed | Muted |

### Footer

- Only a pending proposal has a footer: the Primary **Apply changes** and the Quiet **Dismiss**.
- Both actions are disabled and the card is `aria-busy` while the answer is in flight.
- The footer holds the muted line “Nothing changes until you apply.”
- The line adds “Deleting cannot be undone.” when the proposal deletes a task.
- Each pending card has its own Primary, so a conversation may hold more than one.
- After a successful apply, the board is read again.

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
| Message field | A `textarea` named “Message Aril” with the placeholder “Ask about this board…” |
| Action row | The **Run on** `CommandSelect`, the counter, and the Secondary **Send** |

- The message field has 13px text, and is one row that grows to six and then scrolls.
- The message field has a one-pixel `--command-line-strong` border, the control radius, the panel fill, and the shared focus ring.
- The options and defaults of **Run on** are the Task modal's. See [Run on and Effort](task-modal.md#run-on-and-effort).
- **Run on** starts from the open conversation's provider and model, else from Claude Code's default model.
- **Run on** leaves effort out.
- The counter is muted data-font text that reads “n / 4,000”.
- The counter appears only past 3,600 and takes the error color past 4,000.

### Keys and Send

- Enter sends.
- Shift+Enter makes a new line.
- The key that confirms an IME composition never sends.
- **Send** is disabled for an empty or over-long message, while a message is on its way, while an answer is written elsewhere, and with no repository.
- While an answer is written in the open conversation, the Secondary **Stop** takes the place of **Send**.
- A message that was refused stays in the field.

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
- It renders the composer with an error, over the limit, and while an answer is written elsewhere.
- It renders the answer text, including HTML and a link shown as literal text.
- The panel's own behavior (focus, Escape, the repository choice, polling, and the desktop bridge) is specified here but is not rendered there.
