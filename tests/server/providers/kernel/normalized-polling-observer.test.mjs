import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createNormalizedPollingObserver } from "../../../../server/providers/kernel/normalized-polling-observer.mjs";
import { createPipelineTraceRecorder } from "../../../../server/diagnostics/pipeline-trace.mjs";

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

const turn = () => new Promise((resolve) => setImmediate(resolve));
const settle = (predicate) => waitFor(predicate, 200, () => "(catalog event reconciliation did not settle)");

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

test("a background item promoted by selection records its selected wait from the promotion, not from its enqueue", async (context) => {
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
  assert.equal(timings.queueWaitSelected.sampleCount, 1);
  assert.equal(timings.queueWaitSelected.maxMs, 0, "the minute spent waiting as background is not charged to the selected lane");
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

test("a selection's acquisition carries trace lane \"selected\", separate from urgent first publication", async (context) => {
  const controller = new AbortController();
  const trace = createPipelineTraceRecorder({ enabled: true, now: () => 0 });
  const observer = createNormalizedPollingObserver({
    list: async () => [{ localId: "chosen", isLive: false }],
    shouldEagerHydrate: () => false,
    ingest: async () => ({}),
    intervalMs: 60_000,
    providerId: "claude",
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal, { trace });
  await observer.hydrate("chosen");
  const acquisition = trace.snapshot().traceEvents.find((event) => event.name === "acquisition_normalization");
  assert.equal(acquisition?.args.priorityLane, "selected");
  assert.equal(observer.diagnostics().timings.queueWaitSelected.sampleCount, 1);
  assert.equal(observer.diagnostics().timings.queueWaitUrgent.sampleCount, 0);
});

test("catalog-event bursts coalesce discovery and hydrate departures against the new catalog", async (context) => {
  const controller = new AbortController();
  let wake;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  let entry = { localId: "one", activityStatus: "open", isLive: true };
  const catalogs = [];
  const hydrated = [];
  const observer = createNormalizedPollingObserver({
    async list() {
      reads += 1;
      if (reads === 2) await blocked;
      return [entry];
    },
    async prepare(entries) { return new Map(entries.map((item) => [item.localId, item])); },
    async ingest(id, _publisher, prepared) { hydrated.push(prepared.get(id)); return null; },
    shouldEagerHydrate: () => false,
    routeSourceEvent: () => ({ catalog: true, afterCatalog: true, sessionIds: ["one"] }),
    sourceCatalogIntervalMs: 0,
    watchTargets: ["synthetic-index"],
    watchSource(_target, _options, callback) { wake = callback; return { close() {} }; },
    intervalMs: 60_000,
  });
  context.after(() => { controller.abort(); release(); });
  await observer.start({
    publishCatalog(entries) { catalogs.push(entries); },
    publishSession() {}, invalidateSession() {},
  }, controller.signal);
  await settle(() => catalogs.length === 1);
  await observer.hydrate("one");
  assert.equal(hydrated[0].activityStatus, "open");
  entry = { ...entry, activityStatus: "idle", isLive: false };
  for (let index = 0; index < 100; index += 1) wake("change", "index");
  await settle(() => reads === 2);
  await turn();
  assert.equal(reads, 2, "event routing must not independently prefetch the catalog");
  release();
  await settle(() => catalogs.length === 3 && observer.diagnostics().activeHydrations === 0 && hydrated.length > 1);
  assert.equal(reads, 3, "100 notifications require one active pass and one latest-state follow-up");
  assert.equal(hydrated.slice(1).every((value) => value.activityStatus === "idle" && !value.isLive), true,
    "a session leaving the eager set still refreshes detail using the new entry");
  controller.abort();
  await observer.refresh({ sessionIds: ["one"] });
  assert.equal(reads, 3, "a late private ownership notification cannot restart a stopped observer");
});

test("known source rotations bypass a blocked catalog and unavailable catalogs retain wakeups", async (context) => {
  const controller = new AbortController();
  let wake;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  let hydrated = 0;
  const observer = createNormalizedPollingObserver({
    async list() {
      reads += 1;
      if (reads === 2) { await blocked; return null; }
      return [{ localId: "one", isLive: false }];
    },
    async ingest() { hydrated += 1; return null; },
    shouldEagerHydrate: () => false,
    routeSourceEvent: () => ({ catalog: true, sessionIds: ["one"] }),
    sourceCatalogIntervalMs: 0,
    watchTargets: ["synthetic-sources"],
    watchSource(_target, _options, callback) { wake = callback; return { close() {} }; },
    intervalMs: 60_000,
  });
  context.after(() => { controller.abort(); release(); });
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await settle(() => reads === 1);
  await turn();
  wake("rename", "known.jsonl");
  await settle(() => reads === 2 && hydrated === 1);
  release();
  await turn();
  await observer.refresh();
  await settle(() => hydrated === 2);
  assert.equal(reads, 3, "the next successful reconciliation must retry the lost catalog wakeup");
});

/** One observer whose router answers with `route`; counts catalog reads and session reads. */
async function observeRoutedWrites(context, route) {
  const controller = new AbortController();
  const counts = { catalogs: 0, reads: 0 };
  let wake;
  const observer = createNormalizedPollingObserver({
    async list() { counts.catalogs += 1; return [{ localId: "one", isLive: true }]; },
    async ingest() { counts.reads += 1; return null; },
    shouldEagerHydrate: () => false,
    routeSourceEvent: () => route,
    sourceCatalogIntervalMs: 0,
    watchTargets: ["synthetic-sources"],
    watchSource(_target, _options, callback) { wake = callback; return { close() {} }; },
    intervalMs: 60_000,
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await settle(() => counts.catalogs === 1);
  await observer.hydrate("one");
  counts.reads = 0;
  const idle = async () => {
    await settle(() => counts.catalogs === 2 && observer.diagnostics().activeHydrations === 0);
    for (let index = 0; index < 5; index += 1) await turn();
  };
  return { counts, idle, wake: (eventType) => wake(eventType, "known.jsonl") };
}

test("a write to a source its session already reads refreshes the catalog and reads the session once", async (context) => {
  const { counts, idle, wake } = await observeRoutedWrites(context, { catalog: true, sessionIds: ["one"], sourceKnown: true });
  wake("change");
  await idle();
  assert.equal(counts.catalogs, 2, "the write still marks the catalog dirty");
  assert.equal(counts.reads, 1, "the immediate read answers the write; no second read follows the catalog pass");
});

test("a write keeps its read after the catalog pass when the source is not known, was renamed, or waits for the catalog", async (context) => {
  for (const [label, route, eventType, expected] of [
    ["unknown source", { catalog: true, sessionIds: ["one"] }, "change", 2],
    ["renamed known source", { catalog: true, sessionIds: ["one"], sourceKnown: true }, "rename", 2],
    ["after-catalog route", { catalog: true, afterCatalog: true, sessionIds: ["one"], sourceKnown: true }, "change", 1],
  ]) {
    const { counts, idle, wake } = await observeRoutedWrites(context, route);
    wake(eventType);
    await idle();
    await settle(() => counts.reads === expected);
    assert.equal(counts.reads, expected, label);
  }
});

/** A watched observer over one settled and one live session, with a scripted file stat. */
async function observeNotifiedFiles(context, files, { blockBackground = false } = {}) {
  const controller = new AbortController();
  const state = { catalogs: 0, reads: [], release: () => {} };
  const gate = blockBackground ? new Promise((resolve) => { state.release = resolve; }) : null;
  let wake;
  const recorder = createPipelineTraceRecorder({ enabled: true });
  const observer = createNormalizedPollingObserver({
    providerId: "claude",
    async list() { state.catalogs += 1; return [{ localId: "settled", isLive: false }, { localId: "live", isLive: true }, { localId: "blocker", isLive: false }]; },
    async ingest(id) { state.reads.push(id); if (id === "blocker" && gate) await gate; return null; },
    // The catalog pass queues only the blocker, which can hold the single background slot.
    shouldEagerHydrate: (entry) => entry.localId === "blocker",
    routeSourceEvent: ({ filename }) => ({ catalog: false, sessionIds: [path.basename(String(filename), ".jsonl")], sourceKnown: true }),
    watchTargets: ["synthetic-sources"],
    watchSource(_target, _options, callback) { wake = callback; return { close() {} }; },
    statSource(file) {
      const info = files.get(path.basename(file));
      if (!info) throw new Error("missing");
      return { ...info, isFile: () => true };
    },
    now: () => 1_000_000,
    intervalMs: 60_000,
    backgroundConcurrency: 1,
  });
  context.after(() => { state.release(); controller.abort(); });
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal, { trace: recorder });
  await settle(() => state.catalogs === 1 && state.reads.includes("blocker"));
  for (const id of ["settled", "live"]) await observer.hydrate(id);
  state.reads.length = 0;
  const quiet = async () => { for (let index = 0; index < 8; index += 1) await turn(); };
  const lanes = () => recorder.snapshot().traceEvents.filter((event) => event.name === "source_queue").map((event) => event.args.priorityLane);
  return { state, observer, quiet, lanes, wake: (filename, eventType = "change") => wake(eventType, filename) };
}

test("a change notification that moved neither size nor modification time reads nothing", async (context) => {
  const files = new Map([["settled.jsonl", { size: 10, mtimeMs: 1_000_000 - 3_600_000 }]]);
  const { state, observer, quiet, wake } = await observeNotifiedFiles(context, files);
  wake("settled.jsonl");
  wake("settled.jsonl");
  await quiet();
  assert.deepEqual(state.reads, [], "an access-only notification is not a source event");
  assert.equal(observer.diagnostics().unchangedSourceEvents, 2);
  assert.equal(observer.diagnostics().routedSourceEvents, 0);
  files.set("settled.jsonl", { size: 30, mtimeMs: 1_000_000 - 3_600_000 });
  wake("settled.jsonl");
  await settle(() => state.reads.length === 1);
  assert.deepEqual(state.reads, ["settled"], "growth is read");
});

test("a confirmed write to a settled session uses the live-update lane; an unconfirmed notification waits with background work", async (context) => {
  const files = new Map([["settled.jsonl", { size: 10, mtimeMs: 1_000_000 + 1 }]]);
  const { state, quiet, lanes, wake } = await observeNotifiedFiles(context, files, { blockBackground: true });
  wake("settled.jsonl", "rename");
  await quiet();
  assert.equal(state.reads.includes("settled"), false, "a rename of a settled session's file queues behind background work");
  wake("live.jsonl", "rename");
  await settle(() => state.reads.includes("live"));
  wake("settled.jsonl");
  await settle(() => state.reads.includes("settled"));
  assert.deepEqual(lanes(), ["urgent", "source_update"],
    "the live session's first read is urgent, and the confirmed write promotes the waiting settled read to the live-update lane");
});

test("late eager preparation cannot overwrite a newer lifecycle hydration", async (context) => {
  const controller = new AbortController();
  let releasePreparation;
  let releaseHydration;
  const oldPreparation = new Promise((resolve) => { releasePreparation = resolve; });
  const activeHydration = new Promise((resolve) => { releaseHydration = resolve; });
  let entry = { localId: "one", activityStatus: "unknown", isLive: false };
  let preparations = 0;
  const hydrated = [];
  const observer = createNormalizedPollingObserver({
    async list() { return [entry]; },
    async prepare(entries) {
      preparations += 1;
      if (preparations === 1) await oldPreparation;
      return new Map(entries.map((item) => [item.localId, item]));
    },
    async ingest(id, _publisher, prepared) {
      hydrated.push(prepared.get(id).activityStatus);
      if (hydrated.length === 1) await activeHydration;
      return null;
    },
    shouldEagerHydrate: () => true,
    intervalMs: 60_000,
  });
  context.after(() => { controller.abort(); releasePreparation(); releaseHydration(); });
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await settle(() => preparations === 1);
  entry = { ...entry, activityStatus: "idle", isLive: false };
  await observer.refresh({ sessionIds: ["one"] });
  await settle(() => hydrated.length === 1);
  assert.deepEqual(hydrated, ["idle"]);
  releasePreparation();
  await settle(() => preparations >= 3);
  releaseHydration();
  await settle(() => observer.diagnostics().activeHydrations === 0);
  assert.equal(hydrated.every((status) => status === "idle"), true,
    "a pre-event eager batch cannot revert the newer lifecycle after its delayed preparation finishes");
});

test("a source wake invalidates an earlier prepared batch even without catalog growth", async (context) => {
  const controller = new AbortController();
  let releasePreparation;
  let releaseHydration;
  const oldPreparation = new Promise((resolve) => { releasePreparation = resolve; });
  const activeHydration = new Promise((resolve) => { releaseHydration = resolve; });
  let revision = "old";
  let preparations = 0;
  const hydrated = [];
  const observer = createNormalizedPollingObserver({
    async list() { return [{ localId: "one", isLive: false, updatedAt: new Date().toISOString() }]; },
    async prepare() {
      const snapshot = revision;
      preparations += 1;
      if (preparations === 1) await oldPreparation;
      return snapshot;
    },
    async ingest(id, _publisher, prepared) {
      if (id === "blocker") await activeHydration;
      else hydrated.push(prepared);
      return null;
    },
    concurrency: 1,
    intervalMs: 60_000,
  });
  context.after(() => { controller.abort(); releasePreparation(); releaseHydration(); });
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await settle(() => preparations === 1);
  const blocker = observer.hydrate("blocker");
  await settle(() => preparations === 2);
  revision = "new";
  const requested = observer.hydrate("one");
  releasePreparation();
  await turn();
  await turn();
  releaseHydration();
  await blocker;
  await requested;
  await settle(() => observer.diagnostics().activeHydrations === 0);
  assert.deepEqual(hydrated, ["new"], "late eager work must self-prepare instead of reusing the pre-event source snapshot");
});

function catalogObserver({ list, prepared = [], published = [] }) {
  return createNormalizedPollingObserver({
    list,
    shouldEagerHydrate: () => false,
    async prepare(batch) { prepared.push(...batch); return new Map(batch.map((entry) => [entry.localId, entry])); },
    async ingest(id) { published.push(id); return null; },
    intervalMs: 60_000,
    async yieldControl() {},
  });
}

test("a hydrated session the completed catalog does not list is prepared as not live, and a listed one keeps its entry", async (context) => {
  const controller = new AbortController();
  const prepared = [];
  const observer = catalogObserver({ list: async () => [{ localId: "listed", isLive: true, activityStatus: "working" }], prepared });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await settle(() => observer.diagnostics().reconciliationRuns === 1 && observer.diagnostics().activeHydrations === 0);
  await observer.hydrate("unlisted");
  await observer.hydrate("listed");
  assert.deepEqual(prepared, [
    { localId: "unlisted", isLive: false },
    { localId: "listed", isLive: true, activityStatus: "working" },
  ]);
});

test("hydrations that arrive before the first catalog pass wait for it and then see its answer, live or not", async (context) => {
  const controller = new AbortController();
  const firstPass = deferred();
  const prepared = [];
  let reads = 0;
  const observer = catalogObserver({
    list: async () => { reads += 1; return firstPass.promise; }, prepared,
  });
  context.after(() => { controller.abort(); firstPass.resolve([]); });
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await settle(() => reads === 1);
  const live = observer.hydrate("live-in-first-pass");
  const history = observer.hydrate("absent-from-first-pass");
  for (let index = 0; index < 5; index += 1) await turn();
  assert.deepEqual(prepared, [], "neither a live nor a historical answer is decided before the catalog is known");
  assert.equal(observer.diagnostics().activeHydrations, 2);
  assert.equal(reads, 1, "waiting does not start another catalog pass while one is in flight");
  firstPass.resolve([{ localId: "live-in-first-pass", isLive: true, activityStatus: "working" }]);
  await Promise.all([live, history]);
  assert.deepEqual(prepared.sort((left, right) => left.localId.localeCompare(right.localId)), [
    { localId: "absent-from-first-pass", isLive: false },
    { localId: "live-in-first-pass", isLive: true, activityStatus: "working" },
  ]);
  assert.equal(observer.diagnostics().acquisitionFailures, 0);
});

test("a waiting hydration is rejected, not guessed, when the catalog pass fails, and a later request retries the catalog", async (context) => {
  const controller = new AbortController();
  const firstPass = deferred();
  const prepared = [];
  const published = [];
  let reads = 0;
  const observer = catalogObserver({
    list: async () => {
      reads += 1;
      if (reads > 1) return [];
      await firstPass.promise;
      throw new Error("catalog unavailable");
    }, prepared, published,
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await settle(() => reads === 1);
  const waiting = observer.hydrate("session");
  await turn();
  firstPass.resolve();
  assert.equal(await waiting, false, "an unknown liveness publishes nothing");
  assert.deepEqual(prepared, []);
  assert.deepEqual(published, []);
  await settle(() => observer.diagnostics().activeHydrations === 0);
  assert.equal(observer.diagnostics().acquisitionFailures, 0, "an unavailable catalog is not an acquisition failure");

  await observer.hydrate("session");
  assert.equal(reads, 2, "a request after the failed pass asks for a new catalog pass");
  assert.deepEqual(prepared, [{ localId: "session", isLive: false }]);
  assert.deepEqual(published, ["session"]);
});

test("a hydration waiting for the first catalog pass settles when the observer stops", async (context) => {
  const controller = new AbortController();
  const firstPass = deferred();
  const prepared = [];
  let reads = 0;
  const observer = catalogObserver({ list: async () => { reads += 1; return firstPass.promise; }, prepared });
  context.after(() => { controller.abort(); firstPass.resolve([]); });
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await settle(() => reads === 1);
  const waiting = observer.hydrate("session");
  await turn();
  controller.abort();
  assert.equal(await waiting, false);
  assert.deepEqual(prepared, []);
});
