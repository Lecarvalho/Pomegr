# Pomegr reporting plugin for Codex

Pomegr ships a self-contained Codex plugin that exposes five bounded, provider-neutral reporting tools. The plugin runs locally over stdio and lets the Pomegr observer read agent-reported session, agent, and execution-task signals from Codex transcripts. It does not send transcript contents or credentials.

## Install

Register the Pomegr Git repository as a Codex marketplace, then install the plugin from that marketplace:

```powershell
codex plugin marketplace add Lecarvalho/pomegr --ref main
codex plugin add pomegr@pomegr
```

Restart Codex and start a new task so the installed tools are picked up. The plugin is installed in the client's local Codex configuration and cache; it does not copy scripts or plugin files into the client's repositories. To pin a stable release, replace `main` with a published Pomegr release tag.

To update an installation that tracks `main`:

```powershell
codex plugin marketplace upgrade pomegr
codex plugin add pomegr@pomegr
```

## What is installed

The Codex package distributed from this repository is separate from `plugins/claude-code/`. It intentionally excludes Claude-specific hooks, environment variables, policy injection, and native session renaming. Its MCP server provides:

| Tool | Effect |
| --- | --- |
| `report_session_signal` | Reports or replaces the overall session's bounded label, tone, and optional description. |
| `report_agent_signal` | Reports or replaces the calling agent's bounded label, tone, and optional description. |
| `report_task_signal` | Records a durable outcome for a recognized execution-task ID. |
| `clear_session_signal` | Removes the current agent-reported session signal. |
| `clear_agent_signal` | Removes the calling agent's current signal. |

Signals are agent-reported guidance and may become stale; they are not Pomegr judgments. Tool arguments and results never become a general query channel into the monitor.

## Build and validate

Regenerate the single-file MCP runtime and run the package tests from the Pomegr repository root:

```powershell
npm run build:plugin:codex
npm run test:plugin
```

Validate the manifest with the bundled plugin validator before publishing a change:

```powershell
python C:\path\to\plugin-creator\scripts\validate_plugin.py .\plugins\pomegr
```

The generated bundle is committed so a client repository does not need Pomegr's source tree or `node_modules` at runtime. Node.js 22.13 or newer must be available to Codex for the local MCP process.
