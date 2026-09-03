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
| `list_session_agents` | An exact main or delegated agent reference is needed for context or failure inspection. |
| `get_agent_context` | The latest context level would change whether to continue, compact, split, or stop work. |
| `get_recent_failures` | Retained normalized failures can help diagnose a problem already observed in the session. |

Session-specific tools require the exact `session_ref` returned by
`list_sessions`. The main agent always has the normalized ID `primary`; delegated
agents use the exact IDs returned by `list_session_agents`. Pomegr does not guess a
current session or calling agent from the repository directory, recency, or process
activity.

## Evidence semantics

Provider health is public service reporting. It can cover a broader scope than one
account, model, or session, and it can lag actual failures. **Reported healthy** is
not an availability guarantee. An incident observed near a session failure does not
establish that the incident caused that failure.

Usage limits are current provider/account observations. They are separate from
session history and per-agent context, and are never tokens spent or billing data.
Current limits must not be attached to a historical session.

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
