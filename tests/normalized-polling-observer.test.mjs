import assert from "node:assert/strict";
import test from "node:test";
import { createNormalizedPollingObserver } from "../monitor/providers/normalized-polling-observer.mjs";

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
