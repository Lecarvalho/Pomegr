import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMonitorRuntime } from "../monitor/server.mjs";
import { SessionHistoryStore } from "../monitor/session-history-store.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../shared/monitor-state.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8"));

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for selected history");
}

function evidence(localId, updatedAt) {
  const value = structuredClone(fixture);
  value.localId = localId;
  value.session.title = localId;
  value.session.updatedAt = updatedAt;
  value.historical = true;
  return value;
}

test("selecting recorded history bypasses an occupied maintenance replay lane", async (context) => {
  const first = evidence("first", "2026-09-10T10:00:00.000Z");
  const selected = evidence("selected", "2026-09-10T11:00:00.000Z");
  const maintenanceGate = deferred();
  const historyStarts = [];
  const provider = {
    id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } },
    async readSessionHistory(localSessionId) {
      historyStarts.push(localSessionId);
      if (localSessionId === "first") await maintenanceGate.promise;
      return { complete: true, requests: [], activity: [] };
    },
  };
  const registry = {
    providers: [provider], defaultProvider: provider, providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; }, async readUsageLimits() { return createEmptyUsageLimits(); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; }, unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      publisher.publishCatalog("codex", [first, selected].map((item) => ({
        localId: item.localId, title: item.session.title, project: item.session.project,
        updatedAt: item.session.updatedAt, isLive: false, needsInput: false, activityStatus: "unknown",
      })));
      publisher.publishSession("codex", first.localId, first);
      publisher.publishSession("codex", selected.localId, selected);
      return { async hydrate() { return true; }, async stop() {} };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry, checkpointStore: false, historyStore: new SessionHistoryStore(),
    observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(async () => { maintenanceGate.resolve(); await runtime.stopObservation(); });
  await runtime.startObservation();
  await waitFor(() => historyStarts[0] === "first" && runtime.observationDiagnostics().historyRefresh.pending >= 1);

  assert.equal(runtime.serveSession("codex:selected").status, "ready");
  await waitFor(() => historyStarts.includes("selected"));
  await waitFor(async () => (await runtime.serveSessionHistory("codex:selected", { kind: "requests" })).status === "ready");
  assert.deepEqual(historyStarts, ["first", "selected"]);

  for (let poll = 0; poll < 8; poll += 1) runtime.serveSession("codex:selected");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyStarts.filter((id) => id === "selected").length, 1, "normal state polls do not replay valid history");

  maintenanceGate.resolve();
  await waitFor(async () => (await runtime.serveSessionHistory("codex:first", { kind: "requests" })).status === "ready");
  assert.equal((await runtime.serveSessionHistory("codex:selected", { kind: "requests" })).status, "loading");
  runtime.serveSession("codex:selected");
  await waitFor(() => historyStarts.filter((id) => id === "selected").length === 2);
});

test("an incomplete stable history source does not spin or replay on every state poll", async (context) => {
  const recorded = evidence("incomplete", "2026-09-10T12:00:00.000Z");
  let historyReads = 0;
  const provider = {
    id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(),
    homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } },
    async readSessionHistory() { historyReads += 1; return { complete: false, requests: [], activity: [] }; },
  };
  const registry = {
    providers: [provider], defaultProvider: provider, providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; }, async readUsageLimits() { return createEmptyUsageLimits(); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; }, unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      publisher.publishCatalog("codex", [{ localId: recorded.localId, title: recorded.session.title,
        project: recorded.session.project, updatedAt: recorded.session.updatedAt, isLive: false,
        needsInput: false, activityStatus: "unknown" }]);
      publisher.publishSession("codex", recorded.localId, recorded);
      return { async hydrate() { return true; }, async stop() {} };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry, checkpointStore: false, historyStore: new SessionHistoryStore(),
    observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(() => runtime.stopObservation());
  await runtime.startObservation();
  await waitFor(() => historyReads === 1 && runtime.observationDiagnostics().historyRefresh.active === 0);
  for (let poll = 0; poll < 8; poll += 1) runtime.serveSession("codex:incomplete");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyReads, 1);
  assert.equal(runtime.observationDiagnostics().historyRefresh.pending, 0);
});
