# Metrics and deterministic rules

Threadlight currently makes no model calls. Every value and recommendation comes from recorded data and fixed rules.

## Context usage

Assistant usage is deduplicated by provider message ID. The latest context snapshot is:

```text
input_tokens
+ cache_creation_input_tokens
+ cache_read_input_tokens
+ output_tokens
```

Zero-valued synthetic messages are ignored.

- **Agent context** — latest snapshot for that agent
- **All-agent context** — sum of every visible agent's latest snapshot

## Estimated API cost

Threadlight does not calculate cost from transcript tokens. When explicitly connected through the status-line bridge, it displays Claude Code's client-side `cost.total_cost_usd` session estimate. The bridge persists only the normalized session ID, non-negative USD amount, estimate type, and local observation time under `~/.threadlight/cost-snapshots`; all other status-line fields are discarded.

The value is cumulative for the Claude Code session and is the only cumulative spend-like value Threadlight presents. It is labeled **Estimated API cost** because Claude Code calculates it at standard API list rates and it may differ from an actual bill. A historical session shows its last captured estimate; if no snapshot was captured, cost remains unavailable rather than being reconstructed from transcript throughput.

All-agent context is the only context total Threadlight presents. The dashboard, normalized browser API, agent details, context composition, and generated Markdown reports use only the latest snapshots or sums derived from them. Cumulative transcript-throughput and token-spend session totals remain excluded.

## Context-growth timeline

The context-growth timeline derives each interval from the same snapshots used by All-agent context. At every bucket boundary, Threadlight carries forward each agent's latest non-zero snapshot, sums those snapshots, and compares that sum with the preceding boundary. A bar shows only a positive net increase. Repeated snapshots contribute zero, and context reductions caused by compaction or agent resets are not presented as new context.

Bucket sizes are selected from fixed, human-readable intervals to target roughly 28 bars across the recorded session wall time. Each bar is attributed across uncached input, cache write, cache read, and generated output. Because components can move between cache categories, positive component changes are scaled to the net context increase so their stack can never exceed the bar total. Hovering or focusing a bar shows the exact time range and attributed composition.

This is a change in observed context snapshots, not throughput, billing, or token spend. The normalized API names it `contextGrowthTimeline`; generated reports intentionally omit it.

## Context machinery snapshot

Claude Code records the rendered result of a user-invoked `/context` command in the session JSONL. Threadlight treats this as an opt-in point-in-time snapshot: if no valid result has been recorded, the dashboard asks the user to run `/context`; when one or more results exist, it shows the latest one.

The parser is table-driven rather than repository-driven. It identifies the context category table by its column roles and treats other valid tables with a token column as machinery groups. Category names, group names, and items come from the captured output, so arbitrary repositories, MCP servers, agents, memory files, skills, and future provider-reported groups do not require a hard-coded catalog. Column order may vary. The provider's `Messages` and `Free space` summary rows are excluded because they are not machinery and overlap Threadlight's live context presentation.

The **Machinery token load** is the sum of the remaining provider-estimated category values. Threadlight sums category rows rather than detailed group items because the groups expand portions of the category summary and would otherwise be counted twice. The total is present only when the session has a valid recorded `/context` snapshot; the expandable category and item inventory remains available beside it.

Only bounded, validated labels and the provider's formatted token estimates enter normalized state. Memory paths are reduced to their basename. The raw local-command output, repository paths, prompts, and responses never enter the browser API. These values are provider estimates from the captured `/context` rendering, not Threadlight measurements, billing totals, or cumulative token spend. Historical views use only the recorded snapshot and never substitute current machinery.

## Execution tasks

Each agent's execution-task popover is derived from Bash lifecycle records in that agent's selected-session transcript, not the provider's agent-maintained planning checklist. A Bash tool call creates an execution task from its short description. A returned background-task ID keeps it running until a trusted task notification records completion, failure, cancellation, or interruption. Foreground shell calls finish when their matching tool result arrives. In historical sessions, unmatched executions are marked stopped at the recorded session end.

