# Codex provider integration plan

## Objective

Add Codex sessions to Threadlight without regressing the Claude Code adapter or weakening the normalized browser API, privacy guarantees, metric conventions, or read-only monitor behavior.

This plan is divided into tasks intended to be completed in separate coding sessions. Each task should leave the repository in a buildable, tested state and should avoid pulling later tasks into its scope.

## How to use this plan

Start a new session with a request such as:

> Implement `TL-CX-04` from `docs/plans/codex-provider-integration.md`. Preserve unrelated working-tree changes and stop when that task's acceptance criteria are met.

Before starting any task:

1. Read `AGENTS.md`, this plan, and the files named by the task.
2. Run `git status --short` and preserve unrelated changes.
3. Confirm all dependencies listed for the task are complete.
4. Keep raw prompts, responses, commands, tool output, credentials, and private session content out of fixtures, logs, snapshots, and browser state.
5. Update the task checkbox and its implementation notes only when the task is actually complete.

## Architectural direction

- Keep `monitor/server.mjs` as the provider-neutral HTTP monitor and orchestrator.
- Move provider-specific discovery and parsing under `monitor/providers/`.
- Prefer the documented Codex app-server contract for stable thread metadata and account rate limits.
- Use Codex rollout JSONL only for persisted history or metadata that the read-only app-server surface does not provide reliably.
- Do not use Codex private SQLite tables as the primary integration contract.
- On Windows, do not assume another Codex process can be observed through `codex app-server daemon`; the locally installed CLI reports daemon lifecycle support as Unix-only.
- Provider adapters must return normalized metadata. React components must not understand Claude or Codex transcript schemas.
- Optional provider capabilities must degrade independently. A missing cost estimate, context-machinery snapshot, plan checklist, summary, or usage limit must not fail the session.

## Initial capability matrix

| Capability | Claude Code | Codex target | Initial Codex source |
|---|---|---|---|
| Session catalog and history | Yes | Yes | App-server thread metadata and/or rollout index |
| Live session classification | Registry-backed | Yes | Outcome of `TL-CX-02` |
| Needs-input state | Registry plus transcript fallback | Yes | Outcome of `TL-CX-02` plus unresolved structured calls |
| Parent/child agents | Transcript tree | Yes | `sessionId`, `parentThreadId`, and collaboration records |
| Model and effort | Transcript | Yes | Turn context or thread settings |
| Latest context snapshot | Assistant usage | Yes | Codex `last_token_usage` only |
| Context-growth timeline | Latest snapshots over time | Yes | Codex token-count events |
| Sanitized tool activity | Yes | Yes | Canonical Codex thread items or rollout calls |
| Execution tasks | Bash lifecycle | Yes | Codex command-execution lifecycle |
| Plan tasks | Structured Claude task store | Best effort | Structured Codex plan updates when available |
| Usage limits | Anthropic endpoint | Yes | Codex account rate-limit read |
| Threadlight MCP signals | Yes | Yes | Recognized Codex MCP tool calls |
| Estimated API cost | Claude status line | No initial support | Return `null` |
| Context machinery | Claude `/context` output | No initial support | Return `null`; hide provider-specific prompt |
| Provider session summary | Recognized Claude record | No initial support | Return `null` unless a safe documented record exists |
| Automatic compaction trigger | Explicit auto/manual record | Partial | Do not emit the warning without an explicit automatic trigger |

## Milestones

- **Foundation:** `TL-CX-01` through `TL-CX-05`
- **Codex beta:** `TL-CX-06` through `TL-CX-13`
- **Production readiness:** `TL-CX-14` through `TL-CX-16`
- **Post-launch efficiency signals:** `TL-CX-17` and later follow-up tasks

---

## TL-CX-01 — Freeze the normalized provider contract

- [x] Complete
- **Completed:** 2026-08-10
- **Depends on:** none
- **Target size:** 0.5–1 session

### Implementation notes

- Added the typed provider boundary and sanitized evidence shapes in `monitor/providers/provider-contract.ts`.
- Added deny-by-default capability validation, fixed provider provenance, and safe provider-qualified session ID helpers in `monitor/providers/provider-contract.mjs`.
- Made empty monitor state provider-aware while preserving `Claude Code` as the existing default.
- Added focused provider-contract tests and kept all current runtime behavior unchanged.

### Goal

Define the provider interface and optional capability semantics before moving existing Claude logic.

### Work

- Add a provider contract under `monitor/providers/` that covers:
  - provider identity and display name;
  - session discovery and catalog summaries;
  - selected session plus child-agent sources;
  - normalized timestamps, labels, working directory, model, effort, and approval mode;
  - normalized tool/activity records and latest usage snapshots;
  - optional plan tasks, usage limits, cost, summary, context machinery, signals, and compactions;
  - explicit capability flags for provider-specific UI behavior.
- Decide how session IDs remain unique if Claude and Codex produce the same raw ID. Prefer an opaque provider-qualified browser ID while retaining the provider-local ID monitor-side.
- Make empty-state creation accept a provider/source rather than defaulting permanently to Claude Code.
- Document the interface with JSDoc or TypeScript types; do not add Codex parsing yet.

### Acceptance criteria

- The contract can represent all current Claude state without loss.
- Optional capabilities have documented `null`/empty behavior.
- No raw transcript record is part of the provider-neutral return type.
- Existing runtime behavior is unchanged.

### Verification

```powershell
npm run build
npm run test:node
```

---

