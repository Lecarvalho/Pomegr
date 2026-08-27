# ADR: Codex liveness and needs-input on Windows

- **Status:** Accepted for `POMEGR-CX-02`
- **Date:** 2026-08-10
- **Scope:** Design only; implementation belongs to `POMEGR-CX-14`

## Implementation status

Implemented by `POMEGR-CX-14` in `monitor/providers/codex-liveness.mjs`, `scripts/codex-lifecycle-bridge.mjs`, and `scripts/codex-lifecycle-owner.mjs`. The Codex adapter applies the source priority below to current views, retains the normalized evidence source and observation timestamp, and strips all current liveness evidence from historical reads.

## Context

Pomegr needs to classify Codex threads as active, idle, waiting for input, or no longer live without controlling Codex or exposing conversation content. On Windows, the classification must work for both CLI and desktop-owned threads.

The documented Codex app-server protocol exposes the best lifecycle evidence. A loaded thread has runtime status `idle`, `systemError`, or `active`; an active status may carry `waitingOnApproval` or `waitingOnUserInput`. `thread/status/changed` streams transitions, and `serverRequest/resolved` clears a user-input or approval request after it is answered or otherwise removed. `thread/read` and `thread/list` can also return `notLoaded`, which means only that the queried app-server process has not loaded the thread. It is not evidence that the owning Codex process exited. See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

That status is process-local. The documented transports require a connection to the owning app-server. There is no documented Windows discovery contract for attaching to the private stdio transport of an already-running desktop or CLI process. The installed CLI's managed app-server daemon command reports that daemon lifecycle is supported only on Unix.

Codex lifecycle hooks provide a cross-surface observation point. Relevant events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, and `SessionEnd`. Local function tools, including `request_user_input`, use the pre/post tool hook path. Hooks receive sensitive fields, so a Pomegr bridge must discard all non-allowlisted input before persistence. See the [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks).

## Decision

### Primary Windows strategy: opt-in lifecycle bridge

Use a small, opt-in Codex hook command that writes only Pomegr-owned, allowlisted lifecycle snapshots. This is the general Windows strategy because it runs in the Codex process that owns the thread and applies to CLI and desktop surfaces that support hooks.

The bridge is observational. It must emit no hook decision, add no model context, answer no request, and modify no Codex transcript or state. It writes snapshots atomically to a Pomegr-specific local directory. One lightweight owner watcher records a lease while the originating Codex process is alive; it identifies that process with a PID plus process-creation time so PID reuse cannot extend a lease.

Use these bridge transitions:

| Recognized hook evidence | Normalized state |
|---|---|
| `SessionStart` | live, idle |
| `UserPromptSubmit` | live, active; clear prior needs-input |
| `PermissionRequest` | live, needs input (`approval`) |
| `PreToolUse` for exactly `request_user_input` | live, needs input (`user_input`) |
| Matching `PostToolUse` | live, active; clear that pending request |
| Any later recognized progress event for the same turn | live, active; clear an older pending request |
| `Stop` | live, idle; clear needs-input |
| `SessionEnd` | live, idle; clear needs-input (a completed turn can remain interactive) |

Subagent start/stop events follow the same rule when a safe child-agent ID is present. Parent waiting-on-descendant behavior remains a shared Pomegr normalization concern, not a Codex-specific inference.

When Pomegr has an explicitly configured, authenticated connection to the app-server that owns a thread, the app-server runtime status supersedes the bridge for that thread. This is a higher-confidence source, but it is not the general Windows strategy because Pomegr cannot discover or attach to private desktop/CLI transports reliably.

### Fallback: bounded rollout-tail heuristic

When neither an owning app-server connection nor a current bridge lease exists, tail only a bounded suffix of the rollout. Do not scan private SQLite tables and do not resume or load a thread merely to observe it.

The fallback is deliberately conservative:

- a recognized record appended within 15 seconds is `active (heuristic)`;
- a recognized record 15 to 120 seconds old is `idle/recent (heuristic)`;
- after 120 seconds without recognized activity, the thread is not classified live;
- an unmatched structured `request_user_input` function call may set needs-input only while the same 120-second freshness bound holds;
- the matching structured function-call output clears needs-input immediately;
- rollout content does not provide a sufficiently stable approval-request lifecycle, so fallback-only approval waiting is unsupported.

File modification time is only a change detector. Parsed, validated record timestamps determine ordering. Truncated trailing JSON is retried on the next poll, and unknown record types are ignored. An explicit completed turn makes the thread idle, not finished, because the owning client may keep the thread open.

Every fallback-derived state must carry an evidence label such as `rollout activity heuristic` and its observation timestamp. The UI and reports must not describe it as operating-system certainty.

## Source priority and state mapping

Evidence is applied in this order:

1. status from an explicitly connected owning app-server;
2. a current lifecycle-bridge snapshot with a valid owner lease;
3. the bounded rollout-tail heuristic;
4. unknown/not live.

App-server mapping is exact:

| App-server status | Pomegr interpretation |
|---|---|
| `active` plus `waitingOnApproval` | live, needs input (`approval`) |
| `active` plus `waitingOnUserInput` | live, needs input (`user_input`) |
| `active` without a waiting flag | live, active |
| `idle` | live, idle |
| `systemError` | live, system error |
| `notLoaded` | unknown; never proof of exit or completion |

