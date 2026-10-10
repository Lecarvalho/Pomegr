---
title: "GitHub issues"
description: "Connect the GitHub CLI, promote an open GitHub issue into a task, create an issue from a task, and recover when a create fails."
---

# GitHub issues

Pomegr can turn an open GitHub issue into a task on a repository's board, and can
create a GitHub issue from a task. Both are copies made once, when you ask. Pomegr
does not keep the task and the issue in sync, and GitHub is never the source of a
task's state. It works in the Pomegr desktop app only.

## Before you start

- **Use the desktop app.** A browser on the same computer says "GitHub issues are
  read in the Pomegr desktop app." A phone or another device on your network sees
  no task content at all (see [Phone access](phone-access.md)).
- **Install the GitHub CLI (`gh`) and sign in to it** on this computer. Pomegr
  runs `gh` as you, so it reaches exactly the repositories your account can. It
  never reads, stores, or forwards a GitHub token.
- **Use a repository on github.com.** Public and private repositories both work.
  GitHub Enterprise hosts are not supported.
- Read [Tasks](tasks.md) first if you have not used the board.

## Connect GitHub

1. Open **Settings → GitHub**. The **GitHub CLI** row shows one state.

   | State | What it says | What to do |
   | --- | --- | --- |
   | **Connected** | "Connected through GitHub CLI" | Nothing. |
   | **Not signed in** | "The GitHub CLI is installed, but no one is signed in." | Select **Sign in with GitHub CLI**. |
   | **Not installed** | "GitHub CLI not installed" | Install it on this computer, then select **Check again**. |

2. After **Not signed in**, select **Sign in with GitHub CLI**. Pomegr asks "Sign
   in to GitHub?" in a native dialog and does nothing until you choose **Sign
   in**. A terminal then opens the GitHub CLI's own sign-in. Finish there, then
   select **Check again**. Pomegr does not wait for the sign-in and never sees
   the credential. This button works on Windows only; elsewhere sign in with the
   GitHub CLI yourself.
3. Under **Repositories**, each repository Pomegr knows (up to 16) shows
   **Private** or **Public** and what your account can do there: **Can read
   issues**, **Can create issues**, **Issues are turned off**, or **No access**.
   "Could not be checked." means Pomegr could not match the repository to a
   GitHub project. A public repository lets any signed-in account create issues;
   a private one needs triage or write permission.

The state is read when you open the section and when you select **Check again**,
not on a timer. A browser or phone shows **Desktop managed** instead.

## Promote an issue into a task

1. On **Tasks**, choose the repository and select **Promote issues**. The page
   asks GitHub for the repository's open issues, up to 100 (it says "Showing the
   first 100 open issues." when there are more). Pull requests are never listed.
   **Refresh** reads again.
2. Select an issue in the list. The right side shows its raw body, with **Raw
   body** and "Exactly what the agent will read" above it, and a character count
   such as "1,240 / 4,000 characters". Read it. The text is written by other
   people, and once promoted it is the instruction an agent works from.
3. Check the notices above the body:

   | Notice | Meaning |
   | --- | --- |
   | "Opened by someone outside the repository. Read the whole body before promoting." | The author is neither the owner, a member, nor a collaborator. |
   | "1 hidden comment found. GitHub does not show it on the issue page. It is not copied into the task." | The body holds HTML comments. They show struck through and are removed on promote. |
   | "The task text would be N characters and a task holds 4,000. Shorten the issue, or write the task by hand." | The row reads **Too long** and **Promote** is off. |
   | "Already on the board as T-3." | The issue was promoted. **Open task** goes to the board. |

