# Global session statuses

Reviewed: 2026-09-01.

This is the editable comparison of Pomegr's session-level status rules. Keep each table row on one physical line so later corrections can target that row. Describe what Pomegr can observe through its connected sources; parser support alone is not evidence of an available integration.

Scope: the Sessions list `activityStatus`, not individual agent/task status, agent-reported progress, or provider service health. This reference describes current implementation and known gaps; [OBSERVATION_CACHE.md](OBSERVATION_CACHE.md) remains the operational contract.

Implementation note: the Claude non-live -> Idle rule below is implemented in the working tree. This review did not restart the monitor, so an already-running process can still use the previous Unknown fallback.

## Global scope requirement

Global status must describe the entire observed session, including its subagents and recorded background work. The primary agent being idle, stopped, or finished is not sufficient to describe the session that way while a subagent is known to be working. Missing child evidence must remain an observation limitation, not proof of child inactivity. This is the intended product requirement; the table records remaining implementation gaps.

## Global status table

Conditions use the latest accepted evidence, including retained observations. "Observed" does not guarantee that a newer, inaccessible provider event has not occurred. A live session can be Idle.

The Sessions directory's Live/All split is a separate shared catalog projection. An
owner-retained Claude or Codex session can keep `activityStatus` **Open** while its `isLive`
visibility expires five minutes after the catalog row's last recorded `updatedAt`.
Only Open is subject to this age boundary: Working/In progress and Needs input,
including recognized child or background aggregation, remain Live. Missing, invalid,
or future `updatedAt` excludes Open from Live. The boundary does not change the
underlying runtime-presence observation or imply that execution ended; ownership
probes, restarts, and viewing do not renew catalog activity. A single shared
coordinator timer drives the projection, while cache-only GETs and provider evidence
lifecycles remain unchanged.

Claude first maps non-live sessions to Idle. For live Claude sessions, priority is Needs input, In progress, Open, Idle, then Unknown. Codex checks Needs input, In progress, the inactive-root rules (Idle or Stopped), Open, then Unknown. Related Codex agents include discovered descendants and forks belonging to the session.

| Global status | Provider | Exact classification condition | Evidence Pomegr uses | Discrepancies and detection gaps |
| --- | --- | --- | --- | --- |
| **Needs input** (`needs_input`) | **Both** | **Claude:** live session and primary registry/native `needsInput` is true. **Codex:** at least one live agent has an observed/accepted `needs_input` lifecycle. | **Claude:** registry `waiting` with a wait category containing input, approval, permission, or question; Remote Control `requires_action`. **Codex:** recognized structured `request_user_input` or waiting flags from an explicitly connected owning runtime. | **Codex mobile permission waits are not reliably detected by the current integration.** Its default monitor has no owning-runtime approval feed. Claude child input waits and transcript-only `AskUserQuestion` do not set global Needs input; recognized Codex child waits do. **Mixed-state gap (Both):** Needs input takes precedence even while another agent works. For Claude this can make the primary input wait determine the global label despite confirmed background work. This is attention precedence, not proof that the whole session is blocked. |
| **In progress** (`working`) | **Both** | **Claude:** live session, no primary input wait, and primary status is `active`/`waiting` or recorded background work is confirmed open. **Codex:** no live agent has Needs input and at least one live agent has accepted `active` lifecycle. | **Claude:** primary registry/native state plus exact recorded background workflow, shell, and agent launches/closures. **Codex:** recorded structured execution starts or an explicitly connected runtime's active state. | **Aggregation gap (Claude):** the catalog does not aggregate child agent statuses; it counts only recognized background launches in the primary transcript. Missing launch/owner evidence or independently continuing nested work can therefore be missed (see aggregation gaps below). Recognized background Agent/workflow launches are already covered while open. **Codex:** recognized linked live children are aggregated, but running shell tasks are not independently consulted. An unobserved mobile approval can also leave an open Codex turn labeled In progress. |
| **Idle** (`idle`) | **Both** | **Claude:** session is non-live; otherwise primary status is `idle`, no validated owner, no primary input wait, and background work is not confirmed open. **Codex:** primary status is `idle` or `finished`, and every related live agent is `idle`, `finished`, or `stopped`. | **Claude:** native/registry idle, or the non-live fallback. **Codex:** recorded structured successful turn completion or direct native idle from an explicitly connected owning runtime. | **Aggregation gap (Claude):** primary Idle plus unavailable/unrecognized background evidence can yield global Idle without checking working children. The non-live fallback also returns Idle before background evaluation and requires no completion evidence. **Codex:** a recognized active live child prevents Idle; an unknown live child also blocks it. Undiscovered, unlinked, or classified-non-live children are outside that check. Neither label proves overall task success. |
| **Stopped** (`stopped`) | **Codex** | Primary is `stopped` and every related live agent is inactive (`idle`, `finished`, or `stopped`). A recognized live input wait or active agent takes precedence. | Structured failed/interrupted/aborted turn end, or accepted stopped lifecycle such as an owning runtime's `systemError`. | Claude never emits global Stopped, although individual agents and tasks can be stopped. **Codex does not let a stopped primary override a recognized active live child.** Once all related live agents are inactive, the primary alone chooses Stopped versus Idle; a stopped child with an idle primary does not make the session Stopped. Codex also combines interruption and failure under this label. |
| **Open** (`open`) | **Both** | **Claude:** live session whose primary status is `idle` and whose validated registry/native owner remains present. **Codex:** no Needs input, In progress, Idle, or Stopped rule applies, and at least one live agent has confirmed runtime/owner presence. | **Claude:** validated owner-backed registry/native presence with idle primary state. **Codex:** explicit owning-runtime observation or validated native Windows runtime ownership. | Presence is known while execution state is unresolved; Open does not imply work is executing. |
| **Unknown** (`unknown`) | **Both** | **Claude:** live session, no primary input wait, primary status is not `active`, `waiting`, or `idle`, and no recorded background work is confirmed open. **Codex:** no preceding status rule applies, including insufficient confirmed presence for Open. | Missing, unsupported, incomplete, ambiguous, invalidated, or otherwise unusable lifecycle evidence, after applying source precedence and retention. | **Aggregation gap (Claude):** primary uncertainty can leave the session Unknown despite working children when their work is outside the background-launch tracker. With the non-live fallback, such a row instead becomes Idle. **Codex:** a recognized active live child yields In progress even with an unknown primary, unless a recognized input wait takes precedence. Missing/unlinked child evidence can still prevent that result. Retained observations or alternate sources can continue determining status after another source becomes unavailable. |

