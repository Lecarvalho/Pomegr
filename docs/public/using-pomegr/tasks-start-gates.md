---
title: "Start gates and schedules"
description: "The checks Pomegr makes before it starts a task's session, and how to schedule a task or the queue for a later time."
---

# Start gates and schedules

Before every start, manual or queued, Pomegr judges four start gates from facts it has
already observed. A schedule holds a queued start until a time you choose. For the main
path, see [Tasks](tasks.md).

## Start gates

**Queue settings** on the Board lists each reading. A held queued task shows "Waiting:"
with the reasons (see
[See why a queued task has not started](tasks-queue.md#see-why-a-queued-task-has-not-started)).
A missing, stale, or partial reading is unknown, and unknown holds a start exactly like
a failed gate.

| Gate | A start proceeds only when |
| --- | --- |
| **Earlier task finished** | No task runs outside this task's own parallel group. Holds only the queue: **Start session** starts a task whatever is running. |
| **Claude Code capacity** and **Codex capacity** | The provider is below the threshold for its five-hour window, or its weekly window for weekly-only Codex accounts. |
| **Provider status** | The provider's public status shows no incident. |
| **Working tree** | The repository's working tree has no uncommitted changes. |

- **Threshold.** It is 70, 85, or 95 percent, with 85 as the default, and applies to
  one repository. It uses the five-hour window. Codex accounts with only a weekly limit
  use their seven-day window instead. When both windows exist, the seven-day reading is
  informational.
- **Account-wide readings.** The readings are the
  [usage limits](../concepts/usage-limits.md) Pomegr already shows, so they cover your
  whole account. Public status does not prove that an incident affects you.
- **Working tree.** The gate reads the repository itself, even for a task that will
  start in its own worktree.
- **A held queued task** changes nothing: it waits, the queue stays on, and Pomegr
  judges again at the next check.
- **A held manual start** says which gates hold it, for example "This task is held:
  Claude Code usage is not known yet."

An unknown working tree means its Git check is pending or unavailable. It never means the tree is clean.
Keep the board open, wait 15 seconds, then select **Start session** again in the task window or Aril's proposal.
Pomegr checks again in background. An unavailable check keeps the task held; a successful check updates the gate.
Check **Working tree** in **Queue settings** for the current reading. Pomegr never retries a held manual launch by itself.

### Start in a separate worktree

When the working tree gate is the only gate that holds a manual start, the task window
offers **Start in separate worktree**. The confirmation names the separate worktree and
says that your uncommitted changes are not part of it and stay untouched.

- The session starts in the task's own [worktree](tasks-order.md#worktrees), on the
  `tasks/<task ID>` branch, at the repository's current commit.
- The choice is for that one start. Pomegr does not store it.
- The queue never makes this choice. A queued task that the working tree gate holds
  keeps waiting.

## Runs after

A task that [runs after](tasks-order.md#runs-after) another task does not start until
that task is **Done** or deleted, whatever the gates read.

## Schedule starts

- **A task's own time.** In the task window, **Start at** takes a date and time. It
  makes the task **Scheduled**, adds it to the queue, and keeps the queue from starting
  it earlier. Clear the time to leave the task **Queued**. A scheduled task that is not
  yet due holds nothing behind it, and a scheduled member of a parallel group that is
  not yet due holds nothing for its group.
- **The queue's window.** Under **Schedule**, in **Queue settings** on the Board,
  **Start at a time** sets a time of day before which the queue starts nothing, and
  **Stop starting tasks after** sets a time from which it starts nothing. Pomegr applies
  the next occurrence of that time. Both hold queued starts only; a start you make by
  hand is not held by them. **Run now** clears the start time.

A time can be at most a year ahead. Times are judged only when the desktop app asks for
the next start, so Pomegr must be open. A time that passed while it was closed counts
from the next check, and the start then happens unless the stop time has come. A stop
time that has passed keeps holding the queue until you change or clear it. A schedule
never stops, pauses, or touches a running session.
