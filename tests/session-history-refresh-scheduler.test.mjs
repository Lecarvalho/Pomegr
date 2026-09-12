import assert from "node:assert/strict";
import test from "node:test";
import { createSessionHistoryRefreshScheduler } from "../monitor/session-history-refresh-scheduler.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for history scheduler state");
}

test("selected history uses reserved capacity while one maintenance replay remains active", async () => {
  const gates = new Map([["maintenance-1", deferred()], ["maintenance-2", deferred()], ["selected", deferred()]]);
  const started = [];
  const scheduler = createSessionHistoryRefreshScheduler({
    async run(sessionId) { started.push(sessionId); await gates.get(sessionId).promise; },
    foregroundConcurrency: 1,
    backgroundConcurrency: 1,
  });
  scheduler.enqueue("maintenance-1", { priority: 2 });
  scheduler.enqueue("maintenance-2", { priority: 2 });
  await waitFor(() => started.length === 1);
  assert.deepEqual(started, ["maintenance-1"]);

  scheduler.enqueue("selected", { priority: 0 });
  await waitFor(() => started.includes("selected"));
  assert.deepEqual(started, ["maintenance-1", "selected"]);
  assert.deepEqual(scheduler.diagnostics(), {
    active: 2, pending: 1, activeForeground: 1, activeBackground: 1,
  });

  gates.get("selected").resolve();
  gates.get("maintenance-1").resolve();
  await waitFor(() => started.includes("maintenance-2"));
  gates.get("maintenance-2").resolve();
});

test("selection promotes a queued maintenance replay without duplicating it", async () => {
  const gates = new Map([["occupied", deferred()], ["selected", deferred()]]);
  const started = [];
  const scheduler = createSessionHistoryRefreshScheduler({
    async run(sessionId) { started.push(sessionId); await gates.get(sessionId).promise; },
  });
  scheduler.enqueue("occupied", { priority: 2 });
  scheduler.enqueue("selected", { priority: 2 });
  await waitFor(() => started.length === 1);

  scheduler.enqueue("selected", { priority: 0, rerunIfActive: false });
  await waitFor(() => started.includes("selected"));
  assert.deepEqual(started, ["occupied", "selected"]);
  gates.get("selected").resolve();
  gates.get("occupied").resolve();
});

test("a rejected refresh releases its lane and drains the next pending session", async () => {
  const started = [];
  const scheduler = createSessionHistoryRefreshScheduler({
    async run(sessionId) {
      started.push(sessionId);
      if (sessionId === "broken") throw new Error("synthetic refresh failure");
    },
    foregroundConcurrency: 1,
    backgroundConcurrency: 1,
  });
  scheduler.enqueue("broken", { priority: 2 });
  scheduler.enqueue("next", { priority: 2 });
  await waitFor(() => started.includes("next"));
  assert.deepEqual(started, ["broken", "next"]);
  assert.deepEqual(scheduler.diagnostics(), { active: 0, pending: 0, activeForeground: 0, activeBackground: 0 });
});

test("an active session coalesces one rerun and promotion keeps the rerun foreground", async () => {
  const first = deferred();
  const second = deferred();
  const gates = [first, second];
  const started = [];
  const scheduler = createSessionHistoryRefreshScheduler({
    async run(sessionId, priority) {
      started.push({ sessionId, priority });
      await gates[started.length - 1].promise;
    },
    foregroundConcurrency: 1,
    backgroundConcurrency: 1,
  });
  scheduler.enqueue("session", { priority: 2 });
  await waitFor(() => started.length === 1);
  assert.equal(scheduler.enqueue("session", { priority: 2 }), false);
  assert.equal(scheduler.promote("session"), true);
  first.resolve();
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, [
    { sessionId: "session", priority: 2 },
    { sessionId: "session", priority: 0 },
  ]);
  assert.equal(scheduler.diagnostics().active, 1);
  second.resolve();
  await waitFor(() => scheduler.diagnostics().active === 0);
});

test("stop clears pending work and start does not resurrect it", async () => {
  const occupied = deferred();
  const started = [];
  const scheduler = createSessionHistoryRefreshScheduler({
    async run(sessionId) {
      started.push(sessionId);
      await occupied.promise;
    },
    foregroundConcurrency: 1,
    backgroundConcurrency: 1,
  });
  scheduler.enqueue("occupied", { priority: 2 });
  await waitFor(() => started.length === 1);
  scheduler.enqueue("discarded", { priority: 2 });
  assert.equal(scheduler.diagnostics().pending, 1);
  scheduler.stop();
  assert.deepEqual(scheduler.diagnostics(), { active: 1, pending: 0, activeForeground: 0, activeBackground: 1 });
  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["occupied"]);
  occupied.resolve();
  await waitFor(() => scheduler.diagnostics().active === 0);
});
