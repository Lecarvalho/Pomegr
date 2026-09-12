import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMonitorRuntime } from "../monitor/server.mjs";
import { SessionHistoryStore } from "../monitor/session-history-store.mjs";
import { createPipelineTraceRecorder } from "../monitor/pipeline-trace.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../shared/monitor-state.mjs";

const evidence = JSON.parse(await readFile(new URL("./fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8"));
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("repository inventory association does not delay a normalized live session", async (context) => {
  let releaseAssociation;
  const associationGate = new Promise((resolve) => { releaseAssociation = resolve; });
  const provider = {
    id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } },
    async readSessionHistory() { return { complete: true, requests: [], activity: [] }; },
  };
  const repositoryInventory = {
    ready: Promise.resolve(), async reconcile() {}, startPluginObservation() {}, async stopPluginObservation() {},
    subscribe() { return () => {}; }, readRepositories() { return null; },
    async associateSession() { await associationGate; return {}; },
    readRevision() { return null; }, capture() { return null; }, refreshPluginSetup() { return null; },
    readPluginSetup() { return null; }, preparePluginAction() { return null; },
  };
  const registry = {
    providers: [provider], defaultProvider: provider, providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; }, async readUsageLimits() { return createEmptyUsageLimits(); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; }, unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      publisher.publishCatalog("codex", [{ localId: evidence.localId, title: evidence.session.title, project: evidence.session.project,
        updatedAt: evidence.session.updatedAt, isLive: true, needsInput: false, activityStatus: "working" }]);
      publisher.publishSession("codex", evidence.localId, evidence);
      return { async hydrate() { return true; }, async stop() {} };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry, checkpointStore: false, repositoryInventory,
    observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(async () => { releaseAssociation(); await runtime.stopObservation(); });
  await runtime.startObservation();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (runtime.serveSession(`codex:${evidence.localId}`).status === "ready") break;
    await pause(2);
  }
  assert.equal(runtime.serveSession(`codex:${evidence.localId}`).status, "ready");
  releaseAssociation();
});

