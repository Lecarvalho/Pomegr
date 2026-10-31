# Home design

> Scope: the Home page: its date and greeting, the last-24-hours tiles, Needs you, Continue, the What's new card and dialog, and the composer with its suggestions and focus mode.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> The composer and the suggestion chips are specified in [Agent chat design](agent-chat.md#composer-on-home).
> Related code and checks: `app/HomeDashboard.tsx`, `app/components/home/`, `app/styles/`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract-home.test.tsx`.

Home is the page the owner sees first.
It is a short briefing from the boards and the sessions, and a way to ask Aril, not a dashboard.
The [Aril agent plan](../plans/aril-agent.md) set the direction on 2026-10-28.
The owner approved the revised design, with Needs you, the running sessions, and focus mode, on 2026-10-30.
The owner approved the cards, the tiles, and the phone layout of Home (`HomeV3.dc.html` and `HomeV3Phone.dc.html`) on 2026-10-30.

## Home

- Home is one centered column, at most 820px wide.
- The column keeps the reading order in the table below, on the desktop and on the phone.
- Home keeps bounded, identity-only local preferences.
- Home shows honest unavailable content, and no coming-soon content.

| Order | Part | Drawn |
| --- | --- | --- |
| 1 | Date line and greeting, with the mark “Last 24 hours” | Always; the mark only where the tiles are drawn |
| 2 | The last 24 hours, four tiles | Only where the task log can be read |
| 3 | Needs you and Continue, two cards | Needs you when something waits for the owner; Continue always |
| 4 | What's new card | Until the owner dismisses the announcement |
| 5 | Suggestions and composer | Only where the chat can be reached and Aril is On |

- The session guides and the roadmap preview are not on Home.
- The desktop draws Needs you and Continue side by side, each card at least 196px high. The phone stacks them, and the cards take the height of their content.
- No rule runs between the rows of a card. Each row is a rounded item with a hover fill, and each card ends with a closing line.
- When nothing waits for the owner, Needs you is not drawn and Continue takes the whole row.
- The column is centered vertically in the content area when it is shorter than the window. When it is taller, it starts at the top and the page scrolls as usual.
- On the phone the column always starts at the top, and the composer is pinned to the bottom of the screen above the safe area.
- On the desktop the composer is the last block of the column, and it centers with the column.
- While Aril is Off, Home has neither the composer nor the suggestions, and the other parts lay out as they do otherwise ([While Aril is Off](#while-aril-is-off)).
- The page header is `CommandPageHeader`, with the date line above the title, the greeting as its title, and the mark “Last 24 hours” as its action, bottom-aligned at the end.

### Entrance

- Home draws once, after everything that decides its shape has answered: the boards, the logs, the sessions, the preferences, and where the chat can be reached, the Aril switch.
- Until then the column is laid out and not drawn, so nothing is drawn and then moved or taken away.
- If an answer never comes, as from a desktop too old to answer the switch, Home draws after 1.5 seconds with what it has.
- Each block then fades in and rises 8px over 420ms with the curve `cubic-bezier(.2, .8, .2, 1)`, 60ms after the block above it: the header, the tiles, the cards, the What's new card, and the composer.
- The entrance plays once. Reduced motion removes it.

## Where Home is drawn

- The chat is reached in the desktop app and on a paired phone. Nowhere else.
- That decision is made before anything is drawn: `useAgentChatAvailability` decides.
- While the client is still identified, Home draws no tiles, no Needs you, and no composer.
- Where the chat can be reached, the composer waits for one more answer: the desktop's, whether Aril is On ([While Aril is Off](#while-aril-is-off)).
- A browser on the same computer draws the date, the greeting, Needs you, Continue, and the What's new card.
- That browser draws no tiles, no failure detail on Needs you, and no composer, because it reads no task log and cannot reach the chat.
- So no part is drawn and then taken away.

## Date line and greeting

- The date line is a caption above the title, uppercase with wide letter spacing, in muted text: the weekday, the day, and the month, in the owner's locale.
- The date line and the greeting are empty until the client knows its locale, the day, and the hour. They keep their height, and nothing moves when they arrive.
- The greeting is the 28px page title: **Good morning**, **Good afternoon**, or **Good evening**.
- The hour is the owner's local hour.
- Hours 5 to 11 read **Good morning**, 12 to 17 read **Good afternoon**, and the others read **Good evening**.
- Before the client knows the hour, the title is empty. It is never drawn with another word first.

## The last 24 hours

- The last 24 hours are four tiles in one row under the greeting. The mark “Last 24 hours”, a 12px `spark` glyph and a caption in muted text, sits at the end of the header row.
- A fixed rule counts the tiles from the task log. No model runs, and no model writes the words.
- The tiles count the tasks that the logs of the last 24 hours record for each of four events.

| Tile | Short label on a phone | Log kinds counted |
| --- | --- | --- |
| Started | Started | `started`, `grant_start` |
| Reached Review | Review | `review` |
| Merged | Merged | `merged`, `grant_merge` |
| Marked Done | Done | `done`, `grant_done` |

- A tile is the count in the 28px title step and the label under it in muted text, on the panel fill with a one-pixel rule and the 6px panel radius.
- On a phone the four tiles are one row of equal columns, the count is 18px, and the label is the short one. The full label stays for assistive technology.
- A count is in application ink, a zero is in muted ink, and Marked Done is green when it is above zero.
- A task counts once for each event, however many entries it has.
- With no event in the window, the four tiles read zero. They are not hidden.
- When the owner has no task board, the tiles are not drawn.
- When a log could not be read and others could, the tiles count the logs that were read, and one muted line under them reads “Some logs could not be read.”
- When no log could be read, the tiles are not drawn, and they never say that nothing happened.
- The window ends at the moment of the newest read. The counts read the 12 boards that changed last.
- Home reads those logs again every 60 seconds while the page is visible.
- The tiles come from Pomegr's task logs and not from the chat, so they and the mark are drawn while Aril is Off too.
- The tiles are a deterministic count, not a judgment, and not a complete record.
- Until the Tasks home answers and the first read of the logs ends, the place of the tiles shows the quiet words “Reading the task logs…”, and no count.

## Needs you

- Needs you lists what the owner has to do now, one line for each thing.
- A fixed rule picks and words the lines. No model runs.
- A line is a current state of a board or a session, never an old log entry.
- So a line leaves the list as soon as its state ends.
- With nothing to do, Needs you is not drawn.
- Needs you is a card: the `h2` **Needs you**, its count as a badge, the lines, and a closing line.
- The badge is the number of all the lines, in amber on the soft amber fill, with the control radius, and it is a count and not a pill.
- A line is a rounded item with no rule between lines, and it takes the raised fill on hover.
- A line holds a 32px glyph tile on the soft amber fill, the action with an optional failure detail after it, the repository under them in caption text, and a chevron.
- The glyph names the kind: `session` for a session that waits, `check` for a finished task, `timer` for a stalled task, `stop` for a blocked task, and `history` for a paused queue.
- The closing line reads “Nothing else is waiting on you.” with a `check` glyph, in muted text, at the foot of the card. The phone does not draw it.
- When more lines wait than are drawn, the closing line is the count of the rest instead.
- A line names no task and shows no task title and no task ID.
- The lines are grouped by kind and by repository, and phrased as the action.

| Line | What makes it | Action words |
| --- | --- | --- |
| Sessions that wait | A live session whose agent needs input; one line for each repository | “Answer a session that is waiting for you”, “Answer n sessions that are waiting for you” |
| Finished tasks | Tasks in Needs review: the agent reported complete; one line for each repository | “Review 1 finished task”, “Review n finished tasks” |
| Stalled tasks | Tasks in Stalled: the bound session ended without a report | “Check 1 stalled task”, “Check n stalled tasks” |
| Blocked tasks | Tasks in Blocked by agent: the agent called `block_task` | “Unblock 1 task”, “Unblock n tasks” |
| A paused queue | A queue that a failed start paused, and that waits to be turned on again | “Restart the paused queue” |

- The order is fixed: the sessions that wait, the finished tasks, the stalled tasks, the blocked tasks, and the paused queues.
- Among the finished tasks, the plain lines come before the lines of a failure.
- A session waits when Pomegr observed that an agent needs input: the **Needs input** state of [Sessions and agents](../../public/using-pomegr/sessions-and-agents.md#read-a-sessions-state). The state wins even while other agents work.
- These states are not lines: Not queued, Queued, Scheduled, Done, a running queue, a blocked queue, a session that works, is idle, or is open, and a session that is not live.
- A blocked queue is already a line: the task that blocks it is Stalled or Blocked by agent.
- A pause for provider usage is not a line, because it ends by itself.
- The task log records no ask of an owner and no failed start by itself. A failed start is a paused queue.
- The counts cover the 50 newest tasks that the Tasks home serves. [Tasks](../architecture/tasks.md#tasks-home) owns that read.
- A repository that the inventory no longer lists has no board to open, so its lines are left out.
- At most eight lines are drawn, and the closing line says how many more wait.

### Failure detail

- A failure detail is one word after the action, in amber text.
- Amber text marks a failure only. No other word on a line is amber.
- The badge and the glyph tile are the attention tone of the card: amber on its soft fill, and no word.
- A task in Needs review has a failure when its newest CI, review, or merge result after it reported complete failed. A failure is its own line.
- A passed result, or no result, joins the plain line of its repository, and the line shows no word for it.
- The detail is the newest entry of these kinds that follows the newest `review` entry of the task.

| Detail | Newest log kind after the task's latest `review` entry |
| --- | --- |
| “CI failed” | `checks_failed` |
| “Review failed” | `review_failed` |
| “Merge refused” | `grant_merge_refused` |

- The log kinds `checks_passed`, `review_passed`, `merged`, and `grant_merge` are passed results.
- A paused queue always has a failure detail: the reason, in amber text.

| Pause reason | Words |
| --- | --- |
| `cli_missing` | “CLI not found” |
| `plugin_missing` | “Plugin missing” |
| `unsupported_platform` | “Windows only” |
| `start_failed` | “A start failed” |
| `session_not_linked` | “Session not linked” |
| `worktree_dirty` | “Worktree has changes” |
| `environment_invalid` | “Environment invalid” |
| Another or none | “Paused” |

- Home reads the log of the 12 boards that changed last. A task of an older board has no failure detail.
- Needs you waits for the Tasks home, the logs, the sessions, and the inventory, so no line appears after another is shown.
- When the Tasks home is unavailable, one quiet line reads “Task boards are unavailable. Pomegr will retry.”
- A client that may not read the Tasks home gets no such line.

### Where a line goes

- A line is one link.
- The lines of tasks and queues open the Tasks page of the repository. The Tasks page has no filter by state, so the board shows the column.
- A line for one session that waits opens that session.
- A line for several sessions opens the Sessions page of the repository, or the Sessions page when the sessions have no repository.

## Continue

- Continue is a card next to Needs you: the `h2` **Continue**, a muted “n running” when sessions run, and a quiet **All sessions** link to the Sessions page at the end. A phone draws **All**, and the link keeps its full name.
- It holds the running sessions, the last viewed session while none runs, one small line of pinned destinations, and a closing line.
- Its rows have no rule between them. Each row is a rounded item with a hover fill, like those of Needs you.

### Running sessions

- The running sessions are the live sessions whose state is **In progress** or **Needs input**. Pomegr already observes both.
- A session that is idle, open, stopped, closed, unknown, or not live is not a running session.
- At most four sessions are drawn, and “n running” counts all of them.
- A session that waits comes first. The others follow, newest activity first.
- A session is one link row: an 8px state dot, the title, and under it the state and where it runs.
- The title is clamped to two lines.
- The state reads “Working” in green text, or “Waiting for you” in amber text.
- The dot is green for a session that works and amber for a session that waits. The green dot pulses: a ring of the green at 40% grows to 7px and fades over 1.8s, again and again. The amber dot does not pulse. Reduced motion removes the pulse.
- Its meta reads “repository · updated n min ago”, in muted text, with no provider.
- The time is when the session last changed: “updated just now”, “updated n min ago”, “updated n h ago”, or “updated n d ago”. A session with no known change time has none.
- A session started for a task, or assigned to it, shows the title line of that task. Any other session, a review session included, shows its own title.
- The title line of a task is the first text after its leading tags, as the Tasks home words it.
- The task comes from the board of the session's repository, read through the same store as the Tasks page.
- The task text is a board value, so it never enters `/api/state`. Home draws only that one line.
- The rows wait for the boards of the shown sessions, so no title is drawn and then replaced by another.
- When a board cannot be read, the row shows the session's own title.
- On the phone, the row keeps the same shape and is at least 44px high.

### Last viewed session

- With no running session, Continue shows the last viewed session as one link row, with its title, its project, and its provider.
- With no last viewed session, one muted sentence says that a shortcut will appear after the owner opens a session.
- A last viewed session that the catalog does not hold reads as unavailable. Home never invents a title.

### Pinned line and closing line

- The pinned destinations are one small muted line above the closing line: **Pinned** and the destinations as brand-text links.
- With no pin, there is no pinned line.
- Each pin has an icon **Unpin** action. It shows for the pin that has the pointer or the focus, and it is always shown on a touch screen.
- The closing line reads “Pin a session to keep it here” with a `pin` glyph, at the foot of the card, as a rounded item with a hover fill. It replaces **Add pins**.
- The closing line is the pin action: it opens the picker under it. The owner may pin up to six destinations.
- The preferences keep only the kind and the identity of a pin.
- Pins and the last viewed session stay in browser storage and do not survive a desktop restart.

## Composer and suggestions

- The composer is the chat composer. [Agent chat design](agent-chat.md#composer-on-home) owns its parts and its look.
- The suggestions sit above the composer as chips.
- On the desktop the block of the chips and the composer is the last block of the column, 8px further from the block above it than the other blocks are from each other.
- On the phone the block is pinned to the bottom of the screen, above the safe area, with the page scrolling under it. Focus mode takes it out of that place.
- A suggestion chip fills the message field and sends nothing.
- The dock draws no launcher on Home, because the composer is the way in.
- Home has no way to open the conversation without a message. The owner opens it from another page, or sends a message.
- Where Aril is Off the composer and the suggestions are not there at all ([While Aril is Off](#while-aril-is-off)).

## While Aril is Off

- With Aril Off there is no Aril: Home draws no composer and no suggestion chips, on the desktop and on a paired phone.
- The date, the greeting, the last-24-hours tiles and their mark, Needs you, Continue, and the What's new card are drawn as they are. Needs you and the tiles read the task logs and the boards, not the chat.
- The column holds only the content block, so there is no empty gap, no placeholder, and no notice where the composer was. Nothing says that Aril is off; Settings › Aril does.
- The composer block is never drawn before the desktop has said whether Aril is On, so it is never drawn and then taken away. Before that Home has no composer and, once it is On, the composer appears at the foot of the column without moving anything above it.
- A client that cannot read the switch, such as an older desktop, draws no composer.
- Home asks for the switch every five seconds, together with the chat dock and Settings, so a switch turned on the other device reaches Home.
- When Aril turns Off while the composer is lifted or its thread is open, Home comes back to its own parts at once.
- When Aril turns On again, the composer and the suggestions come back as they were, and the stored thread shows again.
- The owner's decision of 2026-10-30 settled this: Off hides the chat everywhere, including Home.

## Focus mode

- Focusing the message field of the composer, or picking a suggestion chip, starts focus mode.
- Another control of the composer, such as attach or the repository choice, does not start it.
- In focus mode the date, the greeting, the tiles, Needs you, Continue, and the What's new card fade out and cannot be reached.
- They fade over 280ms, and they rise 10px as they go.
- The block of the chips and the composer moves to the vertical middle of the content area over 480ms, with the curve `cubic-bezier(.2, .8, .2, 1)`.
- The page does not move: the shift is measured from the place of the block in the page, and the block keeps its place in the flow.
- The composer takes the overlay shadow while it is lifted.
- The hint “Enter to send · Esc to go back” shows under the composer, in muted caption text, and fades in over 280ms.
- Escape returns to Home, and the draft stays.
- Escape first belongs to an open list of the composer.
- A click outside the block returns to Home while the field is empty. It does nothing while the field holds text or an image.
- A transparent layer over the content area catches that click. The header and the rail stay above it.
- Returning moves focus to the Home page, never into the composer, which would start focus mode again.
- Reduced motion removes every fade and move: the parts and the composer change at once.

### Send

- Send hands the message to the dock. The dock opens the [maximized Aril view](agent-chat.md#panel-opened-from-home) on that repository's thread and sends the message there.
- The earlier messages of the thread fade in one after another, then the new message, and the answer is written as usual.
- The composer of the panel starts where the composer of Home was, and settles to the bottom over 480ms.
- The chips go away, and Home stays hidden under the panel.
- Closing the maximized view returns to Home: the parts fade back in, and the composer returns to the foot of the page.
- Closing the view does not start focus mode.

### Phone

- On the phone, focus mode fills the screen: a layer in the canvas fill covers the page, header included.
- The composer does not lift to the middle. It is fixed to the bottom of the screen, above the keyboard, with the chips above it.
- With the keyboard open the block sits just above it, which is the upper-middle of a tall phone, so it can look centered. Its place is the keyboard's top edge, never the middle.
- The block follows the keyboard: the visual viewport tells how far the keyboard covers the screen, and the block's `bottom` follows it over 300ms.
- The block is fixed only in focus mode, and its resting place is sticky at the bottom of Home. Changing between the two moves it in one frame unless it glides.
- Starting and ending focus mode glide the block between the two places over 480ms, with the desktop's curve, while the other parts fade.
- The glide is a transform that runs from the offset between the two places to none. `useComposerGlide` measures the composer before the mode changes, in the event that changes it, and after.
- The composer decides the offset, not the block, so the chips and the Back to Home action, which comes and goes with focus mode, never make the composer jump.
- Every way out glides the same: a tap outside, **Back to Home**, and Escape. A glide that is still running starts the next one from where the block is on the screen.
- The wrapper's entrance plays once. It never starts over when focus mode ends, or the block would be invisible for the 240ms of its delay and then fade back in.
- **Back to Home** is drawn only in focus mode, so it goes at once when focus mode ends.
- Reduced motion has no glide: the block is at its new place at once, with no blink.
- The block must rise above the layer, so no ancestor of the block makes a stacking context or a containing block in focus mode: no z-index, no animation, no transform, no filter, no containment.
- The wrapper of the block leaves its sticky place, its z-index, and its entrance as focus mode starts, even while the entrance still runs. `tests/ui/home-focus-stacking.test.tsx` guards it, and guards the glide and the single entrance.
- The hint is not drawn, because a phone has no Escape key. A Quiet **Back to Home** action takes its place.
- Send turns the screen into the full-screen sheet of the panel.

## What Home reads

| Read | Where it comes from | What it draws |
| --- | --- | --- |
| Session catalog | The shell | Needs you, Continue |
| Tasks home | `GET /api/tasks?view=home` | Needs you, the suggestions |
| Task log | The desktop or the paired route, once for each of 12 boards | The last-24-hours tiles, the failure details of Needs you |
| Boards | `GET /api/tasks?repositoryId=`, through the Tasks page's store, for the repositories of the shown running sessions | The title line of the task of a running session |
| Aril switch | The desktop or the paired route, shared with the dock and Settings | Whether the composer and the suggestions are drawn |
| Repository inventory | The shell | The repository names, the composer's repository |
| Thread run | The chat's `thread` operation, once for the repository the composer shows | The composer's first model and effort |

- Home calls no new route and stores no board value.
- Home does not show the provider status and does not read it. Usage limits and the session header show it.
- Home never reads a prompt, an answer, a credential, or a transcript.
- [Tasks](../architecture/tasks.md#tasks-home) owns the privacy of the board reads.

## What's new card

`HomeUpdateCard` is a teaser. It is not the announcement itself.

### Layout

- The card sits at the foot of the content, above the composer, and as wide as the column.
- The card is horizontal: the thumbnail on the left, the text beside it, and the actions at the end.
- The card has the panel fill, a one-pixel rule all around, and the 6px panel radius, like the two cards above it.
- The thumbnail has a small fixed size, so the card never grows with the artwork.
- On the phone, the card is one compact row: a smaller thumbnail, the eyebrow and the title on one line each, and a chevron.
- On the phone, the whole row opens the dialog, through the **See what's new** action stretched over the row, and the summary is left to the dialog.
- On the phone, the dismiss keeps its own 44px target at the end of the row.
- The card uses tokens only, as the rest of Home does.

### Content

- A 120×72 thumbnail, 64×48 on the phone.
- An uppercase caption eyebrow in brand text.
- A 14px/650 title.
- One muted 14px summary line.
- A [Secondary](../../../DESIGN.md#buttons) **See what's new** action.
- An icon dismiss.

## What's new dialog

### Layout

- The **See what's new** action opens a modal `<dialog>`.
- The panel is 560px wide and centered, with the overlay shadow.
- The backdrop is `#0008`, the same scrim as the phone agent-filter sheet.
- On the phone, the dialog is a bottom sheet.

