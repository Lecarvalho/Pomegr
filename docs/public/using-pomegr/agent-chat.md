---
title: "Agent chat"
description: "Ask Aril, the Pomegr task-board agent, to cut work into tasks, order the board, and advise on models. You approve every board change."
---

# Agent chat

**Aril** is the agent built into Pomegr that helps you organize a repository's task
board. You ask in a chat panel at the bottom right of the window. Aril reads the board,
the repository's files, and what Pomegr observed, then answers. Aril never changes the
board by itself: it proposes changes, and you apply them.

## Before you start

- **Use the desktop app or a paired device.** The **Aril** button shows in the Pomegr
  desktop app and on a phone you paired with it (see
  [Phone access](phone-access.md)). A browser on the same computer has no chat.
- **Install the coding tool and sign in.** A message runs Claude Code or Codex on your
  computer, signed in as you, so it uses your own subscription allowance. Pomegr reads
  and stores no credential. Without the tool, the panel says that it is not installed on
  this computer.
- **Keep Claude Code current.** The chat needs Claude Code 2.1.248 or later.
- **Have a repository.** Aril works on one repository's board. Pomegr lists a repository
  once it observed a session there.

> **Note:** Each message starts one read-only run of the coding tool. The run can read
> files and Pomegr's observations. It cannot write a file, run a command that changes
> something, or use your other tools and plugins.

## Ask Aril

1. Select **Aril** at the bottom right. The panel opens on your newest conversation.
2. Choose the repository in the **Repository** menu when Pomegr lists more than one.
3. Choose the provider and model in **Run on**. **Default model** uses the tool's own
   default.
4. Type your message and press Enter. Shift+Enter starts a new line.
5. Select **Stop** to end an answer early. The text written so far is kept.

Things you can ask:

- "I have this feature. Create the tasks for it." Aril cuts the feature into parts and
  proposes one feature with its tasks and steps. If the repository has an `acos` skill,
  Aril uses its sizing rules for the cut.
- "Create this task", "Update T-12", or "Remove T-12".
- "T-12 looks too big. How do I cut it?"
- "Which task must run first, and why?"
- "Which model fits this kind of task?" Aril compares the tasks already on the board:
  the planned and observed models, the outcome, and each checked condition. It can also
  read a session's report.

**Minimize** closes the panel and keeps the conversation. **New conversation** starts an
empty one. **Conversations** lists the saved ones and lets you delete one.

## Apply a proposal

When you ask for a change, Aril ends its answer with a proposal: a short summary and a
list of the changes, one line each.

1. Read every line. A delete is marked, because it cannot be undone.
2. Select **Apply changes** to run the list in order, or **Dismiss** to drop it.
3. Read the result beside each line: **Done**, the ID of a new task, or why it failed.

Pomegr stops at the first change that fails and does not run the ones after it. Ask Aril
for the rest once you know why it failed.

A proposal can create a feature, create, update, delete, or move a task, add a task to
the queue or remove it, and move a task to another step. It cannot turn the queue on or
off, start a session, mark a task done, or requeue a task. Those stay with you, as
described in [Tasks](tasks.md).

> **Caution:** Aril can be wrong. Its advice on models is a reading of the tasks
> recorded on your board, not a measurement. Check a proposal before you apply it.

## Understand what is kept and sent

- **Kept on this computer.** Pomegr saves every conversation in its private data folder
  until you delete it. Each repository holds up to 50 conversations.
- **Sent to the provider.** Each message sends the conversation and the board to the
  provider you chose, through your own coding tool. The board includes the text of your
  tasks. Aril may also send file content and session evidence that it reads.
- **Not observed.** A chat run leaves no session, so it does not show in **Sessions**.
  Its usage counts in your account's usage windows.
- **On a paired device.** The conversation crosses your local network without
  encryption, like the rest of phone access. Anyone who holds a paired phone can read
  the conversations, send a message, and apply a proposal.

## If the result is missing

| What you see | What to do |
| --- | --- |
| No **Aril** button | Open the Pomegr desktop app, or pair the phone again. |
| The tool is not installed on this computer | Install Claude Code or Codex, or choose the other provider in **Run on**. |
| Aril could not finish this answer | Open the coding tool once in a terminal. Check that you are signed in and that the tool is up to date. |
| This answer took too long and was stopped | Ask a narrower question. A run may take ten minutes. |
| Aril is already answering | Wait for the running answer, or select **Stop** in its conversation. |
| Aril could not be reached | Check that Pomegr shows **Local monitor**, then send again. |
| Aril wrote a proposal that Pomegr could not read | Ask for the proposal again. Nothing was changed. |
| A line says **No longer possible** or **Not found** | The board changed after Aril wrote the proposal. Ask again. |
