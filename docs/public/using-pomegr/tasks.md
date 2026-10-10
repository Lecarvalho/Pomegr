---
title: "Tasks"
description: "Plan work on a repository's task board, queue it, and have the Pomegr desktop app start Claude Code or Codex sessions for it."
---

# Tasks

**Tasks** in the sidebar opens a board of work you want coding agents to do, one
repository at a time; the **Repository** menu beside the heading switches
repository. You can start a session for a task yourself, or turn on a queue and
let the desktop app start tasks one step at a time. After a start, Pomegr only
observes the session: it never stops, attaches to, answers, or approves anything
in a running session. Observing sessions works the same whether or not you use
tasks.

## Before you start

- **Use the desktop app to change anything.** You create, edit, move, queue,
  schedule, and start tasks only in the Pomegr desktop app. A browser on the same
  computer shows the board read-only and says "Tasks are created and edited in
  the Pomegr desktop app." A phone or another device on your network sees
  **Desktop only** and no task content (see [Phone access](phone-access.md)).
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

Select **Tasks** in the sidebar and choose a repository in the **Repository**
menu. A repository's own **Tasks** tab links to the same board. A board has five
columns: **Backlog**, **Ready**, **In progress**, **Review**, and **Done**. You
cannot add, rename, reorder, or delete a column. Moving a card never changes its
state.

### Create a task

1. On the **Board** view, hover the **Backlog** column, or move keyboard focus
   into it, and select **New task** under its last card. On a touch screen the
   action is always shown. The **Queue** view has no columns, so it has no
   **New task**.
2. Describe the work in **Task**, up to 4,000 characters. It is the only required
   field. A card shows this text until its session has a title, then the title.
3. Set the optional fields below.
4. Select **Create task**. **Cancel** closes the window and writes nothing.

The task lands in the first column and is not queued. Select a card to open its
task window, where your changes stay a draft until you select **Save**. **Save**
is available once something differs from the stored task, and **Close** or
**Escape** discards the draft. While a draft is unsaved, **Start session**, **Add
to queue**, **Remove from queue**, **Mark done**, and **Requeue task** are
unavailable. **Delete task** asks you to confirm; a task number is never reused.

