import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildAgentsAnalytics } from "../monitor/agents-analytics.mjs";
import { createAgentsObservation } from "../monitor/agents-observation.mjs";
import { createCommittedResponseCache } from "../monitor/committed-response-cache.mjs";
import { createRequestHandler } from "../monitor/request-handler.mjs";
import { createMonitorRuntime } from "../monitor/server.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../shared/monitor-state.mjs";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * 24 * 60 * 60_000).toISOString();

function snapshot(id, { project = "Pomegr", live = false, agents = [] } = {}) {
  return {
    qualifiedId: id,
    publicState: {
      source: "Codex",
      session: { id, title: "Bounded session title", project },
      agents,
      view: live ? "live" : "history",
    },
  };
}

function agent(id, values = {}) {
  return {
    id,
    label: id === "primary" ? "Primary agent" : "Subagent",
    assignment: null,
    role: id === "primary" ? "orchestrator" : "builder",
    model: "gpt-5.6-terra",
    status: "finished",
    startedAt: iso(2),
    lastSeen: iso(1),
    toolCalls: 3,
    tokens: { total: 456 },
    executionTasks: [{ workKind: "test" }, { workKind: "test" }],
    ...values,
  };
}

test("agents analytics uses retained normalized public snapshots for filter aggregates and safe hierarchy", () => {
  const entries = [snapshot("codex:recent", {
    live: true,
    agents: [
      agent("primary"),
      agent("child", { parentId: "primary", model: "unknown", startedAt: iso(40), executionTasks: [{ workKind: "write" }] }),
    ],
  })];
  const result = buildAgentsAnalytics({
    entries,
    catalog: [{ id: "codex:recent", project: "Pomegr", isLive: true }],
    project: "Pomegr", days: 7, scope: "all", now: NOW,
  });

  assert.deepEqual(result.summary, { runCount: 1, sessionCount: 1, modelCount: 1, mainRunCount: 1, delegatedRunCount: 0 });
  assert.deepEqual(result.work, [{ workKind: "test", count: 2 }]);
  assert.match(result.runs[0].id, /^run_[A-Za-z0-9_-]{43}$/);
  assert.equal(result.runs[0].modelEvidence, "latest_reported");
  assert.equal(result.runs[0].latestContextTotal, 456);
  assert.equal(result.roster.length, 2, "live roster retains hierarchy outside the historical start-date filter");
  const child = result.roster.find((run) => run.agentId === "child");
  assert.equal(child.parentId, result.roster.find((run) => run.agentId === "primary").id);
  assert.equal(child.depth, 1);
  assert.equal(child.model, null);
  assert.equal(child.modelEvidence, "unavailable");
  assert.doesNotMatch(JSON.stringify(result), /cwd|tokens|prompt|provider kind/i);
});

test("roster is session-grouped parent-first across filtered roots and malformed trees", () => {
  const entries = [snapshot("codex:tree", { live: true, agents: [
    agent("primary", { startedAt: iso(2) }),
    agent("child", { parentId: "primary", startedAt: iso(0.1) }),
    agent("grandchild", { parentId: "child", startedAt: iso(0.05) }),
    agent("cycle-a", { parentId: "cycle-b", startedAt: iso(0.01) }),
    agent("cycle-b", { parentId: "cycle-a", startedAt: iso(0.02) }),
  ] })];
  const roster = buildAgentsAnalytics({ entries, catalog: [{ id: "codex:tree", project: "Pomegr", isLive: true }], now: NOW, days: 7, scope: "all" }).roster;
  assert.deepEqual(roster.slice(0, 3).map((run) => run.agentId), ["primary", "child", "grandchild"]);
  assert.equal(new Set(roster.map((run) => run.id)).size, roster.length, "cycles are emitted once without recursion loss");
  const delegated = buildAgentsAnalytics({ entries, catalog: [{ id: "codex:tree", project: "Pomegr", isLive: true }], now: NOW, days: 7, scope: "delegated" }).roster;
  assert.deepEqual(delegated.slice(0, 2).map((run) => run.agentId), ["child", "grandchild"]);
  assert.deepEqual(delegated.slice(0, 2).map((run) => run.depth), [1, 2], "filtered parents do not collapse persisted depth");
});

test("analytics keeps missing task and zero-context evidence unavailable and bounds aggregate conservation", () => {
  const entries = [snapshot("codex:unknown", { agents: [agent("primary", {
    tokens: { total: 0 }, executionTasks: undefined,
  })] })];
  const result = buildAgentsAnalytics({ entries, catalog: [{ id: "codex:unknown", project: "Pomegr", isLive: false }], now: NOW });
  assert.equal(result.runs[0].latestContextTotal, null);
  assert.equal(result.runs[0].executionTaskCount, null);
  assert.equal(result.summary.runCount, result.runs.length);
  assert.equal(result.models.reduce((total, model) => total + model.runCount, 0), result.summary.runCount);
});

