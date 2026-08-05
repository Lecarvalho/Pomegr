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

- **Primary context** — latest snapshot for the primary agent
- **Agent context** — latest snapshot for that agent
- **All-agent context** — sum of every visible agent's latest snapshot
- **Last 60 seconds** — unique-message usage recorded in the preceding minute

All-agent context is not historical throughput. Earlier repeated cache reads are not accumulated into the headline total.

## Agent state

- `active` — updated within 45 seconds
- `waiting` — has an active descendant and is waiting for that work to return
- `warm` — updated within 5 minutes
- `idle` — older than 5 minutes

Waiting status propagates through the recorded parent-child hierarchy. The other states describe transcript activity, not guaranteed process state.

## Session duration

Elapsed wall time is the difference between the earliest and latest recorded timestamps. It includes idle gaps and overlapping work.

## Repetition

A signature combines agent, tool name, and important target. Three or more identical signatures produce a repetition insight. `repeatedCalls` counts calls beyond the first occurrence.

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

Plan utilization is retrieved from the provider's authenticated endpoint, cached for 60 seconds, and normalized into the current session, all-model, and model-scoped windows. Retrieval does not invoke a model.

## Git state

Branch and uncommitted files come from read-only Git commands against the primary session's working directory.
