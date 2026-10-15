---
title: "Parallel tasks and Runs after"
description: "Start several tasks together in parallel groups, each in its own Git worktree, and make a task wait for another with Runs after."
---

# Parallel tasks and Runs after

The queue starts one card at a time: the top waiting card of **Ready**. It starts the
next card only after that task has reported and is in **Review** or **Done**. A parallel
group starts several cards together. **Runs after** makes a task wait for the result of
another. For the main path, see [Tasks](tasks.md).

## Run tasks in parallel

To run cards at the same time, put them in a parallel group. The queue then starts the
whole group together, one task after another in the same check.

- **Run in parallel.** In **Backlog** or **Ready**, between two cards that have not
  started, select **Run in parallel**. The two cards, or their groups, become one group.
- **Add a card to a group.** Drop a card that has not started onto a group.
- **A group.** A frame marked **Parallel · 3** holds the cards that start together. The
  number counts the members still waiting. Once members have started, the caption adds,
  for example, "· T-4 and T-5 started". A group holds up to 16 cards.
- **Take a card out.** On a card of a group, select **Take out of group**. The card
  keeps its place in **Ready**, or lands right after the group when it was between two
  cards that stay in it. Or drag the card out of the group, and it lands where you drop
  it.
- **Ungroup.** On the caption, select **Ungroup**. Every card keeps its place and runs
  as a card of its own, one after another.
- **When the next card starts.** The cards after a group wait until every task of the
  group is in **Review** or **Done**. A task you took out of the queue no longer counts.
- **A held member.** A member that a start gate holds, for example while a provider has
  an incident, keeps its place and shows "Waiting:" with the reasons. It starts when the
  gate opens. Its siblings start without it, and the cards after the group still wait
  for it. A member scheduled for a later time holds nothing.
- **A waiting card behind running work.** A card that an earlier task holds reads
  "Waiting: T-n is running".
- **A group lasts while it has work.** When a member reaches **Review**, **Blocked by
  agent**, **Stalled**, or **Done**, or leaves the queue, it is no longer in the group. A
  group with only one task left is no group.
- **A group is not a dependency.** A group means "start these together". To make a task
  wait for another task's result, use [Runs after](#runs-after).

### Plan in Backlog

You can arrange cards in **Backlog** before you queue any of them, the same way
**Ready** reads.

- **One after another.** The order of the cards in **Backlog** is your plan.
- **Together.** Select **Run in parallel** between two cards, or drop a card on a group.
  The frame and the caption are the same as in **Ready**. Cards that only sit next to
  each other are not a group.
- **Queue group.** On the caption of a group, select **Queue group**. Every card of the
  group joins the queue and moves to the end of **Ready**, in the order it had.
- **Queue one card of a group.** The card joins the queue and moves to **Ready**. The
  other cards of its group move with it and stay **Not queued** until you queue them.
- **Move the whole plan.** Drag a group's frame to **Ready**. The cards keep their group
  and are not queued.
- **Change it.** Ungroup, take a card out, or reorder at any time. Once a member has
  started, you cannot take that member out.

## Worktrees

Each member of a group starts in a Git worktree of its own, on a branch named
`tasks/<task ID>`, so parallel agents do not edit the same files. The worktree begins
at the repository's current commit, so uncommitted changes in the repository are not
part of it. A task in no group runs in the repository itself, whatever its feature,
unless you choose a [separate worktree](tasks-start-gates.md#start-in-a-separate-worktree)
for one manual start.
Pomegr keeps its worktrees inside the repository, in `.pomegr/worktrees/<task ID>`.
That folder ignores its own contents, so the worktrees do not show as changes in the
repository.

- When you mark a task done, Pomegr removes the task's worktree and its
  `tasks/<task ID>` branch. To keep them, clear **Remove worktree and branch when done**
  in the task. The box is checked for every new task.
- Pomegr never removes a worktree that has uncommitted changes or a commit that exists
  nowhere else, and never forces a removal. Such a worktree stays until you commit,
  push, or remove it. A worktree whose folder is still in use, for example by an open
  terminal, is removed about a minute after it is free.
- The branch is deleted only with its worktree, so every commit on it is also on a
  remote or on another local branch.
- The other worktree Pomegr removes itself is one made for a start that then failed.
- A worktree that an earlier version made under the desktop app's data folder keeps
  working where it is.
- A requeued task reuses its worktree only if Git still lists it on the task branch and
  it is clean. Otherwise the start fails and nothing is touched.

When a start is refused because the task's worktree has uncommitted changes, the task
window says "This task's worktree has uncommitted changes. Pomegr never removes them.
Open the folder to commit or discard them, then try again." and offers **Open folder**.
Commit or discard the changes there, then start the session again. **Open folder**
works in the desktop app on Windows. When the queue made the start, it pauses instead
(see [If a start fails](tasks-queue.md#if-a-start-fails)).

## Runs after

Say that a task runs after other tasks when it must not start before their work is
accepted.

- **Set it.** Open the task and use **Runs after**: choose a task and select **Add**. On
  the Board, select **Runs after…** in a card's move actions to open the same field.
- **Any task of the board.** The tasks can be in any column, with or without a feature.
  A task can run after up to 8 tasks.
- **What it does.** The task never starts until every task it runs after is **Done**, or
  deleted. **Review** is not enough. Neither the queue nor **Start session** starts it.
- **It does not reorder the queue.** The queue passes a waiting task and starts the
  cards after it. When the task is free, it starts at its place in **Ready**.
- **The card says so.** A card reads "Runs after T-13 and T-14", and a queued card reads
  "Waiting: runs after T-13, which is not done".
- **No loops.** A choice that would make tasks wait for each other is refused with
  "These tasks would wait for each other, so nothing was changed."
- **Remove it** with **Remove** on the row. A task that has started cannot be changed.

## If your board had steps

Earlier versions grouped a feature's tasks into steps. Steps are gone, and Pomegr
changed your board once, the first time it opened the board after the update.

- **Queued tasks of one step are now a parallel group.** If a step held two or more
  tasks that were queued, scheduled, or running, those tasks became one group. A step
  with a single such task became an ordinary card.
- **Nothing was lost or restarted.** Every task keeps its column, its place in
  **Ready**, its feature, its state, its schedule, its session, and its report. Pomegr
  started no session, relaunched none, and sent nothing to a running one.
- **Steps no longer hold work back.** A feature that waited behind an earlier step, for
  example because that step had a task you had not queued, no longer waits. Its queued
  cards start at their place in **Ready**, and a running queue can start one at its next
  check. Look at the order of **Ready** after the update.
- **The step controls are gone.** There is no **Move to step…** and no "Step 2 of 4"
  heading. To run cards together, use **Run in parallel**.
