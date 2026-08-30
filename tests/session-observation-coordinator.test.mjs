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
  });
  assert.equal(coordinator.session("codex:one").snapshot.publicState.session.title, "One");
  assert.equal(reads, 0);
  const diagnostics = coordinator.diagnostics();
  assert.equal(diagnostics.sessionCandidates, 1);
  assert.equal(diagnostics.sessionCommits, 1);
  assert.equal(diagnostics.cacheHits, 1);
  assert.equal(diagnostics.catalogStructuralFastPaths, 1);
  assert.equal(diagnostics.catalogCommitDelaySamples >= 1, true);
  assert.equal(diagnostics.catalogCommitDelayAverageMs >= 0, true);
  assert.equal(diagnostics.store, null);
  assert.equal(diagnostics.checkpoints, null);
  assert.deepEqual(diagnostics.observers, {});
});

test("coordinator diagnostics separate commit wait, derivation, and store timing", async () => {
  const scheduler = immediateScheduler();
  const backingStore = memoryStore();
  let clock = 0;
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "codex", source: "Codex" }],
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    },
    store: {
      ...backingStore,
      publish(candidate) { clock += 3; return backingStore.publish(candidate); },
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    monotonicNow: () => clock,
    async deriveSession() {
      clock += 7;
      return { readiness: {}, publicState: {} };
    },
  });
  await coordinator.start();
  publisher.publishCatalog("codex", [{ localId: "private-id", title: "PRIVATE_TITLE", project: "repo", isLive: true }]);
  publisher.publishSession("codex", "private-id", { session: { title: "PRIVATE_TITLE" } });
  await scheduler.flush();

  const diagnostics = coordinator.diagnostics();
  assert.equal(diagnostics.timings.sessionCommitWait.lastMs, 0);
  assert.equal(diagnostics.timings.sessionDerivation.lastMs, 7);
  assert.equal(diagnostics.timings.sessionStoreCommit.lastMs, 3);
  assert.equal(diagnostics.timings.sessionCandidateToCommit.lastMs, 10);
  assert.equal(diagnostics.timings.catalogCommitWait.sampleCount >= 1, true);
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_TITLE|private-id/);
  await coordinator.stop();
});

test("structural catalog changes preempt a queued summary refresh", async () => {
  let clock = 100;
  const jobs = [];
  const schedule = (task, delay) => {
    const job = { task, delay, cancelled: false };
    jobs.push(job);
    return job;
  };
  const cancel = (job) => { job.cancelled = true; };
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "codex", source: "Codex" }],
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    },
    store: memoryStore(),
    schedule,
    cancel,
    now: () => clock,
    commitDelayMs: 500,
    async deriveSession() { return { readiness: {}, publicState: {} }; },
  });
  await coordinator.start();
  const first = { localId: "one", title: "One", project: "repo", updatedAt: "2026-08-28T12:00:00.000Z", isLive: true };
  publisher.publishCatalog("codex", [first]);
  assert.equal(jobs.at(-1).delay, 0);
  jobs.at(-1).cancelled = true;
  await jobs.at(-1).task();

  clock = 200;
  publisher.publishCatalog("codex", [{ ...first, updatedAt: "2026-08-28T12:01:00.000Z" }]);
  const summaryJob = jobs.at(-1);
  assert.equal(summaryJob.delay, 500);
  clock = 250;
  publisher.publishCatalog("codex", [first, { ...first, localId: "two", title: "Two" }]);
  const structuralJob = jobs.at(-1);
  assert.equal(summaryJob.cancelled, true);
  assert.equal(structuralJob.delay, 0);
  structuralJob.cancelled = true;
  await structuralJob.task();

  assert.deepEqual(coordinator.catalog().snapshot.value.sessions.map(({ id }) => id), ["codex:one", "codex:two"]);
  assert.equal(coordinator.diagnostics().catalogStructuralFastPaths, 2);
  await coordinator.stop();
});

