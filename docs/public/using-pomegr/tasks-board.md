---
title: "Board and task states"
description: "Move and find cards on a task board, see when Pomegr moves a card, and read what each task state means."
---

# Board and task states

A board has five fixed columns: **Backlog**, **Ready**, **In progress**, **Review**,
and **Done**. A card's column shows where the work is; its state shows what Pomegr
observed. For the main path, see [Tasks](tasks.md).

## Open a board

Select **Tasks** in the sidebar.

- **Needs you** lists the tasks that need review, are stalled, or are blocked by their
  agent, newest first. A row opens that task's board.
- **Boards** shows each repository with its queue, the number of tasks in each column,
  and when a task last changed. Select a repository's name to open its board.
- On a board, **Tasks** above the heading returns to the home. The **Repository** menu
  beside the heading switches repository.
- A repository's own **Tasks** tab links to the same board.

You cannot add, rename, reorder, or delete a column. Moving a card never changes its
state.

## Move cards

- **Move a card.** Drag it to another column, or between two cards. A line shows where
  the card will land, and a long column scrolls while you hold the card near its top or
  bottom. Dragging is off while a feature filter is on.
- **Move a card from the keyboard.** Focus the card to reveal four buttons, such as
  **Move T-3 up** and **Move T-3 to the next column** (T-3 is an example). Arrow keys
  move between the buttons.

### Cards Pomegr moves

Pomegr moves a card to another column when its task changes state:

| When | The card moves to |
| --- | --- |
| The task's session starts and links to it | **In progress** |
| The task becomes **Needs review**: the agent reported it complete | **Review** |
| The task becomes **Done**: you chose **Mark done** | **Done** |

- **Blocked by agent** and **Stalled** do not move a card. It stays where it is,
  normally **In progress**, and holds the queue. A card in **Review** does not hold the
  queue.
- **You can still move a card by hand.** It stays where you put it until its task's
  next state change in the table, which moves it again.
- The card lands last in its new column.

### Queued cards stay in Ready

- **Add to queue**, a start time, and **Requeue task** put the card in **Ready**, last.
  A card already in **Ready** keeps its place.
- A **Queued** or **Scheduled** card cannot be moved to another column until you choose
  **Remove from queue** or its session starts. **Remove from queue** leaves the card in
  **Ready**.
- The queued cards in **Ready** read top to bottom in the order the queue starts them,
  whatever their feature. Cards that are not queued keep their place between them.
- **Reorder by moving cards.** Drag a queued card above or below another in **Ready**,
  or use its move up and move down buttons. It lands where you drop it. A feature never
  moves a card.
- **Cards that run in parallel** sit together in a frame marked **Parallel**; see
  [Parallel tasks and Runs after](tasks-order.md).

## Find a task

Press **Ctrl K** (**⌘ K** on a Mac), or select **Search tasks** in the top bar, while
the board is open. The search looks at the board of the repository you are on, and
lists its tasks before the usual destinations.

- **What it matches.** The task ID, the task text, the session title, the feature, the
  column, the chip, and `#` with an issue number, such as `#133`. Every word you type
  must match.
- **Choosing a task.** The desktop app opens the task. A same-computer browser shows the
  card on the **Board** and clears a feature filter that would hide it.
- The search reads nothing new: it uses the board already on screen, and what you type
  is not stored.

## Read a task's state

| State | Meaning | Set by |
| --- | --- | --- |
| **Not queued** | On the board, not in the queue. | Creating the task, or **Remove from queue**. |
| **Queued** | Waiting for its turn and the start gates. The next one reads **Queued · next**. | **Add to queue**, or **Requeue task**. |
| **Scheduled** | Queued with its own start time. | Setting **Start at** on the task. |
| **Needs review** | The agent reported complete. The task window shows each checked condition's result and the agent's attention line, if it gave one. | Pomegr, when it verifies the report. |
| **Stalled** | The session ended without a report. | Pomegr, once the session's end is established. It leaves Stalled when that session reports or works again. |
| **Blocked by agent** | The agent reported it cannot continue and gave a reason. | The agent. |
| **Done** | You accepted the task. An agent's report never sets it. | You, with **Mark done**. |

A task has no **Running** state. Once a session is linked to a task that has no outcome
yet, its card shows that session's observed state, such as **In progress** (see
[Sessions and agents](sessions-and-agents.md#read-a-sessions-state)). Until Pomegr has
observed the session, the card keeps the task's own state, so a state is never shown
and then taken back.

**Stalled** means Pomegr observed the session end with no report, not that the work
failed. Pomegr confirms the end with a second reading about 20 seconds after the first,
so a session that reads as ended for a moment does not stall its task. If the same
session reports or works again later, the task leaves **Stalled** by itself.

## Board limits

A board holds up to 500 tasks and 50 features. A feature title is up to 80 characters,
its description up to 2,000, and its app version up to 40.

A board you made before the columns were fixed keeps every task. A column you moved
goes back to its place. A column you added or renamed is removed, and its cards move to
the end of **Backlog** in the order they had. A renamed column that Pomegr moved cards
to is the exception: it gets its fixed name back and keeps its cards.
