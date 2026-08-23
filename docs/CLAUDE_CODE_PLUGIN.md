# Pomegr reporting plugin for Claude Code

Pomegr ships a self-contained Claude Code plugin for configuring and reporting bounded, repository-specific signals. The plugin installs two skills, a stateless local MCP server, and three hooks — `SessionStart`, `PreToolUse`, and `SubagentStop` — as one unit. Pomegr remains provider-neutral; this package is the Claude Code distribution adapter.

## Install

Add the marketplace hosted by this repository, install the plugin, choose **Project** when Claude Code asks for the installation scope, then reload plugins:

```text
/plugin marketplace add Lecarvalho/pomegr
/plugin install pomegr@pomegr
/reload-plugins
```

Project scope makes the plugin available whenever that repository is opened without putting machine-specific MCP paths in the repository.

For local development from a Pomegr checkout, start Claude Code with:

```powershell
claude --plugin-dir .\plugins\claude-code
```

The plugin's MCP process runs locally over stdio. Its generated single-file runtime includes its npm dependencies and does not import from the client repository, a plugin-root `node_modules`, or the rest of the Pomegr checkout.

## Initialize a repository

Run `/pomegr:init`. The skill first inspects safe repository structure and any existing policy. It then asks which project-specific session, agent, and execution-task states an observer needs to notice, including when each should be replaced or cleared. Generic lifecycle, context, Git, approval, and task metadata already derived by Pomegr should not be duplicated as signals.

Before writing, the skill previews the complete policy or a focused update and asks for confirmation. It creates or updates only `.pomegr/signals.md`; it never adds reporting instructions to `AGENTS.md` or `CLAUDE.md`, and it does not blindly replace an existing policy. The policy is designed to be committed and shared with collaborators.

After initialization, the skill follows the policy immediately. `/pomegr:doctor` provides a read-only validation of the policy, optional `.pomegr/roles.json` display mappings, automatic loading, five expected MCP tools, and packaged files. It does not edit files or emit a signal.

## Repository policy

`.pomegr/signals.md` uses policy version `4` and contains Session naming, Privacy and semantics, Delegated agent tooling, Delegated agents, Session signals, Agent signals, and Task signals sections. Each signal table uses `Label`, `Tone`, `Report when`, and `Replace or clear when`. Labels are bounded plain text, tones are `neutral`, `info`, `positive`, `warning`, or `negative`, and transition conditions must be concrete and observable.

The `Delegated agents` table is the declaration that drives delegation. Each row names a subagent type and what it owns — `agent`, `task`, or `agent and task` — and `*` covers every subagent type. A row may only own a scope that configures at least one signal row, and an empty table means the delegating session keeps all reporting for itself. The table is the sole scope input for both delegation hooks, so a repository that configures no delegated agents pays no per-spawn cost.

The delegated-agent tooling section states the capability half of the invariant. Claude Code subagents inherit MCP tools from the parent, but an agent definition with an explicit `tools` allowlist must include the resolved Pomegr namespace, typically `mcp__plugin_pomegr_pomegr__*`, or the applicable exact tool names. A subagent without those tools must not own agent- or task-signal reporting, and `/pomegr:init` proposes the policy and the agent definitions it depends on in one preview.

Validation backs both halves. When a policy configures agent or task signals, `scripts/policy.mjs` scans `.claude/agents/*.md` and returns a bounded `warnings` entry in either direction: a declared agent type whose explicit allowlist omits a Pomegr tool receives the injected rows and still cannot report, and a definition carrying those tools that no `Delegated agents` row matches never receives them. Warnings name the file only, never its contents, and never change the `valid` status or the exit code. The `SessionStart` hook appends them under a `[Pomegr policy drift]` marker so a session can repair the gap in place, and `/pomegr:doctor` reports them read-only.

Instruction, unlike capability, is not checked in the definition at all. A definition is commonly a thin frontmatter wrapper over a canonical body elsewhere, so a scan of the wrapper proves nothing about what the agent was told. The delegation hook supplies the instruction at spawn time instead, which makes the wrapper question moot.

The naming, privacy, and delegated-agent tooling sections are canonical policy and must remain identical to the plugin template. Repository-owned customization belongs in the three signal tables. Session and agent rows must define replacement or clearing; task rows must state that their outcomes are durable and cannot be cleared.

The policy requires Claude Code to use its native automatic session naming after substantive work. Pomegr does not expose a title-reporting tool, does not ask the user to run `/rename`, and does not replace an explicit native title. An idle session may remain Untitled.

Signals are agent-reported guidance and may become stale; they are not authoritative Pomegr judgments. Policies and reports must never contain prompts, responses, secrets, credentials, raw commands, stdout, stderr, tool results, or sensitive repository content.

## Automatic policy loading

The plugin registers a native Claude Code `SessionStart` hook for startup, resume, fork, clear, and compaction. `SessionStart` is a client lifecycle event, not a Pomegr signal.

At each event, the hook searches upward from the working directory to the repository root for `.pomegr/signals.md`, validates its structure and size, and injects a bounded copy through `additionalContext`. This keeps the policy active in every session, including after compaction, without modifying repository-wide agent instruction files.

- A missing policy means repository-specific reporting is inactive.
- A malformed or oversized policy produces a safe, non-blocking warning recommending `/pomegr:doctor`.
- An unavailable MCP server never blocks the coding session.

## Delegation

`SessionStart` context does not reach a subagent. A subagent inherits the parent's MCP tools and starts with its own context, so a delegated agent could hold the Pomegr tools, match a configured row, and have no idea it was supposed to report. Asking the delegating session to paste the rows made that a per-call discipline requirement with no trigger and no feedback, so the plugin mechanizes it in two layers.

