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

Markdown retrospective reports are assembled from the same normalized state. Report generation performs one fresh local-state read, does not call a model, and does not request the provider usage endpoint. Browser development uses a normal download; desktop uses a narrow IPC method that accepts only a bounded Threadlight Markdown report and opens the operating-system save dialog after the user clicks **Generate report**.

### Development orchestrator

`scripts/dev.mjs` starts both long-running processes. The web process binds to `0.0.0.0:3003` for local-network viewing.

### Desktop runtime compatibility boundary

The accepted TL-DT-02 Windows compatibility runtime uses Electron's bundled Node.js environment; it does not launch or require a system `node.exe` for the monitor or production web server. Electron `utilityProcess` was evaluated first, but on the supported Windows test host Chromium terminated the browser process with native breakpoint status `0x80000003` immediately after the utility spawned and before its entry module evaluated. Launching a second Electron executable in bundled-Node mode reached the same host breakpoint, while disabling Chromium's sandbox globally is not an acceptable runtime dependency. Creating a second Node worker hit the same host boundary. TL-DT-03 re-evaluated the fallback and retained the credential-owning monitor in the sole Node worker while hosting only the provider-neutral production web lifecycle in Electron main. The monitor worker now executes a bounded `git --version` probe before reporting ready, so the packaged smoke explicitly verifies that Git child-process creation is stable inside the privacy-owning service boundary. Main never receives repository paths, Git results, transcript content, or provider schemas.

Electron main and its monitor worker receive a strict keep-only runtime environment containing the filtered executable path, Windows runtime fields, temporary directories, and locale fields. Every `PATH` directory containing `node.exe` is removed, and main asserts the same guard before importing web code. The compatibility smoke writes provider roots and home/profile locations to an allowlisted monitor-only snapshot; the production shell passes the same allowlist directly as monitor worker data and drops its local reference after worker creation. Before main imports the web server, it strips its environment again and adds only the monitor origin and ephemeral monitor token. The production web graph has no monitor/provider import and receives no transcript path, provider credential, PAT, API key, or SSH agent socket. Service modules resolve from the application resource path rather than the launch working directory.

The smoke retains its main-process `git --version` path-compatibility probe and separately requires the monitor worker's pre-readiness Git probe. Both use `execFile` with fixed argument arrays, a timeout, and hidden windows. The monitor remains the sole owner of repository selection, repository paths, optional `gh` execution, and Git result normalization.

Electron 43.3.0 is the accepted development runtime. The final TL-DT-03 packaged smoke passed from normal PowerShell with the strict keep-only environment, system-Node-free path, monitor-only provider snapshot, physical Vinext output root, launch-token gates, and hidden sandboxed dashboard window described above.

`npm run desktop:smoke` is the acceptance gate for this structure. Its launcher runs with Electron's bundled Node environment, creates a temporary real `app.asar`/`app.asar.unpacked` resource layout, and starts that archive with hardware acceleration and GPU processes disabled, error dialogs suppressed, and profile/crash/log state isolated to the temporary fixture. Lifecycle shutdown escalates through bounded graceful close and worker termination while awaiting exit, then closes the in-main web listener. A behavioral lifecycle test exercises the forced-cleanup path without deliberately crashing a live runtime before the production services start. The gate covers ESM loading, the self-contained monitor bundle, filesystem reads through the ASAR resource root, the native Sharp runtime, built-in `fetch`, filtered-path Git execution with argument arrays, provider discovery through the normalized sessions endpoint, dynamic loopback listeners, and awaited shutdown. It also creates a hidden production-configured `BrowserWindow`, loads the dashboard through the launch-token gate, and verifies that the renderer has neither `process` nor `require`. It creates no tray, updater, or installer, and a successful run must leave no Electron process or temporary fixture.

The accepted ASAR boundary is deliberately minimal for the APIs in use: unbundled source and runtime packages remain inside `app.asar`. Electron workers hit the host breakpoint when their ESM loader imported modules directly from ASAR, so the smoke build uses Vite's Node SSR bundler to emit one self-contained physical CommonJS monitor bundle at `desktop/workers/monitor-host.cjs` (`ssr.noExternal: true`, code splitting disabled). Vinext dynamically imports its server entry and expects the server, client, static assets, and manifests beneath one `outDir`; the complete generated `dist/` tree is therefore unpacked and supplied as that physical root. The production dependency graph includes Sharp, so `libvips-42.dll`, `libvips-cpp-8.17.3.dll`, and `sharp-win32-x64.node` under `node_modules/@img/sharp-win32-x64/lib/` are unpacked because native loading requires real filesystem paths. A focused ASAR test derives the current generated `dist/` file list, compares it to the archive header, and verifies every expected physical file, preventing unrelated files from drifting into the boundary. Threadlight owns no other native addon or executable that needs unpacking. Electron itself remains outside `app.asar` as part of the packaged runtime. System `git.exe` and optional `gh.exe` are invoked in place and are not copied into application resources. If a future packaged dependency requires another real filesystem path, only that dependency's exact runtime files may move to `app.asar.unpacked`, with a new smoke assertion and documented reason.

