---
title: "Introduction to Pomegr"
description: "Take a look inside Pomegr and see how it helps you follow your coding agents at work and plan tasks for them."
---

# Introduction to Pomegr

Pomegr helps you follow your coding agents at work. Open it alongside Claude Code
or Codex to see which sessions need attention, what each agent is doing, and how
much [context](../concepts/context-and-tokens.md) it is using.

To get started, [install Pomegr](install.md) on your Windows computer, then
[follow your first session](first-session.md).

## A session at a glance

Here is Pomegr showing a recorded Claude Code session: one primary agent and
eight subagents.

![A recorded session's Overview tab in dark theme, with 9 agents, 2.3M all-agent context, 2h 10m recorded wall time, 594 calls, and a 100% agent estimate.](../images/introduction/session-overview.jpg)

*A real recorded development session from the Pomegr project, with its actual
activity and numbers.*

A session opens with a header, a summary strip that stays in view, and tabs.
Read the strip from left to right:

- **Agents** shows how many agents Pomegr has seen and their states.
- **All-agent context** adds each agent's latest context snapshot. It does not
  mean the agents share context, and it is not a token-spend total. See
  [Context and tokens](../concepts/context-and-tokens.md).
- **Wall time**, or **Recorded wall time** for a recorded session, includes idle
  gaps.
- **Calls** shows recorded tool use, such as running a test or searching the
  project.
- **Agent estimate** is the progress the agent reported through the optional
  Pomegr [reporting plugin](../using-pomegr/reporting-plugins.md), not a Pomegr
  measurement. Without a report the strip shows **No estimate recorded**.

The **Overview** tab summarizes the session; **Agents**, **Activities**,
**Repository**, and **Signals** go deeper. **Resources** appears when Pomegr has
resource data for the session, and **Details** lists further session facts.

## Meet the agents

Open the **Agents** tab to see the team. Selecting an agent opens its details on
the right: model, context, wall time, tool calls, cache lifetime, and more. Filter
or group the roster, and switch between **List** and **Grid** to explore the same
agents in different views. [Sessions and agents](../using-pomegr/sessions-and-agents.md)
explains each state and label.

![The Agents tab in dark List view: a primary agent with 440.5K final context, eight subagents, and the selected primary agent's model, context, wall time, and tool calls on the right.](../images/introduction/agents-tab.jpg)

*The same session's Agents tab, with the primary agent selected.*

## Look inside a request

The **Requests** chart on the **Activities** tab shows one bar per model request,
with a lane for each agent so you can see subagents work side by side. Each lane
has its own scale; **Single chart** combines them. Select a bar, or a request in
the **Activity feed** below the chart, to see its recorded actions. **Full
breakdown**, shown here, includes cache reads; **Fresh tokens** excludes them.
Each request is an independent observation, not a running total or a cost per
action.

![The Requests chart in dark Full breakdown mode with request 300 selected: one lane per subagent, each with its own maximum, and a legend for uncached input, cache write, cache read, output, and compaction.](../images/introduction/requests-chart.jpg)

*The same session's Requests chart around request 300.*

## Follow more than one session

Use **Sessions** to move between live and recorded work. **Models & delegation**
shows which models your agents use and how work is delegated, while
[**Repositories**](../using-pomegr/repositories.md) groups work by project. Check
**Usage limits** for supported account windows when that information is available.

Dark mode is the default. Switch to the light theme from the **Local profile**
menu, or set **Color theme** under **Settings → Appearance**. See
[Settings](../using-pomegr/settings.md) for the other options.

![The same session's header, summary strip, and tabs in Pomegr's light theme.](../images/introduction/light-mode.jpg)

*The same session in the light theme.*

Keep working in your coding tool. Pomegr observes existing session records without
controlling your agents or putting prompts, responses, and credentials in the
dashboard.

## Plan work for your agents

In the desktop app, **Tasks** gives each repository a task board. A task is work you
want a coding agent to do, and Pomegr starts a Claude Code or Codex session for it
when you select **Start session**, or when you turn on the queue. The queue starts
cards from the top of **Ready**, one after another. Cards in a **Parallel** group
start together, each in a Git worktree of its own. See [Tasks](../using-pomegr/tasks.md).

**Aril** is the chat panel at the bottom right of the window. It reads the board, the
repository's files, and what Pomegr observed, then proposes changes, such as tasks
cut from a feature. Nothing changes until you select **Apply changes**, and Aril
starts a session or turns the queue on or off only through a proposal you apply. See
[Agent chat](../using-pomegr/agent-chat.md).

After a start, Pomegr only observes the session: it never stops, attaches to,
answers, or approves anything in a running session. Sessions always run on the
computer running Pomegr. A paired phone can change tasks and apply Aril's proposals,
but Aril's start proposals are applied in the desktop app. Observing sessions works
the same whether or not you use tasks.

## Know what the numbers can tell you

Claude Code and Codex expose different information. A missing value means Pomegr
does not have supported evidence; it does not prove inactivity or success.

Agent reports and provider estimates are labeled as such, like **Agent estimate**
and the Overview **Cost** panel's "Estimate, not a bill." That panel appears only
for Claude Code sessions with local usage enabled. Efficiency signals on the
**Signals** tab use explainable rules to point out recorded patterns, not to
grade your agent's work. Wall time includes idle gaps.