**Injection.** A `PreToolUse` hook matching `Task|Agent` — the subagent-spawning tool is named differently across harnesses — reads the spawn's `subagent_type`, resolves the policy from the hook's `cwd`, and returns the prompt with the applicable rows appended through `updatedInput`. The appended block opens with the marker `[Pomegr delegated reporting policy]` and carries only the owned signal tables plus the privacy and transition rules. It is:

- **Scoped.** Nothing is appended unless a `Delegated agents` row matches the spawned type, so an uninvolved repository or agent type is untouched.
- **Idempotent.** The hook skips a prompt that already carries the marker, and also one that mentions Pomegr and already contains every applicable label, so a manually pasted copy is not duplicated.
- **Silent on forks.** A fork inherits the parent's context and already has the policy.
- **Non-escalating.** The hook returns `updatedInput` only. It sets no `permissionDecision`, so subagent spawns keep their normal permission behavior.

**Detection.** A `SubagentStop` hook receives `agent_type` and `transcript_path`. When the stopping agent's type is declared and its transcript contains no `report_agent_signal`, `report_task_signal`, or `clear_agent_signal` call in the Pomegr namespace, the hook emits a `systemMessage` naming the agent type and the configured labels it did not use.

The detector reports a miss; it never infers the verdict. Pomegr's signals are current state rather than guesses, so a wrong signal is worse than a missing one. The hook does not block the subagent's stop either: a subagent's final message is its return value, and forcing an extra turn could corrupt it. An unreadable or oversized transcript, and a re-entrant `stop_hook_active` invocation, both stay silent.

Both hooks exit `0` with no output on a missing, invalid, or unrelated policy, and a malformed hook payload is ignored.

## MCP tools and signal lifetime

The plugin provides five tools:

| Tool | Effect |
| --- | --- |
| `report_session_signal` | Reports or replaces the overall session's current label, tone, and optional description. |
| `report_agent_signal` | Reports or replaces the calling agent's current label, tone, and optional description. |
| `report_task_signal` | Records a durable outcome for a recognized execution-task ID. |
| `clear_session_signal` | Removes the overall session's current agent-reported signal. |
| `clear_agent_signal` | Removes the calling agent's current agent-reported signal. |

A label such as `Idle`, `Blocked`, or `Needs input` is a visible semantic state, not an absence of state. It remains visible until a later report replaces it or the matching clear tool removes it. Clearing means that no agent-reported state is currently meaningful for that scope. Task signals are durable outcomes and cannot be cleared; a later task report for the same recognized execution task may replace one.

The MCP server is stateless. Report and clear calls are recorded in the provider transcript, and Pomegr reconstructs them chronologically for live and historical views. A clear becomes `null` in the existing normalized browser shape, so the browser API does not expose raw clear events or new control fields.

Pomegr derives reporting ownership and timestamps from transcript evidence. Task targets are resolved monitor-side against normalized Bash tool-use or background-task IDs. Unmatched task targets, extra MCP arguments, tool results, and surrounding transcript content never enter the browser API.

## Troubleshooting

Start with `/pomegr:doctor`. Its checklist distinguishes these common cases:

- **Policy missing:** run `/pomegr:init`. Reporting remains inactive until a policy exists.
- **Policy invalid or oversized:** review the bounded validation errors with `/pomegr:init`; the hook does not inject invalid content.
- **Policy not loaded in the current context:** run `/reload-plugins`, then start or resume a session so the `SessionStart` hook runs.
- **A subagent finished without reporting:** confirm its type has a `Delegated agents` row and that its `tools` allowlist reaches the Pomegr namespace. `/pomegr:doctor` lists the declared rows and the drift warnings for both gaps.
- **One or more MCP tools missing:** inspect Claude Code's `/mcp` view and reload the plugin. Doctor does not call a reporting tool merely to test connectivity.
- **Session remains Untitled:** native naming occurs after substantive interaction; an idle session is allowed to remain Untitled.

For unsupported standalone/manual installations, the repository's MCP server can still be registered directly under the exact server name `pomegr`. In that mode, add policy guidance through the host's supported instruction mechanism because the plugin hook is absent. The bundled plugin is the supported path for automatic policy loading.

## Deferred Pomegr queries

V1 is reporting-only. It intentionally does not include `report_session_title`, a policy-status MCP tool, or a generic natural-language `ask_pomegr` tool.

A separately scoped milestone may add authenticated, structured read-only queries for the current context snapshot, provider-reported usage limits, deterministic attention signals, and a normalized session overview. That bridge must use a short-lived local capability and an unambiguous current-session reference. It must not expose the desktop monitor token, raw transcripts, prompts, responses, commands, credentials, cumulative context spent, or token-spend totals.

## Package layout and validation

The marketplace metadata lives in `.claude-plugin/marketplace.json`; the installable package lives in `plugins/claude-code/` with its own manifest, MCP configuration, skills, hooks, scripts, and runtime.

Before publishing a change, regenerate the self-contained MCP runtime, then validate and exercise the package from the repository root:

```powershell
npm run build:plugin
claude plugin validate .
claude --plugin-dir .\plugins\claude-code
```

For a marketplace release, use the transactional version helper with a semantic-version increment:

```bash
./scripts/release-claude-plugin.sh patch
```

Replace `patch` with `minor` or `major` as appropriate. The helper updates both plugin manifests, synchronizes the version reported by the MCP server, rebuilds `plugins/claude-code/mcp/server.bundle.mjs`, and restores the previous files if any step fails. Commit and push the resulting release files before asking clients to update.

Then initialize a clean repository, begin substantive work, verify native naming, report and clear session and agent signals, report a task outcome, compact or resume the session, and run `/pomegr:doctor`.

## References

- [Create Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)
- [Plugin-provided MCP servers](https://code.claude.com/docs/en/mcp)
