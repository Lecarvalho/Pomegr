# Threadlight

Threadlight is a privacy-first operations console for coding agents. It gives developers a live, provider-neutral view of agent activity, context usage, model settings, Git changes, usage limits, and deterministic efficiency signals.

Threadlight ships adapters for Claude Code and Codex. Both appear in one deterministic session catalog and produce the same normalized browser state wherever equivalent provider evidence exists.

Threadlight is local-first and read-only. It observes provider session records already stored on the developer's machine and does not send raw prompts, responses, commands, or tool output to the browser. Its purpose is to make agent execution understandable without turning private coding transcripts into a surveillance feed.

<p align="center">
  <img src="docs/assets/threadlight-introduction.png" alt="Threadlight overview: a local view of coding-agent sessions" width="560">
</p>

## Why Threadlight

Coding agents increasingly work in parallel, wait for input, consume context, invoke tools, and modify repositories outside the narrow view of a single terminal. Threadlight brings that operational metadata into one place while preserving clear privacy boundaries.

- **Local-first:** session discovery and normalization happen on the developer's machine.
- **Read-only:** Threadlight observes agent and repository state; it does not control sessions or modify source code.
- **Privacy-bounded:** browser APIs exclude raw prompts, responses, commands, tool results, transcripts, and credentials.
- **Provider-neutral:** Claude Code and Codex produce the same normalized UI shapes wherever their evidence is equivalent.
- **Deterministic:** metrics and recommendations are rule-based, reproducible, and documented rather than presented as AI judgments.

## What it shows

- Session title, project, elapsed wall time, last activity, and the latest provider-reported approval mode
- Claude Code's client-side estimated API cost when the optional status-line bridge is connected
- Left-side navigation between concurrent live sessions and recent history, grouped into collapsible projects, with an attention marker when a session needs input
- All-agent current context usage and its latest-snapshot composition
- An opt-in session-machinery total and expandable inventory with provider-estimated category and per-item token counts after running `/context` in the observed Claude Code session
- Parent-child agent hierarchy with descriptions, model IDs, effort levels, status, tool counts, and recognized skill-use evidence
- Optional session-, agent-, and execution-task signal tags captured through Threadlight's MCP tools
- The latest provider-generated session summary, when the transcript records one
- Separate primary-agent popovers for live shell executions and the provider's structured, agent-maintained plan checklist
- Current Git branch and every uncommitted path
- Pull requests created in the session or linked to its live branch, with current GitHub status
- Provider usage-limit windows when a supported authenticated connection is available
- Recent tool activity without displaying prompts or responses
- Deterministic loop and agent-overlap warnings
- Local Markdown retrospective reports for discussion with the main agent

Threadlight does not currently call an AI model. Its analysis and recommendations are rule-based and reproducible.

The **Generate report** button refreshes local session data and creates a deterministic Markdown summary. In the desktop app it opens the native save dialog; browser development uses a normal download. Reports include session metrics, per-agent wall time and context snapshots, skill usage, repeated calls, tool distribution, recorded Git metadata, and retrospective questions. Live reports also include plan usage; historical reports do not. Reports never include raw prompts or responses.

Session history is indexed directly from the provider's existing JSONL files; Threadlight does not copy transcripts into a database. Historical views contain recorded session data only, so current plan limits and the current Git working tree are excluded. If the provider removes a transcript, that session also disappears from Threadlight history.

Claude Code's `/context` command writes its rendered context snapshot to the session transcript. Threadlight detects both the Markdown table and ANSI terminal-summary formats, then shows the provider-reported machinery categories and any expanded groups present in the snapshot. Until a session has a recorded snapshot, the dashboard prompts the user to run `/context`; Threadlight never reconstructs the list from the current repository or configuration.

Live-state evidence is provider-specific and explicitly bounded. Claude Code prefers its local session registry. Codex prefers an owning app-server connection, then the opt-in allowlisted lifecycle bridge, then a 120-second bounded rollout-tail heuristic. A current needs-input session takes priority during automatic selection. Historical views never inherit current lifecycle evidence.

