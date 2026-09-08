# Pomegr plugins

Pomegr ships self-contained plugins for Codex and Claude Code. Both adapters configure and report the same bounded, repository-specific signals and can query committed Pomegr observations through a local MCP server. Pomegr remains provider-neutral: provider names and lifecycle details belong only to the distribution adapter.

| Capability | Codex | Claude Code |
| --- | --- | --- |
| Repository initialization | `$pomegr:init` | `/pomegr:init` |
| Read-only diagnosis | `$pomegr:doctor` | `/pomegr:doctor` |
| Automatic policy loading | `SessionStart` hook | `SessionStart` hook |
| Optional usage guard | Advisory `SessionStart` and `PostToolUse` hooks | Advisory `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `PostToolBatch` hooks |
| Delegated policy injection | `SubagentStart` hook | `PreToolUse` hook for `Task\|Agent` |
| Delegated-report detection | `SubagentStop` hook | `SubagentStop` hook |
| Signal and progress tools | Seven shared tools | Seven shared tools |
| Observation query tools | Six shared tools | Six shared tools |
| Native session-title tool | Provider automatic naming | `rename_session` |

Neither plugin sends transcript contents or provider credentials to Pomegr. Observation queries use a separate local, read-only capability and return only bounded normalized evidence. The generated MCP runtimes include their npm dependencies and do not import from the client repository, plugin-root `node_modules`, or the rest of the Pomegr checkout.

## Install

### From Pomegr desktop

Open **Repositories**, select a repository row, then open **Setup** and find
**Pomegr plugin** under its provider. The index summarizes setup and offers
**Needs attention** and **Live now** filters. Pomegr automatically checks local
installation records and configuration.
The row shows the installed version, enablement, scope, and last check. **Recheck**
refreshes local evidence; it respects the separate marketplace request cooldown.
**Install plugin** and **Update plugin** appear only when the official source and
target can be verified. A native confirmation shows the repository, provider,
installation scope, and current-to-target version before the installed provider CLI
is invoked. The result is verified from local records before completion is reported.

Update availability compares with the published manifest in the official Pomegr
marketplace at the configured ref, with one-hour caching and five-minute failure
backoff. Pins are preserved; a pin is not silently switched to `main`. An unavailable
update check retains the installed version. Unknown local formats, conflicting
sources, or ambiguous cache versions show **Unable to verify**. Disabled Codex
installations require manual updating because its add command may enable a plugin.

**Repository reporting** is shared by both providers and appears in **Setup** and
the **Reporting** tab. **Configure reporting** opens the init guidance in Setup;
Reporting always shows that guidance. It does not silently create or replace a policy.
Browser and phone clients show setup instructions, while changes run through the
local desktop. Reload Claude Code plugins or restart Codex and review its hooks as
described below. Running and historical sessions continue to show the version they
actually loaded, even after the on-disk installation changes.

### Codex

Register this Git repository as a marketplace and install Pomegr:

```powershell
codex plugin marketplace add Lecarvalho/pomegr --ref main
codex plugin add pomegr@pomegr
```

Restart Codex and start a new task so the installed skills, hooks, and tools are discovered. Open `/hooks`, review the Pomegr hook definitions, including the SessionStart policy hook, and trust them. Plugin hooks are not trusted automatically, and changed definitions require review again.

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

The init skill is the authoring workflow: it inspects, proposes, confirms, writes, and validates. Its policy template is the runtime artifact copied into `.pomegr/signals.md` and loaded into later sessions. MCP tool descriptions remain the argument contract; the policy maps configured repository states to provider-neutral tool suffixes.

Before writing, the skill previews the complete policy or a focused diff and asks for confirmation. It creates or updates `.pomegr/signals.md`. It does not add reporting instructions to `AGENTS.md`, and it does not blindly replace an existing policy. Generic lifecycle, context, Git, approval, plan-task, and execution-task metadata already derived by Pomegr should not be duplicated as signals.

The Codex skill changes `.pomegr/signals.md` and, when explicitly requested, `.pomegr/usage-guard.json`. The optional guard configuration is supported by both skills; neither creates handoff files nor changes ignore rules. The Claude Code skill may also update explicit `tools` allowlists in `.claude/agents/*.md` when a confirmed delegated-reporting choice requires Pomegr access; those definition edits appear in the same preview.

Use `$pomegr:doctor` in Codex or `/pomegr:doctor` in Claude Code for a read-only checklist. Doctor validates the policy, loading marker, delegated-agent coverage, expected tools, packaged files, and optional `.pomegr/roles.json` display mappings. It does not edit files, invoke a report or clear tool, rename a session, or emit a diagnostic signal.

## Shared repository policy

`.pomegr/signals.md` uses provider-neutral policy version `7`. A policy initialized by either adapter works with both. Legacy version `6` remains accepted as signals-only with Session progress disabled. The current template contains these sections:

- Session naming
- Privacy and semantics
- Tool suffixes
- Delegated agent tooling
- Session progress
- Delegated agents
- Session signals
- Agent signals
- Task signals

The `Tool suffixes` section maps each configured scope to its report or clear action. Earlier valid version 7 policies may omit this explanatory section; their MCP tool descriptions provide the same generic behavior.

Signal tables use `Label`, `Tone`, `Report when`, and `Replace or clear when`. Labels are bounded plain text; tones are `neutral`, `info`, `positive`, `warning`, or `negative`; transition conditions must be concrete and observable. Session and agent rows state when they are replaced or cleared. Task outcomes are durable and cannot be cleared.

The `Delegated agents` table names each normalized agent type and whether it owns `agent`, `task`, or `agent and task` reporting. `*` matches every type. A row may own only a scope with at least one configured signal. An empty table keeps all reporting in the main session.

Every signal-owning agent must retain access to the Pomegr MCP server and applicable reporting tools. Provider-specific MCP prefixes are not part of the policy.

`Session progress` is opt-in and defaults to `- Enabled: no`. When enabled, an all-tool `PostToolUse` hook observes only root-session metadata and reminds the agent after both 10 minutes and 3 qualifying tool completions without a progress report. It ignores subagents and Pomegr report, clear, and rename tools; it never reads tool input or output. A progress report resets the window, and clearing progress suppresses reminders until later activity.

Signals are agent-reported guidance and may become stale; they are not authoritative Pomegr judgments. Policies and reports must never contain prompts, responses, secrets, credentials, raw commands, stdout, stderr, tool results, transcript paths, hook payloads, or sensitive repository content.

## Automatic policy loading

Both packages register `SessionStart`. The hook searches upward from its working directory to the repository root for `.pomegr/signals.md`, validates the file, and returns a bounded copy as additional context under `[Pomegr reporting policy loaded]`. A compact fixed reminder identifies observation queries as decision-triggered and cautions against polling or causal interpretation; it does not change the repository policy schema.

Every `SessionStart` also emits one bounded `[Pomegr plugin metadata]` line containing only the installed plugin version, policy status (`valid`, `invalid`, or `missing`), and recognized policy version. Pomegr accepts that line only from provider-owned hook context, records the provider transcript timestamp as the observation time, and never treats an absent observation as proof that the plugin is uninstalled. Historical views retain the version and policy state observed in that session rather than substituting the current machine configuration.

Both packages also register an all-tool `PostToolUse` reminder hook. Reminder state is stored only as bounded version, timestamp, and counter records under provider plugin data, with SHA-256 session filenames, owner-only permissions, atomic writes, 30-day expiry, and a 256-file cap. Missing, disabled, malformed, or unwritable policy/data suppresses reminders and never blocks a session.

- A missing policy means repository-specific reporting is inactive.
- An invalid, unsafe, or oversized policy produces only a bounded, non-blocking doctor recommendation.
- An unavailable MCP server never blocks the coding session.

Codex runs the hook for startup, resume, clear, and compaction. Claude Code also covers forks; a fork already carries inherited context and is excluded from separate delegated-row injection.

## Optional usage guard

The usage guard is off unless a repository explicitly creates `.pomegr/usage-guard.json`. Installing or updating a plugin never creates or activates it. When enabled, it reads only Pomegr's already-committed, cached usage observations at a bounded cadence. It does not persist hook stdin, prompt text, tool input or output, credentials, account identifiers, or handoff notes.

The version-1 configuration is deliberately narrow:

```json
{
  "version": 1,
  "mode": "advisory",
  "checkIntervalSeconds": 60,
  "warnAt": 70,
  "handoffAt": 80,
  "stopAt": 90,
  "concurrencyReservePercent": 5,
  "maxConcurrencyReservePercent": 15
}
```

`mode` accepts `advisory` or `off`; a missing file is off. `checkIntervalSeconds` is at least 60 seconds. The guard uses fixed comparisons of cached common account quota windows, including the five-hour and weekly windows where supplied. It may make a separate model-window caution, but cannot prove the current model, account, or remaining capacity. It makes no context-window or cache-lifetime prediction. It counts only locally observed executing work on the same machine and provider; idle and activity-unknown sessions are excluded, and this is not evidence that those sessions share a billing account.

For a cached local working-session count `w`, the guard advances every threshold by this reserve: `min(maxConcurrencyReservePercent, max(0, w - 1) * concurrencyReservePercent)`. It subtracts that result from `warnAt`, `handoffAt`, and `stopAt`; it never changes the observed percentage. The count is bounded before catalog-listing truncation, so a truncated listing is only a bounded lower count, never a proof of a complete machine or account inventory.

Warnings are deterministic heuristics and recommendations, never Pomegr judgments or confirmed quota state. At the handoff threshold the advice asks the agent to write the goal, decisions, changed files, tests, and next steps using the repository's existing handoff workflow before voluntarily stopping. Pomegr never reads or ingests those contents. The guard does not block a prompt or tool call, force a stop, reserve quota, or resume work automatically. Unknown, stale, unavailable, rejected, or reset-time observations do not fabricate recovery or capacity.

Codex uses the supported `SessionStart` and `PostToolUse` advisory hooks. Claude Code 2.1.263 also supports `UserPromptSubmit` and `PostToolBatch`; its package registers both, while the runtime deduplicates overlapping post-tool checks. Trust the added hook definitions through the provider's hook review flow before relying on the guard.

The hook keeps only a bounded, hashed per-provider/session/agent record beneath `usage-guards` in the Pomegr data root: version, stage, last-check time, and configuration hash. Persistent records are capped at 256 for 30 days; stale locks and temporary coordination files are cleaned up, while concurrently active transient files are not part of that cap. All guard events, including `SessionStart` after a resume, respect the configured cadence. Routine due checks emit pressure only when the stage changes; a due SessionStart can repeat current pressure to refresh resumed context: the first missing, stale, or otherwise unknown reading may warn once, but unchanged low, unknown, and threshold stages do not produce periodic reminder noise. It stores no usage response, hook payload, prompt, tool content, path, or handoff text. Handoff guidance follows each repository's existing workflow, location, format, and privacy/version-control conventions. Pomegr does not impose a handoff directory or modify ignore rules. If no workflow is defined, the agent leaves a concise handoff in the conversation instead of creating a new directory. Pomegr does not create, read, or ingest handoffs.

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
| `report_session_progress` | Publishes the root agent's latest bounded progress estimate and resets the opt-in reminder window. |
| `clear_session_progress` | Removes the current progress estimate and suppresses reminders until later qualifying root-session activity. |

A visible label remains until a later report replaces it or the matching clear tool removes it. Clearing means no agent-reported state is currently meaningful for that scope. Task signals cannot be cleared; a later report for the same recognized task may replace one.

The MCP server is stateless. Pomegr reconstructs reports and clears chronologically from provider transcript evidence. Task targets are resolved monitor-side against normalized execution-task IDs. Extra MCP arguments, tool results, unmatched targets, and surrounding transcript content never enter the browser API.

## Observation query tools

Both plugins also provide `get_provider_health`, `get_usage_limits`,
`list_sessions`, `list_session_agents`, `get_agent_context`, `get_recent_failures`,
and `get_session_report`. These tools read only committed monitor projections. They
are intended for decisions whose outcome may change based on current provider
health, account limits, retained agent context, or normalized failures; they are
not a polling interface or a required session-start checklist.

Session-specific queries default to the validated current-session identity supplied by
the Codex or Claude Code host to the stdio MCP subprocess. `get_agent_context` also
defaults to the main agent, `primary`. Optional exact references from `list_sessions`
and `list_session_agents` remain available for historical or delegated inspection.
`get_session_report` takes no arguments and returns the same bounded Markdown as the
dashboard download. No tool infers the current session from the working directory or
recency. If Pomegr is not running or the host identity is unavailable, queries return
unavailable without launching it or affecting the existing reporting tools.

The complete contracts, evidence qualifications, and local transport boundary are
documented in [MCP observation queries](MCP_QUERIES.md).

### Claude Code native naming

Claude Code additionally exposes `rename_session`. The main agent supplies one concise title; a trusted `PreToolUse` hook binds the mutation to the current native `session_id` and preserves any explicit user title. Subagents never rename the main session. If the bridge cannot safely identify or update the session, it fails closed and provider automatic naming remains the fallback.

Codex does not receive this Claude-specific control bridge. Its provider-native automatic task title is the fallback unless Codex exposes another safe title capability.

## Troubleshooting

Start with the provider's doctor command.

- **Policy missing:** run init.
- **Policy invalid or old:** run init and review the proposed version 7 update; version 6 is accepted but keeps progress disabled.
- **Policy marker missing in Codex:** review and trust Pomegr in `/hooks`, then start or resume a task.
- **Policy marker missing in Claude Code:** run `/reload-plugins`, then start or resume a session.
- **A delegated agent did not report:** confirm its normalized type appears under `Delegated agents` and retains the Pomegr MCP tools.
- **One or more tools missing:** inspect `/mcp`, confirm the plugin is enabled, reload or reinstall it, and start a new task or session. Doctor never calls a reporting tool merely to test connectivity.
- **Codex hooks changed after an update:** review and trust the new definitions in `/hooks`.
- **Claude session remains Untitled:** confirm `rename_session` in `/mcp` and the Pomegr rename hook in `/hooks`. Provider automatic naming is the fallback.

For unsupported standalone MCP registrations, use the exact server name `pomegr` and add policy guidance through the host's supported instruction mechanism. The plugin packages are the supported path for automatic policy loading.

## Package layout and validation

### Skill changes

Canonical skill content lives in `plugin-src/skills/`. The Codex package lives in `plugins/pomegr/`; the Claude Code package lives in `plugins/claude-code/`, with marketplace metadata in `.claude-plugin/marketplace.json`.

Edit the canonical `SKILL.md.tmpl` files and shared policy template, not the generated package copies. Provider blocks use `{{#codex}}...{{/codex}}` and `{{#claude}}...{{/claude}}`. `npm run build:plugin` renders both self-contained packages and marks generated `SKILL.md` files as artifacts that should not be edited directly.

Regenerate both self-contained runtimes and run package tests:

```powershell
npm run build:plugin
npm run test:plugin
```

After generation, Codex package validation additionally uses the skill and plugin validators:

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

### Plugin upgrade

Claude and Codex share one plugin release version. Prepare both marketplace packages atomically with the shared release helper:

```bash
./scripts/release-plugin.sh patch
```

Replace `patch` with `minor` or `major` as appropriate. The helper rejects version drift, updates every Claude and Codex plugin manifest and MCP identity to the same version, rebuilds both packages, and restores all affected files if either build fails. Run `npm run test:plugin`, review the complete generated diff, then commit and push all release changes together. The helper prints the provider-specific client upgrade commands. The desktop application retains its own independent release version.

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