4. Select **Promote**. The task window opens with the issue and the usual
   **Feature**, **Run on**, **Effort**, and **Done when** fields (see
   [Create and organize tasks](tasks.md#create-and-organize-tasks)). The footer
   says "The pull request will say Closes #N." Select **Promote issue**. The task
   lands in **Backlog**, not queued, and the row reads **Promoted · T-3**.

**What is copied.** The issue title, a blank line, and the body with HTML comments
removed become the task text, once. You can edit that text like any task's. Pomegr
does not copy comments on the issue, labels, or later edits, and it does not read
the issue again when a session starts. The 4,000-character limit blocks the promote
rather than cutting the text. Deleting the task lets you promote the issue again.

**If the issue changed.** If the issue was edited on GitHub since the list was read,
or is already a task, nothing is created and the window says "This issue changed on
GitHub or was already promoted." **Show new version** reads the list again and shows
the issue as it is now, so you can review it before promoting. "This issue is no
longer open." means it was closed or removed.

**Where the issue shows.** A promoted task carries a **#N** chip after its ID on the
board and in the **Queue** view, and its task window shows **Source** with **GitHub
issue**. The **Sessions** list prints the number as plain text after the task number.
It is a label, not a link. A session started for the task is asked to write `Closes
#N` in its pull request description.

> **Note:** Pomegr copies only the title and body. The started agent can still read
> the whole issue thread, comments included, through its own `gh`.

## Create an issue from a task

1. In **New task**, write the task. Under **Task**, **Also create a GitHub issue** is
   on by default when your account can create issues here. Below it, a line says
   "The task text is sent to GitHub once, with its first line as the issue title.
   Anyone who can see the repository can read it. Later edits here are not sent."
   Everyone can read an issue on a public repository; on a private one, people with
   access can.
2. Select **Create task**. Pomegr creates the task first and asks GitHub second.
3. For a task that has no issue, open its window and select **Create GitHub issue**
   in the **Source** row ("Not on GitHub"). It needs saved text, so it is off
   while you have unsaved changes ("Save your changes first.").

The first line becomes the title (one line, at most 120 characters) and the whole
task text becomes the body. The text is sent once through your GitHub CLI session.
Later edits to the task are not sent, and Pomegr does not read the issue back. On
success the task gets the **#N** chip, and a session started for it is asked for
`Closes #N` as above.

The box is off, with one line saying why, when you are not signed in ("You are not
signed in to GitHub. Sign in from Settings to create issues."), the GitHub CLI is
missing, issues are turned off, you cannot create issues in that repository, or
GitHub could not be read.

## If creating an issue fails

A failed create never changes, blocks, or undoes the task. From **New task**, the
window closes on the new task, which has no **#N** chip. Open it: the **Source** row
shows the reason and offers **Create GitHub issue** again; a create from the task's
own window shows its reason in the same place. Pomegr remembers the reason only
while the app stays open, and retries nothing by itself.

| Reason shown | What to do |
| --- | --- |
| "The GitHub issue was not created: the GitHub CLI is not installed." | Install it, then ask again. |
| "The GitHub issue was not created: you are not signed in to GitHub." | Sign in under **Settings → GitHub**, then ask again. |
| "The GitHub issue was not created: you cannot create issues in this repository." | Check your permission on GitHub. |
| "The GitHub issue was not created: issues are turned off for this repository." | Turn issues on in the repository's GitHub settings. |
| "GitHub did not accept the issue. Try again." | Check the repository's issues first, as below, then ask again. |
| "This task already has a GitHub issue, or one is being created." | Wait, then reopen the task. |
| "The GitHub issue could not be created." | Ask again. If it keeps failing, look at **Settings → GitHub**. |

> **Caution:** If Pomegr reports "GitHub did not accept the issue" after a long wait,
> GitHub may still have made the issue. Look at the repository's issues on GitHub
> before you ask again, because a second ask can create a second issue.

## What Pomegr does not do

- It does not sync. Editing, closing, or reopening an issue changes no task, and
  moving or finishing a task changes no issue.
- It reads no comments on an issue, and it never edits, labels, comments on, or
  closes one. Creating an issue is its only write to GitHub. A merged pull request
  that says `Closes #N` closes the issue through GitHub, not through Pomegr.
- It never reads, stores, or forwards a GitHub token.
- It does not talk to GitHub in the background. It reads or writes only when you
  open **Settings → GitHub**, **Promote issues**, or **New task**, or select **Check
  again**, **Refresh**, **Show new version**, **Promote issue**, or **Create GitHub
  issue**. The queue, a session start, and an agent's `add_task` never touch GitHub;
  `add_task` stays on the local board.
- Issue text lives in the task store like any task text, and never appears in the
  Sessions list, reports, or notifications.
