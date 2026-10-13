---
title: "Tasks"
description: "Plan work on a repository's task board, queue it, and have the Pomegr desktop app start Claude Code or Codex sessions for it."
---

# Tasks

**Tasks** in the sidebar opens the Tasks home: the tasks that wait for you on any
board, and one row for each repository's board. A board holds the work you want
coding agents to do in one repository; the **Repository** menu beside its heading
switches repository. You can start a session for a task yourself, or turn on a queue and
let the desktop app start tasks one step at a time. After a start, Pomegr only
observes the session: it never stops, attaches to, answers, or approves anything
in a running session. Observing sessions works the same whether or not you use
tasks.

## Before you start

- **Use the desktop app or a paired device to change tasks.** You create, edit,
  move, queue, and schedule tasks in the Pomegr desktop app or on a phone you
  paired with it (see [Phone access](phone-access.md)). You can also confirm a
  manual start on the phone; the session runs on the computer running Pomegr.
  You can turn the queue on or off from either device. Pomegr must remain open on the computer.
  Only the desktop app attaches images and works with GitHub issues. A browser on the same computer shows the board
  read-only and says "Tasks are created and edited in the Pomegr desktop app or
  on a paired device."
- **Starting sessions works on Windows only for now.** Elsewhere a start answers
  "Starting sessions is available on Windows only."