## Install the Windows desktop app

For a published Windows x64 release, the desktop app is the primary user path. Download the signed `Threadlight-Setup-X.Y.Z-x64.exe` and `SHA256SUMS.txt` from the matching [Threadlight release](https://github.com/Lecarvalho/threadlight/releases). Verify the checksum and that Windows reports a valid, timestamped signature from the expected publisher, then run the per-user installer. It does not require a repository checkout, Node.js, administrator privileges, or an open terminal. A release without those signed matching assets is not a supported desktop release.

Threadlight discovers persisted Claude Code and Codex sessions from their normal Windows user locations. Either provider may be installed independently. The desktop monitor and web service bind only to dynamically assigned `127.0.0.1` ports; desktop LAN sharing is unavailable. Closing the window follows the selected ask, tray, or quit preference; use **Quit Threadlight** or the tray's **Quit** command to stop the app and its services.

The portable beta is a separate recovery/testing option. Place `Threadlight-Portable-X.Y.Z-x64.exe` in a writable directory and run it directly. It keeps Threadlight-owned state in `ThreadlightData` beside the executable, does not register launch at login, and does not offer automatic updates. It never relocates or copies provider data.

Only Windows x64 is supported for this first desktop release. There is no supported macOS, Linux, ARM64, app-store, or cloud-hosted desktop build.

See [desktop configuration and troubleshooting](docs/CONFIGURATION.md) and [release verification details](docs/DESKTOP_RELEASES.md).

## Contributor development

Requirements for source development only:

- Windows with Node.js 22.13 or newer
- Claude Code and/or Codex with local session persistence enabled
- Git on `PATH`

```powershell
npm ci
npm run dev
```

Open `http://localhost:3003` on the development computer. The source-development web server also binds to `0.0.0.0:3003`, so it can be opened from another device on the same trusted network; this LAN exposure is a development feature and is not available in the desktop app.

The development command starts:

- Web dashboard on `0.0.0.0:3003`
- Private monitor API on `127.0.0.1:4317`

The web server proxies `/api/state` to the loopback-only monitor, so private credentials and raw transcripts are never sent to the browser.

## Reported signals through MCP

Threadlight includes a stateless local MCP server with three tools. `report_session_signal` attaches a short label and semantic tone to the overall session header and accepts an optional short `description` shown as the tag tooltip. `report_agent_signal` attaches the same metadata to the calling agent. `report_task_signal` attaches a label and tone to a specific execution task by its background task ID or Bash tool-use ID. Threadlight reads the recorded tool calls from agent transcripts and decorates the matching dashboard locations. The transcript is the source of truth for live and historical sessions.

Register this checkout as a local stdio MCP server in the provider that should report signals. Keep the server name exactly `threadlight`, because both transcript parsers use that namespace. For Claude Code, a local-scoped registration is:

```powershell
claude mcp add --transport stdio --scope local threadlight -- node "C:\path\to\threadlight\mcp\server.mjs"
```

Local scope makes the server available only to you in that repository and keeps the machine-specific path out of its source tree. Use `--scope user` to make it available in all of your repositories. Project scope writes a shared `.mcp.json`, which is appropriate only when its command can be made portable for everyone using the repository.

Check the connection inside Claude Code with `/mcp`. Custom subagents can reference the configured server in their agent frontmatter and instruct themselves when to report:

```yaml
---
name: code-reviewer
mcpServers:
  - threadlight
---

Review the requested code. Before returning, call `report_agent_signal` once with a concise outcome such as `Approved` or `Rejected` and the corresponding `positive` or `negative` tone. Never include prompts, responses, secrets, commands, or tool output in the label.
```

Supported tones are `neutral`, `info`, `positive`, `warning`, and `negative`. Labels are plain text and limited to 20 characters. The optional `report_session_signal` and `report_agent_signal` descriptions are one line of plain text limited to 160 characters. The latest `report_session_signal` call across all agents replaces the earlier session tag. Calling `report_agent_signal` again replaces the earlier tag for that agent. Calling `report_task_signal` again with the same `task_id` replaces the earlier task tag. Threadlight derives the reporting agent and report time from the transcript.

For a session-wide milestone or state:

```text
report_session_signal({
  label: "Review complete",
  tone: "positive",
  description: "All requested review checks passed."
})
```

For a task-specific outcome, pass the stable background task ID returned by Claude Code, or the corresponding Bash tool-use ID when it is available:

```text
report_task_signal({
  task_id: "review123",
  label: "Approved w/ notes",
  tone: "info"
})
```

Threadlight resolves the supplied ID monitor-side and exposes only the bounded signal on a matching normalized execution task. Unknown or unsafe task identifiers produce no dashboard tag.

## Estimated API cost through the Claude status line

Claude Code exposes its client-side session estimate only to the configured status-line command. Threadlight's bridge captures that value without replacing an existing status line: put the bridge before the current command and pass the current command after `--`.

For example, this preserves an existing PowerShell status line:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:\\path\\to\\threadlight\\scripts\\claude-statusline-bridge.mjs\" -- powershell -ExecutionPolicy Bypass -File \"C:\\Users\\you\\.claude\\statusline.ps1\""
  }
}
```

If there is no existing status-line command, omit `--` and everything after it. Restart Claude Code after changing `~/.claude/settings.json`. Each status-line update stores only the session ID, estimated USD amount, estimate type, and observation timestamp in `%APPDATA%\threadlight\cost-snapshots` on Windows (`~/.threadlight/cost-snapshots` elsewhere). The dashboard shows `—` until the first update arrives. Claude Code computes this number at standard API list rates, so Threadlight labels it as an estimate rather than an authoritative bill.

## Configuration

The monitor merges both provider catalogs, then selects a current needs-input session, another live session, or the most recent safe historical entry in that order. Provider-local IDs are never accepted as paths.

| Variable | Purpose | Default |
| --- | --- | --- |
| `CLAUDE_PROJECTS_DIR` | Override the current provider's project/session root | `%USERPROFILE%\.claude\projects` |
| `CLAUDE_SESSION_FILE` | Pin one primary JSONL session | Latest primary session |
| `CODEX_HOME` | Override the Codex data root | `%USERPROFILE%\.codex` |
| `THREADLIGHT_DATA_DIR` | Override the Threadlight-owned settings/snapshot root | `%APPDATA%\threadlight` on Windows |
| `THREADLIGHT_CODEX_LIVENESS_DIR` | Opt in to a shared Codex lifecycle-bridge snapshot root | `%APPDATA%\threadlight\codex-liveness` on Windows |
| `THREADLIGHT_CODEX_OWNER_PID` | Override bridge owner discovery for unusual wrappers | Nearest recognized owner process |
| `THREADLIGHT_COST_SNAPSHOTS_DIR` | Override the Claude estimate-snapshot root | `%APPDATA%\threadlight\cost-snapshots` on Windows |
| `SESSION_PULSE_PORT` | Change the private monitor API port | `4317` |

Example:

```powershell
$env:CLAUDE_SESSION_FILE='C:\path\to\session.jsonl'
npm run dev
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for provider setup, the Codex lifecycle bridge, every supported environment variable, capability availability, and troubleshooting.

