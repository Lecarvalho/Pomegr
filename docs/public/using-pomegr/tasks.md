---
title: "Tasks"
description: "Plan work on a repository's task board, queue it, and have the Pomegr desktop app start Claude Code or Codex sessions for it."
---

# Tasks

A task board holds the work you want coding agents to do in one repository. You start
a session for a task yourself, or turn on the queue and let the desktop app start tasks
one after another. After a start, Pomegr only observes the session: it never stops,
attaches to, answers, or approves anything in a running session. Observing sessions
works the same whether or not you use tasks.

Click through the demo below to see a board at work. It is a demo with sample tasks,
not the Pomegr app, and it starts nothing.

```pomegr-demo
tasks-board
```

## The board

Select **Tasks** in the sidebar to open the Tasks home. **Needs you** lists the tasks
that need review, are stalled, or are blocked by their agent. **Boards** shows one row
for each repository; select its name to open its board.

A board has five fixed columns:

| Column | What it holds |
| --- | --- |
| **Backlog** | New tasks, and the plan of the work you have not queued yet. |
| **Ready** | The queue. Queued cards read top to bottom in the order they start. |
| **In progress** | Tasks whose session started and linked to the task. |
| **Review** | Tasks whose agent reported the work complete. Only you mark them done. |
| **Done** | Tasks you accepted with **Mark done**. |

Pomegr moves a card when its task changes state. You can also drag a card to another
column. [Board and task states](tasks-board.md) explains each state and move.

### Read the task log

In the desktop app or on your paired phone, select **Log** in the strip above the
board. It lists task starts, reports, stalls, CI results, and merges, newest
first. The task log stays on the computer that runs Pomegr. Aril reads entries after its last answer;
the divider shows how far it has read. Opening the log does not move that marker.

### Aril settings

Select **Aril settings** above the board to edit action preferences, limits, work rules, and reviewer preferences.
An unset limit means “Not settled: Aril will ask”. Select **Save** to save your changes.

The **Memory** section lists repository preferences, oldest first. You can add, edit, or delete entries independently of settings.
Each entry holds at most 300 characters; a repository holds at most 100 entries. Confirm deletion inside the panel.

Paired devices can read these settings and entries. To allow changes, enable **Allow paired devices to change Aril settings and memory** in the desktop app.
Only the desktop app can change that permission.

### Aril grants

Settings alone grant no actions. To start a grant, allow **Start tasks**, **Start reviews**,
or both, set **Hours**, **Starts**, and **Concurrent sessions**, and add a work rule.
Save your changes, then select **Start grant** in the panel's **Grant** section and confirm.
The desktop app starts the selected Ready tasks and reviews within the grant's limits,
without asking for each start. When **Send work back** is enabled and **Send-backs per task**
is set, it sends matching tasks with failed reviews to a new builder session in the same worktree.
The strip above the board shows the active grant's end time; the panel also shows starts used.
Select **Stop grant** to stop further starts at once. Running sessions continue.
The panel shows when the last grant ended and why; a grant never renews itself.

A paired device can always stop an active grant; starting one requires that permission.

## Before you start

- **Use the desktop app or a paired phone.** You change tasks in the Pomegr desktop app
  or on a [paired phone](phone-access.md). A browser on the same computer shows the
  board read-only.
- **Use Windows to start sessions.** Starting sessions works on Windows only for now.
  Elsewhere a start answers "Starting sessions is available on Windows only."
