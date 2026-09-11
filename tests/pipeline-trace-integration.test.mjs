import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPipelineTraceRecorder } from "../monitor/pipeline-trace.mjs";
import { createSessionObservationCoordinator } from "../monitor/session-observation-coordinator.mjs";
import { createNormalizedPollingObserver } from "../monitor/providers/normalized-polling-observer.mjs";
import { runDiagnosticsCapture, validTrace } from "../scripts/diagnostics-capture.mjs";
import { startPipelineTraceSampling } from "../monitor/pipeline-trace-sampling.mjs";
import { startMonitorServer } from "../monitor/server.mjs";
import { createDevelopmentDiagnostics } from "../monitor/dev-diagnostics.mjs";
import { createDevelopmentTraceScopeRegistry } from "../monitor/dev-trace-scopes.mjs";
import { runDiagnosticsSnapshot } from "../scripts/diagnostics-snapshot.mjs";

test("development composition writes continuous logs before observation and without a capture client", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-desktop-trace-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const diagnostics = createDevelopmentDiagnostics({ directory });
  const recorder = diagnostics.recorder;
  let starts = 0;
  const runtime = { startObservation: async () => { starts += 1; }, stopObservation: async () => {}, observationDiagnostics: () => ({}) };
  const handle = await startMonitorServer({
    port: 0,
    pipelineOperationsAtEphemeralPort: true,
    pipelineTrace: recorder,
    requestHandlerFactory: (options) => diagnostics.createRequestHandler(options),
    startupExtension: (start) => diagnostics.start(start),
    runtime,
    providerRegistry: { watchTargets: async () => [] },
  });
  context.after(() => handle.close());
  assert.equal(recorder.isRolling(), true);
  assert.equal(recorder.isActive(), true);
  recorder.recordCounter({ counter: "records", value: 1 });
  const snapshot = await runDiagnosticsSnapshot({ port: handle.port, json: true });
  assert.equal(snapshot.snapshot.version, 1);
  await diagnostics.logWriter.flush();
  const files = await readdir(directory);
  const rows = (await readFile(path.join(directory, files[0]), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].kind, "lifecycle");
  assert.ok(rows.some((row) => row.kind === "counter" && row.counter === "records"));
  assert.ok(rows.some((row) => row.kind === "health"));
  assert.equal(starts, 1, "diagnostic clients never restart or request provider observation");
  assert.equal(recorder.isActive(), true);
});

test("development trace scopes retain known sessions at capacity and expire with a monotonic clock", () => {
  let now = 0;
  let created = 0;
  const registry = createDevelopmentTraceScopeRegistry({
    createScope: () => Object.freeze({ id: ++created }),
    now: () => now,
    maxEntries: 2,
    ttlMs: 1_000,
  });
  const first = registry.scopeForSession("claude:first");
  registry.scopeForSession("claude:second");
  assert.equal(registry.scopeForSession("claude:first"), first, "a capacity read must not evict its existing association");
  assert.equal(registry.resolveSessionScope("claude:missing"), registry.resolveSessionScope("invalid"));
  now = 1_001;
  assert.notEqual(registry.scopeForSession("claude:first"), first, "expired associations receive a fresh opaque scope");
});

test("development diagnostics isolate log initialization failures from monitor observation", async (context) => {
  const warnings = [];
  let observationStarts = 0;
  let samplingStarts = 0;
  let samplingCloses = 0;
  const diagnostics = createDevelopmentDiagnostics({
    createWriter: () => { throw new Error("PRIVATE_LOG_FAILURE"); },
    startSampling: () => ({ close() { samplingCloses += 1; }, marker: ++samplingStarts }),
    logger: { warn: (message) => warnings.push(message) },
  });
  const runtime = {
    async startObservation() { observationStarts += 1; },
    async stopObservation() {},
    observationDiagnostics() { return {}; },
  };
  const handle = await startMonitorServer({
    port: 0,
    pipelineTrace: diagnostics.recorder,
    requestHandlerFactory: (options) => diagnostics.createRequestHandler(options),
    startupExtension: (start) => diagnostics.start(start),
    runtime,
    providerRegistry: { async watchTargets() { return []; } },
  });
  context.after(() => handle.close());
  assert.equal(observationStarts, 1);
  assert.equal(samplingStarts, 1);
  assert.deepEqual(warnings, ["[pomegr] Local diagnostic log unavailable."]);
  await handle.close();
  assert.equal(samplingCloses, 1, "initialized diagnostics close once when the monitor closes");
});

