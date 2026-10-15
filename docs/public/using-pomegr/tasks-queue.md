---
title: "Task queue"
description: "How the queue picks the next task, why a queued task waits, and what to do when the queue stops or a start fails."
---

# Task queue

The queue starts tasks without you, from the top of **Ready**, one after another. It
works only while Pomegr is open. For the main path, see
[Tasks](tasks.md#run-the-queue).

## Turn the queue on

The queue is **Off** for every repository until you select **On** in the **Queue**
switch of the Tasks header. Add a task with **Add to queue** in its task window. With
the queue off, queued tasks start only when you start them. Turning it off never touches
a running session. You can also ask Aril to turn the queue on or off: see
[Turn the queue on or off from the chat](agent-chat.md#turn-the-queue-on-or-off-from-the-chat).

The **Ready** column shows what runs when. It reads top to bottom, and a frame marked
**Parallel** surrounds cards that start together (see
[Parallel tasks and Runs after](tasks-order.md)). To change the order, see
[Queued cards stay in Ready](tasks-board.md#queued-cards-stay-in-ready).

## How the queue picks a task

- **Order.** The queue starts the top waiting card of **Ready**, whatever its feature.
  When that card is in a parallel group, it starts the group's other waiting cards in
  the same check, one after another.
- **One at a time.** While a task is running, the queue starts nothing outside that
  task's own group. It starts the next card only when every task of the running group
  has reported and is in **Review** or **Done**. A task in **Review** is finished work
  that waits for you, so the next card starts.
- **The queue does not skip a card.** If a start gate holds the top card, the cards
  after it wait, and the Board marks that card **Queued · next** with the reasons. Cards
  of its own group still start.
- **Started tasks.** A task whose session has started is no longer shown as next or as
  waiting. It keeps its state and shows its session's state. While it runs, a waiting
  card outside its group says which task is running, and the queue starts nothing else.
- **Timing.** The desktop app asks for the next start every 15 seconds, so the queue
  works only while Pomegr is open.

## See why a queued task has not started

Each waiting card in **Ready** says where it stands and what it waits for. A card past
the first place opens with its place, such as "5th in queue". Then "Waiting:" lists
each reason. Open the card to read the same reasons in full under **Queue**, with every
task that starts first.

| The card says | What it means |
| --- | --- |
| earlier tasks start first (T-3, …) | Those cards are above it in **Ready**, so they start first. The cards of its own parallel group are not listed: they start with it. |
| runs after T-13, which is not done | It [runs after](tasks-order.md#runs-after) that task. It starts once that task is **Done** or deleted. |
| T-5 is running | A started task, or a parallel group that runs, holds the queue until it is in **Review** or **Done**. |
| the queue is off | You have not turned the queue on. Nothing is wrong. |
| the queue is blocked by T-2 | That task stalled or was blocked by its agent. Resolve it first. |
| the queue is paused at T-3 | A start failed. See [If a start fails](#if-a-start-fails). |
| a start gate, such as "the working tree has uncommitted changes" | A [start gate](tasks-start-gates.md) holds the start. |
| the queue starts Oct 9, 22:00 | The queue's own start or stop time holds it. |
| the reason is not known yet | Pomegr has no fact that explains the wait. It never assumes that a gate passed. |

To run a task sooner, move its card up in **Ready**, or start it by hand with **Start
session**.

A scheduled task shows its time on the **Starts** line. A reading that Pomegr has not
observed yet reads "not known yet" and holds the start, like a failed gate. The task
window of the next task reads "Nothing known holds it." when Pomegr knows no hold: the
queue starts it at its next check, while the desktop app is open.

## When the queue stops

A task that stalled or was blocked by its agent stops the whole queue. A banner reads
**Queue blocked** and names the task. Nothing new starts until you resolve that task;
sessions already running continue. Open the task and choose one of two actions. In the
desktop app, the banner also offers them, as **Mark done and resume** and **Requeue
T-n**.

- **Mark done and resume queue** accepts the task as done, keeps its report and session
  link, and closes the task window.
- **Requeue task** puts it back in the queue as **Queued** with its card last in
  **Ready**, clears its report and session link, and lets a new session report once
  more.

A stalled task can also release the queue by itself when its session did not really end:
the session reports complete, or Pomegr confirms that it works again. The queue then goes
on. See [How a report is checked](tasks-agents.md#how-a-report-is-checked).

A task whose session never reports holds the queue too. Pomegr never marks it done or
stalled by itself while it cannot tell that the session ended, for example after the
computer or Pomegr restarted. The queue never moves past it, because the task can matter
to the whole feature. Open the task and choose **Mark done** or **Requeue task**; the
task window says "The session has not reported. Mark done and Requeue do not stop it."

- Neither action stops the session.
- **Mark done** accepts the task, and a later report from that session changes nothing.
- **Requeue task** clears the session link, so a later report from the old session is
  not accepted.

## Review a report

Every task an agent reports complete needs review, whether its conditions passed or
not: only you mark a task done. A task that needs review does not stop the queue. Its
work is finished: the card waits in **Review**, and the queue goes on to the next
waiting card once every task of its group is in **Review** or **Done**. Open the task
when you have time and choose **Mark done** or **Requeue task**. If the agent asked for
your attention, the task window shows its line under **Complete when**, in the agent's
own words.

Each checked condition shows one of three results in the task window:

| Result | Meaning |
| --- | --- |
| **Passed** | Pomegr read the repository and the condition holds. |
| **Not passed** | Pomegr read the repository and the condition does not hold. |
| **Not verified** | Pomegr had no current reading. The condition is not known to fail. |

**Not verified** appears, for example, when Pomegr cannot read the session's
repository, or when a command of the session still runs. Look at the pull request
yourself, then choose **Mark done** or **Requeue task**.

> **Note:** Pomegr checks a report once, against the repository and its pull requests
> as it reads them when the report arrives. A condition that comes true later, such as
> CI that finishes after the agent reported, still reads **Not passed** in the task
> window though the condition now holds. Choose **Mark done**; Pomegr does not repeat
> the check.

## If a start fails

A start that fails pauses the queue. The **Queue paused** banner names the task and
one of these reasons. Fix it, then select **On** again to retry.

| Reason | What to do |
| --- | --- |
| The provider's command-line tool was not found. | Install Claude Code or Codex on this computer. |
| The Pomegr plugin is not installed in this repository, or needs an update. | Install it, or update it to 0.9.0 or later; see [Reporting plugins](reporting-plugins.md#install-the-plugin). |
| Starting sessions is available on Windows only. | Start tasks from a Windows computer. |
| Its worktree has uncommitted changes, and Pomegr never removes them. | Select **Open folder** in the banner (desktop app, Windows), commit or discard the changes there, then select **On** again. |
| The terminal window could not be opened. | Select **On** to retry. |
| The terminal opened, but the session did not report back. | Check the plugin, and for Codex that its hooks are trusted. |

- Without the plugin, with a plugin older than 0.9.0, or when Pomegr cannot read its
  version, a start is refused with "Install or update the Pomegr plugin in this
  repository to start sessions."
- If Pomegr cannot find the Claude Code or Codex program, a start says "The
  provider's command-line tool was not found on this computer."
- Codex runs plugin hooks only after you trust them.