test("source-complete Activity commits while the unrelated session derivation is held", async (context) => {
  let releaseDerivation;
  let enteredDerivation;
  let releaseHistory;
  const derivationGate = new Promise((resolve) => { releaseDerivation = resolve; });
  const enteredGate = new Promise((resolve) => { enteredDerivation = resolve; });
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  let historyReads = 0;
  let observerPublisher;
  const sourceActivity = [{
    id: "progressive-call", timestamp: evidence.session.startedAt, actor: "Primary agent", tool: "Read",
    workKind: "read", detail: "Safe synthetic activity", status: null, durationMs: null, requestId: null, agentId: "primary",
  }];
  const trace = createPipelineTraceRecorder({ enabled: true });
  const durableHistoryStore = new SessionHistoryStore();
  let failNextActivityContribution = false;
  const historyStore = {
    publishActivityContribution(...args) {
      if (failNextActivityContribution) { failNextActivityContribution = false; return Promise.reject(new Error("synthetic write failure")); }
      return durableHistoryStore.publishActivityContribution(...args);
    },
    publishRequestContribution: (...args) => durableHistoryStore.publishRequestContribution(...args),
    publish: (...args) => durableHistoryStore.publish(...args), publishOutcome: (...args) => durableHistoryStore.publishOutcome(...args),
    hasCommitted: (...args) => durableHistoryStore.hasCommitted(...args), activityFence: (...args) => durableHistoryStore.activityFence(...args),
    read: (...args) => durableHistoryStore.read(...args), subscribeRevisionEvents: (...args) => durableHistoryStore.subscribeRevisionEvents(...args),
  };
  const provider = {
    id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } },
    async readSessionHistory() { historyReads += 1; await historyGate; return { complete: true, requests: [], activity: sourceActivity }; },
  };
  const repositoryInventory = {
    ready: Promise.resolve(), async reconcile() {}, startPluginObservation() {}, async stopPluginObservation() {},
    subscribe() { return () => {}; }, readRepositories() { return null; },
    async associateSession() { return {}; },
    readRevision() { return null; }, capture() { return null; }, refreshPluginSetup() { return null; },
    readPluginSetup() { return null; }, preparePluginAction() { return null; },
  };
  const registry = {
    providers: [provider], defaultProvider: provider, providerForSessionId: () => provider,
    async resolveCapabilities() { enteredDerivation(); await derivationGate; return provider.capabilities; }, async readUsageLimits() { return createEmptyUsageLimits(); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; }, unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      observerPublisher = publisher;
      publisher.publishCatalog("codex", [{ localId: evidence.localId, title: evidence.session.title, project: evidence.session.project,
        updatedAt: evidence.session.updatedAt, isLive: true, needsInput: false, activityStatus: "working" }]);
      publisher.publishHistoryContribution("codex", evidence.localId, { epoch: 1, sequence: 1, activity: sourceActivity });
      publisher.publishSession("codex", evidence.localId, evidence);
      return { async hydrate() { return true; }, async stop() {} };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry, checkpointStore: false, historyStore, repositoryInventory,
    observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0),
    pipelineTrace: trace,
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(async () => { releaseDerivation(); releaseHistory(); await runtime.stopObservation(); });
  await runtime.startObservation();
  await Promise.race([enteredGate, pause(250).then(() => { throw new Error("session derivation did not begin"); })]);
  let activityPage;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    activityPage = await runtime.serveSessionHistory(`codex:${evidence.localId}`, { kind: "activity", limit: "8" });
    if (activityPage.status === "ready") break;
    await pause(2);
  }
  assert.equal(activityPage.status, "ready");
  assert.equal(activityPage.items[0].id, "progressive-call");
  assert.equal(runtime.serveCatalog().status, "ready", "catalog-native status publishes while detailed session derivation is held");
  assert.equal(runtime.serveCatalog().snapshot.value.sessions[0].activityStatus, "working");
  assert.equal((await runtime.serveSessionHistory(`codex:${evidence.localId}`, { kind: "requests" })).status, "loading");
  assert.equal(runtime.serveSession(`codex:${evidence.localId}`).status, "loading");
  assert.equal(historyReads, 0, "full history replay waits for the held session commit");
  failNextActivityContribution = true;
  observerPublisher.publishHistoryContribution("codex", evidence.localId, { epoch: 1, sequence: 2, activity: [{ ...sourceActivity[0], id: "progressive-retry" }] });
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if ((await runtime.serveSessionHistory(`codex:${evidence.localId}`, { kind: "activity" })).items.some((item) => item.id === "progressive-retry")) break;
    await pause(2);
  }
  assert.equal((await runtime.serveSessionHistory(`codex:${evidence.localId}`, { kind: "activity" })).items.some((item) => item.id === "progressive-retry"), true, "a failed contribution retries without another source append");
  releaseDerivation();
  for (let attempt = 0; attempt < 50 && historyReads !== 1; attempt += 1) await pause(2);
  assert.equal(historyReads, 1, "the first complete replay is now held");
  const lateActivity = { ...sourceActivity[0], id: "progressive-late" };
  sourceActivity.push(lateActivity);
  observerPublisher.publishHistoryContribution("codex", evidence.localId, { epoch: 1, sequence: 3, activity: [lateActivity] });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await runtime.serveSessionHistory(`codex:${evidence.localId}`, { kind: "activity" })).items.some((item) => item.id === "progressive-late")) break;
    await pause(2);
  }
  const laterEvidence = JSON.parse(JSON.stringify(evidence));
  laterEvidence.session.title = "Same-timestamp semantic update";
  observerPublisher.publishSession("codex", evidence.localId, laterEvidence);
  releaseHistory();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await runtime.serveSessionHistory(`codex:${evidence.localId}`, { kind: "requests" })).status === "ready") break;
    await pause(2);
  }
  for (let attempt = 0; attempt < 80 && historyReads < 2; attempt += 1) await pause(2);
  assert.ok(historyReads >= 2, "a session append during an in-flight replay schedules one follow-up");
  assert.equal((await runtime.serveSessionHistory(`codex:${evidence.localId}`, { kind: "activity" })).items.some((item) => item.id === "progressive-late"), true);
  trace.deactivate();
  const names = trace.snapshot().traceEvents.filter((event) => event.ph === "X").map((event) => event.name);
  assert.ok(names.includes("history_contribution"));
  assert.ok(names.includes("history_read"));
  assert.ok(names.includes("history_publish"));
});

