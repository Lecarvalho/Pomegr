import assert from "node:assert/strict";
import test from "node:test";
import { matchResourcePeak, MAX_MATCHED_TASK_IDS } from "../monitor/resource-peak-matching.mjs";

const task = (id, startedAtMs, finishedAtMs = null, requestNumber = null) => ({
  id,
  startedAtMs,
  finishedAtMs,
  requestNumber,
});

const NONE = { taskIds: [], requestNumber: null };

// One row per behavior of the pure matcher. Windows default to [1_000, 2_000].
const CASES = [
  {
    name: "a finished task overlapping the window matches, carrying its request number",
    tasks: [task("toolu_a", 1_500, 1_800, 7)],
    latestObservationMs: 2_000,
    expected: { taskIds: ["toolu_a"], requestNumber: 7 },
  },
  {
    name: "a task starting exactly at the window end overlaps",
    tasks: [task("toolu_start", 2_000, 2_500)],
    expected: { taskIds: ["toolu_start"], requestNumber: null },
  },
  {
    name: "a task finishing exactly at the window start overlaps",
    tasks: [task("toolu_end", 200, 1_000)],
    expected: { taskIds: ["toolu_end"], requestNumber: null },
  },
  {
    name: "an unfinished task is bounded by the latest observation",
    tasks: [task("toolu_running", 1_500, null)],
    latestObservationMs: 1_600,
    expected: { taskIds: ["toolu_running"], requestNumber: null },
  },
  {
    name: "an unfinished task whose latest observation precedes the window does not match",
    tasks: [task("toolu_running", 100, null)],
    latestObservationMs: 500,
    expected: NONE,
  },
  {
    name: "an unfinished task with no latest observation does not match",
    tasks: [task("toolu_running", 1_500, null)],
    expected: NONE,
  },
  {
    name: "a latest observation earlier than the task start does not match",
    tasks: [task("toolu_running", 1_500, null)],
    latestObservationMs: 1_400,
    expected: NONE,
  },
  {
    name: "a reversed window returns empty",
    fromMs: 2_000,
    toMs: 1_000,
    tasks: [task("toolu_a", 1_000, 3_000)],
    expected: NONE,
  },
  {
    name: "a non-finite window start returns empty",
    fromMs: NaN,
    toMs: 1_000,
    tasks: [task("toolu_a", 1_000, 3_000)],
    expected: NONE,
  },
  {
    name: "a non-finite window end returns empty",
    fromMs: 1_000,
    toMs: Infinity,
    tasks: [task("toolu_a", 1_000, 3_000)],
    expected: NONE,
  },
  {
    name: "tasks with invalid identity or timing are skipped while valid ones match",
    tasks: [
      { id: "", startedAtMs: 1_500, finishedAtMs: 1_600, requestNumber: null },
      { id: "toolu_bad_start", startedAtMs: NaN, finishedAtMs: 1_600, requestNumber: null },
      { id: "toolu_bad_finish", startedAtMs: 1_600, finishedAtMs: 1_500, requestNumber: null },
      task("toolu_ok", 1_500, 1_700),
    ],
    expected: { taskIds: ["toolu_ok"], requestNumber: null },
  },
  {
    name: "repeated task IDs are deduplicated and sorted by string order",
    tasks: [
      task("toolu_b", 1_500, 1_600),
      task("toolu_a", 1_500, 1_600),
      task("toolu_a", 1_500, 1_600),
      task("toolu_10", 1_500, 1_600),
    ],
    expected: { taskIds: ["toolu_10", "toolu_a", "toolu_b"], requestNumber: null },
  },
  {
    name: "one request number shared by every overlapping task resolves",
    tasks: [task("toolu_a", 1_500, 1_600, 3), task("toolu_b", 1_550, 1_650, 3)],
    expected: { taskIds: ["toolu_a", "toolu_b"], requestNumber: 3 },
  },
  {
    name: "overlapping tasks that disagree on the request number resolve to null",
    tasks: [task("toolu_a", 1_500, 1_600, 3), task("toolu_b", 1_550, 1_650, 4)],
    expected: { taskIds: ["toolu_a", "toolu_b"], requestNumber: null },
  },
  {
    name: "an overlapping task without a request number makes the request number null",
    tasks: [task("toolu_a", 1_500, 1_600, 3), task("toolu_b", 1_550, 1_650, null)],
    expected: { taskIds: ["toolu_a", "toolu_b"], requestNumber: null },
  },
  ...[0, -1, 1.5].map((requestNumber) => ({
    name: `request number ${requestNumber} is never accepted`,
    tasks: [task("toolu_a", 1_500, 1_600, requestNumber)],
    expected: { taskIds: ["toolu_a"], requestNumber: null },
  })),
  {
    name: "tasks entirely outside the window yield empty taskIds and a null request number",
    tasks: [task("toolu_before", 0, 500, 9), task("toolu_after", 2_500, 3_000, 9)],
    expected: NONE,
  },
];

test("matchResourcePeak resolves overlapping task IDs and an unambiguous request number", () => {
  for (const { name, fromMs = 1_000, toMs = 2_000, tasks, latestObservationMs = null, expected } of CASES) {
    assert.deepEqual(matchResourcePeak({ fromMs, toMs, tasks, latestObservationMs }), expected, name);
  }
});

test("the task ID cap never changes which request number the full overlapping set resolves to", () => {
  const tasks = Array.from({ length: MAX_MATCHED_TASK_IDS + 5 }, (_, index) =>
    task(`toolu_${String(index).padStart(2, "0")}`, 1_500, 1_600, 42));
  const result = matchResourcePeak({ fromMs: 1_000, toMs: 2_000, tasks, latestObservationMs: null });
  assert.deepEqual(result.taskIds, tasks.map((entry) => entry.id).sort().slice(0, MAX_MATCHED_TASK_IDS));
  assert.equal(result.requestNumber, 42);
});