- **Install the Pomegr plugin in the repository.** A started session links to its
  task, and the agent reports its result, through the plugin; see
  [Reporting plugins](reporting-plugins.md#install-the-plugin). Tasks need plugin
  0.9.0 or later. Without the plugin, with an older one, or when Pomegr cannot read
  its version, a start is refused with "Install or update the Pomegr plugin in this
  repository to start sessions." Codex runs plugin hooks only after you trust them.
- **Install the coding tool.** If Pomegr cannot find the Claude Code or Codex
  program, a start says "The provider's command-line tool was not found on this
  computer."

## Create and organize tasks

Select **Tasks** in the sidebar. **Needs you** lists the tasks that need review,
are stalled, or are blocked by their agent, newest first; a row opens that task's
board. **Boards** shows each repository with its queue, the number of tasks in
each column, and when a task last changed; select a repository's name to open its
board. On a board, **Tasks** above the heading returns to the home.

A repository's own **Tasks** tab links to the same board. A board has five
columns: **Backlog**, **Ready**, **In progress**, **Review**, and **Done**. You
cannot add, rename, reorder, or delete a column. Moving a card never changes its
state. **Ready** is the queue's column: a queued or scheduled task's card stays
there until its session starts.

### Create a task

1. On the **Board**, hover the **Backlog** column, or move keyboard focus
   into it, and select **New task** under its last card. On a touch screen the
   action is always shown.
2. Describe the work in **Task**, up to 4,000 characters. It is the only required
   field. A card shows the first sentence of this text as its title and the
   start of the rest below it, until its session has a title, then the title.
3. To show the agent a screenshot or a mock-up, paste an image into the text or
   select **Attach image**; see [Attach images](#attach-images).
4. Set the optional fields below.
5. Select **Create task**. **Cancel** closes the window and writes nothing.

The arrow beside **Create task** opens two more ways to create the task:

- **Create and queue** creates the task and adds it to the queue, at the end of
  **Ready**.
- **Create and start session** creates the task and starts its session at once,
  after the same confirmation as **Start session**.

If the task is created but cannot be queued or started, its task window opens and
says why. The task is kept.

With **Create task**, the task lands in the first column and is not queued. To start from an open GitHub
issue, or to create an issue from a task, see [GitHub issues](github-issues.md).
Select a card to open its
task window, where your changes stay a draft until you select **Save**. **Save**
is available once something differs from the stored task, and **Close** or
**Escape** discards the draft. While a draft is unsaved, **Start session**, **Add
to queue**, **Remove from queue**, **Mark done**, and **Requeue task** are
unavailable. **Delete task** asks you to confirm; a task number is never reused.

Once a task has started, you cannot change it. The session works from the task as
it was when it started, so a later change would not reach it. The task window then
shows the fields read-only, without **Save**, and says "This task has started, so
it cannot be changed." This applies from the start of the session on, and to a task
that is in review, blocked, stalled, or done. **Requeue task** makes the task
editable again until its next session starts. While a queued task is in progress,
**Remove from queue** is unavailable. You can still move, delete, mark
done, and requeue a started task.

| Field | What it sets |
| --- | --- |
| **Run on** | Required. The provider and model of the started session's main agent: under **Claude Code** or **Codex**, a model or **Default model**. A new task starts with the choice of the newest task on the board, or with **Claude Code** and **Default model** on an empty board. Subagents are not set. A task that an agent added without a provider shows **Not set** until you choose one, and starts on Claude Code. |
| **Effort** | Required. **Low**, **Medium**, **High**, or **Xhigh**. A new task starts with the effort of the newest task on the board, or with **Medium** on an empty board. You cannot clear it. |
| **Remote Control** | Starts the Claude Code session with Remote Control on, so you can also open that session on your phone or in a browser, signed in to the same Claude account. It is off by default and is not available for a Codex task. Pomegr only passes Claude Code's own `--remote-control` option; it does not connect to the session. |
| **Remove worktree and branch when done** | When you mark the task done, Pomegr removes the Git worktree it made for the task and the task's branch. It is on by default. It changes nothing for a task that runs in the repository itself, and never removes uncommitted or unpushed work; see [Group tasks into features and steps](#group-tasks-into-features-and-steps). |
| **Complete when** | The conditions an agent's report is checked against; see [Complete when](#complete-when). |
| **Feature** | The group of related tasks the task runs with; see [Group tasks into features and steps](#group-tasks-into-features-and-steps). |

Claude Code lists the newest model of each family Pomegr has seen in your
sessions. Codex lists the models in the client catalog Pomegr last read, which
shows what the client offers, not what your account may use; with no catalog read
yet, Codex offers only **Default model**. A card shows the planned model beside
the model the session's main agent last recorded, and the task window flags a
difference with **Observed model differs**. The plan is your intent; the
recorded model is the evidence.

### Complete when

Five conditions are checked by Pomegr after the agent reports; a new task starts
with **PR open** and **Tree clean** checked.

| Condition | Passes when |
| --- | --- |
| **PR open** | A pull request that the session's Repository tab lists is open: one the session created, or one for its branch. |
| **Tree clean** | Pomegr's record of the session's repository lists no uncommitted file. |
| **Commit on branch** | The session's branch is not the main branch and has a commit of its own, merged since or not. |
| **PR merged** | That pull request is merged. |
| **CI passed** | Every check on that pull request passed. Pending, failed, and missing checks do not pass. |

A sixth checkbox, **Validated with the user**, asks the agent to validate the work
with you before it reports. Pomegr cannot observe that, so the agent judges it and
the task shows it as **Agent-reported**, with no pass or fail.

The **Own condition** field under the checks is free text up to 500 characters; an empty field means none. The
agent judges it, and Pomegr does not evaluate it. A fact Pomegr has not observed
is unknown, and unknown never passes.

When the agent reports, Pomegr reads the repository and its pull requests at that
moment and checks the conditions against that read, so the report can take a few
seconds. If Pomegr cannot read a fact, the condition does not pass and the task
lands in **Needs review**. A command that is still running, such as a development
server, keeps **Tree clean** from passing until it ends.

### Move cards

- **Move a card.** Drag it to another column, or between two cards. A line
  shows where the card will land, and a long column scrolls while you hold the
  card near its top or bottom. Dragging is off while a feature filter is on.
- **Move a card from the keyboard.** Focus the card to reveal four buttons, such
  as **Move T-3 up** and **Move T-3 to the next column** (T-3 is an example).
  Arrow keys move between the buttons.

### Find a task

Press **Ctrl K** (**⌘ K** on a Mac), or select **Search tasks** in the top bar, while
the board is open. The search looks at the board of the repository you are on, and
lists its tasks before the usual destinations.

- **What it matches.** The task ID, the task text, the session title, the feature,
  the column, the chip, and `#` with an issue number, such as `#133`. Every word you
  type must match.
- **Choosing a task.** The desktop app opens the task. A same-computer browser shows
  the card on the **Board** and clears a feature filter that would hide it.
- The search reads nothing new: it uses the board already on screen, and what you
  type is not stored.

### Cards Pomegr moves

Pomegr moves a card to another column when its task changes state:

| When | The card moves to |
| --- | --- |
| The task's session starts and links to it | **In progress** |
| The task becomes **Needs review**: the agent reported it complete | **Review** |
| The task becomes **Done**: you chose **Mark done** | **Done** |

- **Blocked by agent** and **Stalled** do not move a card. It stays where it is,
  normally **In progress**, and holds the queue. A card in **Review** does not hold
  the queue.
- **You can still move a card by hand.** It stays where you put it until its
  task's next state change in the table, which moves it again.
- The card lands last in its new column.

### Queued cards stay in Ready

- **Add to queue**, a start time, and **Requeue task** put the card in **Ready**,
  last. A card already in **Ready** keeps its place.
- A **Queued** or **Scheduled** card cannot be moved to another column until you
  choose **Remove from queue** or its session starts. **Remove from queue** leaves
  the card in **Ready**.
- The queued cards in **Ready** read top to bottom in the order the queue starts
  them, the order the queue starts them. Cards that are not queued keep
  their place between them.
- **Ready** groups its queued cards by step. Each group is headed by its feature
  and step, such as "Step 2 of 4". A frame marked **Parallel** surrounds the cards
  of one step that start together. The queued cards with no feature come last,
  under **Single tasks**.
- **Change a card's step.** In **Ready**, drag a queued card of a feature onto
  another step of that feature to run it in parallel with that step. Drag it just
  under the feature's last step to give it a **New step** of its own at the end.
  A step cannot be inserted between two steps. From the keyboard, or for a card
  that is not in **Ready**, focus the card and use **Move to step…**. It works
  for any card of a feature that has not started, queued or not. A step that is
  running is listed and cannot be chosen. A step whose tasks are all done accepts
  nothing. This is off while a feature filter is on.
- **Reorder single tasks by moving their cards.** Drag a queued card with no
  feature above or below another in **Ready**, or use its move up and move
  down buttons. Feature tasks follow their steps, so a card dropped out of that order
  lands back in it.

A board holds up to 500 tasks and 50 features. A feature title is up to 80
characters, its description up to 2000, and its app version up to 40.

A board you made before the columns were fixed keeps every task. A column you
moved goes back to its place. A column you added or renamed is removed, and its
cards move to the end of **Backlog** in the order they had. A renamed column
that Pomegr moved cards to is the exception: it gets its fixed name back and
keeps its cards.

## Read a task's state

| State | Meaning | Set by |
| --- | --- | --- |
| **Not queued** | On the board, not in the queue. | Creating the task, or **Remove from queue**. |
| **Queued** | Waiting for its turn and the start gates. The next one reads **Queued · next**. | **Add to queue**, or **Requeue task**. |
| **Scheduled** | Queued with its own start time. | Setting **Start at** on the task. |
| **Needs review** | The agent reported complete. The task window shows each checked condition's result and the agent's attention line, if it gave one. | Pomegr, when it verifies the report. |
| **Stalled** | The session ended without a report. | Pomegr, once the session's end is established. |
| **Blocked by agent** | The agent reported it cannot continue and gave a reason. | The agent. |
| **Done** | You accepted the task. An agent's report never sets it. | You, with **Mark done**. |

A task has no **Running** state. Once a session is linked to a task that has no
outcome yet, its card shows that session's observed state, such as **In progress**
(see [Sessions and agents](sessions-and-agents.md#read-a-sessions-state)). Until
Pomegr has observed the session, the card keeps the task's own state, so a state
is never shown and then taken back. **Stalled** means Pomegr observed the session
end with no report, not that the work failed. Pomegr confirms the end with a second
reading about 20 seconds after the first, so a session that reads as ended for a
moment does not stall its task.

### Attach images

In the desktop app a task can hold up to four images: PNG, JPEG, GIF, or WebP, each
at most 5 MB. Paste or drop an image into the **Task** field, or select **Attach
image** at the foot of the field and choose files. The image shows in the text,
where your cursor was, so you can write around it: "make the header look like
this", then the image. To remove an image, delete it like a character, with
**Backspace** or **Delete**.

- An image counts as 24 characters of the 4,000.
- In **New task** the images are stored when you select **Create task**. If one
  cannot be stored, the task is still created and its task window opens to say so.
- In a task window an image is part of the draft, like the text. **Save** stores
  it, and **Close** or **Escape** discards it.
- A session gets the images the task holds when it starts, and is told which image
  the text means at each place. After that you cannot add or remove an image until
  you select **Requeue task**.
- Deleting a task deletes its images.
- A card, the Search bar, and a session's Task tab show `[image]` where the text
  holds an image.

Images stay on this computer, in the same private store as the task text. Creating
a GitHub issue from a task sends the text only, with `[image]` in place of each image.

## Start a session

Open a card and select **Start session**. A task can start when it is **Not
queued**, **Queued**, or **Scheduled** and has no session linked. A scheduled task
cannot start before its own time. In the desktop app you can also ask Aril to start a
task: see [Start a session from the chat](agent-chat.md#start-a-session-from-the-chat).

1. Pomegr asks "Start task T-3?" and does nothing until you confirm. On a paired
   phone, confirm in the phone's browser; no click on the PC is needed.
2. A visible terminal window opens on the computer running Pomegr, in the repository, or in the task's worktree
   (see below), running Claude Code or Codex with the model and effort you chose.
   The task window says "Session started in a new terminal window."
3. When the plugin in that session reports in, the task links to the session. The
   card then shows **Open session** and the session's state.

The session is told one fixed message: your task text, where the task's images
are, the **Complete when** list, and
the instruction to call `complete_task` when the work is complete or `block_task` with
a short reason if it cannot proceed. With nothing checked, the message says the
agent's report alone completes the task, which still goes to **Review**. A Claude Code session may read the folder
that holds the task's images, and a Codex session gets them attached to the
message. Starting never changes the task's state
or its place in the queue. The card moves once the session links (see
[Cards Pomegr moves](#cards-pomegr-moves)). Until the session links, or ten minutes pass, the task
cannot start again, so you do not get two sessions.

## Group tasks into features and steps

A feature is an ordered list of steps. Tasks in the same step run in parallel; the
next step starts only when every task of the step before it is done. Select
**New feature…** in a task's **Feature** field or **+ New feature** above the
board. A task that joins a feature takes a new last step, so it runs after the
feature's other tasks. To run it in parallel with another task, or earlier, move it
to that step on the Board (see [Queued cards stay in Ready](#queued-cards-stay-in-ready)). A feature is done when all its tasks are.
Only unfinished features are offered for a new attachment. Select a feature chip
in the filter row to show only its tasks.

A feature also holds the context its tasks share: a **description** and an **app
version**, the version you plan the feature for. Put there what every task of the
feature needs to know, so that each task's own text stays short. The session Pomegr
starts for a task gets the feature's title and ID in its prompt, and reads the
description and the app version with the `get_feature` tool when it needs them. The
desktop app sets all three fields, and an agent can too (see
[What agents report](#what-agents-report)).

### Create, edit, and delete a feature

You make, edit, and delete features in the Pomegr desktop app. A browser or a paired phone
shows features but does not change them, except that a task's **New feature…** field
still names a feature from a title alone.

1. To create a feature, choose **+ New feature** on the Board, in the row above the
   lanes. While the board has no feature, the button is in the page header instead.
2. Enter a **Title**, up to 80 characters. It is the only required field.
3. Optionally enter a **Description**, up to 2,000 characters, and an **App version**,
   up to 40. The counters show how much room is left.
4. Choose **Create feature**. It stays disabled until the title holds text.
5. To edit a feature, choose it in the **Feature** filter above the board, then choose
   **Edit feature**. The description and the app version load when the window opens.
   If they cannot be read, those two fields stay disabled and you can still rename the
   feature.
6. Change a field and choose **Save**. It stays disabled until something differs, and
   it sends only what you changed. Empty the description or the app version and save
   to remove it.

The window shows how many of the feature's tasks are done. A feature with tasks lists
them under **Tasks**, folded; choose a task there to open it. Closing the window or
pressing Escape discards your changes without asking. A click outside the window
closes it only while it holds nothing to save.

A title that another feature already has is refused, with the line "Another feature
already has this title." A board holds up to 50 features. Any other failure shows
"The feature could not be saved." The window stays open and keeps what you typed.

To delete a feature, open it with **Edit feature**, choose **Delete feature**, and
confirm. The window asks first and says how many tasks the feature has. Deleting
cannot be undone, but it removes no task. Each task stays on the board, in the same
lane, with no feature and no step. A queued task stays queued and runs as a single
task, so in **Ready** it moves below the queued tasks of the other features and starts
after them. The feature's description and app version are deleted with it. If the
feature was chosen in the **Feature** filter, the filter returns to **All**.

You cannot delete a feature while one of its tasks has started and is not done. The
window shows which task, for example "T-34 is running. Delete the feature after its
tasks finish.", and **Delete feature** stays disabled. A done task never blocks.
If the delete fails, the window stays open and shows "The feature could not be
deleted."

A step that holds more than one task starts each task in a Git worktree of its
own, on a branch named `tasks/<task ID>`, so parallel agents do not edit the same
files. The worktree begins at the repository's current commit, so uncommitted
changes in the repository are not part of it. A task alone in its step, or with no
feature, runs in the repository itself. Pomegr keeps its worktrees inside the
repository, in `.pomegr/worktrees/<task ID>`. That folder ignores its own contents,
so the worktrees do not show as changes in the repository.

- When you mark a task done, Pomegr removes the task's worktree and its
  `tasks/<task ID>` branch. To keep them, clear **Remove worktree and branch when
  done** in the task. The box is checked for every new task.
- Pomegr never removes a worktree that has uncommitted changes or a commit that
  exists nowhere else, and never forces a removal. Such a worktree stays until you
  commit, push, or remove it. A worktree whose folder is still in use, for example
  by an open terminal, is removed about a minute after it is free.
- The branch is deleted only with its worktree, so every commit on it is also on a
  remote or on another local branch.
- The other worktree Pomegr removes itself is one made for a start that then failed.
- A worktree that an earlier version made under the desktop app's data folder keeps
  working where it is.
- A requeued task reuses its worktree only if Git still lists it on the task
  branch and it is clean. Otherwise the start fails and nothing is touched.
- When a start is refused because the task's worktree has uncommitted changes, the
  task window says "This task's worktree has uncommitted changes. Pomegr never
  removes them. Open the folder to commit or discard them, then try again." and
  offers **Open folder**. Commit or discard the changes there, then start the
  session again. **Open folder** works in the desktop app on Windows. When the queue
  made the start, it pauses instead (see [When the queue stops](#when-the-queue-stops)).

## Run the queue

The queue starts tasks without you. It is **Off** for every repository until you
select **On** in the **Queue** switch of the Tasks header. Add a task with
**Add to queue** in its task window. With the queue off, queued tasks start only when you start
them. Turning it off never touches a running session.

The **Ready** column shows what runs when. Each step is headed **Parallel** or
**One task**. Tasks with no feature appear under **Single tasks**. To change a
step, see [Queued cards stay in Ready](#queued-cards-stay-in-ready).

- **Order.** Features come first, in the order the board lists them, then each
  feature's steps in order, then single tasks in the order of their cards in the
  board's **Ready** column (see
  [Queued cards stay in Ready](#queued-cards-stay-in-ready)).
- **One step at a time.** The queue starts every queued task of the current step
  in the same check, one after another. It starts nothing in a later step, or a
  later single task, until earlier work has reported and is done.
- **A waiting feature holds only itself.** A step waits when an earlier step of its
  feature has a task that is not done, not in review, and not running, for example
  a task you did not add to the queue. The queue does not start that task, so it
  goes on with the other features and the single tasks, and marks one of those
  **Queued · next**. The waiting feature runs when you add the earlier task to the
  queue or mark it done.
- **Started tasks.** A task whose session has started is no longer shown as next or
  as waiting. It keeps its state and shows its session's state, and later steps
  wait for it. While a task with no feature is running, the queue starts nothing,
  even when the Board still marks the next single task **Queued · next**.
- **Timing.** The desktop app asks for the next start every 15 seconds, so the
  queue works only while Pomegr is open.

### When the queue stops

A task that stalled or was blocked by its agent stops the whole
queue. A banner reads **Queue blocked** and names the task. Nothing new starts
until you resolve that task; sessions already running continue. Open the task and
choose one of two actions. In the desktop app, the banner also offers them, as
**Mark done and resume** and **Requeue T-n**.

- **Mark done and resume queue** accepts the task as done and keeps its report and
  session link.
- **Requeue task** puts it back in the queue as **Queued** with its card last in
  **Ready**, clears its
  report and session link, and lets a new session report once more.

> **Note:** Pomegr checks a report once, against the repository and its pull requests
> as it reads them when the report arrives. A condition that comes true later, such
> as CI that finishes after the agent reported, still reads **Not passed** in the
> task window though the condition now holds. Choose **Mark
> done**; Pomegr does not repeat the check.

Every task an agent reports complete needs review, whether its conditions passed
or not: only you mark a task done. A task that needs review does not stop the queue. Its work is finished: the card
waits in **Review**, the next queued task starts, and a later step of the same
feature starts too. Open the task when you have time and choose **Mark done** or
**Requeue task**. If the agent asked for your attention, the task window shows its
line under **Complete when**, in the agent's own words.

A task whose session never reports holds the queue too. Pomegr never marks it done
or stalled by itself while it cannot tell that the session ended, for example
after the computer or Pomegr restarted, and the queue never moves past it, because
the task can matter to the whole feature. Open the task and choose **Mark done**
or **Requeue task**; the task window says "The session has not reported. Mark done and
Requeue do not stop it." Neither action stops the session. **Mark done** accepts
the task, and a later report from that session changes nothing. **Requeue task**
clears the session link, so a later report from the old session is not accepted.

A start that fails pauses the queue instead. The **Queue paused** banner names the
task and one of these reasons. Fix it, then select **On** again to retry.

| Reason | What to do |
| --- | --- |
| The provider's command-line tool was not found. | Install Claude Code or Codex on this computer. |
| The Pomegr plugin is not installed in this repository, or needs an update. | Install it, or update it to 0.9.0 or later; see [Reporting plugins](reporting-plugins.md#install-the-plugin). |
| Starting sessions is available on Windows only. | Start tasks from a Windows computer. |
| Its worktree has uncommitted changes, and Pomegr never removes them. | Select **Open folder** in the banner (desktop app, Windows), commit or discard the changes there, then select **On** again. |
| The terminal window could not be opened. | Select **On** to retry. |
| The terminal opened, but the session did not report back. | Check the plugin, and for Codex that its hooks are trusted. |

## Start gates

Before every start, manual or queued, Pomegr judges four start gates from
facts it has already observed. **Queue settings** on the Board lists each reading, and a held
queued task shows "Waiting:" with the reasons. A missing, stale, or partial
reading is unknown, and unknown holds a start exactly like a failed gate.

| Gate | A start proceeds only when |
| --- | --- |
| **Previous step done** | Every task of the step before it is done. Holds only the queue: **Start session** starts a task whatever its step. |
| **Claude Code capacity** and **Codex capacity** | The provider is below the threshold for its five-hour window, or its weekly window for weekly-only Codex accounts. |
| **Provider status** | The provider's public status shows no incident. |
| **Working tree** | The repository's working tree has no uncommitted changes. |

The threshold is 70, 85, or 95 percent, with 85 as the default, and applies to one repository.
It uses the five-hour window. Codex accounts with only a weekly limit use their seven-day window instead.
When both windows exist, the seven-day reading is informational.
The readings are the [usage limits](../concepts/usage-limits.md) Pomegr already
shows, so they cover your whole account. Public status does not prove that an
incident affects you. The working tree gate reads the repository itself, even
for a task that will start in its own worktree. A held queued task changes
nothing: it waits, the queue stays on, and Pomegr judges again at the next check.
A held manual start says which gates hold it, for example "This task is held:
Claude Code usage is not known yet."

## Schedule starts

- **A task's own time.** In the task window, **Start at** takes a date and time. It
  makes the task **Scheduled**, adds it to the queue, and keeps the queue from
  starting it earlier. Clear the time to leave the task **Queued**. A scheduled
  task that is not yet due holds nothing behind it, but its feature's next step
  waits until it has run.
- **The queue's window.** Under **Schedule**, in **Queue settings** on the Board, **Start at a
  time** sets a time of day before which the queue starts nothing, and **Stop
  starting tasks after** sets a time from which it starts nothing. Pomegr applies
  the next occurrence of that time. Both hold queued starts only; a start you make
  by hand is not held by them. **Run now** clears the start time.

A time can be at most a year ahead. Times are judged only when the desktop app
asks for the next start, so Pomegr must be open. A time that passed while it was
closed counts from the next check, and the start then happens unless the stop time
has come. A stop time that has passed keeps holding the queue until you change or
clear it. A schedule never stops, pauses, or touches a running session.

## What agents report

The plugin gives agents eleven task tools. Each call is tied to the calling session by
the coding tool, not by anything the model supplies. [MCP tools](mcp-tools.md) lists
these tools with the plugin's reporting and query tools.

| Tool | What it does |
| --- | --- |
| `add_task` | Adds a task to the board of the session's repository. A session started for a task adds to the same board, even from a task worktree. It lands in the first column, not queued. It may carry **Run on**, **Complete when**, with plugin 0.9.3 or later **Remote Control** (`remote_control`, for a Claude Code task only), and the exact name of an unfinished feature, which puts the task in a new last step. When the same session adds the same text to the same feature again within five minutes, it gets the task it already added instead of a second one (plugin 0.9.2 or later tells the agent when Pomegr did not answer in time, so the agent does not add the task twice). |
| `update_task` | Changes a task on the board that has not started: its text, **Run on**, **Effort**, or **Complete when**. A value the agent sets replaces the stored one. It needs plugin 0.9.6 or later. See [Tasks an agent can change](#tasks-an-agent-can-change). |
| `remove_task` | Deletes a task the same session added with `add_task`, such as a duplicate. It needs plugin 0.9.1 or later. See [Tasks an agent can remove](#tasks-an-agent-can-remove). |
| `assign_task` | Assigns the session to a task of the board that is not done. It needs plugin 0.9.8 or later. See [Assign a session to a task](#assign-a-session-to-a-task). |
| `unassign_task` | Removes the session's own assignment from a task. It needs plugin 0.9.8 or later. |
| `complete_task` | Reports the work done on the task the session was started for, or on a task it is assigned to. Pomegr then verifies the checked conditions. The task goes to **Review**, never straight to **Done**. The agent may add one line of up to 200 characters that names what needs your attention. |
| `block_task` | Reports that the agent cannot continue, with a reason of up to 200 characters. The task becomes **Blocked by agent**. |
| `get_feature` | Reads one feature of the board: its ID, title, description, and app version. The agent names the feature by its ID or its exact title. With no input, it reads the feature of the session's task. It changes nothing. |
| `create_feature` | Creates a feature with a title, and optionally a description and an app version. A title that another feature has is refused. |
| `update_feature` | Changes the title, description, or app version of a feature. A field the agent leaves out stays as it is. It changes no task. |
| `delete_feature` | Deletes a feature that has no task. A feature that still has tasks is refused, so no task loses its feature or its step. It cannot be undone. |

The four feature tools need plugin 0.9.4 or later. They work on any feature of the
session's board, also one that you made. In Claude Code, `get_feature` needs no
approval, because it only reads the session's own board. The three tools that change
a feature ask for your approval like the other task tools.

`complete_task` and `block_task` act only on the task linked to the calling
session and on the tasks that session is assigned to. In Claude Code, the coding tool ties each call to its session; if Claude
Code hooks are off or the hook times out, an agent's add, update, remove, complete, block, or feature call is
refused and nothing is added, removed, reported, read, or changed. When Claude Code asks you to approve such
a call, you have up to ten minutes to do so; after that the call is refused and the
agent can try again. Choose to always allow the tools a session should use without you so
a session you are not watching does not wait for you. Leave `remove_task` on ask if you
want to approve each deletion. In Claude Code's auto mode no prompt appears: Claude
Code decides by itself and can, rarely, refuse one of these calls. If that happens,
add a permission rule for the tool in your Claude Code settings. A task takes one report per start; a second report changes
nothing. A report always leaves the task in **Needs review**, with each checked
condition's pass or fail; you choose **Mark done**. When no condition is checked, the
report rests on the agent's word, not a check. A session that ends
without a report leaves the task **Stalled**, but only once Pomegr has established
the session's end, for example a **Closed** session or a **Stopped** Claude Code
session. A Codex session reads **Stopped** after a failed or interrupted turn while
it may still be able to report, so **Stopped** alone does not stall a Codex task; it
stalls only once Pomegr sees that Codex no longer holds the session (Windows). An
**Idle** or **Open** session never stalls a task. A stalled task leaves that state
only through **Mark done and resume queue** or **Requeue task**. Pomegr keeps only
each condition's pass or fail, the block reason, and the attention line, never command
output or diffs.

### Tasks an agent can change

With plugin 0.9.6 or later, an agent can change a task that is already on the board,
for example to add a finding to it. `update_task` works when all of these are true:

- The task is on the board of the session's repository. It can be a task you made, a
  task from a GitHub issue, or a task any session added.
- The task has not started: it is **Not queued**, **Queued**, or **Scheduled**, and
  no session is linked to it.
- No start is in progress for it.

The agent can change the task text, **Run on** (the provider and the model),
**Effort**, and **Complete when**. A value the agent sets replaces the stored value. A
value it leaves out stays as it is. The agent cannot move the task, queue it, start
it, or change its feature, its images, or **Remote Control**.

No tool gives a task's text to an agent. An agent that sets the text therefore
replaces text it has not read. If the agent does not have the full text, give it the
text you want to keep. A new text that leaves out an image keeps the image attached
to the task.

An agent can never change a task that started or finished, so a running session
always matches the task it was started for. The agent gets the same answer for such
a task as for a task that does not exist. Pomegr answers only that the task was
changed or not, never with the task's content.

### Tasks an agent can remove

An agent can delete a task only when all of these are true:

- The same session added the task with `add_task`.
- The task has not started: it is **Not queued**, **Queued**, or **Scheduled**, and
  no session is linked to it.
- No start is in progress for it, and it has no report.

Your own edits do not change this. If you edit, move, or queue a task an agent added,
you can still ask that session to remove it.

An agent can never remove a task you made, a task promoted from a GitHub issue, a task
another session added, or a task that started or finished. It gets the same answer
for each of these as for a task that does not exist, so it learns nothing about
tasks it did not add. To delete one of them, use **Delete task** in the desktop app.

A removal cannot be undone, and the task number is not used again. The task's images
are deleted with it. If the queue was blocked at that task, the queue resumes.

## Assign a session to a task

Pomegr links a task to the session that it starts for the task. You can also assign
other sessions to a task, such as a session that you start by hand to continue the
work after the first session stopped. A task can have many assigned sessions, and a
session can be assigned to many tasks.

An assignment is only a marker. It does not change the state, the column, or the
queue place of the task. It does not start, stop, or change a session. The queue can
still start its own session for the task, so remove the task from the queue if you do
not want that.

To let the agent assign its own session, ask it to assign itself to the task, for
example "assign this session to T-12". The agent calls `assign_task`. It can assign
itself only to a task of its own repository's board that is not **Done**.

To assign a session yourself, in the desktop app or on a paired phone:

1. Open the task.
2. Under **Sessions**, choose a session. The list shows the ten newest sessions of
   the repository that are not closed.
3. Select **Assign session**. The session appears in the list as **Assigned**.

To remove an assignment, select **Unassign** on the row of the session. You cannot
unassign the session that Pomegr started.

An assigned session can report the task with `complete_task` or `block_task`:

- The first report on a task wins. A later report from another session changes
  nothing.
- An assigned session can report a **Stalled** task. The task then goes to
  **Review**, or becomes **Blocked by agent**.
- Pomegr verifies **Complete when** on the repository and the branch of the session
  that reports.
- A session with more than one task names the task in its report.
- **Requeue task** keeps the assigned sessions.

The card shows **Open session** for the first session, and **+1 more** for each
other one. The card state still follows only the session that Pomegr started.

## See a task from Sessions

On a same-computer browser or the desktop app, tasks show up beside the sessions
started for them. Other devices see none of it.

- **Sessions list.** The **Task** column shows the task number, the number of its
  [GitHub issue](github-issues.md) if it has one, its feature and
  step, and a chip only for **Needs review**, **Stalled**, or **Done**. **Group
  by** **Feature** and the **Feature** chip filter are described in
  [Sessions and agents](sessions-and-agents.md#find-a-session). A session that is
  assigned to tasks shows them after the word **Assigned**. A dash means that the
  session has no task.
- **Session view.** The header shows the task, feature, and step. The task
  ID opens the **Task** tab, the last tab. It is read-only. It shows the task text, the planned and observed model, the
  definition of done with each check's result, and the feature's tasks in the same
  and next step. A long task text is cut to ten lines. Select **Show all** to read
  the rest. **Open on board** goes to the card. A session with no task has no
  **Task** tab. The feature name, in the header and on the **Task** tab, opens that
  repository's board with the feature chosen in the **Feature** filter. In the desktop
  app it also opens the feature's window. On a paired device, the filter is the view
  of the feature. If the feature was deleted, the whole board opens.
- **Events.** The **Events** list on the **Overview** tab adds a row when the agent
  adds, removes, updates, or reports a task complete or blocked. The
  row names the agent and the time, not the task. It comes from the agent's own tool
  call in the session, so it appears on every device that shows the session, and a
  call that Pomegr refused adds no row. **Task updated** records the agent's update
  call. **Task reported complete** is the agent's
  report; the task then waits in **Review** until you mark it done. A change you make
  on the board adds no row.

## What Pomegr does not do

- It never stops, attaches to, answers, or approves work in a running session, and
  it never merges a pull request.
- It makes no AI judgment about whether work is complete. It compares the agent's
  report with observed facts, and the own condition is the agent's judgment.
- It does not turn silence into success. An unknown fact does not pass, and a
  session that vanished is **Stalled** only after its end is established.
- Task text, task images, and your other task content stay in a private store on
  this computer, apart from session history, so pruning history never deletes a
  task. The session Pomegr starts for a task is given that task's images. A
  feature's description and app version are given only to an agent that asks for
  them with `get_feature`, and so reach its provider like the task text. They are
  never in reports, notifications, or the session list, which carries only a task's
  number, outcome, feature name, step, and GitHub issue number.

To have an agent cut a feature into tasks or order the board for you, see
[Agent chat](agent-chat.md).

For what the session list and states mean, see
[Sessions and agents](sessions-and-agents.md); for which values are agent
reports, see [Signals and estimates](../concepts/signals-and-estimates.md).
