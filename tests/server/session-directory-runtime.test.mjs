import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMonitorRuntime } from "../../server/server.mjs";
import { openMonitorStore } from "../../server/persistence/monitor-store.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../../shared/monitor-state.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8"));
const wait = async (predicate) => { for (let i = 0; i < 160; i += 1) { if (await predicate()) return; await new Promise((resolve) => setImmediate(resolve)); } throw new Error("timed out"); };
const rows = Array.from({ length: 240 }, (_, index) => ({ localId: `history-${index}`, title: `History ${index}`, project: "Pomegr", createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(), updatedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(), isLive: index === 10, needsInput: false, activityStatus: index === 10 ? "working" : "closed" }));

test("runtime serves paged headers and indexed shell identity without historical hydration", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-directory-runtime-"));
  const database = await openMonitorStore({ directory });
  const monitorStoreRuntime = { async start() {}, async stop() {}, store: () => database, registerContributor() {}, afterCheckpointWrite() {}, serveStorage() { return { snapshot: { value: { readiness: "ready" } } }; } };
  let hydrations = 0; let historyReads = 0; let releaseDiscovery; let releaseHistory;
  const discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  const provider = { id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(), homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } },
    async enumerateSessionHeaders({ onBatch }) { onBatch(rows.slice(0, 100)); await discoveryGate; onBatch(rows.slice(100, 200)); onBatch(rows.slice(200)); return { complete: true }; },
    async readSessionHistory() { historyReads += 1; await historyGate; return { complete: true, requests: [], activity: [] }; },
  };
  const registry = { providers: [provider], defaultProvider: provider, providerForSessionId: () => provider,
    async resolveCapabilities() { return provider.capabilities; }, async readUsageLimits() { return createEmptyUsageLimits(); },
    async enumerateSessionHeaders(providerId, options) { return providerId === "codex" ? provider.enumerateSessionHeaders(options) : { complete: false }; },
    async startObservers(next) { next.publishCatalog("codex", []); return { async hydrate(id) { const localId = id.replace(/^codex:/, ""); hydrations += 1; const evidence = structuredClone(fixture); evidence.localId = localId; evidence.session.title = localId; evidence.historical = true; next.publishSession("codex", localId, evidence); return true; }, async stop() {} }; },
  };
  const runtime = createMonitorRuntime({ providerRegistry: registry, checkpointStore: false, monitorStoreRuntime,
    resourceUsageSampler: { async sample() {}, get() { return null; } }, observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0) });
  t.after(async () => { await runtime.stopObservation(); database.close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.startObservation();
  await wait(() => runtime.serveSessionDirectory({ pageSize: 100 }).coverage.knownCount >= 100);
  const first = runtime.serveSessionDirectory({ pageSize: 100 });
  assert.equal(first.sessions.length, 100); assert.equal(hydrations, 0);
  assert.equal(first.coverage.exactTotal, null, "a blocked provider scan remains partial");
  assert.equal(runtime.serveSession("codex:history-10").status, "loading");
  await wait(() => runtime.serveSession("codex:history-10").status === "ready");
  assert.equal(hydrations, 1, "an indexed selection hydrates while discovery is blocked");
  assert.equal(runtime.serveSessionDirectory({ pageSize: 100 }).counts.live, 1, "detail enrichment preserves current header lifecycle");
  releaseDiscovery();
  await wait(() => runtime.serveSessionDirectory({ pageSize: 100 }).coverage.exactTotal === 240);
  const shell = runtime.serveCatalogShell({ selected: "codex:history-230", pinned: ["codex:history-220"] });
  assert.ok(shell.value.sessions.some((row) => row.id === "codex:history-230"));
  assert.ok(shell.value.sessions.some((row) => row.id === "codex:history-220"));
  assert.equal(hydrations, 1, "shell lookup is index-only");
  assert.equal(runtime.serveSession("codex:history-230").status, "loading");
  await wait(() => runtime.serveSession("codex:history-230").status === "ready");
  assert.equal(hydrations, 2, "only explicit historical detail selections hydrate");
  assert.equal(historyReads, 0, "state polling never replays complete history");
  await Promise.all([
    runtime.serveSessionHistory("codex:history-230", { kind: "activity" }),
    runtime.serveSessionHistory("codex:history-230", { kind: "requests" }),
  ]);
  await wait(() => historyReads === 1);
  releaseHistory();
  await wait(() => runtime.observationDiagnostics().historyRefresh.active === 0);
});

test("runtime retains streamed headers when a provider inventory scan fails", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-directory-partial-"));
  const database = await openMonitorStore({ directory });
  const monitorStoreRuntime = { async start() {}, async stop() {}, store: () => database, registerContributor() {}, afterCheckpointWrite() {}, serveStorage() { return { snapshot: { value: { readiness: "ready" } } }; } };
  const provider = { id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(), homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } },
    async enumerateSessionHeaders({ onBatch }) { onBatch(rows.slice(0, 100)); return { complete: false }; }, async readSessionHistory() { return { complete: true, requests: [], activity: [] }; } };
  const registry = { providers: [provider], defaultProvider: provider, providerForSessionId: () => provider, async resolveCapabilities() { return provider.capabilities; }, async readUsageLimits() { return createEmptyUsageLimits(); },
    async enumerateSessionHeaders(id, options) { return id === "codex" ? provider.enumerateSessionHeaders(options) : { complete: false }; }, async startObservers(publisher) { publisher.publishCatalog("codex", []); return { async hydrate() { return false; }, async stop() {} }; } };
  const runtime = createMonitorRuntime({ providerRegistry: registry, checkpointStore: false, monitorStoreRuntime, resourceUsageSampler: { async sample() {}, get() { return null; } }, observationCommitDelayMs: 0 });
  t.after(async () => { await runtime.stopObservation(); database.close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.startObservation();
  await wait(() => runtime.serveSessionDirectory({ pageSize: 100 }).coverage.knownCount === 100);
  const page = runtime.serveSessionDirectory({ pageSize: 100 });
  assert.equal(page.sessions.length, 100); assert.equal(page.coverage.exactTotal, null);
});
