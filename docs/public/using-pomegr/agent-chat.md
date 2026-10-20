---
title: "Agent chat"
description: "Ask Aril, the Pomegr task-board agent, to cut work into tasks, order the board, advise on models, start a task's session, and turn the queue on or off. You approve every change and every start."
---

# Agent chat

**Aril** is the agent built into Pomegr that helps you organize a repository's task
board. You ask in a chat panel at the bottom right of the window. Aril reads the board,
the repository's files, and what Pomegr observed, then answers. Aril never changes the
board by itself: it proposes changes, and you apply them. Aril starts no session and
turns no queue on or off by itself either: it proposes that, and you apply it.

## Before you start

- **Use the desktop app or a paired device.** The **Aril** button shows in the Pomegr
  desktop app and on a phone you paired with it (see
  [Phone access](phone-access.md)). A browser on the same computer has no chat.
- **Install the coding tool and sign in.** A message runs Claude Code or Codex on your
  computer, signed in as you, so it uses your own subscription allowance. Pomegr reads
  and stores no credential. Without the tool, the panel says that it is not installed on
  this computer.
- **Keep the coding tool current.** The chat needs the native launch options provided by current Claude Code and Codex versions.
- **Have a repository.** Aril works on one repository's board. Pomegr lists a repository
  once it observed a session there.

> **Note:** Each message starts one read-only run of the coding tool. So does each
> proposal you apply or dismiss, for Aril's follow-up. The run can read files and
> Pomegr's observations. It cannot write a file, run a command that changes something,
> or use your other tools and plugins.

When a task's text was shortened in the board snapshot, Aril can read the whole task on demand with `get_task`. It reads only the selected repository's board, including the task's conditions and attention or block line; it changes nothing.

Aril uses the coding tool's native read permissions. It starts in the selected repository, but permissions may allow reading files elsewhere.
Pomegr does not add a separate file filter. Aril remains configured without write access, and you apply its board proposals.
Codex needs a supported Windows sandbox: native MXC, or a provisioned elevated sandbox.
Some read commands can still be refused by the coding tool's policy. Aril reports missing evidence instead of guessing.

On large boards, Aril keeps task titles first, then details for In progress, Review, Ready, Done, and Backlog.
Ready follows queue order; recent Done cards come first. If titles alone exceed the limit, each keeps a shortened prefix.
Aril sees how many texts were shortened and can retrieve needed full tasks with `get_task`.

## Ask Aril

1. Select **Aril** at the bottom right. The panel opens on your newest conversation.
2. Choose the repository in the **Repository** menu when Pomegr lists more than one.
3. Choose the provider and model in **Run on**. **Default model** uses the tool's own
   default.
4. Type your message and press Enter. Shift+Enter starts a new line.
5. Select **Stop** to end an answer early. The text written so far is kept.

Things you can ask:

- "I have this feature. Create the tasks for it." Aril cuts the feature into parts and
  proposes one feature with its tasks in the order they should start. If the repository has an `acos` skill,
  Aril uses its sizing rules for the cut.
- "Create this task", "Update T-12", or "Remove T-12".
- "Add a task for this under T-12." Aril proposes the new task with its place, so one
  **Apply changes** creates the card right under T-12. A card placed in Ready is not
  queued unless you also ask for the queue.
- "T-12 looks too big. How do I cut it?"
- "Which task must run first, and why?"
- "Which model fits this kind of task?" Aril compares the tasks already on the board:
  the planned and observed models, the outcome, and each checked condition. It can also
  read a session's report.

When Aril proposes a task, it chooses the provider, the model, and the effort for that
task. It weighs the kind and size of the work, the risk, how tasks of the same kind did
on your board, and the usage of both providers. It can choose any model that the **Run
on** menu of the task form offers, for Claude Code or Codex, and it says in one line
why it chose it. If you name a provider, a model, or an effort, Aril uses it.

### Send an image

You can show Aril a screenshot or a mock-up.

1. Select **Attach image**, paste an image into the message field, or drop one on it.
   The image shows above the **Run on** menu. **Remove image** takes it out again.
2. Type what you want Aril to do with it, and press Enter.

A message holds up to four images: PNG, JPEG, GIF, or WebP, up to 5 MB each. A message
with an image still needs text. A conversation holds up to 40 images.

Ask "create a task for this" or "attach this to T-12". Aril then proposes the task with
the image, or the image for a task that has not started. The proposal shows each image,
and the session that runs the task gets the image. A task holds up to four images.

**Minimize** closes the panel and keeps the conversation. **New conversation** starts an
empty one. **Conversations** lists the saved ones and lets you delete one.

## Apply a proposal

When you ask for a change, or when Aril recommends one, it ends its answer with a
proposal: a short summary and a list of the changes, one line each. Nothing changes until
you select **Apply changes**. Aril proposes a delete, a session start, or a queue change
only when you ask for it.

1. Read every line. A delete is marked, because it cannot be undone.
2. Select **Apply changes** to run the list in order, or **Dismiss** to drop it.
3. Read the result beside each line: **Done**, the ID of a new task, or why it failed.

