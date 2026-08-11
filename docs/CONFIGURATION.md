# Configuration and troubleshooting

Threadlight discovers Claude Code and Codex independently. One provider can be absent or fail without removing sessions from the other provider. The monitor remains read-only and binds to `127.0.0.1`; only the web dashboard binds to the LAN interface in development.

## Provider setup

### Claude Code

No extra setup is required when Claude Code persists sessions under `%USERPROFILE%\.claude\projects`. The local session registry supplies the strongest live and needs-input evidence. `CLAUDE_PROJECTS_DIR` can select a different session root, and `CLAUDE_SESSION_FILE` can pin one synthetic or explicitly selected primary rollout.

Estimated API cost is optional. Configure `scripts/claude-statusline-bridge.mjs` as described in the README to capture Claude Code's own client-side estimate. The bridge persists only normalized session ID, non-negative USD amount, estimate type, and observation time.

### Codex

No extra setup is required for persisted history under `%USERPROFILE%\.codex`. `CODEX_HOME` can select a different Codex root. Threadlight reads bounded rollout metadata and `session_index.jsonl`; it does not read Codex private SQLite tables.

For higher-confidence Windows live state, register this inert hook command for the supported Codex lifecycle events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `SessionEnd`, and supported subagent transitions):

```powershell
node "C:\path\to\threadlight\scripts\codex-lifecycle-bridge.mjs"
```

Codex hook configuration varies by installed surface and version; use the provider's documented hook configuration to invoke that command and pass the hook JSON on stdin. The bridge always writes `{}` to stdout, adds no model context, makes no decision, and atomically persists only allowlisted lifecycle metadata. The default snapshot root is `%USERPROFILE%\.threadlight\codex-liveness`. Set `THREADLIGHT_CODEX_LIVENESS_DIR` in both the hook environment and the Threadlight monitor only when a shared override is needed.

An authenticated connection to the app-server process that owns a Codex thread is the highest-confidence source for live status and account rate limits. The standalone Windows monitor does not attempt to discover or attach to another process's private stdio transport. Without that connection it uses the lifecycle bridge, then a bounded and explicitly heuristic rollout fallback.

## Capability availability

| Capability | Claude Code | Codex |
| --- | --- | --- |
| Catalog and persisted history | Supported | Supported |
| Agent tree, activity, execution tasks, skills, signals, and PR creation evidence | Supported | Supported for recognized records |
| Latest context snapshot | Supported | Supported from `last_token_usage` only |
| Live and needs-input state | Registry-backed with transcript fallback | Owning app-server or lifecycle bridge; rollout fallback is heuristic |
| Approval mode | Supported | Supported for recognized policies |
| Structured plan checklist | Supported | Best effort; no natural-language plan inference |
| Usage-limit windows | Supported with provider authentication | Supported only through an owning app-server connection |
| Automatic-compaction warning | Supported for explicit automatic records | Best effort; requires an explicit automatic trigger |
| Estimated API cost | Optional Claude status-line estimate | Unavailable |
| Context-machinery snapshot | Optional recorded Claude `/context` output | Unavailable |
| Provider-generated session summary | Supported for recognized records | Unavailable |

Unavailable features are capability-gated and omitted. A missing value is not rendered as zero.

## Environment variables

| Variable | Used by | Purpose | Default |
| --- | --- | --- | --- |
| `CLAUDE_PROJECTS_DIR` | Monitor | Claude project/session root | `%USERPROFILE%\.claude\projects` |
| `CLAUDE_SESSION_FILE` | Monitor | Pin one Claude primary JSONL session | Automatic selection |
| `CODEX_HOME` | Monitor | Codex sessions, archive, and index root | `%USERPROFILE%\.codex` |
| `THREADLIGHT_CODEX_LIVENESS_DIR` | Monitor and Codex hook bridge | Shared allowlisted lifecycle snapshot root | `%USERPROFILE%\.threadlight\codex-liveness` |
| `THREADLIGHT_CODEX_OWNER_PID` | Codex hook bridge | Explicit owner PID for unusual process-wrapper topologies | Automatic owner discovery |
| `THREADLIGHT_COST_SNAPSHOTS_DIR` | Monitor and Claude status-line bridge | Sanitized Claude estimate snapshots | `%USERPROFILE%\.threadlight\cost-snapshots` |
| `SESSION_PULSE_PORT` | Monitor and development launcher | Loopback monitor port | `4317` |

Do not point provider roots at a browser-served directory. Do not place OAuth tokens, auth-file contents, transcripts, or environment dumps in Threadlight configuration.

## Troubleshooting

### No sessions appear

- Confirm the provider has created persisted JSONL history under its default root, or set the matching root override before `npm run dev`.
- Remove `CLAUDE_SESSION_FILE` if it points to a deleted file.
- Confirm the session ID contains only letters, digits, `.`, `_`, or `-`; browser parameters are opaque provider-qualified IDs such as `codex:thread-id`, never paths.
- Check `http://127.0.0.1:4317/health` on the host. The monitor should return HTTP 204.

### Codex appears historical while it is open

- An owning app-server reports only threads loaded by that same process. A newly spawned app-server is not global live-state truth on Windows.
- Confirm the lifecycle hook invokes `scripts/codex-lifecycle-bridge.mjs`, shares `THREADLIGHT_CODEX_LIVENESS_DIR` with the monitor, and can write that directory.
- If hooks are unavailable, rollout-only live state expires after 120 seconds. This is expected heuristic behavior, not an operating-system process claim.
- `THREADLIGHT_CODEX_OWNER_PID` is only for wrapper topologies where automatic ancestry selection cannot identify the owning Codex or ChatGPT process. A stale or unrelated PID will not produce a valid lease.

### Needs-input is stale or missing

- Bridge needs-input clears on the matching result/progress event, session stop, owner-lease expiry, or a 30-minute safety limit.
- Rollout-only requests expire after 120 seconds and approval waits are unsupported without bridge or owning app-server evidence.
- Questions, choices, answers, approval reasons, and commands are intentionally unavailable in diagnostics and browser state.

### Usage limits are unavailable

- Historical views always omit current usage limits.
- Claude failures can indicate missing/expired provider authentication or provider cooldown; the browser receives only a sanitized error.
- Codex limits require an explicitly connected owning app-server. The default standalone Windows process cannot attach to a private desktop/CLI transport.
- Concurrent tabs share one in-flight request and a five-minute cooldown, so repeated refreshes do not force another provider call.

### Git or GitHub metadata is unavailable

- Confirm Git is on `PATH` and the selected live session's recorded working directory still exists.
- Historical views intentionally show only the recorded branch and never the current working tree.
- Git, GitHub CLI, and network failures degrade independently from provider session parsing. Threadlight does not fall back to stale remote-tracking data.

### A session was deleted

Deleted provider history returns a safe historical missing-session state and disappears from the next catalog refresh. Threadlight does not retain a transcript copy or substitute current Git and usage-limit data.
