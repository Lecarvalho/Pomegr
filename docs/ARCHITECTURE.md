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

### Desktop runtime compatibility boundary

The TL-DT-02 Windows compatibility candidate uses Electron's bundled Node.js environment; it must not launch or require a system `node.exe` for the monitor or production web server. Electron `utilityProcess` was evaluated first, but on the supported Windows test host Chromium terminated the browser process with native breakpoint status `0x80000003` immediately after the utility spawned and before its entry module evaluated. Launching a second Electron executable in bundled-Node mode reached the same host breakpoint, while disabling Chromium's sandbox globally is not an acceptable runtime dependency. Creating a second Node worker hit the same host boundary. The feasibility fallback therefore runs the credential-owning monitor in the sole Node worker and hosts only the provider-neutral production web lifecycle in Electron main. This remains narrower than the preferred two-utility target architecture; TL-DT-03 must re-evaluate service isolation before adding any UI or native integration.

The launcher gives Electron main a strict keep-only environment containing the filtered executable path, Windows runtime fields, temporary directories, locale fields, and fixed smoke metadata. Every `PATH` directory containing `node.exe` is removed before launch, the main process asserts the same guard before importing web code, and the monitor worker inherits that filtered path. Provider roots and home/profile locations are written as an allowlisted monitor-only snapshot inside the temporary fixture; main receives only the snapshot path, and the monitor worker installs those values before provider discovery. Before main dynamically imports the web server, it rebuilds its environment from the same keep-only runtime allowlist and explicitly sets only the loopback monitor origin. The production web graph has no monitor/provider import and receives no direct transcript path, provider credential, authentication token, PAT, or SSH agent socket. Service modules resolve from the application resource path rather than the launch working directory.

The smoke's external Git compatibility probe runs in Electron main with `execFile("git", ["--version"])`; a passing result proves that the filtered runtime preserves Git without a shell or terminal but does not claim that child-process creation is stable inside the monitor worker. The monitor remains the owner of repository selection and Git result normalization. Before TL-DT-03 can adopt this fallback as production architecture, Git and optional `gh` execution must either use a stable isolated service host or a narrow main-process execution bridge that accepts only fixed operations and validated argument arrays and returns bounded structured results. Main must never receive transcript contents or parse provider schemas.

Electron 43.3.0 remains the development candidate. A normal-PowerShell packaged smoke passed after the production `dist/` tree was supplied as Vinext's physical unpacked output root, but the launch environment was subsequently tightened as described above. TL-DT-02 remains pending until that changed boundary passes the packaged smoke again.

`npm run desktop:smoke` is the acceptance gate for this structure. Its launcher runs with Electron's bundled Node environment, creates a temporary real `app.asar`/`app.asar.unpacked` resource layout, and starts that archive with hardware acceleration and GPU processes disabled, error dialogs suppressed, and profile/crash/log state isolated to the temporary fixture. Lifecycle shutdown escalates through bounded graceful close and worker termination while awaiting exit, then closes the in-main web listener. A behavioral lifecycle test exercises the forced-cleanup path without deliberately crashing a live runtime before the production services start. The gate covers ESM loading, the self-contained monitor bundle, filesystem reads through the ASAR resource root, the native Sharp runtime, built-in `fetch`, filtered-path Git execution with argument arrays, provider discovery through the normalized sessions endpoint, dynamic loopback listeners, and awaited shutdown. It creates no `BrowserWindow`, tray, updater, installer, or renderer IPC surface, and a successful run must leave no Electron process or temporary fixture.