The implementation owners are [Claude status](../monitor/providers/claude-session-status.mjs), [Codex aggregation](../monitor/providers/codex-session-lifecycle.mjs), and [UI labels](../app/dashboard-utils.ts). Documentation sometimes calls `working` "Working"; the actual UI label is "In progress".

## Whole-session aggregation gaps

- **Claude child coverage is partial, not absent.** A recognized open background Agent or workflow already keeps the session In progress while the primary is idle, including nested work while that outer launch remains open. The remaining gap is that the catalog does not consume the normalized child `agents[]` lifecycle at all.
- **Claude can fall back to the primary despite child activity.** Background recognition requires a validated owner and owner-start timestamp, plus a successful structured launch matched in the primary transcript. A foreground/unrecognized launch, missing ownership evidence, or work recorded only in a child transcript cannot independently override primary Idle/Unknown through this tracker. These are code-path limitations, not claims that every such session has a working child.
- **Claude nested work is represented by the tracked outer task.** Once that task receives its exact terminal notification, the catalog does not separately inspect descendants for continuing work. Whether a particular child survives that boundary requires session evidence; the aggregate currently has no independent descendant check.
- **Claude non-live classification bypasses background work.** The primary/subagent file-age grace can keep the session live briefly after registration disappears, but once it expires, the current fallback returns Idle without checking unresolved child execution. Silence alone is not evidence that all children completed.
- **Codex aggregates the children it knows about.** A linked child marked live and active prevents global Idle/Stopped/Unknown/Open regardless of the primary state. Discovery, linkage, and liveness gaps remain: a missing/unlinked child or one classified non-live is not included as active. This is an evidence-coverage limitation, not a primary-overrides-active-child branch in the reducer.
- **Both providers can show Needs input while work continues.** Claude considers the primary wait; Codex considers any observed live-agent wait. Both prioritize that attention label over working agents. We still need to decide how a single global display represents simultaneous work and required input.
- **Codex terminal labels remain primary-led after work stops.** With an idle primary and stopped child, the session is Idle; with a stopped primary and idle children, it is Stopped. This does not hide recognized active children, but the label is not an aggregate outcome for all agents.

Evidence owners: [Claude catalog](../monitor/providers/claude.mjs), [Claude background reader](../monitor/providers/claude-background-lifecycle.mjs), [Claude status precedence](../monitor/providers/claude-session-status.mjs), [Codex child discovery/liveness](../monitor/providers/codex-liveness.mjs), [Codex aggregation](../monitor/providers/codex-session-lifecycle.mjs).

## What establishes live status

| Provider | Condition | Limitation |
| --- | --- | --- |
| Claude | An explicit source-file override is live. Otherwise, when the registry directory exists, a retained registration or primary/subagent file activity within 15 seconds establishes live status. Without that directory, file activity within five minutes establishes live status. | Registry entries are removed on a positive process-owner mismatch. Missing owner fields or process-inspection failure can leave registration usable without proving ownership. Recency is a compatibility heuristic, not proof that a process is executing. |
| Codex | At least one root/related agent is live under its selected lifecycle evidence: owning-runtime presence, validated native Windows runtime ownership, or unresolved structured execution/input evidence. | Recorded starts can remain active through silence. A recorded completed turn alone is non-live; validated runtime ownership can keep an idle agent live. Native lock semantics are not inferred on Unix without validation. |

