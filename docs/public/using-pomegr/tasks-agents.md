---
title: "What agents report"
description: "The task tools the Pomegr plugin gives agents, how Pomegr checks a report, and which tasks an agent may change or remove."
---

# What agents report

The Pomegr plugin gives agents fourteen task tools. Each call is tied to the calling
session by the coding tool, not by anything the model supplies. [MCP tools](mcp-tools.md)
lists these tools with the plugin's reporting and query tools. For the main path, see
[Tasks](tasks.md).

## Task tools

| Tool | What it does |
| --- | --- |
| `add_task` | Adds a task to the board of the session's repository. A session started for a task adds to the same board, even from a task worktree. It lands in the first column, not queued. It may carry **Run on**, **Complete when**, with plugin 0.9.3 or later **Remote Control** (`remote_control`, for a Claude Code task only), the exact name of a feature that is not done, which attaches the task to it, and with plugin 0.9.12 or later **Runs after** (`runs_after`, up to 8 task IDs of the board). When the same session adds the same text to the same feature again within five minutes, it gets the task it already added instead of a second one (plugin 0.9.2 or later tells the agent when Pomegr did not answer in time, so the agent does not add the task twice). |
| `get_task` | Reads one task of the board by its ID: its text, column, state, feature, **Run on**, **Effort**, **Complete when**, **Runs after**, and whether `update_task` can change it. It changes nothing. It needs plugin 0.9.13 or later. See [What an agent can read](#what-an-agent-can-read). |
| `list_tasks` | Lists the tasks of the board, Done included, in board order. It changes nothing. It needs plugin 0.9.13 or later. |
| `update_task` | Changes a task on the board that has not started: its text, **Run on**, **Effort**, **Complete when**, or with plugin 0.9.12 or later **Runs after**. A value the agent sets replaces the stored one. It needs plugin 0.9.6 or later. See [Tasks an agent can change](#tasks-an-agent-can-change). |
| `remove_task` | Deletes a task the same session added with `add_task`, such as a duplicate. It needs plugin 0.9.1 or later. See [Tasks an agent can remove](#tasks-an-agent-can-remove). |
| `assign_task` | Assigns the session to a task of the board that is not done. It needs plugin 0.9.8 or later. See [Assign a session to a task](tasks-sessions.md#assign-a-session-to-a-task). |
| `unassign_task` | Removes the session's own assignment from a task. It needs plugin 0.9.8 or later. |
| `complete_task` | Reports the work done on the task the session was started for, or on a task it is assigned to. Pomegr then verifies the checked conditions. The task goes to **Review**, never straight to **Done**. The agent may add one line of up to 200 characters that names what needs your attention. |
| `report_review` | Records a verdict only from a review session Pomegr started for the task. It needs plugin 0.9.15 or later. |
| `block_task` | Reports that the agent cannot continue, with a reason of up to 200 characters. The task becomes **Blocked by agent**. |
| `get_feature` | Reads one feature of the board: its ID, title, description, and app version. The agent names the feature by its ID or its exact title. With no input, it reads the feature of the session's task. It changes nothing. |
| `create_feature` | Creates a feature with a title, and optionally a description and an app version. A title that another feature has is refused. |
| `update_feature` | Changes the title, description, or app version of a feature. A field the agent leaves out stays as it is. It changes no task. |
| `delete_feature` | Deletes a feature that has no task. A feature that still has tasks is refused, so no task loses its feature. It cannot be undone. |

The four feature tools need plugin 0.9.4 or later. They work on any feature of the
session's board, also one that you made. In Claude Code, `get_feature`, `get_task`, and `list_tasks` need no
approval, because they only read the session's own board. The three tools that change a
feature ask for your approval like the other task tools.

## Approve task tool calls

In Claude Code, the coding tool ties each call to its session. If Claude Code hooks are
off or the hook times out, an agent's add, read, update, remove, complete, block, or feature
call is refused. Nothing is then added, removed, reported, read, or changed.

- When Claude Code asks you to approve such a call, you have up to ten minutes to do
  so. After that the call is refused and the agent can try again.
- Choose to always allow the tools a session should use without you, so a session you
  are not watching does not wait for you. Leave `remove_task` on ask if you want to
  approve each deletion.
- In Claude Code's auto mode no prompt appears: Claude Code decides by itself and can,
  rarely, refuse one of these calls. If that happens, add a permission rule for the tool
  in your Claude Code settings.

## How a report is checked

`complete_task` and `block_task` act only on the task linked to the calling session
and on the tasks that session is assigned to.

- The latest report wins until you mark the task done. Agents may report blocked, complete, then blocked again.
- Each completion verifies the checked conditions again. Failed or unavailable checks remain identified.
- CI needs a finished check result for the current checkout commit and its pull request.
- Pending, missing, or mismatched CI evidence reads **Not verified**. A verified failed check reads **Did not pass**.
- After CI finishes, a later completion checks again. The task remains in Review until you choose **Mark done**.
- A completion leaves the task in **Needs review**; you choose **Mark done**. See
  [Complete when](tasks-create.md#complete-when).
- When no condition is checked, the report rests on the agent's word, not a check.
- Pomegr keeps only each condition's result, the block reason, and the attention line,
  never command output or diffs.

A completion after a block replaces the report and check results, and moves the task to **Review**.
The queue stays held. Choose **Mark done** or **Requeue task** to resolve that hold.
An updated report never starts a session or marks a task done.
Pomegr retains earlier reports privately; the task window shows the latest report.
Identical reports with identical results change nothing.

This recovery needs a Pomegr build that supports updated reports and plugin 0.9.14 or later.
Update both before retrying. An older plugin omits the remaining owner hold from its feedback.
The board still shows **Queue blocked** until you resolve that hold.
See [Update the plugin](reporting-plugins.md#update-the-plugin).

A session that ends without a report leaves the task **Stalled**, but only once Pomegr
has established the session's end, for example a **Closed** session or a **Stopped**
Claude Code session.

- A Codex session reads **Stopped** after a failed or interrupted turn while it may
  still be able to report. **Stopped** alone therefore does not stall a Codex task. It
  stalls only once Pomegr sees that Codex no longer holds the session (Windows).
- An **Idle** or **Open** session never stalls a task.
- A stalled task leaves that state when you choose **Mark done and resume queue** or
  **Requeue task**, or when its own session turns out not to have ended:
  - The session reports with `complete_task` or `block_task`. The task goes to
    **Review**, or becomes **Blocked by agent**.
  - Pomegr reads the session **Working** or **Needs input** again, and a second reading
    about 20 seconds later confirms that it has not ended. The task goes back to
    **Not queued** with its session, and its card shows the session's state again.
- Either way, a queue that the stalled task held moves on, unless the session reports
  that it is blocked. Pomegr never starts, stops, or steers the session.

## Tasks an agent can change

With plugin 0.9.6 or later, an agent can change a task that is already on the board,
for example to add a finding to it. `update_task` works when all of these are true:

- The task is on the board of the session's repository. It can be a task you made, a
  task from a GitHub issue, or a task any session added.
- The task has not started: it is **Not queued**, **Queued**, or **Scheduled**, and no
  session is linked to it.
- No start is in progress for it.

The agent can change the task text, **Run on** (the provider and the model),
**Effort**, **Complete when**, and with plugin 0.9.12 or later **Runs after**
(`runs_after`). A value the agent sets replaces the stored value. A
value it leaves out stays as it is. The agent cannot move the task, queue it, start it,
or change its feature or its images. It cannot turn **Remote Control** on; a change
to Codex turns it off.

The text the agent sets replaces the whole text. The agent therefore reads the task
with `get_task` first. A new text that leaves out an image keeps the image attached to
the task.

**Runs after** follows the board's rules (see [Runs after](tasks-order.md#runs-after)):
up to 8 tasks of the same board, and an empty list clears it. A task that is not on the
board, or a list that would make tasks wait for each other, is refused with its own
answer, and nothing of the call is changed. `add_task` takes the same list for the new
task. `get_task` shows the current list, so the agent sets the whole list it wants.

An agent can never change a task that started or finished, so a running session always
matches the task it was started for. The agent gets the same answer for such a task as
for a task that does not exist. Pomegr answers only that the task was changed or not,
never with the task's content.

## What an agent can read

With plugin 0.9.13 or later, an agent can read any task of its session's board.

- `get_task` reads one task by its ID, with its whole text.
- `list_tasks` lists at most 100 tasks, with each text cut at 300 characters. The agent
  can narrow the list by a part of the text, a state, a feature, or whether
  `update_task` can change a task.
- An agent reads a task's text, column, state, feature, **Run on**, **Effort**,
  **Complete when**, and with plugin 0.9.12 or later **Runs after**. Where the text has an image, the agent reads `[image]`.
- An agent never reads a report, an attention line, a block reason, the sessions of a
  task, an image, or who added a task.
- What the agent reads reaches its provider, as the task text of its own prompt does.

For a missing task or an unavailable answer, see [If a task cannot be read](mcp-tools.md#if-a-task-cannot-be-read).

## Tasks an agent can remove

An agent can delete a task only when all of these are true:

- The same session added the task with `add_task`.
- The task has not started: it is **Not queued**, **Queued**, or **Scheduled**, and no
  session is linked to it.
- No start is in progress for it, and it has no report.

Your own edits do not change this. If you edit, move, or queue a task an agent added,
you can still ask that session to remove it.

An agent can never remove a task you made, a task promoted from a GitHub issue, a task
another session added, or a task that started or finished. It gets the same answer for
each of these as for a task that does not exist, so it learns nothing about tasks it
did not add. To delete one of them, use **Delete task** in the desktop app.

A removal cannot be undone, and the task number is not used again. The task's images
are deleted with it. If the queue was blocked at that task, the queue resumes.

## What reaches the agent

The session Pomegr starts for a task is told one fixed message: your task text, where
the task's images are, the **Complete when** list, and the instruction to call
`complete_task` when the work is complete or `block_task` with a short reason if it
cannot proceed. With nothing checked, the message says the agent's report alone
completes the task, which still goes to **Review**.

- A Claude Code session may read the folder that holds the task's images. A Codex
  session gets them attached to the message.
- A feature's description and app version are given only to an agent that asks for
  them with `get_feature`, and so reach its provider like the task text.
- They are never in reports, notifications, or the session list. The session list
  carries only a task's number, outcome, feature name, and GitHub issue number.
