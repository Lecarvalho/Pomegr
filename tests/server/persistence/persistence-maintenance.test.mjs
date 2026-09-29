import assert from "node:assert/strict";
import test from "node:test";
import { createPersistenceMaintenance } from "../../../server/persistence/persistence-maintenance.mjs";

function scheduler() {
  const jobs = new Set();
  return { schedule(task) { jobs.add(task); return task; }, cancel(task) { jobs.delete(task); },
    async tick() { const job = jobs.values().next().value; jobs.delete(job); await job?.(); }, jobs };
}

test("live and selected work defer maintenance; idle batches alternate with a fixed budget", async () => {
  const clock = scheduler();
  let busy = true;
  const calls = [];
  const owner = createPersistenceMaintenance({ ...clock, budget: 7, isBusy: () => busy,
    steps: [async ({ budget }) => calls.push(["checkpoint", budget]), async ({ budget }) => calls.push(["history", budget])] });
  owner.start();
  for (let index = 0; index < 20; index += 1) await clock.tick();
  assert.equal(calls.length, 0);
  assert.equal(clock.jobs.size, 1);
  busy = false;
  await clock.tick(); await clock.tick(); await clock.tick();
  assert.deepEqual(calls, [["checkpoint", 7], ["history", 7], ["checkpoint", 7]]);
  await owner.stop();
  assert.equal(clock.jobs.size, 0);
  assert.equal(owner.stats().deferred, 20);
});

test("shutdown cancels scheduling, waits for one in-flight bounded step, and permits restart", async () => {
  const clock = scheduler();
  let release;
  let yieldRequested;
  const owner = createPersistenceMaintenance({ ...clock, steps: [async ({ shouldYield }) => {
    yieldRequested = shouldYield;
    await new Promise((resolve) => { release = resolve; });
  }] });
  owner.start();
  const ticking = clock.tick();
  await Promise.resolve();
  const stopping = owner.stop();
  assert.equal(yieldRequested(), true);
  release();
  await Promise.all([ticking, stopping]);
  assert.equal(clock.jobs.size, 0);
  owner.start();
  assert.equal(clock.jobs.size, 1);
  await owner.stop();
});

test("maintenance failure is bounded and never publishes raw errors", async () => {
  const clock = scheduler();
  const owner = createPersistenceMaintenance({ ...clock, steps: [async () => { throw new Error("private-path-and-content"); }] });
  owner.start(); await clock.tick();
  assert.deepEqual(owner.stats(), { batches: 0, deferred: 0, failed: 1, active: 0 });
  assert.equal(JSON.stringify(owner.stats()).includes("private"), false);
  await owner.stop();
});