## Metrics

Every displayed or reported token number uses the same latest-snapshot concept shown by the provider UI:

- **Agent context:** latest non-zero usage snapshot for that agent
- **All-agent context:** sum of the latest context snapshot for every visible agent

Threadlight does not derive cumulative transcript-throughput or token-spend totals. Its timeline shows positive changes between all-agent context snapshots at consecutive bucket boundaries; repeated snapshots contribute zero and the result is never labeled as token spend. The separately labeled **Estimated API cost** is Claude Code's own cumulative client-side estimate captured from its status-line feed. See [docs/METRICS.md](docs/METRICS.md) for formulas and thresholds.

## Privacy and security

- Raw prompts, answers, responses, reasoning, commands, patches, stdout, stderr, and tool output are not returned by the monitor API.
- The optional status-line bridge persists only session ID, estimated USD amount, estimate type, and observation time. It discards workspace paths and every other status-line field.
- Session summaries are accepted only from recognized provider summary records, reduced to bounded plain text, and labeled as provider-generated; Threadlight never derives them from raw prompts, responses, or tool results.
- Session-, agent-, and task-signal labels are explicit, bounded metadata from recognized Threadlight MCP calls; supplied task targets, surrounding responses, and tool-result content remain private.
- Agent launch text is used only to derive a concise fallback label.
- Session transcripts and Git state are read-only.
- Git commands use argument arrays rather than shell interpolation.
- OAuth credentials, provider auth files, environment secrets, and provider-local transcript paths remain in the monitor process.
- Credentials are sent only to the provider's own usage endpoint and never enter browser state.
- Plan usage is refreshed every 60 seconds while a live view is unpaused. Normal session polling and manual refreshes never call the provider usage endpoint; server caching deduplicates simultaneous tabs.

