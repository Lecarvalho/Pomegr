import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createMonitorRuntime, createMonitorServer } from "../monitor/server.mjs";
import { createObservationStartupRepository } from "../monitor/observation-startup-repository.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../shared/monitor-state.mjs";
import { SessionHistoryStore } from "../monitor/session-history-store.mjs";

const evidence = JSON.parse(await readFile(new URL("./fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8"));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

function delayedRepositoryInventory(ready) {
  return {
    ready,
    async reconcile() {},
    startPluginObservation() {},
    async stopPluginObservation() {},
    async associateSession() { return null; },
    async resolveRepository() { return null; },
    subscribe() { return () => {}; },
    readRepositories() { return null; },
    readRevision() { return null; },
    capture() { return null; },
    refreshPluginSetup() { return null; },
    readPluginSetup() { return null; },
    preparePluginAction() { return null; },
  };
}

test("repository sidecar loads serialize across stopped startup lifetimes", { timeout: 5_000 }, async () => {
  let releaseFirst;
  const firstLoad = new Promise((resolve) => { releaseFirst = resolve; });
  let loads = 0;
  const lifecycle = createObservationStartupRepository({
    repositoryInventory: { ready: Promise.resolve(), async reconcile() {} },
    repositorySnapshotRecorder: { async load() { loads += 1; return loads === 1 ? firstLoad : undefined; } },
    isActive: () => true, catalog: () => [], onRecorded() {},
  });
  lifecycle.start();
  await waitFor(() => loads === 1, "first sidecar load should start");
  lifecycle.stop();
  lifecycle.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1, "second startup waits for the prior sidecar load");
  releaseFirst();
  await waitFor(() => loads === 2, "second sidecar load should follow the first");
  lifecycle.stop();
});

test("live observation startup does not wait for repository inventory or sidecars", { timeout: 5_000 }, async (context) => {
  let releaseInventory;
  const inventoryReady = new Promise((resolve) => { releaseInventory = resolve; });
  let releaseSidecars;
  const sidecarsReady = new Promise((resolve) => { releaseSidecars = resolve; });
  let checkpointLoads = 0;
  let observerStarts = 0;
  let pluginStarts = 0;
  const provider = { id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(), homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } } };
  const registry = {
    providers: [provider], defaultProvider: provider, providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      observerStarts += 1;
      publisher.publishCatalog("codex", [{ localId: evidence.localId, title: evidence.session.title, project: evidence.session.project,
        updatedAt: evidence.session.updatedAt, isLive: true, needsInput: false, activityStatus: "working" }]);
      publisher.publishSession("codex", evidence.localId, evidence);
      return { async stop() {} };
    },
  };
  const repositoryInventory = delayedRepositoryInventory(inventoryReady);
  repositoryInventory.startPluginObservation = () => { pluginStarts += 1; };
  const runtime = createMonitorRuntime({
    providerRegistry: registry, repositoryInventory, monitorStore: false,
    checkpointStore: {
      loadRepositorySnapshots: () => sidecarsReady,
      async writeRepositorySnapshot() {},
      async load() { checkpointLoads += 1; return { records: [] }; },
      async write() {},
    },
    historyStore: new SessionHistoryStore(),
    observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(async () => runtime.stopObservation());

  await runtime.startObservation();
  await waitFor(() => runtime.serveSession(`codex:${evidence.localId}`).status === "ready", "live evidence should commit before inventory readiness");
  assert.equal(observerStarts, 1);
  assert.equal(pluginStarts, 0);
  assert.equal(checkpointLoads, 0, "live publication precedes sidecar-dependent checkpoint projection");

  releaseInventory();
  await waitFor(() => pluginStarts === 1, "plugin observation should begin after repository readiness");
  assert.equal(checkpointLoads, 0);
  releaseSidecars([]);
  await waitFor(() => checkpointLoads === 1, "checkpoint projection begins after sidecars are ready");
});

