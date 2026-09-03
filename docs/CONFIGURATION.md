# Configuration and troubleshooting

Pomegr discovers Claude Code and Codex independently. One provider can be absent or fail without removing sessions from the other provider. The monitor remains read-only and binds to `127.0.0.1`. Development exposes the web dashboard on the LAN; the Windows desktop app offers separate, opt-in phone access.

Operational cache tiers, checkpoint rules, readiness states, and frontend refresh cadence
are defined canonically in [Observation cache and progressive readiness](OBSERVATION_CACHE.md).

## Supported desktop modes

Pomegr desktop supports Windows x64 only. The per-user installer is the normal user path and requires neither administrator credentials, Node.js, Git, nor a repository checkout. Git and GitHub metadata degrade independently when their optional command-line tools are unavailable. macOS, Linux, Windows ARM64, and app-store builds are not supported. Optional phone access shares the dashboard with paired browsers on a trusted local network; see the phone-access instructions below.

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

Pomegr-owned storage is limited to versioned `settings.json`, bounded Claude cost, local usage, and normalized account-usage snapshots, bounded Codex lifecycle snapshots, and bounded normalized observation checkpoints under `observation-cache-v1`. Checkpoints contain only contract-validated normalized evidence, readiness, revision metadata, and bounded source compatibility metadata; raw provider records and incomplete record fragments are never copied. Settings allowlist only window geometry, close behavior, display preferences, and launch-at-login, notification, update, and phone-sharing startup booleans. Phone authorizations and network discovery results are never persisted. Provider transcripts, indexes, tasks, credentials, repositories, `.claude`, and `.codex` stay in provider-owned locations and are never copied. Uninstall preserves Pomegr user data and never deletes provider data.

Reports are written only after the user clicks **Generate report** and selects a destination in the native save dialog. Pomegr keeps no implicit report archive.

## Provider setup

### Claude Code

No extra setup is required when Claude Code persists sessions under `%USERPROFILE%\.claude\projects`. The local session registry supplies the strongest live and needs-input evidence. When the registry provides an owner PID and process-start identity, Pomegr validates both monitor-side so orphaned registry files cannot keep exited sessions live; those owner fields are never exposed to the browser. `CLAUDE_PROJECTS_DIR` can select a different session root, and `CLAUDE_SESSION_FILE` can pin one synthetic or explicitly selected primary rollout.

Claude Remote Control launches `sdk-cli` sessions whose local registry can omit execution status. For these sessions, Pomegr reads the native session metadata API using the existing Claude OAuth access token, only after validating the local process owner and registry bridge association. It maps explicit `running`, `requires_action`, and `idle` primary-loop states. The session additionally remains Working while provider-recorded background workflow or shell launches have neither a matching terminal notification nor a completed workflow manifest in the current validated process lifetime. It does not guess from transcript age or agent counts. No extra hook, worker attachment, or remote session discovery is performed. Missing credentials or an unsupported response leave status unknown until a valid observation arrives; temporary failures retain the last valid status for the same owner. Pomegr does not refresh credentials: sign in through Claude Code if account access has expired. The [Claude session-status contract](CLAUDE_SESSION_STATUS.md) documents request bounds, authentication, and privacy.