Pomegr stops at the first change that fails and does not run the ones after it. Ask Aril
for the rest once you know why it failed. A new task that could not be put in its place
is still created: the result names it, and the card stays at the end of Backlog.

### Read Aril's follow-up

After you apply or dismiss a proposal, Aril answers once more by itself. You do not
need to send a message.

- **After you apply.** Aril says what changed, what failed, and what Pomegr did not run.
  It reads the board again first.
- **After you dismiss.** Aril acknowledges it in a line. Nothing was changed, and Aril
  does not propose the same thing again unless you ask.
- **After a start or a queue change.** Aril says what Pomegr confirmed. A task in the
  queue, or a queue that is on, is not a running session. Check **Sessions** or the
  Board for that.

A follow-up never applies a proposal or retries an operation. After an applied or partial
outcome, it may offer one board-change proposal that continues your earlier
request. Read it, then select **Apply changes** or **Dismiss** yourself. Each choice runs
one more read-only follow-up; Pomegr never applies a proposal or continues the chain by
itself. After a dismissed, refused, or failed proposal, the follow-up has no proposal. A
follow-up cannot propose a session start or queue change; send Aril a new message to ask
for either. Select **Stop** to end a follow-up early.

The result beside each line of the proposal is Pomegr's own record. Trust it over the
follow-up when they differ.

A proposal can create a feature, create a task in a place you name, update, delete, or
move a task, add a task to the queue or remove it, put queued tasks in a parallel group
or take them out of one, and put an image that you sent on a task. It cannot mark a task done,
requeue a task, or change the queue's threshold or schedule. Those stay with you, as
described in [Tasks](tasks.md). Starting a session and turning the queue on or off are
proposals of their own, described below.

## Start a session from the chat

Ask Aril to start one task by its ID, for example "start T-63". Aril answers with a
start proposal for that task. A start is always a proposal of its own.

1. In the Pomegr desktop app, select **Start session** on the proposal, or **Dismiss**
   to drop it. This approves the proposal.