Sources: [Claude discovery](../monitor/session-discovery.mjs), [registry ownership](../monitor/session-registry.mjs), [Codex observation](../monitor/providers/codex-liveness.mjs).

## Available evidence versus implemented support

| Evidence source | Provider | Current availability and handling |
| --- | --- | --- |
| Local session registry | Claude | Read by the default adapter. Recognized primary states are used globally; active/busy/running normalize to active. A registry `waiting` state without a recognized user-attention reason counts as In progress. |
| Remote Control native lifecycle | Claude | Read for eligible locally registered `sdk-cli` sessions with validated ownership, matching bridge identity, and credentials. `running`, `requires_action`, and `idle` map to active, input wait, and idle. A temporary failure retains the previous valid state for the same association; ownership/bridge/credential changes invalidate reuse. |
| Structured transcript lifecycle | Codex | Used by the default adapter when acquired evidence is complete and comparable. Starts, successful ends, failed/interrupted ends, and recognized unresolved user-input calls provide lifecycle evidence. A silent open turn is not automatically converted to Idle. |
| Native Windows runtime ownership | Codex | The selected native CLI writer is accepted only after stable identity, unique file user, exact executable, and matching process-start checks. Unix does not infer presence from an unvalidated native lock. |
| Owning-runtime status and approval flags | Codex | The adapter can consume an explicitly supplied owning connection. Its separate app-server reader is account-rate-limits-only and cannot supply session status or approval waits. Runtime observations are discarded on read failure or after more than 120 seconds without confirmation. |
| Legacy activity/approval/plan inference | Codex | General inference requires every deterministic channel (owning runtime, native writer presence, structured rollout) to be explicitly declared unsupported. The default configuration does not enable that gate. The heuristic code's existence does not establish production coverage for mobile approvals, CLI pending edits, or plan-confirmation waits. Recognized structured `request_user_input` has a separate accepted-evidence path. |

Sources: [default integrations](../monitor/providers/index.mjs), [Claude lifecycle reader](../monitor/providers/claude-session-status.mjs), [Codex owning runtime](../monitor/providers/codex-owning-runtime.mjs), [Codex inference gate](../monitor/providers/codex-source-routing.mjs).

## Completion and permission evidence

Both providers expose comparable native categories for working, user attention, and idle. Different names do not by themselves justify different product behavior. The availability, scope, and meaning of the recorded event matter.

| Evidence or situation | Provider | Current interpretation and limit |
| --- | --- | --- |
| Explicit runtime `idle` | Both | Comparable inactive execution evidence. Session aggregation can still report In progress when tracked related/background work remains active. Codex direct-runtime access is not connected by default. |
| Assistant `stop_reason: end_turn` | Claude | Model-response completion. It does not directly set primary/global Idle. Pomegr does use the latest relevant child assistant stop reason to mark that child finished. Hooks or background activity can continue execution after a response ends. |
| Structured `turn_completed` or equivalent successful end | Codex | Runtime-turn completion, normalized to inactive lifecycle for that agent. It does not prove overall task success, permanent session completion, or inactivity of related agents. |
| Mobile permission prompt | Codex | The user reports that Pomegr misses these waits. The default integration has no owning-runtime approval feed. Official documentation describes server-to-client approval requests; this supports a runtime-channel explanation, but no specific mobile event was inspected to prove that its local transcript contains no approval evidence. |

Codex's documented approval protocol uses server-initiated requests such as `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`, followed by a client decision and resolution. See [official approval protocol](https://learn.chatgpt.com/docs/app-server#approvals). A request existing in that protocol does not mean Pomegr receives it.

Sources: [Claude agent interpretation](../monitor/providers/claude.mjs), [Claude background lifecycle contract](CLAUDE_SESSION_STATUS.md), [Codex turn boundaries](../monitor/providers/codex-turn-lifecycle.mjs).

## Labels outside this table

- **Live / History**: discovery/view classification, separate from activity status.
- **Historical snapshot / Monitor offline / Connecting to monitor**: session-header view or connection states.
- **Complete**: can appear in agent-reported progress or individual task/workflow status; it is not a global session lifecycle status.
- **Provider service health**: an independent domain described in [PROVIDER_STATUS.md](PROVIDER_STATUS.md).

## Decisions still open

- Whether Idle should require observed inactive execution or also cover "no live session detected" consistently across providers.
- Whether child input waits should always affect global Needs input.
- How to make all observed subagent and background work, including shell tasks, participate consistently in the global status, as required above.
- Whether both providers should expose Open and Stopped under equivalent evidence conditions, and whether Stopped represents the primary outcome or the whole session.
- How to show simultaneous input waits and ongoing work without implying that every agent is blocked.
- How to communicate known observation gaps, especially Codex mobile approval waits, without presenting recorded activity as confirmed current execution.

These are discussion points, not additional implemented changes. Future corrections should update the relevant row and supporting evidence here rather than reproduce the whole table in conversation.