test("catalog rows retain bounded final metrics and progress when a session completes", async () => {
  const scheduler = immediateScheduler();
  let publisher;
  const store = memoryStore();
  const currentActivity = { label: "Preparing header measurement", observedAt: "2026-08-28T12:00:00.000Z" };
  const progress = { phase: "complete", percent: 100, confidence: "high", reportedAt: "2026-08-28T12:00:02.000Z" };
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "codex", source: "Codex" }],
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    },
    store,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    async deriveSession({ evidence }) {
      return {
        readiness: { core: "ready" },
        publicState: {
          session: evidence.session,
          metrics: { agents: 2, activeAgents: 1, tokens: { allAgents: 12_000 } },
          agents: [
            { id: "helper", currentActivity: { label: "PRIVATE_HELPER_ACTIVITY", observedAt: "2026-08-28T12:00:01.000Z" } },
            { id: "primary", currentActivity },
          ],
        },
      };
    },
  });
  await coordinator.start();
  publisher.publishCatalog("codex", [{ localId: "one", title: "One", project: "repo", updatedAt: "2026-08-28T12:00:00.000Z", isLive: true }]);
  publisher.publishSession("codex", "one", { historical: false, session: { title: "One", progress } });
  await scheduler.flush();

  const live = coordinator.catalog().snapshot.value.sessions[0];
  assert.deepEqual(live.currentActivity, currentActivity);
  assert.deepEqual(live.progress, progress);
  assert.doesNotMatch(JSON.stringify(live), /PRIVATE_HELPER_ACTIVITY/);

  publisher.publishCatalog("codex", [{ localId: "one", title: "One", project: "repo", updatedAt: "2026-08-28T12:00:02.000Z", isLive: false }]);
  await scheduler.flush();

  const completed = coordinator.catalog().snapshot.value.sessions[0];
  assert.equal(completed.summaryReadiness, "ready");
  assert.equal(completed.agentCount, 2);
  assert.equal(completed.activeAgentCount, 0);
  assert.equal(completed.latestContextTotal, 12_000);
  assert.deepEqual(completed.progress, progress);
  assert.equal(completed.currentActivity, null);
  assert.equal(Object.hasOwn(coordinator.catalog().snapshot.value, "liveSessions"), false);

  store.evict("codex:one");
  publisher.publishCatalog("codex", [
    { localId: "one", title: "One", project: "repo", updatedAt: "2026-08-28T12:00:02.000Z", isLive: false },
    { localId: "two", title: "Two", project: "repo", updatedAt: "2026-08-28T12:00:03.000Z", isLive: false },
  ]);
  await scheduler.flush();

  const retained = coordinator.catalog().snapshot.value.sessions.find((entry) => entry.id === "codex:one");
  assert.equal(retained.summaryReadiness, "ready");
  assert.equal(retained.agentCount, 2);
  assert.equal(retained.latestContextTotal, 12_000);
  assert.deepEqual(retained.progress, progress);
  await coordinator.stop();
});

test("catalog rows are committed by creation time descending regardless of live activity", async () => {
  const scheduler = immediateScheduler();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "codex", source: "Codex" }],
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    },
    store: memoryStore(),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    async deriveSession() { return { readiness: {}, publicState: {} }; },
  });
  await coordinator.start();
  publisher.publishCatalog("codex", [
    { localId: "older-active", title: "Older active", project: "repo", createdAt: "2026-08-28T10:00:00.000Z", updatedAt: "2026-08-29T15:00:00.000Z", isLive: true, needsInput: true },
    { localId: "newest", title: "Newest", project: "repo", createdAt: "2026-08-29T10:00:00.000Z", updatedAt: "2026-08-29T10:00:00.000Z", isLive: false },
    { localId: "middle", title: "Middle", project: "repo", createdAt: "2026-08-28T18:00:00.000Z", updatedAt: "2026-08-28T18:00:00.000Z", isLive: false },
  ]);
  await scheduler.flush();

  assert.deepEqual(coordinator.catalog().snapshot.value.sessions.map(({ id }) => id), [
    "codex:newest",
    "codex:middle",
    "codex:older-active",
  ]);
  await coordinator.stop();
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

test("downstream dependency refreshes rederive a committed session without provider acquisition", async () => {
  const scheduler = immediateScheduler();
  const store = memoryStore();
  let publisher;
  let resourceStatus = "collecting";
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "codex", source: "Codex" }],
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    },
    store,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    async deriveSession({ evidence }) {
      return {
        readiness: { resources: resourceStatus === "unavailable" ? "unavailable" : "loading" },
        publicState: { version: evidence.version, resourceStatus },
      };
    },
  });
  await coordinator.start();
  publisher.publishSession("codex", "one", { version: 1, historical: false, session: {} });
  await scheduler.flush();
  assert.equal(store.getByQualifiedId("codex:one").publicState.resourceStatus, "collecting");

  resourceStatus = "unavailable";
  assert.equal(coordinator.refreshProjection("codex:one"), true);
  await scheduler.flush();
  assert.equal(store.getByQualifiedId("codex:one").publicState.resourceStatus, "unavailable");
  assert.equal(store.getByQualifiedId("codex:one").readiness.resources, "unavailable");
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
