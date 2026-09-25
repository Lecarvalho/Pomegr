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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function checkpoint(localSessionId) {
  const evidence = { historical: true, session: { title: "Saved", updatedAt: "2026-09-24T12:00:00.000Z" }, agents: [] };
  return { providerId: "codex", localSessionId, evidence, publicState: evidence,
    readiness: { core: "ready" }, observedAt: "2026-09-24T12:00:00.000Z", revision: 99 };
}

test("live state publishes before checkpoint I/O and late restore cannot replace fresh evidence", { timeout: 5_000 }, async (t) => {
  const disk = deferred();
  const restored = deferred();
  const scheduler = immediateScheduler();
  const store = new SessionObservationStore();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex" }], async startObservers(value) {
      publisher = value;
      return { async stop() {} };
    } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    checkpointStore: { load: () => disk.promise, async write() {} },
    onRestoreComplete: restored.resolve,
    deriveSession: async ({ evidence }) => ({ readiness: { core: "ready" }, publicState: evidence }),
  });
  t.after(() => coordinator.stop());
  await coordinator.start();
  publisher.publishCatalog("codex", [{ localId: "live", isLive: true, activityStatus: "working" }]);
  const fresh = { ...checkpoint("live").evidence, historical: false, session: { title: "Fresh" } };
  publisher.publishSession("codex", "live", fresh);
  await scheduler.flush();
  const first = coordinator.session("codex:live").snapshot;
  assert.equal(first.publicState.session.title, "Fresh", "usable live state precedes checkpoint completion");
  disk.resolve({ records: [checkpoint("live"), checkpoint("history")] });
  await restored.promise;
  await scheduler.flush();
  const current = coordinator.session("codex:live").snapshot;
  assert.equal(current.publicState.session.title, "Fresh");
  assert.equal(current.revision, first.revision, "late L2 revision 99 must not replace fresh revision");
  assert.equal(store.getByQualifiedId("codex:history").publicState.session.title, "Saved");
});

test("checkpoint restore cannot supersede an in-flight fresh derivation", { timeout: 5_000 }, async (t) => {
  const disk = deferred();
  const deriving = deferred();
  const derived = deferred();
  const restored = deferred();
  const scheduler = immediateScheduler();
  const store = new SessionObservationStore();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex" }], async startObservers(value) {
      publisher = value; return { async stop() {} };
    } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    checkpointStore: { load: () => disk.promise, async write() {} },
    onRestoreComplete: restored.resolve,
    deriveSession: async ({ evidence }) => {
      deriving.resolve();
      await derived.promise;
      return { readiness: { core: "ready" }, publicState: evidence };
    },
  });
  t.after(() => coordinator.stop());
  await coordinator.start();
  publisher.publishSession("codex", "live", { historical: false, session: { title: "Fresh" } });
  await scheduler.flush();
  await deriving.promise;
  disk.resolve({ records: [checkpoint("live")] });
  await restored.promise;
  assert.equal(store.getByQualifiedId("codex:live"), null, "L2 cannot claim a pending fresh candidate");
  derived.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await scheduler.flush();
  assert.equal(store.getByQualifiedId("codex:live").publicState.session.title, "Fresh");
});

test("sidecar readiness delays only restoration and shutdown discards the delayed load", { timeout: 5_000 }, async () => {
  const sidecars = deferred();
  let loads = 0;
  let started = 0;
  let completed = 0;
  const store = new SessionObservationStore();
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex" }], async startObservers() {
      started += 1; return { async stop() {} };
    } },
    store, checkpointRestoreReady: () => sidecars.promise,
    checkpointStore: { async load() { loads += 1; return { records: [checkpoint("saved")] }; }, async write() {} },
    onRestoreComplete: () => { completed += 1; },
    deriveSession: async ({ evidence }) => ({ readiness: {}, publicState: evidence }),
  });
  await coordinator.start();
  assert.equal(started, 1);
  assert.equal(loads, 0);
  await coordinator.stop();
  sidecars.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 0, "shutdown prevents a deferred checkpoint scan from starting");
  assert.equal(completed, 0);
  assert.equal(store.getByQualifiedId("codex:saved"), null);
});

