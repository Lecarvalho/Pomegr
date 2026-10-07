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

function memoryStore() {
  const values = new Map();
  return {
    getByQualifiedId(id) { return values.get(id) || null; },
    setPinned() {},
    publish(candidate) {
      const id = `${candidate.providerId}:${candidate.localSessionId}`;
      const previous = values.get(id);
      const serializedState = JSON.stringify(candidate.publicState);
      if (previous?.serializedState === serializedState) return { accepted: true, unchanged: true, snapshot: previous };
      const snapshot = Object.freeze({ ...candidate, qualifiedId: id, revision: (previous?.revision || 0) + 1, serializedState });
      values.set(id, snapshot);
      return { accepted: true, snapshot };
    },
  };
}

const evidence = (label) => ({ session: {}, agents: [{
  id: "primary", status: "active", liveness: { evidence: "observed", freshness: "current" },
  currentActivity: { label, observedAt: "2026-08-30T12:00:00.000Z" },
}] });
const liveRow = (overrides = {}) => ({ localId: "one", title: "One", isLive: true, activityStatus: "working", ...overrides });

async function startCoordinator() {
  const scheduler = stepScheduler();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex", source: "Codex" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store: memoryStore(), schedule: scheduler.schedule, cancel: scheduler.cancel, commitDelayMs: 0,
    deriveSession: async ({ evidence: value }) => ({ readiness: { core: "ready" }, publicState: value }),
  });
  await coordinator.start();
  const committedRow = () => coordinator.catalog().snapshot.value.sessions[0];
  return { scheduler, coordinator, committedRow, publisher: () => publisher };
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
  assert.deepEqual({ ...ahead, currentActivity: null, activityFallback: null }, { ...before, currentActivity: null, activityFallback: null }, "only the two activity fields differ");

  await scheduler.flush();
  const after = committedRow();
  assert.deepEqual([after.currentActivity, after.activityFallback], [ahead.currentActivity, ahead.activityFallback], "the catalog commit derived the same activity");
  assert.equal(coordinator.rowWithCommittedEvidence(after), after, "once the catalog has the evidence, the row is returned as it is");
  await coordinator.stop();
});

test("the row keeps the committed lifecycle while a lifecycle change waits for its catalog commit", async () => {
  const { scheduler, coordinator, committedRow, publisher } = await startCoordinator();
  publisher().publishCatalog("codex", [liveRow()]);
  publisher().publishSession("codex", "one", evidence("Step 1"));
  await scheduler.flush();
  const before = committedRow();
  assert.equal(before.currentActivity.label, "Step 1");

  publisher().publishSession("codex", "one", evidence("Step 2"));
  publisher().publishCatalog("codex", [liveRow({ activityStatus: "idle" })]);
  await scheduler.step();
  const ahead = coordinator.rowWithCommittedEvidence(before);
  assert.equal(ahead.activityStatus, "working", "the lifecycle is still the committed one");
  assert.equal(ahead.currentActivity.label, "Step 2");

  await scheduler.flush();
  assert.equal(committedRow().activityStatus, "idle");
  assert.equal(committedRow().currentActivity, null, "the lifecycle change arrives with its catalog commit");
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
