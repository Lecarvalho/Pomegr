import assert from "node:assert/strict";
import test from "node:test";
import { createSessionObservationCoordinator } from "../../../server/runtime/session-observation-coordinator.mjs";

// How often the coordinator publishes a session and commits the catalog, counted with a clock
// that moves only when a test moves it. The tests assert scheduled delays and counts, never a
// wall-clock duration.
const SPACING_MS = 500;

// Lets the commit that a timer started finish before the next timer runs, as the event loop does.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function manualClock() {
  let clock = 0;
  const jobs = [];
  return {
    now: () => clock,
    move(milliseconds) { clock += milliseconds; },
    schedule(task, delay) { const job = { task, delay, at: clock + delay, cancelled: false, ran: false }; jobs.push(job); return job; },
    cancel(job) { if (job) job.cancelled = true; },
    /** The delays of the timers a call schedules before it returns. */
    scheduledBy(call) {
      const before = jobs.length;
      call();
      return jobs.slice(before).map((job) => job.delay);
    },
    async advance(milliseconds) {
      const target = clock + milliseconds;
      for (;;) {
        const next = jobs.filter((job) => !job.cancelled && !job.ran && job.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        clock = next.at;
        next.ran = true;
        await next.task();
        await settle();
      }
      clock = Math.max(clock, target);
    },
  };
}

// The schedule this change replaces: the first pending candidate starts a fixed delay, later
// candidates join it, and the next candidate after that publication starts another. Returns
// each candidate's publication time. The counts it gives for the cadences below were checked
// against the previous coordinator.
function fixedDelayPublications(arrivals, delayMs = SPACING_MS) {
  let due = -Infinity;
  return arrivals.map((at) => { if (at >= due) due = at + delayMs; return due; });
}

async function startCoordinator({ records = [], derive, trace } = {}) {
  const clock = manualClock();
  const publications = [];
  const derivations = [];
  const catalogCommits = [];
  const snapshots = new Map();
  const accept = (candidate, revision) => {
    const snapshot = Object.freeze({ ...candidate, qualifiedId: `${candidate.providerId}:${candidate.localSessionId}`, revision, serializedState: JSON.stringify(candidate.publicState) });
    snapshots.set(snapshot.qualifiedId, snapshot);
    return snapshot;
  };
  const store = {
    getByQualifiedId(id) { return snapshots.get(id) || null; },
    setPinned() {},
    restore(candidate) { return { accepted: true, snapshot: accept(candidate, candidate.revision || 1) }; },
    publish(candidate) {
      const previous = snapshots.get(`${candidate.providerId}:${candidate.localSessionId}`);
      if (previous?.serializedState === JSON.stringify(candidate.publicState)) return { accepted: true, unchanged: true, snapshot: previous };
      const snapshot = accept(candidate, (previous?.revision || 0) + 1);
      publications.push({ id: snapshot.qualifiedId, at: clock.now(), version: candidate.publicState.version });
      return { accepted: true, snapshot };
    },
  };
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: "codex", source: "Codex" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store, schedule: clock.schedule, cancel: clock.cancel, now: clock.now, monotonicNow: clock.now, pipelineTrace: trace,
    checkpointStore: records.length ? { async load() { return { records }; }, async write() {} } : null,
    async deriveSession(candidate) {
      derivations.push({ id: candidate.localSessionId, at: clock.now() });
      if (derive) return derive(candidate, clock);
      return { readiness: { core: "ready" }, publicState: { version: candidate.evidence.version } };
    },
  });
  coordinator.subscribe((event) => { if (event.type === "catalog") catalogCommits.push(clock.now()); });
  await coordinator.start();
  await settle();
  const liveRows = (ids) => ids.map((localId) => ({ localId, title: localId, isLive: true, activityStatus: "working" }));
  return {
    clock, coordinator, publications, derivations, catalogCommits, store,
    publish: (localId, version) => publisher.publishSession("codex", localId, { version, historical: false, session: {} }),
    async catalog(ids) { publisher.publishCatalog("codex", liveRows(ids)); await clock.advance(0); },
  };
}

const gaps = (times) => times.slice(1).map((time, index) => time - times[index]);

test("a quiet session's candidate is scheduled with no delay and the next one waits out the spacing", async () => {
  const monitor = await startCoordinator();
  await monitor.catalog(["one"]);
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish("one", 1)), [0]);
  await monitor.clock.advance(0);
  assert.deepEqual(monitor.publications.map(({ at, version }) => [at, version]), [[0, 1]]);

  await monitor.clock.advance(120);
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish("one", 2)), [380], "500 ms after the publication at 0");
  await monitor.clock.advance(200);
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish("one", 3)), [], "a later candidate joins the pending publication");
  await monitor.clock.advance(180);
  assert.deepEqual(monitor.publications.map(({ at, version }) => [at, version]), [[0, 1], [500, 3]]);

  await monitor.clock.advance(SPACING_MS);
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish("one", 4)), [0], "quiet again once the spacing has elapsed");
  await monitor.coordinator.stop();
});