## TL-CX-02 — Resolve Windows liveness and needs-input strategy

- [x] Complete
- **Completed:** 2026-08-10
- **Depends on:** `TL-CX-01`
- **Target size:** 1 session

### Implementation notes

- Added the accepted design in `docs/plans/codex-windows-liveness-strategy.md`.
- Selected an opt-in, allowlisted Codex lifecycle-hook bridge as the general Windows source, with an explicitly connected owning app-server taking priority when available.
- Defined a bounded rollout-tail heuristic for installations where hooks or an owning app-server connection are unavailable.
- Documented stale-state expiry, needs-input clearing, historical isolation, privacy allowlists, and the tested process-local app-server limitation on Windows.

### Goal

Choose and document a reliable, read-only method for classifying Codex threads as live, idle, active, or waiting for input across Codex CLI and desktop processes on Windows.

### Work

- Evaluate, in order:
  1. a documented read-only connection to an already running Codex app-server;
  2. app-server thread status combined with rollout-tail evidence;
  3. a small Codex-side event/status bridge that persists only allowlisted lifecycle metadata;
  4. bounded transcript-activity fallback when no reliable live source exists.
- Test whether a newly spawned app-server reports the status of threads owned by another Codex process; do not assume it does.
- Determine how unresolved user-input and approval requests can be detected without exposing their question, choices, command, or answer.
- Record the selected design and fallback in `docs/ARCHITECTURE.md` or a focused ADR under `docs/plans/`.
- Add no private SQLite dependency unless the user explicitly approves a separately documented compatibility fallback.

### Acceptance criteria

- The selected source, fallback, stale-state behavior, and Windows limitation are documented.
- The design identifies how live status clears after a process exits.
- The design identifies how needs-input clears after the user responds.
- Any heuristic is labeled as a heuristic and does not claim operating-system certainty.

### Verification

- Capture sanitized test observations only: IDs, lifecycle enums, timestamps, and record-type/key names.
- Confirm no diagnostic artifact contains prompts, answers, commands, stdout, stderr, or credentials.

---

## TL-CX-03 — Add provider fixtures and privacy assertions

- [x] Complete
- **Completed:** 2026-08-10
- **Depends on:** `TL-CX-01`
- **Target size:** 1 session

### Implementation notes

- Added bounded synthetic Claude and Codex rollout, registry, task, status-line, malformed, truncated, unknown-record, and expected-evidence fixtures under `tests/fixtures/providers/`.
- Added shared fixture readers and a fail-closed privacy-sentinel assertion in `tests/helpers/provider-fixtures.mjs`.
- Added contract-aligned synthetic `MonitorState` serialization checks for both providers without reading real user sessions.
- Registered the focused provider-fixture suite in `npm run test:node`.

### Goal

Create synthetic, reviewable fixtures that allow provider extraction and Codex parsing to proceed without reading real user conversations during tests.

### Work

- Add minimal synthetic Claude fixtures for every current normalized feature used by extraction tests.
- Add synthetic Codex rollout fixtures for:
  - session metadata and turn context;
  - token-count events;
  - command, file-change, MCP, dynamic-tool, collaboration, and user-input lifecycles;
  - parent and child thread metadata;
  - malformed, truncated, and unknown records.
- Use unmistakably fake content and secrets such as `PROMPT_MUST_NOT_LEAK` and `TOOL_OUTPUT_MUST_NOT_LEAK`.
- Add a shared assertion that serialized monitor state contains none of the sentinel private values.
- Keep fixtures bounded; do not copy real rollouts or provider credential files.

### Acceptance criteria

- Fixtures cover both providers and malformed-line behavior.
- Privacy sentinel assertions fail if raw content reaches normalized state.
- Tests need no access to `%USERPROFILE%\.claude` or `%USERPROFILE%\.codex`.

### Verification

```powershell
npm run test:node
```

---

## TL-CX-04 — Extract the Claude adapter

- [x] Complete
- **Completed:** 2026-08-10
- **Depends on:** `TL-CX-01`, `TL-CX-03`
- **Target size:** 1–2 sessions

### Implementation notes

- Added the Claude provider adapter in `monitor/providers/claude.mjs`, with discovery, registry selection, transcript parsing, runtime metadata, tasks, cost, context machinery, summaries, approval mode, signals, compactions, and authenticated usage limits behind the provider boundary.
- Kept Git inspection, GitHub metadata lookup, context aggregation, activity grouping, scoring, and deterministic efficiency rules in the provider-neutral monitor orchestration.
- Moved Claude transcript PR-result parsing into a provider helper and passed only canonical successful creation URLs to shared GitHub metadata lookup.
- Added synthetic adapter regression/privacy tests and a source assertion that the monitor contains no Claude credential paths, Anthropic endpoints, or transcript schema checks.

### Goal

Move Claude-specific discovery and parsing out of `monitor/server.mjs` without changing observable Claude behavior.

### Work

- Create `monitor/providers/claude.mjs` and provider-focused helpers where useful.
- Move Claude roots, environment overrides, registry access, transcript discovery, record decoding, title extraction, runtime metadata, task-store access, status-line cost, context machinery, summary, approval mode, and authenticated plan usage behind the adapter.
- Keep Git inspection, GitHub metadata lookup, HTTP routing, caching orchestration, normalized metrics, and deterministic rule evaluation provider-neutral.
- Preserve existing exported helper APIs until their tests are migrated intentionally.
- Do not rename user-facing features or change metrics in this task.

