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

function deadlineScheduler() {
  let clock = 0;
  const jobs = [];
  return {
    now: () => clock,
    schedule(task, delay) { const job = { task, at: clock + delay, cancelled: false, ran: false }; jobs.push(job); return job; },
    cancel(job) { job.cancelled = true; },
    async advance(milliseconds) {
      const target = clock + milliseconds;
      for (;;) {
        const next = jobs.filter((job) => !job.cancelled && !job.ran && job.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        clock = next.at;
        next.ran = true;
        await next.task();
      }
      clock = target;
    },
  };
}

test("continuous source candidates publish at the first deadline and update the catalog without a second delay", async () => {
  const scheduler = deadlineScheduler();
  const store = memoryStore();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex", source: "Codex" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel, monotonicNow: scheduler.now,
    deriveSession: async ({ evidence }) => ({ readiness: { core: "ready" }, publicState: evidence }),
  });
  await coordinator.start();
  publisher.publishCatalog("codex", [{ localId: "one", title: "One", isLive: true, activityStatus: "working" }]);
  await scheduler.advance(0);
  for (let version = 1; version <= 10; version += 1) {
    publisher.publishSession("codex", "one", { version, session: {}, agents: [{ id: "primary", status: "active",
      liveness: { evidence: "observed", freshness: "current" },
      currentActivity: { label: `Step ${version}`, observedAt: "2026-08-30T12:00:00.000Z" },
    }] });
    await scheduler.advance(100);
    if (version % 5 === 0) {
      assert.equal(store.getByQualifiedId("codex:one").publicState.version, version);
      assert.equal(coordinator.catalog().snapshot.value.sessions[0].currentActivity.label, `Step ${version}`);
    }
  }
  publisher.publishSession("codex", "one", { version: 11, session: {}, agents: [{ id: "primary", status: "idle", currentActivity: null }] });
  await scheduler.advance(500);
  assert.equal(coordinator.catalog().snapshot.value.sessions[0].currentActivity, null);
  assert.equal(coordinator.diagnostics().sessionCommits, 3);
  await coordinator.stop();
});

test("catalog lifecycle-only transitions bypass the summary delay", async () => {
  const scheduler = deadlineScheduler();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex", source: "Codex" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store: memoryStore(), schedule: scheduler.schedule, cancel: scheduler.cancel,
    deriveSession: async () => ({ readiness: {}, publicState: {} }),
  });
  await coordinator.start();
  const entry = { localId: "one", title: "One", isLive: true, activityStatus: "working" };
  publisher.publishCatalog("codex", [entry]);
  await scheduler.advance(0);
  for (const activityStatus of ["idle", "working", "unknown", "needs_input"]) {
    publisher.publishCatalog("codex", [{ ...entry, activityStatus }]);
    await scheduler.advance(0);
    assert.equal(coordinator.catalog().snapshot.value.sessions[0].activityStatus, activityStatus);
  }
  await coordinator.stop();
});

test("fresh source evidence preempts a delayed derivation retry", async () => {
  const scheduler = deadlineScheduler();
  const store = memoryStore();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex", source: "Codex" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    deriveSession: async ({ evidence }) => {
      if (evidence.version === 1) throw new Error("Synthetic derivation failure");
      return { readiness: {}, publicState: evidence };
    },
  });
  await coordinator.start();
  publisher.publishSession("codex", "one", { version: 1, session: {} });
  await scheduler.advance(600);
  publisher.publishSession("codex", "one", { version: 2, session: {} });
  await scheduler.advance(500);
  assert.equal(store.getByQualifiedId("codex:one").publicState.version, 2);
  await coordinator.stop();
});

test("an obsolete in-flight failure cannot restart a fresh candidate's deadline", async () => {
  const scheduler = deadlineScheduler();
  const store = memoryStore();
  let publisher;
  let rejectObsolete;
  const obsoleteDerivation = new Promise((resolve, reject) => { rejectObsolete = reject; });
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex", source: "Codex" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    deriveSession: ({ evidence }) => evidence.version === 1
      ? obsoleteDerivation
      : Promise.resolve({ readiness: {}, publicState: evidence }),
  });
  await coordinator.start();
  publisher.publishSession("codex", "one", { version: 1, session: {} });
  await scheduler.advance(500);
  publisher.publishSession("codex", "one", { version: 2, session: {} });
  rejectObsolete(new Error("Synthetic obsolete derivation failure"));
  await scheduler.advance(100);
  publisher.publishSession("codex", "one", { version: 3, session: {} });
  await scheduler.advance(399);
  assert.equal(store.getByQualifiedId("codex:one"), null);
  await scheduler.advance(1);
  assert.equal(store.getByQualifiedId("codex:one")?.publicState.version, 3);
  assert.equal(coordinator.diagnostics().sessionCommits, 1);
  await coordinator.stop();
});

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
  assert.equal(live.currentActivity, null);
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

