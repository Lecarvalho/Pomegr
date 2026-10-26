# Sessions design

> Scope: the Sessions directory, session headers, session detail, the Overview tab, the Events panel, and the Signals tab.
> Authority: visual and interaction contract for this surface. [DESIGN.md](../../../DESIGN.md)
> owns the tokens, the six button roles, the chip contract, and the shared controls.
> Related code and checks: `app/components/dashboard/`, `app/styles/session.css`, the `/design-system` samples,
> and `tests/ui/pomegr-design-contract.test.tsx`.

This page covers the directory of sessions and the detail view of one session.

The Activities feed and the Requests chart are in [Activities design](activities.md).
The session Agents panel is in [Agents design](agents.md).
The session Repository tab is in [Repositories design](repositories.md).
The session Task column, Task panel, and Task tab are in [Task board design](task-board.md).

## Sessions directory

### Layout

- The directory is a [`CommandTable`](../../../DESIGN.md#panels-and-tables).
- Rows stay neutral within a cache lifetime.
- The toolbar ends with the **Group by** control.
- On phone, the **Group by** control stretches to the full toolbar width.
- The filter chips stay on one line. Below a 1040px toolbar, **Group by** takes a row of its own.
- The table never scrolls sideways. The width of its panel picks one of three presentations.

| Panel width | Presentation |
| --- | --- |
| 1380px and wider, or 1180px and wider without the Task column | Every column, with Last activity in its own column. |
| Narrower, down to 1000px | Last activity moves under the session title as its compact line. The fixed columns narrow, and the title wraps. |
| Below 1000px | Each session is a stacked row with labelled fields, as on phone. |

### Group by

- The **Group by** control is a `.commandSegmented` [Segmented](../../../DESIGN.md#buttons) control.
- Its options are **Recent**, **Repository**, **Provider**, and **Feature**.
- Muted 12px text labels the control.
- The browser remembers the choice for each browser.

| Option | List | Footer |
| --- | --- | --- |
| **Recent** | The newest-created page, split under creation-day sections. | Previous/Next. |
| **Repository** | Groups, ordered by their newest-created session. | One muted line, no pagination. |
| **Provider** | Groups, ordered by their newest-created session. | One muted line, no pagination. |
| **Feature** | Groups, ordered by their newest-created session. | One muted line, no pagination. |

- Live updates never reorder the groups, because the groups use the newest-created session.
- **Feature** lists only sessions started for a feature's task.
- A client that cannot read tasks gets an explanatory empty state for **Feature**.

### Day sections

- **Recent** uses four creation-day sections.
- The sections are **Started today**, **Started yesterday**, **Started in the previous 7 days**, and **Started earlier**.
- A section header carries no count, because it covers one page.

### Group headers

- A group header is a `CommandTable` row group.
- The header is a full-width cell on the canvas tone.
- Each group lists its newest-created sessions.
- When more sessions exist, the group shows one [Text link](../../../DESIGN.md#buttons) **Show all N in <group>**.
- The link narrows the list to that group.
- The narrowed list shows a **Repository:**, **Provider:**, or **Feature:** filter chip and uses ordinary paging.
- A row under a repository or provider header omits that field from its metadata line.
- Under a **Feature** header, the Task cell of a row prints no feature line.

| Part | Contract |
| --- | --- |
| Toggle | One quiet toggle, `.commandQuietAction.commandSessionGroupToggle`, not a seventh role. |
| Toggle height | 40px, 44px on phone. |
| Chevron | 12px, turns 90° when open. |
| Group name | 13px/600. |
| Session count | Data font. |
| Live count | Green **N live**, only when present. |
| Needs input count | Amber **N needs input**, only when present. |
| Updated | Right-aligned, data font, **Updated** time. |

- A header never shows the status count that the selected **Live** or **Needs input** scope already implies.

### Grouped footer

- The grouped footer is one muted line with no pagination.
- The line reads **N repositories · M sessions**.
- Or the line reads **Showing the N most recent of M repositories. Filter sessions to reach the others.**

### Cache timing glyph

- The primary agent's cache timing adds one 12px `timer` glyph after the Updated time.
- The glyph is the shared dotted disclosure, `.commandSessionCacheTiming`.
- The glyph has no visible text.
- The glyph shows on live and historical rows alike.
- The trigger keeps a 20px box on desktop and 28px on phone.
- The glyph composes `DottedInfoPopover`, `CommandIcon`, and the existing cache-timing popover rows.
- The glyph is never a chip, a badge, or a seventh button role.
- The glyph never describes subagent caches.
- The timing rules are in [Cache timing](../architecture/cache-timing.md#sessions-page-indication).

| State | Look | Accessible name |
| --- | --- | --- |
| A `5m` or `1h` lifetime is nearing its threshold | Amber. | **Cache ~Nm left** |
| The lifetime has passed | Muted at 55%. | **Cache lifetime elapsed** |

### Samples

- `/design-system` renders an open group and a collapsed group.

## Session header

- The status card shows the recorded or live lifecycle state.
- The status card has no duplicate identity badge.
- The provider row omits the repository name that the breadcrumb already shows.
- The provider row omits it while session evidence loads too.
- Live and historical views omit the redundant status row.
- Connection failures stay visible.
- The live status card uses the shared activity labels, including In progress for working sessions.
- Phone summary disclosures identify the summary source once, in their toggle.
- Phone summary disclosures keep agent-reported signals below the toggle.
- Session toolbars offer report download and no pause action.

## Session detail

### Layout

- Session detail uses the shared page header.
- The KPI strip follows the page header.
- The tab rule sits directly below the KPI strip.
- Each KPI is a padded cell with one sub-line.
- The strip is five persistent KPIs on desktop and three on phone.
- The phone KPIs include Agents (active count), Context, and Calls (repeated count).
- The Context KPI is labelled as the sum of latest agent snapshots.
- Context is defined in [Metrics](../architecture/metrics.md).

### Header meta on phone

- The header meta keeps only the provider, status, and branch chips.
- For a session started for a task, the header meta also keeps its task meta.
- The session ID, the start time, and the Download report action are desktop-only.

### Tabs

| Breakpoint | Tabs |
| --- | --- |
| Desktop | Overview, Agents, Activities, Repository, Signals, Resources, Details, then Task for a session started for a task, then Terminal in the desktop app. |
| Phone | Overview, Agents (with its count badge), Activities, Repo, and More (with a chevron). |

- On phone the tabs are content-width and spread across the row.
- On phone the tabs never scroll horizontally.
- **More** opens the remaining real tab destinations.
- A tab switch preserves the `agent`, `request`, and `path` query selections.

### Terminal tab

- Terminal appears last in the desktop app when its terminal bridge exists, decided at first render with a pending server snapshot.
- Browser tabs and paired devices have no Terminal tab.
- On phone widths, the desktop app places Terminal in **More**.
- A Terminal deep link falls back to Overview when the bridge is absent.
- A session Pomegr started in the terminal host shows its live output in one data-font terminal surface.
- A task's Terminal tab lists its build and review terminals in host order, with the task ID and a quiet **Build** or **Review** chip; selecting a row attaches that terminal under the same owner-only input and read-only attachment rules.
- The live terminal uses line height 1.4 to preserve joined box-drawing characters.
- The live terminal fills the window to its bottom, ending above the Aril launcher, with a 360px minimum; the design-system sample keeps a fixed height.
- The live terminal inset matches history: `--space-6` above 760px and `--space-4` at 760px or below.
- The live terminal waits up to 500 ms, measures with a monospace-only family, and re-measures before fitting after the data font loads.
- The CLI draws the only input surface and its caret, which shows focus. Pomegr adds no focus ring.
- The owner types or pastes into the CLI input surface.
- Ctrl+Enter and Shift+Enter send ESC CR, the Alt+Enter sequence that Claude Code and Codex read as a new line; Enter alone submits.
- The Terminal tab sends input, paste, resize, and detach only through fixed trusted desktop IPC.
- A task's Terminal start view says **Waiting for the session to report** before binding. Binding opens the session's Terminal tab.
- A host reconnection keeps input disabled until the terminal attaches and received replay finishes parsing.
- Reopening Terminal restores the full screen, cursor, active buffer, and modes, with up to 5000 lines of scrollback.
- Replay is capped at 4 MiB by omitting the oldest scrollback lines when needed.
- Replayed terminal queries send no input back to the session; live queries keep their normal replies.
- A detached view stays unavailable even when its attach answer arrives later.
- An unavailable host shows **Reconnection unavailable. The session may still be running.** and disables input.
- An incompatible host shows **This session runs in an older host and is temporarily inaccessible.** and disables input.
- A process exit adds one quiet line with its exit code. The surface then becomes read-only.
- Any session that is not live in Pomegr's host keeps the saved-history view read-only.
- Owner messages are a block of their own: a quiet "You" label, the raised panel background, and a 2px left rule in the strong line color (owner, 2026-10-24).
- An owner message longer than 8 lines or 600 characters folds to about 8 lines, with **Show more** and **Show less**.
- Agent replies stay unboxed text, and tool lines stay one muted line.
- Each tool appears as one muted line: `Tool · <name> · <outcome>`.
- Owner and agent text renders through `SafeMarkdown` using `react-markdown@10.1.0` and `remark-gfm@4.0.1`.
- Tool lines stay plain text.
- Saved history renders paragraphs, styled heading lines, code blocks, inline code, bold, italic, strikethrough, and escapes.
- Saved history renders GFM tables, blockquotes, rules, nested ordered and unordered lists, and task lists.
- Tables scroll horizontally inside their message without widening the panel.
- Task-list checkboxes are non-interactive glyphs labelled Checked or Unchecked, never inputs.
- Raw HTML and images stay literal source text; no HTML is set.
- Bare URLs, reference links, and footnotes stay literal.
- In desktop saved history, HTTPS Markdown links without userinfo, at most 2048 characters, with non-empty single-line labels open in the system browser only when the owner clicks them; other links and images stay literal.
- Without the desktop `openSessionLink` bridge, all links stay literal, as they do by default in agent chat and task report notes.
- Saved-history links use `.safeMarkdownLink`, the brand-text token, the Text link hover underline, and the shared focus ring; their label keeps the surrounding type scale and their title shows the full URL.
- Markdown keeps the data font and compact type scale; fenced code preserves line breaks and scrolls horizontally inside the message.
- The docked bar reads **Read-only · Running outside Pomegr · Updates automatically** for a live session.
- The live bar includes a quiet **Refresh** action.
- The docked bar reads **Read-only · Session ended** for an ended session.
- The normalized session state selects the bar text; history never determines liveness.
- A read-only history panel has no input.
- The ended bar offers **Continue** only in the desktop app for readable Claude Code or Codex history whose normalized state is not live.
- Continue opens native confirmation: **Continue this session in Pomegr?**, with the session title, provider, working folder, and Cancel as default.
- A refusal changes the bar to **Read-only · Continue unavailable: <reason>**.
- A successful resume turns the same tab live and lets the CLI draw its own history.
- If observation identifies a different session, the original tab says **This session continued as a new session.** and links to that session.
- Claude Code can resume a background session, and concurrent foreground resumes can interleave; Pomegr cannot eliminate a simultaneous external-start race.
- **Load earlier** appears above messages when an older page exists and prepends that page without moving the reading position.
- The first read shows **Reading history…**.
- Empty history shows **No messages yet**.
- Missing history shows **The provider no longer has this session's history.** and **Pomegr keeps no separate copy.**
- Unsupported history shows **This provider does not support reading session history.**
- A failed read shows one alert: **Session history could not be read.**
- Reopening the tab or **Refresh** retries a failed read.
- Updates follow the bottom while the owner is there and preserve position when the owner scrolls up.
- Existing session-summary events trigger cursor reads only while the selected panel and document are visible.
- Events during a read coalesce into one further read; returning to the visible document reads once.
- A reset answer replaces the displayed messages.
- The panel adds no timer or polling.
- `/design-system` renders synthetic history, live, starting, reconnecting, unavailable, incompatible, ended, empty, failed, and reading states.

### Request preview bars

- The bars show request-local fresh tokens.
- Fresh tokens are uncached input, cache write, and output.
- The bars exclude cache reads.
- The window is fixed at the latest 48 requests on desktop and 24 on phone.

### Role tint

- Role tint appears only in agent tracks and their legends.
- [Agents design](agents.md) owns the role tint mapping.

## Overview tab

### Link rule

- Overview and Signals follow the link rule.
- Panel headings open their tab.
- Show agent is a [Quiet](../../../DESIGN.md#buttons) action.
- On Overview, every heading link is the eyebrow.
- The heading links are Right now, Requests, and Repository.
- The eyebrow is an uppercase 11px/500 caption in ink with the muted chevron.
- Repository introduced this form.
- Headings that are not links use the muted `.sessionEyebrow`.
- The headings that are not links are Events, Progress, Tool calls by kind, and Cost.
- Efficiency signals appear only on the Signals tab, not on Overview.

### Desktop layout

- Overview is a 4/6 + 2/6 split above one bottom row.
- The left column stacks Right now, then Requests.
- Requests grows to fill the remaining height.
- The Events panel fills the right column for the full height of both left panels.
- Below 1181px, a 2/6 rail is too narrow to read a row.
- Below 1181px, Events drops under Requests at full width.
- Below 1181px, the bottom row becomes two columns.

### Bottom row

- The bottom row holds Repository, Progress, Tool calls by kind, and Cost.
- The columns have equal width, in that order.
- Repository always renders.
- The other panels render only when they have evidence or a readiness message to show.
- Repository, Progress, Tool calls by kind, and Cost use compact 12px/16px padding.
- All of them except Repository use eyebrow headings.

### Requests panel

- The request strip always draws 48 slots, so a bar keeps its width in a new session.
- A separate 6px role-track row sits beneath the bars.

### Tool calls by kind

- Tool calls by kind omits medians under one minute.

### Repository tile

- Repository is a compact tile.
- The tile starts with its heading link.
- The heading link is an eyebrow on desktop and the 16px heading on phone.
- The branch follows, beside a comparison chip.
- The chip is toned green only for Up to date or integrated comparisons.
- A muted changes/pull-request line ends the tile.

### Phone

- Overview orders its panels Right now, Events, Requests, Repository, Progress, Tool calls by kind, and Cost.
- Each panel sits in its own bordered panel.
- Right now rows stack the agent name over its latest action, with context on the right.
- The whole Right now row opens the agent.
- Missing readiness stays unavailable.

## Events panel

`SessionEventsPanel` is a fetch-free list of high-level session transitions, newest first.

### Layout

- The heading is a plain eyebrow, `Events · newest first`, the same eyebrow as Tool calls by kind.
- The heading is not a link, because each row opens its own tab.
- The panel always renders, so the layout stays stable.

### Row

- Each row is one real button.
- The row composes the quiet role, `.commandQuietAction.sessionEventRow`, not a seventh role.
- The row has four parts, in this order.

| Part | Contract |
| --- | --- |
| Time | The recorded local time as 24-hour `HH:mm`, in the data font. |
| Glyph | A 16px stroke glyph. |
| Label | A label with a muted detail. |
| Chevron | A trailing 12px chevron in the strong line tone. |

- Glyphs are neutral and muted for every kind.
- No row uses a tone color, amber, or green, because the label names the transition.
- A row prints only what its kind owns.
- The printed values are an agent label, a wall time, a signal label marked agent-reported, a progress percent and phase, a resource name, or a pull-request number.
- A row never prints prompt, command, file, or tool content.
- A task row is the agent's own Pomegr task tool call.
- A task row prints the agent label and never the task.
- The update row reads **Task updated** and opens Agents with the agent selected.
- The two reports of a task row read **Task reported complete** and **Task reported blocked**, because only the owner marks a task done.
- The event fields are in [Session evidence](../architecture/privacy/session-evidence.md#session-events).

### Destinations

- Each row opens the tab that continues its evidence.
- The tabs are Agents with the agent selected, Signals, Activities, Resources, or Repository.
- The progress-estimate row is the exception, because no tab owns the estimate.
- The progress-estimate row is plain text, `.sessionEventRow.isStatic`, on the same grid.
- The progress-estimate row has no button, chevron, hover, or pointer.

### Rows shown

| Breakpoint | Rows | Label and detail | Row height |
| --- | --- | --- | --- |
| Desktop | 9 | One ellipsized line. | 40px. |
| Phone | 5 | Two stacked lines. | At least 48px. |

### Expander

- When more loaded events exist, the footer expander reads **Show N earlier**, then **Show fewer**.
- The expander is a text link.
- The expander is the panel's one in-content pointer.
- The panel collapses again when the session changes.
- On desktop (761px and wider), the expanded list keeps the collapsed nine-row height and scrolls inside it.
- `.sessionEventList[data-expanded="true"]` caps `max-height` at `--event-row-height` times `--event-collapsed-rows`.
- So the panel never grows, and neither does the Requests panel that shares its row.
- On phone, the expanded list is unbounded for page scroll.

### Footer

- The muted footer total reads `N events` (`1 event`).
- The total uses `en-US` digit grouping on every locale.
- The total counts the events derivable from retained evidence.
- The total is never a complete session history, so it carries no session claim.
- The count rule is in [Session evidence](../architecture/privacy/session-evidence.md#session-events).
- The footer is omitted when there are no rows.

### Collapsed consecutive events

- Consecutive Overview events with the same kind, detail, and agent collapse into one row before the row limit.
- A muted data-font `×N` count stays visible beside the text on desktop and phone.
- The row keeps the time and destination of the newest event.
- The accessible count explains that the newest event is shown.
- Different details, agents, or intervening events break a group.
- The footer total still counts events.
- **Show N earlier** counts hidden rows.

### States

| State | Copy |
| --- | --- |
| Feed not ready | The shared unavailable line: **Event evidence unavailable.** or **Loading Event evidence…** |
| Feed ready with no events | **No events recorded.** |

### Samples

- `/design-system` renders every Events state from static data.

## Signals tab

- Signals is a separate tab.
- On phone, Signals is reachable through **More**.
- The tab has three ordered sections: **Efficiency**, **Cache lifetime**, and **Reported signals**.
- **Efficiency** and **Cache lifetime** show deterministic recorded evidence or explicitly labeled inferences.
- **Reported signals** are agent-reported updates and may be stale.
- The tab introduction says **Not a quality assessment**.

## Details tab

- Details opens directly into Session facts and Cost estimate on the left, with Context inventory on the right.
- The columns stack below 1101px, with Session facts first.
- Session facts list provider, full session ID, project, start time, approval mode, and session-observed plugin and policy metadata.
- Plugin and policy metadata keep their recorded state in historical sessions.
- Copy transcript path uses the existing one-shot action for the primary agent and the existing client-access and transcript-availability gates.
- The transcript path is never rendered or stored in the browser.
- Cost estimate keeps its capability gate, display preference, sub-cent precision, observation time, and **Reference only — not a bill or subscription spend** caveat.
- Context inventory shows the three allocation totals and the Category, Tokens, Share, and Kind table inline.
- Share preserves the provider-reported percentage for initial categories; deferred and reserved categories show a dash.
- Groups expands inline into the existing group disclosures.
- A bound repository inventory revision remains linked even when in-session inventory is present.
- Without in-session evidence, a bound immutable revision shows its summary and retention state.
- The context inventory heading's info popover carries the estimate and sanitization explanations.
- Details has no outer disclosure, audience chip, usage limits, flow score, or flow-score inputs.
- Usage limits remain shell chrome; flow score belongs to Signals.

## Samples

- `/design-system` renders an open and a collapsed session group.
- `/design-system` renders every Events panel state from static data.
