import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTaskOutcomes, writeTaskOutcome } from "../../../server/tasks/task-outcomes.mjs";
import { ensureScorecardSnapshots, readScorecardSnapshot, SCORECARD_FORMULA, scorecardMeasures } from "../../../server/tasks/task-scorecard.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { ensureTaskEvents, recordTaskEvent } from "../../../server/tasks/task-events.mjs";
import { ensureTaskReviews } from "../../../server/tasks/task-review.mjs";
import { ensureTaskRework } from "../../../server/tasks/task-rework.mjs";
import { appendTaskLog, ensureTaskLog, TASK_LOG_KEEP } from "../../../server/tasks/task-log.mjs";

const REPOSITORY = `repo-${"a1".repeat(12)}`;
const OTHER = `repo-${"b2".repeat(12)}`;
const row = (overrides = {}) => ({ review_at: 10, done_at: 20, requeues: 0, sessions: 1, owner_turns: 0, commits_after_review: 0, pull_request: 1, pull_request_state: "merged", ...overrides });
const empty = { ownerTurns: { value: null, sample: 0 }, reviewToDoneMs: { value: null, sample: 0 }, firstPass: { value: null, sample: 0 }, reworkRate: { value: null, sample: 0 } };

test("scorecard measures use odd and even medians and first-pass shares", () => {
  const rows = [row({ owner_turns: 9, done_at: 40 }), row(), row({ owner_turns: 3, done_at: 30, commits_after_review: 2 })];
  assert.deepEqual(scorecardMeasures(rows), { ownerTurns: { value: 3, sample: 3 }, reviewToDoneMs: { value: 20, sample: 3 }, firstPass: { value: 2 / 3, sample: 3 }, reworkRate: { value: 0, sample: 3 } });
  rows.push(row({ owner_turns: 7, done_at: 50, commits_after_review: 1 }));
  assert.deepEqual(scorecardMeasures(rows), { ownerTurns: { value: 5, sample: 4 }, reviewToDoneMs: { value: 25, sample: 4 }, firstPass: { value: 0.5, sample: 4 }, reworkRate: { value: 0, sample: 4 } });
});

test("scorecard samples exclude non-merged rows and each measure's nulls, but keep zero", () => {
  const rows = [row({ review_at: 20 }), row({ owner_turns: null, review_at: null, commits_after_review: null }), row({ owner_turns: 4, done_at: 9, commits_after_review: 1 })];
  rows.push(...["open", "closed", null].map((pull_request_state) => row({ pull_request_state, owner_turns: 100 })));
  assert.deepEqual(scorecardMeasures(rows), { ownerTurns: { value: 2, sample: 2 }, reviewToDoneMs: { value: 0, sample: 1 }, firstPass: { value: 0.5, sample: 2 }, reworkRate: { value: 0, sample: 3 } });
  assert.deepEqual(scorecardMeasures(rows.slice(3)), empty);
  assert.deepEqual(scorecardMeasures([]), empty);
  assert.deepEqual(scorecardMeasures([rows[1]]), { ...empty, reworkRate: { value: 0, sample: 1 } });
});