test("stopping cancels contribution retries and prevents a dirty replay follow-up", async (context) => {
  let releaseHistory;
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  let historyReads = 0;
  let contributionAttempts = 0;
  let observerPublisher;
  const sourceActivity = [{
    id: "stopped-call", timestamp: evidence.session.startedAt, actor: "Primary agent", tool: "Read",
    workKind: "read", detail: "Safe synthetic activity", status: null, durationMs: null, requestId: null, agentId: "primary",
  }];
  const durableHistoryStore = new SessionHistoryStore();
  const historyStore = {
    publishActivityContribution() { contributionAttempts += 1; return Promise.reject(new Error("synthetic write failure")); },
    publishRequestContribution: (...args) => durableHistoryStore.publishRequestContribution(...args),
    publish: (...args) => durableHistoryStore.publish(...args), publishOutcome: (...args) => durableHistoryStore.publishOutcome(...args),
    hasCommitted: (...args) => durableHistoryStore.hasCommitted(...args), activityFence: (...args) => durableHistoryStore.activityFence(...args),
    read: (...args) => durableHistoryStore.read(...args), subscribeRevisionEvents: (...args) => durableHistoryStore.subscribeRevisionEvents(...args),
  };
  const provider = {
    id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } },
    async readSessionHistory() { historyReads += 1; await historyGate; return { complete: true, requests: [], activity: sourceActivity }; },
  };
  const repositoryInventory = {
    ready: Promise.resolve(), async reconcile() {}, startPluginObservation() {}, async stopPluginObservation() {},
    subscribe() { return () => {}; }, readRepositories() { return null; }, async associateSession() { return {}; },
    readRevision() { return null; }, capture() { return null; }, refreshPluginSetup() { return null; },
    readPluginSetup() { return null; }, preparePluginAction() { return null; },
  };
  const registry = {
    providers: [provider], defaultProvider: provider, providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; }, async readUsageLimits() { return createEmptyUsageLimits(); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; }, unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      observerPublisher = publisher;
      publisher.publishCatalog("codex", [{ localId: evidence.localId, title: evidence.session.title, project: evidence.session.project,
        updatedAt: evidence.session.updatedAt, isLive: true, needsInput: false, activityStatus: "working" }]);
      publisher.publishHistoryContribution("codex", evidence.localId, { epoch: 1, sequence: 1, activity: sourceActivity });
      publisher.publishSession("codex", evidence.localId, evidence);
      return { async hydrate() { return true; }, async stop() {} };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry, checkpointStore: false, historyStore, repositoryInventory,
    observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(async () => { releaseHistory(); await runtime.stopObservation(); });
  await runtime.startObservation();
  for (let attempt = 0; attempt < 50 && historyReads !== 1; attempt += 1) await pause(2);
  assert.equal(historyReads, 1);
  assert.equal(contributionAttempts, 1);
  const laterEvidence = JSON.parse(JSON.stringify(evidence));
  laterEvidence.session.updatedAt = "2026-09-10T13:00:00.000Z";
  observerPublisher.publishSession("codex", evidence.localId, laterEvidence);
  await pause(20);
  await runtime.stopObservation();
  releaseHistory();
  await pause(150);
  assert.equal(contributionAttempts, 1, "a stopped runtime never executes its queued contribution retry");
  assert.equal(historyReads, 1, "a stopped runtime never starts its dirty replay follow-up");
});
