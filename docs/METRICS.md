# Metrics and deterministic rules

Pomegr currently makes no model calls. Every value and recommendation comes from recorded data and fixed rules.

## Agent roles

`Agent.role` is a bounded display enum: `orchestrator`, `explore`, `plan`, `builder`, `reviewer`, `tester`, `researcher`, `general-purpose`, `workflow-worker`, `fork`, `compaction`, or `unknown`. The monitor resolves it from primary-agent identity, a valid repository mapping, built-in exact types, ordered keyword matches, and finally verified workflow association. Keyword matches use this deterministic order: review/audit/critic/judge/lint; test/qa/spec/verify; explore/search/locate/investigate/discover/scan/map; plan/design/architect; research/docs/guide/study; then build/implement/edit/fix/migrate/refactor/apply/transform/synthesize/writer. Provider-native kinds and mapping contents remain monitor-private; the browser and reports never reinterpret them.

## Context usage

Assistant usage is deduplicated by provider message ID. The latest context snapshot is:

```text
input_tokens
+ cache_creation_input_tokens
+ cache_read_input_tokens
+ output_tokens
```

Zero-valued synthetic messages are ignored.

Claude usage is normalized by a dedicated strict parser. It accepts only non-negative safe-integer request counts, retains at most the latest 1,000 valid observations per agent for context-history coverage, and requires an explicitly valid cache-read field before an observation can classify cache behavior. Missing or malformed cache evidence breaks adjacent comparison without exposing the raw usage object or making the rest of the session unavailable.

For Codex, Pomegr reads only each token-count event's `last_token_usage`; it never uses `total_token_usage`. Codex input includes both cache reads and cache writes, so the adapter maps uncached input as `input_tokens - cached_input_tokens - cache_write_input_tokens`, bounds the two cache categories to the recorded input, and never adds either category twice. Codex `output_tokens` already includes `reasoning_output_tokens`; reasoning is retained as bounded snapshot metadata but is not added to output a second time. The per-snapshot provider total and model context window are retained only as bounded latest-snapshot metadata. They are not accumulated, converted to spend, or used to derive a recent rate. Missing, invalid, and all-zero snapshots remain unavailable.

