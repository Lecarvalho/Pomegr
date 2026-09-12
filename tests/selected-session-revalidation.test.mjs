import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionObservationCoordinator } from "../monitor/session-observation-coordinator.mjs";
import { createIncrementalProviderObserver } from "../monitor/providers/incremental-provider-observer.mjs";

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
    get(providerId, localSessionId) { return values.get(`${providerId}:${localSessionId}`) || null; },
    restore(candidate) { return this.publish(candidate); },
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

function liveCheckpoint(localSessionId = "restored") {
  const agent = { id: "primary", status: "active", toolCalls: 32,
    liveness: { source: "lifecycle_bridge", observedAt: "2026-09-12T17:00:00.000Z", evidence: "observed", freshness: "current" } };
  return { providerId: "claude", localSessionId, source: { fingerprint: "saved", completeOffset: 16 },
    evidence: { historical: false, session: {}, agents: [agent] }, publicState: { agents: [agent] },
    readiness: { core: "ready" }, observedAt: "2026-09-12T17:00:00.000Z" };
}

test("selecting restored live evidence promotes one refresh while serving the saved revision", async (t) => {
  const scheduler = immediateScheduler();
  const record = liveCheckpoint();
  const history = { ...liveCheckpoint("history"), evidence: { ...record.evidence, historical: true } };
  const store = memoryStore();
  let publisher;
  let finishHydration;
  const hydrations = [];
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "claude" }], async startObservers(value) {
      publisher = value;
      return { async stop() {}, hydrate(id) { hydrations.push(id); return new Promise((resolve) => { finishHydration = resolve; }); } };
    } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    checkpointStore: { async load() { return { records: [record, history] }; }, async write() {} },
    deriveSession: async ({ evidence }) => ({ readiness: { core: "ready" }, publicState: evidence }),
  });
  t.after(() => coordinator.stop());
  await coordinator.start();
  await scheduler.flush();
  const saved = store.getByQualifiedId("claude:restored");
  assert.equal(coordinator.session("claude:history").status, "ready");
  for (let index = 0; index < 5; index += 1) {
    const result = coordinator.session("claude:restored", saved.revision);
    assert.equal(result.status, "unchanged");
    assert.equal(result.snapshot, saved);
    assert.equal(result.snapshot.publicState.agents[0].status, "unknown");
    assert.equal(result.snapshot.publicState.agents[0].toolCalls, 32);
  }
  assert.deepEqual(hydrations, [], "GET only queues refresh; it does not acquire provider evidence");
  await Promise.resolve();
  assert.deepEqual(hydrations, ["claude:restored"]);
  coordinator.session("claude:restored");
  await Promise.resolve();
  assert.equal(hydrations.length, 1, "polls do not request a dirty-again replay while refresh is pending");
  finishHydration(false);
  await new Promise(setImmediate);
  coordinator.session("claude:restored");
  await Promise.resolve();
  assert.equal(hydrations.length, 2, "a failed attempt remains eligible for repair on a later read");
  publisher.publishSession("claude", "restored", record.evidence);
  finishHydration(true);
  await new Promise(setImmediate);
  coordinator.session("claude:restored");
  await Promise.resolve();
  assert.equal(hydrations.length, 2, "a candidate waiting to commit does not need another acquisition");
  await scheduler.flush();
  const refreshed = coordinator.session("claude:restored", saved.revision);
  assert.equal(refreshed.status, "ready");
  assert.equal(refreshed.snapshot.publicState.agents[0].status, "active");
  assert.ok(refreshed.snapshot.revision > saved.revision);
  assert.deepEqual(publisher.checkpointFor("claude", "history"), history.source, "historical cursors remain reusable");
  publisher.publishSession("claude", "restored", { ...record.evidence, agents: [{ id: "primary", status: "unknown" }] });
  await scheduler.flush();
  coordinator.session("claude:restored");
  await Promise.resolve();
  assert.equal(hydrations.length, 2, "fresh but unavailable lifecycle is not mistaken for a restored snapshot");
});