2. Confirm the named task in the desktop dialog. Pomegr uses the same checks as [Start a session](tasks.md#start-a-session).
3. Read the result on the proposal.

| Result | What it means |
| --- | --- |
| **Session started in a new terminal window.** | Pomegr opened the session. The task links to it when the plugin in that session reports in. |
| **Not started.** and a reason | Nothing was started. A held start names what holds it, such as usage above the threshold or uncommitted changes. |

A proposal that did not start stays open. Select **Start session** again when the
reason is gone. Pomegr never tries again by itself, and a proposal that started a
session cannot start a second one.

- Aril proposes a start only when you ask for one, and only for a task that is **Not
  queued**, **Queued**, or **Scheduled** with no session.
- A start from the chat does not use the queue and changes nothing in it.
- On a paired phone, the proposal has no **Start session**. Apply it in the desktop app,
  or open the task on the phone and select **Start session** there.
- To start in a separate worktree while the repository has uncommitted changes, use the
  task window.

## Run a temporary pilot

The desktop app or a paired phone can authorize Aril to coordinate selected tasks while you are away.
The pilot is off by default. Keep the Pomegr computer open; the panel can stay closed.
The phone must have an active pairing before it can read or change a pilot grant.

1. In the desktop app or on a paired phone, open a repository's task board and select **Aril pilot**.
2. Enter your objective and select existing tasks. Check their execution settings and dependencies first.
3. Choose the inference provider and model, then the allowed providers and models for task sessions.
4. Set the deadline and limits. Defaults are 24 hours, 20 rounds, three starts, one concurrent task, and five-minute intervals.
5. Review the objective, task IDs, deadline, granted actions, provider/model choices, and limits.
6. Confirm the authorization. Closing the form before confirmation starts nothing.

Aril reads normalized evidence and chooses work with a reason. Pomegr validates every decision before a new task starts.
Explicit task settings take precedence. A task configured for one provider waits when that provider lacks capacity.
A reset wakes a fresh quota check; the clock alone never permits a start.
Waiting for task-provider capacity uses no decision rounds.
Each pilot task runs in its own worktree. Uncommitted changes in the repository are not copied.
Failed planning runs retry twice with increasing waits. Three consecutive failures need your attention.
The pilot never creates tasks, marks them done, changes the queue, or controls existing sessions.
It never approves tools, merges, deploys, or enables additional spending.

Open **Aril pilot** to read decisions, evidence revisions, waits, used limits, and the saved summary.
**Pause** and **Revoke** stop new pilot effects. They leave running task sessions alone.
A new activation requires another review and confirmation. Earlier summaries remain available.
An uncertain start shows **Needs you**. Inspect the task and its session before resolving it; do not blindly start it again.
If you confirm that no session started, select **Reconcile T-n** to requeue the task and revoke the grant.
A replacement grant requires another review and confirmation. Pomegr keeps the old receipt.
When the deadline or budget ends, the pilot keeps its final state and starts no more work.

## Turn the queue on or off from the chat

Ask Aril to turn this repository's queue on or off, for example "turn the queue on".
Aril answers with a queue proposal that names the state you asked for. A queue change is
always a proposal of its own.

1. Select **Turn queue on** or **Turn queue off** on the proposal, or **Dismiss** to
   drop it. Nothing changes before that. You can do this in the desktop app or on a
   paired phone.
2. Pomegr changes the queue as the **Queue** switch of the Tasks header does. See
   [Run the queue](tasks.md#run-the-queue).
3. Read the result on the proposal.

| Result | What it means |
| --- | --- |
| **Queue turned on.** | The queue is on. Pomegr starts the queued tasks by itself, as described below. |
| **Queue turned on.** and a line about a stalled or blocked task | The queue is on, but a task holds it. Resolve that task on the Board. |
| **Queue turned off.** | The queue is off. No new task starts. Running sessions continue. |
| **Queue not changed.** and a reason | Nothing changed. Select the same button again to try once more. |

> **Caution:** Turning the queue on lets Pomegr start sessions without asking again. It
> starts the queued tasks on the computer that runs Pomegr, in Ready order, while
> Pomegr is open there. Read the **Ready** column before you turn the queue on.

- Aril proposes a queue change only when you ask for one.
- A proposal names **On** or **Off**. It never switches the queue to the opposite of
  what it is, so applying it again cannot reverse the queue.
- Every start still passes the same checks as on the Tasks page: the Ready order and parallel
  groups of the queue, each task's own start time, the queue's schedule, and the
  [start gates](tasks-start-gates.md#start-gates).
- Aril does not start the tasks and cannot tell you which ones will start. The Board
  shows that.
- Aril cannot change the usage threshold or the schedule of the queue. Set them on the
  Tasks page.

> **Caution:** Aril can be wrong. Its advice on models is a reading of the tasks
> recorded on your board, not a measurement. Check a proposal before you apply it.

## Understand what is kept and sent

- **Kept on this computer.** Pomegr saves every conversation in its private data folder
  until you delete it, with the images you sent in it. Each repository holds up to 50
  conversations. An image that Aril puts on a task is a copy: it stays on the task when
  you delete the conversation.
- **Sent to the provider.** Each message sends the conversation and the board to the
  provider you chose, through your own coding tool. Applying or dismissing a proposal
  sends them once more, with the result of the proposal, for Aril's follow-up. That run
  uses the provider and model of the conversation's last message. The board includes the text of your
  tasks. Aril may also send file content and session evidence that it reads. The images
  you sent in the conversation go to the provider too, and the prompt names the folder
  where Pomegr keeps them.
- **Not observed.** A chat run leaves no session, so it does not show in **Sessions**.
  Its usage counts in your account's usage windows.
- **On a paired device.** The conversation crosses your local network without
  encryption, like the rest of phone access. Anyone who holds a paired phone can read
  the conversations and their images, send a message or an image, and apply a proposal
  of board changes or a queue change. A paired phone can also read pilot history,
  confirm a reviewed grant, pause it, revoke it, or reconcile an uncertain start.
  A confirmed grant starts selected task sessions on the Pomegr computer. Applying or
  dismissing a proposal there also runs Aril's follow-up on your computer. Turning the
  queue on lets Pomegr start queued tasks on your computer. A start that Aril proposed
  can be applied only in the desktop app.

## If the result is missing

| What you see | What to do |
| --- | --- |
| No **Aril** button | Open the Pomegr desktop app, or pair the phone again. |
| The tool is not installed on this computer | Install Claude Code or Codex, or choose the other provider in **Run on**. |
| Aril could not finish this answer | Open the coding tool once in a terminal. Check that you are signed in and that the tool is up to date. |
| This answer took too long and was stopped | Ask a narrower question. A run may take ten minutes. |
| Aril is already answering | Wait for the running answer, or select **Stop** in its conversation. |
| Aril could not be reached | Check that Pomegr shows **Local monitor**, then send again. |
| No follow-up after you applied or dismissed a proposal | Aril was answering in another conversation, so the follow-up waits for it. If Pomegr closed meanwhile, ask Aril what happened: the result is saved. |
| The follow-up says that Aril could not finish | The proposal's result is saved and shown on its lines. Check the coding tool as for any answer. |
| Aril wrote a proposal that Pomegr could not read | Ask for the proposal again. Nothing was changed. A rejected follow-up proposal has no card. |
| A line says **No longer possible** or **Not found** | The board changed after Aril wrote the proposal. Ask again. |
| A line says **Not attached.** | Read the reason on the line. A task that has started takes no image, and a task holds up to four. |
| A line says a task was created, but its images could not be attached | Open the task and put the image in again, if the task has not started. |
| The image could not be attached | Check that Pomegr shows **Local monitor**, then add the image again. |
| A start proposal says **Not started.** | Read the reason on the proposal. [Start gates](tasks-start-gates.md#start-gates) explains a held start. Select **Start session** again when it is gone. |
| A queue proposal says **Queue not changed.** | Check that Pomegr shows **Local monitor**, then select the same button again. |
| The queue is on and nothing starts | Open **Tasks**. A banner or a "Waiting:" line names what holds the queue. See [Run the queue](tasks.md#run-the-queue). |
| A session can be started from this chat only in the Pomegr desktop app | Apply the start proposal in the desktop app, or start the task from its window. |