Codex subscription-backed session records currently do not provide reliable cache-write counts. Pomegr therefore retains the normalized field internally for contract compatibility but does not present Cache write or derive cache-write classifications for Codex. Cache reads remain available. This limitation is tracked upstream at [openai/codex#35300](https://github.com/openai/codex/issues/35300).

- **Agent context** — latest live snapshot, or final recorded snapshot in history, for that agent
- **All-agent context** — sum of every visible agent's latest live or final recorded snapshot

Codex rollout parsing accepts the recognized snake_case and camelCase token-count shapes. Unknown future shapes are unavailable rather than interpreted as cumulative usage. Live files are read from a bounded tail, with a bounded cold-start history read that recovers normalized context observations alongside execution-task and compaction state. During one monitor process, Pomegr retains at most the latest 1,000 normalized usage observations per agent across verified append-only tail movement; the retained state contains no transcript content and resets on truncation, replacement, deletion, or failed continuity verification. After a cold start, only observations still present in the bounded history read can be recovered, so a sufficiently large burst can still make earlier context unavailable. Pomegr never substitutes `total_token_usage`.

## Estimated API cost

Pomegr does not calculate cost from transcript tokens. When explicitly connected through the status-line bridge, it displays Claude Code's client-side `cost.total_cost_usd` session estimate. The bridge persists only the normalized session ID, non-negative USD amount, estimate type, and local observation time under `%APPDATA%\pomegr\cost-snapshots` on Windows (`~/.pomegr/cost-snapshots` elsewhere); all other status-line fields are discarded.

The value is cumulative for the Claude Code session and is the only cumulative spend-like value Pomegr presents. It is labeled **Estimated API cost** because Claude Code calculates it at standard API list rates and it may differ from an actual bill. A historical session shows its last captured estimate; if no snapshot was captured, cost remains unavailable rather than being reconstructed from transcript throughput.

The initial Codex adapter has no cost source. Cost is capability-gated and omitted rather than inferred from token snapshots or displayed as zero.

All-agent context is the only aggregated context total Pomegr presents. The dashboard, normalized browser API, agent details, context composition, and generated Markdown reports use only the latest snapshots or sums derived from them. Cumulative transcript-throughput and token-spend session totals remain excluded.

## Request snapshots

`metrics.tokens.requestSnapshots` is a separate bounded feed of valid provider usage observations. Every item represents exactly one request and exposes only an opaque monitor-generated ID, normalized agent ID, normalized observation timestamp, request-local uncached input, cache write, cache read, output, and `totalTokens` recomputed from those four parts. It does not use a provider-reported total. Provider capability gates determine which components are presented; Cache write is currently omitted for Codex.

For live Claude Code and Codex sessions, the provider adapters retain no more than the latest 1,000 normalized observations per agent in memory so context history remains continuous when older transcript records leave a bounded read tail. Retention is process-local and is merged only while file identity, size, modification time, and a previously observed file suffix prove append-only continuity. Truncation, replacement, deletion, or unverifiable continuity discards the retained observations. The independent request-snapshot feed remains capped to its newest 100 valid observations per visible agent. When a provider omits a request identity, Pomegr derives a bounded stable internal identity only from normalized timestamp, model, and token-count fields; neither that identity nor its source fields are exposed through the browser API.

The monitor deduplicates observations privately, keeps at most the latest 100 valid requests per visible agent, and returns the merged items chronologically. Invalid timestamps or counts, all-zero observations, unknown agents, missing internal dedupe evidence, and cumulative-only provider records are rejected. Status is `ready` when at least one valid item remains and `unavailable` otherwise.

Request snapshots are not context history or transcript throughput. Pomegr never buckets them, carries values forward, computes deltas, sums requests or agents, derives rates, or translates them into spend. Provider message/session/event IDs, models, comparison groups, dedupe keys, provider totals, raw usage, prompts, and billing fields remain monitor-private. Generated reports intentionally omit this feed.

## Context history

Context history derives each interval from the same snapshots used by All-agent context. At every bucket boundary, Pomegr carries forward each agent's latest non-zero snapshot and exposes both the per-agent level and their all-agent sum. Repeated snapshots produce a flat level, while context reductions caused by compaction or agent resets remain visible. The final all-agent level equals the current or final All-agent context derived from those observations.

Bucket sizes are selected from fixed, human-readable intervals to target roughly 28 points across the recorded session wall time. Cache reads and writes are not plotted as historical context categories; significant request-local cache behavior is exposed separately as bounded cache events.

`contextHistory.boundaries` labels at most the newest 100 normalized context boundaries, returned in chronological order. A recognized provider compaction becomes `automatic_compaction` or `manual_compaction` with its normalized agent ID, transcript timestamp, and non-negative pre-compaction token count when supplied. When adjacent snapshots for one agent decrease without a recognized compaction between them, Pomegr emits `snapshot_drop` at the newer snapshot with the preceding context total. A recognized boundary suppresses the duplicate inferred drop. Boundary IDs are monitor-generated opaque hashes; provider event IDs, summaries, compacted content, and all other compaction metadata remain private.

This is actual observed context level, not throughput, billing, token spend, or cumulative transcript usage. The normalized API names it `contextHistory`; generated reports intentionally omit it.

## Project home history

The project home is built only for projects with at least one live session in the current catalog. Live cards expose bounded session metadata, agent counts, latest all-agent context, per-session `contextHistory`, and live-only resources. The home monitor performs one catalog inspection and one batched resource sample; resources are in-memory telemetry and are never reconstructed for history.

Each visible project's history window is exactly seven days of completed sessions whose recorded session timestamps belong to that project. On a cold monitor start, live cards are returned first while recorded history is marked loading and parsed cooperatively in the background; partial aggregates are not presented as complete. Once ready, history exposes completed count, median wall time, median final all-agent context, and at most six chronological `{ endedAt, total }` final-context points. These are recorded session levels, not sums, rates, throughput, spend, or quality judgments. Current Git state and current plan limits never enter project history.

## Usage-limit colors

Pomegr derives usage-limit color severity from the normalized percentage with fixed inclusive boundaries: the established uncached-input blue (`normal`) from 0% through 74%, yellow (`warning`) from 75% through 84%, and red (`critical`) from 85% through 100%. Provider severity labels and active-window state do not override these color thresholds. Percentages are clamped to the displayed 0–100 range before classification, and every usage-limit surface uses the same rule.

## Cache events

`metrics.tokens.cacheEvents` is a bounded feed derived from recognized per-request usage. It reports only `miss_refill`, `refill`, and `reuse` evidence for normalized agents. Prompt input is `input + cache read + cache write`; output is excluded. At most 20 newest events enter browser state, and their IDs are monitor-generated opaque hashes that do not expose provider message or event identities. If that cap would exclude a reuse event's related refill, the reuse is omitted so normalized relations never dangle.

- **Refill** — the provider records at least 8,000 cache-write tokens on one request.
- **Reuse** — after a tracked refill or miss-refill for the same agent, model, and comparison group, the first comparable request with at least 8,000 prompt-input tokens and at least an 80% cache-read share. Later high-read requests do not flood the feed.
- **Miss-refill** — adjacent comparable requests have at least 8,000 prompt-input tokens, the earlier request has at least an 80% cache-read share, the current request has at most a 10% share after at least 30 minutes, and the provider simultaneously records at least 8,000 cache-write tokens. A low-read transition without a recorded large write is not classified or warned on.

Automatic or manual compaction, a fork boundary for miss classification, a model or comparison-group change, invalid timestamps, or missing/malformed intermediate usage makes observations incomparable. A normal resume does not. The feed status is `unavailable` when no cache-classifiable observation exists and `ready` when an observed bounded window contains valid evidence, including when no event meets the thresholds.

Cache events expose only their fixed kind, normalized agent ID, observation time, prompt-input count, cache-read percentage, cache-write count, optional preceding percentage and elapsed gap, and an opaque relation from reuse to its tracked refill. They never expose prompts, cached prefixes, cache keys, TTL/configuration, routing, service tier, provider-private fields, raw usage, cumulative usage, price, charges, or claimed savings. An event is deterministic evidence, not proof of expiration, eviction, causation, quality, or billing impact.

## Live resource use

For a live session on Windows, Pomegr can measure the verified owner process and its descendants. Provider adapters supply the monitor with a PID and process-start identity only when current ownership evidence is available. The monitor rejects reused identities, owners shared by more than one session, and process trees that overlap another session's tree rather than attributing the same work twice. Ownership identifiers, process names, commands, paths, and environment data remain monitor-side and never enter the browser API.

The collector reads one operating-system process snapshot for all currently attributable sessions. Collection is request-driven and rate-limited by a fixed internal cadence that is intentionally hidden in the V1 interface. Each session keeps a rolling in-memory window of timestamped samples; samples and observed peaks are discarded when the session leaves the live catalog or its verified owner changes, and they are never persisted.

The normalized `metrics.resources` value exposes:

- **CPU** — recent process-tree CPU-time change normalized as a percentage of the machine's total logical-processor capacity; the normalized API also retains the equivalent occupied-core value, but the dashboard presents the whole-machine percentage
- **Memory** — current summed working set and the highest working set observed by Pomegr during the current ownership window
- **Disk I/O** — recent process-tree read and write transfer rates in bytes per second

The first valid observation is `collecting` because CPU and I/O rates require a prior counter baseline. Missing owners, vanished or identity-mismatched owners, shared trees, unsupported platforms, and collection failures produce a bounded unavailable reason; missing intervals are gaps, not zero consumption. These measurements are live operational telemetry, not judgments about task quality or agent efficiency. Historical views return `resources: null`, and resource data is excluded from persistence, generated reports, Flow score, efficiency signals, and recommendations.

## Context machinery snapshot

Claude Code records the rendered result of a user-invoked `/context` command in the session JSONL. Pomegr treats this as an opt-in point-in-time snapshot: if no valid result has been recorded, the dashboard asks the user to run `/context`; when one or more results exist, it shows the latest one.

The parser is output-driven rather than repository-driven. It accepts both Markdown category tables and the ANSI terminal summary emitted by current Claude Code; expanded Markdown tables with a token column become machinery groups. Category names, group names, and items come from the captured output, so arbitrary repositories, MCP servers, agents, memory files, skills, and future provider-reported groups do not require a hard-coded catalog. Table column order may vary. The provider's `Messages` and `Free space` summary rows are excluded because they are not machinery and overlap Pomegr's live context presentation.

The **Machinery token load** is the sum of the remaining provider-estimated category values. Pomegr sums category rows rather than detailed group items because the groups expand portions of the category summary and would otherwise be counted twice. The total is present only when the session has a valid recorded `/context` snapshot; the expandable category and item inventory remains available beside it.

Only bounded, validated labels and the provider's formatted token estimates enter normalized state. Memory paths are reduced to their basename. The raw local-command output, repository paths, prompts, and responses never enter the browser API. These values are provider estimates from the captured `/context` rendering, not Pomegr measurements, billing totals, or cumulative token spend. Historical views use only the recorded snapshot and never substitute current machinery.

Codex does not currently provide a recognized context-machinery snapshot. The panel and Claude `/context` instruction are omitted for Codex sessions.

## Execution tasks

Each agent's execution-task popover is derived from Bash lifecycle records in that agent's selected-session transcript, not the provider's agent-maintained planning checklist. A Bash tool call creates an execution task from its short description. A returned background-task ID keeps it running until a trusted task notification records completion, failure, cancellation, or interruption. Foreground shell calls finish when their matching tool result arrives. In historical sessions, unmatched executions are marked stopped at the recorded session end.

Current Codex desktop rollouts may wrap shell calls inside a recorded `exec` cell rather than emitting the older command lifecycle shape. Pomegr recognizes literal `tools.shell_command(...)` call evidence in that cell and pairs it with the cell's completion and exit-code markers. When that record has no provider description, a deterministic allowlist maps the command shape to a fixed category such as **Run tests**, **Inspect Git changes**, or **Read files**. Arguments, paths, arbitrary script names, and command text never enter the label. Other nested tools are not promoted to shell tasks, and the cell source is never returned to the browser. This compatibility path remains bounded to the same 30 most recent safe task rows.

The normalized API exposes only tool/background IDs, the short Bash description, shell kind, lifecycle status, timestamps, background flag, exit code, and an optional bounded failure category. For failed tasks, the monitor deterministically reduces recognized result evidence to one of a fixed set of categories such as permission restriction, timeout, missing command or path, invalid path, syntax error, failed tests, or network failure. Unrecognized failures fall back to a non-zero-exit or provider-error category. The dashboard exposes that category as an accessible tooltip on the failure marker. Commands, stdout, stderr, matched source text, tool-result content, and notification output are excluded. Tasks are nested under their owning normalized agent, and the top-level `executionTasks` field retains the primary agent's list for compatibility. The dashboard groups running executions above the most recent finished executions, retaining at most 30 rows per agent, and calculates elapsed time from their lifecycle timestamps. Generated reports intentionally omit execution tasks.

For a live Codex agent, the same popover may also show one **Current activity** row above the execution sections. Pomegr accepts only explicitly recognized provider UI activity-summary records, normalizes them to a bounded one-line label plus transcript-derived timestamp, deduplicates duplicate event and response-item representations, and retains only the latest valid observation for the owning agent. The observation is exposed only while its owning turn remains open and is cleared on recognized turn completion, failure, stop, or other terminal agent state. Historical sessions omit it.

The normalized optional `agent.currentActivity` field is provider-reported transient metadata. It is not chain-of-thought, an execution task, a shell description, a plan item, a task signal, an efficiency signal, or a completion claim. Unknown reasoning shapes, encrypted reasoning, prompts, responses, commands, tool arguments, tool results, control characters, and unsupported future fields are ignored. Current activity does not alter execution labels, running/finished counts, durations, tool-call totals, metrics, recommendation rules, or generated reports.

Codex may record a dedicated guardian subagent for automatic approval review. Pomegr recognizes only that exact provider subtype, labels it **Approval reviewer**, and maps it to the normalized reviewer role. A completed guardian turn enters `agent.reviewDecisions` only when its final message is valid JSON with the exact recognized outcome `allow` or `deny`; these become the fixed browser values `allowed` and `denied` with the provider completion timestamp. Pomegr also accepts only the fixed provider-reported risk values `low`, `medium`, or `high` (otherwise `unknown`) and a non-negative provider-reported review duration capped at one hour. These fields are evidence reported by the Codex reviewer, not Pomegr judgments. The monitor separately classifies the final structured approval request into one bounded action enum: build or test, browser interaction, dependency change, file change, filesystem action, local process, network access, version-control action, shell command, or privileged action. This is a deterministic Pomegr category derived from the reviewed tool and bounded command evidence; malformed, unsupported, or ambiguous requests fall back to privileged action. The feed reports allowed and denied totals, retains at most the newest 100 decisions in chronological order, and marks truncation explicitly. Provider turn IDs, reviewed prompts and commands, working directories, paths, justifications, authorization fields, rationale, messages, reasoning, and every unrecognized outcome remain monitor-private. Review decisions appear as their own section in the agent-activity popover and never increment shell-task or tool-call counts.

## Skill usage

Skill usage requires concrete transcript evidence. Pomegr counts explicit provider skill-invocation records. For current Codex desktop `exec` cells, it also counts a read of the exact `SKILL.md` source path declared in that session's host-skill catalog. Merely listing, mentioning, or making a skill available does not count as use.

Only the validated canonical skill name, invocation count, and latest observed timestamp enter normalized state. Skill source paths, catalog descriptions, exec-cell source, prompts, arguments, and tool output remain monitor-side and are never returned to the browser.

## Plan checklist

Pomegr also reads the selected provider's structured task records or structured plan updates and exposes them separately as `planTasks`. The Plan items badge and checkbox popover are intentionally distinct from Execution tasks: this checklist is an agent-maintained planning snapshot, not observed runtime state. The popover always warns that the snapshot changes only when the agent updates it and may be stale. Free-form plan prose is never parsed into checklist items.

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

Workflow workers are ordinary normalized agents for metrics. They contribute exactly once to agent counts, tool-call counts, and all-agent context. A workflow's displayed context is the sum of its linked agents' latest non-zero context snapshots; Pomegr never uses workflow-manifest token totals, tool totals, transcript throughput, or inferred spend. Workflow phase groupings are presentation metadata and do not add another metric contribution.

Each agent's wall time is measured from its earliest to latest recorded transcript timestamp. Active agents and parents waiting on active descendants continue counting from their recorded start time; finished and stopped agents retain their recorded duration. This is elapsed wall time and may include idle gaps.

## Session state

When Claude's local session registry is available, its entries are the primary liveness signal. For current registry records, Pomegr validates the bounded owner PID and process-start identity before accepting the entry; this prevents an orphaned JSON file or a reused PID from keeping an exited session live. The owner fields remain monitor-side and are never returned to the browser. A process-backed registered session remains live even while idle. Registry formats without owner identity retain the compatibility behavior. An unregistered transcript receives a 15-second grace window for startup ordering and final exit-time writes, then moves to history. The browser refreshes the local session catalog every five seconds, so registry-backed exits normally appear within a few seconds after that grace expires. No external API is called.

When the provider registry is unavailable, Pomegr falls back to the five-minute transcript/subagent activity window. This compatibility heuristic supports concurrent sessions but does not claim to detect operating-system process state.

Codex uses a separate evidence order: owning app-server status, a current allowlisted lifecycle-bridge lease, then a rollout-tail heuristic. App-server `active`, `idle`, `systemError`, and recognized waiting flags map directly. Bridge leases use a 15-second heartbeat and 45-second expiry; needs-input also has a 30-minute safety expiry. Rollout-only activity is active for 15 seconds, idle/recent through 120 seconds, and unavailable after 120 seconds. On Windows, Codex can append fresh records while the open rollout's reported modification time remains stale, so Pomegr also tracks bounded file-size/stat changes before applying that expiry gate. Rollout-only approval waiting is unsupported. These windows are liveness heuristics, not token metrics or operating-system certainty.

A recognized provider-authored Codex activity heading is scoped to its open turn, not to the 15-second rollout activity window. When only the rollout fallback has gone idle, an open heading keeps that agent active; explicit app-server and lifecycle-bridge idle states remain authoritative. The heading clears when a newer heading replaces it, a recognized terminal turn record arrives, the agent finishes or stops, or the view becomes historical. Pomegr preserves the provider timestamp so an older heading is never presented as newly observed merely because unrelated rollout activity resumed.

Selecting any live session keeps its state polling. When a selected session loses its live classification, it moves into history and polling stops until it becomes active again.

## Session progress estimate

Session progress is an optional agent-reported snapshot, not a Pomegr metric. When enabled by the project policy, the dashboard shows only the latest primary-session report: its phase (`planning`, `implementing`, `verifying`, `blocked`, or `complete`), integer percentage, optional paired remaining-minute range, confidence, and transcript timestamp. A later report replaces the earlier one, including when the percentage moves backward; a clear call or no report keeps the panel hidden. The progress bar is a semantic, text-labeled instrument and does not imply that Pomegr measured work or predicted completion.

Remaining minutes are displayed exactly as the bounded range reported by the agent. They are never accumulated, recalculated, decremented, or converted into a countdown. Complete progress at 100% omits the remaining estimate. Blocked, waiting, or needs-input states label the estimate as paused and retain the last reported values. A finished session without a complete report likewise keeps its last snapshot. Historical views say **Recorded agent estimate** and show the absolute report time.

For a live session, “may be stale” is shown only when the monitor is connected and unpaused, the primary agent is not waiting or needs-input, at least ten minutes have elapsed since the report, and later primary-agent activity is present. Offline, paused, waiting, needs-input, blocked, and historical views freeze the snapshot without a stale warning. This age gate is a presentation rule; it never changes the underlying report or its range/confidence values.

## User attention

`needs_input` is an operational attention state, not an efficiency signal. The dashboard presents it through live-session navigation and the affected agent's status in the activity and tree views; the desktop app may also issue a transition notification. It does not enter the **Efficiency signals** panel.

For the Claude Code adapter, Pomegr reads the provider's local session registry and treats a `waiting` session whose safe wait category indicates input, approval, permission, or a question as needing user input. The raw wait value and question content are never sent to the browser. Transcript `AskUserQuestion` calls remain a fallback for sessions without registry state. A registered input wait remains live and takes priority for automatic live-session selection until the provider clears it.

For Codex, owning app-server waiting flags or lifecycle-bridge request kinds can mark needs-input. Rollout fallback recognizes a fresh unmatched structured `request_user_input` call. An idle authoritative source can also be supplemented by an assistant final answer from a structured Plan-mode turn; the structurally wrapped Codex proposed-plan form remains a fallback when the turn context has moved outside the bounded tail. The matching tool output or next user turn clears the respective wait; plan-confirmation waits expire after the same bounded needs-input interval as lifecycle observations. Questions, choices, plans, answers, approval reasons, and commands are discarded.

## Session approval mode

The session hero shows the latest recognized approval mode recorded by the provider on the primary session transcript. Claude Code approval modes may come from legacy user records or current standalone permission-mode records. Codex approval modes may come from recognized turn-context or thread-settings records and map `untrusted`, `on-request`, granular, and `never` policies to provider-neutral labels. Pomegr keeps only the fixed policy enum and observation timestamp; granular rules, sandbox settings, writable roots, requested commands, approval reasons, and every other field are discarded. A historical view labels the value as the last approval mode because it does not imply that the configuration remains active.

## Session duration

Elapsed wall time is the difference between the earliest and latest recorded timestamps. It includes idle gaps and overlapping work.

## Efficiency signals

`monitor/efficiency-signals.mjs` is the executable catalog for rules shown in the **Efficiency signals** panel. Cache evidence thresholds live in `monitor/cache-events.mjs`; the efficiency catalog consumes normalized miss-refill events rather than reinterpreting provider snapshots. Rule changes remain covered by focused tests and reflected here.

The current catalog contains these deterministic rules. IDs containing angle-bracket placeholders are per-event patterns rather than literal browser values.

| ID | Signal | Level (`Insight.level`) | Description |
| --- | --- | --- | --- |
| `automatic-compaction-<agent-id>` | Automatic context compaction | `warning` | Appears when the provider explicitly records an `auto` trigger or when Pomegr recognizes Codex's exact in-turn windowed-compaction lifecycle described below. It includes the pre-compaction context snapshot when valid evidence is available. At most three automatic-compaction signals are shown. |
| `loop-<agent-id>-<index>` | Repeated tool call | `warning` | Appears when an agent makes the same scoped call with unchanged inputs at least three times. At most three repetition signals are shown. |
| `overlap-<display>` | Concurrent mutation | `warning` | Appears when at least two agents mutate the same edit anchor, whole-file target, or notebook cell within 30 seconds. At most two overlap signals are shown. |
| `unshared-context-pressure` | Unshared context pressure | `warning` | Appears when the primary agent's latest context snapshot is at least 150,000 tokens, the primary agent has made at least 40 observed tool calls, and no subagent transcript has been observed. Finished and stopped subagents still count as observed delegation. It describes a possible delegation opportunity; it does not claim that the work was parallelizable, that delegation would have reduced total context, or that a project instruction was violated. |
| `prompt-cache-miss-<agent-id>` | Prompt cache miss and refill after idle gap | `warning` | Appears at most once per affected Claude agent from a normalized `miss_refill` event. It requires the cache-read transition, 30-minute gap, and simultaneous recorded refill described above. It never assigns a cause, cost, charge, or savings amount. Codex cache classification remains disabled while its session telemetry does not provide reliable cache-write counts. |
| `healthy-flow` | Healthy fallback | `info` | Appears only when none of the warning rules emit a signal. |

The compaction parser allows only the normalized agent identity, event timestamp, non-negative pre-compaction token count, bounded trigger state, and whether a recognized provider lifecycle supplied that state into the rule engine. Trigger state is `auto`, `manual`, or `unknown` only when neither the provider nor a recognized lifecycle identifies it; unrecognized or conflicting values are rejected. The compacted summary, provider event content, and all other compaction metadata remain monitor-side and never enter browser state. On first observation Pomegr scans each selected Claude transcript for these bounded events, then merges new tail records into an in-memory cache so an earlier compaction remains visible as the transcript grows. Automatic compaction is evidence that context pressure caused the provider to summarize earlier conversation detail; it is not a quality judgment or proof that the session failed.

Codex compaction records follow the same bounded evidence contract. Provider-reported `auto` and `manual` triggers remain authoritative. Current windowed rollouts may omit that trigger, so Pomegr recognizes only two narrow lifecycle receipts: compaction inside an active task followed by a reset `turn_context` and continuation is classified as automatic; a newly started task containing only compaction and then completing is classified as manual. The automatic classification produces the warning above and explicitly says that it is a Pomegr lifecycle classification. Manual compaction remains available as a context-history boundary but does not produce an efficiency signal because it may be deliberate maintenance. Triggerless records that match neither receipt remain `unknown` and do not produce an efficiency signal. A present but unrecognized or conflicting trigger invalidates the record. Live Codex reads hydrate recognized compactions from the bounded lifecycle-history window and retain at most the newest 100 normalized events while a rollout grows, so a warning or boundary does not disappear when its source record moves outside the smaller live-state tail. Replacement, truncation, or deletion invalidates that retained evidence.

Codex repetition, concurrent-mutation, unshared-context, and healthy-fallback rules run only when recognized rollout or canonical tool evidence is available. Missing app-server turns or rollout history disables the affected rule; Pomegr does not silently substitute timestamps, prose, file modification times, or cumulative token totals. Provider-generated summaries, estimated cost, and context machinery are unavailable for Codex and therefore contribute no metrics or efficiency evidence.

Claude cache classification uses per-assistant-message usage with explicit cache-read and cache-write evidence. Missing, malformed, synthetic, cumulative-only, duplicate-only, or unsupported usage disables comparison. Codex cache classification is disabled while subscription-backed session records do not provide reliable cache-write counts; Pomegr never fabricates the missing evidence from later reads.

OpenAI's current [prompt-caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) defines `prompt_cache_options.ttl = "30m"` for GPT-5.6-family and later models as a minimum cache lifetime, not an exact expiration time or maximum retention period; a prefix may remain eligible longer. Cache misses can also follow a changed exact prefix, breakpoint or key behavior, routing, eviction, model changes, or a prefix that was never written. Pomegr therefore keeps the same cautious cache-miss wording even beyond 24 hours for GPT-5.6-family evidence. Older model families have different in-memory and extended-retention policies, so elapsed time alone never proves expiration. Codex subscription usage is not translated into API list-price billing.

The unshared-context rule uses the latest context snapshot rather than cumulative transcript throughput or token spend. Tool calls provide evidence of sustained execution; elapsed wall time is deliberately excluded because it includes idle gaps. Pomegr does not parse natural-language instructions such as `AGENTS.md` to infer a delegation policy.

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

The live Home view retains at most 64 valid observations for each eligible provider-reported limit in the current monitor process. Claude Code uses its five-hour limit. Codex counts bounded local request observations by normalized model over the preceding seven days: when GPT-5.3-Codex-Spark has a unique highest count, Home selects its five-hour limit; otherwise, including ties or unavailable model evidence, Home selects the general Codex seven-day limit. The model counts remain monitor-private. A reset-time change or a lower percentage begins a new observation series. For two comparable observations whose percentage increased, Pomegr reports the observed percentage-point movement and whether zero, one, or several locally discovered sessions had an independent valid request observation inside that refresh interval. One session is labeled a single-session correlation, several are labeled shared and ambiguous, and no matching request is labeled unobserved local activity. These labels are deterministic temporal correlations, not provider attribution, billing, causation, or evidence that a session consumed a proportional share.

For Claude Code only, the Home API may also include the earliest locally recorded structured rejection whose bounded quota metadata identifies the current five-hour reset window. This timestamp is not the authoritative instant the provider exhausted the account. The browser receives only that normalized timestamp; rejection payloads and other quota fields remain monitor-private. Missing, malformed, out-of-window, or differently scoped rejection evidence produces no timestamp.

The Home limit-activity UI keeps the percentage display deliberately sparse: session request observations appear first, followed by a fixed 0–100% range. It labels the known window start and adds one terminal mark with the earliest provider-observation timestamp only when the current series actually reports 100%. Repeated intermediate percentage observations are not plotted.

When a provider reports a percentage reset but temporarily omits the next reset timestamp, Pomegr keeps the previous cycle's reset boundary as the exact start of the new window. A cold monitor may recover that same boundary from matching normalized local five-hour rejection evidence. Only when neither source exists does the timeline use a non-exact lookback matching the selected window; observations and rejection markers from before the selected boundary never carry into the new window.

Current-window correlation considers bounded live and recently updated completed sessions from the same provider across repositories, while project folios remain live-project-only. The browser receives only bounded session/project labels, live state, opaque request-observation IDs and timestamps, bounded plan percentage observations, movement intervals, correlation enums, and coverage flags. At most 24 candidate sessions per provider contribute browser-visible correlation lanes, while the monitor may inspect up to 50 recent Codex sessions for its private seven-day dominant-model selector. At most 240 individual request observations are returned across provider activities. When that cap applies, Pomegr retains the newest observation from each visible session lane before retaining the next-newest observation from each lane in deterministic rounds; a lane is omitted only when the cap cannot retain even one of its observations, and movement correlation IDs are reduced to the retained lanes. The UI discloses bounded or partial coverage. Pomegr never sums request tokens, requests, agents, or sessions through the browser surface, never derives a usage rate or spend estimate, and never substitutes context level, wall time, process resources, or estimated API cost for plan consumption. Observation history is live diagnostic state only: it resets with the monitor process or provider window and remains excluded from historical session views and reports.

## Git state

Live branch metadata comes from read-only Git commands against the primary session's working directory. Pomegr resolves the live default branch from `origin`, fetches its commit objects into a temporary Pomegr-owned bare repository, and caches the result for one minute. It never updates the observed repository's remote-tracking refs, `FETCH_HEAD`, index, or working tree. On a feature branch, Pomegr shows bounded commit metadata unique to the live remote default branch (normally `origin/main`) and ahead/behind counts against that remote snapshot. When graph history says a feature branch is ahead but Git's deterministic merge-tree result is identical to the remote tree, Pomegr reports zero unmerged commits and labels the branch changes as integrated; this handles squash merges without pretending the rewritten commits are still outstanding. On the default branch, it shows recent commits and divergence from the live remote branch. Remote failures degrade independently and never fall back to potentially stale local remote-tracking counts. Commit metadata is limited to the abbreviated hash, a bounded subject, and commit timestamp; author identity and commit bodies are not exposed. Live views also show uncommitted file status and paths. Historical views show only a branch recorded in the transcript when one is available; they never substitute the current repository or working tree for historical Git state.

## Pull-request associations

Pomegr associates a pull request with a session only when a successful, recognized pull-request creation tool result contains a canonical GitHub pull-request URL, or when GitHub reports a pull request for the live session's current branch. Historical sessions never infer associations from the current working tree or branch. A transcript-recorded association may refresh its current GitHub status, which is labeled with the local observation time rather than presented as recorded historical state.

The monitor parses tool results privately and returns only an allowlist: host, repository slug, pull-request number, bounded title, canonical URL, open/draft/merged/closed state, head and base branch names, non-negative additions and deletions, association source, and timestamps. Commands, raw tool output, PR bodies, authors, comments, reviews, checks, and credentials never enter the browser API. GitHub CLI and network failures degrade independently; a safely parsed transcript link can remain visible without current metadata.
