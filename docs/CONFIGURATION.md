# Configuration and troubleshooting

Pomegr discovers Claude Code and Codex independently. One provider can be absent or fail without removing sessions from the other provider. The monitor remains read-only and binds to `127.0.0.1`; only the web dashboard binds to the LAN interface in development.

## Supported desktop modes

Pomegr desktop supports Windows x64 only. The per-user installer is the normal user path and requires neither administrator credentials, Node.js, Git, nor a repository checkout. Git and GitHub metadata degrade independently when their optional command-line tools are unavailable. macOS, Linux, Windows ARM64, app-store builds, and LAN access from the desktop app are not supported.

The portable beta runs without installation from a writable directory. It stores Pomegr-owned state in `PomegrData` beside its executable. Portable mode does not register launch at login and automatic updates are disabled; download and verify a newer portable artifact manually.

## Desktop settings and behavior

Open **Desktop controls** in the dashboard or use the tray menu to manage supported behavior:

- **Pause updates** pauses dashboard polling only. It does not pause or control coding agents and is not persisted.
- **Launch at login** is opt-in and available only for the installed app.
- **Close behavior** can ask each time, hide to the tray, or quit. Explicit **Quit Pomegr** and the tray **Quit** command stop all Pomegr-owned services.
- **Needs-input notifications** are enabled by default and can be disabled persistently. **Quiet for one hour** is temporary and clears when the app exits. Notifications use only the fixed generic Pomegr title and body; they never contain a session title, question, approval reason, command, response, tool output, or provider path.
- **Updates** are enabled by default for installed signed builds. Pomegr checks after startup and every four hours, silently downloads a higher same-channel release, and shows **Restart to update** at the bottom-left only after the installer is verified and ready. Clicking that action is the explicit installation confirmation. A failed check, download, signature verification, or install attempt leaves the current application runnable. Portable mode never checks for updates.

Closing to the tray leaves local observation running. Click the tray icon, use **Open Pomegr**, or launch Pomegr again to reopen the single existing instance.

## Desktop paths and privacy boundaries

Installed state is stored in Electron's per-user application-data directory for Pomegr (normally beneath `%APPDATA%`). `POMEGR_DATA_DIR` is an advanced override that redirects Pomegr-owned state when set before launch. Portable state is always `PomegrData` beside the portable executable.

Pomegr-owned storage is limited to versioned `settings.json`, bounded Claude cost snapshots, bounded Codex lifecycle snapshots, and reserved cache data. Settings allowlist only window geometry, close behavior, and launch-at-login, notification, and update booleans. Provider transcripts, indexes, tasks, credentials, repositories, `.claude`, and `.codex` stay in provider-owned locations and are never copied. Uninstall preserves Pomegr user data and never deletes provider data.

Reports are written only after the user clicks **Generate report** and selects a destination in the native save dialog. Pomegr keeps no implicit report archive.

## Provider setup

### Claude Code

No extra setup is required when Claude Code persists sessions under `%USERPROFILE%\.claude\projects`. The local session registry supplies the strongest live and needs-input evidence. When the registry provides an owner PID and process-start identity, Pomegr validates both monitor-side so orphaned registry files cannot keep exited sessions live; those owner fields are never exposed to the browser. `CLAUDE_PROJECTS_DIR` can select a different session root, and `CLAUDE_SESSION_FILE` can pin one synthetic or explicitly selected primary rollout.

