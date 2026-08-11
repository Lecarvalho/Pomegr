# Architecture

## Data flow

```text
Provider session files ─┐
Git working tree ───────┼─> local monitor (127.0.0.1:4317)
Plan usage endpoint ────┤            │
Safe lifecycle data ────┤            │
Safe cost snapshots ────┘            │
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

1. Discovers Claude Code and Codex session trees through provider adapters and deterministically selects current or historical sessions.
2. Reads provider session metadata, bounded live tails, and cached historical evidence.
3. Normalizes agents, activity, context snapshots, opt-in lifecycle/context-machinery snapshots, provider-estimated cost snapshots, session metadata, and insights.
4. Builds a bounded, cached catalog of existing session transcripts for concurrent live navigation and history, grouping nested working directories by repository root.
5. Inspects the live session repository with read-only Git commands and resolves bounded pull-request metadata through the authenticated GitHub CLI when available.
6. Retrieves and caches provider plan usage for the live view only.

It listens only on `127.0.0.1`.

### Web application

The React dashboard polls `/api/state` approximately every 1.8 seconds for live session data and loads `/api/sessions` for the history sidebar. A selected historical session is read once because its transcript is immutable for dashboard purposes. Every live-state read asks the monitor for plan usage, but only the monitor decides whether a provider request is due. It shares one in-flight request and one cache across every browser connected to that service process, refreshes at most once every five minutes, and extends the cooldown when the provider returns `Retry-After`. Cached values are returned immediately while a refresh is already running. The server routes proxy to the private monitor so remote browsers never receive credentials or raw transcripts.

Markdown retrospective reports are assembled and downloaded in the browser from the same normalized state. Report generation performs one fresh local-state read, does not call a model, and does not request the provider usage endpoint.

### Development orchestrator

`scripts/dev.mjs` starts both long-running processes. The web process binds to `0.0.0.0:3003` for local-network viewing.

## Normalized state

- `session` — title, project, timestamps, repository, bounded pull-request associations, the latest recognized provider-reported approval mode, the latest bounded provider-generated session summary when available, an optional reported session signal, and an optional provider-estimated USD cost snapshot
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

## Provider boundary

```text
monitor/providers/
├── claude.mjs
├── codex.mjs
├── codex-liveness.mjs
└── provider-contract.mjs
```

Each adapter implements session discovery, agent relationships, labels, context snapshots, model/effort metadata, sanitized activity, timestamps, and optional capabilities. Git remains provider-independent after an adapter returns a working directory. Plan usage remains optional and is excluded from historical views.

### Codex live state

Codex liveness is resolved provider-side in strict priority order: an explicitly supplied owning app-server status, an opt-in lifecycle bridge with a valid owner lease, then a bounded rollout-tail heuristic. `notLoaded` from another app-server is unknown and falls through. Current liveness evidence is never applied to historical reads.

The bridge entry point is `scripts/codex-lifecycle-bridge.mjs`. It consumes Codex hook JSON but atomically persists only the allowlisted session/turn/agent IDs, lifecycle enum, request kind, timestamps, sequence, and monitor-local owner identity. On Windows it walks the hook command's process ancestry using process IDs, names, and creation times only, then binds the lease to the nearest allowlisted Codex/ChatGPT owner; none of the discovery fields beyond PID and creation time are persisted. A detached `scripts/codex-lifecycle-owner.mjs` process renews one shared 45-second PID-plus-process-start lease every 15 seconds. It produces no decision or model context. Snapshots and leases default to `~/.threadlight/codex-liveness`; `THREADLIGHT_CODEX_LIVENESS_DIR` is the opt-in root override used by both bridge and monitor. `THREADLIGHT_CODEX_OWNER_PID` can explicitly select the owner for an unusual command-wrapper topology.

Configure the same absolute bridge command for `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop` in a trusted Codex `hooks.json` layer. The handler should be a command with a short timeout, for example:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "commandWindows": "node \"C:\\\\path\\\\to\\\\threadlight\\\\scripts\\\\codex-lifecycle-bridge.mjs\"", "timeout": 3 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "commandWindows": "node \"C:\\\\path\\\\to\\\\threadlight\\\\scripts\\\\codex-lifecycle-bridge.mjs\"", "timeout": 3 }] }]
  }
}
```

Repeat the handler for the other listed events. `PreToolUse`, `PermissionRequest`, and `PostToolUse` must match all supported tools so later progress can clear pending input. Threadlight writes `{}` to hook stdout, which is inert while satisfying `Stop` and `SubagentStop` JSON-output requirements.

Without a current authoritative source, the adapter reads at most 128 KiB and 256 records from each relevant rollout tail. Recognized activity is active for 15 seconds, idle/recent through 120 seconds, then not live. Rollout-only `request_user_input` is current for at most 120 seconds and clears on its matching structured output. Tail results are keyed by file size and modification time; catalog/status reads are cached for 1.5 seconds. Parent agents reuse the shared waiting propagation when a descendant remains active.

## Failure behavior

- No session: connected monitor with an explanatory empty state
- Git failure: repository unavailable without failing the session
- GitHub CLI or network failure: recorded pull-request links remain visible with unavailable live metadata, and branch association degrades independently
- Usage failure: remaining dashboard stays available
- Missing historical transcript: selected view explains that the session is no longer available
- Malformed JSONL: skip the individual line
- Synthetic or zero usage: exclude from latest-context selection
