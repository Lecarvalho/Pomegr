# Architecture

## Data flow

```text
Provider session files ─┐
Git working tree ───────┼─> local monitor (127.0.0.1:4317)
Plan usage endpoint ────┘            │
Safe cost snapshots ─────────────────┘
                                     │ normalized JSON
                                     v
                              /api/state proxy
                                     │
                                     v
                           Threadlight web UI (:3003)
```

The browser receives normalized metadata only. The monitor owns privileged access to local transcripts, Git, and OAuth-backed plan data.

## Runtime components

### Local monitor

`monitor/server.mjs` currently:

1. Finds the session tree with the latest primary or subagent activity, or uses `CLAUDE_SESSION_FILE`.
2. Reads primary and subagent JSONL files.
3. Normalizes agents, activity, context snapshots, opt-in context-machinery snapshots, provider-estimated cost snapshots, session metadata, and insights.
4. Builds a bounded, cached catalog of existing session transcripts for concurrent live navigation and history, grouping nested working directories by repository root.
5. Inspects the live session repository with read-only Git commands.
6. Retrieves and caches provider plan usage for the live view only.

It listens only on `127.0.0.1`.

### Web application

The React dashboard polls `/api/state` approximately every 1.8 seconds for live session data and loads `/api/sessions` for the history sidebar. A selected historical session is read once because its transcript is immutable for dashboard purposes. On entry to a live view, the dashboard immediately requests a cache-aware plan-usage refresh. The monitor serves an attempt made within the last minute from its cache; the dashboard waits out any remaining cooldown before requesting again. The server routes proxy to the private monitor so remote browsers never receive credentials or raw transcripts.

Markdown retrospective reports are assembled and downloaded in the browser from the same normalized state. Report generation performs one fresh local-state read, does not call a model, and does not request the provider usage endpoint.

### Development orchestrator

`scripts/dev.mjs` starts both long-running processes. The web process binds to `0.0.0.0:3003` for local-network viewing.

## Normalized state

- `session` — title, project, timestamps, repository, the latest bounded provider-generated session summary when available, an optional reported session signal, and an optional provider-estimated USD cost snapshot
- `view` — live or historical presentation mode
- `metrics` — agents, tools, repetition, context usage
- `agents` — identity, parent relationship, runtime settings, state, tokens, explicitly invoked skill names/counts, execution tasks observed in that agent's transcript, and an optional reported agent signal
- `activity` — sanitized tool, failed shell-completion, and user-input events
- `executionTasks` — the primary agent's bounded shell-task lifecycle metadata, retained for API compatibility
- `insights` — deterministic rules
- `usageLimits` — normalized plan windows and resets

The UI depends on normalized shapes rather than raw provider records.

Reported signals use the transcript as their only durable source. The local MCP server validates and acknowledges `report_session_signal`, `report_agent_signal`, and `report_task_signal`, but stores nothing. For live and historical views alike, the monitor extracts the latest valid calls from every agent transcript and applies the shared signal normalizer. The latest session signal across all agents decorates the session header. An agent signal decorates only its reporting agent. A task signal is resolved monitor-side against a normalized Bash tool-use or background-task ID and is exposed only when that execution task matches. Historical full-file signal scans are cached; raw target arguments, unmatched signals, tool results, and surrounding response content are never exposed.

When the provider records a recognized session summary, `session.summary` carries only the latest bounded, whitespace-normalized plain-text summary, its transcript timestamp, and provider provenance. Threadlight does not derive a summary from prompts, responses, or tool results. The dashboard labels the text as provider-generated and falls back to static privacy copy when no summary is available.

Claude Code sends `cost.total_cost_usd` only to its configured status-line command. The optional bridge stores a separate per-session snapshot containing only session ID, estimated USD amount, estimate type, and local observation timestamp, then forwards the original input unchanged to the user's existing status-line command. The monitor reads the sanitized snapshot by session ID. Raw status-line JSON never enters browser state.

When a Claude Code session has recorded `/context` output, `session.contextMachinery` carries its latest sanitized, provider-estimated machinery total plus category and item tables. The total sums non-message category rows so expandable group details are not double-counted. The monitor discovers groups from table headers rather than a repository-specific catalog; raw command output and full memory paths stay monitor-side.

## Adding Codex support

Extract the current parser into a provider boundary before adding Codex:

```text
monitor/providers/
├── claude.mjs
├── codex.mjs
└── shared.mjs
```

Each provider should implement session discovery, agent relationships, labels, context snapshots, model/effort metadata, sanitized activity, and timestamps. Git remains provider-independent after an adapter returns a working directory. Plan usage remains an optional provider capability.

## Failure behavior

- No session: connected monitor with an explanatory empty state
- Git failure: repository unavailable without failing the session
- Usage failure: remaining dashboard stays available
- Missing historical transcript: selected view explains that the session is no longer available
- Malformed JSONL: skip the individual line
- Synthetic or zero usage: exclude from latest-context selection
