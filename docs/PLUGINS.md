# Pomegr reporting plugins

Pomegr ships self-contained plugins for Codex and Claude Code. Both adapters configure and report the same bounded, repository-specific signals through a stateless local MCP server. Pomegr remains provider-neutral: provider names and lifecycle details belong only to the distribution adapter.

| Capability | Codex | Claude Code |
| --- | --- | --- |
| Repository initialization | `$pomegr:init` | `/pomegr:init` |
| Read-only diagnosis | `$pomegr:doctor` | `/pomegr:doctor` |
| Automatic policy loading | `SessionStart` hook | `SessionStart` hook |
| Delegated policy injection | `SubagentStart` hook | `PreToolUse` hook for `Task\|Agent` |
| Delegated-report detection | `SubagentStop` hook | `SubagentStop` hook |
| Signal tools | Five shared tools | Five shared tools |
| Native session-title tool | Provider automatic naming | `rename_session` |

Neither plugin sends transcript contents or credentials to Pomegr. The generated MCP runtimes include their npm dependencies and do not import from the client repository, plugin-root `node_modules`, or the rest of the Pomegr checkout.

## Install

### Codex

Register this Git repository as a marketplace and install Pomegr:

```powershell
codex plugin marketplace add Lecarvalho/pomegr --ref main
codex plugin add pomegr@pomegr
```

Restart Codex and start a new task so the installed skills, hooks, and tools are discovered. Open `/hooks`, review the three Pomegr hook definitions, and trust them. Plugin hooks are not trusted automatically, and changed definitions require review again.

The plugin is installed in the local Codex configuration and cache; it does not copy scripts or plugin files into client repositories. Replace `main` with a published Pomegr release tag to pin a stable release.

To update an installation that tracks `main`:

```powershell
codex plugin marketplace upgrade pomegr
codex plugin add pomegr@pomegr
```

Start a new task after updating.

### Claude Code

Add the marketplace, install Pomegr, choose **Project** when asked for the installation scope, and reload:

```text
/plugin marketplace add Lecarvalho/pomegr
/plugin install pomegr@pomegr
/reload-plugins
```

Project scope makes the plugin available whenever the repository is opened without putting machine-specific MCP paths in the repository.

For local development from a Pomegr checkout:

```powershell
claude --plugin-dir .\plugins\claude-code
```

## Initialize a repository

Use `$pomegr:init` in Codex or `/pomegr:init` in Claude Code. The skill inspects safe project structure and any existing policy, then asks which project-specific session, agent, and execution-task outcomes an observer needs to notice and when each state should be replaced or cleared.

Before writing, the skill previews the complete policy or a focused diff and asks for confirmation. It creates or updates `.pomegr/signals.md`. It does not add reporting instructions to `AGENTS.md`, and it does not blindly replace an existing policy. Generic lifecycle, context, Git, approval, plan-task, and execution-task metadata already derived by Pomegr should not be duplicated as signals.

The Codex skill changes only `.pomegr/signals.md`. The Claude Code skill may also update explicit `tools` allowlists in `.claude/agents/*.md` when a confirmed delegated-reporting choice requires Pomegr access; those definition edits appear in the same preview.

Use `$pomegr:doctor` in Codex or `/pomegr:doctor` in Claude Code for a read-only checklist. Doctor validates the policy, loading marker, delegated-agent coverage, expected tools, packaged files, and optional `.pomegr/roles.json` display mappings. It does not edit files, invoke a report or clear tool, rename a session, or emit a diagnostic signal.

## Shared repository policy

`.pomegr/signals.md` uses provider-neutral policy version `6`. A policy initialized by either adapter works with both. It contains these sections:

- Session naming
- Privacy and semantics
- Delegated agent tooling
- Delegated agents
- Session signals
- Agent signals
- Task signals

Signal tables use `Label`, `Tone`, `Report when`, and `Replace or clear when`. Labels are bounded plain text; tones are `neutral`, `info`, `positive`, `warning`, or `negative`; transition conditions must be concrete and observable. Session and agent rows state when they are replaced or cleared. Task outcomes are durable and cannot be cleared.

The `Delegated agents` table names each normalized agent type and whether it owns `agent`, `task`, or `agent and task` reporting. `*` matches every type. A row may own only a scope with at least one configured signal. An empty table keeps all reporting in the main session.

Every signal-owning agent must retain access to the Pomegr MCP server and applicable reporting tools. Provider-specific MCP prefixes are not part of the policy.

Signals are agent-reported guidance and may become stale; they are not authoritative Pomegr judgments. Policies and reports must never contain prompts, responses, secrets, credentials, raw commands, stdout, stderr, tool results, transcript paths, hook payloads, or sensitive repository content.

## Automatic policy loading

Both packages register `SessionStart`. The hook searches upward from its working directory to the repository root for `.pomegr/signals.md`, validates the file, and returns a bounded copy as additional context under `[Pomegr reporting policy loaded]`.

- A missing policy means repository-specific reporting is inactive.
- An invalid, unsafe, or oversized policy produces only a bounded, non-blocking doctor recommendation.
- An unavailable MCP server never blocks the coding session.

Codex runs the hook for startup, resume, clear, and compaction. Claude Code also covers forks; a fork already carries inherited context and is excluded from separate delegated-row injection.

## Delegated agents

A subagent has its own context, so holding the Pomegr tools does not prove it received the repository policy. Both adapters inject only the applicable rows under `[Pomegr delegated reporting policy]` and keep normal permission behavior.

