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

All-agent context is the only context total Threadlight presents. The dashboard, normalized browser API, agent details, context composition, and generated Markdown reports use only the latest snapshots or sums derived from them. Cumulative transcript-throughput and token-spend session totals remain excluded.

## Context-growth timeline

The context-growth timeline derives each interval from the same snapshots used by All-agent context. At every bucket boundary, Threadlight carries forward each agent's latest non-zero snapshot, sums those snapshots, and compares that sum with the preceding boundary. A bar shows only a positive net increase. Repeated snapshots contribute zero, and context reductions caused by compaction or agent resets are not presented as new context.

Bucket sizes are selected from fixed, human-readable intervals to target roughly 28 bars across the recorded session wall time. Each bar is attributed across uncached input, cache write, cache read, and generated output. Because components can move between cache categories, positive component changes are scaled to the net context increase so their stack can never exceed the bar total. Hovering or focusing a bar shows the exact time range and attributed composition.

This is a change in observed context snapshots, not throughput, billing, or token spend. The normalized API names it `contextGrowthTimeline`; generated reports intentionally omit it.

## Session tasks

Threadlight reads the provider's structured task files for the selected session and attaches them to the primary orchestration agent. Current task storage does not include agent ownership, so tasks are never guessed onto subagents. The popover shows normalized task ID, subject, status, and dependency IDs only. Long-form descriptions and active-form text are excluded from the browser API and generated reports.

Task status is presented as `pending`, `in_progress`, or `completed`. Unknown statuses fall back to `pending`; malformed task files and unsafe identifiers are ignored. This is a read-only view and does not update provider tasks.

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

Every primary session whose own transcript or subagent tree changed within the last five minutes appears in the live-session list. If no session is recent, the most recently active session remains the live auto-discovery target. This deterministic activity heuristic supports concurrent sessions but does not claim to detect operating-system process state.

Selecting any live session keeps its state polling. When a selected session ages out of the live window, it moves into history and polling stops until it becomes active again.

## Session duration

Elapsed wall time is the difference between the earliest and latest recorded timestamps. It includes idle gaps and overlapping work.

## Repetition

A signature combines agent, tool name, and important target. Three or more identical signatures produce a repetition insight. `repeatedCalls` counts calls beyond the first occurrence, so it is not the number of distinct loops. The dashboard popover lists every grouped pattern with sanitized agent, tool, target, total-call, and repeated-call metadata.

## Tool calls

`toolCalls` counts every observed tool invocation in the session. Its dashboard popover groups those calls by agent, tool name, and sanitized target; the grouped call counts always sum to the headline total. Prompt text, response text, and full command contents are not exposed.

## Agent overlap

An overlap insight appears when at least two agents access the same normalized path across at least three tool calls. This signals possible duplication, not necessarily waste.

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

Plan utilization is retrieved for the live view from the provider's authenticated endpoint once, one minute after page load, then cached by the monitor to deduplicate simultaneous tabs. Normal session polling, historical views, report generation, and manual refreshes never invoke the provider endpoint. Retrieval does not invoke a model. Plan utilization is omitted entirely from historical views and historical reports.

## Git state

Live branch and uncommitted files come from read-only Git commands against the primary session's working directory. Historical views show only a branch recorded in the transcript when one is available; they never substitute the current working tree for historical Git state.
