import assert from "node:assert/strict";
import test from "node:test";
import { createSessionObservationCoordinator } from "../monitor/session-observation-coordinator.mjs";

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
    setPinned() {},
    publish(candidate) {
      const previous = values.get(`${candidate.providerId}:${candidate.localSessionId}`);
      const snapshot = Object.freeze({ ...candidate, qualifiedId: `${candidate.providerId}:${candidate.localSessionId}`, revision: (previous?.revision || 0) + 1, serializedState: JSON.stringify(candidate.publicState) });
      values.set(snapshot.qualifiedId, snapshot);
      return { accepted: true, snapshot };
    },
  };
}

test("Serving reads committed projections and never invokes compatibility readSession", async () => {
  const scheduler = immediateScheduler();
  let reads = 0;
  let scopedPublisher;
  const registry = {
    providers: [{ id: "codex", source: "Codex" }],
    async readSession() { reads += 1; throw new Error("request path must not parse"); },
    async startObservers(publisher) {
      scopedPublisher = publisher;
      return { async hydrate() { return true; }, async stop() {} };
    },
  };
  const coordinator = createSessionObservationCoordinator({
    registry,
    store: memoryStore(),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    deriveSession: async ({ evidence }) => ({ readiness: { core: "ready" }, publicState: { connected: true, session: evidence.session } }),
  });
  await coordinator.start();
  scopedPublisher.publishCatalog("codex", [{ localId: "one", title: "One", project: "repo", updatedAt: "2026-08-28T12:00:00.000Z", isLive: true }]);
  scopedPublisher.publishSession("codex", "one", { historical: false, session: { title: "One", updatedAt: "2026-08-28T12:00:00.000Z" } });
  await scheduler.flush();

  assert.equal(coordinator.catalog().snapshot.value.sessions[0].id, "codex:one");
  assert.deepEqual(coordinator.catalog().snapshot.value.readiness, {
    catalog: "ready",
    sessionSummaries: { "codex:one": "ready" },
  });
  assert.equal(coordinator.session("codex:one").snapshot.publicState.session.title, "One");
  assert.equal(reads, 0);
  assert.deepEqual(coordinator.diagnostics(), {
    sessionCandidates: 1,
    sessionCommits: 1,
    unchangedCandidates: 0,
    rejectedCandidates: 0,
    cacheHits: 1,
    cacheMisses: 0,
    hydrationsQueued: 0,
    invalidations: 0,
    store: null,
    checkpoints: null,
    observers: {},
  });
});

test("invalid IDs never hydrate and confirmed unavailability preserves data with unavailable readiness", async () => {
  const scheduler = immediateScheduler();
  const store = memoryStore();
  let publisher;
  let hydrations = 0;
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "codex", source: "Codex" }],
      async startObservers(value) {
        publisher = value;
        return { async stop() {}, async hydrate() { hydrations += 1; return true; } };
      },
    },
    store,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    async deriveSession({ evidence }) {
      return { readiness: { core: "ready" }, publicState: { version: evidence.version, readiness: { core: "ready" } } };
    },
  });
  await coordinator.start();
  assert.equal(coordinator.session("unknown:private").status, "empty");
  assert.equal(hydrations, 0);
  publisher.publishSession("codex", "one", { version: 1, historical: false, session: {} });
  await scheduler.flush();
  publisher.invalidateSession("codex", "one", "source_unavailable");
  assert.equal(store.getByQualifiedId("codex:one").publicState.version, 1);
  assert.equal(store.getByQualifiedId("codex:one").readiness.core, "unavailable");
});

test("stopping during derivation prevents a late publication", async () => {
  const scheduler = immediateScheduler();
  const store = memoryStore();
  let publisher;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "claude", source: "Claude Code" }],
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    },
    store,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    async deriveSession() { await pending; return { readiness: { core: "ready" }, publicState: { ready: true } }; },
  });
  await coordinator.start();
  publisher.publishSession("claude", "late", { historical: false, session: {} });
  const work = scheduler.jobs.shift()();
  await Promise.resolve();
  const stopping = coordinator.stop();
  release();
  await Promise.all([work, stopping]);
  assert.equal(store.getByQualifiedId("claude:late"), null);
});

test("a newer candidate supersedes queued work and failed derivation keeps known-good state", async () => {
  const scheduler = immediateScheduler();
  const store = memoryStore();
  let publisher;
  let fail = false;
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "claude", source: "Claude Code" }],
      async startObservers(value) { publisher = value; return { async stop() {}, async hydrate() { return true; } }; },
    },
    store,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    async deriveSession({ evidence }) {
      if (fail) throw new Error("private failure");
      return { readiness: { core: "ready" }, publicState: { version: evidence.version } };
    },
  });
  await coordinator.start();
  publisher.publishSession("claude", "one", { version: 1, historical: false, session: {} });
  publisher.publishSession("claude", "one", { version: 2, historical: false, session: {} });
  await scheduler.flush();
  assert.equal(store.getByQualifiedId("claude:one").publicState.version, 2);

  fail = true;
  publisher.publishSession("claude", "one", { version: 3, historical: false, session: {} });
  await scheduler.flush();
  assert.equal(store.getByQualifiedId("claude:one").publicState.version, 2);
});

test("checkpoint writes debounce until quiet but never drift past the continuous-activity maximum", async () => {
  let clock = 0;
  const jobs = [];
  const schedule = (task, delay) => {
    const job = { task, delay, cancelled: false };
    jobs.push(job);
    return job;
  };
  const cancel = (job) => { job.cancelled = true; };
  const flushImmediate = async () => {
    let job;
    while ((job = jobs.find((candidate) => !candidate.cancelled && candidate.delay === 0))) {
      job.cancelled = true;
      await job.task();
    }
  };
  const writes = [];
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "claude", source: "Claude Code" }],
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    },
    store: memoryStore(),
    checkpointStore: { async load() { return { records: [] }; }, async write(snapshot) { writes.push(snapshot.revision); } },
    schedule,
    cancel,
    now: () => clock,
    commitDelayMs: 0,
    checkpointDelayMs: 5_000,
    checkpointMaxDelayMs: 60_000,
    async deriveSession({ evidence }) { return { readiness: { core: "ready" }, publicState: { version: evidence.version } }; },
  });
  await coordinator.start();

  publisher.publishSession("claude", "one", { version: 1, historical: false, session: {} });
  await flushImmediate();
  assert.equal(jobs.find((job) => !job.cancelled && job.delay > 0)?.delay, 5_000);

  clock = 58_000;
  publisher.publishSession("claude", "one", { version: 2, historical: false, session: {} });
  await flushImmediate();
  const checkpoint = jobs.find((job) => !job.cancelled && job.delay > 0);
  assert.equal(checkpoint.delay, 2_000);
  checkpoint.cancelled = true;
  await checkpoint.task();
  assert.deepEqual(writes, [2]);
});