// `before` is what the fixed delay published for the same candidates, and `now` is what the
// spacing publishes. Both have the same ceiling of one publication per 500 ms. A candidate cadence
// that divides 500 ms already ran at that ceiling, so only the prompt first publication is added.
// At another cadence the fixed delay restarted from the first candidate after each publication
// and so ran below the ceiling; the spacing runs at it.
for (const { cadence, before, now } of [
  { cadence: 10, before: 11, now: 12 },
  { cadence: 50, before: 11, now: 12 },
  { cadence: 100, before: 11, now: 12 },
  { cadence: 250, before: 11, now: 12 },
  { cadence: 70, before: 9, now: 11 },
  { cadence: 300, before: 9, now: 11 },
  { cadence: 499, before: 6, now: 11 },
]) {
  test(`a continuous burst of one candidate per ${cadence} ms publishes at most once per 500 ms`, async () => {
    const monitor = await startCoordinator();
    await monitor.catalog(["one"]);
    const catalogCommitsBefore = monitor.catalogCommits.length;
    const arrivals = [];
    for (let at = 0; at <= 5_000; at += cadence) {
      arrivals.push(at);
      monitor.publish("one", arrivals.length);
      await monitor.clock.advance(cadence);
    }
    await monitor.clock.advance(1_000);
    const published = monitor.publications.map((entry) => entry.at);
    const catalogCommits = monitor.catalogCommits.slice(catalogCommitsBefore);

    assert.equal(published.length, now);
    assert.equal(new Set(fixedDelayPublications(arrivals)).size, before, "the fixed delay's count for the same candidates");
    assert.ok(gaps(published).every((gap) => gap >= SPACING_MS), `publications are at least 500 ms apart: ${published}`);
    assert.ok(published.length <= Math.floor((published.at(-1) - published[0]) / SPACING_MS) + 1, "never above one per 500 ms");
    assert.deepEqual(catalogCommits, published, "one catalog commit per publication, in the same turn");
    assert.equal(monitor.derivations.length, published.length, "no derivation is started and thrown away");
    assert.equal(monitor.publications.at(-1).version, arrivals.length, "the last candidate is published");
    // No candidate waits longer than the fixed delay's worst case, and the first does not wait.
    const waits = arrivals.map((arrival, index) => monitor.publications.find((entry) => entry.version >= index + 1).at - arrival);
    assert.ok(waits.every((wait) => wait >= 0 && wait <= SPACING_MS), `waits: ${waits}`);
    assert.equal(waits[0], 0);
    assert.equal(Math.max(...fixedDelayPublications(arrivals).map((due, index) => due - arrivals[index])), SPACING_MS);
    await monitor.coordinator.stop();
  });
}

test("two writes 300 ms apart publish twice, the first at once and the second no later than before", async () => {
  // The fixed delay absorbed both into one publication 500 ms after the first. The earlier write
  // cannot be published promptly and still wait for a write that has not happened yet.
  const monitor = await startCoordinator();
  await monitor.catalog(["one"]);
  monitor.publish("one", 1);
  await monitor.clock.advance(300);
  monitor.publish("one", 2);
  await monitor.clock.advance(2_000);
  assert.deepEqual(monitor.publications.map(({ at, version }) => [at, version]), [[0, 1], [500, 2]]);
  assert.deepEqual([...new Set(fixedDelayPublications([0, 300]))], [500]);
  await monitor.coordinator.stop();
});

test("many sessions arriving together publish once each and share one catalog commit, as before", async () => {
  const ids = Array.from({ length: 40 }, (_, index) => `together-${index}`);
  const monitor = await startCoordinator();
  await monitor.catalog(ids);
  const catalogCommitsBefore = monitor.catalogCommits.length;
  const delays = monitor.clock.scheduledBy(() => { for (const id of ids) monitor.publish(id, 1); });
  assert.deepEqual(delays, ids.map(() => 0), "one timer per session");
  await monitor.clock.advance(2_000);
  // The fixed delay gave the same counts, 500 ms later: 40 publications, 40 derivations, 1 catalog commit.
  assert.equal(monitor.publications.length, 40);
  assert.equal(monitor.derivations.length, 40);
  assert.equal(monitor.catalogCommits.length - catalogCommitsBefore, 1);
  await monitor.coordinator.stop();
});

