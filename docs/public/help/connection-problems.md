---
title: "Connection problems"
description: "Recover when Pomegr shows Monitor offline or Session catalog unavailable, is paused, does not open, or cannot be reached from a phone."
---

# Connection problems

Pomegr's dashboard reads from a monitor that runs on your computer. When the
dashboard cannot reach it, Pomegr keeps showing the last data it committed and
retries automatically. These states describe that connection, not your coding
tools, and they do not show that any session stopped or failed.

## Monitor offline

The top bar reads **Connecting** while the dashboard reaches the monitor,
**Local monitor** once it does, and **Monitor offline** when it cannot. The
sidebar then says "Local observer unavailable. Showing last known-good state.",
and the **Notifications** tray lists "Monitor unavailable".

1. Wait a minute. Pomegr retries on its own, and the top bar returns to
   **Local monitor** with refreshed data.
2. In the desktop app, select **Quit Pomegr** in the tray menu, then open Pomegr
   again from the Start menu or your portable executable. Closing the window only
   hides it to the tray, so quitting is what restarts the monitor.
3. If Pomegr does not start, see [Pomegr does not open](#pomegr-does-not-open).

## Session catalog unavailable

**Sessions** reads **Session catalog unavailable** with "Pomegr will retry the
local monitor automatically." when the monitor cannot be reached and the list has
no rows to show. If rows are retained, they stay under the note "The local monitor
is reconnecting. Showing the last known session catalog." A session page can read
**Session evidence unavailable** with "Pomegr has not yet reached the local
monitor for this session." for the same reason.

Follow the steps under [Monitor offline](#monitor-offline). When the connection
returns, the list and the session fill in on their own. If the list is then
empty, see [Missing sessions](missing-sessions.md).

## Pomegr is paused

**Pause live refresh** in the tray menu stops the dashboard from polling. While
it is on, **Sessions** can read **Session catalog unavailable** with "Pomegr is
paused. Resume it to refresh the session directory.", and a session's Activities
tab reads "Activity history is unavailable while this session view is paused."

1. Open the tray menu and select **Resume live refresh**.
2. Wait a moment. The data refreshes.

Pausing does not touch your coding agents, and it is not saved: Pomegr starts
unpaused.

## Pomegr does not open

1. Check the tray. Closing the window can hide Pomegr to the notification area,
   where it keeps observing. Select the Pomegr icon or **Open Pomegr**. Starting
   Pomegr again also focuses the window that is already running.
2. Confirm you installed the Windows x64 build from the
   [download page](https://pomegr.com/download). Pomegr does not need Node.js or
   Git to start. Comparing the file's SHA-256 with the checksums in the release
   notes linked from that page shows whether the download is intact.
3. If a page reads "Pomegr could not start" with "The local services did not
   become ready", close Pomegr and open it once more.
4. If it repeats, note the error code the page shows, `DESKTOP_START_FAILED`.
   When you report the problem, leave out private paths, transcripts,
   credentials, and screenshots of session data.

## A phone cannot connect

If the dashboard works on your computer but not on a paired phone, the cause is
usually pairing, the network, or the firewall. Use the recovery steps in
[Phone access](../using-pomegr/phone-access.md#if-a-phone-cannot-connect).
