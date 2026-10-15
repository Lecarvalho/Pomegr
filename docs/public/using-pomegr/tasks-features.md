---
title: "Features"
description: "Group related tasks into a feature, give them shared context, and create, edit, or delete a feature."
---

# Features

A feature is shared context for related tasks and a way to group them on the board. It
has no order of its own: a task in a feature runs when its card reaches the top of
**Ready**, like any other task. For the main path, see [Tasks](tasks.md).

## What a feature holds

- **Title.** Up to 80 characters, unique on the board.
- **Description.** Up to 2,000 characters. Put there what every task of the feature
  needs to know, so that each task's own text stays short.
- **App version.** Up to 40 characters: the version you plan the feature for.

The session Pomegr starts for a task gets the feature's title and ID in its prompt. It
reads the description and the app version with the `get_feature` tool when it needs
them. The desktop app sets all three fields, and an agent can too (see
[What agents report](tasks-agents.md)).

A feature is done when all its tasks are. Only unfinished features are offered for a
new attachment.

## Group tasks by feature

- **Attach a task.** Choose the feature in the task's **Feature** field, or select **New
  feature…** there to name a new one.
- **Filter the board.** Select a feature chip in the filter row to show only its tasks.
  The row reads, for example, "3 of 7 tasks done · 2 running".

## Create, edit, and delete a feature

You make, edit, and delete features in the Pomegr desktop app. A browser or a paired
phone shows features but does not change them, except that a task's **New feature…**
field still names a feature from a title alone.

1. To create a feature, choose **+ New feature** on the Board, in the row above the
   lanes. While the board has no feature, the button is in the page header instead.
2. Enter a **Title**. It is the only required field.
3. Optionally enter a **Description** and an **App version**. The counters show how
   much room is left.
4. Choose **Create feature**. It stays disabled until the title holds text.
5. To edit a feature, choose it in the **Feature** filter above the board, then choose
   **Edit feature**. The description and the app version load when the window opens.
   If they cannot be read, those two fields stay disabled and you can still rename the
   feature.
6. Change a field and choose **Save**. It stays disabled until something differs, and
   it sends only what you changed. Empty the description or the app version and save
   to remove it.

The window shows how many of the feature's tasks are done. A feature with tasks lists
them under **Tasks**, folded; choose a task there to open it. Closing the window or
pressing Escape discards your changes without asking. A click outside the window closes
it only while it holds nothing to save.

A title that another feature already has is refused, with the line "Another feature
already has this title." A board holds up to 50 features. Any other failure shows "The
feature could not be saved." The window stays open and keeps what you typed.

### Delete a feature

Open the feature with **Edit feature**, choose **Delete feature**, and confirm. The
window asks first and says how many tasks the feature has.

- Deleting cannot be undone, but it removes no task. Each task stays on the board, in
  the same lane, with no feature.
- A queued task stays queued, keeps its place in **Ready**, and keeps its parallel
  group, so the order does not change.
- The feature's description and app version are deleted with it.
- If the feature was chosen in the **Feature** filter, the filter returns to **All**.

You cannot delete a feature while one of its tasks has started and is not done. The
window shows which task, for example "T-34 is running. Delete the feature after its
tasks finish.", and **Delete feature** stays disabled. A done task never blocks. If the
delete fails, the window stays open and shows "The feature could not be deleted."