test("catalog idle clears an older heading before detail hydration without erasing retained evidence", async () => {
  const scheduler = immediateScheduler();
  const store = memoryStore();
  let publisher;
  let reads = 0;
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "codex", source: "Codex" }],
      async readSession() { reads += 1; throw new Error("Serving must stay cache-only"); },
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    deriveSession: async ({ evidence }) => ({ readiness: { core: "ready" }, publicState: evidence }),
  });
  await coordinator.start();
  const entry = { localId: "one", title: "One", isLive: true, activityStatus: "working", updatedAt: "2026-08-30T21:27:19.205Z" };
  const currentActivity = { label: "Verifying clean git status after build", observedAt: entry.updatedAt };
  publisher.publishCatalog("codex", [entry]);
  publisher.publishSession("codex", "one", {
    session: {}, metrics: { agents: 2, activeAgents: 1, tokens: { allAgents: 12_000 } },
    agents: [{ id: "primary", status: "active", currentActivity, liveness: {
      source: "structured_lifecycle", observedAt: entry.updatedAt, evidence: "observed", freshness: "current",
    } }],
  });
  await scheduler.flush();
  const first = coordinator.catalog().snapshot;
  assert.deepEqual(first.value.sessions[0].currentActivity, { ...currentActivity, state: "current" });
  const retained = store.getByQualifiedId("codex:one");

  publisher.publishCatalog("codex", [{ ...entry, activityStatus: "idle", updatedAt: "2026-08-30T21:27:29.363Z" }]);
  await scheduler.flush();
  const second = coordinator.catalog().snapshot;
  assert.equal(second.value.sessions[0].currentActivity, null);
  assert.equal(second.value.sessions[0].summaryReadiness, "ready");
  assert.equal(second.value.sessions[0].latestContextTotal, 12_000);
  assert.ok(second.revision > first.revision);
  assert.equal(store.getByQualifiedId("codex:one"), retained);
  assert.deepEqual(retained.publicState.agents[0].currentActivity, currentActivity);
  assert.equal(coordinator.catalog(second.revision).status, "unchanged");
  assert.equal(reads, 0);
  await coordinator.stop();
});