function checkpointRecords(count) {
  return Array.from({ length: count }, (_, index) => ({
    providerId: "codex", localSessionId: `restored-${index}`, revision: 3,
    evidence: { historical: false, version: 1, agents: [], session: {} },
    publicState: { version: 0 }, readiness: { core: "ready" }, observedAt: "2026-08-30T12:00:00.000Z", source: null,
  }));
}

test("a checkpoint restore keeps its gathering delay: no rederivation starts early and none is added", async () => {
  const monitor = await startCoordinator({ records: checkpointRecords(40) });
  assert.equal(monitor.store.getByQualifiedId("codex:restored-0").revision, 3, "the restored revision is served at once");
  await monitor.clock.advance(SPACING_MS - 1);
  assert.equal(monitor.derivations.length, 0, "nothing derives inside the gathering delay");
  await monitor.clock.advance(1);
  // The fixed delay gave the same: 40 rederivations and publications at 500 ms, 1 catalog commit.
  assert.deepEqual([...new Set(monitor.derivations.map((entry) => entry.at))], [SPACING_MS]);
  assert.equal(monitor.derivations.length, 40);
  assert.equal(monitor.publications.length, 40);
  assert.equal(monitor.catalogCommits.length, 1);
  await monitor.clock.advance(5_000);
  assert.equal(monitor.derivations.length, 40);
  await monitor.coordinator.stop();
});

test("fresh evidence that arrives during a restore joins the restore's deadline", async () => {
  const monitor = await startCoordinator({ records: checkpointRecords(40) });
  await monitor.clock.advance(100);
  for (let index = 0; index < 10; index += 1) {
    assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish(`restored-${index}`, 2)), [], `restored-${index} keeps the restore's timer`);
  }
  await monitor.clock.advance(5_000);
  // As before: one batch at 500 ms, the ten fresh candidates in place of their restored ones.
  assert.deepEqual([...new Set(monitor.publications.map((entry) => entry.at))], [SPACING_MS]);
  assert.equal(monitor.publications.length, 40);
  assert.equal(monitor.publications.filter((entry) => entry.version === 2).length, 10);
  assert.equal(monitor.derivations.length, 40);
  assert.equal(monitor.catalogCommits.length, 1);
  await monitor.coordinator.stop();
});

test("a downstream refresh of many sessions keeps its gathering delay and fresh evidence absorbs it", async () => {
  const ids = Array.from({ length: 20 }, (_, index) => `refreshed-${index}`);
  let resources = 0;
  const monitor = await startCoordinator({
    derive: ({ evidence }) => ({ readiness: { core: "ready" }, publicState: { version: evidence.version, resources } }),
  });
  await monitor.catalog(ids);
  for (const id of ids) monitor.publish(id, 1);
  await monitor.clock.advance(5_000);
  const before = { publications: monitor.publications.length, derivations: monitor.derivations.length, catalogCommits: monitor.catalogCommits.length };

  resources = 1;
  const delays = monitor.clock.scheduledBy(() => { for (const id of ids) assert.equal(monitor.coordinator.refreshProjection(`codex:${id}`), true); });
  assert.deepEqual(delays, ids.map(() => SPACING_MS));
  await monitor.clock.advance(200);
  // New evidence for one of them: it publishes now and carries the refresh with it.
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish(ids[0], 2)), [0]);
  await monitor.clock.advance(0);
  assert.deepEqual(monitor.publications.at(-1), { id: `codex:${ids[0]}`, at: 5_200, version: 2 });
  await monitor.clock.advance(5_000);
  assert.equal(monitor.publications.length - before.publications, 20, "one publication per session, not one more for the refresh");
  assert.equal(monitor.derivations.length - before.derivations, 20);
  assert.equal(monitor.catalogCommits.length - before.catalogCommits, 2, "the prompt one and the gathered batch");
  await monitor.coordinator.stop();
});

test("a fresh candidate just after a gathered publication waits out the same spacing", async () => {
  let resources = 0;
  const monitor = await startCoordinator({
    derive: ({ evidence }) => ({ readiness: { core: "ready" }, publicState: { version: evidence.version, resources } }),
  });
  await monitor.catalog(["one"]);
  monitor.publish("one", 1);
  await monitor.clock.advance(5_000);
  resources = 1;
  monitor.coordinator.refreshProjection("codex:one");
  await monitor.clock.advance(SPACING_MS);
  assert.equal(monitor.publications.at(-1).at, 5_500);
  await monitor.clock.advance(100);
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish("one", 2)), [400]);
  await monitor.clock.advance(400);
  assert.deepEqual(gaps(monitor.publications.map((entry) => entry.at)), [5_500, 500]);
  await monitor.coordinator.stop();
});

