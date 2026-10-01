# Durable session store

> Status: proposed; discussed with the product owner on 2026-09-30, no design approved and no code written.
> Created: 2026-09-30.
> Scope: keep normalized session evidence in the monitor SQLite store so a monitor restart does not re-read transcripts for sessions that did not change, so small per-session files have one owner, and so history survives long enough to chart. Excludes any server database: the owner ruled out Elasticsearch on 2026-09-30. DuckDB is considered only at the decision gate in task 6.
> Continuation owner: the agent that picks up this plan in a fresh session; the product owner approves the shape chosen in task 1.
> Authority: working proposal. `AGENTS.md` and [Observation cache](../architecture/observation-cache.md) stay authoritative; tasks 2 to 5 change them.
> Next task or decision: task 0, measure what a restart costs today.
> Completion criteria: a restart with more catalogued sessions than today's checkpoint bound reads only appended transcript bytes, the measured restart numbers from task 0 are beaten and recorded, every per-session store named below has one documented owner, and `npm run build` and `npm test` pass.
> Permanent destinations: [Observation cache](../architecture/observation-cache.md) (store ownership, bounds, migrations, retention, serving), `AGENTS.md` (the checkpoint persistence invariant), and the public [settings](../../public/using-pomegr/settings.md) page if storage controls change.
> Lifetime: temporary; delete on completion, cancellation, or supersession after applying the closure steps in the [style guide](../../STYLE_GUIDE.md#maintain-or-retire-the-artifact).

## The problem

The parsed form of a session is treated as a small throwaway cache. When the monitor restarts with more sessions than the cache holds, the rest are read from their transcripts again. The owner's objection, on 2026-09-30: rebuilding the cache at every restart is not efficient, and building user dashboards on top of that would be reinventing the wheel.

The same pattern caused a real loss on 2026-09-30. A finished session's recorded Git snapshot was deleted when its checkpoint was evicted, and it could not be rebuilt. That one case is fixed (sidecars now outlive checkpoint eviction), but the cause is general: data that cannot be rebuilt lives beside a cache that is expected to be thrown away.

## What exists today

Verified against the code on 2026-09-30.

| Store | Owner | Holds | Bound |
| --- | --- | --- | --- |
| `observation-cache-v1/checkpoint-*.json` | `SessionObservationCheckpointStore` (`server/sessions/checkpoints/session-observation-checkpoints.mjs`) | One file of normalized evidence per session | 100 files and 16 MiB by default, oldest modification time evicted |
| `observation-cache-v1/repository-*.json` | Same store; `createRepositorySnapshotRecorder` (`server/repository/repository-snapshot.mjs`) | The recorded Git snapshot of a session | 2,000 files, at most 64 KiB each |
| `session-history-v1/` | `SessionHistoryStore` (`server/sessions/history/session-history-store.mjs`) | Paged activity and request history | Its own session bound |
| `monitor-store-v1/monitor.sqlite` | `server/persistence/monitor-store.mjs` and `monitor-store-runtime.mjs` | File-change index and resource history | Age and size retention from the storage settings |
| `cost-snapshots/` | `server/normalize/session-cost.mjs` | One small JSON file per session | None found |
| `repository-inventory-v1.json` | `server/repository/repository-inventory-runtime.mjs` | Repository context inventories | One file |

Observed on the owner's machine on 2026-09-30:

- One checkpoint was 2.2 MB, and 100 checkpoints took about 15 MB, so the 16 MiB bound is nearly as tight as the 100-file bound.
- After a restart with more than 200 catalogued sessions, the checkpoint folder went from 223 files to 102, and every remaining file had been rewritten within about seven minutes.

Not yet measured: how much of that restart work was transcript reading and how much was writing unchanged evidence back.

Two properties of the SQLite store matter for this plan:

- A schema version mismatch or a failed integrity check deletes the database and rebuilds it from checkpoints. That is safe only for tables that can be rebuilt. Resource history already cannot be, and neither can recorded Git snapshots or the allowance records in the [session allowance plan](session-allowance.md).
- The store uses the synchronous `node:sqlite` API. A large write blocks the monitor's event loop.

## Principles

- One documented owner for each kind of data. Rebuildable data is marked as a cache; data that cannot be rebuilt is never deleted to free cache space.
- Nothing new is stored. Rows hold only the contract-valid normalized evidence that checkpoints hold today. Every privacy invariant in `AGENTS.md` applies unchanged.
- GETs serve committed values. No GET reads, parses, or migrates.
- A schema change migrates in place. Delete-and-rebuild stays only for tables declared rebuildable.
- Each step is measured against task 0 before the next begins.

## Work and verification

### Task 0 — Measure a restart

- [ ] With the owner's real session catalog, record for one restart: how many sessions were read from transcripts, how many transcript bytes were parsed, how many checkpoints were written, and the time until every catalogued session answers `ready`. Use the continuous pipeline log described in [Pipeline operations](../operations/pipeline-diagnostics.md); add a stage only if none measures a figure.
- [ ] Record whether a restored checkpoint is reused when its source did not change, using the stored source fingerprint and complete-record offset, or re-read.
- [ ] Write the numbers under the continuation checkpoint. They are the baseline.

Acceptance: the checkpoint holds the four figures and the answer about reuse.

### Task 1 — Choose the shape

Two shapes, for the owner to choose between with the task 0 numbers in hand:

| Shape | What changes | Cost |
| --- | --- | --- |
| A. One row per session | The checkpoint payload moves into a SQLite table as one validated JSON value per session. The 100-file bound goes; age and size retention replace it. | Smallest step. Removes the eviction churn. Not queryable for charts. |
| B. Normalized tables | Sessions, agents, requests, and tasks become tables. | Queryable history for charts. A larger change, and every schema field needs a migration path. |

- [ ] Recommend A first, then B only for the measures a chart needs, and record the owner's decision.
- [ ] Estimate the database size for one year of the owner's usage under the chosen shape, and compare it with the storage threshold choices (250 MB to 2 GB).

Acceptance: the decision and the size estimate are in the continuation checkpoint.

### Task 2 — Migrations for data that cannot be rebuilt

- [ ] Give the monitor store versioned in-place migrations. Declare each table rebuildable or not. A version mismatch migrates; only a failed integrity check may still rebuild, and it must say what was lost.
- [ ] Update [Observation cache](../architecture/observation-cache.md) with the table classification.
- [ ] Tests in `tests/server/persistence/monitor-store.test.mjs`: a version step keeps resource history; a declared-rebuildable table is refilled; a corrupt file reports the loss.

Acceptance:

```powershell
node --test tests/server/persistence/monitor-store.test.mjs
```

### Task 3 — Move session evidence

- [ ] Implement the shape chosen in task 1 behind the checkpoint store's existing interface, so the coordinator and restore code keep their contract (validation, legacy upgrade, revision preservation, fresh-evidence precedence).
- [ ] Write in bounded batches so one large session does not block the event loop; measure the longest synchronous write.
- [ ] Import existing checkpoint files once, then stop writing them.
- [ ] Update the checkpoint persistence invariant in `AGENTS.md` to name the new home.

Acceptance: the checkpoint and restore suites pass against the new store, and the task 0 measurement is repeated and recorded.

### Task 4 — Move the small per-session files

- [ ] Recorded Git snapshots, cost snapshots, and the allowance records move into tables, each with its current validation and bounds. Import existing files once.
- [ ] Each table follows the retention rule its data needs; state it in [Observation cache](../architecture/observation-cache.md).

Acceptance: the repository snapshot, session cost, and allowance suites pass, and no code path writes the old files.

### Task 5 — Read only what is new after a restart

- [ ] On restart, a session whose stored source fingerprint still matches is not re-read; a session whose transcript grew is read from its stored complete-record offset.
- [ ] Verify cache-only GET behavior, last-known-good retention, and revision handling, as the `AGENTS.md` change checklist requires.

Acceptance: the task 0 measurement, repeated, shows transcript bytes parsed in proportion to what changed, not to the catalog size.

### Task 6 — History for charts, and the DuckDB gate

- [ ] List the measures the chart library needs (see the [product expansion plan](product-expansion.md)) and add the tables or views that serve them.
- [ ] Time those queries on a year of data. Consider DuckDB only if a needed query stays slow in SQLite after indexing; record the numbers and the decision. It would add a second store and a native dependency, so the default is no.

Acceptance: the timings and the decision are recorded.

## Continuation checkpoint

2026-09-30: proposed after the owner's review of restart behavior and the sidecar loss. Decided so far: no Elasticsearch; SQLite is the direction. Next action: task 0.
