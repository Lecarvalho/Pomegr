---
title: "Unavailable data"
description: "Tell loading, empty, and unavailable states apart, and read missing evidence and provider service status without assuming an impact or a cause."
---

# Unavailable data

A dash, **Unavailable**, or an "unavailable" message means Pomegr has no usable
evidence for that value right now. It is not zero, and it does not show that work
succeeded, stopped, or failed. Provider service status is likewise a public
report, not proof about your account or a session.

## Loading, empty, or unavailable

| You see | It means |
| --- | --- |
| Gray placeholders, "Loading session…", or "Loading agent evidence…" | Pomegr is preparing the first results. |
| "—" in a summary cell | The value is not ready or has no evidence. Pomegr shows a dash, never an invented zero. |
| **No recorded activity yet** | Pomegr has the session but nothing recorded to show. |
| "Agent evidence is unavailable for this session." | Pomegr confirmed it cannot produce that evidence. |
| "Signal evidence is temporarily unavailable." | The latest request failed, and Pomegr retries. |
| "Activity history is unavailable while this session view is paused." | Refresh is paused; see [Connection problems](connection-problems.md#pomegr-is-paused). |

During a refresh, or after a failed one, Pomegr keeps showing data it already
committed. Check the time beside a value before you treat it as current.

## A value stays unavailable

1. Wait a minute. Pomegr retries in the background.
2. Check whether the value depends on optional setup:
   - **Agent estimate**, **Progress**, and **Reported signals** need the
     [Pomegr plugin](../using-pomegr/reporting-plugins.md). Without a report,
     **Agent estimate** shows "No estimate recorded".
   - **Cost** appears only with Claude Code local usage, and Codex has no session
     estimate. See [Signals and estimates](../concepts/signals-and-estimates.md).
   - **Cache write** and refill markers are missing for Codex, whose records do
     not give reliable cache-write counts as of September 2026. See
     [Cache reuse](../concepts/cache-reuse.md).
   - Usage windows have their own steps in
     [Usage limits](../concepts/usage-limits.md#if-a-window-is-missing).
3. If a section still reads "temporarily unavailable", select **Quit Pomegr** in
   the tray menu and reopen Pomegr. If the same message returns once Pomegr has
   finished loading, that evidence is unavailable for this session.

## Repository details are missing

The **Repository** tab can show "Branch unavailable", "Remote comparison
unavailable", or "Repository evidence is unavailable for this session."

- Git details need Git, and pull-request details need the GitHub command-line
  tool, on the computer running Pomegr. A live session's recorded working folder
  must still exist.
- A recorded session shows only what Pomegr saved at its last live check, never
  today's working tree or stale remote-tracking data.
- "No saved Git snapshot for this session" means Pomegr holds no saved Git state
  for a recorded session: it never checked the session while live, or it no
  longer keeps that state. Recorded file changes still list under **Touched
  here**.
- A Git or GitHub failure affects only this information.

See [Repositories](../using-pomegr/repositories.md#read-a-sessions-repository-tab).

## Needs input looks stale or is missing

**Needs input** reflects what the coding tool last recorded. It clears only when
matching evidence or a later turn is recorded, so it can lag, and Pomegr can miss
some approvals, such as Codex approvals made on a phone. It never shows the
question or approval reason, so check the coding tool itself. See
[Sessions and agents](../using-pomegr/sessions-and-agents.md#read-a-sessions-state).

## What provider status can tell you

**Provider status** on Home, a status dot beside each provider on
**Usage limits**, a chip such as **Degraded service** beside a live session, and
the **Notifications** tray show what each provider's public status page reports.
Select one for **Last checked** (when Pomegr fetched the report), **Provider
update** (when the provider last changed it), and a link to the status page or
incident.

| Label | Read it as |
| --- | --- |
| **Reported healthy** | The relevant components were reported healthy at the last check. |
| **Degraded service**, **Service outage**, **Maintenance** | The provider reported an issue or maintenance on a relevant component. |
| **Status unknown**, **Provider status unavailable** | Pomegr could not establish a status. That is not the same as healthy. |
| **Provider status may be stale**, **Status refresh delayed** | Pomegr is showing the last confirmed report because it could not refresh. |

Pomegr reads only the public status pages. It does not test your account, probe
the provider, or measure availability. Those pages can cover more than your
account or model, so **Reported healthy** does not prove your requests work, and
an incident does not prove it affected a session or caused a failure. The notice
on **Usage limits** and in the tray says "Requests may be delayed or fail" as a
general caution. Historical sessions and downloaded reports never include
provider status.
