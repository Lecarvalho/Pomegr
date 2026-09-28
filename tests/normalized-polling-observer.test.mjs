import assert from "node:assert/strict";
import test from "node:test";
import { createNormalizedPollingObserver } from "../monitor/providers/normalized-polling-observer.mjs";
import { createPipelineTraceRecorder } from "../monitor/pipeline-trace.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function waitFor(predicate, attempts = 100, detail = () => "") {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for observer state ${detail()}`);
}

test("a queued maintenance hydration starts when selection promotes that same session", async (context) => {
  const releases = new Map([["background-1", deferred()], ["background-2", deferred()]]);
  const started = [];
  let entries = [];
  let eager = false;
  const controller = new AbortController();
  const observer = createNormalizedPollingObserver({
    list: async () => entries,
    shouldEagerHydrate: () => eager,
    prepare: async (entries) => new Map(entries.map((entry) => [entry.localId, entry])),
    ingest: async (localSessionId) => {
      started.push(localSessionId);
      await releases.get(localSessionId).promise;
      return null;
    },
    intervalMs: 60_000,
    interactiveConcurrency: 1,
    backgroundConcurrency: 1,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await waitFor(() => observer.diagnostics().reconciliationRuns === 1);
  entries = [
    { localId: "background-1", detailReadiness: "ready" },
    { localId: "background-2", detailReadiness: "ready" },
  ];
  await observer.refresh({ fresh: true });
  eager = true;

  await observer.refresh({ fresh: true });
  await waitFor(() => started.includes("background-1") && observer.diagnostics().pendingHydrations === 1);
  assert.deepEqual(started, ["background-1"]);

  const selected = observer.hydrate("background-2");
  await waitFor(() => started.includes("background-2"), 100, () => JSON.stringify({ started, diagnostics: observer.diagnostics() }));
  assert.deepEqual(started, ["background-1", "background-2"]);

  releases.get("background-2").resolve();
  await selected;
  releases.get("background-1").resolve();
});

test("a new live session publishes while historical preparation is blocked and retries stay urgent", async (context) => {
  const history = deferred();
  const controller = new AbortController();
  let entries = [{ localId: "history", isLive: false }];
  let historyPreparing = false;
  const attempts = [];
  const published = [];
  const observer = createNormalizedPollingObserver({
    list: async () => entries,
    shouldEagerHydrate: () => true,
    async prepare(batch) {
      if (batch.some((entry) => entry.localId === "history")) {
        historyPreparing = true;
        await history.promise;
      }
      return new Map(batch.map((entry) => [entry.localId, entry]));
    },
    async ingest(id) {
      attempts.push(id);
      return attempts.filter((value) => value === id).length === 1 ? null : {};
    },
    intervalMs: 60_000,
  });
  context.after(() => { controller.abort(); history.resolve(); });
  await observer.start({ publishCatalog() {}, publishSession(id) { published.push(id); }, invalidateSession() {} }, controller.signal);
  await waitFor(() => historyPreparing);
  entries = [...entries, { localId: "live", isLive: true }];
  await observer.refresh();
  await waitFor(() => attempts.includes("live") && observer.diagnostics().activeHydrations === 0);
  assert.deepEqual(published, []);
  await observer.refresh();
  await waitFor(() => published.includes("live"));
  assert.deepEqual(attempts, ["live", "live"], "catalog rediscovery must not demote an incomplete live session behind history");
});

test("cold historical discovery and source bursts preserve capacity for first live publication and selection", async (context) => {
  const blocked = deferred();
  const controller = new AbortController();
  let wake;
  let entries = Array.from({ length: 20 }, (_, index) => ({ localId: `history-${index}`, isLive: false }));
  const started = [];
  const published = [];
  const observer = createNormalizedPollingObserver({
    list: async () => entries,
    shouldEagerHydrate: () => true,
    async ingest(id) {
      started.push(id);
      if (id.startsWith("history-") || id.startsWith("source-")) await blocked.promise;
      return {};
    },
    routeSourceEvent: ({ filename }) => ({ sessionIds: [filename] }),
    watchTargets: ["synthetic"],
    watchSource(_target, _options, callback) { wake = callback; return { close() {} }; },
    intervalMs: 60_000,
  });
  context.after(() => { controller.abort(); blocked.resolve(); });
  await observer.start({ publishCatalog() {}, publishSession(id) { published.push(id); }, invalidateSession() {} }, controller.signal);
  await waitFor(() => started.length === 1);
  assert.deepEqual(started, ["history-0"], "cold history belongs in the background lane");
  for (let index = 0; index < 20; index += 1) wake("change", `source-${index}`);
  await waitFor(() => started.includes("source-0"));
  entries = [...entries, { localId: "live", isLive: true }];
  await observer.refresh();
  await waitFor(() => published.includes("live"));
  await observer.hydrate("selected");
  assert.deepEqual(published, ["live", "selected"]);
  assert.equal(started.filter((id) => id.startsWith("source-")).length, 1,
    "ordinary source updates cannot occupy the reserved urgent slot");
});

test("broad catalog notifications keep historical refreshes behind live initial evidence", async (context) => {
  const blocked = deferred();
  const controller = new AbortController();
  let entries = Array.from({ length: 10 }, (_, index) => ({ localId: `history-${index}`, isLive: false }));
  const started = [];
  const published = [];
  const observer = createNormalizedPollingObserver({
    list: async () => entries,
    shouldEagerHydrate: (entry) => entry.isLive,
    async ingest(id) {
      started.push(id);
      if (id.startsWith("history-")) await blocked.promise;
      return {};
    },
    intervalMs: 60_000,
  });
  context.after(() => { controller.abort(); blocked.resolve(); });
  await observer.start({ publishCatalog() {}, publishSession(id) { published.push(id); }, invalidateSession() {} }, controller.signal);
  await observer.refresh({ sessionIds: entries.map((entry) => entry.localId) });
  await waitFor(() => started.length === 1);
  entries = [...entries, { localId: "live", isLive: true }];
  await observer.refresh({ sessionIds: entries.map((entry) => entry.localId) });
  await waitFor(() => published.includes("live"));
  assert.equal(started.filter((id) => id.startsWith("history-")).length, 1);
});

test("initial live preparation starts before synchronous background preparation", async (context) => {
  const controller = new AbortController();
  const prepared = [];
  const published = [];
  const observer = createNormalizedPollingObserver({
    list: async () => [{ localId: "history", isLive: false }, { localId: "live", isLive: true }],
    shouldEagerHydrate: () => true,
    prepare(entries) { prepared.push(entries.map((entry) => entry.localId)); },
    ingest: async () => ({}),
    intervalMs: 60_000,
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession(id) { published.push(id); }, invalidateSession() {} }, controller.signal);
  await waitFor(() => published.length === 2);
  assert.deepEqual(prepared[0], ["live"]);
});

test("per-priority queue-wait timings are recorded separately for urgent, source-update, and background hydrations", async (context) => {
  const controller = new AbortController();
  const entries = [
    { localId: "live-one", isLive: true },
    { localId: "background-one", isLive: false },
  ];
  const observer = createNormalizedPollingObserver({
    list: async () => entries,
    shouldEagerHydrate: () => false,
    ingest: async () => ({}),
    intervalMs: 60_000,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await waitFor(() => observer.diagnostics().reconciliationRuns === 1);

  await observer.refresh({ sessionIds: ["live-one"], sourceEventAt: 0 });
  await waitFor(() => observer.diagnostics().timings.queueWaitUrgent.sampleCount === 1,
    100, () => JSON.stringify(observer.diagnostics().timings.queueWaitUrgent));

  await observer.refresh({ sessionIds: ["live-one"], sourceEventAt: 0 });
  await waitFor(() => observer.diagnostics().timings.queueWaitSourceUpdate.sampleCount === 1);

  await observer.refresh({ sessionIds: ["background-one"], sourceEventAt: 0 });
  await waitFor(() => observer.diagnostics().timings.queueWaitBackground.sampleCount === 1);

  const timings = observer.diagnostics().timings;
  assert.equal(timings.queueWaitUrgent.sampleCount, 1);
  assert.equal(timings.queueWaitSourceUpdate.sampleCount, 1);
  assert.equal(timings.queueWaitBackground.sampleCount, 1);
  assert.equal(timings.queueWait.sampleCount, 3, "the aggregate still reflects every priority");
});

test("per-priority queue waits are also recorded for urgent and background items with no source event, from their own enqueue time", async (context) => {
  const controller = new AbortController();
  const releaseUrgent = deferred();
  const entries = [
    { localId: "live-one", isLive: true },
    { localId: "background-one", isLive: false },
  ];
  const observer = createNormalizedPollingObserver({
    list: async () => entries,
    shouldEagerHydrate: () => true,
    ingest: async (id) => (id === "live-one" ? releaseUrgent.promise.then(() => ({})) : {}),
    intervalMs: 60_000,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  releaseUrgent.resolve();
  await waitFor(() => observer.diagnostics().timings.queueWaitUrgent.sampleCount === 1
    && observer.diagnostics().timings.queueWaitBackground.sampleCount === 1);

  const diagnostics = observer.diagnostics();
  assert.equal(diagnostics.timings.queueWaitUrgent.sampleCount, 1);
  assert.equal(diagnostics.timings.queueWaitBackground.sampleCount, 1);
  assert.equal(diagnostics.sourceEventQueueSamples, 0, "no item here ever carried a source event");
  assert.equal(diagnostics.timings.queueWait.sampleCount, 0, "the aggregate stays source-event-only");
});

test("a background item promoted to urgent records its urgent wait from the promotion, not from its enqueue", async (context) => {
  const controller = new AbortController();
  const releaseFirst = deferred();
  let clock = 0;
  const entries = [
    { localId: "background-a", isLive: false },
    { localId: "background-b", isLive: false },
  ];
  const observer = createNormalizedPollingObserver({
    list: async () => entries,
    shouldEagerHydrate: () => true,
    ingest: async (id) => (id === "background-a" ? releaseFirst.promise.then(() => ({})) : {}),
    monotonicNow: () => clock,
    backgroundConcurrency: 1,
    intervalMs: 60_000,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  context.after(() => releaseFirst.resolve());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await waitFor(() => observer.diagnostics().timings.queueWaitBackground.sampleCount === 1);

  clock += 60_000;
  await observer.hydrate("background-b");
  const timings = observer.diagnostics().timings;
  assert.equal(timings.queueWaitUrgent.sampleCount, 1);
  assert.equal(timings.queueWaitUrgent.maxMs, 0, "the minute spent waiting as background is not charged to the urgent lane");
});

test("a session published soon after its own creation gets first-publication priority even though it already finished, while startup catalog sessions are exempt", async (context) => {
  const controller = new AbortController();
  const nowMs = Date.parse("2026-09-27T12:00:00.000Z");
  let entries = [
    { localId: "startup-recent", isLive: false, createdAt: new Date(nowMs - 60_000).toISOString() },
    { localId: "startup-old", isLive: false, createdAt: new Date(nowMs - 90 * 24 * 60 * 60_000).toISOString() },
  ];
  const bulkBatches = [];
  const observer = createNormalizedPollingObserver({
    list: async () => entries,
    now: () => nowMs,
    shouldEagerHydrate: () => true,
    async prepare(batch) {
      bulkBatches.push(batch.map((entry) => entry.localId));
      return new Map(batch.map((entry) => [entry.localId, entry]));
    },
    ingest: async () => ({}),
    intervalMs: 60_000,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await waitFor(() => observer.diagnostics().reconciliationRuns === 1);
  await waitFor(() => observer.diagnostics().activeHydrations === 0 && observer.diagnostics().pendingHydrations === 0);
  assert.deepEqual(bulkBatches.map((batch) => [...batch].sort()), [["startup-old", "startup-recent"]],
    "every startup-catalog session, however recently created, is prepared through the ordinary background batch");

  entries = [...entries, { localId: "new-recent", isLive: false, createdAt: new Date(nowMs - 30_000).toISOString() }];
  await observer.refresh({ fresh: true });
  await waitFor(() => bulkBatches.some((batch) => batch.includes("new-recent")));
  assert.equal(bulkBatches.some((batch) => batch.length === 1 && batch[0] === "new-recent"), true,
    "a genuinely new, recently created session is prepared alone through the first-publication (urgent) lane");
  assert.equal(bulkBatches.some((batch) => batch.includes("new-recent") && batch.length > 1), false,
    "a new session is never folded into the historical background batch");
});

test("a Codex urgent source_queue record carries provider \"codex\" and lane \"urgent\"", async (context) => {
  const controller = new AbortController();
  let clock = 0;
  const entries = [{ localId: "live-one", isLive: true }];
  const trace = createPipelineTraceRecorder({ enabled: true, now: () => clock });
  const observer = createNormalizedPollingObserver({
    list: async () => entries,
    shouldEagerHydrate: () => false,
    ingest: async () => ({}),
    intervalMs: 60_000,
    providerId: "codex",
    monotonicNow: () => clock,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal, { trace });
  await waitFor(() => observer.diagnostics().reconciliationRuns === 1);

  clock += 5;
  await observer.refresh({ sessionIds: ["live-one"], sourceEventAt: 0 });
  await waitFor(() => observer.diagnostics().timings.queueWaitUrgent.sampleCount === 1);

  const { traceEvents } = trace.snapshot();
  const sourceQueue = traceEvents.find((event) => event.name === "source_queue");
  assert.ok(sourceQueue, "a source_queue span was recorded");
  assert.equal(sourceQueue.args.provider, "codex");
  assert.equal(sourceQueue.args.priorityLane, "urgent");

  const acquisition = traceEvents.find((event) => event.name === "acquisition_normalization");
  assert.ok(acquisition, "an acquisition_normalization span was recorded");
  assert.equal(acquisition.args.provider, "codex");
  assert.equal(acquisition.args.priorityLane, "urgent");
});
