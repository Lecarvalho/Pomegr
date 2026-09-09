# MCP observation queries

Pomegr's MCP server exposes bounded read tools for decisions that benefit from
already-observed operational state. These tools are passive clients of Pomegr's
committed monitor caches. They never start the monitor, acquire provider data,
hydrate a session, parse a transcript, or control a coding-agent process.

Use a query only when its result can change the next decision. Do not poll the
tools or call all of them at session start.

| Tool | Use when |
| --- | --- |
| `get_provider_health` | Reported provider health would change whether to begin, retry, defer, or parallelize provider-sensitive work. |
| `get_usage_limits` | Current account capacity would change the scope, timing, or concurrency of planned work. |
| `list_sessions` | An exact Pomegr session reference is needed for another query. |
| `list_session_agents` | Main or delegated agent identity is needed for context or failure inspection; no argument uses the current host session. |
| `get_agent_context` | The latest context level would change whether to continue, compact, split, or stop work; no argument uses the current host session's primary agent. |
| `get_recent_failures` | Retained normalized failures can help diagnose a problem already observed; no session argument uses the current host session. |
| `get_session_report` | A session's bounded Markdown observation report can improve a harness decision, handoff, or diagnosis. |

Session-specific MCP tools automatically select the calling session. Codex supplies
its validated thread/session ID to the MCP subprocess. Claude's `PreToolUse` hook
supplies the current session on every call, including after `/clear` or a session
switch. It extracts the bounded session ID from the host-provided current transcript
locator without opening the transcript or emitting its path. A delegated transcript
resolves to its owning session. Pomegr never guesses a current session from the
repository directory, recency, or process activity.

`list_session_agents`, `get_agent_context`, `get_recent_failures`, and `get_session_report` accept optional
`session_ref` selectors for delegated or historical inspection. `get_agent_context`
also accepts an optional `agent_id` and otherwise selects `primary`.
Omit `session_ref` for the current session; no discovery call or manual ID is required.
Claude's subprocess launch ID is never used as a fallback because it can remain tied
to the previous session. See the
[Claude Code environment reference](https://code.claude.com/docs/en/env-vars).
If the hook cannot resolve the current identity, or is missing or disabled, the MCP
tool returns `current_session_unavailable`. It never selects the preceding session.
Responses identifying a different session from the requested reference are rejected.
Delegated agents use the exact IDs returned by
`list_session_agents` when the primary default is not appropriate.

## Evidence semantics

Provider health is public service reporting. It can cover a broader scope than one
account, model, or session, and it can lag actual failures. **Reported healthy** is
not an availability guarantee. An incident observed near a session failure does not
establish that the incident caused that failure.

Usage limits are current provider/account observations. They are separate from
session history and per-agent context, and are never tokens spent or billing data.
Current limits must not be attached to a historical session.

The optional repository usage guard consumes the same committed usage projection at
most once per configured interval, which is at least 60 seconds for every hook event.
Its threshold messages are deterministic advisory
heuristics, not account capacity, billing, or reset guarantees. A common five-hour or
weekly account window may be useful for a warning; model-specific observations remain
separate and cannot establish the current model's available capacity. Missing, stale,
rejected, or reset-time observations remain unknown and never imply recovery.

Agent context is the latest retained non-zero context snapshot for that normalized
agent. Its input, cache-read, cache-write, and output components describe that one
request-local observation. They are never accumulated across requests. Cache
lifetime is the agent's bounded aggregate of resolved request lifetimes; `30m+`
means a documented minimum, not an observed expiry.

Recent failures come from bounded normalized tool-call and execution-task evidence.
They exclude commands, arguments, descriptions, stdout, stderr, provider error text,
and tool-result content. Missing or truncated evidence remains unavailable, and an
empty result does not prove the full session had no failures.

Every tool returns structured content with schema version, readiness, source
observation time, and committed revision where applicable. `monitor_unavailable`,
`session_not_found`, and `agent_not_found` are normal unavailable observations, not
MCP execution errors.

`get_session_report` returns the same bounded Markdown generated by the dashboard
download, plus its sanitized filename and format. The text content is the report itself
so ordinary MCP clients and harnesses can consume it without interpreting the structured
envelope. The report is precomputed from one committed public session revision during D
Derivation; the GET does not build it or read provider data. Its agent runtime table lists
the latest bounded provider-reported model and reasoning effort for every normalized agent.
Missing values remain unavailable; they are not inferred, and the table does not claim
complete model history, service tier, routing, performance, or cost.

## Local transport and privacy

Packaged desktop queries use a separate per-launch capability that authorizes only
the monitor's GET-only agent-query routes. It cannot access ordinary monitor routes
or the one-shot transcript-path endpoint. The MCP client accepts only loopback
origins, rejects redirects, bounds response time and size, and never prints the
capability. Development retains the existing unauthenticated loopback behavior.

The agent-query API is monitor-private. It is not proxied to the renderer or exposed
through LAN sharing. Responses exclude prompts, responses, reasoning, commands,
tool output, raw provider identifiers and schemas, credentials, transcript paths,
repository paths, and arbitrary error text.