test("stopping suppresses a delayed repository plugin startup", async () => {
  let releaseInventory;
  const inventoryReady = new Promise((resolve) => { releaseInventory = resolve; });
  let pluginStarts = 0;
  const provider = { id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(), homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } } };
  const repositoryInventory = delayedRepositoryInventory(inventoryReady);
  repositoryInventory.startPluginObservation = () => { pluginStarts += 1; };
  const runtime = createMonitorRuntime({
    providerRegistry: {
      providers: [provider], defaultProvider: provider, providerForSessionId: () => provider,
      async resolveCapabilities() { return provider.capabilities; },
      async readUsageLimits() { return createEmptyUsageLimits(); },
      async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
      unavailableMessage: () => "Unavailable",
      async startObservers() { return { async stop() {} }; },
    },
    repositoryInventory, checkpointStore: false,
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });

  await runtime.startObservation();
  await runtime.stopObservation();
  releaseInventory();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pluginStarts, 0);
});

test("concurrent state GETs consume one committed response without provider transcript reads", async (context) => {
  let compatibilityReads = 0;
  let historyReads = 0;
  let stopped = false;
  let resourceState = null;
  const resourceSamples = [];
  const provider = {
    id: "codex",
    source: "Codex",
    capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: true, modelSelection: false, usageLimitActivity: { enabled: false } },
    async readSessionHistory() { historyReads += 1; return { complete: true, requests: [], activity: [] }; },
  };
  const registry = {
    providers: [provider],
    defaultProvider: provider,
    providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readSession() { compatibilityReads += 1; throw new Error("raw request path read"); },
    async inspectSessions() {
      return {
        sessions: [],
        resourceTargets: [{ sessionId: `codex:${evidence.localId}`, status: "unavailable" }],
      };
    },
    unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      publisher.publishCatalog("codex", [{
        localId: evidence.localId,
        title: evidence.session.title,
        project: evidence.session.project,
        updatedAt: evidence.session.updatedAt,
        isLive: true,
        needsInput: false,
        activityStatus: "working",
      }]);
      publisher.publishSession("codex", evidence.localId, evidence);
      return { async hydrate() { return true; }, async stop() { stopped = true; } };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry,
    checkpointStore: false,
    historyStore: new SessionHistoryStore(),
    observationCommitDelayMs: 0,
    scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: {
      async sample(targets) {
        resourceSamples.push(targets);
        resourceState = {
          status: "unavailable",
          reason: "missing_owner",
          current: null,
          samples: [],
        };
      },
      get() { return resourceState; },
    },
  });
  await runtime.startObservation();
  context.after(async () => runtime.stopObservation());
  for (let attempt = 0; attempt < 50 && runtime.serveSession(`codex:${evidence.localId}`).status !== "ready"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (let attempt = 0; attempt < 50 && runtime.serveSession(`codex:${evidence.localId}`).snapshot?.readiness?.resources !== "unavailable"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(runtime.serveSession(`codex:${evidence.localId}`).status, "ready");
  assert.equal(await runtime.sessionFeed(), runtime.serveCatalog().snapshot.value);
  assert.equal(runtime.serveSession(`codex:${evidence.localId}`).snapshot.readiness.resources, "unavailable");
  assert.deepEqual(resourceSamples, [[{ sessionId: `codex:${evidence.localId}`, status: "unavailable" }]]);

  const server = createMonitorServer({ runtime });
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  for (let attempt = 0; attempt < 50 && !historyReads; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(historyReads > 0, "history acquisition belongs to background observation");
  let committedHistory;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    committedHistory = await runtime.serveSessionHistory(`codex:${evidence.localId}`, { kind: "activity", limit: "8" });
    if (committedHistory.status === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(committedHistory.status, "ready", "the background replay commits before GET isolation is measured");
  const beforeHistoryGets = historyReads;
  const historyPages = await Promise.all(Array.from({ length: 4 }, () => fetch(`${origin}/api/session-history?sessionId=codex%3A${evidence.localId}&kind=activity&limit=8`)));
  assert.ok(historyPages.every((response) => response.status === 200));
  for (const response of historyPages) assert.equal((await response.json()).kind, "activity");
  const requestPages = await Promise.all(Array.from({ length: 4 }, () => fetch(`${origin}/api/session-history?sessionId=codex%3A${evidence.localId}&kind=requests&limit=60`)));
  for (const response of requestPages) {
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.kind, "requests");
    assert.deepEqual(page.overview, []);
  }
  assert.equal(historyReads, beforeHistoryGets, "history GETs never invoke provider history acquisition");
  const preloaded = await fetch(`${origin}/api/session-history?sessionId=codex%3A${evidence.localId}&kind=requests&overview=0`);
  assert.equal(preloaded.status, 200);
  assert.equal(Object.hasOwn(await preloaded.json(), "overview"), false);
  assert.equal(historyReads, beforeHistoryGets, "preload GETs never invoke provider history acquisition");
  for (const overview of ["", "2", "false", "0&overview=1"]) {
    assert.equal((await fetch(`${origin}/api/session-history?sessionId=codex%3A${evidence.localId}&kind=requests&overview=${overview}`)).status, 400);
  }
  assert.equal((await fetch(`${origin}/api/session-history?sessionId=codex%3A${evidence.localId}&offset=..%2Fprivate`)).status, 400);
  const eventResponse = await fetch(`${origin}/api/events`);
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get("content-type") || "", /^text\/event-stream/u);
  const eventReader = eventResponse.body.getReader();
  try {
    const initialEvent = new TextDecoder().decode((await eventReader.read()).value);
    assert.match(initialEvent, /event: catalog\ndata: \{"domain":"sessions","revision":\d+\}\n\n/u);
    assert.match(initialEvent, /event: repositories\ndata: \{"domain":"repositories","revision":\d+\}\n\n/u);
    assert.doesNotMatch(initialEvent, /prompt|response|path|credential/iu);
    const publications = initialEvent.split("\n\n").filter(Boolean).map((event) => JSON.parse(event.split("\ndata: ")[1]));
    const scoped = publications.filter((event) => event.sessionId !== undefined);
    assert.ok(scoped.some((event) => event.domain === "session-summary"));
    assert.ok(scoped.some((event) => event.domain === "history"));
    for (const event of scoped) {
      assert.equal(event.sessionId, `codex:${evidence.localId}`);
      assert.deepEqual(Object.keys(event).sort(), (event.domain === "history"
        ? ["domain", "sessionId", "revision", "total"] : ["domain", "sessionId", "revision"]).sort());
      assert.ok(Number.isSafeInteger(event.revision) && event.revision > 0);
      if (event.domain === "history") assert.ok(Number.isSafeInteger(event.total) && event.total >= 0);
    }
  } finally {
    await eventReader.cancel().catch(() => {});
  }
  const responses = await Promise.all(Array.from({ length: 8 }, () => (
    fetch(`${origin}/api/state?sessionId=codex%3Acodex-fixture-parent`)
  )));
  assert.equal(responses.every((response) => response.status === 200), true);
  const revision = responses[0].headers.get("x-pomegr-revision");
  const bodies = await Promise.all(responses.map((response) => response.text()));
  assert.equal(new Set(bodies).size, 1);
  assert.equal(compatibilityReads, 0);
  assert.equal(JSON.parse(bodies[0]).metrics.tokens.reportEvidence.version, 1);
  assert.equal(JSON.parse(bodies[0]).metrics.tokens.reportEvidence.cache.status, "unavailable");
  assert.deepEqual(JSON.parse(bodies[0]).metrics.resources, {
    status: "unavailable",
    reason: "missing_owner",
    current: null,
    samples: [],
  });
  assert.doesNotMatch(bodies[0], /raw request path read|prompt|response|credential/i);

  const unchanged = await fetch(`${origin}/api/state?sessionId=codex%3Acodex-fixture-parent&revision=${revision}`);
  assert.equal(unchanged.status, 204);
  await runtime.stopObservation();
  assert.equal(stopped, true);
});