In the installed and portable desktop apps, both local services use dynamic loopback-only ports plus a per-launch authorization boundary; other LAN devices cannot connect. In source development, anyone who can reach port 3003 on the local network can view dashboard metadata. The development server accepts any hostname, so use it only on a trusted network or change the development binding if that is inappropriate. Your firewall may prompt you to allow Node.js on private networks.

## Development

```powershell
npm run dev       # web dashboard and monitor
npm run dev:web   # web dashboard only
npm run monitor   # monitor API only
npm run build     # production build
npm test          # build and rendered-output checks
npm run lint      # static linting
```

Important source files:

- `monitor/server.mjs` — discovery, parsing, metrics, Git, and plan usage
- `app/Dashboard.tsx` — live React dashboard
- `app/api/state/route.ts` — same-origin proxy to the private monitor
- `scripts/dev.mjs` — local process orchestration

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the shipped provider flow and failure boundaries.

## Current limitations

- Codex live state is exact only with an owning app-server connection or a current lifecycle-bridge lease; rollout-only state is a bounded heuristic.
- Codex estimated API cost, context-machinery snapshots, and provider-generated session summaries are unavailable in the initial adapter.
- Codex structured plan items and automatic-compaction warnings are best effort and appear only with explicit recognized records.
- Codex account usage limits require an owning app-server connection; the standalone Windows monitor cannot discover another process's private app-server transport.
- Session duration is elapsed wall time and includes idle periods.
- Each provider catalog is bounded to its 50 most recent safe entries by default.
- Subagent completion uses transcript stop reasons, with modification time as a fallback.
- Efficiency warnings are heuristics, not authoritative judgments.
- Live Codex state parsing reads a bounded 512 KiB tail per rollout and caches unchanged files; historical reads are cached after the first full parse.

## License

Current Threadlight source is licensed under the [GNU Affero General Public License version 3](LICENSE) (`AGPL-3.0-only`). If you modify Threadlight and make that version available to users over a network, the license requires you to offer those users the corresponding source code.

Revisions through commit [`95cd66c`](https://github.com/Lecarvalho/threadlight/tree/95cd66cb60831ef876421a5149d25788f9dab736) were published under the MIT License and remain available under those terms. See the [license history](docs/LICENSE_HISTORY.md) for the transition boundary.

The Threadlight name and visual identity are not granted by the software license. See the [trademark policy](TRADEMARKS.md). Commercial licenses for uses incompatible with the AGPL may be offered separately; contact the maintainer through the [Threadlight repository](https://github.com/Lecarvalho/threadlight).