test("catalog activity falls back from running tasks to recorded work without reads or private fields", async () => {
  const scheduler = immediateScheduler();
  const store = memoryStore();
  let publisher;
  let reads = 0;
  const coordinator = createSessionObservationCoordinator({
    registry: {
      providers: [{ id: "claude", source: "Claude Code" }],
      async readSession() { reads += 1; throw new Error("Serving must stay cache-only"); },
      async startObservers(value) { publisher = value; return { async stop() {} }; },
    },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    deriveSession: async ({ evidence }) => {
      if (evidence.fail) throw new Error("Synthetic derivation failure");
      return { readiness: { core: "ready" }, publicState: {
        session: evidence.session, agents: evidence.agents, metrics: { agents: 1, activeAgents: 1 },
      } };
    },
  });
  await coordinator.start();
  const entry = { localId: "activity", title: "Activity", isLive: true, activityStatus: "working", updatedAt: "2026-09-02T12:00:00.000Z" };
  const task = { id: "PRIVATE_TASK", label: "PRIVATE_DESCRIPTION", kind: "shell", workKind: "test", status: "running", startedAt: entry.updatedAt, finishedAt: null };
  const evidence = {
    session: {}, agents: [{ id: "primary", status: "active", executionTasks: [task] }],
    toolCalls: [{ id: "PRIVATE_CALL", tool: "PRIVATE_TOOL", detail: "PRIVATE_DETAIL", actor: { id: "primary", label: "PRIVATE_ACTOR" }, workKind: "write", timestamp: "2026-09-02T12:00:01.000Z" }],
  };
  publisher.publishCatalog("claude", [entry]);
  publisher.publishSession("claude", "activity", evidence);
  await scheduler.flush();
  const first = coordinator.catalog().snapshot;
  assert.equal(first.value.sessions[0].currentActivity, null);
  assert.equal(first.value.sessions[0].activityFallback.label, "Running tests");
  assert.equal(first.value.sessions[0].activityFallback.state, "current");
  assert.doesNotMatch(JSON.stringify(first.value), /PRIVATE_|executionTasks|toolCalls/);
  const committed = store.getByQualifiedId("claude:activity");
  publisher.publishSession("claude", "activity", { ...evidence, fail: true });
  await scheduler.flush();
  assert.equal(coordinator.catalog().snapshot, first);
  assert.equal(store.getByQualifiedId("claude:activity"), committed);

  publisher.publishCatalog("claude", [{ ...entry, activityStatus: "idle" }]);
  await scheduler.flush();
  const idle = coordinator.catalog().snapshot;
  assert.equal(idle.value.sessions[0].activityFallback.label, "file edit");
  assert.equal(idle.value.sessions[0].activityFallback.state, "last_observed");
  assert.ok(idle.revision > first.revision);
  assert.equal(coordinator.catalog(idle.revision).status, "unchanged");
  assert.equal(store.getByQualifiedId("claude:activity"), committed);

  publisher.publishSession("claude", "activity", { ...evidence, agents: [{ ...evidence.agents[0], executionTasks: [{ ...task, status: "completed", finishedAt: "2026-09-02T12:00:02.000Z" }] }] });
  publisher.publishCatalog("claude", [{ ...entry, isLive: false, activityStatus: "stopped" }]);
  await scheduler.flush();
  const finalActivity = coordinator.catalog().snapshot.value.sessions[0].activityFallback;
  assert.equal(finalActivity.label, "test run");
  assert.equal(finalActivity.observedAt, "2026-09-02T12:00:02.000Z");
  store.evict("claude:activity");
  publisher.publishCatalog("claude", [{ ...entry, isLive: false, activityStatus: "stopped" }]);
  await scheduler.flush();
  assert.deepEqual(coordinator.catalog().snapshot.value.sessions[0].activityFallback, finalActivity);
  assert.equal(reads, 0);
  await coordinator.stop();
});

test("an evicted live snapshot cannot leave a running fallback on a completed catalog row", async () => {
  const scheduler = immediateScheduler();
  const store = memoryStore();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "claude", source: "Claude Code" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    deriveSession: async ({ evidence }) => ({ readiness: {}, publicState: evidence }),
  });
  await coordinator.start();
  const entry = { localId: "evicted", isLive: true, activityStatus: "working", updatedAt: "2026-09-02T12:00:00.000Z" };
  publisher.publishCatalog("claude", [entry]);
  publisher.publishSession("claude", "evicted", { session: {}, metrics: { agents: 1 }, agents: [{ id: "primary", status: "active", executionTasks: [{
    id: "task", kind: "shell", workKind: "test", status: "running", startedAt: entry.updatedAt, finishedAt: null,
  }] }] });
  await scheduler.flush();
  assert.equal(coordinator.catalog().snapshot.value.sessions[0].activityFallback.state, "current");
  store.evict("claude:evicted");
  publisher.publishCatalog("claude", [{ ...entry, isLive: false, activityStatus: "stopped" }]);
  await scheduler.flush();
  const completed = coordinator.catalog().snapshot.value.sessions[0];
  assert.equal(completed.summaryReadiness, "ready");
  assert.equal(completed.agentCount, 1);
  assert.equal(completed.activityFallback, null);
  await coordinator.stop();
});