### Codex only

`SubagentStart` reads `agent_type` and supplies the rows declared for that normalized type. An uninvolved type receives nothing. Custom Codex agents normally inherit parent settings when omitted; a signal-owning definition must not replace or disable Pomegr MCP access.

`SubagentStop` performs a bounded, best-effort scan for recognized Pomegr reporting call records. If a declared agent finished without one, the warning contains only its normalized type, owned scopes, and configured labels. Missing, unreadable, oversized, symlinked, or unrecognized evidence degrades silently.

### Claude Code only

A `PreToolUse` hook matching `Task\|Agent` reads the spawn's `subagent_type` and appends matching rows through `updatedInput`. Injection is scoped and idempotent: prompts already carrying the marker, or all applicable labels with a Pomegr reference, are not modified again. The hook never changes the permission decision.

Explicit `tools` allowlists in `.claude/agents/*.md` must include the resolved Pomegr namespace, typically `mcp__plugin_pomegr_pomegr__*`, or the applicable exact tools. Policy validation reports bounded drift warnings when a declared type lacks access or an undeclared definition carries reporting tools. Warnings name the definition file only, never its contents.

The Claude `SubagentStop` detector checks recognized Pomegr report or clear calls and emits a bounded miss warning. It never infers a verdict, exposes transcript content, blocks the agent's final result, or retries during `stop_hook_active`.

## Tools and signal lifetime

Both plugins provide:

| Tool | Effect |
| --- | --- |
| `report_session_signal` | Reports or replaces the main session's current bounded signal. |
| `report_agent_signal` | Reports or replaces the calling agent's current bounded signal. |
| `report_task_signal` | Records a durable outcome for a recognized execution-task ID. |
| `clear_session_signal` | Removes the main session's current agent-reported signal. |
| `clear_agent_signal` | Removes the calling agent's current agent-reported signal. |

A visible label remains until a later report replaces it or the matching clear tool removes it. Clearing means no agent-reported state is currently meaningful for that scope. Task signals cannot be cleared; a later report for the same recognized task may replace one.

The MCP server is stateless. Pomegr reconstructs reports and clears chronologically from provider transcript evidence. Task targets are resolved monitor-side against normalized execution-task IDs. Extra MCP arguments, tool results, unmatched targets, and surrounding transcript content never enter the browser API.

### Claude Code native naming

Claude Code additionally exposes `rename_session`. The main agent supplies one concise title; a trusted `PreToolUse` hook binds the mutation to the current native `session_id` and preserves any explicit user title. Subagents never rename the main session. If the bridge cannot safely identify or update the session, it fails closed and provider automatic naming remains the fallback.

Codex does not receive this Claude-specific control bridge. Its provider-native automatic task title is the fallback unless Codex exposes another safe title capability.

## Troubleshooting

Start with the provider's doctor command.

- **Policy missing:** run init.
- **Policy invalid or old:** run init and review the proposed version 6 update.
- **Policy marker missing in Codex:** review and trust Pomegr in `/hooks`, then start or resume a task.
- **Policy marker missing in Claude Code:** run `/reload-plugins`, then start or resume a session.
- **A delegated agent did not report:** confirm its normalized type appears under `Delegated agents` and retains the Pomegr MCP tools.
- **One or more tools missing:** inspect `/mcp`, confirm the plugin is enabled, reload or reinstall it, and start a new task or session. Doctor never calls a reporting tool merely to test connectivity.
- **Codex hooks changed after an update:** review and trust the new definitions in `/hooks`.
- **Claude session remains Untitled:** confirm `rename_session` in `/mcp` and the Pomegr rename hook in `/hooks`. Provider automatic naming is the fallback.

For unsupported standalone MCP registrations, use the exact server name `pomegr` and add policy guidance through the host's supported instruction mechanism. The plugin packages are the supported path for automatic policy loading.

## Package layout and validation

The Codex package lives in `plugins/pomegr/`. The Claude Code package lives in `plugins/claude-code/`, with marketplace metadata in `.claude-plugin/marketplace.json`.

Regenerate both self-contained runtimes and run package tests:

```powershell
npm run build:plugin
npm run test:plugin
```

Codex package validation additionally uses the skill and plugin validators:

```powershell
python C:\path\to\skill-creator\scripts\quick_validate.py .\plugins\pomegr\skills\init
python C:\path\to\skill-creator\scripts\quick_validate.py .\plugins\pomegr\skills\doctor
python C:\path\to\plugin-creator\scripts\validate_plugin.py .\plugins\pomegr
```

Validate and exercise Claude Code locally:

```powershell
claude plugin validate .
claude --plugin-dir .\plugins\claude-code
```

Claude and Codex share one plugin release version. Prepare both marketplace packages atomically with the shared release helper:

```bash
./scripts/release-plugin.sh patch
```

Replace `patch` with `minor` or `major` as appropriate. The helper rejects version drift, updates every Claude and Codex plugin manifest and MCP identity to the same version, rebuilds both packages, and restores all affected files if either build fails. The desktop application retains its own independent release version.

Node.js 22.13 or newer must be available for local MCP and hook processes.

## References

### Codex

- [OpenAI plugin skills](https://developers.openai.com/plugins/concepts/skills)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Codex subagents](https://developers.openai.com/codex/subagents)

### Claude Code

- [Create Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)
- [Plugin-provided MCP servers](https://code.claude.com/docs/en/mcp)
