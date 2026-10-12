---
title: "MCP tools"
description: "The complete list of the tools that the Pomegr plugin gives a coding agent: reporting tools, read-only queries, and task tools, with the guide for each group."
---

# MCP tools

The [Pomegr plugin](reporting-plugins.md) gives a coding agent a set of MCP tools.
This page is the complete list. Each group has its own guide that tells you how the
tools behave and what Pomegr shows.

You do not call these tools yourself. The agent calls them, and you can ask it to.
The coding tool shows each name with its own prefix, for example
`mcp__plugin_pomegr_pomegr__get_usage_limits` in Claude Code.

## Reporting tools

These tools write a short status that Pomegr shows as agent-reported. They do not
change a session or a task. Guide: [Reporting plugins](reporting-plugins.md#what-agents-report).

| Tool | What it does |
| --- | --- |
| `report_session_signal` | Sets or replaces the signal of the session. |
| `clear_session_signal` | Removes the signal of the session. |
| `report_agent_signal` | Sets or replaces the signal of the agent that calls it. |
| `clear_agent_signal` | Removes the signal of the agent that calls it. |
| `report_task_signal` | Records an outcome for one shell task. It cannot be cleared; a later report replaces it. |
| `report_session_progress` | Sets or replaces the progress estimate of the session. |
| `clear_session_progress` | Removes the progress estimate of the session. |
| `rename_session` | Sets the title of the session. Claude Code only. |

## Query tools

These seven tools are read-only. They read only what Pomegr has already observed.
Guide: [MCP queries](mcp-queries.md).

| Tool | What it returns |
| --- | --- |
| `get_provider_health` | The public service status of each provider. |
| `get_usage_limits` | The current account usage windows. |
| `list_sessions` | Sessions, with an exact reference for each one. |
| `list_session_agents` | The agents of one session. |
| `get_agent_context` | The latest context snapshot of one agent. |
| `get_recent_failures` | The recent failures that Pomegr kept for one session. |
| `get_session_report` | The Markdown report of one session. |

## Task tools

These eleven tools work on the task board of the repository. Ten of them write to
it; they are the only tools that change something you made or that Pomegr manages.
`get_feature` only reads. Guide: [Tasks](tasks.md#what-agents-report).

| Tool | What it does |
| --- | --- |
| `add_task` | Adds a task to the first column of the board. It does not queue or start the task. |
| `update_task` | Changes the text, **Run on**, **Effort**, or **Complete when** of a task that has not started. |
| `remove_task` | Deletes a task that the same session added, if the task has not started. |
| `assign_task` | Assigns the session to a task of the board that is not done, so the session can report it. It changes no state and starts nothing. |
| `unassign_task` | Removes the session's own assignment from a task. |
| `complete_task` | Reports that a task of the session is complete. The task goes to **Review**. |
| `block_task` | Reports that the agent cannot continue a task, with a short reason. |
| `get_feature` | Reads the title, description, and app version of one feature. |
| `create_feature` | Creates a feature with a title, and optionally a description and an app version. |
| `update_feature` | Changes the title, description, or app version of a feature. |
| `delete_feature` | Deletes a feature that has no task. |

`complete_task` and `block_task` work in a session that Pomegr started for a task, and
in a session that is assigned to a task. A session with more than one task names the
task with `task_id`. The first report on a task wins. `assign_task` and `unassign_task`
need plugin 0.9.8 or later.

## If a tool is missing

Run `/pomegr:doctor` in Claude Code or `$pomegr:doctor` in Codex. Then see
[If reporting is missing](reporting-plugins.md#if-reporting-is-missing). A session
keeps the plugin version that it loaded, so a new tool appears only in a session
that starts after the update.
