# Monitor performance: baseline, three fixes, comparison

Status: active plan, opened 2026-10-07. Delete this file and its `monitor-performance/`
attachments in the change that completes or cancels it, after moving enduring findings into
`docs/internal/architecture/observation-cache.md` and `docs/internal/architecture/metrics.md`.

## What the product owner needs

These are the outcomes the work is judged by. The baseline measures them directly, and the
same measurements are repeated after the fixes.

1. **Opening a running session** shows data at once.
2. **Live updates** of a running session arrive with very short or near-zero latency.
3. **Historical sessions** have their header (the row shown in the Sessions list) available.
4. **Opening a historical session** does not take long to load.

Memory and CPU use of the monitor matter because they degrade the four outcomes above, not
as goals of their own.

## What was observed on 2026-10-07

Machine: Windows 11, 16 logical processors. Provider homes at the time: 1,874 Claude
transcript files (515 top-level) and 3,989 Codex rollout files totalling 5.9 GB (median
549 KB, 90th percentile 3.2 MB, largest 121 MB). Nine to ten Claude sessions were open.

Each figure names how it was obtained. Treat the code-level explanations as leads to verify
against the source before relying on them.

### Memory

| Measurement | Value | Source |
| --- | --- | --- |
| Heap retained after a forced full GC, 183 s after start | 707 MB (RSS 927 MB) | Inspector, `HeapProfiler.collectGarbage` |
| Sampled allocations still live after that GC | 684 MB | Sampling heap profile from 2 s after start |
| of which allocated in `readRolloutRecords` (`server/providers/codex/live-state.mjs`) | 407 MB (59.5%) | same |
| of which allocated in `growEntry` (`server/providers/claude/tail-cache.mjs`) | 83 MB (12.1%) | same |
| RSS of the previous 12-hour process | 1.67 GB at 10 h, 2.43 GB at 12 h | `memory` counter in `outputs/pipeline-logs/` |

### CPU

| Measurement | Value | Source |
| --- | --- | --- |
| First 3.5 minutes after start | about 96% of one core | Process CPU time over uptime |
| Steady state, uptime 150 to 210 s | 49% of one core | 60 s CPU profile |
| Previous process, averaged over 12 hours | about 70% of one core | 507 CPU-minutes since start |
| `#publishDiskContribution` (history SQLite writes), inclusive | 10.6% of the 60 s profile | CPU profile |
| of which statement `prepare` | 26% | CPU profile |
| `commitCatalog`, inclusive | 5.9% | CPU profile |
| Process `spawn` | 7.3% (Git via `runGitAsync` 5.7%) | CPU profile |
| `realpath` | 4.3% | CPU profile |

### Stage timings from the pipeline logs

Median span duration per log file. "Healthy" is the previous process at about 10 hours of
uptime; "degraded" is the same process 90 minutes later; "fresh" is a new process in its
first four minutes.

| Stage | Healthy | Degraded | Fresh |
| --- | ---: | ---: | ---: |
| `catalog_projection` | 43 to 50 ms | 986 to 1,388 ms | 70 ms |
| `revision_notify` | 4.6 ms | 144 to 206 ms | 18 ms |
| `history_contribution` | 49 ms | 156 to 183 ms | 85 ms |
| `checkpoint` | 57 to 64 ms | 150 to 210 ms | 112 ms |
| `session_projection` | 0.5 ms | 1.7 to 3.2 ms | 1.7 ms |
| `candidate_to_commit` | 538 ms | 598 ms | 533 ms |
| `event_loop_ms` counter, median / max | 32 / 815 ms | 145 to 171 / 3,897 ms | not read |

The degraded period ran from about 08:05 to 09:25 local time and ended on its own. Its
trigger was not identified. In-memory stages stayed fast while every disk-touching stage
slowed, and five Python scripts pinned one core each from 07:58, so disk or CPU contention
is plausible but unproven.

`source_queue` showed a 95th percentile of 168 s in the degraded period. That stage name is
emitted from two places, the checkpoint persistence queue
(`server/runtime/session-observation-coordinator.mjs`) and the acquisition queue
(`server/providers/kernel/normalized-polling-observer.mjs`), so the figure does not by
itself show how stale the dashboard was. The baseline measures live latency directly.

`candidate_to_commit` sits just above 500 ms in every period. `commitDelayMs` defaults to
500 in the coordinator, so part of live latency is a fixed delay that none of the three
fixes changes. The baseline itemizes it; changing it is a separate decision for the product
owner.

## Baseline to capture before any fix

Record the numbers under "Baseline results" below, with the conditions they were taken in:
the commit and branch of the checkout the monitor ran from, the count of live sessions, the
catalog size, and whether unrelated heavy processes were running.

The measuring script is a plan attachment at
`docs/internal/plans/monitor-performance/measure.mjs`. It is passive: it only sends GET
requests to the loopback monitor and web proxy, reads `outputs/pipeline-logs/`, reads
process counters, and reads file sizes and modification times of provider transcript files.
It never reads transcript content into its output, never writes outside its own result
file, and never launches a provider session. The same script, unchanged, produces the
after-fix numbers.

| ID | Outcome | What to measure |
| --- | --- | --- |
| B1 | Startup | From monitor process start: time until the session list serves at least one ready row; time until catalog coverage reports complete; time until a chosen live session's summary domain serves `ready`. CPU seconds consumed and RSS at 60, 180, and 300 s. |
| B2 | Open a running session | Time from the first domain request for a live session not requested since start until a `ready` response. Then the response time of repeated requests, median and 95th percentile. |
| B3 | Live latency | For a session that is being written, time from a transcript file growing to the first served revision that reflects it. Median, 95th percentile, maximum, and sample count over at least three minutes. Report the fixed commit delay separately where it can be isolated. |
| B4 | Historical header | Row count served by the directory listing and the coverage state, and how long after start they became available. |
| B5 | Open a historical session | Time from the first domain request until `ready`, for three historical sessions not opened since start: small, medium, and large transcript. Record each transcript's size. |
| B6 | Background cost | After ten minutes of uptime, over five minutes: share of one core, RSS, `event_loop_ms` median and maximum, and the median of `catalog_projection`, `revision_notify`, `history_contribution`, and `candidate_to_commit` from the pipeline logs. |

