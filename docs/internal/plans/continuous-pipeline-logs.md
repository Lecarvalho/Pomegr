# Continuous development pipeline logs

User wants simpler files instead of Perfetto, emphasizing continuity: watch live and
go back in time without capture/save. Development-only and anonymous/privacy boundaries
remain. Automatic JSONL append with bounded asynchronous queue, rotation, explicit loss
and observed coverage. Default proposed disk budget: 250 MiB (10 x 25 MiB files).
Questions pending: remove Perfetto entirely versus optional export; 250 MiB versus 1 GiB.
No user response to those choices yet. Do not let optional tooling block continuous logs.

Workspace: root dirty main preserves original implementation and unrelated desktop fix.
PR 23 checkout work/pr-progressive-pipeline-perfetto is clean at 4c6fbfa; transfer only
this follow-up after verification. Stash remains intact. Running app in independent
terminal 30460; prior P1 is fixed and live-verified. No log implementation restarted yet.

Owners:

- jsonl_writer (Luna/high): monitor/pipeline-log-writer.mjs and tests, synchronous factory
  with async initialization, bounded 1 MiB queue, 64 KiB max line, flush/close/stats,
  10 x 25 MiB owned files, no symlinks or arbitrary deletion, fixed sanitized failures.
- jsonl_analyzer (Terra/medium): scripts/diagnostics-logs.mjs and tests. Stream local files,
  validate through parent schema, bounded aggregation/time filtering, coverage/gaps,
  sanitized health failures, no native tools/network/monitor connection.
- Parent: schema and recorder event sink; automatic development writer integration;
  docs/skill/package routing; retirement according to user's preference; verification/PR.

Record schema agreed with analyzer: common version=1, run UUID, at ISO, kind.
span_start: stage/domain/startMs/lane with optional flow/revision/scope numeric opaque IDs.
span: same plus durationMs/outcome, optional surface/clockErrorMs.
flow: phase(start/step/end), flow/startMs/lane/outcome, optional scope.
counter: counter/value/startMs. health: normalized operations snapshot.
gap: droppedRecords/rejectedRecords/reason(backpressure/disk_error/instrumentation_limit).
lifecycle: event(started/stopped). Parent normalizer returns fixed safe shape or null.
No session identifiers, maps, source paths, transcripts, raw errors or content in logs.

Next: implement schema/sink, integrate writer before observation starts, preserve bounded
unfinished starts, auto health snapshots and loss reporting. Update operations contract,
AGENTS and forensics to file-first evidence. Add focused privacy/rotation/integration tests,
run required build/tests/verify:fast. Copy scoped changes to PR checkout and push; restart
only within authorization and confirm actual files continue growing. Delete plan at closure.

## Checkpoint: 2026-09-11, usage guard requested handoff

Implemented (not committed, not deployed):
- monitor/pipeline-log-schema.mjs validates anonymous fixed JSONL records.
- monitor/pipeline-log-stream.mjs converts instrumentation events, preserves immediate
  starts/completions and reports bounded loss.
- monitor/pipeline-log-writer.mjs appends batched records through persistent exclusive
  handles, rotates 10 x 25 MiB files, bounds queue/records and isolates disk failures.
- monitor/pipeline-trace.mjs supports event sinks without retaining the capture ring.
- monitor/dev-diagnostics.mjs automatically starts file logging before observation,
  records health each second, drains on shutdown; normal dev no longer starts capture IPC.
- scripts/diagnostics-logs.mjs validates and analyzes retained logs, follows appended
  bytes/rotation without rescanning old history. No native tools or network needed.
- New tests: pipeline-log-stream, pipeline-log-writer, diagnostics-logs. Integration,
  renderer and production/desktop exclusion tests updated.
- README and session-forensics skill point toward continuous logs; added reference
  pipeline-logs.md and removed perfetto-diagnostics.md. Runbook write initially denied
  by sandbox and still needs authorized host write, plus canonical contract updates.

Focused stream/integration/renderer/writer checks passed before final writer batching
refinement. Analyzer 5 passed. Latest writer 7 passed, 1 skipped (host file symlink
unavailable); lint passed. Full tests/build and bundle privacy checks NOT run for this
change. No PR transfer, commit, push or restart for JSONL implementation.

Immediate next steps: inspect writer retention failure handling and closure guarantees;
finish package commands and operations/observation/AGENTS contracts; rerun focused checks.
Then full npm test (host escalation, includes build), verify:fast and skill validation.
Transfer only this follow-up to PR 23 worktree, preserve root unrelated desktop commit
and existing stash. Rewrite PR description, commit/push, restart authorized local dev
app and verify automatic growing logs plus session readiness. Remove this plan only
when implementation and verification finish.

## Essential verification and review checkpoint

