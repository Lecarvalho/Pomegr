# Codex liveness and needs-input on Windows

> Status: accepted on 2026-08-10 as a design for `POMEGR-CX-02`. Its primary strategy, an opt-in lifecycle-hook bridge, was superseded on 2026-09-02; the evidence principles, privacy boundary, and rejected alternatives remain in force.
> Decided: 2026-08-10. The bridge and its watcher were removed in commit `0df9f9a` on 2026-09-02.
> Scope and owner: classifying Codex threads as active, idle, waiting for input, or not live on Windows, for CLI and desktop-owned threads; Pomegr maintainers.
> Authority: rationale only. [AGENTS.md](../../../AGENTS.md) (Codex native writer presence) and the [observation cache](../architecture/observation-cache.md) own the current contract, [session status](../architecture/session-status.md) and [metrics](../architecture/metrics.md) own the status rules, and [`liveness.mjs`](../../../server/providers/codex/liveness.mjs) implements them.

## Decision and context

Pomegr must classify Codex threads without controlling Codex and without exposing conversation content. The constraints recorded when this was decided (Codex CLI 0.144.1, 2026-08-10) were:

- The documented app-server reports the best lifecycle evidence: a loaded thread is `idle`, `systemError`, or `active`, and an active thread may carry `waitingOnApproval` or `waitingOnUserInput`. That status is process-local. `notLoaded` means only that the queried server has not loaded the thread; it is not evidence that the owning process exited.
- No documented Windows contract discovers or authenticates to the private transport of an already-running desktop or CLI process, and the installed CLI reported its managed app-server daemon as Unix-only.
- Codex lifecycle hooks run in the owning process but receive sensitive fields, so anything that consumed them had to discard every non-allowlisted field before persistence.

The decision was a ranked set of sources, each labeled with its evidence: an explicitly connected owning app-server, then an opt-in hook bridge with an owner lease, then a bounded rollout-tail heuristic, then unknown.

### Principles that remain in force

- Accept liveness only from evidence whose ownership and provenance are known. Label any inference as an inference with its observation time; never describe it as operating-system certainty.
- An explicitly connected owning app-server outranks every other source. `notLoaded` is unknown, never proof of exit or completion. Validate recognized enums and treat unknown values as unavailable.
- Never attach to a discovered Codex process, treat a newly spawned app-server as global truth, or read Codex's private SQLite tables.
- Persist and expose only normalized enums and timestamps. Prompts, answers, questions, choices, commands, tool input and output, transcript paths, credentials, process identifiers, and unrecognized fields stay out of browser state, checkpoints, and logs.
- Historical views never receive current runtime, presence, or lease evidence, and a historical session never becomes live because the repository or another Codex process is active.
- Ownership and lock evidence is operational evidence. It does not show that a window is visible or focused, and it does not establish work, completion, idle, or success.

## Shipped semantics versus the earlier proposal

Checked against `server/providers/codex/` on 2026-09-30.

| Topic | Earlier proposal (2026-08-10) | Shipped |
| --- | --- | --- |
| General Windows source | Opt-in hook bridge writing allowlisted snapshots, with a PID-plus-process-start lease (15-second heartbeat, 45-second lease). | Removed. The monitor reads only provider-owned writer locks, read-only, and asserts presence only after byte-range contention, stable file identity, a unique Restart Manager owner, an allowlisted native executable, and a matching process-start identity. Hook snapshots and leases are never consumed. The plugin stays optional for policy, signals, and progress. |
| Owning app-server | Highest priority when explicitly connected; exact status mapping. | Same priority, and the mapping applies only to a connection with per-thread confirmation. Status expires after 120 seconds without a fresh observation (`observation_gap`). Production does not auto-attach, pair, or configure that transport. `systemError` maps to stopped rather than a separate system-error state. |
| Silence and crashed owners | Rollout-derived live and needs-input state always expired after 120 seconds; a bridge needs-input record expired after 30 minutes. | No timer ends recorded work. A validated turn start stays in progress, and an unmatched structured input request stays needs-input, until matching evidence resolves it. On Windows, when the thread's lock and its root's lock are both missing or uncontended, unresolved work is never live: it shows as Unknown with reason `writer_released`. Other platforms keep the recorded state. |
| Rollout-tail heuristic | Fallback when no owning app-server or bridge lease exists: a recorded activity within 15 seconds is active, 15 to 120 seconds is idle or recent, and older is not live. | The code and its 15-second and 120-second constants remain, but inference is admitted only with a confirmed native owner or when every deterministic channel is explicitly declared unsupported, which the default configuration does not do. A result is labeled inferred. Tail reads stay bounded at 128 KiB and 256 records, widened to 4 MiB and 2,048 records for a confirmed owner. |
| Bridge transitions | `SessionStart`, prompt, permission, tool, `Stop`, and `SessionEnd` hooks drove live, active, and needs-input states. | Removed with the bridge. Recorded turn boundaries and structured input requests supply lifecycle. The `lifecycle_bridge` source value survives only so older checkpoints restore; it is downgraded and never renews presence. |
| Historical isolation | Historical reads strip all current liveness. | Unchanged. |

Where the table and the linked contracts differ, the contracts govern. The [opt-in native lock acceptance test](../../../tests/server/providers/codex/native-lock-acceptance.test.mjs) exercises the native presence path against an isolated temporary provider home. The manual two-session smoke test that the original Codex plan never ran targeted the removed bridge.

## Alternatives and consequences

Rejected in 2026-08 and still rejected:

- **Attach to any discovered Codex process.** No documented Windows discovery or authentication contract exists for private stdio transports.
- **Treat a spawned app-server as global truth.** At design time a newly spawned app-server reported zero loaded threads and six `notLoaded` persisted rows while several Codex processes ran, so its loaded set and status are process-local.
- **Use process presence alone.** A process name or PID shows that some Codex process exists, not which thread it owns. The shipped check is stricter than the original objection: it needs file identity, a unique owner, the exact executable, and process-start identity together.
- **Read private SQLite tables.** An undocumented compatibility dependency outside the approved scope.

Rejected, then solved differently: rollout freshness without an expiry. The original answer was a 120-second timer. The shipped answer is structural: recorded work stays unresolved through silence, and Windows lock release is the only evidence that removes it from Live.

Consequences that still hold:

- A separately spawned app-server cannot be assumed to know another process's threads, and the Windows native-lock probe is not inherited by macOS or Linux, where only a connected owning runtime and recorded lifecycle are available.
- A Codex surface that writes rollouts without taking a writer lock would be read as released. Every surface observed so far takes the lock.
- A crash without a terminal record can leave unresolved work on platforms without lock evidence; Pomegr does not guess an end from silence.
- The retained rollout heuristic has a bounded uncertainty window. A finished client can read idle or recent for up to 120 seconds after its last recorded activity, and a burst of more than 256 records can push an unmatched input request out of the tail. That is why its result is labeled inferred and gated.
- Codex versions and transport schemas change. Re-verify the lock and app-server assumptions against the acceptance test when a new CLI or desktop version changes them.