### Acceptance criteria

- Claude session catalog, live selection, history, agents, metrics, usage limits, signals, Git, and reports remain unchanged.
- `monitor/server.mjs` no longer contains Claude credential paths, Anthropic URLs, or Claude transcript schema checks.
- Provider failures still degrade independently.

### Verification

```powershell
npm run build
npm test
npm run lint
```

---

## TL-CX-05 — Make monitor orchestration provider-neutral

- [x] Complete
- **Completed:** 2026-08-10
- **Depends on:** `TL-CX-04`
- **Target size:** 1 session

### Implementation notes

- Added a provider registry with a production registration entry point; Claude remains the only loaded adapter and the monitor now consumes it exclusively through the registry.
- Merged allowlisted catalog summaries under provider-qualified IDs with deterministic recency and tie ordering, duplicate/unsafe-ID rejection, and independent provider failure handling.
- Routed explicit IDs only to their owning provider and made automatic selection prefer live needs-input sessions, then recent live activity, then recent history.
- Kept usage limits and Git state scoped to the selected provider evidence, with safe empty historical states for unknown, malformed, missing, or failed selections.
- Added deterministic registry, routing, privacy, fallback, and production-registration tests.

### Goal

Allow one monitor process to discover and select sessions from multiple providers while preserving the browser API.

### Work

- Add a provider registry and load the Claude adapter through it.
- Merge provider catalogs with stable ordering and provider-qualified IDs.
- Route `/api/state?sessionId=...` to the owning provider without trusting arbitrary paths or provider input.
- Define automatic live-session selection when multiple providers have live sessions. Prefer explicit selection, then needs-input sessions, then most recent safe activity.
- Add provider/source metadata to session summaries if required for disambiguation, updating the frontend and contract together.
- Ensure historical selection never receives current usage limits or current Git state from another provider.

### Acceptance criteria

- Claude remains the only loaded provider but runs entirely through the registry.
- Unknown or malformed session IDs produce a safe empty state.
- Catalog ordering and selected-session behavior have deterministic tests.
- No provider-local path is accepted from a browser query.

### Verification

```powershell
npm run build
npm run test:node
npm run test:ui
```

---

## TL-CX-06 — Implement the Codex session catalog and history reader

- [x] Complete
- **Completed:** 2026-08-10
- **Depends on:** `TL-CX-02`, `TL-CX-03`, `TL-CX-05`
- **Target size:** 1 session

### Implementation notes

- Added a Codex provider with stable `CODEX_HOME` discovery, provider-qualified catalog provenance, and historical-only state pending the dedicated liveness task.
- Preferred allowlisted `thread/list` and `thread/read` metadata through an owning app-server client seam, using only explicit thread names and never previews or loaded turns.
- Added bounded `session_index.jsonl`, active rollout-header, and archived rollout-header fallbacks with malformed-line, missing-file, safe-ID, source-kind, and deterministic catalog handling.
- Registered Codex beside Claude and added focused privacy, history, archive, missing-session, bounded-catalog, and regression coverage without parsing activity or agent metadata.

### Goal

List Codex sessions and load a selected persisted session without yet deriving full activity or metrics.

### Work

- Create `monitor/providers/codex.mjs` plus focused parser helpers.
- Discover Codex home from supported configuration/environment rules.
- Prefer documented app-server `thread/list`/`thread/read` metadata where practical; use `session_index.jsonl` and rollout headers as bounded fallbacks.
- Use only safe title sources such as the explicit thread name. Never expose the app-server `preview`, because it may be the first user prompt.
- Normalize ID, provider, title, working directory, project, created/updated timestamps, source kind, history/live classification, and recorded Git branch metadata.
- Support malformed lines, missing rollouts, archived sessions if included by product scope, and bounded catalog size.

### Acceptance criteria

- Codex sessions appear beside Claude sessions with unambiguous IDs/source labels.
- Selecting a historical Codex session returns only recorded metadata.
- Missing or deleted sessions return the existing safe missing-session state.
- No preview, user message, agent message, or rollout path is serialized to the browser.

### Verification

```powershell
node --test tests/codex-session-discovery.test.mjs tests/session-registry.test.mjs
npm run build
```

---

## TL-CX-07 — Parse Codex thread and agent metadata

- [x] Complete
- **Completed:** 2026-08-10
- **Depends on:** `TL-CX-06`
- **Target size:** 1 session

### Implementation notes

- Added a privacy-bounded Codex agent metadata parser for session relationships, collaboration lifecycle records, latest model/effort/settings metadata, transcript timing, and terminal outcomes.
- Built deterministic primary, nested subagent, fork, resumed, interrupted, unknown-source, and missing-rollout agent trees from app-server metadata plus rollout relationships.
- Kept collaboration prompts, developer instructions, writable roots, raw tool output, previews, turns, and provider-local rollout paths out of provider evidence.
- Added focused fixtures and regression coverage for active, idle, finished, stopped, missing-child, wall-time, cross-session isolation, and neutral fallback behavior.

### Goal

Build the normalized primary-agent and subagent tree for Codex sessions.

### Work

- Map Codex `sessionId`, `parentThreadId`, collaboration records, agent nickname, and agent role to normalized agent IDs, parents, labels, and kinds.
- Normalize model, reasoning effort, approval policy, sandbox presentation label, start/update times, duration, and terminal status.
- Do not expose collaboration prompt text or developer instructions.
- Handle missing child rollouts, resumed agents, forks, stopped agents, and unknown future source kinds.
- Keep wall-time semantics consistent with `docs/METRICS.md`.

