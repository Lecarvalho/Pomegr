---
title: "Missing sessions"
description: "Find a session that does not appear in Pomegr: clear filters, check Live and All, confirm the provider folders, and recover from an unavailable session."
---

# Missing sessions

Use this page when **Sessions** is empty or a session you expect is not listed.
The usual causes are a search or filter hiding the row, or Pomegr reading a
different folder from your coding tool. A missing session is missing evidence; it
does not show that the work never happened or did not finish.

## An empty Sessions list

The list reads **No sessions match** when a search or filter matches none, and
**No sessions observed** when Pomegr has found no sessions.

### No sessions match

A search or filter is hiding the rows, and "0 matches" appears beside the
filters.

1. Clear **Filter sessions**, and select the close button on a **Project:** or
   **Repository:** chip if one is shown. **View sessions** on a repository opens
   the list with the **Repository:** chip.
2. Select **All**. **Live** and **Needs input** list only sessions in that state.

Rows return, and "0 matches" changes to a count of the sessions listed.

### No sessions observed

No search or filter is active and the count beside **All** is zero.

1. Wait while the list reads "Loading sessions". The first discovery can take a
   moment, and each coding tool reports on its own.
2. Confirm your coding tool has saved a session on this computer, under the
   Windows account that runs Pomegr. Pomegr reads only locally saved history, not
   sessions from another computer or account.
3. Select **Configure session sources** under the empty list, or open
   **Settings → Providers**. In the desktop app, each row reads
   **Default folder**, **Launch environment**, or **Custom folder**, then
   **Available** or **Unavailable**. **Unavailable** means Pomegr cannot read that
   folder; **Available** does not mean it holds sessions. A browser shows each
   folder read-only, or **Path unavailable**.
4. If your coding tool keeps its history in another profile, choose that folder in
   the desktop app as described in
   [If you use a different profile](../get-started/first-session.md#if-you-use-a-different-profile).

After Pomegr restarts, sessions from the new folder appear as discovery finishes.

## A session is missing from Live

**Live** lists sessions Pomegr has current evidence for, such as a coding tool's
own session registration, recent activity, or a confirmed process. An open coding
tool does not guarantee a place there, and a session that leaves **Live** did not
necessarily finish. Select **All** to find it.
[Sessions and agents](../using-pomegr/sessions-and-agents.md#read-a-sessions-state)
explains each state.

- An **Open** session moves from **Live** to **All** five minutes after its last
  recorded activity, and keeps its state.
- For Codex, Pomegr shows unresolved work as live only while it can confirm a
  running Codex process. Without that, the session sits under **All** and its
  state can read **Unknown**: missing evidence, not proof that the work stopped
  or finished.
- If only one coding tool's sessions appear, check that tool's folder in
  **Settings → Providers**. Pomegr discovers Claude Code and Codex independently,
  so a problem with one does not remove the other's sessions.

## Session unavailable

Opening a session can show **Session unavailable** with "Pomegr found no recorded
evidence for this session." or "Pomegr has no committed summary for this
session." This can happen when the provider's history for that session was
deleted, or when the link is to a session this Pomegr never observed.

1. Select **Sessions**, type part of the title in **Filter sessions**, and select
   **All**. If the session still exists, its row appears; open it from there.
2. If it is gone, Pomegr cannot restore it, because it keeps no copy of a
   session's transcript.

A listed session that shows **No recorded activity yet** is not missing; see
[Follow your first session](../get-started/first-session.md#read-the-first-results).
**Session catalog unavailable** and **Session evidence unavailable** describe the
connection instead; see [Connection problems](connection-problems.md).
