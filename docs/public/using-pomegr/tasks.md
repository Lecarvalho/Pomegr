---
title: "Tasks"
description: "Plan work on a repository's task board, queue it, and have the Pomegr desktop app start Claude Code or Codex sessions for it."
---

# Tasks

A task board holds the work you want coding agents to do in one repository. You start
a session for a task yourself, turn on the queue and let the desktop app start tasks
one after another, or start an [Aril grant](#aril-grants). After a start, Pomegr only
observes the session: it never attaches to, answers, or approves anything in a
running session, and it ends the session only when its task is done
([Done ends the task's sessions](#done-ends-the-tasks-sessions)). Observing sessions
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

### Done ends the task's sessions

When a task is done, Pomegr ends the sessions it started for the task in its terminal: the
builder session and any review session. This stops the provider process and the helper
processes it started, so finished work does not keep using memory. Pomegr never ends a session
you started outside Pomegr, and it never ends a session for another task.

When you choose **Mark done** or drag a card into **Done** in the desktop app, an idle session
ends at once. If the session is still working, Pomegr asks first: "Its session is still working.
End it?" **End session** ends it. **Keep it running** leaves it running until you close Pomegr. Both
choices mark the task done. A session that is still working when a grant marks a task done is left
running, and Pomegr ends it later if it goes idle and the task is still done. Pomegr also ends the
idle sessions of tasks that were done before you updated, or that you marked done on your phone.

### Read the task log

In the desktop app or on your paired phone, select **Log** in the strip above the
board. It lists task starts, reports, stalls, CI results, and merges, newest
first. The task log stays on the computer that runs Pomegr. Aril reads entries after its last answer;
the divider shows how far it has read. Opening the log does not move that marker.

In a task window, **Reworks** records earlier work that this task fixes. On the desktop
or a paired device, enter a task reference such as `T-12` or a pull request such as
`#336`, choose a cause, and select **Add**. You can remove a link beside its chip.
Each task can name up to five earlier items; adding a link leaves its state unchanged
and adds **Rework** to the log. Causes are declarations, not automatic detections.

### Aril settings

Open **Settings** and select **Aril** to turn Aril on or off, edit memory, see the space conversations take, and set the reviewer.
**Aril settings** above the board opens the same section for that board's repository. In the **Per repository** card, choose the repository,
which Pomegr remembers, then choose the reviewer's provider and model, and whether a different provider than the builder reviews.
Each change saves at once.

The **Memory** card has a tab for each repository: free text of at most 6,000 characters about how things are done there. Aril keeps it current
and you can edit it; it is context and not permission (see [Aril's settings and memory](agent-chat.md#arils-settings-and-memory)).

Paired devices can read these settings and the memory. To allow changes, enable **Allow paired devices to change Aril settings and memory** in the desktop app.
Only the desktop app can change that permission. A grant's own settings (actions, limits, and work rules) are no longer in Settings.

### Aril grants

A grant lets the desktop app run a repository's selected Ready tasks while you are away. Only you
start a grant, in the desktop app or on a paired phone you allow. Aril settings alone grant no
action. A grant ends at its end time or when you quit Pomegr, and it never renews itself.

Settings no longer offers a grant's actions, limits, or work rules, or a way to start one: a later version replaces grants with agreements you settle in the chat. A grant that is still running keeps one line in **Settings**, under **Aril**, with its end time and **Stop grant**. A phone can always stop a grant.

How a grant that was started earlier counts its limits:

| Limit | What it counts |
| --- | --- |
| **Hours** | How long the grant lasts. |
| **Tasks** | The different tasks the grant takes on. A task counts once, when the grant first starts it. Its reviews and send-backs are part of that task. |
| **Tasks at a time** | The taken tasks that are open. A task is open until it is merged, marked done, or needs you. |
| **Send-backs per task** | How often Aril sends one task back after a failed review. |
| **Usage limit %** | The provider usage at or above which the grant starts nothing. |

A task needs you when it is blocked, out of send-backs, or has a refused merge for its current
pull-request head. When the grant has taken **Tasks** tasks, it starts no new task. It keeps reviewing,
sending back, and merging the open ones, and it ends when none remains open.

While a grant is active, the desktop app does these things, as far as you allowed them, without asking for each one:

- **Start.** It starts the Ready tasks that your work rules select, in Ready order, behind every
  [start gate](tasks-start-gates.md).
- **Review.** It starts a separate reviewer session for a task in **Review**. The reviewer runs the
  repository's checks, changes no code, and reports pass or fail.
- **Send back.** After a failed review, it starts a new builder session in the same worktree. When the
  send-backs are used, the task stays in **Review** for you.
- **Merge.** With **Merge on green**, it merges a task's open pull request only after the latest review
  passed and CI passed for the known pull-request head. It attempts each head commit once. The task
  stays in **Review** for your **Mark done**, unless you also allowed **Mark done when acceptance passes**.
- **Mark done.** With **Mark done when acceptance passes**, it marks a task **Done** after its pull request
  merged, when a fresh check shows every **Complete when** condition passed and its review passed (when reviews
  are on). A condition Pomegr could not check is no pass. A task with no **Complete when** condition, or whose
  **Complete when** asks for your validation, stays yours. Tasks that run after it can then start. The task's
  idle sessions end, and a session that still works is left running. The log reads “Marked done by Aril under a grant”.
- **Write tasks.** With **Write tasks from plans**, Aril creates tasks in **Ready** from the next unbuilt
  step of the plans you named. It writes at most **Tasks** tasks, and they join the grant's work set.

Choose how a grant merges before it may merge. Ask Aril to propose these settings: it reads the
repository's own rules and GitHub settings first.

- **Merge method.** The repository default, unless you choose **Squash**, **Merge commit**, or **Rebase**.
  If the repository allows several methods, choose one.
- **Merge mode.** **Merge when green** merges once CI passes. **Auto-merge when green** asks GitHub to merge
  through the repository's auto-merge or merge queue, when its rules allow. The repository must allow
  auto-merge. The log then reads “Auto-merge enabled by Aril”.
- **Delete branch after merge.** **Repository default** leaves it to GitHub's own setting, and Pomegr deletes
  nothing. **Delete** deletes the task's branch from the repository after its pull request is merged, never the
  default branch or a fork's branch. **Keep** deletes nothing. A grant that used all its tasks waits up to ten
  minutes after the last merge for that deletion.
- **Send follow-ups.** On by default. After grant actions, Aril adds a short line to the chat and sends a
  notification. See [Agent chat](agent-chat.md).

The grant starts no task, review, or send-back for a provider whose usage is unknown, stale,
unavailable, or at the usage limit. Writing tasks waits the same way for the provider that would run it.
It resumes when that usage is current and below the limit. Merges are never held for usage.

To see what a grant did, select **Log**; see [Read the task log](#read-the-task-log). The log lists each start,
review, send-back, merge, branch deletion, and written task. It also lists each usage pause and resume
with the provider name, and each refused merge or branch deletion.
To watch a review, open the task's **Terminal** tab in the desktop app. It lists the task's build and review
sessions, and a review carries a **Review** label.

The strip above the board shows **Aril grant until** the end time, and the **Aril** section of Settings shows the tasks used.
Select **Stop grant** to stop every further grant action at once. Running sessions continue, because
stopping a grant ends no session. A paired phone can always stop a grant. It can start one only when you allow
paired devices in the **Aril** section of Settings. That section shows when the last grant ended and why.

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

Pomegr keeps the ID of every reviewer session with its task, and when it was linked,
until you delete the task. The **Sessions** list shows a reviewer session's task,
marked **Review**, after the review ends and after the task is done or requeued. The
task's **Terminal** tab still finds an ended review.

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

- It never attaches to, answers, or approves work in a running session, and it ends a
  session only when its task is done. A pull
  request can be merged only by the desktop runner under an active grant, after passing
  CI and review. Only you mark a task Done, or a grant you allowed to, after its acceptance passes.
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
