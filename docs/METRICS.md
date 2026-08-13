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

For Codex, Threadlight reads only each token-count event's `last_token_usage`; it never uses `total_token_usage`. Codex input includes cached input, so the adapter maps uncached input as `input_tokens - cached_input_tokens`, maps cached input to cache read, and maps recognized cache-creation input to cache write. Codex `output_tokens` already includes `reasoning_output_tokens`; reasoning is retained as bounded snapshot metadata but is not added to output a second time. The per-snapshot provider total and model context window are retained only as bounded latest-snapshot metadata. They are not accumulated, converted to spend, or used to derive a recent rate. Missing, invalid, and all-zero snapshots remain unavailable.

- **Agent context** — latest snapshot for that agent
- **All-agent context** — sum of every visible agent's latest snapshot

Codex rollout parsing accepts the recognized snake_case and camelCase token-count shapes. Unknown future shapes are unavailable rather than interpreted as cumulative usage. Live files are read from a bounded tail, so a burst that pushes the latest recognized snapshot beyond that tail can temporarily make context unavailable; Threadlight never substitutes `total_token_usage`.

## Estimated API cost

Threadlight does not calculate cost from transcript tokens. When explicitly connected through the status-line bridge, it displays Claude Code's client-side `cost.total_cost_usd` session estimate. The bridge persists only the normalized session ID, non-negative USD amount, estimate type, and local observation time under `%APPDATA%\threadlight\cost-snapshots` on Windows (`~/.threadlight/cost-snapshots` elsewhere); all other status-line fields are discarded.

The value is cumulative for the Claude Code session and is the only cumulative spend-like value Threadlight presents. It is labeled **Estimated API cost** because Claude Code calculates it at standard API list rates and it may differ from an actual bill. A historical session shows its last captured estimate; if no snapshot was captured, cost remains unavailable rather than being reconstructed from transcript throughput.

The initial Codex adapter has no cost source. Cost is capability-gated and omitted rather than inferred from token snapshots or displayed as zero.

All-agent context is the only context total Threadlight presents. The dashboard, normalized browser API, agent details, context composition, and generated Markdown reports use only the latest snapshots or sums derived from them. Cumulative transcript-throughput and token-spend session totals remain excluded.

## Context-growth timeline

The context-growth timeline derives each interval from the same snapshots used by All-agent context. At every bucket boundary, Threadlight carries forward each agent's latest non-zero snapshot, sums those snapshots, and compares that sum with the preceding boundary. A bar shows only a positive net increase. Repeated snapshots contribute zero, and context reductions caused by compaction or agent resets are not presented as new context.

Bucket sizes are selected from fixed, human-readable intervals to target roughly 28 bars across the recorded session wall time. Each bar is attributed across uncached input, cache write, cache read, and generated output. Because components can move between cache categories, positive component changes are scaled to the net context increase so their stack can never exceed the bar total. Hovering or focusing a bar shows the exact time range and attributed composition.

This is a change in observed context snapshots, not throughput, billing, or token spend. The normalized API names it `contextGrowthTimeline`; generated reports intentionally omit it.

## Context machinery snapshot

Claude Code records the rendered result of a user-invoked `/context` command in the session JSONL. Threadlight treats this as an opt-in point-in-time snapshot: if no valid result has been recorded, the dashboard asks the user to run `/context`; when one or more results exist, it shows the latest one.

The parser is output-driven rather than repository-driven. It accepts both Markdown category tables and the ANSI terminal summary emitted by current Claude Code; expanded Markdown tables with a token column become machinery groups. Category names, group names, and items come from the captured output, so arbitrary repositories, MCP servers, agents, memory files, skills, and future provider-reported groups do not require a hard-coded catalog. Table column order may vary. The provider's `Messages` and `Free space` summary rows are excluded because they are not machinery and overlap Threadlight's live context presentation.

The **Machinery token load** is the sum of the remaining provider-estimated category values. Threadlight sums category rows rather than detailed group items because the groups expand portions of the category summary and would otherwise be counted twice. The total is present only when the session has a valid recorded `/context` snapshot; the expandable category and item inventory remains available beside it.

Only bounded, validated labels and the provider's formatted token estimates enter normalized state. Memory paths are reduced to their basename. The raw local-command output, repository paths, prompts, and responses never enter the browser API. These values are provider estimates from the captured `/context` rendering, not Threadlight measurements, billing totals, or cumulative token spend. Historical views use only the recorded snapshot and never substitute current machinery.

Codex does not currently provide a recognized context-machinery snapshot. The panel and Claude `/context` instruction are omitted for Codex sessions.