test("resource sampling is passive, capture-scoped, and survives diagnostic errors", () => {
  let active = false; let reads = 0; let stops = 0; let cpu = 10;
  const counters = [];
  const sampling = startPipelineTraceSampling({
    recorder: { isActive: () => active, recordCounter: (counter) => counters.push(counter) },
    cpuUsage: () => { reads += 1; cpu += 5; return { user: cpu, system: 2 }; },
    memoryUsage: () => ({ rss: 1024 }),
    histogram: { max: 2e6, reset() {}, enable() {}, disable() { stops += 1; } },
    diagnostics: () => ({ coordinator: { observers: { synthetic: { pendingHydrations: 3, activeHydrations: 1, hydrationConcurrency: 2, oldestPendingMs: 5 } } } }),
    schedule: () => 1, cancel() {},
  });
  sampling.sample(); assert.equal(reads, 0);
  active = true; sampling.sample(); sampling.sample();
  assert.deepEqual(counters.find((entry) => entry.counter === "cpu"), { counter: "cpu", value: 5 });
  assert.deepEqual(counters.find((entry) => entry.counter === "oldest_pending_ms"), { counter: "oldest_pending_ms", value: 5 });
  active = false; sampling.sample(); assert.equal(reads, 2); assert.equal(stops, 1);
  sampling.close();
});

test("direct capture callers cannot bypass duration and local path limits", async () => {
  for (const durationSeconds of [NaN, -1, 0, 601, Infinity]) {
    await assert.rejects(() => runDiagnosticsCapture({ port: 4317, durationSeconds, descriptorPath: "unused", outputPath: "unused" }), /duration/i);
  }
  await assert.rejects(() => runDiagnosticsCapture({ port: 4317, durationSeconds: 1, descriptorPath: "unused", outputPath: "\\\\remote\\share\\trace.json" }), /CAPTURE_PATH_INVALID/);
});

test("capture export rejects private values at every nested transport boundary", () => {
  let now = 100;
  const recorder = createPipelineTraceRecorder({ enabled: true, now: () => now });
  now = 101;
  recorder.recordDuration({ stage: "catalog_discovery", domain: "acquisition", durationMs: 0.125 });
  recorder.deactivate();
  const valid = recorder.snapshot();
  assert.equal(valid.traceEvents[0].dur, 125);
  assert.equal(validTrace(valid), true);
  for (const inject of [
    (value) => { value.private = "PRIVATE_SENTINEL"; },
    (value) => { value.metadata.capture.private = "PRIVATE_SENTINEL"; },
    (value) => { value.metadata.coverage.private = "PRIVATE_SENTINEL"; },
    (value) => { value.traceEvents[0].private = "PRIVATE_SENTINEL"; },
    (value) => { value.traceEvents[0].id = "PRIVATE_SENTINEL"; },
    (value) => { value.traceEvents[0].args.revision = "PRIVATE_SENTINEL"; },
  ]) {
    const value = structuredClone(valid);
    inject(value);
    assert.equal(validTrace(value), false);
  }
});

test("coordinator records a causal derivation/store attempt without candidate identity", async () => {
  const trace = createPipelineTraceRecorder({ enabled: true });
  const tasks = [];
  let publisher;
  let committed = false;
  const coordinator = createSessionObservationCoordinator({
    pipelineTrace: trace,
    registry: { providers: [{ id: "codex", source: "Codex" }], async startObservers(value, signal, diagnostics) {
      publisher = value;
      assert.equal(diagnostics.trace, trace);
      return { async stop() {} };
    } },
    schedule(task) { tasks.push(task); return task; },
    cancel(task) { const index = tasks.indexOf(task); if (index >= 0) tasks.splice(index, 1); },
    store: { getByQualifiedId: () => null, publish(candidate) {
      committed = true;
      return { accepted: true, snapshot: { ...candidate, qualifiedId: "codex:PRIVATE_SESSION", revision: 1 } };
    } },
    deriveSession: async () => ({ readiness: {}, publicState: {} }),
  });
  await coordinator.start();
  publisher.publishSession("codex", "PRIVATE_SESSION", { session: { title: "PRIVATE_TITLE" } });
  tasks.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(committed, true);
  trace.deactivate();
  const result = trace.snapshot();
  const slices = result.traceEvents.filter((event) => event.ph === "X");
  assert.ok(slices.some((event) => event.name === "session_derivation" && event.args.outcome === "completed"));
  assert.ok(slices.some((event) => event.name === "normalized_store_commit" && event.args.outcome === "accepted"));
  assert.ok(slices.some((event) => event.name === "candidate_to_commit"));
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  await coordinator.stop();
});

test("an acquisition exception records a failed stage while retaining the ordinary failure contract", async () => {
  const trace = createPipelineTraceRecorder({ enabled: true });
  const controller = new AbortController();
  const observer = createNormalizedPollingObserver({
    list: async () => [],
    read: async () => { throw new Error("PRIVATE_TRANSCRIPT"); },
    yieldControl: async () => {},
  });
  await observer.start({ publishCatalog() {}, publishSession() { assert.fail("failed acquisition must not publish"); }, invalidateSession() {} }, controller.signal, { trace });
  assert.equal(await observer.hydrate("PRIVATE_SESSION"), false);
  assert.equal(observer.diagnostics().acquisitionFailures, 1);
  observer.stop();
  trace.deactivate();
  const result = trace.snapshot();
  assert.ok(result.traceEvents.some((event) => event.name === "acquisition_normalization" && event.args.outcome === "failed"));
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});
