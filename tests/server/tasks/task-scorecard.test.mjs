import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTaskOutcomes, writeTaskOutcome } from "../../../server/tasks/task-outcomes.mjs";
import { ensureScorecardSnapshots, readScorecardSnapshot, SCORECARD_FORMULA, scorecardMeasures } from "../../../server/tasks/task-scorecard.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY = `repo-${"a1".repeat(12)}`;
const OTHER = `repo-${"b2".repeat(12)}`;
const row = (overrides = {}) => ({ review_at: 10, done_at: 20, requeues: 0, sessions: 1, owner_turns: 0, commits_after_review: 0, pull_request: 1, pull_request_state: "merged", ...overrides });
const empty = { ownerTurns: { value: null, sample: 0 }, reviewToDoneMs: { value: null, sample: 0 }, firstPass: { value: null, sample: 0 } };

test("scorecard measures use odd and even medians and first-pass shares", () => {
  const rows = [row({ owner_turns: 9, done_at: 40 }), row(), row({ owner_turns: 3, done_at: 30, commits_after_review: 2 })];
  assert.deepEqual(scorecardMeasures(rows), { ownerTurns: { value: 3, sample: 3 }, reviewToDoneMs: { value: 20, sample: 3 }, firstPass: { value: 2 / 3, sample: 3 } });
  rows.push(row({ owner_turns: 7, done_at: 50, commits_after_review: 1 }));
  assert.deepEqual(scorecardMeasures(rows), { ownerTurns: { value: 5, sample: 4 }, reviewToDoneMs: { value: 25, sample: 4 }, firstPass: { value: 0.5, sample: 4 } });
});

test("scorecard samples exclude non-merged rows and each measure's nulls, but keep zero", () => {
  const rows = [row({ review_at: 20 }), row({ owner_turns: null, review_at: null, commits_after_review: null }), row({ owner_turns: 4, done_at: 9, commits_after_review: 1 })];
  rows.push(...["open", "closed", null].map((pull_request_state) => row({ pull_request_state, owner_turns: 100 })));
  assert.deepEqual(scorecardMeasures(rows), { ownerTurns: { value: 2, sample: 2 }, reviewToDoneMs: { value: 0, sample: 1 }, firstPass: { value: 0.5, sample: 2 } });
  assert.deepEqual(scorecardMeasures(rows.slice(3)), empty);
  assert.deepEqual(scorecardMeasures([]), empty);
  assert.deepEqual(scorecardMeasures([rows[1]]), empty);
});

test("snapshots refresh only the current version, keep its first time, and choose the earliest baseline", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  ensureTaskOutcomes(database);
  ensureScorecardSnapshots(database);
  ensureScorecardSnapshots(database);
  assert.equal(SCORECARD_FORMULA, 1);
  writeTaskOutcome(database, REPOSITORY, 1, row());
  writeTaskOutcome(database, OTHER, 1, row({ owner_turns: 100 }));
  readScorecardSnapshot(database, OTHER, "other", 1);
  const first = readScorecardSnapshot(database, REPOSITORY, "1.0", 100);
  assert.deepEqual(first, { formula: 1, current: { version: "1.0", takenAt: 100, measures: scorecardMeasures([row()]) }, baseline: null });
  writeTaskOutcome(database, REPOSITORY, 1, row({ owner_turns: 8 }));
  const second = readScorecardSnapshot(database, REPOSITORY, "2.0", 200);
  assert.deepEqual(second.baseline, first.current);
  const repeated = readScorecardSnapshot(database, REPOSITORY, "2.0", 300);
  assert.equal(repeated.current.takenAt, 200);
  assert.deepEqual(repeated.current.measures.ownerTurns, { value: 8, sample: 1 });
  assert.deepEqual(repeated.baseline, first.current);
  database.exec("UPDATE task_outcomes SET owner_turns = 12");
  assert.deepEqual(readScorecardSnapshot(database, REPOSITORY, "2.0", 400).current.measures.ownerTurns, { value: 12, sample: 1 });
  readScorecardSnapshot(database, REPOSITORY, "0.9", 100);
  database.exec("INSERT INTO task_scorecard_snapshots SELECT repository_id, 'old-formula', 2, 0, owner_turns, owner_turns_n, review_to_done_ms, review_to_done_n, first_pass, first_pass_n FROM task_scorecard_snapshots WHERE repository_id = '" + REPOSITORY + "' AND app_version = '1.0'");
  assert.equal(readScorecardSnapshot(database, REPOSITORY, "3.0", 500).baseline.version, "0.9");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM task_scorecard_snapshots WHERE repository_id = ? AND app_version = ?").get(REPOSITORY, "2.0").n, 1);
});

test("the store creates snapshots on fresh and existing stores and retains them when a task is deleted", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-scorecard-"));
  let store = openTaskStore({ directory, now: () => 100 });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); });
  assert.deepEqual(store.readScorecard(REPOSITORY, "1.0").current, { version: "1.0", takenAt: 100, measures: empty });
  store.close();
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  database.exec("DROP TABLE task_scorecard_snapshots");
  database.close();
  store = openTaskStore({ directory, now: () => 200 });
  assert.equal(store.apply(REPOSITORY, "create", { text: "Synthetic task" }).ok, true);
  const first = store.readScorecard(REPOSITORY, "1.0");
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-1" }).ok, true);
  assert.deepEqual(store.readScorecard(REPOSITORY, "2.0").baseline, first.current);
  store.close();
  store = openTaskStore({ directory, now: () => 300 });
  assert.equal(store.readScorecard(REPOSITORY, "1.0").current.takenAt, 200);
});
