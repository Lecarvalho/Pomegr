import assert from "node:assert/strict";
import test from "node:test";
import { createObservationPersistenceQueue } from "../monitor/observation-persistence-queue.mjs";

function snapshot(session, revision, extra = {}) {
  return { providerId: "claude", localSessionId: session, revision, source: null,
    evidence: { agents: [{ id: "primary" }], revision }, readiness: { session: "ready" },
    observedAt: "2026-09-27T12:00:00.000Z", publicState: { prompt: "MUST_NOT_RETAIN" }, ...extra };
}

test("coalesces a hot session, keeps cold FIFO fairness, and drops public state", async () => {
  const writes = [];
  const queue = createObservationPersistenceQueue({ write: async (value) => writes.push(value), maxPending: 3 });
  queue.enqueue(snapshot("hot", 1));
  queue.enqueue(snapshot("cold", 1));
  queue.enqueue(snapshot("hot", 4));
  await queue.drain();
  assert.deepEqual(writes.map((value) => [value.localSessionId, value.revision]), [["hot", 4], ["cold", 1]]);
  assert.equal("publicState" in writes[0], false);
  assert.equal(queue.stats().coalesced, 1);
});

test("bounds new keys while allowing newest same-key replacement", async () => {
  const writes = [];
  const queue = createObservationPersistenceQueue({ write: async (value) => writes.push(value), maxPending: 1 });
  assert.equal(queue.enqueue(snapshot("a", 1)).accepted, true);
  assert.equal(queue.enqueue(snapshot("b", 1)).accepted, false);
  assert.equal(queue.enqueue(snapshot("a", 2)).accepted, true);
  await queue.drain();
  assert.deepEqual(writes.map((value) => [value.localSessionId, value.revision]), [["a", 2]]);
});

test("ten thousand active hot revisions keep one ready entry and do not starve other sessions", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writes = [];
  const queue = createObservationPersistenceQueue({ maxPending: 4, write: async (value) => {
    writes.push([value.localSessionId, value.revision]);
    if (writes.length === 1) await gate;
  } });
  queue.enqueue(snapshot("hot", 1));
  await Promise.resolve();
  queue.enqueue(snapshot("cold-a", 1));
  queue.enqueue(snapshot("cold-b", 1));
  for (let revision = 2; revision <= 10_000; revision += 1) {
    assert.equal(queue.enqueue(snapshot("hot", revision)).accepted, true);
    assert.ok(queue.stats().ready <= 3);
    assert.ok(queue.stats().bytes <= queue.stats().maxBytes);
  }
  const closing = queue.stop();
  assert.equal(queue.enqueue(snapshot("after-stop", 1)).accepted, false);
  release(); await closing;
  assert.deepEqual(writes, [["hot", 1], ["cold-a", 1], ["cold-b", 1], ["hot", 10_000]]);
  assert.equal(queue.stats().coalesced, 9_999);
});

test("valid large normalized collections are bounded by bytes rather than an acquisition row limit", async () => {
  const queue = createObservationPersistenceQueue({ write: async () => {} });
  const evidence = { activity: Array.from({ length: 10_000 }, (_, index) => ({ id: `activity-${index}` })) };
  assert.equal(queue.enqueue(snapshot("retained", 1, { evidence })).accepted, true);
  await queue.stop();
});

test("retries at the tail and exhausts bounded attempts without retaining waiters", async () => {
  const writes = [];
  const attempts = new Map();
  const queue = createObservationPersistenceQueue({
    retryDelayMs: 0, maxAttempts: 2,
    write: async (value) => {
      attempts.set(value.localSessionId, (attempts.get(value.localSessionId) || 0) + 1);
      if (value.localSessionId === "bad") throw new Error("disk unavailable");
      writes.push(value.localSessionId);
    },
  });
  queue.enqueue(snapshot("bad", 1));
  queue.enqueue(snapshot("good", 1));
  await queue.drain();
  assert.deepEqual(writes, ["good"]);
  assert.equal(attempts.get("bad"), 2);
  assert.equal(queue.stats().exhausted, 1);
  assert.equal(queue.stats().pending, 0);
});

test("zero-delay writes start asynchronously and stop deterministically drains", async () => {
  let calls = 0;
  const queue = createObservationPersistenceQueue({ write: async () => { calls += 1; } });
  queue.enqueue(snapshot("later", 1));
  assert.equal(calls, 0);
  await queue.stop();
  assert.equal(calls, 1);
  assert.equal(queue.stats().pending, 0);
});

test("an active hot replacement survives the older write and is persisted newest", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writes = [];
  const queue = createObservationPersistenceQueue({ write: async (value) => {
    writes.push(value.revision);
    if (value.revision === 1) await gate;
  } });
  queue.enqueue(snapshot("hot", 1));
  await Promise.resolve();
  queue.enqueue(snapshot("hot", 2));
  release();
  await queue.drain();
  assert.deepEqual(writes, [1, 2]);
  assert.equal(queue.stats().pending, 0);
});

test("byte bounds reject oversized and growing replacements", async () => {
  const queue = createObservationPersistenceQueue({ write: async () => {}, maxBytes: 2_000 });
  assert.equal(queue.enqueue(snapshot("a", 1, { evidence: { text: "x".repeat(10_000) } })).accepted, false);
  assert.equal(queue.enqueue(snapshot("a", 1)).accepted, true);
  assert.equal(queue.enqueue(snapshot("a", 2, { evidence: { text: "x".repeat(10_000) } })).accepted, false);
  await queue.stop();
});

test("drain forces delayed retry attempts to bounded exhaustion", async () => {
  let attempts = 0;
  const queue = createObservationPersistenceQueue({ maxAttempts: 3, retryDelayMs: 60_000, write: async () => { attempts += 1; throw new Error("fail"); } });
  queue.enqueue(snapshot("bad", 1));
  await queue.drain();
  assert.equal(attempts, 3);
  assert.equal(queue.stats().exhausted, 1);
});
