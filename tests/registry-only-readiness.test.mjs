import assert from "node:assert/strict";
import test from "node:test";
import { createSessionObservationCoordinator } from "../monitor/session-observation-coordinator.mjs";

function immediateScheduler() {
  const jobs = [];
  return {
    schedule(task) { jobs.push(task); return task; },
    cancel(task) { const index = jobs.indexOf(task); if (index >= 0) jobs.splice(index, 1); },
    async flush() { while (jobs.length) await jobs.shift()(); },
  };
}

function memoryStore() {
  const values = new Map();
  return {
    getByQualifiedId(id) { return values.get(id) || null; },
    setPinned() {},
    publish(candidate) {
      const snapshot = Object.freeze({ ...candidate, qualifiedId: `${candidate.providerId}:${candidate.localSessionId}`, revision: 1 });
      values.set(snapshot.qualifiedId, snapshot);
      return { accepted: true, snapshot };
    },
  };
}

test("catalog-only unavailable detail is settled without hydration and never reaches public rows", async () => {
  const scheduler = immediateScheduler();
  const store = memoryStore();
  let publisher;
  let hydrations = 0;
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "claude", source: "Claude Code" }],
      async startObservers(value) {
        publisher = value;
        return { async hydrate() { hydrations += 1; return false; }, async stop() {} };
      },
    },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    async deriveSession() {
      return {
        readiness: { core: "ready" },
        publicState: { session: { progress: null }, metrics: { agents: 1, activeAgents: 1, tokens: { allAgents: 1200 } }, agents: [] },
      };
    },
  });
  await coordinator.start();
  const entry = {
    localId: "registry-only", title: "Claude session", project: "Unknown project",
    updatedAt: "2026-09-02T12:00:00.000Z", isLive: true, needsInput: false,
    activityStatus: "open", detailReadiness: "unavailable",
  };
  publisher.publishCatalog("claude", [entry]);
  await scheduler.flush();
  const unavailable = coordinator.catalog().snapshot.value.sessions[0];
  assert.equal(unavailable.summaryReadiness, "unavailable");
  assert.equal(unavailable.agentCount, null);
  assert.equal(unavailable.activeAgentCount, null);
  assert.equal(unavailable.latestContextTotal, null);
  assert.equal(Object.hasOwn(unavailable, "detailReadiness"), false);
  assert.equal(coordinator.session("claude:registry-only").status, "unavailable");
  assert.equal(hydrations, 0);
  const unavailableRevision = coordinator.catalog().snapshot.revision;

  publisher.publishCatalog("claude", [{ ...entry, detailReadiness: undefined }]);
  await scheduler.flush();
  assert.equal(coordinator.catalog().snapshot.value.sessions.length, 1);
  assert.ok(coordinator.catalog().snapshot.revision > unavailableRevision);
  assert.equal(coordinator.catalog().snapshot.value.sessions[0].summaryReadiness, "loading");
  assert.equal(coordinator.session("claude:registry-only").status, "loading");
  assert.equal(hydrations, 1);

  publisher.publishSession("claude", "registry-only", { historical: false, session: {} });
  await scheduler.flush();
  publisher.publishCatalog("claude", [entry]);
  await scheduler.flush();
  const retained = coordinator.catalog().snapshot.value.sessions[0];
  assert.equal(retained.summaryReadiness, "ready", "last-known-good evidence wins over catalog-only absence");
  assert.equal(retained.agentCount, 1);
  assert.equal(retained.latestContextTotal, 1200);
  assert.equal(Object.hasOwn(retained, "detailReadiness"), false);
  await coordinator.stop();
});