Estimated API cost is optional. Wrap the Claude Code status line with `scripts/claude-statusline-bridge.mjs` to capture Claude Code's own client-side estimate. In `~/.claude/settings.json`, point `statusLine.command` at the bridge and pass the existing status-line command after `--`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<repo>/scripts/claude-statusline-bridge.mjs\" -- <existing status-line command>"
  }
}
```

The bridge forwards bounded stdin to the delegated command unchanged, so the visible status line keeps working. Cost storage contains only the normalized session ID, non-negative USD amount, estimate type, and observation time. A separate usage snapshot contains only the two normalized usage windows described below. Replacing `statusLine.command` with a direct script call stops these captures, so keep the bridge as the outermost command.

#### Claude local usage feed

A failed usage check automatically expands **Usage connection help** under
**Usage limits → Claude Code**, even when retained usage figures remain available.
Authentication failures and missing credentials show browser users the manual
`claude auth login --claudeai` command to run on the computer hosting Pomegr;
desktop users can select **Reconnect Claude Code**. Throttled checks explain the
provider cooldown, while other failures suggest checking connectivity and sign-in.
Loading and successful checks do not show troubleshooting. The installed Windows app
also offers **Enable local usage** when usage is unavailable and setup is supported.
The native confirmation explains that Pomegr will update the current Claude Code profile's
status-line setting. Setup preserves the existing command and other status-line settings;
malformed or concurrently edited settings are refused. No sign-in or model request runs
during setup. The bundled bridge uses Pomegr's own runtime, so a separate Node installation
is not needed. Automatic setup is unavailable in the portable app because its extracted
runtime path is temporary.

Claude Code reports five-hour and seven-day percentages and reset times through its
status line. The documented subscription support is Pro and Max, after the first API
response in a supported session. See the [Claude status-line documentation](https://code.claude.com/docs/en/statusline#rate-limit-usage).
Project or managed settings can override the user status line; enabling the user setting
does not override those policies. If no usage arrives, check Claude Code's status-line
and workspace-trust configuration.

Browser-only installations can use the script configuration above with an installed Node
runtime. Pass the existing executable and its arguments after `--`; shell expressions
need an explicit shell executable and its arguments. With no existing status line, omit
`--` and the delegate. Use forward slashes in Windows paths. Both the monitor and bridge
must use the same `POMEGR_USAGE_SNAPSHOTS_DIR` (or the same `POMEGR_DATA_DIR`). This feed
represents the Claude profile connected to that bridge; use separate roots for separate
accounts/profiles rather than combining their observations.

Pomegr reads the local snapshot in its background usage job. A recent valid local pair
is immediately available while the existing account check updates model-specific limits.
Account checks retain their five-minute cooldown and provider retry delays. Failed
checks preserve the last good values. **Last observed** identifies locally reported
figures; stale data is explicitly labelled and must not be treated as current usage.
Repeated identical status-line values retain their original observation timestamp.

The local feed does not include Fable's model-specific weekly limit. Pomegr keeps its
last API reading separately, labelled **Last API value** with its own timestamp. If none
was observed or safely restored, Fable shows **Checking…** while the first account
check runs, then its value or the check's failure status. The initial result normally
appears within a minute. Keeping
this column visible uses the existing shared account-check cadence.

Pomegr retains the last normalized account reading and its retry deadline across restarts
in a separate `usage-snapshots/claude-api.json` file. A restored Fable reading keeps its
original **Last API value** timestamp; it is not presented as a fresh account check.
The cache contains only allowlisted usage fields and an opaque fingerprint of the selected
credential file's filesystem metadata, never credential contents or account identifiers.
It is reused only while that credential source matches. Changing profiles, signing in again,
or Claude refreshing the credential file invalidates it. A provider throttle still has to
expire before Pomegr can fetch a new value; no value is invented before a successful reading.

The usage file is `usage-snapshots/claude.json` beneath Pomegr's data root. It contains
only the schema version, observation time, and two percentage/reset pairs. It has no
account, session, transcript, prompt, response, token, or credential data. To stop capture,
restore your previous Claude Code status-line command in that profile's settings.

#### Reconnect Claude Code

When a usage check rejects saved access, select **Reconnect Claude Code** and confirm in
the native dialog. Pomegr launches the installed native CLI's
`claude auth login --claudeai` flow; Claude Code owns the browser approval and credentials.
The action can change the signed-in Claude Code account. It is never launched by polling,
and it makes no model request. The UI receives only a fixed outcome such as completed,
cancelled, unavailable, failed, or timed out. Pomegr retries usage on its normal background
cadence after sign-in; it does not bypass provider cooldowns.

Native executable discovery checks the standard `.local/bin/claude.exe` installation and
absolute PATH entries. Set `POMEGR_CLAUDE_EXECUTABLE` before launching Pomegr for a custom
native installation. `CLAUDE_CONFIG_DIR` selects the profile used for sign-in, local-feed
setup, and usage credential reads. Neither action is available through HTTP or from the
LAN dashboard. If a browser callback cannot finish, use Claude Code's own command-line
prompts on the monitor computer. No credentials or auth URLs are copied into Pomegr.

### Codex

No extra setup is required for persisted history under `%USERPROFILE%\.codex`. `CODEX_HOME` can select a different Codex root. Pomegr reads bounded rollout metadata and `session_index.jsonl`; it does not read Codex private SQLite tables.

To display current Codex usage limits, install a supported native Codex CLI and sign it in with the account whose limits should be shown. Pomegr starts a short-lived, account-only `codex app-server --stdio` reader at most once every five minutes; it requests only the rate-limit snapshot and exits immediately. It never uses that transient process for session discovery, cataloging, liveness, or turn data. Set `POMEGR_CODEX_EXECUTABLE` to an absolute native CLI path when automatic discovery cannot find the CLI. A missing or unsupported CLI disables session-level usage capability, while the Usage limits page shows **Codex CLI required for usage limits** with expanded **Usage connection help**. A valid CLI with signed-out, API-key-only, or temporarily failing account access retains the capability and shows troubleshooting beside a sanitized failure. Retained readings do not hide help.

#### Codex usage troubleshooting

On the computer running Pomegr:

1. Install or update the native Codex CLI using the [official installation guide](https://learn.chatgpt.com/docs/codex/cli#get-started-with-codex-cli). For Windows Pomegr, use a Windows-native CLI installation.
2. Run `codex login` and sign in with ChatGPT. `codex login status` reports the active authentication mode; API-key-only access does not supply the ChatGPT account windows used here. These commands are documented in the [official CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-login).
3. Fully quit and reopen Pomegr after installing or updating the CLI, because executable detection is cached for the monitor process. Merely closing to the tray does not restart detection.

If the CLI is already installed but undetected, use the absolute native executable override above. If it is already signed in with ChatGPT, check connectivity and allow the normal retry interval. A missing CLI is an unavailable setup state, not a pending account request; the dashboard settles to its normal polling cadence. Reading Codex desktop session history does not require this CLI and cannot establish account-usage access. Pomegr only displays these instructions; it does not install Codex, launch sign-in, or expose credentials through the browser.

On Windows, the monitor can keep a current Codex CLI session **Live** when the native writer ownership checks pass: stable writer identity, a unique file user, the exact native executable, and matching process-start identity. This is runtime presence, not execution state. Recorded turn starts and terminal records determine execution; an incomplete or ambiguous turn remains unknown/stale. Unix does not claim native lock ownership without validated platform semantics. An explicitly connected owning app-server is supported on any platform; the separate account-only usage reader is never used as live-state evidence.

An owner-retained idle session may remain `activityStatus: Open` while the shared
catalog projection shows it under All after five minutes since its last recorded
`updatedAt`. Missing, invalid, or future timestamps exclude Open from Live. This
visibility age applies only to Open; Working/In progress and Needs input, including
recognized child/background aggregation, do not expire. Ownership checks, monitor
restarts, and viewing do not renew activity, and moving a row to All does not mean
the underlying runtime presence ended. The projection uses one shared expiry timer;
browser GETs remain cache-only.

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
| `CLAUDE_CONFIG_DIR` | Claude usage reader and desktop integration | Claude profile for usage authentication and status-line setup | `%USERPROFILE%\.claude` |
| `POMEGR_CLAUDE_EXECUTABLE` | Desktop sign-in action | Absolute path to the native `claude.exe` | Standard native installation, then PATH |
| `CODEX_HOME` | Monitor | Codex sessions, archive, and index root | `%USERPROFILE%\.codex` |
| `POMEGR_CODEX_EXECUTABLE` | Monitor | Absolute path to a supported native Codex CLI for account-only limit reads | Native CLI discovered on `PATH` or the official npm installation |
| `POMEGR_DATA_DIR` | Desktop and monitor | Override Pomegr-owned settings/snapshot root | `%APPDATA%\pomegr` on Windows |
| `POMEGR_COST_SNAPSHOTS_DIR` | Monitor and Claude status-line bridge | Sanitized Claude estimate snapshots | `%APPDATA%\pomegr\cost-snapshots` on Windows |
| `POMEGR_USAGE_SNAPSHOTS_DIR` | Monitor and Claude status-line bridge | Sanitized local usage pair | `usage-snapshots` beneath Pomegr's data root |
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

To share Claude cost snapshots with a portable build, set `POMEGR_DATA_DIR` to that portable `PomegrData` directory when launching Pomegr; the specific Claude snapshot-root variable remains available when only that root should move.

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

In the desktop app, open **Settings → Phone access** on the computer and enable sharing.
Choose a private Wi-Fi or Ethernet connection if more than one is available, then generate
a pairing QR code and scan it with the phone's camera. Both devices must be on the same
local subnet. Each code expires after five minutes and can pair one browser; generate a
new code for another browser. Up to four browser authorizations can exist per running
gateway. The displayed count is paired browsers, not proof of currently connected devices.

Phone access is an HTTP MVP for trusted local networks. Pairing restricts access but does
not encrypt traffic. The phone can view the existing normalized dashboard; it cannot
retrieve transcript paths, invoke desktop controls, sign in to providers, or change the
computer's sharing settings. No cloud account or phone installation is required.

**Start sharing when Pomegr starts** remembers only the startup preference. Addresses and
phone authorizations are not saved, so restarting Pomegr requires a fresh pairing code.
Keeping Pomegr in the tray keeps sharing available while the computer remains awake.
Stopping sharing or quitting Pomegr revokes access and closes open connections. Changing
the selected interface, address, or private-network eligibility stops sharing; enable it
again after checking the new connection. With several eligible connections, automatic
startup waits for a selection on the computer.

If the phone cannot connect:

- Check that Windows classifies the chosen connection as **Private**. Public, domain,
  VPN, virtual, IPv6-only, and unrecognized connections are not supported by this MVP.
- Allow Pomegr through Windows Firewall for **Private** networks only; limit a manually
  configured inbound rule to the local subnet. Pomegr does not modify firewall rules.
- Check whether guest Wi-Fi or access-point isolation prevents devices from communicating.
- Keep the computer awake and Pomegr running; **Sharing started** confirms the local
  listener, not end-to-end reachability from the phone.
- If the code expired or Pomegr restarted, generate and scan a new code.

The desktop's original dashboard and monitor stay on dynamic `127.0.0.1` ports. The
`0.0.0.0:3003` binding remains specific to the source-development workflow.

### No sessions appear

- Confirm the provider has created persisted JSONL history under its default root, or set the matching root override before `npm run dev`.
- Remove `CLAUDE_SESSION_FILE` if it points to a deleted file.
- Confirm the session ID contains only letters, digits, `.`, `_`, or `-`; browser parameters are opaque provider-qualified IDs such as `codex:thread-id`, never paths.
- Check `http://127.0.0.1:4317/health` on the host. The monitor should return HTTP 204.

