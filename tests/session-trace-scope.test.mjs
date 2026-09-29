import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { createMonitorRuntime } from "../monitor/server.mjs";
import { createPipelineTraceRecorder } from "../monitor/pipeline-trace.mjs";
import { createNormalizedPollingObserver } from "../monitor/providers/normalized-polling-observer.mjs";
import { SessionHistoryStore } from "../monitor/session-history-store.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../shared/monitor-state.mjs";

const evidence = JSON.parse(await readFile(new URL("./fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8"));
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("Timed out waiting for observer"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("normalized observer scopes hydration flow, queue, and acquisition spans to its owner", async (context) => {
  const controller = new AbortController();
  context.after(() => controller.abort());
  const calls = { flows: [], begins: [], durations: [], finishes: [] };
  let flowId = 0;
  const trace = {
    createFlow(options) { const flow = { id: ++flowId }; calls.flows.push({ flow, options }); return flow; },
    begin(options) { calls.begins.push(options); return {}; },
    end() {},
    recordDuration(options) { calls.durations.push(options); },
    finishFlow(flow, options) { calls.finishes.push({ flow, options }); },
  };
  const observer = createNormalizedPollingObserver({
    async list() { listCalls += 1; return listCalls === 1 ? [] : listed; },
    async ingest() { return { session: { id: "normalized" } }; },
    intervalMs: 60_000,
    monotonicNow: () => 20,
    yieldControl: async () => {},
  });
  const scope = Object.freeze({});
  let listCalls = 0;
  const listed = [{ localId: "local-a" }];
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal, {
    trace,
    traceScopeForLocalId: (localId) => localId === "local-a" ? scope : null,
  });
  await waitFor(() => observer.diagnostics().reconciliationRuns === 1);
  await observer.refresh({ sessionIds: ["local-a"], sourceEventAt: 0 });
  await waitFor(() => calls.finishes.length === 1);

  assert.equal(calls.flows[0].options.scope, scope);
  assert.ok(calls.begins.some((entry) => entry.flow === calls.flows[0].flow
    && entry.scope === scope && entry.stage === "acquisition_normalization"));
  assert.ok(calls.durations.some((entry) => entry.stage === "source_queue" && entry.scope === scope));
  assert.equal(calls.finishes[0].flow, calls.flows[0].flow);
  assert.equal(calls.finishes[0].options.outcome, "completed");
});

test("runtime scopes owned session spans while shared catalog work stays unscoped", async (context) => {
  const otherLocalId = `${evidence.localId}-other`;
  const otherEvidence = { ...evidence, localId: otherLocalId, session: { ...evidence.session, title: otherLocalId } };
  const trace = createPipelineTraceRecorder({ enabled: true });
  const ownedScope = trace.createScope();
  const otherScope = trace.createScope();
  const scopes = new Map([
    [`codex:${evidence.localId}`, ownedScope],
    [`codex:${otherLocalId}`, otherScope],
  ]);
  const historyStore = new SessionHistoryStore();
  const provider = {
    id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } },
    async readSessionHistory() { return { complete: true, requests: [], activity: [] }; },
  };
  const repositoryInventory = {
    ready: Promise.resolve(), async reconcile() {}, startPluginObservation() {}, async stopPluginObservation() {},
    subscribe() { return () => {}; }, readRepositories() { return null; },
    async associateSession() { return {}; }, readRevision() { return null; }, capture() { return null; },
    refreshPluginSetup() { return null; }, readPluginSetup() { return null; }, preparePluginAction() { return null; },
  };
  const registry = {
    providers: [provider], defaultProvider: provider, providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; }, async readUsageLimits() { return createEmptyUsageLimits(); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; }, unavailableMessage: () => "Unavailable",
    async startObservers(publisher, _signal, observerOptions) {
      assert.equal(observerOptions.traceScopeForSession(`codex:${evidence.localId}`), ownedScope);
      assert.equal(observerOptions.traceScopeForSession("codex:unowned"), undefined);
      const catalog = [evidence, otherEvidence].map((entry) => ({
        localId: entry.localId, title: entry.session.title, project: entry.session.project,
        updatedAt: entry.session.updatedAt, isLive: true, needsInput: false, activityStatus: "working",
      }));
      publisher.publishCatalog("codex", catalog);
      for (const entry of [evidence, otherEvidence]) {
        publisher.publishHistoryContribution("codex", entry.localId, { epoch: 1, sequence: 1, activity: [] });
        publisher.publishSession("codex", entry.localId, entry);
      }
      return { async hydrate() { return true; }, async stop() {} };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry, checkpointStore: false, historyStore, repositoryInventory,
    observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0),
    pipelineTrace: trace,
    traceScopeForSession: (sessionId) => scopes.get(sessionId),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(async () => { trace.deactivate(); await runtime.stopObservation(); });
  await runtime.startObservation();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (runtime.serveSession(`codex:${evidence.localId}`).status === "ready"
      && runtime.serveSession(`codex:${otherLocalId}`).status === "ready") break;
    await pause(2);
  }
  assert.equal(trace.snapshot({ scope: ownedScope }).traceEvents.some((event) => event.name === "history_read"), false,
    "session observation does not replay complete history without an Activity or Requests demand");
  await runtime.serveSessionHistory(`codex:${evidence.localId}`, { kind: "activity" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (trace.snapshot({ scope: ownedScope }).traceEvents.some((event) => event.name === "history_publish")) break;
    await pause(2);
  }

  trace.deactivate();
  const selected = trace.snapshot({ scope: ownedScope });
  const other = trace.snapshot({ scope: otherScope });
  const all = trace.snapshot();
  const selectedNames = selected.traceEvents.filter((event) => event.ph === "X").map((event) => event.name);
  const otherNames = other.traceEvents.filter((event) => event.ph === "X").map((event) => event.name);
  assert.ok(selectedNames.includes("history_contribution"));
  assert.ok(selectedNames.includes("history_read"));
  assert.ok(selectedNames.includes("history_publish"));
  assert.ok(selectedNames.includes("session_derivation"));
  assert.ok(otherNames.includes("session_derivation"));
  assert.equal(selectedNames.filter((name) => name === "history_contribution").length, 1);
  assert.equal(otherNames.filter((name) => name === "history_contribution").length, 1);
  assert.ok(selectedNames.filter((name) => name === "session_derivation").length >= 1,
    "the explicit history demand may reproject its selected session");
  assert.ok(otherNames.filter((name) => name === "session_derivation").length >= 1);
  assert.equal(selectedNames.includes("catalog_projection"), true, "shared catalog work remains visible in a scoped export");
  assert.equal(otherNames.includes("catalog_projection"), true, "shared catalog work remains unscoped");
  assert.ok(all.traceEvents.some((event) => event.name === "catalog_projection"));
  assert.doesNotMatch(JSON.stringify({ selected, other, all }), /codex:[^" ]+/);
});