## Execution tasks

Each agent's execution-task popover is derived from Bash lifecycle records in that agent's selected-session transcript, not the provider's agent-maintained planning checklist. A Bash tool call creates an execution task from its short description. A returned background-task ID keeps it running until a trusted task notification records completion, failure, cancellation, or interruption. Foreground shell calls finish when their matching tool result arrives. In historical sessions, unmatched executions are marked stopped at the recorded session end.

Current Codex desktop rollouts may wrap shell calls inside a recorded `exec` cell rather than emitting the older command lifecycle shape. Threadlight recognizes literal `tools.shell_command(...)` call evidence in that cell and pairs it with the cell's completion and exit-code markers. When that record has no provider description, a deterministic allowlist maps the command shape to a fixed category such as **Run tests**, **Inspect Git changes**, or **Read files**. Arguments, paths, arbitrary script names, and command text never enter the label. Other nested tools are not promoted to shell tasks, and the cell source is never returned to the browser. This compatibility path remains bounded to the same 30 most recent safe task rows.

The normalized API exposes only tool/background IDs, the short Bash description, shell kind, lifecycle status, timestamps, background flag, exit code, and an optional bounded failure category. For failed tasks, the monitor deterministically reduces recognized result evidence to one of a fixed set of categories such as permission restriction, timeout, missing command or path, invalid path, syntax error, failed tests, or network failure. Unrecognized failures fall back to a non-zero-exit or provider-error category. The dashboard exposes that category as an accessible tooltip on the failure marker. Commands, stdout, stderr, matched source text, tool-result content, and notification output are excluded. Tasks are nested under their owning normalized agent, and the top-level `executionTasks` field retains the primary agent's list for compatibility. The dashboard groups running executions above the most recent finished executions, retaining at most 30 rows per agent, and calculates elapsed time from their lifecycle timestamps. Generated reports intentionally omit execution tasks.

For a live Codex agent, the same popover may also show one **Current activity** row above the execution sections. Threadlight accepts only explicitly recognized provider UI activity-summary records, normalizes them to a bounded one-line label plus transcript-derived timestamp, deduplicates duplicate event and response-item representations, and retains only the latest valid observation for the owning agent. The observation is exposed only while its owning turn remains open and is cleared on recognized turn completion, failure, stop, or other terminal agent state. Historical sessions omit it.

The normalized optional `agent.currentActivity` field is provider-reported transient metadata. It is not chain-of-thought, an execution task, a shell description, a plan item, a task signal, an efficiency signal, or a completion claim. Unknown reasoning shapes, encrypted reasoning, prompts, responses, commands, tool arguments, tool results, control characters, and unsupported future fields are ignored. Current activity does not alter execution labels, running/finished counts, durations, tool-call totals, metrics, recommendation rules, or generated reports.

## Skill usage

Skill usage requires concrete transcript evidence. Threadlight counts explicit provider skill-invocation records. For current Codex desktop `exec` cells, it also counts a read of the exact `SKILL.md` source path declared in that session's host-skill catalog. Merely listing, mentioning, or making a skill available does not count as use.

Only the validated canonical skill name, invocation count, and latest observed timestamp enter normalized state. Skill source paths, catalog descriptions, exec-cell source, prompts, arguments, and tool output remain monitor-side and are never returned to the browser.

## Plan checklist

Threadlight also reads the selected provider's structured task records or structured plan updates and exposes them separately as `planTasks`. The Plan items badge and checkbox popover are intentionally distinct from Execution tasks: this checklist is an agent-maintained planning snapshot, not observed runtime state. The popover always warns that the snapshot changes only when the agent updates it and may be stale. Free-form plan prose is never parsed into checklist items.

Only normalized task ID, subject, status, and dependency IDs enter the browser API. Long-form descriptions and active-form text are excluded. Claude task records with unknown statuses fall back to `pending`; malformed task files and unsafe identifiers are ignored. Malformed Codex plan updates are ignored, and Codex dependencies remain empty because the provider does not supply them. Generated reports omit the plan checklist.

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

Codex uses a separate evidence order: owning app-server status, a current allowlisted lifecycle-bridge lease, then a rollout-tail heuristic. App-server `active`, `idle`, `systemError`, and recognized waiting flags map directly. Bridge leases use a 15-second heartbeat and 45-second expiry; needs-input also has a 30-minute safety expiry. Rollout-only activity is active for 15 seconds, idle/recent through 120 seconds, and unavailable after 120 seconds. On Windows, Codex can append fresh records while the open rollout's reported modification time remains stale, so Threadlight also tracks bounded file-size/stat changes before applying that expiry gate. Rollout-only approval waiting is unsupported. These windows are liveness heuristics, not token metrics or operating-system certainty.

