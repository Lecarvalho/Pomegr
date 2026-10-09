---
title: "Tasks"
description: "Plan work on a repository's task board, queue it, and have the Pomegr desktop app start Claude Code or Codex sessions for it."
---

# Tasks

A repository's **Tasks** tab holds a board of work you want coding agents to do.
You can start a session for a task yourself, or turn on a queue and let the
desktop app start tasks one step at a time. After a start, Pomegr only observes
the session: it never stops, attaches to, answers, or approves anything in a
running session. Observing sessions works the same whether or not you use tasks.

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
  [Reporting plugins](reporting-plugins.md#install-the-plugin). Without it a start
  is refused with "Install the Pomegr plugin in this repository to start
  sessions." Codex runs plugin hooks only after you trust them.
- **Install the coding tool.** If Pomegr cannot find the Claude Code or Codex
  program, a start says "The provider's command-line tool was not found on this
  computer."

## Create and organize tasks

Open a repository (see [Repositories](repositories.md#open-a-repository)) and
select **Tasks**. A new board has five columns: **Backlog**, **Ready**,
**In progress**, **Review**, and **Done**. They are only places to arrange cards.
Moving a card never changes its state.

### Create a task

1. Select **New task**.
2. Describe the work in **Task**, up to 4,000 characters. It is the only required
   field. A card shows this text until its session has a title, then the title.
3. Set the optional fields below.
4. Select **Create task**, or **Create and add another**.

The task lands in the first column and is not queued. Select a card to open its
task panel, where a change saves when a field changes or loses focus. **Delete
task** asks you to confirm; a task number is never reused.

| Field | What it sets |
| --- | --- |
| **Run on** | The provider and model of the started session's main agent: **Not set**, or under **Claude Code** or **Codex** a model or **Default model**. Subagents are not set. A task with no provider starts on Claude Code. |
| **Effort** | **Low**, **Medium**, **High**, or **Xhigh**. Select the chosen button again to clear it. |
| **Done when** | The conditions an agent's report is checked against; see [Done when](#done-when). |
| **Feature**, **Step in feature** | Where the task runs among related tasks; see [Group tasks into features and steps](#group-tasks-into-features-and-steps). |

Claude Code lists the newest model of each family Pomegr has seen in your
sessions. Codex lists the models in the client catalog Pomegr last read, which
shows what the client offers, not what your account may use; with no catalog read
yet, Codex offers only **Default model**. A card shows the planned model beside
the model the session's main agent last recorded, and the task panel flags a
difference with **Observed model differs**. The plan is your intent; the
recorded model is the evidence.

### Done when

Five conditions are checked by Pomegr after the agent reports; a new task starts
with **Pull request open** and **Working tree clean** checked.

| Condition | Passes when |
| --- | --- |
| **Pull request open** | The pull request for the session's branch is open. |
| **Working tree clean** | Pomegr's record of the session's repository lists no uncommitted file. |
| **Commit on task branch** | The session's branch is not the main branch and has a commit of its own, merged since or not. |
| **Pull request merged** | That pull request is merged. |
| **CI passed** | Every check on the branch's pull request passed. Pending, failed, and missing checks do not pass. |

The last row, **Your own condition**, is free text up to 500 characters. The
agent judges it, and Pomegr does not evaluate it. A fact Pomegr has not observed
is unknown, and unknown never passes.

### Move cards and manage columns

- **Move a card.** Drag it to another column, or onto a card to place it before
  that card. Dragging is off while a feature filter is on.
- **Move a card from the keyboard.** Focus the card to reveal four buttons, such
  as **Move T-3 up** and **Move T-3 to the next column** (T-3 is an example).
  Arrow keys move between the buttons.
- **Manage columns.** **Add column** appends one. A column's **Edit column**
  button renames it, moves it left or right, or offers **Delete column**, which
  works only on an empty column and never on the last one.

A board holds up to 500 tasks, 12 columns, and 50 features. A column name is up
to 40 characters and a feature name up to 80.

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
   The panel says "Session started in a new terminal window."
3. When the plugin in that session reports in, the task links to the session. The
   card then shows **Open session** and the session's state.

The session is told one fixed message: your task text, the **Done when** list, and
the instruction to call `complete_task` when the work is done or `block_task` with
a short reason if it cannot proceed. With nothing checked, the message says the
agent's report alone completes the task. Starting never changes the task's state,
column, or queue position. Until the session links, or ten minutes pass, the task
cannot start again, so you do not get two sessions.

## Group tasks into features and steps

A feature is an ordered list of steps. Tasks in the same step run in parallel; the
next step starts only when every task of the step before it is done. Select
**New feature…** in a task's **Feature** field or **+ New feature** above the
board, then choose **Step in feature**: **Last · new step N**, or an existing step,
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

## Run the queue

The queue starts tasks without you. It is **Off** for every repository until you
select **On** in the **Queue** switch of the Tasks header (which is separate from
the **Board** and **Queue** view buttons beside it). Add a task with **Add to
queue** in its panel. With the queue off, queued tasks start only when you start
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

A start that fails pauses the queue instead. The **Queue paused** banner names the
task and one of these reasons. Fix it, then select **On** again to retry.

| Reason | What to do |
| --- | --- |
| The provider's command-line tool was not found. | Install Claude Code or Codex on this computer. |
| The Pomegr plugin is not installed in this repository. | Install it; see [Reporting plugins](reporting-plugins.md#install-the-plugin). |
| Starting sessions is available on Windows only. | Start tasks from a Windows computer. |
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

- **A task's own time.** In the task panel, **Start at** takes a date and time. It
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
| `add_task` | Adds a task to the board of the session's repository. It lands in the first column, not queued. It may carry **Run on**, **Done when**, and the exact name of an unfinished feature, which puts the task in a new last step. Agents cannot create features. |
| `complete_task` | Reports the work done on the task the session was started for. Pomegr then verifies the checked conditions. |
| `block_task` | Reports that the agent cannot continue, with a reason of up to 200 characters. The task becomes **Blocked by agent**. |

`complete_task` and `block_task` act only on the task linked to the calling
session. A task takes one report per start; a second report changes nothing. If
every checked condition passes, the task is **Done**; if one fails, it is **Needs
review**. When no condition is checked, the agent's report alone completes the
task, which is the agent's word, not a check. A session that ends without a report
leaves the task **Stalled**, but only once Pomegr has established the session's
end, for example a **Closed** or **Stopped** session. An **Idle** or **Open**
session never stalls a task. A stalled task leaves that state only through **Mark
done and resume queue** or **Requeue task**. Pomegr keeps only each condition's
pass or fail and the block reason, never command output or diffs.

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