Estimated API cost is optional. Wrap the Claude Code status line with `scripts/claude-statusline-bridge.mjs` to capture Claude Code's own client-side estimate. In `~/.claude/settings.json`, point `statusLine.command` at the bridge and pass the existing status-line command after `--`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<repo>/scripts/claude-statusline-bridge.mjs\" -- <existing status-line command>"
  }
}
```

The bridge forwards stdin to the delegated command unchanged, so the visible status line keeps working. It persists only the normalized session ID, non-negative USD amount, estimate type, and observation time. Replacing `statusLine.command` with a direct script call silently stops cost capture, so keep the bridge as the outermost command.

### Codex

No extra setup is required for persisted history under `%USERPROFILE%\.codex`. `CODEX_HOME` can select a different Codex root. Pomegr reads bounded rollout metadata and `session_index.jsonl`; it does not read Codex private SQLite tables.

To display current Codex usage limits, install a supported native Codex CLI and sign it in with the account whose limits should be shown. Pomegr starts a short-lived, account-only `codex app-server --stdio` reader at most once every five minutes; it requests only the rate-limit snapshot and exits immediately. It never uses that transient process for session discovery, cataloging, liveness, or turn data. Set `POMEGR_CODEX_EXECUTABLE` to an absolute native CLI path when automatic discovery cannot find the CLI. A missing or unsupported CLI disables and hides only the usage-limit panel. A valid CLI with signed-out, API-key-only, or temporarily failing account access retains the capability but produces the fixed sanitized unavailable state.

For higher-confidence Windows live state, register this inert hook command for the supported Codex lifecycle events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `SessionEnd`, and supported subagent transitions):

```powershell
node "C:\path\to\pomegr\scripts\codex-lifecycle-bridge.mjs"
```

Codex hook configuration varies by installed surface and version; use the provider's documented hook configuration to invoke that command and pass the hook JSON on stdin. The bridge always writes `{}` to stdout, adds no model context, makes no decision, and atomically persists only allowlisted lifecycle metadata. On Windows, the default snapshot root is `%APPDATA%\pomegr\codex-liveness`. Set `POMEGR_CODEX_LIVENESS_DIR` in both the hook environment and the Pomegr monitor only when a shared override is needed.

An authenticated connection to the app-server process that owns a Codex thread is the highest-confidence source for live status. The standalone Windows monitor does not attempt to discover or attach to another process's private stdio transport. Its transient account-only usage reader is not an owning app-server and is never used as live-state evidence. Without an owning connection it uses the lifecycle bridge, then a bounded and explicitly heuristic rollout fallback.

## Capability availability

This matrix is generated from the same explicit manifests enforced for every provider adapter. Runtime readiness and the presence of evidence in one session are separate: “Supported” does not imply that an optional executable is installed or that every session contains the evidence.

<!-- provider-capabilities:start -->
| Capability | Normalized evidence | Claude Code | Codex |
| --- | --- | --- | --- |
| Approval mode | `session.approvalMode` | Supported | Supported |
| Automatic compactions | `compactions` | Supported | Supported |
| Context machinery | `session.contextMachinery` | Supported | Unsupported — Codex session evidence does not expose normalized context-machinery categories. |
| Estimated cost | `session.cost` | Supported | Unsupported — Codex session evidence does not expose a provider cost estimate. |
| Live sessions | `catalog.isLive` | Supported | Supported |
| Needs-input state | `catalog.needsInput` | Supported | Supported |
| Plan tasks | `planTasks` | Supported | Supported |
| Cache-write usage | `usageSnapshots.cacheWrite` | Supported | Unsupported — Codex usage evidence does not provide normalized cache-write tokens. |
| Cache usage classification | `usageSnapshots.cacheComparable` | Supported | Unsupported — Codex usage evidence cannot safely classify cache-write behavior. |
| Session summary | `session.summary` | Supported | Unsupported — Codex session evidence does not expose a bounded provider session summary. |
| Agent-reported signals | `session.signal` | Supported | Supported |
| Usage limits | `usageLimits` | Supported | Supported |
| Workflows | `workflows` | Supported | Unsupported — Codex does not expose the structured workflow artifacts required by the normalized workflow contract. |
<!-- provider-capabilities:end -->

Unavailable features are capability-gated and omitted. A missing value is not rendered as zero.

## Environment variables

| Variable | Used by | Purpose | Default |
| --- | --- | --- | --- |
| `CLAUDE_PROJECTS_DIR` | Monitor | Claude project/session root | `%USERPROFILE%\.claude\projects` |
| `CLAUDE_SESSION_FILE` | Monitor | Pin one Claude primary JSONL session | Automatic selection |
| `CODEX_HOME` | Monitor | Codex sessions, archive, and index root | `%USERPROFILE%\.codex` |
| `POMEGR_CODEX_EXECUTABLE` | Monitor | Absolute path to a supported native Codex CLI for account-only limit reads | Native CLI discovered on `PATH` or the official npm installation |
| `POMEGR_DATA_DIR` | Desktop, monitor, and local bridges | Override Pomegr-owned settings/snapshot root | `%APPDATA%\pomegr` on Windows |
| `POMEGR_CODEX_LIVENESS_DIR` | Monitor and Codex hook bridge | Shared allowlisted lifecycle snapshot root | `%APPDATA%\pomegr\codex-liveness` on Windows |
| `POMEGR_CODEX_OWNER_PID` | Codex hook bridge | Explicit owner PID for unusual process-wrapper topologies | Automatic owner discovery |
| `POMEGR_COST_SNAPSHOTS_DIR` | Monitor and Claude status-line bridge | Sanitized Claude estimate snapshots | `%APPDATA%\pomegr\cost-snapshots` on Windows |
| `SESSION_PULSE_PORT` | Monitor and development launcher | Loopback monitor port | `4317` |

Do not point provider roots at a browser-served directory. Do not place OAuth tokens, auth-file contents, transcripts, or environment dumps in Pomegr configuration.

## Agent display roles

Pomegr exposes a bounded display `role` for each agent, not a provider-native agent type. The primary agent is always `orchestrator`; other roles resolve in this order: repository mapping, built-in exact type, documented keyword rule, verified workflow association, then `unknown`. This is display normalization applied whenever a session is read, including history; it is not recorded session state or an authoritative assessment of an agent.

To customize recognized local agent types, optionally commit `.pomegr/roles.json`:

```json
{
  "version": 1,
  "roles": {
    "cavecrew-builder": "builder"
  }
}
```

Keys must already be normalized: lowercase, the text after the final `:`, and separators folded to `-`. The file is capped at 16 KiB and 64 mappings, keys at 64 characters, and values must be one of Pomegr's built-in roles. Extra top-level fields, an unsupported version, or malformed JSON ignore the entire file; invalid individual mapping rows are skipped. Validate it read-only with `node monitor/agent-roles.mjs validate --cwd .` or `/pomegr:doctor`. Mapping contents never enter the browser API or generated reports.

To share Claude cost or Codex lifecycle snapshots with a portable build, set `POMEGR_DATA_DIR` to that portable `PomegrData` directory in the external bridge environment as well as when launching Pomegr; the specific snapshot-root variables remain available when only one bridge root should move.

## Troubleshooting

### The desktop app does not open

- Confirm the downloaded artifact is the Windows x64 build, its SHA-256 matches `SHA256SUMS.txt`, and its Authenticode signature is valid and timestamped for the expected complete publisher Subject.
- Quit any existing tray instance before retrying. A second launch focuses the existing window instead of starting another service set.
- If a fixed Pomegr startup-error page appears, restart once and record only its bounded diagnostic code. Do not publish environment dumps, private paths, transcripts, credentials, or screenshots containing session data.
- Installed and portable builds do not require system Node.js. Missing Git affects repository enrichment only and must not prevent startup.

### The window disappeared after I closed it

The selected close behavior may hide Pomegr to the system tray. Reopen it from the tray or launch Pomegr again. Change **Close behavior** under **Desktop controls** if you prefer explicit quit. Use the tray **Quit** command to stop all owned services.

### Notifications do not appear

- Confirm **Needs-input notifications** is enabled and temporary quiet mode is off.
- Pomegr notifies only on a transition into a recognized live needs-input state; it deduplicates repeated observations until the state clears.
- Windows notification settings or Focus Assist can suppress native presentation. Pomegr monitoring continues if notification delivery fails.
- Notification clicks navigate to an observation view only. Pomegr cannot approve, answer, resume, or control an agent.

### Updates are unavailable

- Automatic updates require an installed, signed release with updates enabled and network access to the official release endpoint. Portable builds intentionally disable them.
- The update action appears only after the signed installer finishes downloading and verification succeeds; checking and downloading do not interrupt the dashboard.
- Stable and beta channels never cross. Publish or install a monotonically higher version on the same channel.
- A failed or rejected update leaves the current installation runnable. Never bypass publisher checks or replace updater metadata manually; use a newer correctly signed release.
- See `docs/DESKTOP_RELEASES.md` for signature, publisher, checksum, and rollback policy.

### Another device cannot open the dashboard

This is expected in the desktop app: both services bind to dynamic `127.0.0.1` ports and LAN sharing is unavailable. The `0.0.0.0:3003` LAN binding exists only in the source-development workflow.

### No sessions appear

- Confirm the provider has created persisted JSONL history under its default root, or set the matching root override before `npm run dev`.
- Remove `CLAUDE_SESSION_FILE` if it points to a deleted file.
- Confirm the session ID contains only letters, digits, `.`, `_`, or `-`; browser parameters are opaque provider-qualified IDs such as `codex:thread-id`, never paths.
- Check `http://127.0.0.1:4317/health` on the host. The monitor should return HTTP 204.

