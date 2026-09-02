import assert from "node:assert/strict";
import test from "node:test";
import { createNormalizedPollingObserver } from "../monitor/providers/normalized-polling-observer.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate) {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await turn();
  }
  assert.fail("catalog event reconciliation did not settle");
}

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
    watchTargets: ["synthetic-index"],
    watchSource(_target, _options, callback) { wake = callback; return { close() {} }; },
    intervalMs: 60_000,
  });
  context.after(() => { controller.abort(); release(); });
  await observer.start({
    publishCatalog(entries) { catalogs.push(entries); },
    publishSession() {}, invalidateSession() {},
  }, controller.signal);
  await waitFor(() => catalogs.length === 1);
  await observer.hydrate("one");
  assert.equal(hydrated[0].activityStatus, "open");
  entry = { ...entry, activityStatus: "idle", isLive: false };
  for (let index = 0; index < 100; index += 1) wake("change", "index");
  await waitFor(() => reads === 2);
  await turn();
  assert.equal(reads, 2, "event routing must not independently prefetch the catalog");
  release();
  await waitFor(() => catalogs.length === 3 && observer.diagnostics().activeHydrations === 0 && hydrated.length > 1);
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
    watchTargets: ["synthetic-sources"],
    watchSource(_target, _options, callback) { wake = callback; return { close() {} }; },
    intervalMs: 60_000,
  });
  context.after(() => { controller.abort(); release(); });
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await waitFor(() => reads === 1);
  await turn();
  wake("rename", "known.jsonl");
  await waitFor(() => reads === 2 && hydrated === 1);
  release();
  await turn();
  await observer.refresh();
  await waitFor(() => hydrated === 2);
  assert.equal(reads, 3, "the next successful reconciliation must retry the lost catalog wakeup");
});

test("late eager preparation cannot overwrite a newer lifecycle hydration", async (context) => {
  const controller = new AbortController();
  let releasePreparation;
  let releaseHydration;
  const oldPreparation = new Promise((resolve) => { releasePreparation = resolve; });
  const activeHydration = new Promise((resolve) => { releaseHydration = resolve; });
  let entry = { localId: "one", activityStatus: "open", isLive: true };
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
  await waitFor(() => preparations === 1);
  entry = { ...entry, activityStatus: "idle", isLive: false };
  await observer.refresh({ sessionIds: ["one"] });
  await waitFor(() => hydrated.length === 1);
  assert.deepEqual(hydrated, ["idle"]);
  releasePreparation();
  await waitFor(() => preparations >= 3);
  releaseHydration();
  await waitFor(() => observer.diagnostics().activeHydrations === 0);
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
    async list() { return [{ localId: "one", isLive: true }]; },
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
  await waitFor(() => preparations === 1);
  const blocker = observer.hydrate("blocker");
  await waitFor(() => preparations === 2);
  revision = "new";
  const requested = observer.hydrate("one");
  releasePreparation();
  await turn();
  await turn();
  releaseHydration();
  await blocker;
  await requested;
  await waitFor(() => observer.diagnostics().activeHydrations === 0);
  assert.deepEqual(hydrated, ["new"], "late eager work must self-prepare instead of reusing the pre-event source snapshot");
});