Provider transcripts, credentials, provider-owned configuration, Git repositories, and Threadlight user state are never application resources and must never be copied into `app.asar` or `app.asar.unpacked`. This compatibility proof reads provider records only through the existing monitor/provider boundary and returns only the normalized session catalog.

### Desktop shell security boundary

The Electron shell requests the single-instance lock before starting services. It starts the monitor worker first, waits for its bounded readiness message, starts the loopback production web server with the monitor origin, and creates the dashboard window only after both services are ready. Both listeners use operating-system-assigned loopback ports. A random per-launch token is passed only to the monitor worker and provider-neutral web runtime; the monitor and desktop web listener reject requests without the token, while Electron injects it into requests for the exact dashboard origin. Host, Origin, and read-only method checks provide additional local-request boundaries. Development startup remains token-optional and retains its existing browser behavior.

The dashboard window uses a minimal preload, renderer sandboxing and context isolation, with Node integration, worker/subframe Node integration, webviews, insecure content, and experimental renderer features disabled. Permission checks and requests, device access, Chromium downloads, webview attachment, unexpected navigation, redirects, and new windows are denied. Only the Threadlight source and license paths under the fixed project GitHub URL may open in the external browser. The desktop response carries a restrictive same-origin CSP and frame, referrer, opener, and content-type protections. The only renderer IPC method is `saveReport`: main validates the exact local sender origin, a generated filename grammar, a fixed report header, exact request keys, and a 2 MiB UTF-8 limit before showing the native save dialog. The renderer never receives filesystem paths or arbitrary Electron, filesystem, process, or environment access.

### Desktop installed and portable paths

Electron main resolves application code from `app.getAppPath()`, physical unpacked runtime files from the corresponding `app.asar.unpacked`, packaged resources from `process.resourcesPath`, and user state from `app.getPath("userData")`; none depends on the launch working directory. When electron-builder supplies `PORTABLE_EXECUTABLE_DIR`, main redirects Electron user data and Threadlight-owned state to `ThreadlightData` beside the portable executable before acquiring the single-instance lock. `THREADLIGHT_DATA_DIR` applies the same early user-data redirect as an explicit advanced override when portable mode is not active.

Threadlight-owned storage is limited to `settings.json`, bounded Claude estimate snapshots, bounded Codex lifecycle snapshots, and a reserved cache directory under that data root. On Windows, bridges and non-desktop monitor startup resolve their shared default root to `%APPDATA%\threadlight`; the specific `THREADLIGHT_COST_SNAPSHOTS_DIR` and `THREADLIGHT_CODEX_LIVENESS_DIR` overrides still take precedence. Provider transcripts, indexes, task records, credentials, and repositories remain in provider-owned `%USERPROFILE%\.claude`, `%USERPROFILE%\.codex`, or their explicit provider overrides and are never copied into Threadlight storage.

Desktop settings are a versioned allowlist containing only bounded window position/size/maximized state and booleans for launch at login, notifications, and updates. Unknown fields are discarded during a valid load and save; credentials, OAuth data, provider paths, transcripts, prompts, responses, commands, and tool content cannot be serialized by the settings store. A missing file may be created normally, but malformed, schema-invalid, transiently unreadable, and newer-version files use a non-persistable fallback so window close cannot overwrite them. Explicit recovery is allowed only for malformed/schema-invalid or newer-version files and must rename the original to a quarantine file before writing normalized defaults. Reports are saved only after the user chooses a destination in the native dialog; Threadlight does not maintain an implicit report archive.

Owned services are supervised for unexpected exit and stopped in bounded order on failure or application quit. Startup and runtime failures show only a fixed local page and `DESKTOP_START_FAILED`; arbitrary exception text, service output, environment values, provider paths, and credentials are neither rendered nor logged.

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

The bridge entry point is `scripts/codex-lifecycle-bridge.mjs`. It consumes Codex hook JSON but atomically persists only the allowlisted session/turn/agent IDs, lifecycle enum, request kind, timestamps, sequence, and monitor-local owner identity. On Windows it walks the hook command's process ancestry using process IDs, names, and creation times only, then binds the lease to the nearest allowlisted Codex/ChatGPT owner; none of the discovery fields beyond PID and creation time are persisted. A detached `scripts/codex-lifecycle-owner.mjs` process renews one shared 45-second PID-plus-process-start lease every 15 seconds. It produces no decision or model context. Snapshots and leases default to `%APPDATA%\threadlight\codex-liveness` on Windows and `~/.threadlight/codex-liveness` elsewhere; `THREADLIGHT_DATA_DIR` can move the shared Threadlight root and `THREADLIGHT_CODEX_LIVENESS_DIR` remains the more specific override used by both bridge and monitor. `THREADLIGHT_CODEX_OWNER_PID` can explicitly select the owner for an unusual command-wrapper topology.

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