On startup, compatible normalized checkpoints may make prior session state visible before provider reconciliation finishes. A missing, corrupt, oversized, unknown-version, or source-incompatible checkpoint is ignored and rebuilt in the background; it must not block other providers or make raw provider data browser-visible. During that rebuild, the affected UI regions remain geometry-matched skeletons while already committed regions continue rendering.

### Codex appears historical while it is open

- An owning app-server reports only threads loaded by that same process. A newly spawned app-server is not global live-state truth on Windows.
- On Windows, confirm the native Codex CLI writer is the selected executable and that its validated process ownership is present. A missing or ambiguous writer is unknown/stale, not proof of idle or completion.
- On Unix, Pomegr does not infer runtime presence from an unvalidated native lock. Use an explicitly connected owning app-server when available, or rely on recorded turns and bounded structured rollout evidence.

### Needs-input is stale or missing

- Recorded input requests clear on matching provider evidence or a subsequent turn; accepted unresolved lifecycle evidence persists until that evidence arrives. Missing, invalid, or incomplete evidence remains unavailable rather than expiring into a guessed state.
- Questions, choices, answers, approval reasons, and commands are intentionally unavailable in diagnostics and browser state.

### Usage limits are unavailable

- Historical views always omit current usage limits.
- Claude failures can indicate missing/expired provider authentication or provider cooldown; the browser receives only a sanitized error.
- Codex limits require a supported native Codex CLI authenticated with ChatGPT. Set `POMEGR_CODEX_EXECUTABLE` to an absolute native executable if automatic discovery cannot find it; Pomegr does not attach to an existing desktop or CLI stdio transport. If no valid CLI is found, the Usage limits page shows **Codex CLI required for usage limits** with installation, sign-in, and restart instructions. Session-level usage capability remains disabled. Account-read failures show expanded troubleshooting even when previous values remain available.
- Concurrent tabs share one in-flight request and a five-minute cooldown, so repeated refreshes do not force another provider call.

### Git or GitHub metadata is unavailable

- Confirm Git is on `PATH` and the selected live session's recorded working directory still exists.
- Historical views intentionally show only the recorded branch and never the current working tree.
- Git, GitHub CLI, and network failures degrade independently from provider session parsing. Pomegr does not fall back to stale remote-tracking data.

### A session was deleted

Deleted provider history returns a safe historical missing-session state and disappears from the next catalog refresh. Pomegr does not retain a transcript copy or substitute current Git and usage-limit data.