### Codex appears historical while it is open

- An owning app-server reports only threads loaded by that same process. A newly spawned app-server is not global live-state truth on Windows.
- Confirm the lifecycle hook invokes `scripts/codex-lifecycle-bridge.mjs`, shares `POMEGR_CODEX_LIVENESS_DIR` with the monitor, and can write that directory.
- If hooks are unavailable, rollout-only live state expires after 120 seconds. This is expected heuristic behavior, not an operating-system process claim.
- `POMEGR_CODEX_OWNER_PID` is only for wrapper topologies where automatic ancestry selection cannot identify the owning Codex or ChatGPT process. A stale or unrelated PID will not produce a valid lease.

### Needs-input is stale or missing

- Bridge needs-input clears on the matching result/progress event, session stop, owner-lease expiry, or a 30-minute safety limit.
- Rollout-only requests expire after 120 seconds and approval waits are unsupported without bridge or owning app-server evidence.
- Questions, choices, answers, approval reasons, and commands are intentionally unavailable in diagnostics and browser state.

### Usage limits are unavailable

- Historical views always omit current usage limits.
- Claude failures can indicate missing/expired provider authentication or provider cooldown; the browser receives only a sanitized error.
- Codex limits require a supported native Codex CLI authenticated with ChatGPT. Set `POMEGR_CODEX_EXECUTABLE` to an absolute native executable if automatic discovery cannot find it; Pomegr does not attach to an existing desktop or CLI stdio transport. If no valid CLI is found, only the usage-limit panel is hidden. Authentication or temporary read failures keep the panel available with a fixed sanitized unavailable state.
- Concurrent tabs share one in-flight request and a five-minute cooldown, so repeated refreshes do not force another provider call.

### Git or GitHub metadata is unavailable

- Confirm Git is on `PATH` and the selected live session's recorded working directory still exists.
- Historical views intentionally show only the recorded branch and never the current working tree.
- Git, GitHub CLI, and network failures degrade independently from provider session parsing. Pomegr does not fall back to stale remote-tracking data.

### A session was deleted

Deleted provider history returns a safe historical missing-session state and disappears from the next catalog refresh. Pomegr does not retain a transcript copy or substitute current Git and usage-limit data.