test("restored task summaries stay last observed until provider evidence commits", async () => {
  const scheduler = immediateScheduler();
  const store = memoryStore();
  store.restore = (candidate) => store.publish(candidate);
  const task = { id: "task", kind: "shell", workKind: "test", status: "running", startedAt: "2026-09-02T12:00:00.000Z", finishedAt: null };
  const agents = [{ id: "primary", status: "active", executionTasks: [task] }];
  const evidence = { historical: false, session: {}, agents };
  const record = { providerId: "claude", localSessionId: "restored", evidence, publicState: { agents }, readiness: {}, observedAt: "2026-09-02T12:00:00.000Z" };
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "claude", source: "Claude Code" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store, schedule: scheduler.schedule, cancel: scheduler.cancel,
    checkpointStore: { async load() { return { records: [record] }; }, async write() {} },
    deriveSession: async ({ evidence }) => ({ readiness: {}, publicState: { agents: evidence.agents } }),
  });
  await coordinator.start();
  publisher.publishCatalog("claude", [{ localId: "restored", isLive: true, activityStatus: "working" }]);
  await scheduler.flush();
  assert.equal(coordinator.catalog().snapshot.value.sessions[0].activityFallback.state, "last_observed");
  coordinator.refreshProjection("claude:restored");
  await scheduler.flush();
  assert.equal(coordinator.catalog().snapshot.value.sessions[0].activityFallback.state, "last_observed");
  publisher.publishSession("claude", "restored", evidence);
  await scheduler.flush();
  assert.equal(coordinator.catalog().snapshot.value.sessions[0].activityFallback.state, "current");
  await coordinator.stop();
});

