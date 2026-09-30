---
title: "MCP queries"
description: "Let a coding agent read Pomegr's already-observed provider health, usage limits, agents, context, failures, and session report, and know what each result can and cannot show."
---

# MCP queries

With the [Pomegr plugin](reporting-plugins.md) installed, your coding agent can
read a few facts Pomegr has already observed, then decide whether to continue,
wait, or change plan. The seven tools are read-only. They read only what Pomegr
has committed locally: they never start Pomegr, read a transcript, or control an
agent. You do not call them yourself: the agent decides when a result could
help, and you can ask it to check.

## When to use each tool

Use a query only when its result could change the next decision. Do not poll a
tool or call all of them at the start of a session.

| Tool | Use it when |
| --- | --- |
| `get_provider_health` | Provider health would change whether to start, retry, or run work in parallel. |
| `get_usage_limits` | Account capacity would change the scope, timing, or concurrency of planned work. |
| `list_sessions` | You need an exact session reference for another query. |
| `list_session_agents` | You need the main agent or a subagent's identity. |
| `get_agent_context` | The latest context level would change whether to continue, compact, split, or stop. |
| `get_recent_failures` | Retained failures could help diagnose a problem you already observed. |
| `get_session_report` | A bounded session report would help a handoff, decision, or diagnosis. |

The session tools default to the session that is calling, and
`get_agent_context` defaults to its main agent, so no ID is needed. Pass a
`session_ref` from `list_sessions`, or an agent ID from `list_session_agents`,
only to inspect another session or a subagent. Pomegr never guesses a session
from the folder or from recent activity.

## What each result contains

- **Provider health.** For each coding tool: a status (operational, degraded,
  outage, maintenance, or unknown), freshness, check times, and up to eight active
  incidents with official links. It is the provider's public status page, so it can
  cover more than your account and lag real failures.
- **Usage limits.** Each account window's used percentage, reset time, and
  severity, with freshness and observation times, plus an optional count of local
  working sessions. See [Usage limits](../concepts/usage-limits.md).
- **Sessions and agents.** Sessions (live by default, at most 50) with title,
  project, state, and activity; agents with role, status, assignment, and current
  activity.
- **Agent context.** The latest non-zero snapshot: total, uncached input, cache
  read, cache write, output, and cache lifetime. See
  [Context and tokens](../concepts/context-and-tokens.md).
- **Recent failures.** Up to 10 failures (at most 25) from the last 15 minutes by
  default (at most 24 hours), each with agent, time, work kind, tool label, and failure
  category, plus how much history was retained.
- **Session report.** The same bounded Markdown as **Download report**.

## Read the results carefully

- A healthy provider status is not an availability guarantee. A failure near an
  incident does not show the incident caused it.
- Usage limits are the account's current windows, not tokens spent, billing, or a
  past session's usage.
- Context is a latest snapshot, never a running total or cost.
- An empty failure list does not prove the session had no failures.
- A result can be unavailable: `monitor_unavailable` (Pomegr is not running),
  `current_session_unavailable`, `session_not_found`, or `agent_not_found`. These
  are normal answers, not errors, and say nothing about how the work went.