function scheduler() {
  let now = NOW;
  let id = 0;
  let lastDelay = null;
  const timers = new Map();
  return {
    now: () => now,
    schedule(task, delay) { const key = ++id; lastDelay = delay; timers.set(key, { task, at: now + delay }); return key; },
    cancel(key) { timers.delete(key); },
    count: () => timers.size,
    lastDelay: () => lastDelay,
    async run() {
      const next = [...timers].sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) return false;
      now = next[1].at;
      timers.delete(next[0]);
      await next[1].task();
      return true;
    },
  };
}

test("agents observation waits for committed readiness, coalesces commits, and retains last good response", async () => {
  const clock = scheduler();
  let entries = [snapshot("codex:one", { agents: [agent("primary")] })];
  let entryReads = 0;
  let listener = null;
  let ready = false;
  const observation = createAgentsObservation({
    store: { entries() { entryReads += 1; return entries; } },
    catalog: () => [{ id: "codex:one", project: "Pomegr", isLive: false }],
    subscribe(next) { listener = next; return () => { listener = null; }; },
    isReady: () => ready,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  observation.start();
  assert.equal(observation.read({ project: "all", days: 7, scope: "main" }).snapshot.value.readiness, "loading");
  assert.equal(clock.count(), 0, "startup remains loading until committed catalog/session evidence changes");
  ready = true;
  listener({ type: "catalog" });
  assert.equal(clock.count(), 1);
  await clock.run();
  const first = observation.read({ project: "all", days: 30, scope: "all" }).snapshot;
  assert.equal(first.value.readiness, "ready");
  const readsAfterDerivation = entryReads;
  for (let index = 0; index < 10; index += 1) {
    assert.equal(observation.read({ project: "all", days: 30, scope: "all" }, first.revision).status, "unchanged");
  }
  assert.equal(entryReads, readsAfterDerivation, "GET-serving reads the committed response only");

  listener({ type: "session" });
  await clock.run();
  const unchanged = observation.read({ project: "all", days: 30, scope: "all" }).snapshot;
  assert.strictEqual(unchanged, first, "unchanged committed evidence keeps the exact response revision");

  listener({ type: "session" });
  listener({ type: "catalog" });
  assert.equal(clock.count(), 1, "relevant commits share one pending derivation");
  entries = null;
  await clock.run();
  const retained = observation.read({ project: "all", days: 30, scope: "all" }).snapshot;
  assert.ok(retained.revision > first.revision, "refresh status may revise while retaining last-known-good analytics");
  assert.equal(retained.value.summary.runCount, first.value.summary.runCount);
  assert.equal(retained.value.refreshReadiness, "unavailable");
  assert.equal(observation.diagnostics().failures, 1);
  observation.stop();
});

test("agents observation stages project variants in yielded batches and retries failures no faster than one minute", async () => {
  const clock = scheduler();
  let entries = [snapshot("codex:one", { project: "One", agents: [agent("primary")] }), snapshot("codex:two", { project: "Two", agents: [agent("primary")] })];
  let listener = null;
  let yields = 0;
  const observation = createAgentsObservation({
    store: { entries: () => entries },
    catalog: () => [{ id: "codex:one", project: "One", isLive: false }, { id: "codex:two", project: "Two", isLive: false }],
    subscribe(next) { listener = next; return () => { listener = null; }; },
    isReady: () => true,
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    batchSize: 2, yieldTask: async () => { yields += 1; },
  });
  observation.start();
  listener({ type: "catalog" });
  await clock.run();
  assert.ok(yields > 0, "large variant matrices yield between bounded batches");
  assert.equal(observation.diagnostics().variants, 27);
  const first = observation.read({ project: "One", days: 30, scope: "all" }).snapshot;
  entries = null;
  listener({ type: "session" });
  await clock.run();
  const failed = observation.read({ project: "One", days: 30, scope: "all" }).snapshot;
  assert.equal(observation.diagnostics().variants, 27);
  assert.equal(failed.value.refreshReadiness, "unavailable");
  listener({ type: "catalog" });
  assert.equal(clock.count(), 1, "failure retry and later events share the same bounded attempt");
  assert.equal(observation.read({ project: "One", days: 30, scope: "all" }).snapshot.value.summary.runCount, first.value.summary.runCount);
  observation.stop();
});

test("agents observation restart rebuilds identical retained input for the new generation", async () => {
  const clock = scheduler();
  let listener = null;
  let entries = [snapshot("codex:restart", { project: "Restart", agents: [agent("primary")] })];
  const observation = createAgentsObservation({
    store: { entries: () => entries },
    catalog: () => [{ id: "codex:restart", project: "Restart", isLive: false }],
    subscribe(next) { listener = next; return () => { listener = null; }; },
    isReady: () => true,
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  observation.start();
  await clock.run();
  const ready = observation.read({ project: "Restart", days: 30, scope: "all" }).snapshot;
  assert.equal(ready.value.readiness, "ready");
  entries = null;
  listener({ type: "session" });
  await clock.run();
  const failed = observation.read({ project: "Restart", days: 30, scope: "all" }).snapshot;
  assert.equal(failed.value.refreshReadiness, "unavailable");
  assert.equal(failed.value.summary.runCount, ready.value.summary.runCount);
  observation.stop();
  observation.start();
  assert.equal(clock.count(), 1, "already-committed readiness schedules the new generation");
  assert.strictEqual(observation.read({ project: "Restart", days: 30, scope: "all" }).snapshot, failed, "restart retains a project LKG response before refresh");
  observation.stop();
});

test("pruned and re-added project variants never reuse an old conditional revision", async () => {
  const clock = scheduler();
  let listener = null;
  let entries = [snapshot("codex:revision", { project: "First", agents: [agent("primary")] })];
  const observation = createAgentsObservation({
    store: { entries: () => entries },
    catalog: () => entries.map((entry) => ({ id: entry.qualifiedId, project: entry.publicState.session.project, isLive: false })),
    subscribe(next) { listener = next; return () => { listener = null; }; },
    isReady: () => true,
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  observation.start();
  await clock.run();
  const old = observation.read({ project: "First", days: 30, scope: "all" }).snapshot;
  entries = [snapshot("codex:revision", { project: "Second", agents: [agent("primary")] })];
  listener({ type: "session" });
  await clock.run();
  assert.equal(observation.read({ project: "First", days: 30, scope: "all" }).status, "invalid");
  entries = [snapshot("codex:revision", { project: "First", agents: [agent("primary", { toolCalls: 99 })] })];
  listener({ type: "session" });
  await clock.run();
  const readded = observation.read({ project: "First", days: 30, scope: "all" });
  assert.ok(readded.revision > old.revision);
  assert.equal(observation.read({ project: "First", days: 30, scope: "all" }, old.revision).status, "ready");
  observation.stop();
});

test("future cache-window boundary never schedules a native timeout above Node's limit", async () => {
  const clock = scheduler();
  let listener = null;
  const observation = createAgentsObservation({
    store: { entries: () => [snapshot("codex:future", { agents: [agent("primary", { startedAt: iso(31) })] })] },
    catalog: () => [{ id: "codex:future", project: "Pomegr", isLive: false }],
    subscribe(next) { listener = next; return () => { listener = null; }; },
    isReady: () => true,
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  observation.start();
  await clock.run();
  assert.equal(observation.diagnostics().failures, 0);
  assert.ok(observation.diagnostics().nextBoundaryAt - NOW > 2_147_483_647);
  assert.equal(clock.lastDelay(), 2_147_483_647);
  observation.stop();
});

test("agents HTTP endpoint serves one prebuilt revision and never invokes an acquisition path", async (t) => {
  const cache = createCommittedResponseCache({ includeRevision: true });
  const committed = cache.commit(buildAgentsAnalytics({
    entries: [snapshot("codex:one", { agents: [agent("primary")] })],
    catalog: [{ id: "codex:one", project: "Pomegr", isLive: false }],
    now: NOW,
  }));
  let serveCalls = 0;
  let sourceReads = 0;
  const server = http.createServer(createRequestHandler({ runtime: {
    serveAgents(query, revision) { serveCalls += 1; return cache.read(revision); },
    acquireProvider() { sourceReads += 1; },
  } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/agents?project=all&days=30&scope=all`;
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(url)));
  const bodies = await Promise.all(responses.map((response) => response.text()));
  assert.equal(new Set(bodies).size, 1);
  assert.equal(JSON.parse(bodies[0]).revision, committed.revision);
  assert.equal((await fetch(`${url}&revision=${committed.revision}`)).status, 204);
  assert.equal(sourceReads, 0);
  assert.equal(serveCalls, 9);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
});

test("monitor runtime publishes agents only after its committed catalog and never hydrates on serve", async () => {
  let sourceReads = 0;
  const retained = snapshot("codex:runtime", { agents: [agent("primary")] });
  const provider = { id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities() };
  const runtime = createMonitorRuntime({
    checkpointStore: false,
    observationCommitDelayMs: 0,
    observationStore: {
      entries: () => [retained], getByQualifiedId: () => null, get: () => null,
      setPinned() {}, stats: () => ({ entries: 1 }), publish() { throw new Error("unexpected source publication"); },
    },
    resourceUsageSampler: { sample: async () => {}, get: () => null },
    providerRegistry: {
      providers: [provider], defaultProvider: provider,
      readServiceStatus: async () => ({ status: "operational", updatedAt: iso(0), incidents: [] }),
      readUsageLimits: async () => createEmptyUsageLimits(),
      inspectSessions: async () => ({ resourceTargets: [] }),
      startObservers: async (publisher) => {
        publisher.publishCatalog("codex", [{ localId: "runtime", title: "Runtime", project: "Pomegr", isLive: false, updatedAt: iso(0) }], "ready");
        return { async stop() {} };
      },
      readSession: async () => { sourceReads += 1; return null; },
    },
  });
  await runtime.startObservation();
  for (let index = 0; index < 8 && runtime.serveAgents({ project: "all", days: 30, scope: "all" }).snapshot.value.readiness !== "ready"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const served = runtime.serveAgents({ project: "all", days: 30, scope: "all" });
  assert.equal(served.snapshot.value.readiness, "ready");
  assert.equal(served.snapshot.value.summary.runCount, 1);
  assert.equal(sourceReads, 0, "agents serving does not route through registry readSession/hydration");
  await runtime.stopObservation();
});