test("a committed registry-only catalog row serves cached unavailable detail without hydration", async (context) => {
  let transcriptReads = 0;
  let hydrations = 0;
  let stopped = false;
  const localId = "registry-only";
  const provider = {
    id: "claude",
    source: "Claude Code",
    capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } },
  };
  const registry = {
    providers: [provider],
    defaultProvider: provider,
    providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readSession() { transcriptReads += 1; return null; },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      publisher.publishCatalog("claude", [{
        localId,
        title: "Claude session",
        project: "Unknown project",
        updatedAt: "2026-09-02T12:00:00.000Z",
        isLive: true,
        needsInput: false,
        activityStatus: "open",
        detailReadiness: "unavailable",
      }]);
      return { async hydrate() { hydrations += 1; return false; }, async stop() { stopped = true; } };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry,
    checkpointStore: false,
    observationCommitDelayMs: 0,
    scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  await runtime.startObservation();
  context.after(async () => runtime.stopObservation());
  for (let attempt = 0; attempt < 50 && runtime.serveSession(`claude:${localId}`).status !== "unavailable"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const catalog = runtime.serveCatalog().snapshot.value.sessions;
  assert.deepEqual(catalog.map(({ id, summaryReadiness, agentCount, activeAgentCount, latestContextTotal }) => ({
    id, summaryReadiness, agentCount, activeAgentCount, latestContextTotal,
  })), [{
    id: `claude:${localId}`, summaryReadiness: "unavailable", agentCount: null, activeAgentCount: null, latestContextTotal: null,
  }]);
  assert.equal(Object.hasOwn(catalog[0], "detailReadiness"), false);
  // The catalog is now committed; subsequent cache-only detail reads must not
  // enqueue a source acquisition for this confirmed absence.
  hydrations = 0;
  assert.equal(runtime.serveSession(`claude:${localId}`).status, "unavailable");
  assert.equal(hydrations, 0);

  const server = createMonitorServer({ runtime });
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`${origin}/api/state?sessionId=claude%3A${localId}&revision=1`);
  assert.equal(response.status, 200, "catalog-only availability never shares a session-evidence revision");
  assert.equal(response.headers.get("x-pomegr-revision"), null);
  const body = await response.json();
  assert.equal(body.session, null);
  assert.equal(body.view, "live", "an expired Open catalog row is not a historical snapshot");
  assert.deepEqual(body.readiness, {
    core: "unavailable", agentEvidence: "unavailable", contextEvidence: "unavailable",
    activityEvidence: "unavailable", repository: "unavailable", resources: "unavailable", usageLimits: "unavailable",
  });
  assert.deepEqual(body.catalogIdentity, catalog[0]);
  assert.equal(Object.hasOwn(body.catalogIdentity, "detailReadiness"), false);
  assert.equal(hydrations, 0);
  assert.equal(transcriptReads, 0);
  await runtime.stopObservation();
  assert.equal(stopped, true);
});