test("selection during observer startup is retained and coalesced to the latest session", async (t) => {
  const scheduler = immediateScheduler();
  const store = memoryStore();
  const hydrations = [];
  let finishStartup;
  let observersStarting;
  const starting = new Promise((resolve) => { observersStarting = resolve; });
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "claude" }], startObservers() {
      observersStarting();
      return new Promise((resolve) => { finishStartup = () => resolve({ async stop() {}, async hydrate(id) { hydrations.push(id); } }); });
    } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    checkpointStore: { async load() { return { records: [liveCheckpoint("first"), liveCheckpoint("second")] }; }, async write() {} },
    deriveSession: async ({ evidence }) => ({ readiness: {}, publicState: evidence }),
  });
  t.after(() => coordinator.stop());
  const startup = coordinator.start();
  await starting;
  assert.equal(coordinator.session("claude:first").snapshot.publicState.agents[0].status, "unknown");
  coordinator.session("claude:second");
  coordinator.session("claude:second");
  assert.deepEqual(hydrations, []);
  finishStartup();
  await startup;
  await Promise.resolve();
  assert.deepEqual(hydrations, ["claude:second"]);
});

test("a cached historical selection cancels an earlier live startup promotion", async (t) => {
  const scheduler = immediateScheduler();
  const record = liveCheckpoint();
  const history = { ...liveCheckpoint("history"), evidence: { ...record.evidence, historical: true } };
  const hydrations = [];
  let finishStartup;
  let observersStarting;
  const starting = new Promise((resolve) => { observersStarting = resolve; });
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "claude" }], startObservers() {
      observersStarting();
      return new Promise((resolve) => { finishStartup = () => resolve({ async stop() {}, async hydrate(id) { hydrations.push(id); } }); });
    } },
    store: memoryStore(), schedule: scheduler.schedule, cancel: scheduler.cancel,
    checkpointStore: { async load() { return { records: [record, history] }; }, async write() {} },
    deriveSession: async ({ evidence }) => ({ readiness: {}, publicState: evidence }),
  });
  t.after(() => coordinator.stop());
  const startup = coordinator.start();
  await starting;
  coordinator.session("claude:restored");
  coordinator.session("claude:history");
  finishStartup();
  await startup;
  await Promise.resolve();
  assert.deepEqual(hydrations, [], "the old live selection is left to ordinary background observation");
});

test("an unchanged restored live source revalidates lifecycle without waiting for a transcript append", { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-restored-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source.jsonl");
  const contents = '{"type":"synthetic"}\n';
  await writeFile(file, contents);
  const record = liveCheckpoint();
  record.source = { fingerprint: crypto.createHash("sha256").update("claude\0restored\0unchanged").digest("hex"), completeOffset: Buffer.byteLength(contents) };
  const scheduler = immediateScheduler();
  const store = memoryStore();
  let publisher;
  let evidenceReads = 0;
  let didPublish;
  const published = new Promise((resolve) => { didPublish = resolve; });
  let finishCatalog;
  const catalog = new Promise((resolve) => { finishCatalog = resolve; });
  const observer = createIncrementalProviderObserver({
    providerId: "claude", list: () => catalog,
    resolveSource: () => ({ file, identity: "unchanged", size: Buffer.byteLength(contents), historical: false }),
    readEvidence: async () => { evidenceReads += 1; return record.evidence; },
  });
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "claude" }], async startObservers(value, signal) {
      publisher = value;
      await observer.start({
        checkpointFor: (id) => publisher.checkpointFor("claude", id),
        publishCatalog: (entries) => publisher.publishCatalog("claude", entries),
        publishSession: (id, evidence) => { publisher.publishSession("claude", id, evidence); didPublish(); },
        invalidateSession: (id, reason) => publisher.invalidateSession("claude", id, reason),
      }, signal);
      return { hydrate: () => observer.hydrate("restored"), stop: () => observer.stop() };
    } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    checkpointStore: { async load() { return { records: [record] }; }, async write() {} },
    deriveSession: async ({ evidence }) => ({ readiness: { core: "ready" }, publicState: evidence }),
  });
  t.after(async () => { await coordinator.stop(); finishCatalog([]); });
  await coordinator.start();
  await scheduler.flush();
  assert.equal(publisher.checkpointFor("claude", "restored"), null, "a saved cursor cannot stand in for current lifecycle evidence");
  const saved = coordinator.session("claude:restored").snapshot;
  assert.equal(saved.publicState.agents[0].status, "unknown");
  await published;
  await scheduler.flush();
  assert.equal(evidenceReads, 1);
  const current = coordinator.session("claude:restored").snapshot;
  assert.equal(current.publicState.agents[0].status, "active");
  assert.ok(current.revision > saved.revision);
  assert.deepEqual(publisher.checkpointFor("claude", "restored"), record.source);
  await observer.hydrate("restored");
  assert.equal(evidenceReads, 1, "the successfully revalidated source resumes unchanged-cursor reuse");
});
