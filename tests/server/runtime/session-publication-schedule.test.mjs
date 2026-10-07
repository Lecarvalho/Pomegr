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
  // The owner records a derivation start when a timer fires and it still has a candidate.
  const schedule = createSessionPublicationSchedule({
    schedule: clock.schedule, cancel: clock.cancel, now: clock.now, spacingMs,
    publish(id) { published.push([id, clock.now()]); schedule.started(id); },
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

test("a fresh candidate after a derivation start waits the rest of the spacing, and later ones join it", () => {
  const { clock, published, schedule } = harness();
  schedule.fresh("a");
  clock.advance(120);
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[380, 500]], "500 ms after the derivation start at 0");
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

test("a gathered rederivation right after a derivation start still waits the full spacing", () => {
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

test("a candidate that arrives while a derivation runs waits the spacing from that derivation's start", () => {
  const { clock, published, schedule } = harness();
  schedule.fresh("a");
  clock.advance(3);
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[497, 500]], "the derivation that started at 0 is still running");
  clock.advance(4);
  // The derivation ended and its result was dropped. Nothing may move the newer candidate forward.
  schedule.gathered("a");
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[497, 500]]);
  clock.advance(493);
  assert.deepEqual(published, [["a", 0], ["a", 500]]);
});

test("a timer that fires without a recorded start does not space the next request", () => {
  const clock = manualClock();
  const fired = [];
  // The owner found no candidate when the timer fired, so no derivation started.
  const schedule = createSessionPublicationSchedule({
    schedule: clock.schedule, cancel: clock.cancel, now: clock.now, spacingMs: 500, publish(id) { fired.push(id); },
  });
  schedule.fresh("a");
  clock.advance(100);
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[0, 100]]);
  assert.deepEqual(fired, ["a"]);
});

test("clearing cancels every timer and forgets every derivation start", () => {
  const { clock, published, schedule } = harness();
  schedule.fresh("a");
  clock.advance(100);
  schedule.gathered("a");
  schedule.fresh("b");
  assert.deepEqual(schedule.retained(), { timers: 2, started: 1 });
  schedule.clear();
  assert.equal(schedule.pending(), false);
  assert.deepEqual(schedule.retained(), { timers: 0, started: 0 });
  schedule.fresh("a");
  assert.deepEqual(clock.timers(), [[0, 100]], "the start before the clear no longer spaces new work");
  clock.advance(1_000);
  assert.deepEqual(published, [["a", 0], ["a", 100]]);
});

test("only sessions that started a derivation within the spacing are retained", () => {
  const { clock, schedule } = harness();
  for (let index = 0; index < 1_000; index += 1) {
    schedule.fresh(`session-${index}`);
    clock.advance(1);
  }
  assert.equal(schedule.retained().started, 500);
  assert.equal(schedule.retained().timers, 0);
  clock.advance(500);
  schedule.fresh("one-more");
  clock.advance(0);
  assert.equal(schedule.retained().started, 1);
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
  assert.equal(schedule.retained().started, 0);
});
