# Configuration and troubleshooting

Pomegr discovers Claude Code and Codex independently. One provider can be absent or fail without removing sessions from the other provider. The monitor remains read-only and binds to `127.0.0.1`. Development exposes the web dashboard on the LAN; the Windows desktop app offers separate, opt-in phone access.

Operational cache tiers, checkpoint rules, readiness states, and frontend refresh cadence
are defined canonically in [Observation cache and progressive readiness](../architecture/observation-cache.md).

## Supported desktop modes

See [Install Pomegr](../../public/get-started/install.md) for supported downloads,
prerequisites, installed and portable modes, and launch instructions. Optional
phone access shares the dashboard with paired
browsers on a trusted local network; see the
[Phone access guide](../../public/using-pomegr/phone-access.md).

## Desktop settings and behavior

The [Settings guide](../../public/using-pomegr/settings.md) explains the Settings tabs, the tray menu, and how installed and portable modes differ. This section keeps the behavior behind them:

- **Pause live refresh** in the tray menu (**Resume live refresh** while paused) pauses dashboard polling only. It does not pause or control coding agents and is not persisted.
- **Launch at login** is an opt-in tray-menu checkbox, available only for the installed app.
- **Close behavior** is stored as `ask` (the default), `tray`, or `quit`. With `ask`, closing the window shows **Keep running** and **Quit Pomegr** with **Remember my choice**, which stores `tray` or `quit`. **Settings → Desktop** (desktop app only) changes the stored choice through the existing fixed-value close-behavior IPC. **Quit Pomegr** in the tray menu stops all Pomegr-owned services.
- **Needs-input notifications** are enabled by default and stored as a persistent boolean; a temporary one-hour quiet mode clears when the app exits. In the desktop app, **Settings → Notifications** switches both through the existing boolean IPC; a browser shows the alerts as **Desktop managed** with no switch. A notification shows the session's normalized catalog title (one line, at most 96 characters) and a fixed body, or the fixed generic Pomegr title and body when the session has no title; it never contains a question, approval reason, command, response, tool output, or provider path.
- **Updates** are enabled by default for installed signed builds. Pomegr checks after startup and every four hours and silently downloads a higher same-channel release. [Install Pomegr](../../public/get-started/install.md#keep-pomegr-up-to-date) explains the user steps. **Settings → About** shows the installed desktop version, the last successful check time, and **Check for updates**; the same row shows checking/download progress, retry feedback, and **Restart and install** once the installer is verified and ready, and a dot beside **About** also indicates readiness. The existing bottom-left **Restart to update** action remains available. Clicking either install action is the explicit restart/installation confirmation. A failed check, download, signature verification, or install attempt leaves the current application runnable. Portable mode never checks for updates, and ordinary browser settings expose no native update controls.

Closing to the tray leaves local observation running. Click the tray icon, use **Open Pomegr**, or launch Pomegr again to reopen the single existing instance.

## Desktop paths and privacy boundaries

Installed state is stored in Electron's per-user application-data directory for Pomegr (normally beneath `%APPDATA%`). `POMEGR_DATA_DIR` is an advanced override that redirects Pomegr-owned state when set before launch. Portable state is always `PomegrData` beside the portable executable.

Pomegr-owned storage is limited to versioned `settings.json`, bounded Claude cost, local usage, and normalized account-usage snapshots, bounded Codex lifecycle snapshots, and bounded normalized observation checkpoints under `observation-cache-v1`. Checkpoints contain only contract-validated normalized evidence, readiness, revision metadata, and bounded source compatibility metadata; raw provider records and incomplete record fragments are never copied. Settings allowlist only window geometry, close behavior, display preferences, launch-at-login, notification, update, and phone-sharing startup booleans, plus the three private provider-folder overrides described below, the two storage retention/cleanup overrides described in [Storage settings](#storage-settings), and the two bounded Home announcement markers (`homeUpdate.seenId`, `homeUpdate.dismissedId`) that record which What's new announcement already opened its dialog and which was dismissed. Phone authorizations and network discovery results are never persisted. Provider transcripts, indexes, tasks, credentials, repositories, `.claude`, and `.codex` stay in provider-owned locations and are never copied. Uninstall preserves Pomegr user data and never deletes provider data.

Reports are written only after the user clicks **Download report** and, in the desktop app, selects a destination in the native save dialog (a browser downloads the file instead). Pomegr keeps no implicit report archive.

## Storage settings

Pomegr periodically prunes its own resource-history SQLite store by age and by a soft
size threshold. Pruning only ages out or trims `resource_minutes` and
`resource_peak_samples` rows; it never removes sessions, transcripts, checkpoints,
file history, or recorded peaks.

The [Settings guide](../../public/using-pomegr/settings.md#manage-storage) explains the desktop **Settings → Storage** controls (**Retention age**, **Resource history cleanup threshold**, and **Save and restart Pomegr**). Saved desktop values win over the matching environment variables below once saved; the monitor applies either source only on its next start and prune cycle, never synchronously from a settings change or a browser request. Source-development launches and any field left unset in the desktop app continue to use the `POMEGR_RETENTION_DAYS` and `POMEGR_STORE_MAX_MB` environment variables below; an unset, malformed, or out-of-range value for either one falls back to its default.

## Provider setup

For the first-use walkthrough, see [Follow your first session](../../public/get-started/first-session.md).
The sections below cover provider-specific configuration and optional evidence.

### Choose provider folders in the desktop app

The [Settings guide](../../public/using-pomegr/settings.md#choose-provider-folders) and [Follow your first session](../../public/get-started/first-session.md#if-you-use-a-different-profile) cover the desktop **Settings → Providers** controls and steps. Default session discovery, live presence, task data, account usage, reconnection, and plugin setup follow the Claude **Configuration folder**; the optional **Session folder override** is separate, and the Codex **Home folder** covers session discovery and account usage. Changes apply after Pomegr restarts, running coding tools keep their existing profiles, and no provider files are moved or modified.

Saved choices take precedence over matching environment variables. A saved Claude
configuration or session-folder choice also disables an inherited
`CLAUDE_SESSION_FILE` pin. Without a session-folder override, Claude sessions come
from `projects` beneath the effective configuration folder. An explicit
`CLAUDE_PROJECTS_DIR` environment setting remains an override until changed outside
Pomegr or replaced by a saved session-folder choice.

Folder-change controls are desktop-only. Paths appear in native dialogs and private
desktop settings. **Restore defaults** in the Settings header resets display
preferences only. Source-development launches
continue to use the environment variables below.

In a browser on the same computer or through paired LAN access, **Settings → Providers** shows the monitor's
effective configuration folder, session folder, and home folder as read-only text
fields. You can select and copy these paths, but cannot change folders or restart
Pomegr from the browser. On the same computer, development access supports
`localhost`, the machine name (including `.local`), and its local interface IPs.
Other computers require the desktop app's paired LAN access; direct unpaired
access to the development server cannot read folders. This replaces the temporary simulated preview.
Unavailable roots remain blank with **Path unavailable**. Folder paths are not
saved in browser storage or included in ordinary session responses or reports.

Custom Claude profiles use separate default local usage and cost snapshot folders.
Pomegr does not import older unscoped readings into a custom profile. Explicit
`POMEGR_USAGE_SNAPSHOTS_DIR` and `POMEGR_COST_SNAPSHOTS_DIR` overrides remain
operator-owned; use separate destinations for different profiles. The native
**Enable local usage** action configures the selected profile's bridge to write
to the matching destinations after confirmation.

### Claude Code

No extra setup is required when Claude Code persists sessions under `%USERPROFILE%\.claude\projects`. The local session registry supplies the strongest live and needs-input evidence. When the registry provides an owner PID and process-start identity, Pomegr validates both monitor-side so orphaned registry files cannot keep exited sessions live; those owner fields are never exposed to the browser. `CLAUDE_PROJECTS_DIR` can select a different session root, and `CLAUDE_SESSION_FILE` can pin one synthetic or explicitly selected primary rollout.

Claude Remote Control launches `sdk-cli` sessions whose local registry can omit execution status. For these sessions, Pomegr reads the native session metadata API using the existing Claude OAuth access token, only after validating the local process owner and registry bridge association. It maps explicit `running`, `requires_action`, and `idle` primary-loop states. The session additionally remains Working while provider-recorded background workflow or shell launches have neither a matching terminal notification nor a completed workflow manifest in the current validated process lifetime. It does not guess from transcript age or agent counts. No extra hook, worker attachment, or remote session discovery is performed. Missing credentials or an unsupported response leave status unknown until a valid observation arrives; temporary failures retain the last valid status for the same owner. Pomegr does not refresh credentials: sign in through Claude Code if account access has expired. The [Claude session-status contract](../architecture/claude-session-status.md) documents request bounds, authentication, and privacy.

The API list-rate estimate is optional. Wrap the Claude Code status line with `scripts/claude-statusline-bridge.mjs` to capture Claude Code's own client-side estimate. In `~/.claude/settings.json`, point `statusLine.command` at the bridge and pass the existing status-line command after `--`:

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

For what the windows mean and how fresh they are, see the public
[Usage limits](../../public/concepts/usage-limits.md) guide. The in-app **Setup
guide** link opens the public
[Claude Code local usage](../../public/help/claude-local-usage.md) page, which gives
the end-user steps; keep it in step with this section.

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

To display current Codex usage limits, install a supported native Codex CLI and sign it in with the account whose limits should be shown. Pomegr starts a short-lived, account-only `codex app-server --stdio` reader at most once every five minutes; it requests only the rate-limit snapshot and exits immediately. It never uses that transient process for session discovery, cataloging, liveness, or turn data. Set `POMEGR_CODEX_EXECUTABLE` to an absolute native CLI path when automatic discovery cannot find the CLI. A missing or unsupported CLI disables session-level usage capability, while the Usage limits page shows **Codex CLI required for usage limits** with expanded **Usage connection help**. A valid CLI with signed-out, API-key-only, or temporarily failing account access retains the capability and shows troubleshooting beside a sanitized failure. Retained readings do not hide help. The public [Usage limits](../../public/concepts/usage-limits.md) guide explains how the windows are presented.

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

The generated capability matrix and current provider-related gaps are in
[Limitations](../architecture/limitations.md#provider-related-limitations).
The same reference lists Pomegr-specific limitations separately.

## Environment variables

| Variable | Used by | Purpose | Default |
| --- | --- | --- | --- |
| `CLAUDE_PROJECTS_DIR` | Monitor | Claude project/session root override | `projects` beneath the effective Claude configuration folder |
| `CLAUDE_SESSION_FILE` | Monitor | Pin one Claude primary JSONL session | Automatic selection |
| `CLAUDE_CONFIG_DIR` | Claude adapter and desktop integration | Claude profile for discovery, presence, tasks, usage, sign-in, and setup | `%USERPROFILE%\.claude` |
| `POMEGR_CLAUDE_EXECUTABLE` | Desktop sign-in action | Absolute path to the native `claude.exe` | Standard native installation, then PATH |
| `CODEX_HOME` | Monitor | Codex sessions, archive, and index root | `%USERPROFILE%\.codex` |
| `POMEGR_CODEX_EXECUTABLE` | Monitor | Absolute path to a supported native Codex CLI for account-only limit reads | Native CLI discovered on `PATH` or the official npm installation |
| `POMEGR_DATA_DIR` | Desktop and monitor | Override Pomegr-owned settings/snapshot root | `%APPDATA%\pomegr` on Windows |
| `POMEGR_COST_SNAPSHOTS_DIR` | Monitor and Claude status-line bridge | Sanitized Claude estimate snapshots | `%APPDATA%\pomegr\cost-snapshots` on Windows |
| `POMEGR_USAGE_SNAPSHOTS_DIR` | Monitor and Claude status-line bridge | Sanitized local usage pair | `usage-snapshots` beneath Pomegr's data root |
| `POMEGR_RETENTION_DAYS` | Monitor | Resource-history retention age: `30`, `90`, `180`, `365`, or `all` to keep every session | `90` |
| `POMEGR_STORE_MAX_MB` | Monitor | Soft size threshold that triggers pruning the oldest resource history first: `250`, `500`, `1024`, or `2048` | `500` |
| `SESSION_PULSE_PORT` | Monitor and development launcher | Loopback monitor port | `4317` |

Do not point provider roots at a browser-served directory. Do not place OAuth tokens, auth-file contents, transcripts, or environment dumps in Pomegr configuration.

## Agent display roles

Pomegr exposes a bounded display `role` for each agent. The primary agent is always `orchestrator`; other roles resolve in this order: repository mapping, built-in exact type, documented keyword rule, verified workflow association, then `unknown`. This is display normalization applied when a session response is projected, including history; it is not recorded session state or an authoritative assessment of an agent.

Unmapped agents with a valid recorded type display `custom: <type>` in their
individual details. The label uses the recorded terminal type name, normalized
and validated under the [agent role rules](../architecture/metrics.md#agent-roles). Missing or
invalid types still display `unknown`. No mapping file is needed for this label;
add a mapping only to assign one of Pomegr's built-in roles.

To customize recognized local agent types, optionally commit `.pomegr/roles.json`:

```json
{
  "version": 1,
  "roles": {
    "cavecrew-builder": "builder"
  }
}
```

Keys must already be normalized: lowercase, the text after the final `:`, and separators folded to `-`. The file is capped at 16 KiB and 64 mappings, keys at 64 characters, and values must be one of Pomegr's built-in roles. Extra top-level fields, an unsupported version, or malformed JSON ignore the entire file; invalid individual mapping rows are skipped. Validate it read-only with `node server/normalize/agent-roles.mjs validate --cwd .` or `/pomegr:doctor`. Mapping contents never enter the browser API or generated reports.

To share Claude cost snapshots with a portable build, set `POMEGR_DATA_DIR` to that portable `PomegrData` directory when launching Pomegr; the specific Claude snapshot-root variable remains available when only that root should move.

## Troubleshooting

The public help pages give the recovery steps: [Missing sessions](../../public/help/missing-sessions.md), [Unavailable data](../../public/help/unavailable-data.md), and [Connection problems](../../public/help/connection-problems.md). The sections below keep the technical contracts behind them.

### The desktop app does not open

The [Connection problems guide](../../public/help/connection-problems.md#pomegr-does-not-open) explains the recovery steps. This section keeps the release and startup contract:

- The release must be the Windows x64 build, its SHA-256 must match `SHA256SUMS.txt`, and its Authenticode signature must be valid and timestamped for the expected complete publisher Subject.
- A second launch focuses the existing window instead of starting another service set.
- The fixed Pomegr startup-error page carries only the bounded diagnostic code `DESKTOP_START_FAILED`. Do not publish environment dumps, private paths, transcripts, credentials, or screenshots containing session data.
- Installed and portable builds do not require system Node.js. Missing Git affects repository enrichment only and must not prevent startup.

### The window disappeared after I closed it

Closing the window may hide Pomegr to the tray; see [Connection problems](../../public/help/connection-problems.md#pomegr-does-not-open). The close-behavior contract is under [Desktop settings and behavior](#desktop-settings-and-behavior).

### Notifications do not appear

The [Settings guide](../../public/using-pomegr/settings.md#use-the-desktop-controls) tells users when the alerts appear and what they show. This section keeps the delivery contract:

- Needs-input notifications are enabled by default. Check that **Settings → Notifications** in the desktop app has **Needs-input alerts** on and **Quiet for one hour** off. Confirm the session was live and waiting when Pomegr observed it.
- Pomegr notifies only on a transition into a recognized live needs-input state; it deduplicates repeated observations until the state clears.
- Windows notification settings or Focus Assist can suppress native presentation. Pomegr monitoring continues if notification delivery fails.
- Notification clicks navigate to an observation view only. Pomegr cannot approve, answer, resume, or control an agent.

### Updates are unavailable

The [installation guide](../../public/get-started/install.md#keep-pomegr-up-to-date) explains the user steps for installed and portable builds. This section keeps the update contract:

- Automatic updates require an installed, signed release with updates enabled and network access to the official release endpoint. Portable builds intentionally disable them.
- The update action appears only after the signed installer finishes downloading and verification succeeds; checking and downloading do not interrupt the dashboard.
- Stable and beta channels never cross. Publish or install a monotonically higher version on the same channel.
- A failed or rejected update leaves the current installation runnable. Never bypass publisher checks or replace updater metadata manually; use a newer correctly signed release.
- See [desktop releases](../operations/desktop-releases.md) for signature, publisher, checksum, and rollback policy.

### Another device cannot open the dashboard

The [Phone access guide](../../public/using-pomegr/phone-access.md) explains pairing, the sharing settings, and recovery from the desktop **Settings → Phone access** panel. This section keeps the contract behind them:

- Phone access is an HTTP MVP for trusted local networks. Pairing restricts access but does not encrypt traffic. A paired phone can view the existing normalized dashboard; it cannot retrieve transcript paths, invoke desktop controls, sign in to providers, or change the computer's sharing settings. No cloud account or phone installation is required.
- Each pairing code expires after five minutes and pairs one browser. Up to four browser authorizations can exist per running gateway. The displayed count is paired browsers, not proof of currently connected devices. Both devices must be on the same local subnet, and only a connection Windows classifies as **Private** is eligible: public, domain, VPN, virtual, IPv6-only, and unrecognized connections are not supported by this MVP.
- **Start on a private network** remembers only the startup preference. Addresses, network discovery results, and phone authorizations are not saved, so restarting Pomegr requires a fresh pairing code. Keeping Pomegr in the tray keeps sharing available while the computer remains awake. Stopping sharing or quitting Pomegr revokes access and closes open connections. Changing the selected interface, address, or private-network eligibility stops sharing, and it must be enabled again after checking the new connection. With several eligible connections, automatic startup waits for a selection on the computer.
- Pomegr does not modify firewall rules. Windows Firewall should allow Pomegr for **Private** networks only, and a manually configured inbound rule should be limited to the local subnet. **Sharing started** confirms the local listener, not end-to-end reachability from the phone; guest Wi-Fi and access-point isolation can still block it.
- The desktop's original dashboard and monitor stay on dynamic `127.0.0.1` ports. The `0.0.0.0:3003` binding remains specific to the source-development workflow.

### No sessions appear

The [Missing sessions guide](../../public/help/missing-sessions.md) explains the recovery steps. This section keeps the source-development and identifier checks:

- Confirm the provider has created persisted JSONL history under its default root, or set the matching root override before `npm run dev`.
- Remove `CLAUDE_SESSION_FILE` if it points to a deleted file.
- Confirm the session ID contains only letters, digits, `.`, `_`, or `-`; browser parameters are opaque provider-qualified IDs such as `codex:thread-id`, never paths.
- Check `http://127.0.0.1:4317/health` on the host. The monitor should return HTTP 204.

On startup, compatible normalized checkpoints may make prior session state visible before provider reconciliation finishes. A missing, corrupt, oversized, unknown-version, or source-incompatible checkpoint is ignored and rebuilt in the background; it must not block other providers or make raw provider data browser-visible. During that rebuild, the affected UI regions remain geometry-matched skeletons while already committed regions continue rendering.

### Codex appears historical while it is open

The [Missing sessions guide](../../public/help/missing-sessions.md#a-session-is-missing-from-live) gives the reader-facing summary. The liveness rules:

- An owning app-server reports only threads loaded by that same process. A newly spawned app-server is not global live-state truth on Windows.
- On Windows, confirm the native Codex CLI writer is the selected executable and that its validated process ownership is present. A missing or ambiguous writer is unknown/stale, not proof of idle or completion.
- On Unix, Pomegr does not infer runtime presence from an unvalidated native lock. Use an explicitly connected owning app-server when available, or rely on recorded turns and bounded structured rollout evidence.

### Needs-input is stale or missing

The [Unavailable data guide](../../public/help/unavailable-data.md#needs-input-looks-stale-or-is-missing) explains what to check. The evidence rules:

- Recorded input requests clear on matching provider evidence or a subsequent turn; accepted unresolved lifecycle evidence persists until that evidence arrives. Missing, invalid, or incomplete evidence remains unavailable rather than expiring into a guessed state.
- Questions, choices, answers, approval reasons, and commands are intentionally unavailable in diagnostics and browser state.

### Usage limits are unavailable

- The public [Usage limits](../../public/concepts/usage-limits.md) guide explains the windows, freshness, and recovery steps.
- Historical views always omit current usage limits.
- Claude failures can indicate missing/expired provider authentication or provider cooldown; the browser receives only a sanitized error.
- Codex limits require a supported native Codex CLI authenticated with ChatGPT. Set `POMEGR_CODEX_EXECUTABLE` to an absolute native executable if automatic discovery cannot find it; Pomegr does not attach to an existing desktop or CLI stdio transport. If no valid CLI is found, the Usage limits page shows **Codex CLI required for usage limits** with installation, sign-in, and restart instructions. Session-level usage capability remains disabled. Account-read failures show expanded troubleshooting even when previous values remain available.
- Concurrent tabs share one in-flight request and a five-minute cooldown, so repeated refreshes do not force another provider call.

### Git or GitHub metadata is unavailable

The [Unavailable data guide](../../public/help/unavailable-data.md#repository-details-are-missing) explains what to check. The contract behind it:

- Git must be on `PATH`, and the selected live session's recorded working directory must still exist.
- Historical views intentionally show only the recorded branch and never the current working tree.
- Git, GitHub CLI, and network failures degrade independently from provider session parsing. Pomegr does not fall back to stale remote-tracking data.

### A session was deleted

The [Missing sessions guide](../../public/help/missing-sessions.md#session-unavailable) shows what the reader sees. Deleted provider history returns a safe historical missing-session state and disappears from the next catalog refresh. Pomegr does not retain a transcript copy or substitute current Git and usage-limit data.
