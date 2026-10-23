---
title: "Create and edit tasks"
description: "Create a task on the board, set how its session runs and what Pomegr checks, attach images, and edit it until it starts."
---

# Create and edit tasks

A task describes one piece of work for a coding agent. You can change it until its
session starts. For the main path, see [Tasks](tasks.md).

## Where you can change tasks

- You create, edit, move, queue, and schedule tasks in the Pomegr desktop app or on a
  phone you paired with it (see [Phone access](phone-access.md)). Pomegr must remain
  open on the computer.
- You can confirm a manual start on the phone. The session runs on the computer that
  runs Pomegr. You can turn the queue on or off from either device.
- Only the desktop app works with [GitHub issues](github-issues.md): it starts a task
  from an open issue, or creates an issue from a task.
- The desktop app and a paired phone attach images. A browser on the same computer
  neither sends nor shows them.
- A browser on the same computer shows the board read-only and says "Tasks are created
  and edited in the Pomegr desktop app or on a paired device."

## Create a task

1. On the **Board**, hover the **Backlog** column, or move keyboard focus into it, and
   select **New task** under its last card. On a touch screen the action is always
   shown.
2. Describe the work in **Task**, up to 4,000 characters. It is the only required
   field. A card shows the first sentence of this text as its title, without its tags,
   until its session has a title. Then the card shows the session title.
