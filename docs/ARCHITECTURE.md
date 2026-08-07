# Architecture

## Data flow

```text
Provider session files ─┐
Git working tree ───────┼─> local monitor (127.0.0.1:4317)
Plan usage endpoint ────┘            │
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
3. Normalizes agents, activity, context snapshots, opt-in context-machinery snapshots, session metadata, and insights.
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

- `session` — title, project, timestamps, repository, and the normalized first-request footprint when recorded
- `view` — live or historical presentation mode
- `metrics` — agents, tools, repetition, context usage
- `agents` — identity, parent relationship, runtime settings, state, tokens, and explicitly invoked skill names/counts
- `activity` — sanitized tool and user-input events
- `insights` — deterministic rules
- `usageLimits` — normalized plan windows and resets

The UI depends on normalized shapes rather than raw provider records.

When a Claude Code session has recorded `/context` output, `session.contextMachinery` carries its latest sanitized, provider-estimated category and item tables. The monitor discovers groups from table headers rather than a repository-specific catalog; raw command output and full memory paths stay monitor-side.

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
