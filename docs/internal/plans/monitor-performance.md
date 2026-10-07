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
fixes changes. The baseline itemizes it, and Fix 4 below removes it.

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

Captured on 2026-10-07 between 10:48 and 11:13 local time (UTC-4), one run of each
measurement. B2, B3, B5, and B6 ran with `measure.mjs` at commit `3a5a2b13`. B1 and B4 ran with
the same script before the fix in `a505a285`, which only affects how the chosen live session's
summary is timed (see [What the baseline could not measure](#what-the-baseline-could-not-measure)).
The full JSON of each run, including the raw B3 timeline, was kept outside the repository.

#### Conditions

- **Machine.** Windows 11, 16 logical processors, 31 GB of memory, Node 24.14.
- **Monitor under test.** A fresh `npm run dev` start through the `restart-pomegr` script at
  10:48:38, running the main checkout at `3c3e20ee` on `main` with a clean working tree at the
  start and at the end of the run. The checkout had been on another branch earlier that
  morning, so the previous monitor, used only for trial runs, ran different code.
- **Catalog.** 1,705 session headers: 515 top-level Claude transcripts (0.87 GB) with 615
  subagent transcripts, and 3,985 Codex rollouts (6.2 GB).
- **Live sessions.** One live Claude session during B2, B3, and B6. The subagent that ran
  these measurements was writing its transcript, which gave B3 a steady signal (107 writes in
  200 s). A second Claude session that was live before the restart was no longer live when B2
  ran. The dashboard may have been open: the log shows one `selected`-lane read about 50 s
  after start.
- **Unrelated load.** At 10:47 and 10:54 five `python.exe` processes each used 95 to 100% of
  one core, a WSL VM (`vmmemwsl`) used 35 to 42%, and Defender up to 17%. At 11:15 none of them
  was busy. The load was not sampled during B6 or B3, so whether the `python.exe` processes were
  running then is unknown. The web dev server was running. No build, test, or lint ran during B1,
  B6, or B3. The continuous pipeline log was on, as it is in every development run.

#### Results

Elapsed times for B1 and B4 are from monitor process creation. "Evidence" means the
normalized session evidence in the committed store. "p95" is the nearest-rank 95th percentile.

| ID | Measurement | Result | Unit |
| --- | --- | --- | --- |
| B1 | First HTTP response | 975 | ms |
| B1 | First session-list row with a ready summary (catalog readiness `ready`) | 6,855 | ms |
| B1 | Catalog coverage first `complete` (it returns to `discovering` at each 60 s header rescan) | 134,593 | ms |
| B1 | Live session A summary `ready` | not captured; see below | |
| B1 | Live session A evidence from a checkpoint restore (from the log) | 12,679 | ms |
| B1 | Live session A first fresh read ended / evidence committed (from the log) | 46,537 / 47,113 | ms |
| B1 | CPU seconds consumed at 60 / 180 / 300 s | 57.3 / 158.5 / 194.4 | s |
| B1 | RSS at 60 / 180 / 300 s | 924 / 1,092 / 1,218 | MB |
| B2 | Live session A first request to `ready` (answered `ready` at once) | 0.8 | ms |
| B2 | Repeated full-body request, monitor: median / p95 / max (n=100) | 0.6 / 58.6 / 246.6 | ms |
| B2 | Repeated full-body request, web proxy: median / p95 / max (n=100) | 7.4 / 10.1 / 154.7 | ms |
| B3 | Write to served revision, every write: median / p95 / max (n=107) | 687 / 867 / 1,012 | ms |
| B3 | Oldest write behind each revision: median / p95 / max (n=83) | 730 / 871 / 1,012 | ms |
| B4 | First directory page with a row | 2,360 | ms |
| B4 | Rows served from 5 s onward; coverage until 134.6 s | 1,705; `discovering` | rows |
| B6 | CPU, one quiet 300 s window from uptime 601 s (process counters; log counter) | 22.0; 22.0 | % of one core |
| B6 | RSS at start / middle / end of the window | 1,214 / 1,294 / 1,162 | MB |
| B6 | `event_loop_ms`: median / p95 / max (n=1,128 samples of 250 ms) | 32 / 181 / 811 | ms |
| B6 | `catalog_projection`: median / p95 (n=169, 33.8 per minute) | 53.7 / 78.6 | ms |
| B6 | `revision_notify`: median / p95 (n=227, 45.3 per minute) | 19.4 / 26.7 | ms |
| B6 | `history_contribution`: median / p95 (n=22, 4.4 per minute) | 57.7 / 380.5 | ms |
| B6 | `candidate_to_commit`: median / p95 (n=100, 20.0 per minute) | 526 / 593 | ms |

B5 times are from the first domain request to the summary domain's top-level `readiness:
ready`, for sessions that answered `loading` to that first request. Two samples per size
class: the nearest sessions to 100 KB, 1 MB, and 10 MB of transcript, then the next nearest.
"Core" is the first answer whose `core` section was ready.

| Provider | Class | First sample | Second sample |
| --- | --- | --- | --- |
| Codex | Small | 100.8 KB: not ready in 60 s; core 812 ms | 101.1 KB: ready 880 ms |
| Codex | Medium | 1,025.9 KB: not ready in 60 s; core 1,288 ms | 1,021.8 KB: not ready in 60 s; core 1,125 ms |
| Codex | Large | 10,343.7 KB: ready 112 ms (restore) | 10,021.1 KB: not ready in 60 s; core 1,580 ms |
| Claude | Small | 137.4 KB: ready 1,096 ms | 146.0 KB: ready 726 ms |
| Claude | Medium | 1,023.6 KB: ready 887 ms | 1,025.3 KB plus 840 KB in 1 subagent file: ready 929 ms |
| Claude | Large | 10,295.4 KB plus 839 KB in 3 subagent files: ready 1,247 ms | 9,727.5 KB: ready 110 ms (restore) |

An entry marked "restore" took about 110 ms in two polls, with no 500 ms commit wait. It is
inferred to be a checkpoint restore of a session that an earlier monitor run had already
opened; the monitor does not report which path it took. Those two entries are not cold opens.

#### How B3 paired writes with revisions

A write is one 50 ms stat poll that saw a watched transcript file grow, timed by the file's
modification time. A revision counter cannot identify the reflecting revision: it advances for
resource samples, history publications, and a catalog-driven second summary, and several
writes share one revision. In 200 s the summary was published 163 times for 107 writes.

Each write was therefore paired with the first published `session-summary` revision whose
served `session.updatedAt` is within 400 ms of the write. A transcript record carries its own
timestamp, which preceded the file write by a median 102.7 ms (95th percentile 105.3 ms) in the
baseline run, so the revision that holds a write can be recognized. Publication time is the
revision's event on the monitor's `/api/events` stream, and a conditional GET could read the new
body a median 0.7 ms later (95th percentile 3.1 ms, maximum 41.7 ms).

All 107 writes were paired and none were dropped. The "oldest write behind each revision" row
keeps only the longest wait in each burst of writes that one revision absorbed (83 bursts).
Writes that create a new subagent file are paired but excluded from both rows because the
script finds the file up to 250 ms late; there were none. All 107 writes in the baseline were to
subagent files. Writes to the main transcript appeared only in trial runs, where they paired
normally. Of the 107 pairs, 82 have a record lead of 95 to 110 ms; the other 25 are the earlier
of two writes 220 to 370 ms apart that one revision absorbed. A write that changed no
timestamped record would pair with a later revision and overstate its wait; none shows in the
baseline, where the longest wait is 1,012 ms.

Stage durations from the pipeline log during the same 200 s (all sessions together):

| Stage | Median | 95th percentile | Meaning |
| --- | ---: | ---: | --- |
| `source_queue`, Claude `source_update` lane | 0.1 ms | 198 ms | Watcher event to the start of the read |
| `acquisition_normalization`, same lane | 122.6 ms | 211.7 ms | The read and normalization |
| `candidate_to_commit` | 516.9 ms | 551.6 ms | Candidate published to store commit |
| `session_derivation` | 4.6 ms | 6.9 ms | Public-state projection |
| `catalog_projection` | 65.8 ms | 80.2 ms | Catalog commit that follows |

The first three medians add to about 640 ms of the 687 ms median wait (derivation happens inside
`candidate_to_commit`, and the catalog projection follows the evidence revision). The rest is
file-watch delivery and publication, which the log does not time.

For context only, the same script on the previous monitor, 56 minutes after its start with two
live sessions being written, gave n=68 with a median of 1,041 ms, a 95th percentile of 3,147 ms,
and a maximum of 5,738 ms over 90 s. Its median acquisition was 270 ms.

#### Configured fixed delays

These come from the code at the commit the monitor ran. Only the first is a floor on live
latency.

| Delay | Value | Owner |
| --- | --- | --- |
| Session publication coalescing | 500 ms from the first pending candidate; later candidates replace it without restarting the timer; a candidate replaced during derivation is dropped and costs another 500 ms; a failure retries after at least 1 s, up to five times | `commitDelayMs` in `server/runtime/session-observation-coordinator.mjs`, no override in `server/dev-cli.mjs` |
| Catalog commit after a session commit | 0 ms (`catalogStructuralDelayMs`); it costs a `catalog_projection` of about 66 ms and produces the second summary revision a median 83 ms after the evidence revision (n=38, 95th percentile 219 ms) | same file |
| File-watch handling | none: `fs.watch` events enqueue the read at once; at most two Claude source updates run at a time | `server/providers/kernel/normalized-polling-observer.mjs` |
| Catalog pass after a source event | at least 1,000 ms apart; affects catalog rows, not session evidence | `SOURCE_CATALOG_INTERVAL_MS` in the same file |
| Observer reconciliation poll | 10,000 ms, a safety net for missed watch events | `server/providers/claude/index.mjs`, `server/providers/codex/index.mjs` |
| Checkpoint and row-summary persistence | 5 s quiet, 60 s maximum; not on the serving path | `checkpointDelayMs` and `checkpointMaxDelayMs` in the coordinator |
| Browser: revision events | pushed over `/api/events`; the domain store refetches at once; the composed state poll settles for 100 ms | `app/session-domain-store.ts`, `app/components/dashboard/useTransitionalSessionState.ts` |
| Browser: fallback and retry | 30 s while connected, 5 s while reconnecting, 1 s while a live domain is loading, 5 s for a loading historical one | same files |
| Domain hydration request | one queued read per session per 30 s | `DOMAIN_HYDRATION_RETRY_MS` in `server/sessions/domain/session-domain-serving.mjs` |

#### What the baseline shows

- **Floor.** The 500 ms commit coalescing is about three quarters of the median write-to-served
  wait in a quiet monitor (`candidate_to_commit` median 517 ms of 687 ms). None of the three
  fixes changes it. Most of the rest is the read, which took 123 ms at the median here, and 270
  ms (1.7 s at the 95th percentile) on the loaded previous monitor.
- **Idle cost.** With one live session and no request, the monitor used 22% of a core.
  `catalog_projection`, `revision_notify`, and `history_contribution` together used about 5
  percentage points of that (33.8 × 53.7 ms, 45.3 × 19.4 ms, and 4.4 × 57.7 ms per minute).
  The log does not attribute the rest, so on this evidence Fixes 2 and 3 address about a fifth
  of the idle cost.
- **Startup.** The monitor used 95% of a core for the first 60 s, 84% over the next 120 s, and
  30% over the next 120 s. The live session's first fresh read took 39.5 s, during that load;
  its restored checkpoint was served from 12.7 s.
- **Historical Codex sessions.** In 4 of the 6 Codex samples the summary stayed `loading` for
  the whole 60 s because its `repository` section stayed `loading`, although the `core`
  section was ready within 0.8 to 1.6 s. A trial run on the previous monitor waited 3 minutes with
  no change, and four cold Codex sessions there all reported `view: live` while the catalog
  showed them not live. `server/providers/codex/observation.mjs` sets
  `historical: entry?.isLive === false` (lines 316 and 458), which is false for a session the
  observer's list does not contain, so such a session would be read as live and wait for a
  Git check. That cause is inferred from the code and not tested. It affects outcome 4 and none
  of the three fixes addresses it.
- **Memory.** The baseline monitor held 1.16 to 1.32 GB during the quiet B6 window, and 1.47
  GB at 11:15, after the two B5 passes had opened twelve historical sessions, six of them Codex
  rollouts of 0.1 to 10 MB. In the trial runs the previous monitor rose from 1.18 GB to
  1.80 GB within 7 minutes of opening seven Codex sessions of 22 KB to 28 MB. This is
  consistent with Fix 1 but was not profiled, and RSS can stay high after memory is no longer used.

#### What the baseline could not measure

- **B1, live session A summary `ready`.** The startup run stopped polling that domain after
  the previous monitor, which was still answering when the script started, had reported it
  `ready`. Commit `a505a285` fixes this and adds the log-based milestones above, which are
  commit times of the evidence, not served readiness: the summary also waits for its
  `repository` section. `measure.mjs startup-logs --created 2026-10-07T14:48:38.694Z`
  re-derives them. The restart could not be repeated.
- **B2 as defined.** A live session is committed by the monitor before anyone asks for it, so
  its first domain request answers `ready` at once. B2 reduces to the repeated-request
  latency; the cost of opening a live session after a restart is the B1 log milestones.
- **B3 coverage.** One live session, subagent writes only, a quiet machine for the monitor
  (the other live session had ended), and 200 s. The loaded previous monitor was worse.
- **B5 cold opens.** The monitor does not say whether an open used a checkpoint; two
  entries are probably restores. Cold Claude opens were 0.7 to 1.2 s, almost all of it the
  500 ms commit wait plus the read.

#### How to repeat

From the repository root, with no dependencies installed, run `node
docs/internal/plans/monitor-performance/measure.mjs startup --label after --out <file>`, then
restart the dev app once with the `restart-pomegr` script within 180 s. After the 300 s window
ends, run it with `steady --label after --b5-skip 2 --out <file>`, which waits for 10 minutes of
uptime before B6 and takes about 20 minutes, then with `steady --only b5 --b5-skip 3 --label
after-b5-second --out <file>` for the second B5 sample. The baseline opened the sessions at skip
0 and 1, and their checkpoints remain on disk, so reuse of those values would measure restores.
Keep a session being written for B3, avoid other heavy work while it runs, and record the
conditions listed above.

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

## Follow-on fixes decided after the baseline

The product owner approved both on 2026-10-07, after reading the baseline. Each is its own
branch and pull request and keeps the same contracts as the three fixes above.

### Fix 4: remove the fixed commit wait from live updates

Where: `scheduleSessionCommit` and `commitSession` in
`server/runtime/session-observation-coordinator.mjs`. The first pending candidate for a
session starts a `commitDelayMs` timer (500 ms); later candidates replace the pending evidence
without restarting it; a candidate replaced during derivation is dropped and waits another
full delay. The baseline's `candidate_to_commit` median was 517 ms of a 687 ms median
write-to-served wait.

Change: publish the first candidate of a quiet session promptly and keep a minimum spacing
between two publications of the same session, so a burst still coalesces and the publication
rate per session stays bounded. A candidate superseded during derivation publishes at the next
permitted time, not after another full delay. Build this on Fix 2, because every session
publication is followed by a catalog commit and its cost sets how often publishing is
affordable.

Must hold: the publication rate per session under a continuous burst is no higher than today.
A failed derivation still retains the previous committed revision and backs off as today.
Fresh evidence still preempts a delayed failure retry. Restored-checkpoint sessions and
startup recovery, where many sessions publish at once, must not turn into a commit storm:
count publications and catalog commits in a test for N sessions arriving together.

Evidence it worked: B3 median and 95th percentile, `candidate_to_commit`, and B6 idle cost,
which must not rise.

### Fix 5: historical Codex sessions that never finish loading

The baseline found 4 of 6 historical Codex sessions whose summary stayed `loading` for 60 s
because the `repository` section never became ready, while the `core` section was ready in
about a second. The cause is under investigation; this section is completed when it is
confirmed.

Evidence it worked: B5 for Codex, with fresh sessions (`--b5-skip`), reaches top-level `ready`.

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

### After-fix results

Captured on 2026-10-07 between 13:08 and 13:30 local time (UTC-4), one run of each
measurement, with `measure.mjs` unchanged at commit `a505a285` for the whole run. The monitor
was started fresh through the `restart-pomegr` script and ran the main checkout detached at
`cfb432c6` (`perf/integration`: `main` at `3c3e20ee` plus ten commits), clean at the start and
at the end. Its process creation time (13:08:41) is after the restart, and B5 ran after that
was confirmed. The full JSON of each run was kept outside the repository. "Change" is after
minus before; a negative change in a time, CPU, or memory is an improvement.

#### Conditions compared with the baseline

| Condition | Baseline | After |
| --- | --- | --- |
| Monitor code | `3c3e20ee` on `main` | `cfb432c6`, `main` plus ten commits |
| Process creation | 10:48:38 | 13:08:41 |
| Catalog | 1,705 headers; 515 Claude transcripts with 615 subagent files; 3,985 Codex rollouts | 1,707 headers; 517 Claude transcripts with 634 subagent files; 3,985 Codex rollouts |
| Live sessions | 2 before the restart; 1 live-at-start read; 1 live during B2, B3, B6 | 2 before the restart; 3 live-at-start reads; 1 live during B2, B3, B6 |
| Unrelated load at the start of the run | 5 `python.exe` at 95 to 100% of a core, `vmmemwsl` 35 to 42%, Defender up to 17% | 3 `python.exe` at 98 to 100%, `vmmemwsl` 30%, `lsass.exe` 14% |
| Unrelated load during B6 | not sampled | `vmmemwsl` 46%; the monitor under 10% |
| Unrelated load during B3 | not sampled | `lsass.exe` 19%, Defender 17%, `vmmemwsl` 12%; the monitor 23% |
| Unrelated load at the start of `steady` | 5 `python.exe` (10:54) | `vmmemwsl` 27%, a fan-control service 15% |

The three `python.exe` processes were gone by the start of `steady` (13:14) and during B6 and
B3, so the after run had less competing CPU load than the baseline had at its start; the
baseline's load during B6 and B3 is unknown. Both runs have one live session being written by
the measuring subagent during B2, B3, and B6, one run each, and different historical sessions
in B5.

#### B1 and B4: startup and historical header

| Measurement | Before | After | Change | Unit |
| --- | --- | --- | --- | --- |
| First HTTP response | 975 | 2,871 | +1,896 | ms |
| First session-list row with a ready summary | 6,855 | 9,720 | +2,865 | ms |
| Catalog coverage first `complete` | 134,593 | 82,601 | -51,992 | ms |
| Live session A summary `ready` | not captured | 3,383 | n/a | ms |
| First live-at-start session, checkpoint restore committed (log) | 12,679 | 3,911 | -8,768 | ms |
| Live-at-start sessions, first fresh read ended (log) | 46,537 (1 session) | 21,954 / 22,894 / 23,433 (3 sessions) | not comparable | ms |
| Live-at-start sessions, fresh evidence committed (log) | 47,113 (1 session) | 22,001 / 22,945 / 23,480 (3 sessions) | not comparable | ms |
| CPU seconds consumed at 60 / 180 / 300 s | 57.3 / 158.5 / 194.4 | 57.0 / 110.3 / 137.2 | -0.3 / -48.2 / -57.2 | s |
| RSS at 60 / 180 / 300 s | 924 / 1,092 / 1,218 | 789 / 729 / 729 | -135 / -363 / -489 | MB |
| B4: first directory page with a row | 2,360 | 2,871 | +511 | ms |
| B4: rows served at 5 s | 1,705 | 1,707 | +2 | rows |

The monitor's CPU use over the three windows was 95%, 84%, and 30% of a core before, and 95%,
44%, and 22% after. Coverage still alternates between `complete` and `discovering` at each 60 s
header rescan in both runs.

#### B2: repeated requests for a live session

| Measurement | Before | After | Change | Unit |
| --- | --- | --- | --- | --- |
| First request to `ready` | 0.8 | 0.9 | +0.1 | ms |
| Repeated request, monitor: median / p95 / max (n=100) | 0.6 / 58.6 / 246.6 | 0.6 / 32.1 / 147.8 | 0.0 / -26.5 / -98.8 | ms |
| Repeated request, web proxy: median / p95 / max (n=100) | 7.4 / 10.1 / 154.7 | 8.0 / 31.2 / 287.7 | +0.6 / +21.1 / +133.0 | ms |

#### B3: live latency

One live Claude session written by subagent tool calls, 200 s, in both runs.

| Measurement | Before | After | Change | Unit |
| --- | --- | --- | --- | --- |
| Write to served revision: median / p95 / max | 687 / 867 / 1,012 | 306 / 774 / 1,016 | -382 / -93 / +4 | ms |
| Writes paired | 107 | 97 | n/a | writes |
| Oldest write behind each revision: median / p95 / max | 730 / 871 / 1,012 | 286 / 774 / 1,016 | -444 / -97 / +4 | ms |
| Revisions behind those writes | 83 | 87 | n/a | revisions |
| Writes served within 300 / 500 / 700 ms | 5 / 26 / 52 | 49 / 72 / 92 | +44 / +46 / +40 | % |
| `session-summary` events published in the window | 163 | 87 | -76 | events |
| Second, catalog-driven revision after the evidence revision | median 83 ms (n=38) | none (n=0) | n/a | |
| Revision readable by a GET after its event: median / p95 / max | 0.7 / 3.1 / 41.7 | 0.4 / 25.5 / 88.1 | -0.3 / +22.4 / +46.4 | ms |

The shares within 300, 500, and 700 ms were computed from the stored raw timelines with the
script's pairing. Stage durations from the pipeline log in the same 200 s (all sessions
together), median with 95th percentile in parentheses:

| Stage | Before | After |
| --- | --- | --- |
| `source_queue`, Claude `source_update` lane | 0.1 (198) | 0.1 (1,240) |
| `acquisition_normalization`, same lane | 123 (212) | 161 (288) |
| `candidate_to_commit`, all outcomes | 517 (552) | 182 (553) |
| `candidate_to_commit`, accepted | 517 (565) | 89 (550) |
| `session_derivation` | 4.6 (6.9) | 16.8 (22.9) |
| `catalog_projection` | 65.8 (80.2) | 15.6 (21.9) |

#### B5: opening a historical session

Times are from the first domain request to the summary domain's top-level `ready`; "core" is
the first answer with the `core` section ready. The after run used `--b5-skip 2` and `3`, so the
sessions differ from the baseline's (`0` and `1`) but are the nearest to the same sizes. Each
after-run entry is marked cold when the pipeline log shows a read in the `selected` lane for it,
and restore when it shows none; the baseline's log had rotated away, so its two restore entries
are the inferred ones from the baseline results.

| Provider | Class | Baseline, first / second sample | After, first / second sample |
| --- | --- | --- | --- |
| Codex | Small | 100.8 KB: not ready in 60 s (core 812 ms) / 101.1 KB: 880 ms | 98.5 KB: 476 ms, cold / 98.4 KB: 288 ms, cold |
| Codex | Medium | 1,025.9 KB: not ready in 60 s (core 1,288 ms) / 1,021.8 KB: not ready in 60 s (core 1,125 ms) | 1,030.1 KB: 161 ms, restore / 1,016.8 KB: 697 ms, cold |
| Codex | Large | 10,343.7 KB: 112 ms, restore / 10,021.1 KB: not ready in 60 s (core 1,580 ms) | 10,560.1 KB: 112 ms, restore / 9,918.9 KB: 2,243 ms, cold |
| Claude | Small | 137.4 KB: 1,096 ms / 146.0 KB: 726 ms | 153.8 KB: 127 ms, cold / 175.3 KB: 126 ms, cold |
| Claude | Medium | 1,023.6 KB: 887 ms / 1,025.3 KB plus 840 KB in 1 subagent file: 929 ms | 1,021.1 KB: 226 ms, cold / 1,018.4 KB plus 345 KB in 1 subagent file: 218 ms, cold |
| Claude | Large | 10,295.4 KB plus 839 KB in 3 subagent files: 1,247 ms / 9,727.5 KB: 110 ms, restore | 9,667.0 KB: 779 ms, cold / 9,633.5 KB plus 163,944 KB in 39 subagent files: 9,840 ms, cold |

For Codex, top-level `ready` was reached in 6 of 6 after-run samples (2 of 6 in the baseline),
and the `repository` section was `ready` in all 6. No session stayed `loading`. The script does
not record the `view` value served, so it is not reported. In the four cold opens of the first
pass the open finished 75 to 175 ms after the log's read (reads of 50 to 704 ms); the Codex
cold reads took 173 to 2,019 ms.

#### B6: background cost

A quiet 300 s window from uptime 601 s, no requests sent, in both runs.

| Measurement | Before | After | Change | Unit |
| --- | --- | --- | --- | --- |
| CPU (process counters; log counter) | 22.0; 22.0 | 19.0; 19.0 | -3.0; -3.0 | % of one core |
| RSS at start / middle / end | 1,214 / 1,294 / 1,162 | 1,228 / 1,200 / 1,181 | +14 / -94 / +19 | MB |
| RSS from the log counter: median / max | 1,252 / 1,319 | 1,178 / 1,241 | -74 / -78 | MB |
| `event_loop_ms`: median / p95 / max | 32 / 181 / 811 | 33 / 234 / 1,351 | +1 / +53 / +540 | ms |
| `catalog_projection`: median / p95 (per minute) | 53.7 / 78.6 (33.8) | 16.2 / 25.1 (33.2) | -37.5 / -53.5 | ms |
| `revision_notify`: median / p95 (per minute) | 19.4 / 26.7 (45.3) | 1.1 / 13.8 (40.8) | -18.3 / -12.9 | ms |
| `history_contribution`: median / p95 (per minute) | 57.7 / 380.5 (4.4) | 101.9 / 207.7 (2.8) | +44.2 / -172.8 | ms |
| `candidate_to_commit`: median / p95 (per minute) | 526 / 593 (20.0) | 541 / 553 (13.4) | +15 / -40 | ms |
| `checkpoint`: median / p95 (per minute) | 8.1 / 44.5 (10.2) | 20.0 / 27.4 (6.2) | +11.9 / -17.1 | ms |
| RSS after B3 and both B5 passes (uptime 1,608 s before; 1,242 s after) | 1,475 | 1,210 | -265 | MB |

#### Outcome 1: opening a running session

B2 cannot show a change: a live session is committed before anyone asks, so its first request
answered `ready` in about 1 ms in both runs. The startup log shows the change that matters.
The first live-at-start session was served from its checkpoint at 3.9 s instead of 12.7 s, and
the chosen live session's summary was `ready` at 3.4 s (not captured in the baseline). Fresh
evidence for the live-at-start sessions was committed by 23.5 s for three sessions, against
47.1 s for one session whose single read took 39.5 s. These are not one-to-one: the after run
had three live-at-start sessions, less competing load, and the first response came 1.9 s later
(2.9 s against 1.0 s after process creation), and the first ready catalog row 2.9 s later, which
is slower and unexplained by this data.

#### Outcome 2: live latency

The median write-to-served wait fell from 687 to 306 ms, and the share served within 500 ms
rose from 26% to 72%. The pipeline log shows where: the median `candidate_to_commit` of accepted
commits fell from 517 to 89 ms, and the second catalog-driven revision after each write no longer
occurs (38 of them before, none after), so one write now publishes one summary revision. The
tail did not improve to the same degree: the 95th percentile fell from 867 to 774 ms and the
maximum stayed at about 1,016 ms. The `source_queue` 95th percentile rose from 198 to 1,240 ms,
and the median read took 38 ms longer, and the median derivation 12 ms longer; the log does not
show why. This is one session, 97 writes against 107, and one run each, and the readable-after-
publish tail was worse (95th percentile 3.1 to 25.5 ms), so the tail difference is within what
one run can show.

#### Outcome 3: historical headers

The directory served 1,707 rows from 5 s after start, against 1,705 before, and coverage first
reached `complete` at 82.6 s instead of 134.6 s. The first directory page with a row came 0.5 s
later (2.9 s against 2.4 s), because the process answered its first request later. Coverage
still returns to `discovering` at every 60 s header rescan.

#### Outcome 4: opening a historical session

Every after-run open reached top-level `ready`, including all six Codex samples; the baseline
reached it in 2 of 6 Codex samples and left four `loading` for the whole 60 s. Cold Claude opens
of the small and medium transcripts took 126 to 226 ms against 726 to 1,096 ms before. The log
shows reads of 50 to 139 ms for them, so the 500 ms commit wait is no longer part of an open.
Cold Codex opens took 288 to 2,243 ms. The comparison is loose: the sessions differ, two
baseline and two after entries are restores, and one after-run Claude "large" session carried
39 subagent files of 164 MB and took 9.8 s, where the baseline's carried 0.8 MB. The mechanism
that kept Codex sessions `loading` is not shown by these numbers, so I do not attribute the
Codex change to a fix.

#### Background cost and memory

Idle CPU fell from 22.0% to 19.0% of a core. The three stages the plan targets account for it:
by their per-minute counts and medians, `catalog_projection`, `revision_notify`, and
`history_contribution` used about 4.9 points before and 1.5 points after, a drop of 3.5 points
against the measured 3.0. The first two fell, to 16.2 ms and 1.1 ms at the median; the third
did not: `history_contribution` had a higher median (101.9 against 57.7 ms) from 14 samples
against 22, so this run shows no improvement from the history store change. `event_loop_ms`
was worse at the tail (95th percentile 234 against 181 ms, maximum 1,351 against 811 ms).
The B6 `candidate_to_commit` median stayed at 541 ms, while the same stage in the B3 window fell;
the log does not say which sessions those B6 commits belong to.

RSS was lower at startup (729 MB against 1,218 MB at 300 s) but rose to 1.2 GB between 8 and
10 minutes of uptime, so B6 started at the same level as in the baseline and ended 19 MB
higher (1,181 against 1,162 MB). After B3 and both B5 passes, RSS was 1,210 MB against 1,475
MB: it rose 29 MB from the end of B6 in the after run and 313 MB in the baseline, with six Codex
opens in each. The after run's pass included a 10 MB Codex rollout read cold and a Claude session
with 164 MB of subagent files, and was measured at a shorter uptime (1,242 s against 1,608 s).
The log does not show where memory is held, so I do not attribute the difference.

#### Where the runs are not comparable, and what else was seen

- Each measurement is one run per monitor. Small differences in B2 percentiles and B3 tails
  should not be read as changes: two trial runs on the previous monitor gave B2 95th percentiles
  of 98 and 107 ms against 59 ms in the baseline run.
- Load differed: 3 `python.exe` at the start of the after run, none later, against 5 in the
  baseline at its start; neither run's B3 and B6 load matches (the baseline's was not sampled).
- B1 had one live-at-start session before and three after. B5 used different sessions and one
  after-run session far larger in subagent files.
- The pipeline log recorded no failed span, gap, or rejected derivation in the after run. It
  recorded six `rejected` outcomes of the checkpoint persistence queue within 0.3 s, about 7 s
  after start (the queue's bounded admission). The baseline's startup log had rotated away, so
  there is no comparison for that.
- Not measured by the script: the `view` value for Codex sessions, and whether each B5 open was
  a restore (inferred from the log in the after run only).
