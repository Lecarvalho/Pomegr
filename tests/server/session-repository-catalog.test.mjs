import assert from "node:assert/strict";
import test from "node:test";
import { createSessionObservationCoordinator } from "../../server/runtime/session-observation-coordinator.mjs";

function immediateScheduler() {
  const jobs = [];
  return {
    jobs,
    schedule(task) { jobs.push(task); return task; },
    cancel(task) { const index = jobs.indexOf(task); if (index >= 0) jobs.splice(index, 1); },
    async flush() { while (jobs.length) await jobs.shift()(); },
  };
}

function memoryStore() {
  const values = new Map();
  return {
    getByQualifiedId(id) { return values.get(id) || null; },
    evict(id) { values.delete(id); },
    setPinned() {},
    publish(candidate) {
      const previous = values.get(`${candidate.providerId}:${candidate.localSessionId}`);
      const snapshot = Object.freeze({ ...candidate, qualifiedId: `${candidate.providerId}:${candidate.localSessionId}`, revision: (previous?.revision || 0) + 1, serializedState: JSON.stringify(candidate.publicState) });
      values.set(snapshot.qualifiedId, snapshot);
      return { accepted: true, snapshot };
    },
  };
}

test("catalog follows committed repository attribution and clears an obsolete single-repository identity", async () => {
  const scheduler = immediateScheduler();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex", source: "Codex" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store: memoryStore(), schedule: scheduler.schedule, cancel: scheduler.cancel,
    deriveSession: async ({ evidence }) => ({ readiness: {}, publicState: evidence }),
  });
  await coordinator.start();
  publisher.publishCatalog("codex", [{ localId: "one", title: "One", project: "Clapline", isLive: true }]);
  publisher.publishSession("codex", "one", { session: { project: "Pomegr", repositoryId: "repo-proven", contextInventoryRef: null } });
  await scheduler.flush();
  assert.equal(coordinator.catalog().snapshot.value.sessions[0].project, "Pomegr");
  assert.equal(coordinator.catalog().snapshot.value.sessions[0].repositoryId, "repo-proven");
  publisher.publishSession("codex", "one", { session: { project: "Multiple repositories", repositoryId: null, contextInventoryRef: null } });
  await scheduler.flush();
  assert.equal(coordinator.catalog().snapshot.value.sessions[0].project, "Multiple repositories");
  assert.equal(coordinator.catalog().snapshot.value.sessions[0].repositoryId, null);
  await coordinator.stop();
});
