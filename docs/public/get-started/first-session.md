---
title: "Follow your first session"
description: "Open Pomegr, find a local coding-agent session, and understand the first results or missing data."
---

# Follow your first session

Open Pomegr alongside your coding tool to follow a session as it works. Pomegr
discovers local sessions automatically; you keep giving instructions and answering
questions in Claude Code or Codex.

## Before you start

[Install Pomegr](install.md) on the computer where you use your coding tool.
Use the same Windows account that runs that tool so Pomegr can find its locally
saved history. With the default session storage, no extra discovery setup or
reporting plugin is required. You can explore existing history without starting
new work.

If you use a different local profile, open **Settings → Providers** in the desktop
app. Choose the Claude Code **Configuration folder** or Codex **Home folder**, then select **Save
and restart Pomegr** and review the native confirmation. Under Claude Code,
**Advanced** lets you override the session folder separately. This changes what
Pomegr observes; it does not switch the account of an already-running coding tool.
In a browser on the same computer or through paired LAN access, this section shows the effective folders as
read-only paths. Folder changes require the desktop app.

## Find and open a session

1. Open **Pomegr** from the Start menu, or open your portable executable. Allow
   the dashboard to load while Pomegr discovers local sessions.
2. Select **Sessions** in the sidebar. It starts on **Live** when live sessions
   are available, otherwise **All**. Choose **All** to include older work;
   **History** shows sessions outside the current live selection.
3. Use **Filter sessions** to search by session title, project, or coding tool.
   Select the session title to open its dashboard.
4. For new work, start or continue a session in your coding tool as usual, then
   return to Pomegr. The dashboard updates automatically as supported activity
   is recorded.

The **Live** filter depends on the evidence Pomegr can observe. An open coding
tool is not a guarantee that its session appears there, and a session in
**History** is not proof that its work completed. Check **All** before treating
a session as missing.

## Read the first results

The session overview shows observed agents, context, and tool calls. Select an
agent under **Agent activity** to inspect its details. A new session may have
only its primary agent and little activity; more appears when the coding tool
records it.

Loading placeholders mean a section is still preparing its first results.
Sections can become ready at different times, and existing results remain visible
while they refresh. **No recorded activity yet** means Pomegr detected the session
but has no recorded activity to display. This can happen when you open Claude
Code before sending its first prompt.

A missing value or an unavailable feature does not mean zero activity or
successful completion. Claude Code and Codex supply different evidence. See the
[introduction](introduction.md) for examples of the overview, agent details, and
request chart.

## If something is missing

| What you see | What to do |
| --- | --- |
| **No sessions match** | Clear **Filter sessions**, select **All**, and clear any project filter. |
| **No sessions observed** | Allow discovery to finish. Confirm your coding tool saves local history under the same Windows account. Use **Configure session sources** to check **Settings → Providers** if you use a different folder or profile. |
| **No recorded activity yet** | Continue in your coding tool; activity and context appear when it records supported evidence. |
| **Session catalog unavailable** or **Local monitor offline** | Allow Pomegr to reconnect automatically. If it persists in the desktop app, use **Quit Pomegr** in the tray menu, then reopen Pomegr. Closing the window may only hide it to the tray. |
| Missing account usage | Open **Usage limits** and follow **Usage connection help** if shown. Account usage has separate requirements; missing limits do not prevent local session history from appearing. |

Keep prompts, replies, and approvals in your coding tool. Pomegr observes the
session; it does not start work or answer an agent for you.