| Field | What it sets |
| --- | --- |
| **Run on** | The provider and model of the started session's main agent: **Not set**, or under **Claude Code** or **Codex** a model or **Default model**. Subagents are not set. A task with no provider starts on Claude Code. |
| **Effort** | **Low**, **Medium**, **High**, or **Xhigh**. Select the chosen button again to clear it. |
| **Done when** | The conditions an agent's report is checked against; see [Done when](#done-when). |
| **Feature**, **Step** | Where the task runs among related tasks; see [Group tasks into features and steps](#group-tasks-into-features-and-steps). |

Claude Code lists the newest model of each family Pomegr has seen in your
sessions. Codex lists the models in the client catalog Pomegr last read, which
shows what the client offers, not what your account may use; with no catalog read
yet, Codex offers only **Default model**. A card shows the planned model beside
the model the session's main agent last recorded, and the task window flags a
difference with **Observed model differs**. The plan is your intent; the
recorded model is the evidence.

### Done when

Five conditions are checked by Pomegr after the agent reports; a new task starts
with **PR open** and **Tree clean** checked.

| Condition | Passes when |
| --- | --- |
| **PR open** | The pull request for the session's branch is open. |
| **Tree clean** | Pomegr's record of the session's repository lists no uncommitted file. |
| **Commit on branch** | The session's branch is not the main branch and has a commit of its own, merged since or not. |
| **PR merged** | That pull request is merged. |
| **CI passed** | Every check on the branch's pull request passed. Pending, failed, and missing checks do not pass. |

The **Own condition** field under the five checks is free text up to 500 characters; an empty field means none. The
agent judges it, and Pomegr does not evaluate it. A fact Pomegr has not observed
is unknown, and unknown never passes.

A condition also passes only when Pomegr read its fact after the session's last
related work. If a command ran after the last read, or Pomegr could not date the
fact, the condition does not pass and the task lands in **Needs review**, even when
it now holds. A command that is still running, such as a development server,
keeps **Tree clean** from passing until it ends.

### Move cards

- **Move a card.** Drag it to another column, or onto a card to place it before
  that card. Dragging is off while a feature filter is on.
- **Move a card from the keyboard.** Focus the card to reveal four buttons, such
  as **Move T-3 up** and **Move T-3 to the next column** (T-3 is an example).
  Arrow keys move between the buttons.

### Cards Pomegr moves

Pomegr moves a card to another column when its task changes state:

| When | The card moves to |
| --- | --- |
| The task's session starts and links to it | **In progress** |
| The task becomes **Needs review** | **Review** |
| The task becomes **Done**, also through **Mark done** | **Done** |

- **Blocked by agent**, **Stalled**, and **Requeue task** do not move a card.
- **You can still move a card by hand.** It stays where you put it until its
  task's next state change in the table, which moves it again.
- The card lands last in its new column.

A board holds up to 500 tasks and 50 features. A feature name is up to 80
characters.

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
| **Needs review** | The agent reported complete, but a checked condition did not pass. | Pomegr, when it verifies the report. |
| **Stalled** | The session ended without a report. | Pomegr, once the session's end is established. |
| **Blocked by agent** | The agent reported it cannot continue and gave a reason. | The agent. |
| **Done** | The agent reported complete and every checked condition passed, or none was checked. | Pomegr, when it verifies the report. |

A task has no **Running** state. Once a session is linked to a task that has no
outcome yet, its card shows that session's observed state, such as **In progress**
(see [Sessions and agents](sessions-and-agents.md#read-a-sessions-state)). Until
Pomegr has observed the session, the card keeps the task's own state, so a state
is never shown and then taken back. **Stalled** means Pomegr observed the session
end with no report, not that the work failed.

## Start a session

Open a card and select **Start session**. A task can start when it is **Not
queued**, **Queued**, or **Scheduled** and has no session linked. A scheduled task
cannot start before its own time.

1. Pomegr asks "Start task T-3?" and does nothing until you select **Start
   session** in that dialog.
2. A visible terminal window opens in the repository, or in the task's worktree
   (see below), running Claude Code or Codex with the model and effort you chose.
   The task window says "Session started in a new terminal window."
3. When the plugin in that session reports in, the task links to the session. The
   card then shows **Open session** and the session's state.

The session is told one fixed message: your task text, the **Done when** list, and
the instruction to call `complete_task` when the work is done or `block_task` with
a short reason if it cannot proceed. With nothing checked, the message says the
agent's report alone completes the task. Starting never changes the task's state
or queue position. The card moves once the session links (see
[Cards Pomegr moves](#cards-pomegr-moves)). Until the session links, or ten minutes pass, the task
cannot start again, so you do not get two sessions.

## Group tasks into features and steps

A feature is an ordered list of steps. Tasks in the same step run in parallel; the
next step starts only when every task of the step before it is done. Select
**New feature…** in a task's **Feature** field or **+ New feature** above the
board, then choose **Step**: **Last · new step N**, or an existing step,
such as "Step 2 · parallel with T-3". A feature is done when all its tasks are.
Only unfinished features are offered for a new attachment. Select a feature chip
in the filter row to show only its tasks.

A step that holds more than one task starts each task in a Git worktree of its
own, on a branch named `tasks/<task ID>`, so parallel agents do not edit the same
files. The worktree begins at the repository's current commit, so uncommitted
changes in the repository are not part of it. A task alone in its step, or with no
feature, runs in the repository itself. Pomegr keeps its worktrees in a folder it
owns under the desktop app's data folder.

- Pomegr never removes a worktree that has uncommitted changes or a commit that
  exists nowhere else, and never forces a removal.
- The only worktree it removes itself is one made for a start that then failed.
  Worktrees of finished tasks stay until you remove them.
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
select **On** in the **Queue** switch of the Tasks header (which is separate from
the **Board** and **Queue** view buttons beside it). Add a task with **Add to
queue** in its task window. With the queue off, queued tasks start only when you start
them. Turning it off never touches a running session.

The **Queue** view shows what runs when. Each unfinished feature lists its steps,
marked **Parallel** or **One task**. Drag a queued task to another step, or to
**New last step**, or use **Move to step…** from the keyboard; a step whose tasks
are all done accepts none. Tasks with no feature appear under **Single tasks**.

- **Order.** Features come first, in the order the board lists them, then each
  feature's steps in order, then single tasks in the order you queued them.
- **One step at a time.** The queue starts every queued task of the current step
  in the same check, one after another. It starts nothing in a later step, or a
  later single task, until earlier work has reported and is done.
- **Started tasks.** A task whose session has started is no longer shown as next or
  as waiting. It keeps its state and shows its session's state, and later steps
  wait for it. While a task with no feature is running, the queue starts nothing,
  even when the Queue view still marks the next single task **Queued · next**.
- **Timing.** The desktop app asks for the next start every 15 seconds, so the
  queue works only while Pomegr is open.

### When the queue stops

A task that needs review, stalled, or was blocked by its agent stops the whole
queue. A banner reads **Queue blocked** and names the task. Nothing new starts
until you resolve that task; sessions already running continue. Open the task and
choose one of two actions.

- **Mark done and resume queue** accepts the task as done and keeps its report and
  session link.
- **Requeue task** puts it back at the end of the queue as **Queued**, clears its
  report and session link, and lets a new session report once more.

> **Note:** Pomegr checks a report against what it has already observed. A pull
> request opened seconds before the agent reports may not be recorded yet, so the
> task can show **Needs review** though the condition now holds. Choose **Mark
> done and resume queue**; Pomegr does not repeat the check.

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
facts it has already observed. The **Queue** view lists each reading, and a held
queued task shows "Waiting:" with the reasons. A missing, stale, or partial
reading is unknown, and unknown holds a start exactly like a failed gate.

| Gate | A start proceeds only when |
| --- | --- |
| **Previous step done** | Every task of the step before it is done. |
| **Claude Code capacity** and **Codex capacity** | The task's provider is below the **Do not start above** threshold of its five-hour window. |
| **Provider status** | The provider's public status shows no incident. |
| **Working tree** | The repository's working tree has no uncommitted changes. |

The threshold is 70, 85, or 95 percent of the five-hour window, 85 by default,
and applies to one repository. The seven-day window is shown but decides nothing.
The readings are the [usage limits](../concepts/usage-limits.md) Pomegr already
shows, so they cover your whole account. Public status does not prove that an
incident affects you. The working tree gate reads the repository itself, even
for a task that will start in its own worktree. A held queued task changes
nothing: it waits, the queue stays on, and Pomegr judges again at the next check.
A held manual start answers "A start gate holds this task. See Start gates in the
Queue view."

## Schedule starts

- **A task's own time.** In the task window, **Start at** takes a date and time. It
  makes the task **Scheduled**, adds it to the queue, and keeps the queue from
  starting it earlier. Clear the time to leave the task **Queued**. A scheduled
  task that is not yet due holds nothing behind it, but its feature's next step
  waits until it has run.
- **The queue's window.** In the Queue view's **Schedule** panel, **Start at a
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

The plugin gives agents three tools. Each call is tied to the calling session by
the coding tool, not by anything the model supplies.

| Tool | What it does |
| --- | --- |
| `add_task` | Adds a task to the board of the session's repository. A session started for a task adds to the same board, even from a task worktree. It lands in the first column, not queued. It may carry **Run on**, **Done when**, and the exact name of an unfinished feature, which puts the task in a new last step. Agents cannot create features. |
| `complete_task` | Reports the work done on the task the session was started for. Pomegr then verifies the checked conditions. |
| `block_task` | Reports that the agent cannot continue, with a reason of up to 200 characters. The task becomes **Blocked by agent**. |

`complete_task` and `block_task` act only on the task linked to the calling
session. In Claude Code, the coding tool ties each call to its session; if Claude
Code hooks are off or the hook times out, an agent's add, complete, or block call is
refused and nothing is added or reported. When Claude Code asks you to approve such
a call, you have up to ten minutes to do so; after that the call is refused and the
agent can try again. Choose to always allow the three tools so a session you are not
watching does not wait for you. In Claude Code's auto mode no prompt appears: Claude
Code decides by itself and can, rarely, refuse one of these calls. If that happens,
add a permission rule for the tool in your Claude Code settings. A task takes one report per start; a second report changes
nothing. If every checked condition passes, the task is **Done**; if one fails, it
is **Needs review**. When no condition is checked, the agent's report alone
completes the task, which is the agent's word, not a check. A session that ends
without a report leaves the task **Stalled**, but only once Pomegr has established
the session's end, for example a **Closed** session or a **Stopped** Claude Code
session. A Codex session reads **Stopped** after a failed or interrupted turn while
it may still be able to report, so **Stopped** alone does not stall a Codex task; it
stalls only once Pomegr sees that Codex no longer holds the session (Windows). An
**Idle** or **Open** session never stalls a task. A stalled task leaves that state
only through **Mark done and resume queue** or **Requeue task**. Pomegr keeps only
each condition's pass or fail and the block reason, never command output or diffs.

## See a task from Sessions

On a same-computer browser or the desktop app, tasks show up beside the sessions
started for them. Other devices see none of it.

- **Sessions list.** The **Task** column shows the task number, its feature and
  step, and a chip only for **Needs review**, **Stalled**, or **Done**. **Group
  by** **Feature** and the **Feature** chip filter are described in
  [Sessions and agents](sessions-and-agents.md#find-a-session). A dash means you
  started the session yourself.
- **Session view.** The header shows the task, feature, and step. The **Overview**
  tab has a compact **Task** row whose heading opens the **Task** tab, the last
  tab. It is read-only. It shows the task text, the planned and observed model, the
  definition of done with each check's result, and the feature's tasks in the same
  and next step. **Open on board** goes to the card. A session with no task has no
  **Task** tab.

## What Pomegr does not do

- It never stops, attaches to, answers, or approves work in a running session, and
  it never merges a pull request.
- It makes no AI judgment about whether work is complete. It compares the agent's
  report with observed facts, and the own condition is the agent's judgment.
- It does not turn silence into success. An unknown fact does not pass, and a
  session that vanished is **Stalled** only after its end is established.
- Task text and your other task content stay in a private store on this computer,
  apart from session history, so pruning history never deletes a task. They are
  never in reports, notifications, or the session list, which carries only a task's
  number, outcome, feature name, and step.

For what the session list and states mean, see
[Sessions and agents](sessions-and-agents.md); for which values are agent
reports, see [Signals and estimates](../concepts/signals-and-estimates.md).