The normalized API exposes only tool/background IDs, the short Bash description, shell kind, lifecycle status, timestamps, background flag, and exit code. Commands, stdout, stderr, tool-result content, and notification output are excluded. Tasks are nested under their owning normalized agent, and the top-level `executionTasks` field retains the primary agent's list for compatibility. The dashboard groups running executions above the most recent finished executions, retaining at most 30 rows per agent, and calculates elapsed time from their lifecycle timestamps. Generated reports intentionally omit execution tasks.

## Plan checklist

Threadlight also reads the provider's structured task files for the selected session and exposes them separately as `planTasks`. The Plan items badge and checkbox popover are intentionally distinct from Execution tasks: this checklist is an agent-maintained planning snapshot, not observed runtime state. The popover always ends with a warning that it remains static until Claude updates it and Claude may forget to do so.

Only normalized task ID, subject, status, and dependency IDs enter the browser API. Long-form descriptions and active-form text are excluded. Unknown statuses fall back to `pending`; malformed task files and unsafe identifiers are ignored. Generated reports omit the plan checklist.

## Agent state

- `active` — updated within 45 seconds
- `waiting` — has an active descendant and is waiting for that work to return
- `needs_input` — issued a user-input request that has not received its matching result
- `stopped` — a parent agent received a successful `TaskStop` result for that subagent
- `finished` — a subagent transcript ends with `end_turn` or `stop_sequence`
- `warm` — updated within 5 minutes
- `idle` — older than 5 minutes

Finished subagents are detected directly from their final assistant record and turn gray on the next poll. If a finished subagent is resumed and receives a new record, it returns to an activity-based state. Waiting status propagates through the recorded parent-child hierarchy. Primary agents and older transcript formats without a terminal marker continue to use modification-time state as a fallback.

Needs-input state is detected by matching a provider user-input tool request to its result ID. It appears only while that result is absent and clears on the next poll after the user answers. The question, choices, and answer are never returned to the browser. A needs-input agent is not counted as running, and its explicit state is preserved even if it also has an active descendant.

Externally stopped subagents are detected from the parent transcript by matching a `TaskStop` request to its successful tool result. A later assistant record in that subagent transcript clears the stopped state, allowing resumed work to return to activity-based status. The stop event timestamp is shown as the agent's last-seen time.

The dashboard's running-agent count includes both `active` agents and parents marked `waiting` on active descendants.

Each agent's wall time is measured from its earliest to latest recorded transcript timestamp. Active agents and parents waiting on active descendants continue counting from their recorded start time; finished and stopped agents retain their recorded duration. This is elapsed wall time and may include idle gaps.

## Session state

When Claude's local session registry is available, its entries are the primary liveness signal. A registered session remains live even while idle. An unregistered transcript receives a 15-second grace window for startup ordering and final exit-time writes, then moves to history. The browser refreshes the local session catalog every two seconds, so registry-backed exits normally appear within a few seconds after that grace expires. No external API is called.

When the provider registry is unavailable, Threadlight falls back to the five-minute transcript/subagent activity window. This compatibility heuristic supports concurrent sessions but does not claim to detect operating-system process state.

Selecting any live session keeps its state polling. When a selected session loses its live classification, it moves into history and polling stops until it becomes active again.

## User attention

For the Claude Code adapter, Threadlight reads the provider's local session registry and treats a `waiting` session whose safe wait category indicates input, approval, permission, or a question as needing user input. The raw wait value and question content are never sent to the browser. Transcript `AskUserQuestion` calls remain a fallback for sessions without registry state. A registered input wait remains live and takes priority for automatic live-session selection until the provider clears it.

## Session duration

Elapsed wall time is the difference between the earliest and latest recorded timestamps. It includes idle gaps and overlapping work.

## Repetition

A repetition signature combines the agent and tool name with a monitor-side digest of the tool's complete input. Three or more identical signatures produce a repetition insight. Different edit anchors, read offsets or limits, grep patterns or windows, and review-driven replacement text therefore remain distinct. The input and digest are never returned to the browser. `repeatedCalls` counts calls beyond the first occurrence, so it is not the number of distinct loops. Repetition remains available to deterministic insights and the flow score, but is not shown as a persistent summary card or report section.