### Acceptance criteria

- Primary and child agents form a deterministic tree.
- Model and effort are taken from the latest recognized provider record.
- Unknown metadata degrades to bounded neutral labels.
- Agent timing and status fixtures cover active, idle, completed, interrupted, and missing-child cases.

### Verification

```powershell
node --test tests/codex-agent-metadata.test.mjs tests/agent-metadata.test.mjs
npm run build
```

---

## TL-CX-08 — Normalize Codex tools and recent activity

- [x] Complete
- **Completed:** 2026-08-10
- **Depends on:** `TL-CX-07`
- **Target size:** 1–2 sessions

### Implementation notes

- Added provider-local normalization for canonical and rollout command, file-change, MCP, dynamic, collaboration, web, image, input-request, tool-search, and wait calls with stable identities and lifecycle status.
- Exposed only bounded safe tool labels, targets, and basenames while retaining raw inputs solely for monitor-side repetition and hashed mutation evidence; unknown items are ignored.
- Extended `apply_patch` and canonical file-change mutation scopes across anchored hunks, whole-file changes, and moves without sending full paths, patches, or anchors across the provider boundary.
- Added deterministic recent-activity ordering/bounds plus focused totals, deduplication, privacy-sentinel, malformed/unknown, and mutation regression coverage.

### Goal

Convert Codex canonical items and rollout calls into Threadlight's safe activity and tool-pattern inputs.

### Work

- Recognize command execution, file changes, MCP calls, dynamic tools, collaboration tools, web search, image view/generation, and other supported canonical items.
- Generate stable call IDs, timestamps, actor IDs, safe tool names, bounded safe targets, lifecycle status, and monitor-side repetition inputs.
- Never expose commands, arguments, prompts, responses, reasoning, stdout, stderr, patches, full paths, or tool-result content.
- Extend mutation-scope normalization for Codex `apply_patch` and file-change events while keeping exact anchors/digests monitor-side.
- Preserve unknown item types as ignored records rather than generic raw objects.

### Acceptance criteria

- Tool totals equal the grouped tool-pattern totals.
- Recent activity is bounded and sorted consistently.
- Repetition signatures distinguish materially different safe calls without exposing their inputs.
- Sentinel private values cannot be found in serialized state.

### Verification

```powershell
node --test tests/codex-activity-events.test.mjs tests/activity-events.test.mjs tests/tool-efficiency.test.mjs
npm run build
```

---

## TL-CX-09 — Implement Codex execution-task lifecycle

- [x] Complete
- **Completed:** 2026-08-10
- **Depends on:** `TL-CX-08`
- **Target size:** 1 session

### Implementation notes

- Added provider-local normalization for Codex canonical and rollout command lifecycles, including foreground/background success, failure, interruption, duplicate-event merging, safe process IDs, and recorded timestamps/exit codes.
- Kept commands, parsed actions, terminal input, aggregated output, stdout, and stderr inside the adapter while exposing only the existing bounded shell-task contract.
- Attached signals only after matching known normalized execution or background IDs, populated per-agent task lists, preserved the primary compatibility field, and stopped incomplete historical tasks at the recorded session end.
- Added focused lifecycle, privacy-sentinel, signal-matching, historical-stop, per-agent, and compatibility coverage.

### Goal

Represent Codex command executions using the existing safe execution-task contract.

### Work

- Map command-execution start/completion/interruption/failure records to normalized shell tasks.
- Expose only normalized task ID, bounded description, shell kind, status, timestamps, background flag, background/process ID when safe, and exit code.
- Never expose the command, parsed command actions, aggregated output, terminal input, stdout, or stderr.
- Attach task signals only after monitor-side matching to a known execution ID.
- Mark unmatched historical executions stopped at the recorded session end, consistent with current semantics.

### Acceptance criteria

- Foreground and background lifecycle tests cover success, failure, interruption, missing completion, and duplicate events.
- Primary compatibility field and per-agent task lists remain consistent.
- No command or output sentinel reaches normalized state or reports.

### Verification

```powershell
node --test tests/codex-execution-tasks.test.mjs tests/execution-tasks.test.mjs
npm run build
```

---

## TL-CX-10 — Implement Codex context snapshots and timeline

- [x] Complete
- **Completed:** 2026-08-10
- **Depends on:** `TL-CX-07`
- **Target size:** 1 session

### Implementation notes

- Added a Codex rollout context parser that reads only `last_token_usage`, rejects cumulative-only and zero/synthetic records, deduplicates stable provider event identities, and emits chronological per-agent snapshots.
- Mapped uncached input, cached input, cache-write input, generated output, reasoning-output metadata, per-snapshot totals, and model context windows without counting cached input or reasoning output twice; shared aggregation continues to use each visible agent's latest non-zero snapshot.
- Added bounded explicit-trigger compaction evidence, Codex metric documentation, and focused coverage for timeline repetition, privacy, primary/child aggregation, malformed cumulative evidence, and automatic-warning gating.

### Goal

Map Codex token-count events to Threadlight's latest-context metric without introducing cumulative throughput.

### Work

