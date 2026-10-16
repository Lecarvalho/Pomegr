---
title: "Task sessions"
description: "How Pomegr starts and links a task's session, how to assign other sessions to a task, and where a task shows up in Sessions."
---

# Task sessions

Pomegr links a task to the session it starts for the task. You can assign other
sessions to the task too. A session started for a task shows the task beside it in
**Sessions**. For the main path, see [Tasks](tasks.md#start-a-session).

## Start a task's session

A task can start when it is **Not queued**, **Queued**, or **Scheduled** and has no
session linked. A scheduled task cannot start before its own time.

1. Open a card and select **Start session**. Pomegr asks "Start task T-3?" and does
   nothing until you confirm. On a paired phone, confirm in the phone's browser; no
   click on the PC is needed.
2. A visible terminal window opens on the computer that runs Pomegr, in the repository
   or in the task's [worktree](tasks-order.md#worktrees). It runs Claude Code or Codex
   with the model and effort you chose. The task window closes.
3. When the plugin in that session reports in, the task links to the session. The card
   then shows **Open session** and the session's state.

- Starting never changes the task's state or its place in the queue. The card moves
  once the session links (see [Cards Pomegr moves](tasks-board.md#cards-pomegr-moves)).
- Until the session links, or ten minutes pass, the task cannot start again, so you do
  not get two sessions.
- [What reaches the agent](tasks-agents.md#what-reaches-the-agent) lists what the
  session is told.

## Assign a session to a task

You can assign other sessions to a task, such as a session that you start by hand to
continue the work after the first session stopped. A task can have many assigned
sessions, and a session can be assigned to many tasks.

An assignment is only a marker. It does not change the state, the column, or the queue
place of the task. It does not start, stop, or change a session. The queue can still
start its own session for the task, so remove the task from the queue if you do not
want that.

To let the agent assign its own session, ask it to assign itself to the task, for
example "assign this session to T-12". The agent calls `assign_task`. It can assign
itself only to a task of its own repository's board that is not **Done**.

To assign a session yourself, in the desktop app or on a paired phone:

1. Open the task.
2. Under **Sessions**, choose a session. The list shows the ten newest sessions of the
   repository that are not closed and not already on the task.
3. Select **Assign session**. The session appears in the list as **Assigned**.

To remove an assignment, select **Unassign** on the row of the session. You cannot
unassign the session that Pomegr started.

An assigned session can report the task with `complete_task` or `block_task`:

- The latest report from a linked or assigned session wins until you mark the task done.
- A completion after a block keeps the owner hold. See [How a report is checked](tasks-agents.md#how-a-report-is-checked).
- An assigned session can report a **Stalled** task, and so can the session Pomegr
  started. The task then goes to **Review**, or becomes **Blocked by agent**.
- Pomegr verifies **Complete when** on the repository and the branch of the session
  that reports.
- A session with more than one task names the task in its report.
- **Requeue task** keeps the assigned sessions.

The card shows **Open session** for the first session, and **+1 more** for each other
one. The card state still follows only the session that Pomegr started.

## See a task from Sessions

On a same-computer browser or the desktop app, tasks show up beside the sessions
started for them. Other devices see none of it.

- **Sessions list.** The **Task** column shows the task number, the number of its
  [GitHub issue](github-issues.md) if it has one, its feature, and a chip only for
  **Needs review**, **Stalled**, or **Done**. **Group by** **Feature** and the
  **Feature** chip filter are described in
  [Sessions and agents](sessions-and-agents.md#find-a-session). A session that is
  assigned to tasks shows them after the word **Assigned**. A dash means that the
  session has no task.
- **Session view.** The header shows the task and its feature. The task ID opens the
  **Task** tab, the last tab. It is read-only. It shows the task text, the planned and
  observed model, the definition of done with each check's result, and the feature's
  tasks that run with this session and the ones that come next. A long task text is cut
  to ten lines. Select **Show all** to read the rest. **Open on board** goes to the
  card. A session with no task has no **Task** tab.
- **Feature link.** The feature name, in the header and on the **Task** tab, opens that
  repository's board with the feature chosen in the **Feature** filter. In the desktop
  app it also opens the feature's window. On a paired device, the filter is the view of
  the feature. If the feature was deleted, the whole board opens.
- **Events.** The **Events** list on the **Overview** tab adds a row when the agent
  adds, removes, updates, or reports a task complete or blocked. The row names the
  agent and the time, not the task. It comes from the agent's own tool call in the
  session, so it appears on every device that shows the session, and a call that Pomegr
  refused adds no row. **Task updated** records the agent's update call. **Task
  reported complete** is the agent's report; the task then waits in **Review** until
  you mark it done. A change you make on the board adds no row.