## Tool calls

`toolCalls` counts every observed tool invocation in the session. Its dashboard popover groups those calls by agent, tool name, and sanitized target; the grouped call counts always sum to the headline total. Prompt text, response text, and full command contents are not exposed.

## Activity events

Recent activity includes tool invocations, failed shell completions, and timestamps for direct user messages or answers to an agent's structured question. A failed shell event is timestamped when execution finishes and exposes only the sanitized Bash description plus its exit code when available; commands, stdout, stderr, and tool-result content remain excluded. A user-input event's target lists only its content categories (`Text`, `Document`, and `Image`, including combinations); prompt text, answers, filenames, tool results, and synthetic subagent prompts are never returned to the browser. Outcome and user-input events do not contribute to `toolCalls`, repetition signals, or the flow score.

## Agent overlap

An overlap insight appears only when at least two agents modify the same edit anchor, whole-file write target, or notebook cell within 30 seconds. Reads and searches never count as collisions. Edits to different regions of one file and sequential review/fix work remain distinct. The 30-second window is a deterministic proxy for concurrent work because transcripts record invocation timestamps rather than full edit lifetimes.

## Flow score

```text
score = max(
  25,
  100
  - min(45, repeatedCalls × 4)
  - min(25, overlappingTargets × 7)
)
```

The score is a heuristic attention signal, not a quality assessment.

## Plan usage

Plan utilization is refreshed when an unpaused live view opens if the last attempt is at least 60 seconds old. If it is newer, the dashboard waits for the remainder of that minute before refreshing, then continues at 60-second intervals. The monitor also caches each attempt for 60 seconds to deduplicate simultaneous tabs and enforce the cooldown server-side. Normal session polling, historical views, report generation, and manual refreshes never invoke the provider endpoint. Failed refreshes retain the last successful values, expose only a sanitized error and safe attempt timestamp, and retry after the same cooldown. The dashboard distinguishes the last successful `fetchedAt` time from the latest `attemptedAt` retry. Retrieval does not invoke a model. Plan utilization is omitted entirely from historical views and historical reports.

## Git state

Live branch metadata comes from read-only Git commands against the primary session's working directory. Threadlight resolves the live default branch from `origin`, fetches its commit objects into a temporary Threadlight-owned bare repository, and caches the result for one minute. It never updates the observed repository's remote-tracking refs, `FETCH_HEAD`, index, or working tree. On a feature branch, Threadlight shows bounded commit metadata unique to the live remote default branch (normally `origin/main`) and ahead/behind counts against that remote snapshot. When graph history says a feature branch is ahead but Git's deterministic merge-tree result is identical to the remote tree, Threadlight reports zero unmerged commits and labels the branch changes as integrated; this handles squash merges without pretending the rewritten commits are still outstanding. On the default branch, it shows recent commits and divergence from the live remote branch. Remote failures degrade independently and never fall back to potentially stale local remote-tracking counts. Commit metadata is limited to the abbreviated hash, a bounded subject, and commit timestamp; author identity and commit bodies are not exposed. Live views also show uncommitted file status and paths. Historical views show only a branch recorded in the transcript when one is available; they never substitute the current repository or working tree for historical Git state.

## Pull-request associations

Threadlight associates a pull request with a session only when a successful, recognized pull-request creation tool result contains a canonical GitHub pull-request URL, or when GitHub reports a pull request for the live session's current branch. Historical sessions never infer associations from the current working tree or branch. A transcript-recorded association may refresh its current GitHub status, which is labeled with the local observation time rather than presented as recorded historical state.

The monitor parses tool results privately and returns only an allowlist: host, repository slug, pull-request number, bounded title, canonical URL, open/draft/merged/closed state, head and base branch names, non-negative additions and deletions, association source, and timestamps. Commands, raw tool output, PR bodies, authors, comments, reviews, checks, and credentials never enter the browser API. GitHub CLI and network failures degrade independently; a safely parsed transcript link can remain visible without current metadata.