test("catalog qualifies primary activity without promoting uncertainty or child activity", async (t) => {
  const currentActivity = { label: "Retained heading", observedAt: "2026-08-30T12:00:00.000Z", privateField: "PRIVATE_ACTIVITY_INPUT" };
  const liveness = { source: "structured_lifecycle", observedAt: "2026-08-30T12:00:01.000Z", evidence: "observed", freshness: "current" };
  for (const row of [
    { name: "active", status: "active", expected: "current" },
    { name: "unknown root with active child", status: "unknown", expected: null },
    { name: "stale", status: "active", liveness: { ...liveness, freshness: "stale" }, expected: null },
    { name: "unavailable", status: "active", liveness: { ...liveness, evidence: "unavailable" }, expected: null },
    { name: "inferred", status: "active", liveness: { ...liveness, evidence: "inferred" }, expected: null },
    { name: "legacy", status: "active", liveness: null, expected: null },
    { name: "confirmed idle primary with active child", status: "idle", expected: null },
    { name: "finished primary with active child", status: "finished", expected: null },
    { name: "stopped primary with active child", status: "stopped", expected: null },
    { name: "older idle observation", status: "idle", liveness: { ...liveness, observedAt: "2026-08-30T11:59:00.000Z" }, expected: null },
    { name: "unknown catalog", status: "active", activityStatus: "unknown", expected: null },
    { name: "awaiting input", status: "needs_input", activityStatus: "needs_input", expected: null },
    { name: "active primary while a child needs input", status: "active", activityStatus: "needs_input", expected: "current" },
    { name: "historical", status: "active", isLive: false, expected: null },
  ]) await t.test(row.name, async () => {
    const scheduler = immediateScheduler();
    let publisher;
    const coordinator = createSessionObservationCoordinator({
      registry: { providers: [{ id: "codex", source: "Codex" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
      store: memoryStore(), schedule: scheduler.schedule, cancel: scheduler.cancel,
      deriveSession: async ({ evidence }) => ({ readiness: { core: "ready" }, publicState: evidence }),
    });
    await coordinator.start();
    publisher.publishCatalog("codex", [{ localId: "one", title: "One", isLive: row.isLive ?? true, activityStatus: row.activityStatus || "working" }]);
    publisher.publishSession("codex", "one", { session: {}, agents: [
      { id: "primary", status: row.status, liveness: Object.hasOwn(row, "liveness") ? row.liveness : liveness, currentActivity },
      { id: "child", status: "active", liveness, currentActivity: { label: "PRIVATE_CHILD_ACTIVITY", observedAt: currentActivity.observedAt } },
    ] });
    await scheduler.flush();
    const catalog = coordinator.catalog().snapshot.value;
    assert.deepEqual(catalog.sessions[0].currentActivity, row.expected
      ? { label: currentActivity.label, observedAt: currentActivity.observedAt, state: row.expected } : null);
    assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE_|structured_lifecycle|liveness/);
    await coordinator.stop();
  });
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

test("checkpoint restore downgrades lifecycle truth without removing retained activity", async () => {
  const scheduler = immediateScheduler();
  const restoredCandidates = [];
  const snapshots = new Map();
  const store = {
    getByQualifiedId(id) { return snapshots.get(id) || null; },
    setPinned() {},
    restore(candidate) {
      restoredCandidates.push(candidate);
      const snapshot = { ...candidate, qualifiedId: `${candidate.providerId}:${candidate.localSessionId}`, revision: candidate.revision || 1, serializedState: JSON.stringify(candidate.publicState) };
      snapshots.set(snapshot.qualifiedId, snapshot);
      return { accepted: true, snapshot };
    },
    publish(candidate) { return this.restore(candidate); },
  };
  const lifecycleAgent = {
    id: "primary",
    status: "active",
    currentActivity: { label: "Retained heading", observedAt: "2026-08-30T12:00:00.000Z" },
    liveness: { source: "structured_lifecycle", observedAt: "2026-08-30T12:00:00.000Z", evidence: "observed", freshness: "current" },
  };
  const record = {
    providerId: "codex", localSessionId: "restart-session", revision: 3,
    evidence: { historical: false, agents: [lifecycleAgent], session: {} },
    publicState: { agents: [lifecycleAgent] }, readiness: { core: "ready" }, observedAt: "2026-08-30T12:00:00.000Z", source: null,
  };
  const legacyRecord = { ...record, localSessionId: "legacy-session", evidence: { ...record.evidence, agents: [{ ...lifecycleAgent, status: "idle", liveness: { source: "lifecycle_bridge", observedAt: lifecycleAgent.liveness.observedAt } }] }, publicState: { agents: [{ ...lifecycleAgent, status: "idle", liveness: { source: "owning_app_server", observedAt: lifecycleAgent.liveness.observedAt } }] } };
  const historicalRecord = { ...record, localSessionId: "historical-session", evidence: { ...record.evidence, historical: true, agents: [{ ...lifecycleAgent, status: "finished", liveness: { source: "lifecycle_bridge", observedAt: lifecycleAgent.liveness.observedAt } }] }, publicState: { agents: [{ ...lifecycleAgent, status: "finished", liveness: { source: "lifecycle_bridge", observedAt: lifecycleAgent.liveness.observedAt } }] } };
  const claudeRecord = { ...record, providerId: "claude", localSessionId: "claude-restart-session", evidence: { ...record.evidence, agents: [{ ...lifecycleAgent, liveness: { ...lifecycleAgent.liveness, source: "lifecycle_bridge" } }] }, publicState: { agents: [{ ...lifecycleAgent, liveness: { ...lifecycleAgent.liveness, source: "lifecycle_bridge" } }] } };
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex", source: "Codex" }, { id: "claude", source: "Claude Code" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store,
    checkpointStore: { async load() { return { records: [record, legacyRecord, historicalRecord, claudeRecord] }; }, async write() {} },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    deriveSession: async ({ evidence }) => ({ readiness: { core: "ready" }, publicState: { agents: evidence.agents } }),
  });
  await coordinator.start(); await scheduler.flush();
  const restored = restoredCandidates[0].evidence.agents[0];
  assert.equal(restored.status, "unknown");
  assert.equal(restored.currentActivity.label, "Retained heading");
  assert.deepEqual(restored.liveness, {
    source: "structured_lifecycle", observedAt: "2026-08-30T12:00:00.000Z", evidence: "unavailable", freshness: "stale", reason: "legacy_snapshot",
  });
  const legacy = restoredCandidates.find((candidate) => candidate.localSessionId === "legacy-session").evidence.agents[0];
  assert.equal(legacy.status, "unknown");
  assert.equal(legacy.liveness.evidence, "unavailable");
  assert.equal(legacy.liveness.freshness, "stale");
  const historical = restoredCandidates.find((candidate) => candidate.localSessionId === "historical-session").evidence.agents[0];
  assert.deepEqual([historical.status, historical.liveness], ["finished", null]);
  const claude = restoredCandidates.find((candidate) => candidate.localSessionId === "claude-restart-session").evidence.agents[0]; assert.deepEqual([claude.status, claude.liveness.evidence, claude.liveness.freshness], ["unknown", "unavailable", "stale"]);
  publisher.publishCatalog("codex", [{ localId: "restart-session", title: "Restored", isLive: true, activityStatus: "working" }]);
  await scheduler.flush();
  assert.equal(coordinator.catalog().snapshot.value.sessions[0].currentActivity, null);
  assert.equal(snapshots.get("codex:restart-session").publicState.agents[0].status, "unknown");
  publisher.publishSession("codex", "restart-session", record.evidence);
  await scheduler.flush();
  assert.deepEqual(coordinator.catalog().snapshot.value.sessions[0].currentActivity, {
    ...lifecycleAgent.currentActivity, state: "current",
  });
  assert.equal(publisher !== undefined, true);
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
