import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNormalizedPollingObserver } from "../../server/providers/kernel/normalized-polling-observer.mjs";
import { createSessionFileLister } from "../../server/normalize/session-discovery.mjs";

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

async function flush() {
  for (let turn = 0; turn < 10; turn += 1) await yieldTurn();
}

async function settle(predicate, message = "observer did not settle") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await yieldTurn();
  }
  assert.fail(message);
}

// The observer's spacing timers are setTimeout-driven against an injectable monotonic clock.
// Tests advance both together instead of sleeping.
function useFakeClock(context) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  return {
    now: () => clock,
    async advance(ms) {
      clock += ms;
      context.mock.timers.tick(ms);
      await flush();
    },
  };
}

function startObserver(context, clock, { list, sourceCatalogIntervalMs }) {
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
    monotonicNow: clock.now,
  });
  context.after(() => controller.abort());
  const started = observer.start({
    publishCatalog(entries) { catalogs.push(entries); },
    publishSession() {}, invalidateSession() {},
  }, controller.signal);
  return { started, catalogs, wake: (...args) => wake(...args), observer };
}

test("a burst of source notifications runs a bounded number of catalog passes and ends fresh", async (context) => {
  const clock = useFakeClock(context);
  const passes = [];
  const { started, wake } = startObserver(context, clock, {
    async list(options) { passes.push({ at: clock.now(), fresh: options.fresh }); return []; },
    sourceCatalogIntervalMs: 200,
  });
  await started;
  await settle(() => passes.length === 1);
  const burstStartedAt = clock.now();
  let lastWakeAt = 0;
  for (let index = 0; index < 60; index += 1) {
    wake("change", "session.jsonl");
    lastWakeAt = clock.now();
    await clock.advance(10);
  }
  const burstMs = clock.now() - burstStartedAt;
  await clock.advance(450);
  const sourcePasses = passes.slice(1);
  assert.ok(sourcePasses.length >= 1, "notifications still cause catalog discovery");
  assert.ok(sourcePasses.length <= Math.ceil(burstMs / 200) + 2,
    `60 notifications over ${burstMs} ms caused ${sourcePasses.length} passes`);
  assert.ok(sourcePasses.every(({ fresh }) => fresh), "source-driven passes bypass discovery caches");
  assert.ok(sourcePasses.at(-1).at >= lastWakeAt, "the last notification is followed by a pass that starts after it");
  for (let index = 1; index < passes.length; index += 1) {
    assert.ok(passes[index].at - passes[index - 1].at >= 200, "passes respect the configured spacing");
  }
});

test("an idle observer answers a notification immediately and a routine pass absorbs a pending one", async (context) => {
  const clock = useFakeClock(context);
  const passes = [];
  const { started, wake, observer } = startObserver(context, clock, {
    async list(options) { passes.push({ at: clock.now(), fresh: options.fresh }); return []; },
    sourceCatalogIntervalMs: 300,
  });
  await started;
  await settle(() => passes.length === 1);
  await clock.advance(320);
  const wokeAt = clock.now();
  wake("change", "session.jsonl");
  await settle(() => passes.length === 2);
  assert.equal(passes[1].at, wokeAt, "the leading notification is not delayed");

  wake("change", "session.jsonl");
  await clock.advance(20);
  assert.equal(passes.length, 2, "a notification inside the spacing window waits");
  await observer.refresh();
  assert.equal(passes.length, 3);
  assert.equal(passes[2].fresh, true, "a routine pass that answers a notification is upgraded to fresh");
  await clock.advance(400);
  assert.equal(passes.length, 3, "an answered notification schedules no extra trailing pass");
});

test("a new Claude session file is discovered after a notification", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-spacing-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "existing.jsonl"), "{}\n");
  const clock = useFakeClock(context);
  const lister = createSessionFileLister();
  const passStarts = [];
  const { started, catalogs, wake } = startObserver(context, clock, {
    async list() {
      passStarts.push(clock.now());
      return (await lister.listAsync(root)).map(({ file }) => ({ localId: path.basename(file, ".jsonl") }));
    },
    sourceCatalogIntervalMs: 1_000,
  });
  await started;
  await settle(() => catalogs.length === 1);
  assert.deepEqual(catalogs[0].map(({ localId }) => localId), ["existing"]);
  const createdAt = clock.now();
  fs.writeFileSync(path.join(root, "project", "created.jsonl"), "{}\n");
  wake("rename", path.join("project", "created.jsonl"));
  for (let step = 0; step < 20 && passStarts.length < 2; step += 1) await clock.advance(100);
  await settle(() => catalogs.at(-1).some(({ localId }) => localId === "created"));
  assert.ok(passStarts[1] - createdAt <= 1_000, "a new session appears within one spacing window");
});