Focused six-file suite: 48 passed, 1 skipped, 0 failed (49 total). Evidence:
outputs/continuous-logs-focused.log. Covers new writer/stream/analyzer, legacy recorder,
development integration and renderer bridge. Writer now also closes its active handle
immediately on append failure and stops startup/rotation if retention cannot be enforced
(EACCES etc.; ENOENT remains harmless). Added retention-failure regression test.

Remaining review issues discovered (must resolve before claiming continuity complete):
- scripts/diagnostics-logs.mjs analyzePipelineLogs overwrites healthFailures with each
  health snapshot. Preserve bounded timestamped historical failure evidence as well as
  latest health; otherwise a recovered issue disappears from historical reports.
- Follow poll currently buffers all new records in an array and main setInterval can
  overlap async polls. Bound per-poll bytes/output and serialize polling; surface missed
  rotation/partial coverage. Streaming reader must discard an entire oversized line
  through its next newline, not clear its prefix and parse an embedded suffix.
- Follow/read error paths should emit fixed sanitized messages, not unhandled errors
  with local paths. Explicit --input invalid path currently can reject outside a catch.
- Health report quantile sampling flag exists in JSON; show it in Markdown too.
- Writer queue is at most 1 MiB plus a separately bounded in-flight batch of up to 1 MiB;
  documentation must describe this accurately. Retention assumes one development writer.

Package routing still TODO: diagnostics:logs -> node scripts/diagnostics-logs.mjs;
append the three new test files to test:diagnostics. Decide whether analyze is an alias.
Do not delete legacy helpers blindly: benchmark/test fixtures import capture validation.
No final Perfetto removal decision from user. Normal dev composition already omits IPC.

Canonical docs still stale: docs/PIPELINE_OPERATIONS.md (initial rewrite was denied),
AGENTS.md diagnostics paragraph, docs/OBSERVATION_CACHE.md around line 1808,
docs/ARCHITECTURE.md around lines 107/161, docs/AGENT-WORKFLOW.md ownership row.
Use authorized host PowerShell writes for protected markdown if apply_patch fails.

Pause requested by usage guard. No new workers launched. Root changes remain reviewable;
PR 23 and running app still contain the prior verified P1 fix, not these new JSONL edits.
Resume with the listed correctness fixes, canonical docs and command routing, then
required full verification before PR update/restart. Keep prior stash and unrelated
root desktop commit intact.

Focused ESLint: exit 0, no errors; one unused durationMs warning in monitor/pipeline-trace.mjs:216 remains. Progress estimate 50%, implementation incomplete.

## Checkpoint: 2026-09-11, quota-preserving Luna pass

Objective remains continuous anonymous development JSONL logs with bounded storage,
historical analysis and safe follow mode. One Luna builder and one Luna reviewer ran
serially to preserve the shared Codex allowance; no parallel work was started.

Changed in this pass:
- scripts/diagnostics-logs.mjs now retains bounded timestamped health-failure history
  alongside latest health, discards oversized lines through their newline, serializes and
  bounds follow polling, reports partial coverage/rotation, sanitizes CLI failures, and
  labels exact versus sampled quantiles in Markdown.
- tests/diagnostics-logs.test.mjs covers recovery history, oversized suffix rejection,
  follow bounds and serialization, rotation/coverage, sanitized failures and deferred
  records after a per-poll limit.

Review found and the builder fixed one data-loss bug where a limited poll advanced past
unread complete records. Latest direct verification: diagnostics-logs 11 passed; Node
syntax check passed. A reviewer-triggered broader wrapper reached the expected managed
sandbox build EPERM for generated plugin files; this is not a product failure and required
host build/test verification remains outstanding.

Remaining work: add diagnostics:logs package routing and the three new suites to
test:diagnostics; update PIPELINE_OPERATIONS, AGENTS, OBSERVATION_CACHE, ARCHITECTURE and
AGENT-WORKFLOW for continuous logs and accurate queue/in-flight bounds; review the final
two-file analyzer diff; run host npm test, verify:fast, skill validation and privacy/bundle
checks; transfer scoped changes to the clean PR 23 worktree at 4c6fbfa, commit/push, update
the PR description, restart only with existing authorization, verify logs keep growing and
session readiness, then close and delete this plan. Preserve the existing stash and
unrelated root desktop commit. Perfetto retirement and 250 MiB versus 1 GiB remain optional
product choices; continuous logs need not wait for them.

Commit-boundary verification in the PR 23 worktree: the focused six-file suite passed
54 with one Windows symlink skip; focused lint had zero errors and the existing unused
durationMs warning. Full npm test passed its build, 1,126 of 1,127 Node tests with one
opt-in skip, and all 722 UI tests. verify:fast passed lint and then stopped in the
unchanged landing typecheck because the installed miniflare package does not export
convertV4MiniflareOptions and a dependent callback is implicitly any. No scoped logging
file or test caused that failure. This checkpoint is the reviewed commit boundary; push,
remaining documentation/package routing, live acceptance and plan closure remain later.