- Read `last_token_usage`, not `total_token_usage`, for the displayed agent snapshot.
- Map input, output, cached input, cache-write input, reasoning output, total tokens, and model context window into the normalized contract without double-counting reasoning output.
- Deduplicate snapshots by a stable provider event/message identity.
- Feed chronological latest snapshots into the existing context-growth timeline algorithm.
- Treat zero/synthetic snapshots as unavailable.
- Parse compaction records only as bounded events. Do not emit the automatic-compaction warning unless Codex records an explicit automatic trigger.
- Update `docs/METRICS.md` for any Codex-specific mapping or limitation.

### Acceptance criteria

- Agent context is the latest non-zero snapshot for that agent.
- All-agent context is the sum of visible agents' latest snapshots.
- No cumulative `total_token_usage`, token spend, or recent token rate is exposed.
- Repeated snapshots contribute zero timeline growth.

### Verification

```powershell
node --test tests/codex-context.test.mjs tests/context-growth-timeline.test.mjs tests/efficiency-signals.test.mjs
npm run build
```

---

## TL-CX-11 — Add Codex approval mode and plan tasks

- [x] Complete
- **Completed:** 2026-08-11
- **Depends on:** `TL-CX-07`
- **Target size:** 1 session

### Implementation notes

- Added provider-neutral Codex approval modes for `untrusted`, `on-request`, granular, and `never`, retaining only the fixed mode, bounded label, provider provenance, and valid observation timestamp.
- Added latest-valid structured Codex plan normalization for rollout tool calls and documented app-server plan updates, with stable bounded IDs, mapped statuses, empty dependencies, and no natural-language plan inference.
- Added focused rollout, missing, malformed, privacy-sentinel, browser-state, Claude regression, historical-label, UI, and TypeScript contract coverage; plan prose, explanations, permission details, commands, and approval reasons remain provider-local.

### Goal

Expose bounded Codex approval-policy metadata and the latest structured plan when available.

### Work

- Extend the normalized approval-mode contract to represent Codex `untrusted`, `on-request`, granular, and `never` policies using provider-neutral IDs/labels.
- Record only the recognized policy enum and observation timestamp; do not expose permission rules, writable roots, requested commands, or approval reasons.
- Normalize structured Codex plan steps to ID, subject, and status.
- Do not infer dependencies when the provider does not supply them.
- If only free-form plan prose is available, return no plan tasks rather than parsing natural language.
- Make plan UI copy provider-neutral and continue labeling the checklist as agent-maintained and potentially stale.

### Acceptance criteria

- Approval modes from both providers render without weakening TypeScript exhaustiveness.
- Historical modes are labeled as last recorded, not current.
- Plan fixtures cover pending, in-progress, completed, missing, and malformed updates.
- Plan explanations and other long-form text never enter browser state.

### Verification

```powershell
node --test tests/codex-approval-mode.test.mjs tests/session-approval-mode.test.mjs tests/codex-plan-tasks.test.mjs tests/session-tasks.test.mjs
npm run build
npm run test:ui
```

---

## TL-CX-12 — Add Codex usage limits

- [x] Complete
- **Completed:** 2026-08-11
- **Depends on:** `TL-CX-05`, `TL-CX-06`
- **Target size:** 0.5–1 session

### Implementation notes

- Added documented `account/rateLimits/read` normalization for deterministic multi-bucket primary and secondary windows, with bounded IDs, labels, percentages, durations, reset timestamps, severity, and reached state.
- Shared the existing request coordinator and five-minute cooldown across providers so concurrent browser polls coalesce while Claude Retry-After behavior remains unchanged.
- Discarded credits, spend controls, account/workspace/entitlement/authentication metadata, specific reached reasons, and raw errors; Codex limit failures degrade to a fixed provider-safe message without affecting session discovery.
- Centralized historical usage-limit exclusion in provider orchestration and added focused normalization, privacy, concurrency, cooldown, failure-isolation, and historical-state coverage.

### Goal

Map Codex account rate-limit windows to Threadlight's provider-neutral usage-limit panel.

### Work

- Use the documented/local app-server `account/rateLimits/read` response when available.
- Normalize limit ID/name, primary and secondary window duration, used percentage, reset time, and active/reached state.
- Do not expose credit balances, account identity, workspace identity, entitlements, raw backend errors, or authentication data.
- Reuse the shared request coordinator and cooldown behavior where applicable.
- Keep usage limits out of historical views and reports.
- Sanitize errors independently so a limit failure cannot fail session parsing.

### Acceptance criteria

- Multiple rate-limit buckets are deterministic and safely labeled.
- Percentages and reset timestamps are validated and bounded.
- Concurrent browser polls cannot multiply provider requests.
- Historical Codex state contains no current limits.

### Verification

```powershell
node --test tests/codex-usage-limits.test.mjs tests/usage-limits.test.mjs
npm run build
```

---

## TL-CX-13 — Integrate skills, signals, PRs, and efficiency rules

- [x] Complete
- **Completed:** 2026-08-11
- **Depends on:** `TL-CX-08`, `TL-CX-09`, `TL-CX-10`
- **Target size:** 1–2 sessions

### Implementation notes

- Added explicit Codex rollout/canonical skill evidence and rollout-only Threadlight MCP signal parsing with strict label/tone/input allowlists, rollout-derived actor/timestamps, latest replacement semantics, and monitor-side execution-task target resolution.
- Replaced provider-local PR URL lists with normalized successful creation events for both adapters; commands, arguments, and result content remain provider-local while the shared GitHub association path consumes only canonical URLs and bounded event provenance.
- Gated repetition, concurrent-mutation, unshared-context, and healthy-fallback rules on explicit provider evidence availability while retaining Claude's existing rule behavior, and added focused Codex/privacy/regression coverage.