A recognized provider-authored Codex activity heading is scoped to its open turn, not to the 15-second rollout activity window. When only the rollout fallback has gone idle, an open heading keeps that agent active; explicit app-server and lifecycle-bridge idle states remain authoritative. The heading clears when a newer heading replaces it, a recognized terminal turn record arrives, the agent finishes or stops, or the view becomes historical. Threadlight preserves the provider timestamp so an older heading is never presented as newly observed merely because unrelated rollout activity resumed.

Selecting any live session keeps its state polling. When a selected session loses its live classification, it moves into history and polling stops until it becomes active again.

## User attention

For the Claude Code adapter, Threadlight reads the provider's local session registry and treats a `waiting` session whose safe wait category indicates input, approval, permission, or a question as needing user input. The raw wait value and question content are never sent to the browser. Transcript `AskUserQuestion` calls remain a fallback for sessions without registry state. A registered input wait remains live and takes priority for automatic live-session selection until the provider clears it.

For Codex, owning app-server waiting flags or lifecycle-bridge request kinds can mark needs-input. Rollout fallback recognizes only a fresh unmatched structured `request_user_input` call. The matching output clears it; questions, choices, answers, approval reasons, and commands are discarded.

## Session approval mode

The session hero shows the latest recognized approval mode recorded by the provider on the primary session transcript. Claude Code approval modes may come from legacy user records or current standalone permission-mode records. Codex approval modes may come from recognized turn-context or thread-settings records and map `untrusted`, `on-request`, granular, and `never` policies to provider-neutral labels. Threadlight keeps only the fixed policy enum and observation timestamp; granular rules, sandbox settings, writable roots, requested commands, approval reasons, and every other field are discarded. A historical view labels the value as the last approval mode because it does not imply that the configuration remains active.

## Session duration

Elapsed wall time is the difference between the earliest and latest recorded timestamps. It includes idle gaps and overlapping work.

## Efficiency signals

`monitor/efficiency-signals.mjs` is the executable catalog for every rule shown in the **Efficiency signals** panel. It owns each rule's fixed thresholds, evidence requirements, severity, display limit, and user-facing explanation. New rules and adjustments should be made there, covered by `tests/efficiency-signals.test.mjs`, and reflected in this section. Supporting modules may derive evidence, but they do not decide whether the panel emits a signal.

The current catalog contains these deterministic rules:

- **User input needed** — appears while an observed agent has an unresolved structured user-input request.
- **Automatic context compaction** — appears for an agent when the provider records a `compact_boundary` system event with an `auto` trigger. The signal includes the pre-compaction context snapshot when the provider records a valid value. Manual compaction does not emit a warning because it may be deliberate session maintenance. At most three automatic-compaction signals are shown.
- **Repeated tool call** — appears when an agent makes the same scoped call with unchanged inputs at least three times. At most three repetition signals are shown.
- **Concurrent mutation** — appears when at least two agents mutate the same edit anchor, whole-file target, or notebook cell within 30 seconds. At most two overlap signals are shown.
- **Unshared context pressure** — appears when the primary agent's latest context snapshot is at least 150,000 tokens, the primary agent has made at least 40 observed tool calls, and no subagent transcript has been observed. Finished and stopped subagents still count as observed delegation. The signal describes a possible delegation opportunity; it does not claim that the work was parallelizable, that delegation would have reduced total context, or that a project instruction was violated.
- **Prompt cache miss after idle gap** — appears at most once per affected Codex agent when adjacent comparable `last_token_usage` observations show at least 8,000 current input tokens, at least an 80% cached-input share previously, at most a 10% cached-input share currently, and at least a 30-minute gap. The signal reports only bounded context size, cached-input share, and elapsed time. It says expiration or eviction may have reduced efficiency; it never assigns a cause, cost, charge, or savings amount.
- **Healthy fallback** — appears only when none of the warning rules emit a signal.

The automatic-compaction parser allows only the normalized agent identity, recognized trigger, non-negative pre-compaction token count, and event timestamp into the rule engine. The compacted summary, provider event content, and all other compaction metadata remain monitor-side and never enter browser state. On first observation Threadlight scans each selected agent transcript for these bounded events, then merges new tail records into an in-memory cache so an earlier compaction remains visible as the transcript grows. Automatic compaction is evidence that context pressure caused the provider to summarize earlier conversation detail; it is not a quality judgment or proof that the session failed.

