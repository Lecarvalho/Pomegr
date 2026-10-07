import assert from "node:assert/strict";
import test from "node:test";
import { createSessionObservationCoordinator } from "../../../server/runtime/session-observation-coordinator.mjs";

// The row a session event projects against, between a session commit and the catalog commit
// that the session commit schedules. The scheduler runs one job at a time, so a test can stand
// between the two commits.
const settle = () => new Promise((resolve) => setImmediate(resolve));
function stepScheduler() {
  const jobs = [];
  return {
    schedule(task) { jobs.push(task); return task; },
    cancel(task) { const index = jobs.indexOf(task); if (index >= 0) jobs.splice(index, 1); },
    async step() { await jobs.shift()(); await settle(); },
    async flush() { while (jobs.length) await this.step(); },
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Snapshots are deep-frozen and replaced, as the observation store's are.
function memoryStore() {
  const values = new Map();
  const accept = (candidate, revision) => {
    const snapshot = deepFreeze(structuredClone({ ...candidate, qualifiedId: `${candidate.providerId}:${candidate.localSessionId}`, revision, serializedState: JSON.stringify(candidate.publicState) }));
    values.set(snapshot.qualifiedId, snapshot);
    return snapshot;
  };
  return {
    getByQualifiedId(id) { return values.get(id) || null; },
    setPinned() {},
    restore(candidate) { return { accepted: true, snapshot: accept(candidate, candidate.revision || 1) }; },
    publish(candidate) {
      const previous = values.get(`${candidate.providerId}:${candidate.localSessionId}`);
      if (previous?.serializedState === JSON.stringify(candidate.publicState)) return { accepted: true, unchanged: true, snapshot: previous };
      return { accepted: true, snapshot: accept(candidate, (previous?.revision || 0) + 1) };
    },
  };
}

const evidence = (label, agent = {}) => ({ session: {}, agents: [{
  id: "primary", status: "active", liveness: { evidence: "observed", freshness: "current" },
  currentActivity: { label, observedAt: "2026-08-30T12:00:00.000Z" }, ...agent,
}] });
// A running test task of an adapter that reports no separate liveness object.
const runningTask = { liveness: undefined, currentActivity: null, executionTasks: [
  { id: "task-1", kind: "shell", workKind: "test", status: "running", startedAt: "2026-08-30T12:00:00.000Z", finishedAt: null, exitCode: null },
] };
const liveRow = (overrides = {}) => ({ localId: "one", title: "One", isLive: true, activityStatus: "working", ...overrides });
const lifecycleOnly = (row) => ({ ...row, currentActivity: null, activityFallback: null });

async function startCoordinator({ records = [] } = {}) {
  const scheduler = stepScheduler();
  let publisher;
  let refreshes = 0;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex", source: "Codex" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store: memoryStore(), schedule: scheduler.schedule, cancel: scheduler.cancel, commitDelayMs: 0,
    checkpointStore: records.length ? { async load() { return { records }; }, async write() {} } : null,
    // A rederivation without new evidence changes one derived field, as a resource refresh does.
    deriveSession: async ({ evidence: value, freshObservation }) => ({ readiness: { core: "ready" }, publicState: { ...value, refreshes: freshObservation ? 0 : (refreshes += 1) } }),
  });
  await coordinator.start();
  await settle();
  const committedRow = () => coordinator.catalog().snapshot.value.sessions[0];
  return { scheduler, coordinator, committedRow, publisher: () => publisher, walks: () => coordinator.diagnostics().catalogRowActivity };
}

test("between a session commit and its catalog commit, the row carries the activity that catalog commit derives", async () => {
  const { scheduler, coordinator, committedRow, publisher } = await startCoordinator();
  publisher().publishCatalog("codex", [liveRow()]);
  await scheduler.flush();
  const before = committedRow();
  assert.equal(before.currentActivity, null);
  assert.equal(coordinator.rowWithCommittedEvidence(before), before, "a row the catalog already built is returned as it is");

  publisher().publishSession("codex", "one", evidence("Step 1"));
  await scheduler.step();
  assert.equal(committedRow(), before, "the catalog commit that the session commit scheduled has not run");
  const ahead = coordinator.rowWithCommittedEvidence(before);
  assert.equal(ahead.currentActivity.label, "Step 1");
  assert.deepEqual(lifecycleOnly(ahead), lifecycleOnly(before), "only the two activity fields differ");

  await scheduler.flush();
  const after = committedRow();
  assert.deepEqual([after.currentActivity, after.activityFallback], [ahead.currentActivity, ahead.activityFallback], "the catalog commit derived the same activity");
  assert.equal(coordinator.rowWithCommittedEvidence(after), after, "once the catalog has the evidence, the row is returned as it is");
  await coordinator.stop();
});

test("each evidence publication walks its row once, and the catalog commit reuses that walk", async () => {
  const { scheduler, coordinator, committedRow, publisher, walks } = await startCoordinator();
  publisher().publishCatalog("codex", [liveRow()]);
  publisher().publishSession("codex", "one", evidence("Step 1"));
  await scheduler.flush();
  const row = committedRow();
  const before = walks();

  publisher().publishSession("codex", "one", evidence("Step 2"));
  await scheduler.step();
  // Two domain commits read the view in the gap: the session event's and one from another source.
  assert.equal(coordinator.rowWithCommittedEvidence(row).currentActivity.label, "Step 2");
  assert.equal(coordinator.rowWithCommittedEvidence(row).currentActivity.label, "Step 2");
  await scheduler.flush();
  assert.equal(committedRow().currentActivity.label, "Step 2");
  assert.deepEqual(walks(), { walks: before.walks + 1, reuses: before.reuses + 2, rows: 1 }, "one walk for the publication");
  await coordinator.stop();
});