3. To show the agent a screenshot or a mock-up, paste an image into the text or select
   **Attach image**; see [Attach images](#attach-images).
4. Set the optional fields; see [Task fields](#task-fields).
5. Select **Create task**. **Cancel** closes the window and writes nothing.

With **Create task**, the task lands in the first column and is not queued. The arrow
beside **Create task** opens two more ways to create the task:

- **Create and queue** creates the task and adds it to the queue, at the end of
  **Ready**.
- **Create and start session** creates the task and starts its session at once, after
  the same confirmation as **Start session**.

If the task is created but cannot be queued or started, its task window opens and says
why. The task is kept.

## Edit a task

Select a card to open its task window. Your changes stay a draft until you select
**Save**.

- **Save** is available once something differs from the stored task. **Close** or
  **Escape** discards the draft.
- While a draft is unsaved, **Start session**, **Add to queue**, **Remove from queue**,
  **Mark done**, and **Requeue task** are unavailable.
- **Delete task** asks you to confirm. A task number is never reused.

Once a task has started, you cannot change it. The session works from the task as it
was when it started, so a later change would not reach it. The task window then shows
the task as text, without **Save**. A lock and the line "Started, so read-only." sit
beside the **Task** label. The line adds "Requeue to edit." when **Requeue task** is
available. This applies from the start of the session on, and to a task that is in
review, blocked, stalled, or done.

A task can start while its window holds unsaved changes. Pomegr then drops the changes.
A line in the footer says "This task started before your changes were saved."

- A task that needs you opens with a panel: **Ready for your review**, or the state
  name for a stalled or blocked task. The panel holds the agent's report and the result
  of each condition; see [Review a report](tasks-queue.md#review-a-report).
- The text shows its tags, its first line as a title, and the rest as paragraphs and
  lists. A line that starts with `- `, or with a number and a period, is a list item. Code between backticks,
  UUIDs, and dates show in a code font.
- **Run settings** lists the task's settings as plain values.
- **Requeue task** makes the task editable again until its next session starts.
- While a queued task is in progress, the task window offers no **Remove from queue**.
- You can still move, delete, mark done, and requeue a started task.

## Task fields

| Field | What it sets |
| --- | --- |
| **Run on** | Required. The provider and model of the started session's main agent: under **Claude Code** or **Codex**, a model or **Default model**. A new task starts with the choice of the newest task on the board, or with **Claude Code** and **Default model** on an empty board. Subagents are not set. A task that an agent added without a provider shows **Not set** until you choose one, and starts on Claude Code. |
| **Effort** | Required. **Low**, **Medium**, **High**, or **Xhigh**. A new task starts with the effort of the newest task on the board, or with **Medium** on an empty board. You cannot clear it. |
| **Remote Control** | The box "Open the session on your phone too" starts the Claude Code session with Remote Control on, so you can also open that session on your phone or in a browser, signed in to the same Claude account. It is off by default and is not available for a Codex task. Pomegr only passes Claude Code's own `--remote-control` option; it does not connect to the session. |
| **When done** | The box **Remove worktree and branch** is on by default. When you mark the task done, Pomegr removes the Git worktree it made for the task and the task's branch. It changes nothing for a task that runs in the repository itself, and never removes uncommitted or unpushed work; see [Worktrees](tasks-order.md#worktrees). |
| **Complete when** | The conditions an agent's report is checked against; see [Complete when](#complete-when). |
| **Feature** | The feature the task belongs to. A feature is shared context and a way to group tasks on the board. It does not set when the task runs; see [Features](tasks-features.md). |
| **Runs after** | The tasks that must be done before this task starts; see [Runs after](tasks-order.md#runs-after). |
| **Start at** | A date and time before which the queue does not start the task; see [Schedule starts](tasks-start-gates.md#schedule-starts). |

Claude Code lists the newest model of each family Pomegr has seen in your sessions.
Codex lists the models in the client catalog Pomegr last read. That catalog shows what
the client offers, not what your account may use. With no catalog read yet, Codex
offers only **Default model**.

A card shows the planned model beside the model the session's main agent last
recorded. The task window flags a difference with **Observed model differs**. The plan
is your intent; the recorded model is the evidence. The card also shows the main agent's latest reported effort and flags when it differs from the planned effort.

## Complete when

Pomegr checks five conditions after the agent reports. A new task copies the checks
and the own condition of the newest task on the board. On an empty board it starts
with **PR open** and **Tree clean** checked.

| Condition | Passes when |
| --- | --- |
| **PR open** | A pull request that the session's Repository tab lists is open: one the session created, or one for its branch. |
| **Tree clean** | Pomegr's record of the session's repository lists no uncommitted file. |
| **Commit on branch** | The session's branch is not the main branch and has a commit of its own, merged since or not. |
| **PR merged** | That pull request is merged. |
| **CI passed** | Every check passed on each open pull request, or on each merged one when none is open. Pending, failed, and missing checks do not pass. |

- **Validated with the user**, a sixth checkbox, asks the agent to validate the work
  with you before it reports. Pomegr cannot observe that, so the agent judges it. The
  task shows it as **Agent-reported**, with no pass or fail.
- **Own condition**, under the checks, is free text up to 500 characters. An empty
  field means none. The agent judges it, and Pomegr does not evaluate it.
- A fact Pomegr has not observed is unknown, and unknown never passes.

When the agent reports, Pomegr reads the repository and its pull requests at that
moment and checks the conditions against that read, so the report can take a few
seconds. If Pomegr cannot read a fact, the condition does not pass and the task lands
in **Needs review**. A command that is still running, such as a development server,
keeps **Tree clean** from passing until it ends. [Review a report](tasks-queue.md#review-a-report)
explains the results.

## Tag a task

In the desktop app or on a paired phone, the first line of **Task** is the title line.
It uses larger type.

Start it with one or more words in brackets, such as `[ backend ]`. Each word turns into
a tag label above the title line as soon as you type its closing bracket. The caret
stays at the start of the title.

- A tag is one word of 1 to 24 letters, digits, `.`, `_`, or `-`.
- Spaces inside the brackets are allowed.
- A task shows at most eight tags, and a repeated word shows once.
- Brackets anywhere else in the text stay text.
- To remove the last tag, press **Backspace** at the very start of the title line.
- A tag is a label for you. The task text keeps its brackets.
- The character count, the saved text, and what the agent reads are the same as if you had typed the brackets.
- Tags can sit on their own lines. Every line at the start that holds only tags joins the tags, and the title is the first text after them.
- Blank lines between tags do not matter: a tag typed at the start of the title line joins the tags above it.
- A tag needs no space after it. If text follows it right away, Pomegr adds one space.
- A pasted line of tags that touch each other, such as `[a][b]Title`, gets the same spaces.
- If you press **Backspace** right after typing the closing bracket, the tag becomes text again, without its last bracket, so you can correct it.
- A pasted line that starts with tags turns all of them into labels.
- **Ctrl+A** (**Cmd+A** on a Mac) selects the tags too, and **Copy** includes them. **Cut**, **Delete**, or typing over that selection removes them, and **Undo** brings them back.
- Selecting only the title line and retyping it keeps the tags.
- A task whose text is only tags shows its tags as labels over an empty title line. A card shows the tags' text as its title.

## Attach images

In the desktop app or on a paired phone, a task can hold up to four images: PNG, JPEG, GIF, or WebP, each at
most 5 MB. Paste or drop an image into the **Task** field, or select **Attach image**
at the foot of the field and choose files. The image shows in the text, where your
cursor was, so you can write around it: "make the header look like this", then the
image. To remove an image, delete it like a character, with **Backspace** or
**Delete**.

- An image counts as 24 characters of the 4,000.
- In **New task** the images are stored when you select **Create task**. If one cannot
  be stored, the task is still created and its task window opens to say so.
- In a task window an image is part of the draft, like the text. **Save** stores it,
  and **Close** or **Escape** discards it.
- A session gets the images the task holds when it starts, and is told which image the
  text means at each place. After that you cannot add or remove an image until you
  select **Requeue task**.
- Deleting a task deletes its images.
- A card, the Search bar, and a session's Task tab show `[image]` where the text holds
  an image.

Images stay on this computer, in the same private store as the task text. Creating a
GitHub issue from a task sends the text only, with `[image]` in place of each image.