Codex compaction records follow the same bounded evidence contract, but a warning is emitted only when the record contains an explicit `auto` or `automatic` trigger. A compaction-shaped record without a recognized trigger is ignored rather than inferred to be automatic; an explicit manual trigger remains recorded evidence but does not produce a warning.

Codex repetition, concurrent-mutation, unshared-context, and healthy-fallback rules run only when recognized rollout or canonical tool evidence is available. Missing app-server turns or rollout history disables the affected rule; Threadlight does not silently substitute timestamps, prose, file modification times, or cumulative token totals. Provider-generated summaries, estimated cost, and context machinery are unavailable for Codex and therefore contribute no metrics or efficiency evidence.

Prompt-cache classification uses bounded chronological `last_token_usage` observations for the same normalized Codex agent; it never reads or exposes cumulative `total_token_usage`. Missing, malformed, synthetic, cumulative-only, duplicate-only, or provider-unsupported usage disables the rule. Known automatic or manual compaction, a fork boundary, a model or provider/session identity change, or unavailable intermediate usage makes observations incomparable. A normal resume of the same thread is not itself a suppression condition. A simultaneous recognized cache-write count may corroborate a cold refill but is never fabricated or required.

OpenAI's current [prompt-caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) defines `prompt_cache_options.ttl = "30m"` for GPT-5.6-family and later models as a minimum cache lifetime, not an exact expiration time or maximum retention period; a prefix may remain eligible longer. Cache misses can also follow a changed exact prefix, breakpoint or key behavior, routing, eviction, model changes, or a prefix that was never written. Threadlight therefore keeps the same cautious cache-miss wording even beyond 24 hours for GPT-5.6-family evidence. Older model families have different in-memory and extended-retention policies, so elapsed time alone never proves expiration. Codex subscription usage is not translated into API list-price billing.

The unshared-context rule uses the latest context snapshot rather than cumulative transcript throughput or token spend. Tool calls provide evidence of sustained execution; elapsed wall time is deliberately excluded because it includes idle gaps. Threadlight does not parse natural-language instructions such as `AGENTS.md` to infer a delegation policy.

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

Plan utilization is coordinated entirely by the monitor for live views. Every live-state read receives the monitor's cached value, while the monitor permits at most one provider request per service process after the previous request's five-minute cooldown. Concurrent browsers and overlapping polls share the same in-flight request and cannot multiply provider traffic. A `429` response extends the next-attempt boundary according to a valid `Retry-After` delta or HTTP date; other failures and invalid or absent `Retry-After` values use the five-minute cooldown. Failed refreshes retain the last successful values and expose only a sanitized error and safe attempt timestamp. Retrieval does not invoke a model. Plan utilization is omitted entirely from historical views and historical reports, and reports never request the provider endpoint.

## Git state

Live branch metadata comes from read-only Git commands against the primary session's working directory. Threadlight resolves the live default branch from `origin`, fetches its commit objects into a temporary Threadlight-owned bare repository, and caches the result for one minute. It never updates the observed repository's remote-tracking refs, `FETCH_HEAD`, index, or working tree. On a feature branch, Threadlight shows bounded commit metadata unique to the live remote default branch (normally `origin/main`) and ahead/behind counts against that remote snapshot. When graph history says a feature branch is ahead but Git's deterministic merge-tree result is identical to the remote tree, Threadlight reports zero unmerged commits and labels the branch changes as integrated; this handles squash merges without pretending the rewritten commits are still outstanding. On the default branch, it shows recent commits and divergence from the live remote branch. Remote failures degrade independently and never fall back to potentially stale local remote-tracking counts. Commit metadata is limited to the abbreviated hash, a bounded subject, and commit timestamp; author identity and commit bodies are not exposed. Live views also show uncommitted file status and paths. Historical views show only a branch recorded in the transcript when one is available; they never substitute the current repository or working tree for historical Git state.

## Pull-request associations

Threadlight associates a pull request with a session only when a successful, recognized pull-request creation tool result contains a canonical GitHub pull-request URL, or when GitHub reports a pull request for the live session's current branch. Historical sessions never infer associations from the current working tree or branch. A transcript-recorded association may refresh its current GitHub status, which is labeled with the local observation time rather than presented as recorded historical state.

The monitor parses tool results privately and returns only an allowlist: host, repository slug, pull-request number, bounded title, canonical URL, open/draft/merged/closed state, head and base branch names, non-negative additions and deletions, association source, and timestamps. Commands, raw tool output, PR bodies, authors, comments, reviews, checks, and credentials never enter the browser API. GitHub CLI and network failures degrade independently; a safely parsed transcript link can remain visible without current metadata.
