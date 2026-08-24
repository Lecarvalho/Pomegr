# Pomegr reporting plugin for Codex

Pomegr ships a self-contained Codex plugin that exposes five bounded, provider-neutral reporting tools. The plugin runs locally over stdio and lets the Pomegr observer read agent-reported session, agent, and execution-task signals from Codex transcripts. It does not send transcript contents or credentials.

## Install into a repository

Use the installer from a Pomegr source checkout or release archive. Preview the exact target-repository changes first:

```powershell
node .\scripts\install-codex-plugin.mjs --repo C:\path\to\client-repository --dry-run
```

Apply the installation after reviewing the preview:

```powershell
node .\scripts\install-codex-plugin.mjs --repo C:\path\to\client-repository
```

The installer requires the target to be a Git repository root. It copies the package to `plugins/pomegr/` and safely creates or merges `.agents/plugins/marketplace.json`. Existing marketplace metadata and other plugin entries are preserved. An existing `plugins/pomegr/` directory is updated only when its manifest identifies it as Pomegr and contains no unmanaged files.

Commit those repository files so collaborators receive the same package and marketplace entry. Each client then registers the repository root as a local marketplace and installs Pomegr using the marketplace name from `.agents/plugins/marketplace.json` (`pomegr` for a new installation):

```powershell
codex plugin marketplace add C:\path\to\client-repository
codex plugin add pomegr@pomegr
```

Restart Codex and start a new task in the repository so the installed skills and tools are picked up. If the repository already had a differently named marketplace, use that preserved name after `@` in the second command. The Codex CLI currently has no repo-scoped plugin-install flag; the package and catalog remain repository-owned while each collaborator explicitly enables the installed plugin in their local Codex configuration.

## What is installed

The Codex package is separate from `plugins/claude-code/`. It intentionally excludes Claude-specific hooks, environment variables, policy injection, and native session renaming. Its MCP server provides:

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