test("snapshots refresh only the current version, keep its first time, and choose the earliest baseline", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  sources(database);
  ensureScorecardSnapshots(database);
  ensureScorecardSnapshots(database);
  assert.equal(SCORECARD_FORMULA, 2);
  writeTaskOutcome(database, REPOSITORY, 1, row());
  writeTaskOutcome(database, OTHER, 1, row({ owner_turns: 100 }));
  readScorecardSnapshot(database, OTHER, "other", 1);
  const first = readScorecardSnapshot(database, REPOSITORY, "1.0", 100);
  assert.deepEqual(first, { formula: 2, current: { version: "1.0", takenAt: 100, measures: scorecardMeasures([row()]) }, baseline: null });
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
  database.exec("INSERT INTO task_scorecard_snapshots SELECT repository_id, 'old-formula', 1, 0, owner_turns, owner_turns_n, review_to_done_ms, review_to_done_n, first_pass, first_pass_n, NULL, 0 FROM task_scorecard_snapshots WHERE repository_id = '" + REPOSITORY + "' AND app_version = '1.0'");
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

function sources(database) {
  ensureTaskOutcomes(database);
  ensureTaskEvents(database);
  ensureTaskReviews(database);
  ensureTaskRework(database);
  ensureTaskLog(database);
  database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

test("rework counts each merged task once across durable signals after log pruning", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  sources(database);
  ensureScorecardSnapshots(database);
  for (let number = 1; number <= 8; number++) writeTaskOutcome(database, REPOSITORY, number, row({ pull_request: 100 + number, pull_request_state: number === 7 ? "open" : "merged" }));
  const read = () => readScorecardSnapshot(database, REPOSITORY, "1.0", 100).current.measures.reworkRate;
  assert.deepEqual(read(), { value: 0, sample: 7 });
  database.prepare("INSERT INTO meta VALUES (?, ?)").run(`task_send_back:${REPOSITORY}:T-1`, '{"count":1}');
  assert.deepEqual(read(), { value: 1 / 7, sample: 7 });
  const review = database.prepare("INSERT INTO task_reviews (repository_id, number, session_id, at, verdict) VALUES (?, ?, 'synthetic', 1, ?)");
  review.run(REPOSITORY, 2, "fail");
  review.run(REPOSITORY, 2, "pass");
  assert.deepEqual(read(), { value: 2 / 7, sample: 7 });
  recordTaskEvent(database, REPOSITORY, 3, "requeued", 1);
  assert.deepEqual(read(), { value: 3 / 7, sample: 7 });
  const link = database.prepare("INSERT INTO task_rework VALUES (?, ?, ?, 'wrong_behavior', 'owner', 1)");
  link.run(REPOSITORY, "#900", "T-4");
  assert.deepEqual(read(), { value: 4 / 7, sample: 7 });
  link.run(REPOSITORY, "#900", "#105");
  assert.deepEqual(read(), { value: 5 / 7, sample: 7 });
  // Task 6 is a fix, not reworked; task 8 only has signals in another repository.
  link.run(REPOSITORY, "T-6", "#999");
  link.run(OTHER, "#900", "#108");
  review.run(OTHER, 8, "fail");
  recordTaskEvent(database, OTHER, 8, "requeued", 1);
  database.prepare("INSERT INTO meta VALUES (?, ?)").run(`task_send_back:${OTHER}:T-8`, '{"count":1}');
  for (const number of [1, 2, 3, 4, 5, 7]) {
    review.run(REPOSITORY, number, "fail");
    recordTaskEvent(database, REPOSITORY, number, "requeued", 1);
    link.run(REPOSITORY, "#901", `T-${number}`);
    appendTaskLog(database, REPOSITORY, number, "sent_back", 1);
  }
  // Done clears the send-back marker; its requeue remains durable.
  database.prepare("DELETE FROM meta WHERE key = ?").run(`task_send_back:${REPOSITORY}:T-1`);
  for (let i = 0; i < TASK_LOG_KEEP; i++) appendTaskLog(database, REPOSITORY, 6, "started", i + 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM task_log WHERE repository_id = ? AND kind <> 'started'").get(REPOSITORY).n, 0);
  assert.deepEqual(read(), { value: 5 / 7, sample: 7 });
});

test("formula 2 migrates old snapshots without overwriting or comparing formula 1", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  sources(database);
  database.exec(`CREATE TABLE task_scorecard_snapshots (
    repository_id TEXT, app_version TEXT, formula INTEGER, taken_at INTEGER,
    owner_turns REAL, owner_turns_n INTEGER, review_to_done_ms REAL, review_to_done_n INTEGER,
    first_pass REAL, first_pass_n INTEGER, PRIMARY KEY (repository_id, app_version, formula)
  ) WITHOUT ROWID`);
  database.prepare("INSERT INTO task_scorecard_snapshots VALUES (?, '1.0', 1, 1, 3, 2, 10, 2, 0.5, 2)").run(REPOSITORY);
  ensureScorecardSnapshots(database);
  ensureScorecardSnapshots(database);
  const first = readScorecardSnapshot(database, REPOSITORY, "1.0", 100);
  assert.equal(first.formula, 2);
  assert.equal(first.baseline, null);
  const old = database.prepare("SELECT * FROM task_scorecard_snapshots WHERE formula = 1").get();
  assert.equal(old.owner_turns, 3);
  assert.equal(old.taken_at, 1);
  assert.equal(old.rework_rate, null);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM task_scorecard_snapshots").get().n, 2);
  assert.deepEqual(readScorecardSnapshot(database, REPOSITORY, "2.0", 200).baseline, first.current);
});
