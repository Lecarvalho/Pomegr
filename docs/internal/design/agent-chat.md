# Agent chat design

> Scope: the Aril chat, its launcher, panel, repository choice, thread, search, messages, answer text, proposal card, choices, and composer, and the composer with its suggestion chips as Home draws them.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/components/agent-chat/`, `app/styles/agent-chat.css`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

The **Aril** chat is a panel docked to the right edge of the window, below the header, where the owner talks to Aril, the Pomegr task-board agent.

The runs, the proposals, and the privacy rules of the chat are in [Agent chat](../architecture/agent-chat.md).
The task board is in [Task board design](task-board.md).

## Composition

- The chat is `AgentChatDock` and its siblings in `app/components/agent-chat/`, with styles in `app/styles/agent-chat.css`.
- The chat is a composition of the existing roles, chips, `CommandSelect`, notices, and tokens.
- The chat adds no button role.
- The round **Send** and **Stop** compose the Icon role, and the composer has its own radius. [DESIGN.md](../../../DESIGN.md#agent-chat-exceptions) records both as intended exceptions.
- `AppShell` mounts the chat once, after the shell.
- The chat is drawn only where it can be reached: the desktop app and a paired phone, and only while Aril is On ([While Aril is Off](#while-aril-is-off)).
- That decision is made before anything is drawn.
- A client that is still being identified draws nothing.
- A browser on the same computer draws nothing.
- So the launcher is never drawn and then taken away.
- The chat holds no data of its own.
- The thread and the answer being written come from `useAgentChat`, and the search matches from `useAgentChatSearch`.
- The board rows come from `useTasks`.
- The repositories come from the inventory.
- The only thing the chat writes to browser storage is the last repository ID (`pomegr.agentChat.repository`), never a message.
- The composer on Home reads and writes the same key.
- Home's focus mode on a phone keeps one more value, which is a keyboard height and not chat content. [Home design](home.md#the-keyboard-height-home-remembers) owns it.

## Launcher

- `.agentChatLauncher` is shell chrome like the header icon buttons (`.commandIconButton`), not a seventh role.
- The launcher is `position: fixed`, 16px from the right and bottom edges, and clear of the safe area.
- The launcher is 36px high, and 44px at 760px and narrower and on coarse pointers.
- The launcher has the panel fill, a one-pixel `--command-line-strong` border, the control radius, and the overlay shadow.
- The launcher holds a 16px `spark` glyph in the brand text color and the name **Aril** at 13px/500.
- The accessible name is “Open Aril, the Pomegr agent”.
- `aria-expanded` and `aria-controls` name the panel.
- The launcher is hidden while the panel is open.
- The launcher is not drawn on Home, where the composer is the way in. [Composer on Home](#composer-on-home) says what follows.
- The z-index of the launcher is 85: above the sidebar and the header, below the agent inspector sheet (90) and the select list (120).
- The z-index of the docked panel is 75, below the header (80), so the notification tray and the profile menu open over it.
- The z-index of the scrim is 74: above the sidebar, below the panel.
- The z-index of the phone sheet is 85.

| State | Label | Accessible name |
| --- | --- | --- |
| An answer is being written and the panel is closed | The label reads “Aril · answering…” | Adds “answering” |
| An answer finished while the panel was closed | A 7px `--command-brand` dot follows the name | Adds “new answer” until the panel is opened |

- Both states follow a turn of the open conversation that another device started, once the open panel has seen it.
- A turn that another device starts while the panel is closed and idle does not change the launcher, because that panel asks the chat nothing. The dock asks one thing, whether Aril is On.

## While Aril is Off

- With Aril Off there is no Aril: the dock draws nothing. There is no launcher, no panel, no scrim, and no expanded page, on the desktop and on a paired phone.
- The dock draws nothing either before the desktop has said whether Aril is On. So the chat is never drawn and then taken away, and an Off Aril never flashes a launcher.
- A client that cannot read the switch, such as an older desktop, draws nothing.
- A panel that is open when Aril turns Off closes with the rest of the dock, and its draft goes with it. A message that was being written is stopped by the desktop ([The switch](../architecture/agent-chat.md#the-switch)).
- A link to the chat, such as a grant follow-up's notification or one clicked in the app, lands on Home instead.
- The dock asks for the switch every five seconds for as long as it is mounted, together with Home and Settings, so a switch turned on the other device reaches it. A failed ask keeps what was known.
- Nothing says that Aril is off: Settings › Aril does. The stored thread is kept and shows again, as it was, when Aril is turned On.
- The owner's decision of 2026-10-30 settled this: Off hides the chat everywhere.

## Panel

### Layout

- `.agentChatPanel` is a non-modal `<section aria-label="Aril, the Pomegr agent">`.
- Wider than 760px, the panel is docked: `position: fixed` to the right edge, from the bottom of the shell header to the bottom of the window.
- The top edge of the panel is the shell's header height, token `--command-header-height`.
- The panel is 520px wide, and never wider than the content area (`min(520px, 100vw - --command-rail-width)`).
- The panel has the panel fill, a one-pixel `--command-line` left line, no radius, and no shadow.
- The panel is a column of header, body, and composer.
- The panel lays over the page and does not move it: the page keeps its width, its layout, and its scroll position.
- While the panel is open and wider than 760px, `AgentChatDock` draws the scrim (`.agentChatScrim`) over the page below the header, behind the panel.
- The scrim covers the rail too, and the header stays above it.
- The scrim has the `--command-scrim` fill (black at 10% in light mode and 18% in dark mode) and no blur.
- The scrim is a button that is out of the tab order and `aria-hidden`, because the keyboard has **Close Aril** and Escape.
- A click on the scrim closes the panel exactly like **Close Aril**: the panel stays mounted, the draft is kept, and focus returns to the launcher.
- The scrim fades in with the panel, and the fade is removed under `prefers-reduced-motion`.
- The header action **Expand** changes the panel to `expanded`, and **Dock** changes it back.
- Expanded, the panel covers the whole content area, from the rail's right edge (`--command-rail-width`) to the right edge of the window, and the scrim dims the rail beside it.
- Expanded, the log, the search, and the composer sit in a centered column of at most 760px, and the header keeps the full width.
- The dock keeps the mode in memory while the app runs and never writes it to browser storage.
- At 760px and narrower, the panel is a full-screen sheet (`inset: 0`, z-index 85, no border, padded by the safe area) with 44px targets.
- At 760px and narrower, **Expand** is not drawn and the scrim is not drawn.
- The only motion is a 140ms opacity fade when the panel opens, removed under `prefers-reduced-motion`.
- The panel is built the first time it opens and is then kept, hidden, while closed.
- So the draft and the scroll position survive.
- The chat asks the desktop only while the panel is open or an answer is being written.
- A closed, idle panel asks nothing.
- An open panel that follows no answer asks for the conversation list every five seconds, on the desktop and on a paired device.
- So a message sent from another device, and the turn it starts, reach an open panel without reopening it.
- A turn started elsewhere shows as the panel's own: the answer text, the activity line, Stop in place of Send, then the stored messages.
- A newer update time in that list reads the thread's newest page again, so a turn that ended between two asks still shows.
- The panel reads the thread's newest page every poll interval while an answer is written, and older pages only on request.

### Header

- The header (`.agentChatHeader`) has a one-pixel rule below it.
- The header holds the `spark` glyph and the 16px/650 `h2` **Aril**, and, once the desktop has answered, the state of Aril as a `.commandChip`: **On** in the positive tone, **Off** in the neutral tone (never amber: Off is a choice, not a fault).
- Nothing is drawn for a state that is not known yet, so the chip is never drawn and taken back. The panel exists only while Aril is On, so the chip reads **On** whenever it is seen; its **Off** form is kept for the component and has no panel to appear in. The dock asks for the state every five seconds.
- The header has no other caption.
- The header ends with three [Icon](../../../DESIGN.md#buttons)-role actions, each with an `aria-label` and a `title`.
- **Search** has a `search` glyph and `aria-pressed`.
- The pressed state of **Search** takes the raised fill, a local toggle state of the role.
- The header has no conversation list, no **Conversations** action, and no **New conversation** action: the repository has one thread.
- **Expand** has an `expand` glyph and `aria-pressed`.
- The pressed **Expand** is named **Dock** and has a `dock` glyph.
- **Close Aril** has a `close` glyph.
- **Close Aril** closes the panel and keeps it mounted, and the launcher returns.

### Repository

- The chat belongs to one repository.
- A `CommandSelect` named **Repository** sits in the composer's action row, right after **Attach image**.
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

- Opening moves focus to the message field, or to **Close Aril** when the field is disabled.
- **Close Aril** and Escape close the panel and return focus to the launcher.
- **Expand** and **Dock** keep focus on themselves.
- Escape first belongs to a layer inside the panel: an open `CommandSelect` list, or the open search.
- The panel never traps focus.
- Nothing moves focus while an answer is written.
- The message field asks the desktop to [warm a run](../architecture/agent-chat.md#the-warm-run) while it keeps its focus. The ask has no sign: it adds no line, no spinner, no state, and no word to the field, the composer, or the panel.
- The ask waits 250ms (`WARM_DEBOUNCE_MS`) after the field gains focus, so the panel's own focus as it opens and a click into the field ask once, and a field that loses focus within the pause asks nothing.
- The ask also waits for the thread to be read, so it names the run the composer shows (the thread's last run, or what the owner chose), and a change of that run while the field keeps its focus asks again.
- Focus that returns to the field is another ask. Closing the panel is no ask and ends nothing: the desktop's idle clock alone closes a run that waits.

## Search

- **Search** opens the search under the header: `.agentChatSearch`, a `role="search"` region named “Search the conversation”, holding a field and the matches below it.
- The search region is as wide as the panel, at most 45% of its height, and scrolls inside that height.
- The field is `type="search"`, named “Search messages”, with the placeholder “Search messages…” and at most 100 characters.
- The field has the raised fill (`--command-panel-2`), the control radius, 13px text, and no border.
- The browser's own clear button is not drawn.
- The field shows no focus ring when it is focused: the caret marks focus. [DESIGN.md](../../../DESIGN.md#agent-chat-exceptions) records the exception.
- Focus moves to the field when the search opens.
- Escape closes the search, empties the field, and returns focus to **Search**, and it does not close the panel then.
- **Search** closes the search the same way, and sending a message closes it.
- The search asks the desktop 250ms after the last key, and asks nothing for a field that holds only spaces.
- The matches are a list named “Matching messages”, newest first, at most 20.
- A match is a full-width button row with a minimum height of 32px, and 44px at 760px and narrower and on coarse pointers.
- A match has two lines: who wrote the message, **You** or **Aril** in 12px/600, with its time; and a plain excerpt in muted 13px text.
- The time of a match reads as a message time does: `HH:MM` for today, and `Mon D, HH:MM` for an earlier day.
- The excerpt shows the searched text where it occurs, in the ink color at weight 650, whatever its case.
- A row has a 6% ink tint on hover and the shared focus ring.
- Choosing a match closes the search and brings its message into view as the [Thread](#thread) rules say.
- The search has one quiet line in each of three states, in muted 12px text.

| State | Line |
| --- | --- |
| Nothing typed | “Search the messages of this repository.” |
| No match | “No messages match.” |
| The desktop did not answer | “Search could not be reached. Try again.” |

## Thread

- The log shows one thread for each repository: its saved conversations as one continuous conversation, in the order of the time of each message.
- The panel offers no way to choose, start, or delete a conversation, and it never says in which conversation a message is stored.
- A message that follows one from another conversation is drawn like any other: nothing marks the boundary.
- The log opens on the newest line.
- Scrolling to within 80px of the first message loads the page of messages before it, at most 60.
- A log whose messages do not fill its height loads the page before them, once it has a height.
- A quiet status, “Loading earlier messages…”, floats at the top center of the log while a page loads. It sits over the log, so the log does not move for it.
- Older messages added above leave the lines the owner reads where they were: the browser's scroll anchoring is off for the log, and the panel keeps the place.
- A message that is brought into view is loaded first, by loading older pages, at most ten.
- It is then scrolled to the middle of the log and marked for two seconds: the raised fill behind it, with the owner's bubble one step lighter.
- A follow-up's notification link and a match the owner chose in the search bring a message into view in the same way.
- A message that no page holds is not reached, and the log stays where it was.
- **Apply changes**, **Dismiss**, and the other card actions belong to the proposal's own conversation, which the panel finds from the message.
- An answer being written, and a follow-up that waits for the one turn, show in the thread wherever they run: the panel has no note of another conversation.

## Messages

### Log

- The body is a `role="log"` region named “Conversation with Aril”.
- The log is itself a focusable scroller with 16px padding and a 16px gap.
- The log keeps the newest line in view only while the owner is at the bottom.
- Once the owner scrolls up, the log stays where they are.
- A Quiet **Jump to latest** brings the log back to the newest line.
- **Jump to latest** has the panel fill and a one-pixel line, and sits at the bottom right of the log; its fill is opaque, hover included, so the log never shows through.

### Owner and Aril

- The owner's message is a block at the right, at most 85% wide, made of a bubble and its time.
- The bubble has the raised fill (`--command-panel-2`), the control radius, and 13px text, with its line breaks kept.
- The images of the owner's message follow its text inside the bubble as an image strip named “Images you sent”. See [Image strip](#image-strip).
- The time of the owner's message sits below the bubble, right-aligned.
- Aril's message is full width with no fill.
- Aril's message starts with a head line of the 12px/600 name, its time, and a muted data-font caption “provider · model · Effort”.
- The caption leaves the effort out for an answer that stored none, and the answer being written shows the effort of its turn.
- The effort reads as the Effort field of the Task modal labels it.
- The caption reads “Claude Code · default model” for an older answer with no model.
- A grant follow-up is drawn as a quiet line and not as a message: a 14px `spark` glyph, its text, and its time, all muted, with no head, no caption, and no bubble.
- A grant follow-up never draws a card (T-183).
- A grant follow-up notification opens the panel in its repository, and brings the follow-up into view.
- The answer follows as Markdown.
- An answer that did not complete ends with one muted line of fixed words.
- Aril's follow-up after an applied or dismissed proposal is drawn as any message of Aril, with no message of the owner before it.
- An eligible follow-up proposal draws the same pending card as any other proposal.
- Its card has its own Apply and Dismiss actions.
- A rejected or ineligible follow-up block draws no card and uses the unreadable-proposal notice.
- A follow-up that could not be written is drawn as an answer that did not complete, with the same fixed words.

| Fixed words of an answer that did not complete |
| --- |
| “Stopped.” |
| “Aril could not finish this answer. Check that the provider's CLI is installed, signed in, and up to date.” |
| “This answer took too long and was stopped.” |
| “Pomegr closed before this answer was finished.” |

### Message time

- Every message shows its time: the owner's message, Aril's answer, the answer being written, and a quiet line.
- A time is a `<time>` element whose `dateTime` is the stored instant and whose `title` is the whole local date and time.
- The `title` of the time of an answer that Pomegr measured adds a second line: “Started 1.2s · first words 6.8s · done 11.4s”.
- The seconds have one decimal, and a step the run never reached is left out.
- An answer that a [warm run](../architecture/agent-chat.md#the-warm-run) gave reads “Started 0.1s (warm)” in place of “Started 0.1s”. The words “(warm)” are fixed and come after the seconds of the start; an answer with no start has no such words.
- A timing that holds an [effort routing](../architecture/agent-chat.md#effort-routing) record adds one line right under the date: “Effort low, chosen by Jev in 0.4s”.
- When the run kept the owner's effort, that line reads “Effort high, your choice (Jev agreed in 0.4s)”, and in place of the parenthesis “Jev did not answer in time”, “Jev was not reachable”, “Jev's answer was not usable”, or “a message with images is not sent to Jev”. No effort chosen reads “Effort default”.
- A timeout adds where the call waited, after “Jev did not answer in time”: “, looking up its address”, “, connecting”, or “, waiting for its answer”. A timeout with no phase reads as before.
- `routeLine` in `agent-chat-presentation.ts` builds that line from a fixed shape; no error text is ever placed in it.
- A timing that holds the preparation adds a line above it: “Prepared in 3.2s (slowest: GitHub 2.9s)”.
- The slowest step is named in fixed words, only when it took a tenth of a second or more; a quicker preparation reads “Prepared in 0.2s”.
- An answer with no timing keeps the date and time alone, and the time itself still reads the clock.
- `prepareLine`, `timingLine`, and `answerTimeTitle` in `agent-chat-presentation.ts` build the words from numbers only.
- A time is muted `--text-xs` text in the data face.
- A time reads `HH:MM` (24-hour, local) for a message of today.
- A time reads `Mon D, HH:MM` for a message of an earlier day.
- The day is decided in the owner's local time.
- A message whose time cannot be read draws no time.
- `formatMessageTime` and `fullMessageTime` in `agent-chat-presentation.ts` build the words.

### Summary line

- Where Pomegr summarized the older messages for Aril, the log draws one quiet line after the newest message the summary covers.
- The line is a 14px `history` glyph, the words “Earlier messages summarized for Aril”, and the time the summary was written, all muted.
- It is drawn like the grant follow-up line, in a `.agentChatQuietLine`, and it adds no style of its own.
- It is not a message: it has no head, no bubble, no card, and no address, and the search never finds it.
- The words are fixed. The desktop sends the panel only a position and a time, never the summary.
- The messages above the line stay in the log, readable and searchable.
- A summary whose message is on an older page that is not loaded yet draws no line until that page loads.
- When the message is gone, the line follows the last message before the time the summary ends at.
- A thread that was never summarized draws no line.
- The panel reads the thread again when a summary is written, so the line appears without a new message.
- `SUMMARIZED_LINE` in `agent-chat-presentation.ts` holds the words.

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
- The pending message of the owner shows the time it was sent, and its answer's head shows that time until the turn reports its own start.
- The answer being written shows the time its turn started in its head.
- The pending message shows its images from the files the owner added, so they do not load again.
- An agent block then holds the partial text.
- The agent block is in an `aria-live="off"` wrapper, so the log announces each stored message and not each chunk.
- A `role="status"` line holds one fixed word.
- After **Apply changes**, **Start session**, a queue Primary, or **Dismiss**, the agent block of the follow-up is drawn the same way, with no pending message.
- “Starting…” shows only until the provider process writes its first event; from then on the word is “Thinking…” until a tool, the text, or another block changes it.
- A follow-up that waits for the one turn reads “Starting…”.
- The panel asks for no follow-up: it reads the turn that the desktop app started.
- The fixed word is “Starting…”, “Thinking…”, “Reading repository files…”, “Reading sessions…”, “Reading usage limits…”, or “Writing…”.

### Loading and empty states

- Before the first read of the thread has answered, the log reads a quiet “Loading…”.
- The log never shows an empty state that is then replaced.
- The empty state shows when the thread holds no message and has been read.
- The empty state starts with a 14px/650 “Ask Aril about this board” and one muted 12px sentence.
- Four full-width Secondary rows follow, and they only fill the message field.
- The rows read “Break this feature into tasks: ”, “Which task should run first, and why?”, “Is any task too big for one session?”, and “Which model fits this kind of task: ”.
- A muted caption reads “Aril can be wrong. Check a proposal before you apply it.”

### Answer text

- `SafeMarkdown` builds React elements from the answer and sets no HTML.
- The renderer uses `react-markdown@10.1.0` with `remark-gfm@4.0.1`.
- It renders paragraphs, headings as styled lines, fenced code, inline code, bold, italic, strikethrough, and escapes.
- It renders GFM tables, blockquotes, rules, nested ordered and unordered lists, and task lists.
- Raw HTML and images stay literal source text.
- Links stay literal in agent chat and task report notes.
- Bare URLs, reference links, and footnotes stay literal even when a caller supplies a link opener.
- Task-list checkboxes are non-interactive glyphs labelled Checked or Unchecked, never inputs.
- Tables scroll horizontally inside their message without widening the panel.
- Table cells use `--space-1` by `--space-3` padding and `--command-line` row rules, with no zebra fill.
- Table headers have weight 650.
- Blockquotes use muted ink and a left rule in `--command-line-strong`.
- Horizontal rules use `--command-line`.
- Task report notes share this renderer and keep their amber inline-code fill through the notice's CSS scope.
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
- The card of a worktree removal is a region named “Proposed worktree removal”.
- A worktree removal in which every worktree was removed has the chip **Applied**, and one that kept a worktree has **Partly applied**.

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
| **Remove worktree for T-n** | A muted 12px line: “Also delete its task branch when safe.” or “Keep its task branch.” |
| **Turn the queue on** | Nothing more |
| **Turn the queue off** | Nothing more |

- The line of what is set holds “in feature”, provider, model, and effort, “Complete when: PR open, CI passed”, and “then add to queue”.
- The line of what is set of **Create task** adds “with 1 image” or “with n images”, and the image strip follows it.
- **Attach n images to T-n** reads “Attach 1 image to T-n” for one image.
- **Update T-n** leaves the current first line out when the board does not hold the task.
- **Start a session for T-n** is the only row of its card.
- **Turn the queue on** or **Turn the queue off** is the only row of its card.
- A worktree removal card holds one **Remove worktree for T-n** row for each worktree, and nothing else.

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
| “Worktree removed”, for a worktree that was removed | Green |
| “Worktree kept: uncommitted changes”, “Worktree kept: commits exist nowhere else”, or “Worktree kept: task or review is running” | The error color |
| “Worktree removal failed”, for a worktree that Git or the file system would not remove, and “Not found”, for one that is not there | The error color |
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
- The Primary of a worktree removal reads **Remove worktree** for one worktree and **Remove worktrees** for more.
- The footer line of a worktree removal reads “Nothing is removed until you apply. Pomegr keeps any worktree with uncommitted changes or commits that exist nowhere else.”
- On a paired device a worktree removal has no Primary, only **Dismiss**, and its footer line reads “Aril's worktree removal can be applied only in the Pomegr desktop app.”
- On a paired device a proposal that renames, marks done, reopens, or deletes a feature has no Primary, only **Dismiss**, and its footer line reads “This proposal changes a feature, so it can be applied only in the Pomegr desktop app.”
- A worktree removal does not stop at a worktree it kept: every row shows its own result.

### Unreadable proposal

- A proposal that could not be read draws no card.
- It draws only the shared warning notice (`.taskNotice.warning`).
- The notice reads “Aril wrote a proposal that Pomegr could not read, so there is nothing to apply. Ask for it again.”

## Choices

- Aril may end an answer with quick replies or with one multiple-choice question, never both.
- The choices sit inside Aril's message, after its text and its notes.
- A choice only sends its label as the owner's own message, with the repository, model, and effort that the composer shows.
- A choice applies, starts, and changes nothing by itself.
- A choice leaves the message field as it is, so a draft stays.
- Sending a choice closes the search, as sending a message does.
- An answer that carries a proposal draws no choices: the proposal has its own **Apply changes** and **Dismiss**.
- A grant follow-up line draws no choices.
- A block that Pomegr could not read draws nothing and no notice: the answer text stays.

### Quick replies

- `.agentChatReplies` is a list named “Quick replies” that wraps, with an 8px gap.
- It holds 1 to 4 replies, each one line of at most 40 characters, and no two the same whatever their case.
- A reply (`.agentChatReply`) is a [Quiet](../../../DESIGN.md#buttons) button with the raised `--command-panel-2` fill, ink text, no border, and the control radius.
- A reply is 32px high with 12px side padding, and 44px at 760px and narrower and on coarse pointers.
- A reply wraps its label rather than widen the panel.
- Hover takes a 10% ink tint over the raised fill.
- A reply keeps the shared focus ring.
- A reply is the Quiet role with a local fill, as **Jump to latest** is the Quiet role with a local line. It is not a seventh role.

### Multiple-choice question

- `.agentChatQuestion` is a group named by its question.
- The question is a `--text-sm` line of weight 600, at most 120 characters, above the options.
- The question is in the block and not in the answer text, so it is not said twice.
- The options are a list of 2 to 4 rows, 4px apart.
- A row (`.agentChatChoice`) is a full-width Quiet button with the raised fill and 8px by 12px padding.
- A row holds the label over a detail.
- The label is `--text-xs` at weight 500, at most 60 characters.
- The detail is muted `--text-caption`, one line of at most 120 characters.
- The first option is the one Aril recommends, and its label is followed by a neutral `.commandChip` **Recommended**.
- A row is at least 44px high at 760px and narrower and on coarse pointers.
- The panel draws no option for a free answer: the composer is the free answer.

### When choices can be tapped

| State | When | Look |
| --- | --- | --- |
| Active | The choices of the newest answer, while no message is on its way and no turn runs | Buttons |
| Waiting | The same choices while a turn runs, one that another device started included | The same buttons, disabled |
| Past | The owner sent anything after the answer, a newer answer came, or a message is on its way | Quiet text, not buttons |

- The newest answer is the newest message of Aril's own run, so a grant follow-up line does not end the choices before it.
- Past replies and rows keep their order, with muted `--text-xs` text and no fill.
- The choice the owner picked is the one whose label is the owner's next message.
- The picked choice reads in ink at weight 650 and follows its label with a neutral `.commandChip` **Chosen**.
- When the owner answers in their own words, nothing is marked.
- A choice sent by the keyboard returns focus to the message field, because the buttons leave the page.
- A choice sent by a pointer moves no focus, so a tap on a phone opens no keyboard.

## Composer

### Layout

- `.agentChatComposer` is a form with no border, the raised fill (`--command-panel-2`), and the 12px `--composer-radius`.
- The composer has 12px of padding and an 8px gap between its parts.
- The composer sits inset from the panel edges: 16px at the sides and the bottom, and 12px at 760px and narrower.
- The composer holds these parts, from the top.

| Part | Contract |
| --- | --- |
| Alert line | One `role="alert"` line of fixed words for the last refused operation, in error-colored text, never a fill |
| Image alert line | One `role="alert"` line of fixed words for the last image that was not added |
| Message field | A `textarea` named “Message Aril” with the placeholder “Ask Aril…” |
| Image strip | The images of the message being written, named “Images to send”, each with a **Remove image n** Icon action |
| Adding line | The muted `role="status"` line “Adding image…”, while an image is on its way to the desktop app |
| Action row | **Attach image**, the **Repository** `CommandSelect` when more than one repository is listed, a spacer, the **Model** `CommandSelect`, the **Effort** `CommandSelect`, the counter, and the round **Send** or **Stop** |

- The message field has 13px text, and is one row that grows to six and then scrolls.
- The message field has no border and a transparent fill, so the composer's fill shows through.
- The message field shows no focus ring when it is focused: the caret marks focus. [DESIGN.md](../../../DESIGN.md#agent-chat-exceptions) records the exception.
- Every button and select in the composer keeps the shared focus ring for keyboard users.
- Every button and select trigger in the composer has no frame: a transparent fill, no border, and a 6% ink tint on hover and while open.
- The select triggers in the composer are 32px high with muted 14px text, and 44px on phone and coarse pointers.
- The **Repository** options are the listed repositories, and the choice remounts the body as the [Repository](#repository) rules say.
- The counter is muted data-font text that reads “n / 4,000”.
- The counter appears only past 3,600 and takes the error color past 4,000.

### Model and effort

- **Model** is a `CommandSelect` named **Model**, and its closed control reads the model alone.
- The options are the named models of each provider under a heading for the provider: the Claude models of the Task modal's Run on list, sorted, and the Codex catalog in its order. See [Run on and Effort](task-modal.md#run-on-and-effort).
- The list never offers a default model, and no control in the composer reads “default”.
- A provider with no known model has one row labelled with the provider's name and no heading, so the provider can still be chosen.
- The model of the thread's last run is listed even when the known models no longer include it.
- The initial model is the model of the thread's last run, else the newest known Claude model, else the newest known Codex model.
- The last run of a thread is that of its newest conversation that is not a grant follow-up conversation.
- A last run with no model shows the newest known model of its provider.
- The newest model has the highest version, then the latest date (`newestModel` in `shared/task-run-models.mjs`).
- **Effort** is a `CommandSelect` named **Effort** with **Low**, **Medium**, **High**, and **Xhigh**, labelled as the Task modal labels them.
- The initial effort is the effort of the thread's last run, else **Medium**.
- Choosing a model keeps the effort, and choosing an effort keeps the model.
- The choice lasts while the panel stays on the repository, and each send carries both.
- Both selects follow the composer's rule: no frame, a 6% ink tint on hover, and a visible ring on keyboard focus.

### Images

- **Attach image** is an Icon action with the `plus` glyph that opens the file chooser for PNG, JPEG, GIF, and WebP.
- **Attach image** keeps the focus in the message field.
- **Attach image** is disabled with no repository and when the message holds four images.
- An image pasted into the message field is attached, and no text is pasted then.
- An image dropped on the composer is attached, and a dropped file is never opened or typed as its path.
- **Remove image n** is a 24px Icon action at the top right of its picture, with the panel fill and no border.
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
- **Send** is disabled for an empty or over-long message, while a message or an image is on its way, and with no repository.
- A message that holds only images cannot be sent.
- **Send** is a round 32px action composed from the Icon role, with the brand fill, `--command-on-brand` ink, and an up-arrow (`send`) glyph, named “Send”.
- While an answer is written in the open conversation, **Stop** takes the place of **Send**: the same round action with a square (`stop`) glyph, named “Stop”.
- **Send** and **Stop** are 44px at 760px and narrower and on coarse pointers, and stay round.
- **Stop** also ends a follow-up, and takes back one that has not started.
- A message that was refused stays in the field, with its images.

### Fixed words of the alert line

| Fixed words | Note |
| --- | --- |
| “Aril is already answering. Wait for it to finish.” | None |
| “Claude Code is not installed on this computer.” | The line names the provider that was asked |
| “That message is no longer there.” | None |
| “That proposal was already answered.” | None |
| “That message could not be sent.” | None |
| “Aril could not be reached. Try again.” | None |
| “This proposal can be applied only in the Pomegr desktop app.” | A proposal that only the desktop window applies was applied elsewhere |

## Composer on Home

- Home draws the same `AgentChatComposer` as the panel. It has the same parts, fills, radius, rings, keys, and fixed words.
- The composer on Home fills the Home column. It has no outer margin, because it does not sit in a panel.
- The message field is named “Message Aril” and has the placeholder “Ask Aril…”.
- The **Repository** choice is drawn when more than one repository is listed, as in the panel.
- The first repository is the last one used, else the first listed.
- Choosing a repository keeps the draft and drops the images and the choice of model and effort.
- Choosing a repository stores its ID in the same key as the panel.
- The first model and effort follow [Model and effort](#model-and-effort).
- Home reads the thread once for each repository the composer shows, only to learn the run of its last turn.
- **Stop** is never drawn on Home, because Home follows no turn.
- The composer is disabled with no repository.
- Focusing the message field starts focus mode, which lifts the composer. [Focus mode](home.md#focus-mode) owns it.

### Send from Home

- **Send** hands the message to the dock. The dock opens the maximized panel on the thread of that repository, and the panel sends the message.
- The panel sends it as if the owner typed it there: the same `send` operation, with the model and effort the Home composer showed.
- Home does not open the docked panel. [Panel opened from Home](#panel-opened-from-home) says what the owner sees.
- On a phone, the panel opens as the full-screen sheet.
- Home then clears its field and its images.
- A message that the desktop refuses goes back to the panel's field with the images, and the fixed alert line says why. Nothing is lost.
- A message waiting in the panel's field is kept. A message from Home never replaces it.
- The handoff is a window event, `pomegr:send-aril-chat`. It carries the repository ID, the text, the provider, the model, the effort, the image IDs, and the screen position of the Home composer.
- The event writes nothing to browser storage.
- Home shows no sign of an answer being written or of a new answer. The launcher's states return when the owner leaves Home.

### Suggestion chips

- The chips are a list named **Suggestions** above the composer, at most three, in one row that wraps.
- A chip (`.agentChatSuggestionChip`) is a [Quiet](../../../DESIGN.md#buttons) button with the raised `--command-panel-2` fill, ink text, no border, and the `--composer-radius`.
- A chip is 32px high with 12px side padding, `--text-xs` text, and 44px high at 760px and narrower and on coarse pointers.
- A chip wraps its label rather than widen the column.
- Hover takes a 10% ink tint over the raised fill. A chip keeps the shared focus ring.
- A chip puts its words in the message field, replacing the draft, and moves focus to the field. It starts focus mode, and it sends nothing.
- The words are fixed. A fixed rule picks the first three of this list whose condition holds. No model picks them.

| Order | Words | Condition |
| --- | --- | --- |
| 1 | “What needs my attention first?” | Needs you holds a line |
| 2 | “Which task should run first, and why?” | A board holds a task in Backlog, Ready, or In progress |
| 3 | “Is any task too big for one session?” | The same |
| 4 | “Break this feature into tasks: ” | Always |
| 5 | “Which model fits this kind of task: ” | Always |

## Panel opened from Home

- The panel that Home opens is the existing expanded panel. It has the same header, log, search, and composer in the centered column. No second chat view exists.
- The dock opens it expanded, whatever mode it had. The dock keeps that mode, and restores it when the panel closes.
- A panel that was docked is docked again after the close, and a panel that was expanded stays expanded.
- For 2.2 seconds after it opens, the panel has the class `isEntering`.
- While it has the class, each message of the log fades in over 420ms and rises 8px, one after another, the newest last.
- The last six messages start 80ms apart, and the earlier ones start with the first.
- The composer of the panel starts where the composer of Home was on the screen, and settles to its place at the bottom.
- The settle takes 480ms with the curve `cubic-bezier(.2, .8, .2, 1)`. The dock does it with a transform that it removes at the end.
- Reduced motion removes the fade and the settle: the log and the composer are where they belong at once.
- Closing the panel with **Close Aril**, Escape, or the scrim gives the page back to Home. The dock tells Home with the window event `pomegr:aril-chat-closed`.
- After the close, focus goes to the Home page, never into the composer of Home, which would lift it again.
- **Dock** inside the panel docks it over Home. Home stays hidden behind the scrim until the panel closes.

## Samples

- `/design-system` renders the Aril launcher in its three states.
- It renders the panel from invented threads: empty, with a pending proposal holding all eight operations, with an answer being written, with quiet activity lines, with the line where earlier messages were summarized and the timing in the tooltip of a measured answer, with the search open and with a search that found nothing, while earlier messages load, with the notes under an answer and the unreadable-proposal notice, and with no repository.
- It renders the expanded panel, with the log and the composer in their centered column.
- It renders the proposal card pending, with a delete, in flight, applied, partly applied, with a task that was not found, with every result word, and dismissed.
- It renders the session start proposed, held, failed, launched, and on a paired device.
- It renders the queue change proposed for on and for off, turned on, turned on and held, turned off, and not changed.
- It renders the panel with quick replies, answered, and waiting, and with a multiple-choice question, open and answered.
- It renders the composer with a repository choice, with the model and the effort, with no known model, with an error, and over the limit.
- It renders the composer as Home draws it, with the suggestion chips above it, and in focus mode, lifted, with the overlay shadow and the hint.
- It renders no panel, launcher, or composer for Aril Off, because nothing is drawn then.
- It renders the panel over a dimmed page, with the scrim.
- It renders the answer text, including HTML and a link shown as literal text.
- The panel's own behavior (docking, the room the page makes for it, focus, Escape, the repository choice, loading older pages, bringing a message into view, polling, and the desktop bridge) is specified here but is not rendered there.