- **Install the Pomegr plugin 0.9.0 or later in the repository.** The started session
  links to its task, and the agent reports its result, through the plugin; see
  [Reporting plugins](reporting-plugins.md#install-the-plugin).
- **Install Claude Code or Codex** on the computer that runs Pomegr.

## Create a task

1. On the board, hover the **Backlog** column and select **New task** under its last
   card. On a touch screen the action is always shown.
2. Describe the work in **Task**. It is the only required field.
3. Check **Run on**, **Effort**, and **Complete when**. A new task takes these choices from
   the newest task on the board.
4. Select **Create task**. The card lands in **Backlog**, not queued.

The arrow beside **Create task** offers **Create and queue** and **Create and start
session**. [Create and edit tasks](tasks-create.md) explains each field, images, and
the conditions Pomegr checks. To start from an open GitHub issue,
or to create an issue from a task, see [GitHub issues](github-issues.md).

## Start a session

1. Open a card and select **Start session**.
2. Pomegr asks "Start task T-3?" and does nothing until you confirm. T-3 is an example.
3. A terminal window opens on the computer that runs Pomegr. It runs Claude Code or
   Codex with the model and effort of the task.
4. When the plugin in that session reports in, the task links to the session. The card
   moves to **In progress** and shows **Open session**.

The agent reports with `complete_task` when the work is complete, or with `block_task`
when it cannot continue. A completion puts the task in **Review**, never in **Done**.
A later completion keeps an existing block until you resolve it; see [What agents report](tasks-agents.md#how-a-report-is-checked). A
[start gate](tasks-start-gates.md) can hold a start, for example while a provider has an
incident. In the desktop app you can also ask Aril to start a task; see
[Start a session from the chat](agent-chat.md#start-a-session-from-the-chat).

### Review a task's work

In the desktop app, open a task in **Review** with a linked session and select
**Start review**, before **Requeue task** in the footer. Confirm **Start review**
in the native dialog to start a separate reviewer session in the task's worktree,
or the repository folder when no task worktree is available. No worktree is created.

The reviewer checks the work and runs the repository's checks. It changes no code,
does not move the task, and is instructed to report **pass** or **fail**. The verdict
appears in the task modal's **Review** row, on the desktop and a paired device.
The row reads **Review running…** until the reviewer reports, then **Passed** or
**Failed** with the time and, for a failure, its reasons. It shows only verdicts
from the task's current stay in Review. Starting a review is available only in
the Windows desktop app.

## Run the queue

1. Open a task and select **Add to queue**. Its card moves to **Ready**, last.
2. Select **On** in the **Queue** switch of the Tasks header. The queue is **Off** for
   every repository until you turn it on.
3. The queue starts the top waiting card of **Ready**. It starts the next card when that
   task is in **Review** or **Done**.

To change the order, drag a queued card up or down in **Ready**. A waiting card says
what it waits for. The queue works only while Pomegr is open, and turning it off never
touches a running session. [Task queue](tasks-queue.md) explains the wait reasons and
what to do when the queue stops. To run cards at the same time, or to make one task
wait for another, see [Parallel tasks and Runs after](tasks-order.md).

## What Pomegr does not do

- It never stops, attaches to, answers, or approves work in a running session, and it
  never merges a pull request.
- It makes no AI judgment about whether work is complete. It compares the agent's
  report with observed facts. The own condition is the agent's judgment. An unknown
  fact never passes.
- It does not turn silence into success. A session that vanished is **Stalled** only
  after Pomegr establishes its end.
- Task text, task images, and your other task content stay in a private store on this
  computer, apart from session history. Pruning history never deletes a task.

## Learn more

- [Create and edit tasks](tasks-create.md): fields, images, and **Complete when**.
- [Board and task states](tasks-board.md): columns, card moves, search, and states.
- [Features](tasks-features.md): group tasks and give them shared context.
- [Task queue](tasks-queue.md): order, wait reasons, and what to do when the queue stops.
- [Parallel tasks and Runs after](tasks-order.md): groups, worktrees, and dependencies.
- [Start gates and schedules](tasks-start-gates.md): what holds a start, and start times.
- [What agents report](tasks-agents.md): the task tools and how a report is checked.
- [Task sessions](tasks-sessions.md): assign a session, and see a task from **Sessions**.
- [Agent chat](agent-chat.md): have Aril cut a feature into tasks or order the board.
- [Signals and estimates](../concepts/signals-and-estimates.md): which values are agent
  reports.