// A lifecycle change that the provider published but the catalog has not committed yet. Deriving
// the new evidence under the committed lifecycle would show a state that the catalog commit
// withdraws a moment later (a running task of a session that is already idle).
for (const { change, pending } of [
  { change: "an activity status", pending: [liveRow({ activityStatus: "idle" })] },
  { change: "a live flag", pending: [liveRow({ isLive: false, activityStatus: "stopped" })] },
  { change: "a needs-input flag", pending: [liveRow({ needsInput: true })] },
  { change: "a row that is leaving the catalog", pending: [] },
]) {
  test(`the committed row is returned unchanged while ${change} waits for its catalog commit`, async () => {
    const { scheduler, coordinator, committedRow, publisher } = await startCoordinator();
    publisher().publishCatalog("codex", [liveRow()]);
    publisher().publishSession("codex", "one", evidence("Step 1"));
    await scheduler.flush();
    const before = committedRow();
    assert.equal(before.activityFallback, null);

    publisher().publishSession("codex", "one", evidence("Step 2", runningTask));
    publisher().publishCatalog("codex", pending);
    await scheduler.step();
    assert.equal(committedRow(), before, "the session committed before the catalog commit ran");
    assert.equal(coordinator.rowWithCommittedEvidence(before), before, "the catalog commit delivers the lifecycle and the activity together");

    await scheduler.flush();
    const after = committedRow();
    if (pending.length) {
      assert.deepEqual([after.isLive, after.needsInput, after.activityStatus], [pending[0].isLive, Boolean(pending[0].needsInput), pending[0].activityStatus]);
      assert.notEqual(after.activityFallback, null, "the catalog commit derived the new evidence's activity");
    } else assert.equal(after, undefined);
    await coordinator.stop();
  });
}

test("the row keeps every lifecycle field of the committed row, whatever the evidence says", async () => {
  const { scheduler, coordinator, committedRow, publisher } = await startCoordinator();
  publisher().publishCatalog("codex", [liveRow()]);
  publisher().publishSession("codex", "one", evidence("Step 1"));
  await scheduler.flush();
  const before = committedRow();

  // The evidence says the agent needs input; the provider's row does not say so yet.
  publisher().publishSession("codex", "one", evidence("Step 2", { ...runningTask, status: "needs_input" }));
  await scheduler.step();
  const ahead = coordinator.rowWithCommittedEvidence(before);
  assert.equal(ahead.activityFallback.state, "current");
  assert.deepEqual(lifecycleOnly(ahead), lifecycleOnly(before));
  assert.equal(ahead.needsInput, false);
  await coordinator.stop();
});

test("a restored session's row keeps its running work last observed", async () => {
  const restored = evidence("Restored", runningTask);
  const { scheduler, coordinator, committedRow, publisher } = await startCoordinator({ records: [{
    providerId: "codex", localSessionId: "one", revision: 3, evidence: { historical: false, ...restored },
    publicState: { seed: true }, readiness: { core: "ready" }, observedAt: "2026-08-30T12:00:00.000Z", source: null,
  }] });
  publisher().publishCatalog("codex", [liveRow()]);
  await scheduler.flush();
  const before = committedRow();
  assert.equal(before.activityFallback.state, "last_observed", "restored evidence is not current until the provider confirms it");

  // A rederivation without new provider evidence commits a changed state for the restored session.
  assert.equal(coordinator.refreshProjection("codex:one"), true);
  await scheduler.step();
  const ahead = coordinator.rowWithCommittedEvidence(before);
  assert.notEqual(ahead, before, "the session is between its commit and the catalog commit");
  assert.deepEqual(ahead.activityFallback, before.activityFallback);
  await scheduler.flush();
  assert.deepEqual(committedRow().activityFallback, ahead.activityFallback);
  await coordinator.stop();
});

test("an unchanged publication and a stopped coordinator leave no row marked", async () => {
  const { scheduler, coordinator, committedRow, publisher } = await startCoordinator();
  publisher().publishCatalog("codex", [liveRow()]);
  publisher().publishSession("codex", "one", evidence("Step 1"));
  await scheduler.flush();
  const row = committedRow();
  const revision = coordinator.catalog().snapshot.revision;

  publisher().publishSession("codex", "one", evidence("Step 1"));
  await scheduler.step();
  assert.equal(coordinator.rowWithCommittedEvidence(row), row);
  await scheduler.flush();
  assert.equal(coordinator.catalog().snapshot.revision, revision, "an unchanged publication schedules no catalog commit");

  publisher().publishSession("codex", "one", evidence("Step 2"));
  await scheduler.step();
  assert.notEqual(coordinator.rowWithCommittedEvidence(row), row);
  await coordinator.stop();
  assert.equal(coordinator.rowWithCommittedEvidence(row), row);
  assert.equal(coordinator.rowWithCommittedEvidence(null), null);
});
