import assert from "node:assert/strict";
import test from "node:test";
import { createSessionPublicationSchedule } from "../../../server/runtime/session-publication-schedule.mjs";

// A clock that moves only when the test moves it. The tests assert the delay each timer was
// scheduled with and the clock time it is due at, never how long anything took.
function manualClock() {
  let clock = 0;
  const jobs = [];
  return {
    now: () => clock,
    set(value) { clock = value; },
    // The pending timers, as [delay it was scheduled with, clock time it is due at].
    timers: () => jobs.filter((job) => !job.cancelled && !job.ran).map((job) => [job.delay, job.at]),
    schedule(task, delay) { const job = { task, delay, at: clock + delay, cancelled: false, ran: false }; jobs.push(job); return job; },
    cancel(job) { job.cancelled = true; },
    advance(milliseconds) {
      const target = clock + milliseconds;
      for (;;) {
        const next = jobs.filter((job) => !job.cancelled && !job.ran && job.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        clock = next.at;
        next.ran = true;
        next.task();
      }
      clock = target;
    },
  };
}

function harness(spacingMs = 500) {
  const clock = manualClock();
  const published = [];
  // The owner settles each publication when it reaches the store; these tests settle at once.
  const schedule = createSessionPublicationSchedule({
    schedule: clock.schedule, cancel: clock.cancel, now: clock.now, spacingMs,
    publish(id) { published.push([id, clock.now()]); schedule.settled(id); },
  });
  return { clock, published, schedule };
}

test("a quiet session's fresh candidate is scheduled with no delay", () => {
  const { clock, published, schedule } = harness();
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[0, 0]]);
  clock.advance(0);
  assert.deepEqual(published, [["a", 0]]);
  assert.equal(schedule.pending(), false);
});

test("a fresh candidate after a publication waits the rest of the spacing, and later ones join it", () => {
  const { clock, published, schedule } = harness();
  schedule.fresh("a");
  clock.advance(120);
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[380, 500]], "500 ms after the publication at 0");
  clock.advance(200);
  schedule.fresh("a");
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[380, 500]], "a later candidate neither adds a timer nor moves the deadline");
  clock.advance(180);
  assert.deepEqual(published, [["a", 0], ["a", 500]]);
  clock.advance(500);
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[0, 1_000]], "the spacing has elapsed, so the session is quiet again");
});

test("a fractional remainder is rounded up, so a timer never fires inside the spacing", () => {
  const { clock, schedule } = harness();
  schedule.fresh("a");
  clock.advance(0);
  clock.set(120.25);
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[380, 500.25]]);
});

test("sessions are spaced independently", () => {
  const { clock, published, schedule } = harness();
  schedule.fresh("a");
  clock.advance(100);
  schedule.fresh("b");
  assert.deepEqual(clock.timers(), [[0, 100]]);
  clock.advance(0);
  assert.deepEqual(published, [["a", 0], ["b", 100]]);
});

test("a gathered rederivation waits the full spacing and a fresh candidate moves it forward", () => {
  const { clock, published, schedule } = harness();
  schedule.gathered("a");
  assert.deepEqual(clock.timers(), [[500, 500]]);
  clock.advance(200);
  schedule.gathered("a");
  assert.deepEqual(clock.timers(), [[500, 500]], "a second refresh joins the first");
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[0, 200]], "one timer, moved forward");
  clock.advance(0);
  assert.deepEqual(published, [["a", 200]]);
  clock.advance(1_000);
  assert.deepEqual(published, [["a", 200]], "the replaced timer never fires");
});

test("a gathered rederivation right after a publication still waits the full spacing", () => {
  const { clock, schedule } = harness();
  schedule.fresh("a");
  clock.advance(100);
  schedule.gathered("a");
  assert.deepEqual(clock.timers(), [[500, 600]]);
});

test("a restore holds its deadline against fresh evidence", () => {
  const { clock, published, schedule } = harness();
  schedule.restored("a");
  schedule.restored("b");
  clock.advance(100);
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[500, 500], [500, 500]]);
  clock.advance(400);
  assert.deepEqual(published, [["a", 500], ["b", 500]]);
});

test("a fresh candidate moves a retry forward, but only as far as the spacing permits", () => {
  const { clock, published, schedule } = harness();
  schedule.fresh("a");
  clock.advance(0);
  schedule.retry("a", 1_000);
  assert.deepEqual(clock.timers(), [[1_000, 1_000]]);
  clock.advance(100);
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[400, 500]]);
  clock.advance(400);
  assert.deepEqual(published, [["a", 0], ["a", 500]]);
});

test("a retry never replaces a timer that is already set", () => {
  const { clock, schedule } = harness();
  schedule.gathered("a");
  schedule.retry("a", 4_000);
  assert.deepEqual(clock.timers(), [[500, 500]]);
});

test("a fresh candidate behind a derivation in flight keeps the full spacing until that derivation ends", () => {
  const clock = manualClock();
  const started = [];
  const schedule = createSessionPublicationSchedule({
    schedule: clock.schedule, cancel: clock.cancel, now: clock.now, spacingMs: 500,
    publish(id) { started.push([id, clock.now()]); },
  });
  schedule.fresh("a");
  clock.advance(0);
  const ended = schedule.derivationStarted("a");
  clock.advance(3);
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[500, 503]], "no second derivation starts beside the first");
  clock.advance(4);
  ended();
  // The owner found the older candidate superseded and asks again for the newer one.
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[0, 7]], "nothing was published, so the newer candidate may go at once");
  clock.advance(0);
  assert.deepEqual(started, [["a", 0], ["a", 7]]);
});

test("clearing cancels every timer and forgets derivations that are still in flight", () => {
  const { clock, published, schedule } = harness();
  const ended = schedule.derivationStarted("a");
  schedule.gathered("a");
  schedule.fresh("b");
  schedule.clear();
  assert.equal(schedule.pending(), false);
  assert.deepEqual(schedule.retained(), { timers: 0, settled: 0, deriving: 0 });
  // A derivation that began before the clear ends after it and must not count against new work.
  const next = schedule.derivationStarted("a");
  ended();
  assert.equal(schedule.retained().deriving, 1);
  next();
  assert.equal(schedule.retained().deriving, 0);
  clock.advance(1_000);
  assert.deepEqual(published, []);
});

test("only sessions that published within the spacing are retained", () => {
  const { clock, schedule } = harness();
  for (let index = 0; index < 1_000; index += 1) {
    schedule.fresh(`session-${index}`);
    clock.advance(1);
  }
  assert.equal(schedule.retained().settled, 500);
  assert.equal(schedule.retained().timers, 0);
  clock.advance(500);
  schedule.fresh("one-more");
  clock.advance(0);
  assert.equal(schedule.retained().settled, 1);
});

test("a zero spacing schedules everything at once and retains nothing", () => {
  const { clock, published, schedule } = harness(0);
  schedule.fresh("a");
  schedule.gathered("b");
  schedule.restored("c");
  assert.deepEqual(clock.timers(), [[0, 0], [0, 0], [0, 0]]);
  clock.advance(0);
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[0, 0]]);
  clock.advance(0);
  assert.equal(published.length, 4);
  assert.equal(schedule.retained().settled, 0);
});