The accepted ASAR boundary is deliberately minimal for the APIs in use: unbundled source and runtime packages remain inside `app.asar`. Electron workers hit the host breakpoint when their ESM loader imported modules directly from ASAR, so the smoke build uses Vite's Node SSR bundler to emit one self-contained physical CommonJS monitor bundle at `desktop/workers/monitor-host.cjs` (`ssr.noExternal: true`, code splitting disabled). Vinext dynamically imports its server entry and expects the server, client, static assets, and manifests beneath one `outDir`; the complete generated `dist/` tree is therefore unpacked and supplied as that physical root. The production dependency graph includes Sharp, so `libvips-42.dll`, `libvips-cpp-8.17.3.dll`, and `sharp-win32-x64.node` under `node_modules/@img/sharp-win32-x64/lib/` are unpacked because native loading requires real filesystem paths. A focused ASAR test derives the current generated `dist/` file list, compares it to the archive header, and verifies every expected physical file, preventing unrelated files from drifting into the boundary. Threadlight owns no other native addon or executable that needs unpacking. Electron itself remains outside `app.asar` as part of the packaged runtime. System `git.exe` and optional `gh.exe` are invoked in place and are not copied into application resources. If a future packaged dependency requires another real filesystem path, only that dependency's exact runtime files may move to `app.asar.unpacked`, with a new smoke assertion and documented reason.

Provider transcripts, credentials, provider-owned configuration, Git repositories, and Threadlight user state are never application resources and must never be copied into `app.asar` or `app.asar.unpacked`. This compatibility proof reads provider records only through the existing monitor/provider boundary and returns only the normalized session catalog.

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

Reported signals use the transcript as their only durable source. The local MCP server validates and acknowledges `report_session_signal`, `report_agent_signal`, and `report_task_signal`, but stores nothing. For live and historical views alike, the monitor extracts the latest valid calls from every agent transcript and applies the shared signal normalizer. The latest session signal across all agents decorates the session header. An agent signal decorates only its reporting agent and may expose a bounded, one-line plain-text description as its tag tooltip. A task signal is resolved monitor-side against a normalized Bash tool-use or background-task ID and is exposed only when that execution task matches. Historical full-file signal scans are cached; raw target arguments, unmatched signals, tool results, and surrounding response content are never exposed.

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

### Provider flow and serialization boundary

The provider registry queries adapters independently and merges their allowlisted catalog summaries under opaque IDs such as `claude:session-id` and `codex:thread-id`. A provider failure contributes no rows but cannot fail another provider's catalog. Explicit browser IDs are parsed against the fixed provider namespace and safe local-ID grammar; they are never resolved as filesystem paths or routed to a different adapter.

For Codex, the adapter prefers an explicitly connected app-server for allowlisted thread metadata and canonical items. It never serializes thread previews or loaded turns directly. Persisted rollout headers and `session_index.jsonl` fill gaps and keep history available when the app-server is absent. Unknown record/item types, malformed JSONL lines, and a truncated final live write are ignored individually. A missing child rollout produces bounded neutral child metadata when the relationship is still documented elsewhere.

Provider evidence crosses into `monitor/server.mjs` only after raw prompts, answers, responses, reasoning, commands, patches, stdout, stderr, tool output, credentials, environment values, private transcript/auth paths, and unrecognized MCP arguments have been discarded. The monitor adds provider-neutral Git, pull-request, metric, and deterministic-rule data. `/api/state` and `/api/sessions` serialize only that normalized result; caught exceptions use fixed messages rather than arbitrary provider or filesystem error text. Browser reports are derived from the same state.

Codex selected-state polling parses each rollout once per read and reuses that record array for agent, activity, execution-task, context, approval/plan, signal, skill, and pull-request normalization. Live reads are capped at the final 512 KiB per rollout and cached by size and modification time. Historical reads may parse the complete persisted rollout once, then reuse the cache. Cache entries are bounded by the provider scan limit. Concurrent catalog polls share one in-flight app-server request and the 1.5-second catalog cache.

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
- One provider unavailable: sessions from other providers remain discoverable and selectable
- Codex app-server unavailable: rollout/index discovery and persisted history remain available
- Missing child rollout: keep only bounded relationship/runtime fallback metadata
- Git failure: repository unavailable without failing the session
- GitHub CLI or network failure: recorded pull-request links remain visible with unavailable live metadata, and branch association degrades independently
- Usage failure: expose a fixed provider-safe unavailable message while the remaining dashboard stays available
- Missing or deleted historical transcript: selected historical view explains that the session is no longer available and receives no current Git or usage data
- Malformed JSONL, unknown future record, or truncated final write: skip the individual record/line and retain other recognized evidence
- Synthetic or zero usage: exclude from latest-context selection
