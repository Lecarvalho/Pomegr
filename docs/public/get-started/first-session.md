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
[reporting plugin](../using-pomegr/reporting-plugins.md) is required. You can explore existing history without starting
new work. If you use a different local profile, see
[If you use a different profile](#if-you-use-a-different-profile).

## Find and open a session

1. Open **Pomegr** from the Start menu, or open your portable executable. The
   dashboard opens on **Home** while Pomegr discovers local sessions.
2. Select **Sessions** in the sidebar. It starts on **Live** when live sessions
   are available, otherwise **All**. Choose **All** to include older work, or
   **Needs input** to see sessions where Pomegr observed an agent waiting for you.
3. Use **Filter sessions** to search by session title, project, or coding tool.
   Select the session title to open its dashboard, which starts on **Overview**.
4. For new work, start or continue a session in your coding tool as usual, then
   return to Pomegr. The dashboard updates automatically as supported activity
   is recorded.

The **Live** filter depends on the evidence Pomegr can observe. An open coding
tool is not a guarantee that its session appears there, and a session missing
from **Live** is not proof that its work completed. Check **All** before treating
a session as missing; [Missing sessions](../help/missing-sessions.md) has the full
recovery. [Sessions and agents](../using-pomegr/sessions-and-agents.md) explains
each state label.

## Read the first results

A session opens on a summary of its agents,
[context](../concepts/context-and-tokens.md), and calls, with tabs beneath it.
The **Overview** tab summarizes the session; open the **Agents** tab, or select
**Right now**, and choose an agent to inspect its details. A new session may have
only its primary agent and little activity; more appears when the coding tool
records it.

Loading placeholders mean a section is still preparing its first results.
**No recorded activity yet** means Pomegr detected the session but has no
recorded activity to display, for example before you send Claude Code its first
prompt. A missing value or an unavailable feature does not mean zero activity or
successful completion; see [Unavailable data](../help/unavailable-data.md). The
[introduction](introduction.md) shows examples of the overview, the Agents tab,
and the Requests chart.

## If something is missing

These are the quick fixes. [Missing sessions](../help/missing-sessions.md),
[Unavailable data](../help/unavailable-data.md), and
[Connection problems](../help/connection-problems.md) explain each symptom and
what it does not prove.

| What you see | What to do |
| --- | --- |
| **No sessions match** | Clear **Filter sessions** and select **All**. |
| **No sessions observed** | Wait for discovery to finish. |
| **No sessions observed** after discovery finishes | Select **Configure session sources** to check your provider folders. |
| **Session catalog unavailable** or **Monitor offline** | Wait; Pomegr reconnects automatically. |
| **Session catalog unavailable**, saying Pomegr is paused | Select **Resume live refresh** in the tray menu. |
| **No recorded activity yet** | Continue in your coding tool. |
| Missing account usage | Open **Usage limits** and follow **Usage connection help** if shown. |

If an unavailable message persists in the desktop app, select **Quit Pomegr** in
the tray menu, then reopen Pomegr; closing the window may only hide it to the
tray. Account usage has separate requirements, and missing limits do not prevent
local session history from appearing.

## If you use a different profile

1. In the desktop app, open **Settings → Providers**.
2. Choose the Claude Code **Configuration folder** or the Codex **Home folder**.
   For Claude Code, **Advanced** sets the session folder separately.
3. Select **Save and restart Pomegr** and review the native confirmation. Pomegr
   restarts and observes the new folders.

This changes what Pomegr observes; it does not switch the account of an
already-running coding tool. A browser on the same computer, or paired over your
network, shows these folders read-only. Changing them requires the desktop app.
See [Settings](../using-pomegr/settings.md#choose-provider-folders) for what each
label means.

Keep prompts, replies, and approvals in your coding tool. Pomegr observes the
session; it does not start work or answer an agent for you.