test("a candidate superseded during derivation is followed at once by the newer one, without overlap", async () => {
  const gates = [];
  const monitor = await startCoordinator({
    derive: ({ evidence }) => new Promise((resolve) => {
      gates.push(() => resolve({ readiness: { core: "ready" }, publicState: { version: evidence.version } }));
    }),
  });
  await monitor.catalog(["one"]);
  monitor.publish("one", 1);
  await monitor.clock.advance(0);
  assert.equal(monitor.derivations.length, 1, "the first candidate is deriving");

  await monitor.clock.advance(3);
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish("one", 2)), [SPACING_MS], "no second derivation beside the first");
  await monitor.clock.advance(4);
  const moved = monitor.clock.scheduledBy(() => gates.shift()());
  await settle();
  assert.deepEqual(moved, [], "the release itself schedules nothing");
  assert.equal(monitor.publications.length, 0, "the superseded result is not published");
  await monitor.clock.advance(0);
  assert.deepEqual(monitor.derivations.map((entry) => entry.at), [0, 7], "the newer candidate derives when the older one ends, not 500 ms later");
  gates.shift()();
  await settle();
  assert.deepEqual(monitor.publications.map(({ at, version }) => [at, version]), [[7, 2]]);
  await monitor.clock.advance(5_000);
  assert.equal(monitor.derivations.length, 2);
  await monitor.coordinator.stop();
});

test("a failed derivation keeps the committed revision and backs off as before", async () => {
  let failing = false;
  const monitor = await startCoordinator({
    derive: ({ evidence }) => {
      if (failing) throw new Error("Synthetic derivation failure");
      return { readiness: { core: "ready" }, publicState: { version: evidence.version } };
    },
  });
  await monitor.catalog(["one"]);
  monitor.publish("one", 1);
  await monitor.clock.advance(1_000);
  failing = true;
  monitor.publish("one", 2);
  await monitor.clock.advance(60_000);
  // One attempt and five retries, 1, 2, 4, 8, and 16 seconds apart, then the candidate is dropped.
  assert.deepEqual(monitor.derivations.slice(1).map((entry) => entry.at - 1_000), [0, 1_000, 3_000, 7_000, 15_000, 31_000]);
  assert.equal(monitor.store.getByQualifiedId("codex:one").publicState.version, 1);
  assert.equal(monitor.publications.length, 1);
  await monitor.coordinator.stop();
});

test("fresh evidence moves a failure retry forward, but not inside the spacing after the failed attempt", async () => {
  let failing = true;
  const monitor = await startCoordinator({
    derive: ({ evidence }) => {
      if (failing) throw new Error("Synthetic derivation failure");
      return { readiness: { core: "ready" }, publicState: { version: evidence.version } };
    },
  });
  await monitor.catalog(["one"]);
  monitor.publish("one", 1);
  await monitor.clock.advance(100);
  failing = false;
  assert.deepEqual(monitor.clock.scheduledBy(() => monitor.publish("one", 2)), [400], "ahead of the retry at 1,000 ms");
  await monitor.clock.advance(400);
  assert.deepEqual(monitor.publications.map(({ at, version }) => [at, version]), [[500, 2]]);
  await monitor.clock.advance(60_000);
  assert.equal(monitor.derivations.length, 2, "the replaced retry never runs");
  await monitor.coordinator.stop();
});

test("candidate_to_commit still measures from the queued candidate to its store commit", async () => {
  const stages = [];
  const trace = {
    begin: () => null, end() {}, createFlow: () => null, finishFlow() {},
    recordDuration(record) { if (record.stage === "candidate_to_commit" || record.stage === "session_commit_wait") stages.push([record.stage, record.durationMs, record.outcome]); },
  };
  const monitor = await startCoordinator({
    trace,
    derive: ({ evidence }, clock) => { clock.move(5); return { readiness: { core: "ready" }, publicState: { version: evidence.version } }; },
  });
  await monitor.catalog(["one"]);
  monitor.publish("one", 1);
  await monitor.clock.advance(0);
  // A quiet session: only the derivation stands between the candidate and its commit.
  assert.deepEqual(stages, [["session_commit_wait", 0, undefined], ["candidate_to_commit", 5, "accepted"]]);
  assert.equal(monitor.coordinator.diagnostics().timings.sessionCandidateToCommit.lastMs, 5);

  stages.length = 0;
  await monitor.clock.advance(95);
  monitor.publish("one", 2);
  await monitor.clock.advance(SPACING_MS);
  // Queued 100 ms after start, 95 ms after the commit at 5: it waits out the remaining 405 ms.
  assert.deepEqual(stages, [["session_commit_wait", 405, undefined], ["candidate_to_commit", 410, "accepted"]]);
  await monitor.coordinator.stop();
});