If both waiting flags appear, needs-input remains true and the safe kind is `multiple`; Pomegr does not guess which prompt has priority.

## Clearing stale state

Archival clears liveness immediately. Process exit clears it when the owner watcher stops renewing its lease. The monitor allows a 15-second heartbeat interval, a 45-second lease, and two consecutive failed polls before clearing, which bounds the ordinary crash false-positive window while tolerating scheduling jitter. After system resume, the monitor applies one fresh lease interval before declaring old snapshots stale. `SessionEnd` is intentionally idle rather than terminal because Codex can emit it after a completed turn while the conversation remains open for another user message.

The implementation keeps heartbeat leases separate from lifecycle snapshots so renewal cannot overwrite a newer transition. A first expired-lease poll and the resume grace can temporarily retain the last bridge state, but never beyond the documented lease/grace bounds while polling continues. Persisted `ended` snapshots from earlier Pomegr versions are interpreted as idle while their original owner lease remains current, then regain their terminal suppression behavior after that lease expires.

Needs-input clears on `serverRequest/resolved`, matching `PostToolUse`, a later recognized progress event for the same turn, `Stop`, `UserPromptSubmit`, `SessionEnd`, or owner-lease expiry. As a final guard against a lost clear event, a bridge needs-input record expires after 30 minutes without reaffirming evidence. This can produce a false negative for a prompt left unanswered longer than 30 minutes; the state must therefore retain its evidence label.

Rollout-only liveness and needs-input always expire after 120 seconds. Thus a crashed process cannot leave a transcript-derived live or needs-input state indefinitely. A later matching function-call output clears rollout needs-input as soon as it is observed.

Rollout parsing is limited to the final 128 KiB and 256 JSONL records per relevant file. Parsed tails are cached by size and modification time, bridge/catalog reads use a 1.5-second cache, and bridge directory scans are capped at 500 newest snapshot/lease files. These bounds mean a very large burst of more than 256 records can hide an unmatched request and produce a false negative; missing or disabled hooks can leave a finished client classified idle/recent for at most 120 seconds.

Historical views never receive current app-server, bridge, process, or lease evidence. They show only recorded terminal state and must not be promoted to live because the repository or another Codex process is active.

## Privacy allowlist

The bridge may persist only:

- schema version and constant provider ID;
- normalized session, turn, and optional agent IDs;
- one recognized lifecycle enum and optional safe request kind (`approval`, `user_input`, or `multiple`);
- local observation time, lease expiry, and monotonic sequence number;
- owner PID, owner process-creation time, and an opaque bridge-instance nonce, all monitor-side only.

The bridge must never persist, log, or return prompts, answers, questions, choices, commands, command arguments, working directories, transcript paths, tool input, tool output, stdout, stderr, patches, reasons, model responses, credentials, environment values, or unrecognized hook fields. It must parse hook stdin into the allowlist and discard the original object before writing. Browser state receives only normalized status, evidence label, and timestamps; process identifiers and bridge nonces stay monitor-side.

## Windows limitations and bounded uncertainty

- A separately spawned app-server cannot be assumed to know another process's in-memory threads. `notLoaded` is local to the queried server.
- The managed app-server daemon lifecycle is unavailable on the tested Windows CLI, so Unix control-socket assumptions are invalid.
- Desktop and CLI versions may differ, and app-server transports/status schemas may evolve. Validate recognized enums and fail closed on unknown values.
- Hook availability can be disabled by configuration or policy, and non-managed hooks require trust. In that case Pomegr degrades to the explicitly labeled rollout heuristic.
- Owner-process association and heartbeat timing are operational evidence, not proof that a particular OS window is visible or focused.
- Sleep, abrupt termination, hook failure, and long unanswered prompts create the bounded false-positive/false-negative windows documented above.

## Sanitized observations

Diagnostics recorded only process names/counts, lifecycle enums, timestamps, and record/key names:

- Installed CLI: `0.144.1`; hooks reported stable and enabled.
- `codex app-server daemon version` returned the Unix-only lifecycle limitation on Windows.
- With several Codex/desktop processes present, a newly spawned app-server returned zero loaded threads. Its broad persisted list returned six rows, all `notLoaded`; it did not expose another process's loaded runtime state.
- The installed generated schema defined `ThreadActiveFlag` as `waitingOnApproval | waitingOnUserInput` and exposed `serverRequest/resolved` with only thread and request IDs.
- Sanitized rollout inspection found nine structured `request_user_input` function calls, all paired with a later function-call output. Only record types, key names, counts, and timestamps were retained.
- The temporary generated schema directory was removed after inspection. No diagnostic artifact remains.

No prompt, answer, question, choice, command, stdout, stderr, credential, raw tool content, or private SQLite data was captured.

## Rejected alternatives

- **Attach to any discovered Codex process:** no documented Windows discovery/authentication contract exists for private stdio transports.
- **Treat a newly spawned app-server as global truth:** its loaded set and status are process-local.
- **Use process presence alone:** Windows can show that some Codex process exists, not which thread it owns or whether that thread awaits input.
- **Use rollout freshness without expiry:** crashes and abandoned requests would leave stale live/needs-input state.
- **Read private SQLite tables:** rejected as an undocumented compatibility dependency and outside the approved scope.