### Goal

Feed normalized Codex events into the shared higher-level Threadlight features.

### Work

- Detect explicit Codex skill invocations from recognized metadata/tool calls only.
- Parse Threadlight MCP signal calls from Codex function/custom-tool records using the existing label/tone allowlist.
- Derive the reporting agent and timestamp from the rollout; never accept an MCP-supplied agent identity.
- Resolve task-signal target IDs only against normalized execution tasks.
- Refactor pull-request association to consume provider-neutral successful creation events, while keeping raw result parsing monitor-side.
- Run repetition, concurrent-mutation, unshared-context, and healthy-fallback rules over normalized evidence.
- Disable provider-specific rules when their required evidence is unavailable rather than substituting weaker evidence silently.

### Acceptance criteria

- Claude and Codex share the same rule engine and output contract.
- Signal replacement and task matching semantics remain unchanged.
- Unmatched task signals and raw MCP arguments never enter the browser API.
- Every emitted recommendation traces to a concrete normalized event.

### Verification

```powershell
node --test tests/codex-session-signals.test.mjs tests/session-signals.test.mjs tests/codex-skill-usage.test.mjs tests/skill-usage.test.mjs tests/pull-requests.test.mjs tests/efficiency-signals.test.mjs
npm run build
```

---

## TL-CX-14 — Implement and harden Codex live-state behavior

- [x] Complete
- **Completed:** 2026-08-11
- **Depends on:** `TL-CX-02`, `TL-CX-06`, `TL-CX-07`, `TL-CX-08`
- **Target size:** 1–2 sessions

### Implementation notes

- Added owning app-server status priority, an opt-in allowlisted lifecycle-hook bridge with PID-plus-process-start owner leases, and a bounded cached rollout-tail fallback.
- Added deterministic start, active, idle, waiting/needs-input, answer, finish/close, interruption, system-error, lease expiry, prompt expiry, shutdown/resume grace, and descendant waiting behavior.
- Kept current app-server/bridge/process/lease evidence out of historical reads; exposed only the normalized liveness source and observation timestamp, never hook content or owner identifiers.
- Bounded each rollout tail to 128 KiB/256 records, bridge scans to 500 files, and status caches to 1.5 seconds; documented the 15/45/120-second and 30-minute uncertainty windows.
- Automated Windows-safe bridge and privacy coverage passed. The requested manual smoke with two real sessions and one subagent was not run because enabling user-level hooks and launching extra Codex sessions would interfere with existing user sessions; this remains the sole manual verification limitation.

### Goal

Implement the liveness design chosen in `TL-CX-02` and make automatic session selection trustworthy enough for daily use.

### Work

- Implement the selected primary live-status source and bounded activity fallback.
- Map active, idle, waiting, needs-input, finished, stopped, interrupted, and system-error states to the existing normalized enum.
- Add startup/shutdown grace windows where file and registry/event ordering can race.
- Ensure parents waiting on active descendants use the existing waiting propagation semantics.
- Prefer needs-input sessions during automatic selection only when the evidence remains current.
- Cache status reads and avoid scanning every complete rollout on each 1.8-second browser poll.
- Document any remaining heuristic and its expected false-positive/false-negative window.

### Acceptance criteria

- Starting, idling, awaiting input, answering, finishing, and closing a Codex session produce deterministic state transitions in tests.
- Stale needs-input state clears.
- Historical sessions never become live solely because the current repository is active.
- Polling remains bounded under multiple concurrent Codex sessions and subagents.

### Verification

```powershell
node --test tests/codex-liveness.test.mjs tests/session-discovery.test.mjs tests/agent-metadata.test.mjs
npm run build
```

- Perform a manual Windows smoke test with two concurrent Codex sessions and one subagent.

---

## TL-CX-15 — Add provider capability gates and UI copy

- [x] Complete
- **Completed:** 2026-08-11
- **Depends on:** `TL-CX-10`, `TL-CX-11`, `TL-CX-12`, `TL-CX-14`
- **Target size:** 1 session

### Implementation notes

- Added the provider capability allowlist to normalized browser state with deny-by-default transitional behavior, and gated summaries, approval modes, plan tasks, usage limits, context machinery, and attributed estimated cost without inferring support from provider names.
- Added provider provenance to live and historical session navigation plus the session hero, with bounded overflow behavior for mixed-provider catalogs at desktop and narrow widths.
- Made reports omit provider-unsupported cost and plan-limit sections while preserving supplied zero estimates, and added UI/report/privacy regression coverage that keeps Claude `/context` and status-line estimate copy out of Codex views.
- Visually verified live Claude and historical Claude/Codex sessions at 1440×1000 and 390×844 with no horizontal overflow; a live Codex visual was unavailable without restarting the existing monitor or launching another session, both intentionally avoided for this task.

### Goal

Make the dashboard accurately present provider capabilities without Claude-specific instructions appearing in Codex views.

### Work

- Add provider/source labeling where needed in the session sidebar and hero.
- Hide or replace the `/context` instruction for providers without context-machinery support.
- Show estimated API cost only when a provider supplies the existing explicitly attributed estimate.
- Keep summary, approval-mode, plan-task, and usage-limit empty states provider-neutral.
- Ensure reports omit unsupported sections instead of claiming a zero value.
- Check responsive behavior and accessibility for mixed Claude/Codex catalogs.

### Acceptance criteria

