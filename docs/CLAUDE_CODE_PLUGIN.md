# Threadlight reporting plugin for Claude Code

Threadlight ships a self-contained Claude Code plugin for configuring and reporting bounded, repository-specific signals. The plugin installs two skills, a stateless local MCP server, and a `SessionStart` hook as one unit. Threadlight remains provider-neutral; this package is the Claude Code distribution adapter.

## Install

Add the marketplace hosted by this repository, install the plugin, choose **Project** when Claude Code asks for the installation scope, then reload plugins:

```text
/plugin marketplace add Lecarvalho/threadlight
/plugin install threadlight@threadlight
/reload-plugins
```

Project scope makes the plugin available whenever that repository is opened without putting machine-specific MCP paths in the repository.

For local development from a Threadlight checkout, start Claude Code with:

```powershell
claude --plugin-dir .\plugins\claude-code
```

The plugin's MCP process runs locally over stdio. Its packaged runtime and dependencies do not import from the rest of the Threadlight checkout.

## Initialize a repository

Run `/threadlight:init`. The skill first inspects safe repository structure and any existing policy. It then asks which project-specific session, agent, and execution-task states an observer needs to notice, including when each should be replaced or cleared. Generic lifecycle, context, Git, approval, and task metadata already derived by Threadlight should not be duplicated as signals.

Before writing, the skill previews the complete policy or a focused update and asks for confirmation. It creates or updates only `.threadlight/signals.md`; it never adds reporting instructions to `AGENTS.md` or `CLAUDE.md`, and it does not blindly replace an existing policy. The policy is designed to be committed and shared with collaborators.

After initialization, the skill follows the policy immediately. `/threadlight:doctor` provides a read-only validation of the policy, automatic loading, five expected MCP tools, and packaged files. It does not edit files or emit a signal.

## Repository policy

`.threadlight/signals.md` uses policy version `1` and contains Session naming, Privacy and semantics, Session signals, Agent signals, and Task signals sections. Each signal table uses `Label`, `Tone`, `Report when`, and `Replace or clear when`. Labels are bounded plain text, tones are `neutral`, `info`, `positive`, `warning`, or `negative`, and transition conditions must be concrete and observable.

The naming and privacy sections are canonical safety policy and must remain identical to the plugin template. Repository-owned customization belongs in the three signal tables. Session and agent rows must define replacement or clearing; task rows must state that their outcomes are durable and cannot be cleared.

The policy requires Claude Code to use its native automatic session naming after substantive work. Threadlight does not expose a title-reporting tool, does not ask the user to run `/rename`, and does not replace an explicit native title. An idle session may remain Untitled.

Signals are agent-reported guidance and may become stale; they are not authoritative Threadlight judgments. Policies and reports must never contain prompts, responses, secrets, credentials, raw commands, stdout, stderr, tool results, or sensitive repository content.

## Automatic policy loading

The plugin registers a native Claude Code `SessionStart` hook for startup, resume, fork, clear, and compaction. `SessionStart` is a client lifecycle event, not a Threadlight signal.

At each event, the hook searches upward from the working directory to the repository root for `.threadlight/signals.md`, validates its structure and size, and injects a bounded copy through `additionalContext`. This keeps the policy active in every session, including after compaction, without modifying repository-wide agent instruction files.

- A missing policy means repository-specific reporting is inactive.
- A malformed or oversized policy produces a safe, non-blocking warning recommending `/threadlight:doctor`.
- An unavailable MCP server never blocks the coding session.

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

The MCP server is stateless. Report and clear calls are recorded in the provider transcript, and Threadlight reconstructs them chronologically for live and historical views. A clear becomes `null` in the existing normalized browser shape, so the browser API does not expose raw clear events or new control fields.

Threadlight derives reporting ownership and timestamps from transcript evidence. Task targets are resolved monitor-side against normalized Bash tool-use or background-task IDs. Unmatched task targets, extra MCP arguments, tool results, and surrounding transcript content never enter the browser API.

## Troubleshooting

Start with `/threadlight:doctor`. Its checklist distinguishes these common cases:

- **Policy missing:** run `/threadlight:init`. Reporting remains inactive until a policy exists.
- **Policy invalid or oversized:** review the bounded validation errors with `/threadlight:init`; the hook does not inject invalid content.
- **Policy not loaded in the current context:** run `/reload-plugins`, then start or resume a session so the `SessionStart` hook runs.
- **One or more MCP tools missing:** inspect Claude Code's `/mcp` view and reload the plugin. Doctor does not call a reporting tool merely to test connectivity.
- **Session remains Untitled:** native naming occurs after substantive interaction; an idle session is allowed to remain Untitled.

For unsupported standalone/manual installations, the repository's MCP server can still be registered directly under the exact server name `threadlight`. In that mode, add policy guidance through the host's supported instruction mechanism because the plugin hook is absent. The bundled plugin is the supported path for automatic policy loading.

## Deferred Threadlight queries

V1 is reporting-only. It intentionally does not include `report_session_title`, a policy-status MCP tool, or a generic natural-language `ask_threadlight` tool.

A separately scoped milestone may add authenticated, structured read-only queries for the current context snapshot, provider-reported usage limits, deterministic attention signals, and a normalized session overview. That bridge must use a short-lived local capability and an unambiguous current-session reference. It must not expose the desktop monitor token, raw transcripts, prompts, responses, commands, credentials, cumulative context spent, or token-spend totals.

## Package layout and validation

The marketplace metadata lives in `.claude-plugin/marketplace.json`; the installable package lives in `plugins/claude-code/` with its own manifest, MCP configuration, skills, hooks, scripts, and runtime.

Before publishing a change, validate and exercise the package from the repository root:

```powershell
claude plugin validate .
claude --plugin-dir .\plugins\claude-code
```

Then initialize a clean repository, begin substantive work, verify native naming, report and clear session and agent signals, report a task outcome, compact or resume the session, and run `/threadlight:doctor`.

## References

- [Create Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)
- [Plugin-provided MCP servers](https://code.claude.com/docs/en/mcp)
