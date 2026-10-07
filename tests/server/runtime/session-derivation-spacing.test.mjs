import assert from "node:assert/strict";
import test from "node:test";
import { createSessionObservationCoordinator } from "../../../server/runtime/session-observation-coordinator.mjs";

// How often one session's derivations start when a derivation takes time, fails, or is replaced
// while it runs. Derivations last as long as the test's clock says; nothing asserts a wall-clock
// duration.
const SPACING_MS = 500;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function manualClock() {
  let clock = 0;
  const jobs = [];
  return {
    now: () => clock,
    schedule(task, delay) { const job = { task, delay, at: clock + delay, cancelled: false, ran: false }; jobs.push(job); return job; },
    cancel(job) { if (job) job.cancelled = true; },
    /** The delays of the timers a call schedules before it returns. */
    scheduledBy(call) {
      const before = jobs.length;
      call();
      return jobs.slice(before).map((job) => job.delay);
    },
    async advanceTo(target) {
      for (;;) {
        const next = jobs.filter((job) => !job.cancelled && !job.ran && job.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        clock = Math.max(clock, next.at);
        next.ran = true;
        await next.task();
        await settle();
      }
      clock = Math.max(clock, target);
    },
  };
}

// `duration(version)` is how long that candidate's derivation runs; `fails(version)` rejects it.
// The store reports an identical state as unchanged and rejects the versions in `rejected`.
async function startCoordinator({ duration = () => 0, fails = () => false, rejected = [] } = {}) {
  const clock = manualClock();
  const starts = [];
  const publications = [];
  const snapshots = new Map();
  const store = {
    getByQualifiedId(id) { return snapshots.get(id) || null; },
    setPinned() {},
    publish(candidate) {
      const id = `${candidate.providerId}:${candidate.localSessionId}`;
      if (rejected.includes(candidate.publicState.version)) return { accepted: false };
      const previous = snapshots.get(id);
      const serializedState = JSON.stringify(candidate.publicState);
      if (previous?.serializedState === serializedState) return { accepted: true, unchanged: true, snapshot: previous };
      const snapshot = Object.freeze({ ...candidate, qualifiedId: id, revision: (previous?.revision || 0) + 1, serializedState });
      snapshots.set(id, snapshot);
      publications.push({ at: clock.now(), version: candidate.publicState.version });
      return { accepted: true, snapshot };
    },
  };
  let publisher;
  let refreshes = 0;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex", source: "Codex" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store, schedule: clock.schedule, cancel: clock.cancel, now: clock.now, monotonicNow: clock.now,
    deriveSession: ({ evidence, freshObservation }) => new Promise((resolve, reject) => {
      const version = evidence.version;
      starts.push({ at: clock.now(), version, fresh: freshObservation === true });
      const finish = () => (fails(version) ? reject(new Error("Synthetic derivation failure"))
        : resolve({ readiness: { core: "ready" }, publicState: { version, refreshes: freshObservation ? 0 : (refreshes += 1) } }));
      if (duration(version) === 0) finish();
      else clock.schedule(finish, duration(version));
    }),
  });
  await coordinator.start();
  await settle();
  return {
    clock, coordinator, starts, publications, startTimes: () => starts.map((entry) => entry.at),
    publisher: () => publisher,
    publish: (version) => publisher.publishSession("codex", "one", { version, session: {} }),
  };
}

const gaps = (times) => times.slice(1).map((time, index) => time - times[index]);
const every = (cadence, end) => Array.from({ length: Math.floor(end / cadence) + 1 }, (_, index) => index * cadence);

// `before` was measured on the coordinator that used a fixed delay from the first pending
// candidate, with this harness. In each burst every derivation but the last is replaced while
// it runs, before and now, so the burst publishes once, after its last candidate.
for (const { name, arrivals, derivationMs, before, derivations } of [
  { name: "one candidate per 50 ms, 100 ms derivations", arrivals: every(50, 10_000), derivationMs: 100, before: { derivations: 21, published: 10_600 }, derivations: 22 },
  { name: "one candidate per 100 ms, 150 ms derivations", arrivals: every(100, 10_000), derivationMs: 150, before: { derivations: 21, published: 10_650 }, derivations: 22 },
  { name: "one candidate per 130 ms and a last one at 1,390 ms, 300 ms derivations", arrivals: [...every(130, 1_300), 1_390], derivationMs: 300, before: { derivations: 3, published: 1_840 }, derivations: 4 },
  { name: "one candidate per 200 ms, 300 ms derivations", arrivals: every(200, 3_000), derivationMs: 300, before: { derivations: 6, published: 3_800 }, derivations: 8 },
]) {
  test(`a burst with slow derivations starts at most one per 500 ms: ${name}`, async () => {
    const monitor = await startCoordinator({ duration: () => derivationMs });
    for (const [index, at] of arrivals.entries()) {
      await monitor.clock.advanceTo(at);
      monitor.publish(index + 1);
    }
    await monitor.clock.advanceTo(arrivals.at(-1) + 5_000);
    const starts = monitor.startTimes();
    assert.equal(starts[0], 0, "the first candidate of the quiet session derives at once");
    assert.ok(gaps(starts).every((gap) => gap >= SPACING_MS), `derivation starts are at least 500 ms apart: ${starts}`);
    assert.equal(starts.length, derivations, `the fixed delay started ${before.derivations}`);
    // No candidate waits more than the spacing for a derivation to start, as with the fixed delay.
    for (const arrival of arrivals) assert.ok(starts.some((start) => start >= arrival && start - arrival <= SPACING_MS), `candidate at ${arrival}`);
    assert.equal(monitor.publications.at(-1).version, arrivals.length, "the last candidate is published");
    assert.ok(monitor.publications.at(-1).at <= before.published, `published at ${monitor.publications.at(-1).at}, the fixed delay at ${before.published}`);
    await monitor.coordinator.stop();
  });
}