### Baseline results

Not yet captured.

## The three fixes

Each fix is its own branch from this plan's branch and its own pull request. Each keeps the
contracts in `AGENTS.md` and `docs/internal/architecture/observation-cache.md`: GETs serve
committed caches only, the last known-good revision survives until a complete replacement
commits, no state is shown and then withdrawn, and nothing new crosses the browser
boundary. Each adds deterministic tests that count work or bytes; no test asserts a
wall-clock time.

### Fix 1: stop keeping raw Codex records

Where: `createCodexLiveState` in `server/providers/codex/live-state.mjs`. `rolloutCache`
maps a rollout file to `{ key, records, generation, complete }`, where `records` is every
parsed line. It evicts by entry count (`scanLimit`, 500 by default from
`server/providers/codex/session-metadata.mjs`), never by size. A historical or
complete-story read parses the whole file; a live read parses a tail of 512 KB, or 8 MiB
for an approval-reviewer thread. The caller is `readSession` in
`server/providers/codex/index.mjs`.

Change: bound what the cache retains by bytes, and stop retaining raw records for a file
once its normalized evidence is built and the file is settled. A file still being written
may keep its records under the byte bound, since an append re-reads it soon.

Must hold: a cache hit still requires the same identity, size, modification time, and
suffix check as today. Evicting an entry must not clear normalized context that
`liveContextUsageCache` and the other per-file caches hold as last known-good; today
`invalidateRolloutFile(file, { clearContext: true })` runs on eviction, so check what an
earlier eviction now removes. Read bounds control acquisition cost only and must not shorten
the life of normalized evidence.

Evidence it worked: retained heap three minutes after start, and the `readRolloutRecords`
share of it, against the 707 MB and 407 MB above.

### Fix 2: rebuild a session only when it changed

Where: the observation subscriber in `server/runtime/observation-runtime.mjs`. On every
`catalog` event it runs `sessionDomainServing.commit(retainedId)` for every id in
`sessionDomains.sessionIds()`, then `agentQueryProjection.refresh()`.
`sessionDomains.commit` in `server/sessions/domain/session-domain-store.mjs` calls
`projectSessionDomains` for the whole session and `JSON.stringify`s each domain to detect
that nothing changed. Live and open sessions are protected from eviction, so they are all
re-projected on every catalog commit. `commitCatalog` in
`server/runtime/session-observation-coordinator.mjs` also builds a row for each of up to
200 catalog entries through `catalogShellRow`
(`server/sessions/catalog/session-catalog-row.mjs`), and for each resident snapshot
`projectSessionActivityFallback` (`server/sessions/domain/session-current-activity.mjs`)
walks every tool call and execution task again. A catalog commit follows every session
commit with no added delay.

Change: on a catalog event, re-project a retained session only when the inputs that the
projection takes from its catalog entry changed. A session with new evidence is already
re-projected by its own `session` event. Memoize the per-row activity summary by snapshot
revision plus the entry fields it reads, so an unchanged session costs a lookup.

Must hold: every catalog-entry field that any domain projection reads is part of the
comparison, proven by a test per field; a lifecycle change that arrives only through the
catalog (for example an open session expiring, or a live row turning historical) still
re-projects that session in the same commit. Revisions, retention order, and eviction
behave exactly as today for an unchanged session, which is already a no-op that neither
advances a revision nor refreshes retention.

Evidence it worked: `catalog_projection` and `revision_notify` medians, `event_loop_ms`,
and B3 live latency.

### Fix 3: keep the history database open

Where: `server/sessions/history/session-history-block-store.mjs`. Every `transaction`
opens a new `DatabaseSync` for the session's file, runs the PRAGMA and
`CREATE TABLE IF NOT EXISTS` statements, calls `db.prepare` again for each row inside
`contribute`, `put`, and `get`, commits, and closes. Writable connections use
`journal_mode=DELETE` and `synchronous=FULL`.

Change: keep a small bounded pool of open connections with idle closing, and prepare each
statement once per connection.

Must hold: durability settings and commit semantics are unchanged, so a crash loses nothing
more than today. Every path that deletes, replaces, prunes, or recovers a history file
closes its pooled connection first, because Windows cannot delete an open file. The pool
closes on monitor shutdown and never grows past its bound. Read-only opens of a file that
has a pooled writable connection still see committed data.

Evidence it worked: `history_contribution` median and the `#publishDiskContribution` share
of a CPU profile, against 49 to 85 ms and 10.6% above.

## Comparison after the fixes

The monitor that the dashboard uses runs from the main checkout. Once the fixes are in the
checkout it runs from, restart it, repeat B1 to B6 with the unchanged script under
conditions as close to the baseline as practical, and add a results table beside the
baseline here. Report each outcome as before, after, and difference, and say plainly where
a fix made no measurable difference.

To attach a profiler to the running monitor: port 9229 is taken by the web dev server's
worker inspector. Start the dev app with `NODE_OPTIONS=--inspect-port=9330`, then run
`node -e "process._debugProcess(<monitor pid>)"` and connect to
`http://127.0.0.1:9330/json/list`. Relaunch through the `restart-pomegr` skill script
afterwards.
