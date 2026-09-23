import assert from "node:assert/strict";
import test from "node:test";
import { matchResourcePeak, MAX_MATCHED_TASK_IDS } from "../monitor/resource-peak-matching.mjs";

const task = (id, startedAtMs, finishedAtMs = null, requestNumber = null) => ({
  id,
  startedAtMs,
  finishedAtMs,
  requestNumber,
});

test("matches a finished task whose interval overlaps the peak window", () => {
  const result = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [task("toolu_a", 1_500, 1_800, 7)],
    latestObservationMs: 2_000,
  });
  assert.deepEqual(result, { taskIds: ["toolu_a"], requestNumber: 7 });
});

test("touching endpoints count as overlap on both sides", () => {
  const startTouch = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [task("toolu_start", 2_000, 2_500)],
    latestObservationMs: null,
  });
  assert.deepEqual(startTouch.taskIds, ["toolu_start"]);

  const endTouch = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [task("toolu_end", 200, 1_000)],
    latestObservationMs: null,
  });
  assert.deepEqual(endTouch.taskIds, ["toolu_end"]);
});

test("an unfinished task is bounded by the latest observation", () => {
  const withinLatest = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [task("toolu_running", 1_500, null)],
    latestObservationMs: 1_600,
  });
  assert.deepEqual(withinLatest.taskIds, ["toolu_running"]);

  const beforePeak = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [task("toolu_running", 100, null)],
    latestObservationMs: 500,
  });
  assert.deepEqual(beforePeak.taskIds, []);
});

test("an unfinished task with no latest observation does not match", () => {
  const result = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [task("toolu_running", 1_500, null)],
    latestObservationMs: null,
  });
  assert.deepEqual(result, { taskIds: [], requestNumber: null });
});

test("a latest observation earlier than the task start does not match", () => {
  const result = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [task("toolu_running", 1_500, null)],
    latestObservationMs: 1_400,
  });
  assert.deepEqual(result.taskIds, []);
});

test("reversed or non-finite interval bounds return empty", () => {
  const reversed = matchResourcePeak({
    fromMs: 2_000,
    toMs: 1_000,
    tasks: [task("toolu_a", 1_000, 3_000)],
    latestObservationMs: null,
  });
  assert.deepEqual(reversed, { taskIds: [], requestNumber: null });

  const nonFiniteFrom = matchResourcePeak({
    fromMs: NaN,
    toMs: 1_000,
    tasks: [task("toolu_a", 1_000, 3_000)],
    latestObservationMs: null,
  });
  assert.deepEqual(nonFiniteFrom, { taskIds: [], requestNumber: null });

  const nonFiniteTo = matchResourcePeak({
    fromMs: 1_000,
    toMs: Infinity,
    tasks: [task("toolu_a", 1_000, 3_000)],
    latestObservationMs: null,
  });
  assert.deepEqual(nonFiniteTo, { taskIds: [], requestNumber: null });
});

test("skips tasks with invalid identity or timing but keeps valid ones", () => {
  const result = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [
      { id: "", startedAtMs: 1_500, finishedAtMs: 1_600, requestNumber: null },
      { id: "toolu_bad_start", startedAtMs: NaN, finishedAtMs: 1_600, requestNumber: null },
      { id: "toolu_bad_finish", startedAtMs: 1_600, finishedAtMs: 1_500, requestNumber: null },
      task("toolu_ok", 1_500, 1_700),
    ],
    latestObservationMs: null,
  });
  assert.deepEqual(result.taskIds, ["toolu_ok"]);
});

test("dedupes repeated task IDs and sorts ascending by string order", () => {
  const result = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [
      task("toolu_b", 1_500, 1_600),
      task("toolu_a", 1_500, 1_600),
      task("toolu_a", 1_500, 1_600),
      task("toolu_10", 1_500, 1_600),
    ],
    latestObservationMs: null,
  });
  assert.deepEqual(result.taskIds, ["toolu_10", "toolu_a", "toolu_b"]);
});

test("caps matched task IDs at MAX_MATCHED_TASK_IDS", () => {
  const tasks = Array.from({ length: 25 }, (_, index) =>
    task(`toolu_${String(index).padStart(2, "0")}`, 1_500, 1_600));
  const result = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks,
    latestObservationMs: null,
  });
  assert.equal(MAX_MATCHED_TASK_IDS, 20);
  assert.equal(result.taskIds.length, 20);
  assert.deepEqual(result.taskIds, tasks.map((task) => task.id).sort().slice(0, 20));
});

test("resolves an unambiguous request number shared by all overlapping tasks", () => {
  const result = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [task("toolu_a", 1_500, 1_600, 3), task("toolu_b", 1_550, 1_650, 3)],
    latestObservationMs: null,
  });
  assert.equal(result.requestNumber, 3);
});

test("request number is null when overlapping tasks disagree", () => {
  const result = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [task("toolu_a", 1_500, 1_600, 3), task("toolu_b", 1_550, 1_650, 4)],
    latestObservationMs: null,
  });
  assert.equal(result.requestNumber, null);
  assert.deepEqual(result.taskIds, ["toolu_a", "toolu_b"]);
});

test("request number is null when any overlapping task lacks one", () => {
  const result = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [task("toolu_a", 1_500, 1_600, 3), task("toolu_b", 1_550, 1_650, null)],
    latestObservationMs: null,
  });
  assert.equal(result.requestNumber, null);
});

test("request number stays null for zero, negative, or non-integer values", () => {
  const zero = matchResourcePeak({
    fromMs: 1_000, toMs: 2_000,
    tasks: [task("toolu_a", 1_500, 1_600, 0)],
    latestObservationMs: null,
  });
  assert.equal(zero.requestNumber, null);

  const negative = matchResourcePeak({
    fromMs: 1_000, toMs: 2_000,
    tasks: [task("toolu_a", 1_500, 1_600, -1)],
    latestObservationMs: null,
  });
  assert.equal(negative.requestNumber, null);

  const fractional = matchResourcePeak({
    fromMs: 1_000, toMs: 2_000,
    tasks: [task("toolu_a", 1_500, 1_600, 1.5)],
    latestObservationMs: null,
  });
  assert.equal(fractional.requestNumber, null);
});

test("no overlap returns empty taskIds and null requestNumber", () => {
  const result = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks: [task("toolu_before", 0, 500, 9), task("toolu_after", 2_500, 3_000, 9)],
    latestObservationMs: null,
  });
  assert.deepEqual(result, { taskIds: [], requestNumber: null });
});

test("requestNumber determination uses the full overlapping set, not the capped output", () => {
  const tasks = Array.from({ length: 25 }, (_, index) =>
    task(`toolu_${String(index).padStart(2, "0")}`, 1_500, 1_600, 42));
  const result = matchResourcePeak({
    fromMs: 1_000,
    toMs: 2_000,
    tasks,
    latestObservationMs: null,
  });
  assert.equal(result.taskIds.length, 20);
  assert.equal(result.requestNumber, 42);
});