### Content

- The illustration on the raised fill (`--command-panel-2`).
- The same eyebrow as the card.
- A 16px/650 title.
- The description.
- Short muted highlights.
- A [Primary](../../../DESIGN.md#buttons) **Got it**.

### States

- **Got it**, the icon close, Escape, and a backdrop click close the dialog and keep the card.
- Closing the dialog returns focus to the trigger.
- Only the card's icon dismiss dismisses the announcement.
- The dialog opens by itself once for each announcement, the first time Home renders it.
- Pomegr records that opening when the dialog opens.
- After that, the dialog opens only on the **See what's new** action. This holds whether it was closed or the page reloaded.
- The automatic opening waits 300ms after Home renders, so the entrance does not compete with first paint.
- The privacy rules for the stored markers are in [Desktop and diagnostics](../architecture/privacy/desktop-and-diagnostics.md#home-announcement-markers).

### Motion

- The entrance is one unhurried ease-out moment.
- Reduced motion removes the entrance.
- The panel fades in and rises 12px over 600ms. It does not scale.
- The backdrop dims on the same gentle curve.
- The phone sheet rises 32px.

## Illustration

- `HomeUpdateIllustration` is decorative static artwork.
- It is built from tokens and sample data.
- It is authored 408px wide.
- The card thumbnail scales the same node down.
- Both copies are inert and hidden from assistive technology.
- An announcement without an illustration renders text only.
- It never reads session state.
- It never ships a screenshot.

## Samples

- `/design-system` renders both forms of the What's new card, and the dialog.
- It renders Home's Needs you card with every line kind and a failure detail.
- It renders the running sessions with a session that waits.
- It renders the last-24-hours tiles with counts, with nothing logged, with a log that could not be read, and while they read.
- It renders the suggestion chips above the composer, and the composer in focus mode, as [Agent chat design](agent-chat.md#samples) lists.
