# Provider tool inventory

> Scope: every tool identity and rollout item Pomegr has seen from Claude Code and Codex,
> the work kind each one gets, and what is deliberately not read.
> Authority: reference inventory. [Metrics](metrics.md#tool-calls) owns the
> classification rules; `server/normalize/work-kind.mjs` and the adapter modules are the
> executable owners.
> Related code and checks: `tests/server/normalize/work-kind.test.mjs` and
> `tests/server/providers/codex/activity-events.test.mjs`.

Coding harnesses add, rename, and restructure tools between releases. This page records
what was true when it was last taken, so a change in a new harness version can be found
by comparing against it.

| Provider | Versions covered | Taken | Evidence |
| --- | --- | --- | --- |
| Claude Code | Tool set of the session current on the date taken | 2026-10-01 | Tool definitions of a live session; not a transcript survey |
| Codex | 0.144.1 to 0.159.2 | 2026-10-01 | 2,180 local rollouts since 2026-08-15; identities only |

A tool absent from this page was not observed. It is not known to be unsupported.

## How a tool gets its kind

1. A **shell tool** (`Bash`, `PowerShell`, Codex `Shell`) is classified by its private
   command structure. A program counts only where a command can start: the start of the
   text or a line, or after `;`, `&`, `|`, `(`, `{`, or an `=` assignment. A program name inside a quoted
   string or an argument never classifies the command. Git is classified by its
   subcommand, after any global options.
2. A **carrier** (a Claude `mcp__<server>__<tool>` name, or a Codex `MCP` or `Dynamic tool`
   row) is **Integration**, unless its exact identity is allowlisted below. An MCP tool
   name is third-party text and never classifies by resemblance.
3. Any other tool is looked up by its **exact name** in one table. Its detail (a file name,
   a description, a task subject) never decides the kind.
4. A tool that matches nothing is **Other**. It is never guessed.

### Carrier allowlist

| Identity | Kind |
| --- | --- |
| Server name containing `pomegr`, tool `report_session_progress`, `report_session_signal`, `report_agent_signal`, `report_task_signal`, `clear_session_progress`, `clear_session_signal`, or `clear_agent_signal` | Reports |
| Server `github`, or a tool name starting with `github`, whose tool name contains the word `pr`, `prs`, or `pull request` | Pull requests |

## Claude Code tools

| Kind | Tools |
| --- | --- |
| Shell, by command | `Bash`, `PowerShell` |
| Reading | `Read`, `NotebookRead` |
| Editing | `Write`, `Edit`, `MultiEdit`, `NotebookEdit` |
| Searching | `Grep`, `Glob`, `LS`, `ToolSearch` |
| Web | `WebFetch`, `WebSearch` |
| Agents | `Agent`, `Task`, `Workflow`, `SendMessage`, `ListAgents` |
| Planning | `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `TodoWrite`, `TodoRead`, `EnterPlanMode`, `ExitPlanMode` |
| Processes | `TaskStop`, `TaskOutput`, `BashOutput`, `KillShell`, `KillBash` |
| Waiting | `Monitor`, `ScheduleWakeup` |
| Git | `EnterWorktree`, `ExitWorktree` |
| Skills | `Skill` |
| Input | `AskUserQuestion` |
| Transfer | `SendUserFile` |
| Integration | Every `mcp__*` tool outside the allowlist, including browser automation |
| Other | `Artifact`, `SendFeedback`, `ReportFindings`, `CronCreate`, `CronList`, `CronDelete`, `PushNotification`, `RemoteTrigger`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, and any unlisted tool |

Rows that are not tool calls: **User input** (Input), **Assistant replied** and
**Summary updated** (Replies), and **Task completed**, **Task failed**, **Task stopped**
(the kind of the launching tool). They are listed in Activity and never counted in a
by-kind aggregate.

## Codex tools

Codex records a tool in up to three places: a `response_item` function or custom tool
call, a legacy `event_msg` begin/end pair, and a completed `item_completed` item. Since
code mode (the `exec` custom tool), most work appears only as completed items inside
the wrapper call.

### Function and custom tool calls

| Recorded name | Namespace | Row label | Kind |
| --- | --- | --- | --- |
| `exec` (custom tool) | | Dynamic tool | Integration; a wrapper, counted only when no nested item was recorded |
| `exec_command`, `shell_command`, `local_shell_call` | | Shell | By command |
| `apply_patch` | | File change | Editing |
| `write_stdin` | | Shell input | Processes |
| `wait` with a `cell_id` argument | | Wait | Waiting |
| `wait`, `wait_agent` | `collaboration` | Wait for agent | Waiting |
| `sleep` | `clock` | Wait | Waiting |
| `spawn_agent` | `collaboration` | Spawn agent | Agents |
| `send_message`, `send_input`, `followup_task` | `collaboration` | Send to agent | Agents |
| `resume_agent` | `collaboration` | Resume agent | Agents |
| `interrupt_agent`, `close_agent` | `collaboration` | Stop agent | Agents |
| `list_agents` | `collaboration` | List agents | Agents |
| `request_user_input`, `request_user_input_async` | | Request input | Input |
| `send_user_message_async` | | Message to user | Replies |
| `update_plan` | | Plan update | Planning |
| `view_image` | | View image | Images |
| `image_gen`, `image_generation_call` | | Image generation | Images |
| `web_search`, `web_search_call` | | Web search | Web |
| `tool_search`, `tool_search_call` | | Tool search | Searching |
| Any name | `mcp__<server>` | MCP | Carrier rule |
| Any other name | Any | Dynamic tool | Integration |

### Completed items

| Item type | Read | Row label | Kind |
| --- | --- | --- | --- |
| `CommandExecution` | Yes | Shell | By command |
| `FileChange` | Yes | File change | Editing |
| `McpToolCall` | Yes | MCP | Carrier rule |
| `DynamicToolCall` | Yes | Dynamic tool | Integration |
| `CollabAgentToolCall` | Yes | As the collaboration tool above | Agents or Waiting |
| `ImageView` | Yes | View image | Images |
| `WebSearch` | Yes | Web search | Web |
| `Extension`, kind `web.search` | Yes | Web search | Web |
| `Extension`, kind `image_gen.generation` | Yes | Image generation | Images |
| `Extension`, kind `clock.sleep` | Yes | Wait | Waiting |
| `Extension`, any other kind | No | | Unrecognized; add it here when it appears |
| `AgentMessage` | As a reply row | Assistant replied | Replies |
| `Plan` | No | | Plan-mode text, not a tool call |
| `Reasoning`, `UserMessage`, `ContextCompaction`, `SubAgentActivity`, `FunctionCallOutput` | No | | Not tool calls |

An item whose `id` equals a recorded call's `call_id` is the same row. Observed pairs:
`clock.sleep` with its `sleep` call, `CollabAgentToolCall` with `wait_agent`, and
`McpToolCall` with a namespaced `mcp__<server>` call.

### MCP servers observed

`codex_app`, `codex_apps` (GitHub connector, tool names prefixed `github.`), `cua_repl`,
`node_repl`, `openaiDeveloperDocs`, and `pomegr`. All are Integration except the
allowlisted Pomegr reporting tools and the GitHub pull-request tools.

### Command shape

Every observed `CommandExecution.command` is a launcher argument array:
`[pwsh.exe | powershell.exe | bash.exe | cmd.exe, (-NoProfile,) -Command | -c | -lc | /c, <script>]`.
The script is classified as its own line. `parsed_cmd` was `unknown` for 92% of commands
and `read` for the rest, so it is not used as a classification source.

## Take the inventory again

Re-take it when a harness release changes tool calls, or when **Other** or **Integration**
grows without an obvious cause. A probe that reads provider transcripts is temporary: print
identities only (record types, tool names, namespaces, item types, key names), never
arguments or output, and delete the probe when the page is updated. Then:

1. Add each new identity to the tables above with its kind, or to the not-read rows with
   the reason.
2. Add the exact name to `TOOL_KINDS` in `server/normalize/work-kind.mjs`, or the item
   type to `server/providers/codex/execution-items.mjs`, with a test.
3. Bump the adapter's normalization revision so committed checkpoints are rebuilt, and
   update the versions row at the top of this page.