test("overlapping derivations keep their starts 500 ms apart, though their publications land closer", async () => {
  // The spacing is between derivation starts. A slow derivation followed by faster ones
  // publishes closer together than 500 ms, as it did with the fixed delay.
  const monitor = await startCoordinator({ duration: (version) => ({ 1: 700, 2: 300, 3: 0 })[version] });
  monitor.publish(1);
  await monitor.clock.advanceTo(100);
  monitor.publish(2);
  await monitor.clock.advanceTo(950);
  monitor.publish(3);
  await monitor.clock.advanceTo(5_000);
  assert.deepEqual(monitor.startTimes(), [0, 500, 1_000]);
  assert.deepEqual(monitor.publications, [{ at: 800, version: 2 }, { at: 1_000, version: 3 }]);
  await monitor.coordinator.stop();
});

test("a superseded derivation that ends late does not move a failing candidate's retry forward", async () => {
  const monitor = await startCoordinator({ duration: (version) => (version === 1 ? 2_000 : 0), fails: (version) => version === 2 });
  monitor.publish(1);
  await monitor.clock.advanceTo(100);
  monitor.publish(2);
  await monitor.clock.advanceTo(80_000);
  // The first candidate at 0, then the failing one and its retries 1, 2, 4, 8, and 16 seconds apart.
  assert.deepEqual(monitor.startTimes(), [0, 500, 1_500, 3_500, 7_500, 15_500, 31_500]);
  assert.equal(monitor.publications.length, 0);
  await monitor.coordinator.stop();
});

test("a refresh queued after an invalidation during a derivation keeps its gathering delay", async () => {
  const monitor = await startCoordinator({ duration: (version) => (version === 2 ? 300 : 0) });
  monitor.publish(1);
  await monitor.clock.advanceTo(10_000);
  monitor.publish(2);
  await monitor.clock.advanceTo(10_050);
  monitor.publisher().invalidateSession("codex", "one", "source_changed");
  assert.equal(monitor.coordinator.refreshProjection("codex:one"), true);
  await monitor.clock.advanceTo(20_000);
  // The dropped derivation ends at 10,300. The refresh is not new evidence and waits until 10,550.
  assert.deepEqual(monitor.starts.slice(1), [{ at: 10_000, version: 2, fresh: true }, { at: 10_550, version: 1, fresh: false }]);
  await monitor.coordinator.stop();
});

test("an obsolete failure does not mark the newer candidate as a retry", async () => {
  const monitor = await startCoordinator({ duration: (version) => (version === 1 ? 150 : 0), fails: () => true });
  monitor.publish(1);
  await monitor.clock.advanceTo(100);
  monitor.publish(2);
  await monitor.clock.advanceTo(4_000);
  // The newer candidate's own first failure is followed by the first backoff step, one second.
  assert.deepEqual(monitor.startTimes(), [0, 500, 1_500, 3_500]);
  await monitor.coordinator.stop();
});

test("an obsolete failure that ends after newer work published does not delay the next candidate", async () => {
  const monitor = await startCoordinator({ duration: (version) => (version === 1 ? 2_000 : 0), fails: (version) => version === 1 });
  monitor.publish(1);
  await monitor.clock.advanceTo(100);
  monitor.publish(2);
  await monitor.clock.advanceTo(2_100);
  assert.deepEqual(monitor.publications, [{ at: 500, version: 2 }]);
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish(3)), [0], "the failure at 2,000 belongs to no pending work");
  await monitor.clock.advanceTo(70_000);
  assert.deepEqual(monitor.startTimes(), [0, 500, 2_100], "and nothing is retried");
  await monitor.coordinator.stop();
});

test("an unchanged or rejected store commit still spaces the next derivation", async () => {
  const monitor = await startCoordinator({ rejected: [99] });
  monitor.publish(1);
  await monitor.clock.advanceTo(1_000);
  monitor.publish(1);
  await monitor.clock.advanceTo(1_100);
  assert.equal(monitor.publications.length, 1, "the identical candidate committed nothing");
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish(2)), [400], "500 ms after the unchanged attempt started");
  await monitor.clock.advanceTo(3_000);
  monitor.publish(99);
  await monitor.clock.advanceTo(3_100);
  assert.deepEqual(monitor.publications.map((entry) => entry.version), [1, 2], "the store rejected the candidate");
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish(3)), [400], "500 ms after the rejected attempt started");
  await monitor.coordinator.stop();
});

test("stopping cancels pending publication timers and forgets derivation starts", async () => {
  const monitor = await startCoordinator();
  monitor.publish(1);
  await monitor.clock.advanceTo(100);
  monitor.publish(2);
  assert.equal(monitor.coordinator.persistenceBusy(), true);
  await monitor.coordinator.stop();
  assert.equal(monitor.coordinator.persistenceBusy(), false, "no publication timer is left");
  await monitor.clock.advanceTo(200);
  await monitor.coordinator.start();
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish(3)), [0], "the start before the stop no longer spaces new work");
  await monitor.clock.advanceTo(5_000);
  assert.deepEqual(monitor.starts.map((entry) => entry.version), [1, 3]);
  await monitor.coordinator.stop();
});
