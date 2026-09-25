import assert from "node:assert/strict";
import test from "node:test";
import { createSessionObservationCoordinator } from "../monitor/session-observation-coordinator.mjs";
import { SessionObservationStore } from "../monitor/session-observation-store.mjs";

function immediateScheduler() {
  const jobs = [];
  return {
    schedule(task) { jobs.push(task); return task; },
    cancel(task) { const index = jobs.indexOf(task); if (index >= 0) jobs.splice(index, 1); },
    async flush() { while (jobs.length) await jobs.shift()(); },
  };
}

test("empty startup catalogs stay loading until every provider has reported", async (t) => {
  for (const firstReadiness of ["ready", "unavailable"]) {
    for (const secondReadiness of ["ready", "unavailable"]) {
      await t.test(`${firstReadiness} then ${secondReadiness}`, async () => {
        const scheduler = immediateScheduler();
        let publisher;
        const coordinator = createSessionObservationCoordinator({
          registry: {
            providers: [{ id: "claude", source: "Claude Code" }, { id: "codex", source: "Codex" }],
            async startObservers(value) { publisher = value; return { async stop() {} }; },
          },
          store: new SessionObservationStore(), schedule: scheduler.schedule, cancel: scheduler.cancel,
          deriveSession: async () => ({ readiness: {}, publicState: {} }),
        });
        try {
          await coordinator.start();
          publisher.publishCatalog("claude", [], firstReadiness);
          await scheduler.flush();
          const pending = coordinator.catalog().snapshot;
          assert.equal(pending.value.readiness.catalog, "loading");
          assert.deepEqual(pending.value.sessions, []);
          assert.equal(coordinator.catalog(pending.revision).status, "unchanged");

          publisher.publishCatalog("codex", [], secondReadiness);
          await scheduler.flush();
          const settled = coordinator.catalog().snapshot;
          assert.equal(settled.value.readiness.catalog,
            firstReadiness === "unavailable" && secondReadiness === "unavailable" ? "unavailable" : "ready");
          assert.ok(settled.revision > pending.revision, "readiness alone publishes a new revision");
          assert.deepEqual(settled.value.sessions, []);
        } finally { await coordinator.stop(); }
      });
    }
  }
});

test("a delayed provider replaces the loading catalog with sessions without waiting for detail hydration", async () => {
  const scheduler = immediateScheduler();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "claude", source: "Claude Code" }, { id: "codex", source: "Codex" }],
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    },
    store: new SessionObservationStore(), schedule: scheduler.schedule, cancel: scheduler.cancel,
    deriveSession: async () => { throw new Error("Catalogs must not wait for detail hydration"); },
  });
  try {
    await coordinator.start();
    publisher.publishCatalog("claude", []);
    await scheduler.flush();
    assert.equal(coordinator.catalog().snapshot.value.readiness.catalog, "loading");
    publisher.publishCatalog("codex", [{ localId: "one", title: "One" }]);
    await scheduler.flush();
    const catalog = coordinator.catalog().snapshot.value;
    assert.equal(catalog.readiness.catalog, "ready");
    assert.equal(catalog.sessions[0].id, "codex:one");
    assert.equal(catalog.sessions[0].summaryReadiness, "loading");
  } finally { await coordinator.stop(); }
});

test("available catalog rows do not wait for another provider's first discovery", async () => {
  const scheduler = immediateScheduler();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "claude", source: "Claude Code" }, { id: "codex", source: "Codex" }],
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    },
    store: new SessionObservationStore(), schedule: scheduler.schedule, cancel: scheduler.cancel,
    deriveSession: async () => ({ readiness: {}, publicState: {} }),
  });
  try {
    await coordinator.start();
    publisher.publishCatalog("claude", [{ localId: "one", title: "One" }]);
    await scheduler.flush();
    assert.equal(coordinator.catalogReadiness().codex, "loading");
    const catalog = coordinator.catalog().snapshot.value;
    assert.equal(catalog.readiness.catalog, "ready");
    assert.equal(catalog.sessions[0].id, "claude:one");
  } finally { await coordinator.stop(); }
});