- A Codex session never instructs the user to run Claude `/context` or describes a Claude status-line estimate.
- Optional panels distinguish unavailable from zero.
- Provider names are used only for provenance or provider-specific setup copy.
- Existing Claude rendering remains unchanged where its capabilities are present.

### Verification

```powershell
npm run build
npm run test:ui
npm run lint
```

- Visually inspect one live and one historical fixture for each provider at desktop and narrow widths.

---

## TL-CX-16 — Privacy audit, compatibility QA, and release documentation

- [x] Complete
- **Completed:** 2026-08-11
- **Depends on:** all previous tasks
- **Target size:** 1–2 sessions

### Implementation notes

- Added end-to-end synthetic HTTP serialization audits for `/api/state` and `/api/sessions`, covering both providers, every forbidden privacy category, fixed fail-closed errors, provider/Git/pull-request/usage failure isolation, deleted history, and historical exclusion of current Git and limits.
- Added snake_case/camelCase rollout fixtures plus direct/JSON-RPC app-server compatibility coverage for malformed, truncated, unknown, missing-child, unavailable-app-server, usage-failure, and deleted-history behavior.
- Made Codex selected-state reads parse each rollout once, bound live parsing to a cached 512 KiB tail, cache full historical parses, cap cache entries, and coalesce concurrent catalog polls; focused QA verifies bounded reads across eight synthetic large rollouts.
- Updated provider support/setup, architecture and liveness flow, Codex metric mappings and unavailable evidence, complete environment-variable reference, and troubleshooting guidance.
- Full build, 171 Node tests, 28 UI tests, focused privacy/performance QA, lint, and diff checks pass; lint reports only pre-existing warnings under `.agents/skills/impeccable`.

### Goal

Prove that Codex support satisfies Threadlight's privacy, metric, compatibility, and failure-isolation requirements before calling it production-ready.

### Work

- Add an API serialization audit covering both `/api/state` and `/api/sessions` with privacy sentinels for:
  - user prompts and answers;
  - agent responses and reasoning;
  - commands, patches, stdout, stderr, and tool outputs;
  - OAuth tokens, auth files, environment secrets, and provider-local private paths;
  - MCP arguments other than the bounded Threadlight signal allowlist.
- Test at least two recent Codex rollout/app-server schema versions when fixtures are available.
- Test unknown future record types, malformed JSONL, truncated live writes, missing child rollouts, app-server unavailable, usage-limit failure, Git failure, and deleted history.
- Run performance checks with multiple large rollouts and confirm polling uses tail reads/caches rather than repeated full scans.
- Update:
  - `README.md` provider support and setup;
  - `docs/ARCHITECTURE.md` provider flow and liveness;
  - `docs/METRICS.md` Codex mappings and unsupported signals;
  - environment-variable reference and troubleshooting guidance.
- Remove any temporary diagnostics or generated schema files.

### Acceptance criteria

- The browser API contains no forbidden sentinel value.
- Claude and Codex failures degrade independently.
- Historical views never expose current plan limits or current Git state.
- Metrics follow latest-snapshot semantics and never expose cumulative transcript throughput.
- Documentation clearly distinguishes supported, best-effort, and unavailable provider features.
- Full build, test, and lint suites pass.

### Verification

```powershell
npm run build
npm test
npm run lint
```

---

## TL-CX-17 — Detect costly prompt-cache misses after idle gaps

- [ ] Complete
- **Depends on:** `TL-CX-10`, `TL-CX-13`
- **Target size:** 1 session

### Goal

Add a deterministic Codex efficiency signal when a large context that previously received a strong prompt-cache read is subsequently processed mostly as uncached input after an idle gap, without claiming authoritative billing impact or attributing every cache miss to expiration.

### Provider facts and interpretation boundary

- For GPT-5.6-family models, OpenAI documents `prompt_cache_options.ttl = "30m"` as a minimum cache lifetime, not an exact expiration time. A cached prefix may remain eligible longer.
- Prompt-cache application state is not retained beyond 24 hours. Older model families and data-retention policies may use different in-memory or extended-retention behavior.
- A low cache-read count can also result from a changed prefix, compaction, model changes, a different cache key, routing, eviction, or a cache entry that was never written. Elapsed time and token counts alone do not prove which cause occurred.
- Codex subscription usage is not equivalent to API list-price billing. Describe observed token treatment as cached or uncached processing; do not say that the user paid a particular amount or was charged “full price.”

Reference the current official OpenAI prompt-caching and data-retention documentation when implementing this task, and update these facts if provider behavior changes.

### Work

- Preserve enough bounded, chronological `last_token_usage` evidence to compare adjacent Codex requests for the same normalized agent without exposing `total_token_usage` or accumulating transcript throughput.
- Add an explicit provider evidence capability for prompt-cache classification. Missing, malformed, synthetic, cumulative-only, or provider-unsupported usage must disable the rule.
- Centralize the rule and its fixed thresholds in `monitor/efficiency-signals.mjs`. Start with conservative candidate boundaries and validate them against synthetic fixtures:
  - current input context of at least 8,000 tokens;
  - previous cached-input share of at least 80 percent;
  - current cached-input share of at most 10 percent;
  - at least 30 minutes between the comparable observations.