test("a transcript path copy resolves from committed evidence without a session read", async (context) => {
  let sessionReads = 0;
  const pathReads = [];
  const childFile = path.resolve("synthetic-transcripts", "agent-codex-fixture-child.jsonl");
  const committedEvidence = {
    ...evidence,
    agents: evidence.agents.map((agent) => (agent.id === "primary" ? agent : { ...agent, transcriptAvailable: true })),
  };
  const provider = {
    id: "codex",
    source: "Codex",
    capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } },
    async readTranscriptPath(localId, agentId) {
      pathReads.push([localId, agentId]);
      return agentId === "agent-codex-fixture-child" ? childFile : null;
    },
  };
  const registry = {
    providers: [provider],
    defaultProvider: provider,
    providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readSession() { sessionReads += 1; throw new Error("full session read"); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      publisher.publishCatalog("codex", [{
        localId: evidence.localId,
        title: evidence.session.title,
        project: evidence.session.project,
        updatedAt: evidence.session.updatedAt,
        isLive: true,
        needsInput: false,
        activityStatus: "working",
      }]);
      publisher.publishSession("codex", evidence.localId, committedEvidence);
      return { async hydrate() { return true; }, async stop() {} };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry,
    checkpointStore: false,
    historyStore: new SessionHistoryStore(),
    observationCommitDelayMs: 0,
    scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  await runtime.startObservation();
  context.after(async () => runtime.stopObservation());
  for (let attempt = 0; attempt < 50 && runtime.serveSession(`codex:${evidence.localId}`).status !== "ready"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(runtime.serveSession(`codex:${evidence.localId}`).status, "ready");

  const server = createMonitorServer({ runtime });
  const origin = await listen(server);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const query = (agentId) => new URLSearchParams({ sessionId: `codex:${evidence.localId}`, agentId });
  const [child, primary] = await Promise.all([
    fetch(`${origin}/api/transcript-path?${query("agent-codex-fixture-child")}`),
    fetch(`${origin}/api/transcript-path?${query("primary")}`),
  ]);
  assert.deepEqual([child.status, primary.status], [200, 404]);
  assert.deepEqual(await child.json(), { path: childFile });
  assert.deepEqual(pathReads, [[evidence.localId, "agent-codex-fixture-child"]], "only a proven agent reaches the adapter");
  assert.equal(sessionReads, 0, "committed evidence replaces the full session read");
});
