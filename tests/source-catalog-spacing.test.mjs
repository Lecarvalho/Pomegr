import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNormalizedPollingObserver } from "../monitor/providers/normalized-polling-observer.mjs";
import { createSessionFileLister } from "../monitor/session-discovery.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("observer did not settle");
}

function startObserver(context, { list, sourceCatalogIntervalMs }) {
  const controller = new AbortController();
  let wake;
  const catalogs = [];
  const observer = createNormalizedPollingObserver({
    list,
    async ingest() { return null; },
    shouldEagerHydrate: () => false,
    routeSourceEvent: () => ({ catalog: true, sessionIds: [] }),
    watchTargets: ["synthetic-projects"],
    watchSource(_target, _options, callback) { wake = callback; return { close() {} }; },
    intervalMs: 60_000,
    sourceCatalogIntervalMs,
  });
  context.after(() => controller.abort());
  const started = observer.start({
    publishCatalog(entries) { catalogs.push(entries); },
    publishSession() {}, invalidateSession() {},
  }, controller.signal);
  return { started, catalogs, wake: (...args) => wake(...args), observer };
}

test("a burst of source notifications runs a bounded number of catalog passes and ends fresh", async (context) => {
  const passes = [];
  const { started, wake } = startObserver(context, {
    async list(options) { passes.push({ at: performance.now(), fresh: options.fresh }); return []; },
    sourceCatalogIntervalMs: 200,
  });
  await started;
  await waitFor(() => passes.length === 1);
  const burstStartedAt = performance.now();
  let lastWakeAt = 0;
  for (let index = 0; index < 60; index += 1) {
    wake("change", "session.jsonl");
    lastWakeAt = performance.now();
    await delay(10);
  }
  const burstMs = performance.now() - burstStartedAt;
  await delay(450);
  const sourcePasses = passes.slice(1);
  assert.ok(sourcePasses.length >= 1, "notifications still cause catalog discovery");
  assert.ok(sourcePasses.length <= Math.ceil(burstMs / 200) + 2,
    `60 notifications over ${Math.round(burstMs)} ms caused ${sourcePasses.length} passes`);
  assert.ok(sourcePasses.every(({ fresh }) => fresh), "source-driven passes bypass discovery caches");
  assert.ok(sourcePasses.at(-1).at >= lastWakeAt, "the last notification is followed by a pass that starts after it");
  for (let index = 1; index < passes.length; index += 1) {
    assert.ok(passes[index].at - passes[index - 1].at >= 195, "passes respect the configured spacing");
  }
});

test("an idle observer answers a notification immediately and a routine pass absorbs a pending one", async (context) => {
  const passes = [];
  const { started, wake, observer } = startObserver(context, {
    async list(options) { passes.push({ at: performance.now(), fresh: options.fresh }); return []; },
    sourceCatalogIntervalMs: 300,
  });
  await started;
  await waitFor(() => passes.length === 1);
  await delay(320);
  const wokeAt = performance.now();
  wake("change", "session.jsonl");
  await waitFor(() => passes.length === 2);
  assert.ok(passes[1].at - wokeAt < 100, "the leading notification is not delayed");

  wake("change", "session.jsonl");
  await delay(20);
  assert.equal(passes.length, 2, "a notification inside the spacing window waits");
  await observer.refresh();
  assert.equal(passes.length, 3);
  assert.equal(passes[2].fresh, true, "a routine pass that answers a notification is upgraded to fresh");
  await delay(400);
  assert.equal(passes.length, 3, "an answered notification schedules no extra trailing pass");
});

test("a new Claude session file is discovered after a notification", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-spacing-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "existing.jsonl"), "{}\n");
  const lister = createSessionFileLister();
  const { started, catalogs, wake } = startObserver(context, {
    async list() {
      return (await lister.listAsync(root)).map(({ file }) => ({ localId: path.basename(file, ".jsonl") }));
    },
    sourceCatalogIntervalMs: 1_000,
  });
  await started;
  await waitFor(() => catalogs.length === 1);
  assert.deepEqual(catalogs[0].map(({ localId }) => localId), ["existing"]);
  const createdAt = performance.now();
  fs.writeFileSync(path.join(root, "project", "created.jsonl"), "{}\n");
  wake("rename", path.join("project", "created.jsonl"));
  await waitFor(() => catalogs.at(-1).some(({ localId }) => localId === "created"));
  assert.ok(performance.now() - createdAt < 1_500, "a new session appears within one spacing window");
});