- Treat a simultaneous large cache-write count as corroborating cold-refill evidence when the provider reports it, but do not require or fabricate it when Codex omits that field.
- Emit cautious copy such as **Prompt cache miss after idle gap**. State that expiration or eviction may have reduced efficiency and report only bounded normalized context size, cache-read share, and elapsed time.
- Reserve stronger expiration wording for a gap beyond the documented 24-hour maximum and only when the observations remain otherwise comparable. Do not describe a 30-minute gap as proof of expiration.
- Suppress the signal when known evidence makes the observations incomparable, including automatic or manual compaction, agent forks, model changes, unavailable intermediate usage, or a changed provider/session identity. A normal resume of the same thread is not by itself a suppression condition.
- Keep prompt content, cache keys, request bodies, response content, provider routing data, and pricing assumptions monitor-side or entirely unread. None may enter the normalized browser API.
- Document the final rule, thresholds, evidence gaps, and false-positive boundary in `docs/METRICS.md`.

### Acceptance criteria

- A large, previously cache-efficient context followed by a near-total cache miss after the threshold idle gap emits one bounded warning for the affected agent.
- The same token pattern before the idle threshold does not claim TTL expiration, and an observation between 30 minutes and 24 hours uses only cautious cache-miss wording.
- A comparable observation beyond 24 hours may use expiration wording but still makes no billing or savings claim.
- Compaction, fork, model-change, malformed-record, synthetic-record, cumulative-only, and missing-evidence fixtures do not emit the signal.
- Repeated polling and duplicate token-count records do not duplicate the warning.
- No cumulative transcript throughput, inferred cost, raw prompt content, cache key, or private provider field is serialized to `/api/state`, `/api/sessions`, reports, or UI fixtures.
- Existing Claude and Codex efficiency signals remain unchanged when prompt-cache evidence is unavailable.

### Verification

```powershell
node --test tests/codex-context.test.mjs tests/efficiency-signals.test.mjs tests/privacy.test.mjs
npm run build
npm test
```

## Definition of done

Codex support is complete when:

- Both providers appear in one safe, deterministic session catalog.
- Live and historical Codex sessions produce the same normalized session, agent, activity, token, repository, and insight shapes as Claude wherever equivalent evidence exists.
- Unsupported provider features are omitted or capability-gated without misleading fallbacks.
- Windows live-state behavior is documented and tested.
- The browser and generated reports contain no raw private session content.
- Claude behavior remains regression-tested.
- `README.md`, `docs/ARCHITECTURE.md`, and `docs/METRICS.md` describe the shipped behavior.

## Progress log

Add short entries here only after completing a task.

| Date | Task | Result | Notes |
|---|---|---|---|
| 2026-08-10 | TL-CX-01 | Complete | Provider contract, capability semantics, qualified IDs, provider-aware empty state, and focused tests added. |
| 2026-08-10 | TL-CX-02 | Complete | Accepted Windows liveness strategy: owning app-server when explicit, opt-in lifecycle bridge generally, bounded rollout heuristic as fallback. |
| 2026-08-10 | TL-CX-03 | Complete | Synthetic provider fixtures, malformed-record coverage, and serialized-state privacy sentinels added. |
| 2026-08-10 | TL-CX-04 | Complete | Claude discovery and parsing extracted behind the provider contract; shared orchestration and regression/privacy coverage retained. |
| 2026-08-10 | TL-CX-05 | Complete | Provider registry, qualified catalog merge, safe selection routing, and deterministic cross-provider priority added. |
| 2026-08-10 | TL-CX-06 | Complete | Codex catalog/history metadata reader, app-server seam, bounded rollout/index fallbacks, archive support, and privacy tests added. |
| 2026-08-10 | TL-CX-07 | Complete | Deterministic Codex primary/subagent metadata tree with safe runtime, timing, terminal, fork, resume, and missing-child handling. |
| 2026-08-10 | TL-CX-08 | Complete | Safe Codex tool/activity normalization, stable lifecycle evidence, repetition signatures, mutation scopes, deterministic recent activity, and privacy coverage added. |
| 2026-08-10 | TL-CX-09 | Complete | Safe Codex command lifecycle normalization, per-agent execution tasks, process IDs, historical stops, signal matching, and compatibility coverage added. |
| 2026-08-10 | TL-CX-10 | Complete | Latest non-zero Codex context snapshots, chronological growth timeline input, bounded explicit-trigger compactions, and metric/privacy coverage added. |
| 2026-08-11 | TL-CX-11 | Complete | Provider-neutral approval modes and latest structured plan tasks added with bounded fields, empty uninferred dependencies, neutral UI copy, and privacy coverage. |
| 2026-08-11 | TL-CX-12 | Complete | Documented Codex app-server rate-limit windows, shared request coordination/cooldown, bounded normalization, privacy filtering, failure isolation, and historical exclusion added. |
| 2026-08-11 | TL-CX-13 | Complete | Codex skill and signal evidence, provider-neutral PR creation events, monitor-side task matching, and evidence-gated shared efficiency rules added. |
| 2026-08-11 | TL-CX-14 | Complete | Owning app-server liveness, allowlisted lifecycle bridge, bounded rollout fallback, deterministic expiry/grace behavior, descendant waiting, and cached polling added. |
| 2026-08-11 | TL-CX-15 | Complete | Capability-gated provider copy and optional panels, provenance labels, unsupported-versus-zero report semantics, and mixed-provider responsive/accessibility coverage added. |
| 2026-08-11 | TL-CX-16 | Complete | API privacy audit, schema/failure compatibility QA, bounded Codex state parsing and caching, release documentation, and full-suite verification completed. |