test("checkpoint failure is isolated from provider startup", { timeout: 5_000 }, async (t) => {
  const disk = deferred();
  let publisher;
  const scheduler = immediateScheduler();
  const store = new SessionObservationStore();
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex" }], async startObservers(value) {
      publisher = value; return { async stop() {} };
    } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    checkpointStore: { load: () => disk.promise, async write() {} },
    deriveSession: async ({ evidence }) => ({ readiness: {}, publicState: evidence }),
  });
  t.after(() => coordinator.stop());
  await coordinator.start();
  disk.reject(new Error("optional disk recovery failed"));
  await new Promise((resolve) => setImmediate(resolve));
  publisher.publishSession("codex", "live", { historical: false, session: { title: "Fresh" } });
  await scheduler.flush();
  assert.equal(coordinator.session("codex:live").snapshot.publicState.session.title, "Fresh");
});

test("a checkpoint from a stopped startup cannot restore into a new generation", { timeout: 5_000 }, async (t) => {
  const oldDisk = deferred();
  const newDisk = deferred();
  const restored = deferred();
  let loads = 0;
  let completions = 0;
  const scheduler = immediateScheduler();
  const store = new SessionObservationStore();
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex" }], async startObservers() { return { async stop() {} }; } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    checkpointStore: { load: () => (++loads === 1 ? oldDisk.promise : newDisk.promise), async write() {} },
    onRestoreComplete: () => { completions += 1; restored.resolve(); },
    deriveSession: async ({ evidence }) => ({ readiness: {}, publicState: evidence }),
  });
  t.after(() => coordinator.stop());
  await coordinator.start();
  await coordinator.stop();
  await coordinator.start();
  oldDisk.resolve({ records: [checkpoint("old")] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getByQualifiedId("codex:old"), null);
  assert.equal(completions, 0);
  newDisk.resolve({ records: [checkpoint("current")] });
  await restored.promise;
  await scheduler.flush();
  assert.equal(store.getByQualifiedId("codex:current").publicState.session.title, "Saved");
  assert.equal(completions, 1);
});

test("late checkpoints do not resurrect fresh sessions evicted during startup", { timeout: 5_000 }, async (t) => {
  const disk = deferred();
  const restored = deferred();
  const scheduler = immediateScheduler();
  const store = new SessionObservationStore({ maxEntries: 1 });
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex" }], async startObservers(value) {
      publisher = value; return { async stop() {} };
    } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    checkpointStore: { load: () => disk.promise, async write() {} },
    onRestoreComplete: restored.resolve,
    deriveSession: async ({ evidence }) => ({ readiness: {}, publicState: evidence }),
  });
  t.after(() => coordinator.stop());
  await coordinator.start();
  for (const id of ["first", "second"]) {
    publisher.publishSession("codex", id, { historical: true, session: { title: id } });
    await scheduler.flush();
  }
  assert.equal(store.getByQualifiedId("codex:first"), null);
  disk.resolve({ records: [checkpoint("first")] });
  await restored.promise;
  await scheduler.flush();
  assert.equal(store.getByQualifiedId("codex:first"), null);
  assert.equal(store.getByQualifiedId("codex:second").publicState.session.title, "second");
});

test("selection before checkpoint restoration shares its hydration with restored-live revalidation", { timeout: 5_000 }, async (t) => {
  const disk = deferred();
  const restored = deferred();
  const acquisition = deferred();
  const hydrations = [];
  const scheduler = immediateScheduler();
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex" }], async startObservers() {
      return { hydrate(id) { hydrations.push(id); return acquisition.promise; }, async stop() {} };
    } },
    store: new SessionObservationStore(), schedule: scheduler.schedule, cancel: scheduler.cancel,
    checkpointStore: { load: () => disk.promise, async write() {} },
    onRestoreComplete: restored.resolve,
    deriveSession: async ({ evidence }) => ({ readiness: {}, publicState: evidence }),
  });
  t.after(async () => { acquisition.resolve(false); await coordinator.stop(); });
  await coordinator.start();
  assert.equal(coordinator.session("codex:live").status, "loading");
  await Promise.resolve();
  assert.deepEqual(hydrations, ["codex:live"]);
  const record = checkpoint("live");
  record.evidence.historical = false;
  disk.resolve({ records: [record] });
  await restored.promise;
  await scheduler.flush();
  for (let index = 0; index < 5; index += 1) {
    assert.equal(coordinator.session("codex:live").status, "ready");
  }
  await Promise.resolve();
  assert.deepEqual(hydrations, ["codex:live"], "restoration must not queue a second acquisition for the selection");
});
