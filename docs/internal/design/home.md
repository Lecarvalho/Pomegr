# Home design

> Scope: the Home page: its greeting, the Aril line, Needs you, Continue, the status line, the composer and its suggestions, and the What's new line and dialog.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> The composer and the suggestion chips are specified in [Agent chat design](agent-chat.md#composer-on-home).
> Related code and checks: `app/HomeDashboard.tsx`, `app/components/home/`, `app/styles/`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract-home.test.tsx`.

Home is the page the owner sees first.
It is a short briefing from the boards and a way to ask Aril, not a dashboard.
The [Aril agent plan](../plans/aril-agent.md) set the direction on 2026-10-28.

## Home

- Home is one centered column, at most 720px wide.
- The column keeps the reading order in the table below, on the desktop and on the phone.
- Home keeps bounded, identity-only local preferences.
- Home shows honest unavailable content, and no coming-soon content.

| Order | Part | Drawn |
| --- | --- | --- |
| 1 | Greeting and the Aril line | Always; the Aril line only where the task log can be read |
| 2 | Needs you | When the Tasks home answers, and holds an item |
| 3 | Continue | Always |
| 4 | Status line | Always |
| 5 | Suggestions and composer | Only where the chat can be reached |

- The session guides and the roadmap preview are not on Home.
- The suggestions and the composer sit at the bottom of the content area when the column is shorter than the window.
- When the column is taller, they follow the content.
- The page header is `CommandPageHeader`, with the greeting as its title and the Aril line as its meta line.

## Where Home is drawn

- The chat is reached in the desktop app and on a paired phone. Nowhere else.
- That decision is made before anything is drawn: `useAgentChatAvailability` decides.
- While the client is still identified, Home draws no Aril line, no Needs you, and no composer.
- A browser on the same computer draws the greeting, Needs you, Continue, and the status line.
- That browser draws no Aril line, no Needs you detail, and no composer, because it reads no task log and cannot reach the chat.
- So no part is drawn and then taken away.

## Greeting

- The greeting is the 28px page title: **Good morning**, **Good afternoon**, or **Good evening**.
- The hour is the owner's local hour.
- Hours 5 to 11 read **Good morning**, 12 to 17 read **Good afternoon**, and the others read **Good evening**.
- Before the client knows the hour, the title is empty. It is never drawn with another word first.

## The Aril line

- The Aril line is one muted line under the greeting, with a 16px `spark` glyph.
- A fixed rule writes the line from the task log. No model runs, and no model writes the words.
- The line counts the tasks that the logs of the last 24 hours record for each of four events.

| Event | Log kinds counted | Words |
| --- | --- | --- |
| Started | `started`, `grant_start` | “n started” |
| Reached Review | `review` | “n reached Review” |
| Merged | `merged`, `grant_merge` | “n merged” |
| Marked Done | `done`, `grant_done` | “n marked Done” |

- A task counts once for each event, however many entries it has.
- The line reads “In the last 24 hours: ” and the events with a count above zero, in the order of the table, joined with commas.
- When no event has a count, the line reads “Nothing was logged in the last 24 hours.”
- When the owner has no task board, the line is not drawn.
- When a log could not be read, the line adds “Some logs could not be read.”
- When no log could be read, the line is not drawn, and it never says that nothing happened.
- The window ends at the moment of the newest read. The counts read the 12 boards that changed last.
- Home reads those logs again every 60 seconds while the page is visible.
- The line is a deterministic count, not a judgment, and not a complete record.
- Until the Tasks home answers and the first read of the logs ends, the line shows the quiet words “Reading the task logs…”.

## Needs you

- Needs you lists what waits for the owner now.
- An item is a current state of a board, never an old log entry.
- So an item leaves the list as soon as its state ends.
- The list is drawn from the Tasks home. [Tasks](../architecture/tasks.md#tasks-home) owns that read.
- A fixed rule picks the items. No model picks them.

| Item | State that makes it | Words after the title |
| --- | --- | --- |
| A task | Needs review: the agent reported complete | “Needs review” |
| A task | Stalled: the bound session ended without a report | “Stalled” |
| A task | Blocked by agent: the agent called `block_task` | “Blocked by agent” |
| A queue | Paused: a start failed, and the queue waits to be turned on again | “Queue paused”, and the reason below |

- These states are not items: Not queued, Queued, Scheduled, Done, a running queue, and a queue that is blocked.
- A blocked queue is already one item: the task that blocks it is Stalled or Blocked by agent.
- A pause for provider usage is not an item, because it ends by itself.
- The task log records no ask of an owner and no failed start by itself. A failed start is a paused queue.

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

- The queues come first, because a paused queue holds every task of its board. The tasks follow, newest change first.
- At most five items are drawn. A quiet link **Show all n** opens the Tasks page when more wait.
- An item is one row and one link to the board of its repository.
- A task row holds the repository name, the task ID in the data face, the title on one line with an ellipsis, and the state words.
- A queue row holds the repository name, “Queue paused”, and the reason words.
- State words are muted `--text-xs` text. They are not chips.
- The title is the one line that the Tasks home serves. It is the session title or the first line of the task text.
- A Needs review item adds one detail word from the task log, in the same muted text.

| Detail | Newest log kind after the task's latest `review` entry |
| --- | --- |
| “CI failed” | `checks_failed` |
| “CI passed” | `checks_passed` |
| “Review failed” | `review_failed` |
| “Review passed” | `review_passed` |
| “Merge refused” | `grant_merge_refused` |
| “Merged” | `merged`, `grant_merge` |

- The detail is the newest entry of these kinds that follows the newest `review` entry of the task.
- A task with no such entry has no detail.
- “CI failed”, “Review failed”, and “Merge refused” take the amber text color, because the owner can act on them. No other detail does.
- A task that is not Needs review has no detail.
- Home reads the log of the 12 boards that changed last. A task of an older board has no detail.
- Needs you waits for the logs where the client reads them, so a detail never appears after its row.
- When the Tasks home is not ready or holds no item, Needs you is not drawn.
- When the Tasks home is unavailable, one quiet line reads “Task boards are unavailable. Pomegr will retry.”
- A client that may not read the Tasks home gets no line.

## Continue

- Continue is the `h2` **Continue**, with a quiet **Browse sessions** link to the Sessions page.
- It holds the last viewed session, the pinned destinations, and **Add pins**.
- The last viewed session is one link row, with its title, its project, and its provider.
- With no last viewed session, one muted sentence says that a shortcut will appear after the owner opens a session.
- A last viewed session that the catalog does not hold reads as unavailable. Home never invents a title.
- The pinned destinations are a list named **Pinned destinations**, in two columns wider than 760px.
- A pin is a link and an icon **Unpin** action. The preferences keep only its kind and its identity.
- **Add pins** opens the picker. The owner may pin up to six destinations.
- Pins and the last viewed session stay in browser storage and do not survive a desktop restart.

## Status line

- The status line is one quiet line at the foot of the content, above the composer.
- It holds the provider status area and the What's new line.
- The provider status area is the shared `ProviderStatusArea`, with its label and one row for each provider.
- The two parts wrap on a narrow window. The What's new line stays last.

## Composer and suggestions

- The composer is the chat composer. [Agent chat design](agent-chat.md#composer-on-home) owns its parts and its look.
- The suggestions sit above the composer as chips. A quiet **Open conversation** action sits at the end of that row.
- **Open conversation** opens the panel on the repository's thread and sends nothing.
- A suggestion chip fills the message field and sends nothing.
- Send hands the message to the dock. The dock opens the panel on that repository's thread and sends the message there.
- On the phone, the panel opens as the full-screen sheet.
- The dock draws no launcher on Home, because the composer is the way in.

## What Home reads

| Read | Where it comes from | What it draws |
| --- | --- | --- |
| Session catalog | The shell | Continue |
| Provider status | `GET /api/provider-status` | The status line |
| Tasks home | `GET /api/tasks?view=home` | Needs you, the suggestions |
| Task log | The desktop or the paired route, once for each of 12 boards | The Aril line, the details of Needs you |
| Repository inventory | The shell | The repository names, the composer's repository |
| Thread run | The chat's `thread` operation, once for the repository the composer shows | The composer's first model and effort |

- Home calls no new route and stores no board value.
- Home never reads a prompt, an answer, a credential, or a transcript.
- [Tasks](../architecture/tasks.md#tasks-home) owns the privacy of the board reads.

## What's new line

`HomeUpdateCard` is the What's new line. It is not the announcement itself.

### Content

- A neutral `aside` named **What's new**, in the status line.
- A [Quiet](../../../DESIGN.md#buttons) action that reads “What's new: ” and the title of the announcement.
- An icon dismiss.

## What's new dialog

### Layout

- The Quiet action opens a modal `<dialog>`.
- The panel is 560px wide and centered, with the overlay shadow.
- The backdrop is `#0008`, the same scrim as the phone agent-filter sheet.
- On the phone, the dialog is a bottom sheet.

### Content

- The illustration on the raised fill (`--command-panel-2`).
- The same eyebrow as the line.
- A 16px/650 title.
- The description.
- Short muted highlights.
- A [Primary](../../../DESIGN.md#buttons) **Got it**.

### States

- **Got it**, the icon close, Escape, and a backdrop click close the dialog and keep the line.
- Closing the dialog returns focus to the trigger.
- Only the line's icon dismiss dismisses the announcement.
- The dialog opens by itself once for each announcement, the first time Home renders it.
- Pomegr records that opening when the dialog opens.
- After that, the dialog opens only on the Quiet action. This holds whether it was closed or the page reloaded.
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
- Only the dialog shows it.
- The copy in the dialog is inert and hidden from assistive technology.
- An announcement without an illustration renders text only.
- It never reads session state.
- It never ships a screenshot.

## Samples

- `/design-system` renders the What's new line and the dialog.
- It renders Home's Needs you list with every item kind, a failed detail, and a passed detail.
- It renders the Aril line with counts, with nothing logged, and with a log that could not be read.
- It renders the suggestion chips above the composer, as [Agent chat design](agent-chat.md#samples) lists.
