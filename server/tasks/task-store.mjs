// The private task store: one monitor-owned SQLite file, separate from the observation
// cache (monitor.sqlite) and from its retention and prune cycle, so pruning session history
// never deletes a task. Task text, the own condition, and column and feature names are
// user-authored content held only here; this module never logs them or throws them.
//
// Unlike monitor.sqlite this store is not a rebuildable index: a file that is malformed, or
// written by a newer version, is left untouched. The store then reports `unavailable` and
// refuses every write, so a routine write can never replace the user's tasks.
//
// The schema already holds full Task rows (queue, session link, report, dispatch token), so
// later parts add actions to `ACTIONS` rather than migrate. Task rows are written only by
// those actions. Every action runs in one transaction and commits only when the whole board
// still projects within the contract, so a write can never leave a board the user cannot read.

import crypto from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { installSqliteExperimentalWarningFilter } from "../persistence/monitor-store.mjs";
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { fillTaskSessions } from "./task-board.mjs";
import { clearColumnRoles, readColumnRoles, seedColumnRoles, setColumnRole, taskNumbersInOrder, writeTaskOrder } from "./task-columns.mjs";
import { bindDispatch, startAbort, startPlan } from "./task-dispatch.mjs";
import { fillQueueGates, nextQueueStarts, pauseQueue, queueSettings, readPauseReason, readQueueSchedule, startGates } from "./task-queue-advance.mjs";
import { releaseQueue, reportBlock, reportComplete, resolveDone, resolveRequeue } from "./task-report.mjs";
import { featureSessionGroups, featureSessions, sessionTaskReferences } from "./task-session-link.mjs";
import { stallEndedTasks } from "./task-stall.mjs";
import {
  DEFAULT_TASK_COLUMNS, TASK_BOUNDS, emptyBoard, isRepositoryId, normalizeColumnCreatePayload, normalizeColumnDeletePayload,
  normalizeColumnRenamePayload, normalizeColumnReorderPayload, normalizeCreatePayload, normalizeDeletePayload,
  normalizeFeatureCreatePayload, normalizeMovePayload, normalizeQueueAddPayload, normalizeQueueReorderPayload, normalizeQueueTaskPayload, normalizeUpdatePayload,
  projectBoard, taskIdFromNumber,
} from "./task-record.mjs";

export const TASK_STORE_SCHEMA_VERSION = 1;

const DATABASE_FILENAME = "tasks.sqlite";
const TABLES = ["meta", "repositories", "columns", "features", "tasks"];

let sqliteModule = null;

function loadSqlite() {
  if (!sqliteModule) {
    installSqliteExperimentalWarningFilter();
    sqliteModule = createRequire(import.meta.url)("node:sqlite");
  }
  return sqliteModule;
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE repositories (
      repository_id TEXT PRIMARY KEY,
      queue_status TEXT NOT NULL DEFAULT 'idle' CHECK (queue_status IN ('idle', 'running', 'blocked', 'paused')),
      queue_blocked_by TEXT,
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE columns (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0)
    ) WITHOUT ROWID;
    CREATE INDEX columns_repository ON columns (repository_id, position);
    CREATE TABLE features (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX features_repository ON features (repository_id, created_at);
    CREATE TABLE tasks (
      repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
      number INTEGER NOT NULL CHECK (number >= 1),
      text TEXT NOT NULL,
      column_id TEXT NOT NULL REFERENCES columns(id),
      position INTEGER NOT NULL CHECK (position >= 0),
      feature_id TEXT REFERENCES features(id),
      step INTEGER CHECK (step IS NULL OR step >= 1),
      run_provider TEXT CHECK (run_provider IS NULL OR run_provider IN ('claude', 'codex')),
      run_model TEXT,
      run_effort TEXT CHECK (run_effort IS NULL OR run_effort IN ('low', 'medium', 'high', 'xhigh')),
      checks TEXT NOT NULL DEFAULT '[]',
      own_condition TEXT,
      state TEXT NOT NULL DEFAULT 'not_queued'
        CHECK (state IN ('not_queued', 'queued', 'scheduled', 'needs_review', 'stalled', 'blocked', 'done')),
      scheduled_at INTEGER,
      queue_position INTEGER,
      session_id TEXT,
      dispatch_token TEXT,
      report_at INTEGER,
      report_results TEXT,
      report_block_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (repository_id, number),
      CHECK ((feature_id IS NULL) = (step IS NULL))
    ) WITHOUT ROWID;
    CREATE INDEX tasks_column ON tasks (repository_id, column_id, position);
    CREATE UNIQUE INDEX tasks_session ON tasks (session_id) WHERE session_id IS NOT NULL;
  `);
}

function runTransaction(database, work) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* connection may already be unusable */ }
    throw error;
  }
}

/** Creates the schema and version in one transaction, so an interrupted creation leaves no half-built store. */
function createFreshStore(database) {
  runTransaction(database, () => {
    createSchema(database);
    preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?)").run("schema_version", String(TASK_STORE_SCHEMA_VERSION));
    preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?)").run("created_at", String(Date.now()));
  });
  database.exec("PRAGMA journal_mode = WAL");
}

/** Throws unless the file is an intact store of exactly this version. Issues no write. */
function verifyExistingStore(database) {
  const check = database.prepare("PRAGMA quick_check").get();
  if ((check ? Object.values(check)[0] : null) !== "ok") throw new Error("TASK_STORE_MALFORMED");
  const version = database.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
  if (!version || version.value !== String(TASK_STORE_SCHEMA_VERSION)) throw new Error("TASK_STORE_VERSION");
  for (const table of TABLES) database.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all();
}

/** The open database, or null when the store cannot be used. Never throws. */
function openDatabase(directory) {
  let database = null;
  try {
    if (typeof directory !== "string" || directory.length === 0) return null;
    mkdirSync(directory, { recursive: true });
    const databasePath = path.join(directory, DATABASE_FILENAME);
    let size = 0;
    try {
      size = statSync(databasePath).size;
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
    }
    database = new (loadSqlite().DatabaseSync)(databasePath);
    // An empty file holds no tasks to protect; any other file must verify before it is trusted.
    if (size === 0) createFreshStore(database);
    else verifyExistingStore(database);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 2000");
    return database;
  } catch {
    try { database?.close(); } catch { /* already unusable */ }
    return null;
  }
}

function newOpaqueId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

/** Seeds the default columns for a repository seen for the first time. The caller owns the transaction. */
function ensureRepository(database, repositoryId) {
  const inserted = preparedStatement(database, "INSERT OR IGNORE INTO repositories (repository_id, created_at) VALUES (?, ?)").run(repositoryId, Date.now());
  if (Number(inserted.changes) === 0) return;
  const insertColumn = preparedStatement(database, "INSERT INTO columns (id, repository_id, name, position) VALUES (?, ?, ?, ?)");
  const ids = DEFAULT_TASK_COLUMNS.map(() => newOpaqueId("col"));
  DEFAULT_TASK_COLUMNS.forEach((name, position) => insertColumn.run(ids[position], repositoryId, name, position));
  seedColumnRoles(database, repositoryId, ids);
}

// Task numbers are monotonic per repository and never reused. The next number is kept beside the
// schema version in `meta`, so deleting the newest task cannot hand its number to the next one.
const nextNumberKey = (repositoryId) => `next_task_number:${repositoryId}`;

function nextTaskNumber(database, repositoryId) {
  const stored = Number(preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(nextNumberKey(repositoryId))?.value);
  const highest = Number(preparedStatement(database, "SELECT MAX(number) AS highest FROM tasks WHERE repository_id = ?").get(repositoryId)?.highest ?? 0);
  return Math.max(Number.isSafeInteger(stored) ? stored : 1, highest + 1);
}

function reserveTaskNumber(database, repositoryId, atLeast) {
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(nextNumberKey(repositoryId), String(atLeast));
}

// Features hold tasks at dense steps (1..n). A write that changes a task's feature or step reads the
// affected feature's steps and closes any gap, leaving the other tasks' update times alone.
const featureExists = (database, repositoryId, id) =>
  preparedStatement(database, "SELECT 1 FROM features WHERE repository_id = ? AND id = ?").get(repositoryId, id) !== undefined;

const highestStep = (database, repositoryId, featureId) =>
  Number(preparedStatement(database, "SELECT MAX(step) AS highest FROM tasks WHERE repository_id = ? AND feature_id = ?").get(repositoryId, featureId)?.highest ?? 0);

// A feature is done when it has tasks and every one of them is done; only unfinished features take tasks.
function featureIsDone(database, repositoryId, featureId) {
  const row = preparedStatement(database, "SELECT COUNT(*) AS total, COUNT(CASE WHEN state = 'done' THEN 1 END) AS done FROM tasks WHERE repository_id = ? AND feature_id = ?")
    .get(repositoryId, featureId);
  return Number(row.total) > 0 && Number(row.total) === Number(row.done);
}

// A step from 1 to the current highest step + 1 (a new last step); null asks for the new last step.
const stepWithin = (requested, highest) =>
  requested === null ? highest + 1 : requested >= 1 && requested <= highest + 1 ? requested : undefined;

function renumberSteps(database, repositoryId, featureId) {
  const steps = preparedStatement(database, "SELECT DISTINCT step FROM tasks WHERE repository_id = ? AND feature_id = ? ORDER BY step").all(repositoryId, featureId);
  const update = preparedStatement(database, "UPDATE tasks SET step = ? WHERE repository_id = ? AND feature_id = ? AND step = ?");
  steps.forEach((row, index) => { if (Number(row.step) !== index + 1) update.run(index + 1, repositoryId, featureId, Number(row.step)); });
}

function createTask({ database, repositoryId }, payload) {
  const input = normalizeCreatePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  ensureRepository(database, repositoryId);
  const count = Number(preparedStatement(database, "SELECT COUNT(*) AS n FROM tasks WHERE repository_id = ?").get(repositoryId).n);
  if (count >= TASK_BOUNDS.tasksPerRepository) return { ok: false, error: "limit" };
  let step = null;
  if (input.featureId !== null) {
    if (!featureExists(database, repositoryId, input.featureId)) return { ok: false, error: "not_found" };
    if (featureIsDone(database, repositoryId, input.featureId)) return { ok: false, error: "conflict" };
    step = stepWithin(input.step, highestStep(database, repositoryId, input.featureId));
    if (step === undefined) return { ok: false, error: "invalid" };
  }
  // A new task always lands as the last card of the first column.
  const first = preparedStatement(database, "SELECT id FROM columns WHERE repository_id = ? ORDER BY position, id LIMIT 1").get(repositoryId);
  if (!first) return { ok: false, error: "conflict" };
  const last = preparedStatement(database, "SELECT MAX(position) AS last FROM tasks WHERE repository_id = ? AND column_id = ?").get(repositoryId, first.id);
  const position = last?.last === null || last?.last === undefined ? 0 : Number(last.last) + 1;
  const number = nextTaskNumber(database, repositoryId);
  if (taskIdFromNumber(number) === undefined) return { ok: false, error: "limit" };
  const now = Date.now();
  preparedStatement(database, `INSERT INTO tasks (repository_id, number, text, column_id, position, run_provider, run_model, run_effort, checks, own_condition, created_at, updated_at, feature_id, step)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(repositoryId, number, input.text, first.id, position, input.run.provider, input.run.model, input.run.effort,
      JSON.stringify(input.doneWhen.checks), input.doneWhen.own, now, now, input.featureId, step);
  reserveTaskNumber(database, repositoryId, number + 1);
  return { ok: true };
}

function updateTask({ database, repositoryId }, payload) {
  const input = normalizeUpdatePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const stored = preparedStatement(database, "SELECT text, feature_id, step, run_provider, run_model, run_effort, checks, own_condition FROM tasks WHERE repository_id = ? AND number = ?")
    .get(repositoryId, input.number);
  if (!stored) return { ok: false, error: "not_found" };
  // A field the payload left out keeps its stored value; one it carried is replaced whole.
  const run = input.run ?? { provider: stored.run_provider, model: stored.run_model, effort: stored.run_effort };
  const doneWhen = input.doneWhen ? { checks: JSON.stringify(input.doneWhen.checks), own: input.doneWhen.own } : { checks: stored.checks, own: stored.own_condition };
  const placement = updatedPlacement(database, repositoryId, stored, input);
  if (placement.error) return { ok: false, error: placement.error };
  preparedStatement(database, `UPDATE tasks SET text = ?, run_provider = ?, run_model = ?, run_effort = ?, checks = ?, own_condition = ?, feature_id = ?, step = ?, updated_at = ?
    WHERE repository_id = ? AND number = ?`)
    .run(input.text ?? stored.text, run.provider, run.model, run.effort, doneWhen.checks, doneWhen.own, placement.featureId, placement.step, Date.now(), repositoryId, input.number);
  // The feature the task left and the one it joined each close any gap in their steps.
  for (const featureId of new Set([stored.feature_id, placement.featureId])) if (featureId) renumberSteps(database, repositoryId, featureId);
  return { ok: true };
}

// Where an update leaves the task. An absent key keeps the stored value; a different feature follows
// the rules of create; the task's own feature takes a step from 1 to the highest step + 1, measured
// before the move, and never answers `conflict`, even when that feature is done.
function updatedPlacement(database, repositoryId, stored, input) {
  const current = { featureId: stored.feature_id ?? null, step: stored.step ?? null };
  if (input.featureId === undefined && input.step === undefined) return current;
  const featureId = input.featureId === undefined ? current.featureId : input.featureId;
  if (featureId === null) return input.featureId === null ? { featureId: null, step: null } : input.step == null ? current : { error: "invalid" };
  if (!featureExists(database, repositoryId, featureId)) return { error: "not_found" };
  const joining = featureId !== current.featureId;
  if (joining && featureIsDone(database, repositoryId, featureId)) return { error: "conflict" };
  const step = stepWithin(input.step ?? (joining ? null : current.step), highestStep(database, repositoryId, featureId));
  return step === undefined ? { error: "invalid" } : { featureId, step };
}

function deleteTask({ database, repositoryId }, payload) {
  const input = normalizeDeletePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const task = preparedStatement(database, "SELECT column_id, position, feature_id FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { ok: false, error: "not_found" };
  const reserved = nextTaskNumber(database, repositoryId);
  preparedStatement(database, "DELETE FROM tasks WHERE repository_id = ? AND number = ?").run(repositoryId, input.number);
  // The deleted number stays retired even when it was newer than the stored counter.
  reserveTaskNumber(database, repositoryId, Math.max(reserved, input.number + 1));
  preparedStatement(database, "UPDATE tasks SET position = position - 1 WHERE repository_id = ? AND column_id = ? AND position > ?")
    .run(repositoryId, task.column_id, task.position);
  if (task.feature_id) renumberSteps(database, repositoryId, task.feature_id);
  // A blocked queue must not keep naming a task that is gone.
  releaseQueue(database, repositoryId);
  return { ok: true };
}

// Positions stay dense (0..n-1) in every column (task-columns.mjs) and among the columns. Each write below reads the
// affected order, changes it as a list, and writes the whole list back, so a gap or a tie left by an
// earlier write is closed by the next action that touches the same list.
const columnIdsInOrder = (database, repositoryId) =>
  preparedStatement(database, "SELECT id FROM columns WHERE repository_id = ? ORDER BY position, id").all(repositoryId).map((row) => row.id);

function writeColumnOrder(database, repositoryId, ids) {
  const update = preparedStatement(database, "UPDATE columns SET position = ? WHERE repository_id = ? AND id = ? AND position <> ?");
  ids.forEach((id, index) => update.run(index, repositoryId, id, index));
}

const columnExists = (database, repositoryId, id) =>
  preparedStatement(database, "SELECT 1 FROM columns WHERE repository_id = ? AND id = ?").get(repositoryId, id) !== undefined;

// A move changes only the task's column, position, and update time. The tasks that shift to make room
// or close a gap change position alone, as they do when a task is deleted.
function moveTask({ database, repositoryId }, payload) {
  const input = normalizeMovePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const task = preparedStatement(database, "SELECT column_id FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task || !columnExists(database, repositoryId, input.columnId)) return { ok: false, error: "not_found" };
  const sourceColumnId = task.column_id;
  const before = taskNumbersInOrder(database, repositoryId, input.columnId);
  const order = before.filter((number) => number !== input.number);
  order.splice(Math.min(input.position, order.length), 0, input.number);
  // Dropping a card where it already is writes no update time; it still closes any stored gap.
  if (sourceColumnId !== input.columnId || before.join() !== order.join()) {
    preparedStatement(database, "UPDATE tasks SET column_id = ?, updated_at = ? WHERE repository_id = ? AND number = ?")
      .run(input.columnId, Date.now(), repositoryId, input.number);
  }
  writeTaskOrder(database, repositoryId, order);
  if (sourceColumnId !== input.columnId) writeTaskOrder(database, repositoryId, taskNumbersInOrder(database, repositoryId, sourceColumnId));
  return { ok: true };
}

function createColumn({ database, repositoryId }, payload) {
  const input = normalizeColumnCreatePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  ensureRepository(database, repositoryId);
  const ids = columnIdsInOrder(database, repositoryId);
  if (ids.length >= TASK_BOUNDS.columnsPerRepository) return { ok: false, error: "limit" };
  // Names may repeat: the opaque ID is the identity. A new column is always the last one.
  const id = newOpaqueId("col");
  preparedStatement(database, "INSERT INTO columns (id, repository_id, name, position) VALUES (?, ?, ?, ?)").run(id, repositoryId, input.name, ids.length);
  writeColumnOrder(database, repositoryId, [...ids, id]);
  return { ok: true };
}

function renameColumn({ database, repositoryId }, payload) {
  const input = normalizeColumnRenamePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  if (!columnExists(database, repositoryId, input.id)) return { ok: false, error: "not_found" };
  preparedStatement(database, "UPDATE columns SET name = ? WHERE repository_id = ? AND id = ?").run(input.name, repositoryId, input.id);
  return { ok: true };
}

function reorderColumn({ database, repositoryId }, payload) {
  const input = normalizeColumnReorderPayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  if (!columnExists(database, repositoryId, input.id)) return { ok: false, error: "not_found" };
  const order = columnIdsInOrder(database, repositoryId).filter((id) => id !== input.id);
  order.splice(Math.min(input.position, order.length), 0, input.id);
  writeColumnOrder(database, repositoryId, order);
  return { ok: true };
}

// A column that still holds tasks, and the last column, cannot go: the board must always have a
// first column for a new task to land in, and no task is ever moved or removed on its owner's behalf.
function deleteColumn({ database, repositoryId }, payload) {
  const input = normalizeColumnDeletePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  if (!columnExists(database, repositoryId, input.id)) return { ok: false, error: "not_found" };
  const ids = columnIdsInOrder(database, repositoryId);
  if (ids.length <= 1 || taskNumbersInOrder(database, repositoryId, input.id).length > 0) return { ok: false, error: "conflict" };
  preparedStatement(database, "DELETE FROM columns WHERE repository_id = ? AND id = ?").run(repositoryId, input.id);
  clearColumnRoles(database, repositoryId, input.id);
  writeColumnOrder(database, repositoryId, ids.filter((id) => id !== input.id));
  return { ok: true };
}

function createFeature({ database, repositoryId }, payload) {
  const input = normalizeFeatureCreatePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  ensureRepository(database, repositoryId);
  const stored = preparedStatement(database, "SELECT name, created_at FROM features WHERE repository_id = ?").all(repositoryId);
  if (stored.length >= TASK_BOUNDS.featuresPerRepository) return { ok: false, error: "limit" };
  if (stored.some((feature) => feature.name === input.name)) return { ok: false, error: "conflict" };
  // Features list in creation order, so a creation time never ties with or precedes an earlier one.
  const createdAt = Math.max(Date.now(), ...stored.map((feature) => Number(feature.created_at) + 1));
  preparedStatement(database, "INSERT INTO features (id, repository_id, name, created_at) VALUES (?, ?, ?, ?)").run(newOpaqueId("feat"), repositoryId, input.name, createdAt);
  return { ok: true };
}

// The queue is the set of tasks in state `queued` or `scheduled`, ordered by the pure `orderQueue` rule when the
// board is projected. A scheduled task is a queued task with a start time of its own: it keeps its place and is not
// started before that time. These actions change a task's state, time, and step only; they start no session and
// leave the queue status as stored. A task that leaves the queue here gets a null `queue_position` and no time.
const queuePositionAfterHighest = (database, repositoryId) => {
  const highest = preparedStatement(database, "SELECT MAX(queue_position) AS highest FROM tasks WHERE repository_id = ?").get(repositoryId)?.highest;
  return highest === null || highest === undefined || !Number.isSafeInteger(Number(highest)) ? 0 : Number(highest) + 1;
};

function stepCounts(database, repositoryId, featureId, step) {
  const row = preparedStatement(database, "SELECT COUNT(*) AS total, COUNT(CASE WHEN state = 'done' THEN 1 END) AS done FROM tasks WHERE repository_id = ? AND feature_id = ? AND step = ?")
    .get(repositoryId, featureId, step);
  return { total: Number(row.total), done: Number(row.done) };
}

// A step is done when it holds tasks and every one of them is done, the same rule `orderQueue` reports.
function stepIsDone(database, repositoryId, featureId, step) {
  const { total, done } = stepCounts(database, repositoryId, featureId, step);
  return total > 0 && total === done;
}

// `{ id }` queues a task that is not queued, and takes the start time off a scheduled one, which stays in its place.
// `{ id, at }` gives a task that is not queued, queued, or scheduled its own start time: it is Scheduled from then
// on, in the place it had or at the end. A task with a session already started and is not scheduled again.
function addToQueue({ database, repositoryId, now }, payload) {
  const input = normalizeQueueAddPayload(payload, now());
  if (!input) return { ok: false, error: "invalid" };
  const task = preparedStatement(database, "SELECT state, session_id, queue_position FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { ok: false, error: "not_found" };
  const waiting = task.state === "not_queued" || task.state === "queued" || task.state === "scheduled";
  if (input.at === null ? task.state !== "not_queued" && task.state !== "scheduled" : !waiting || (task.session_id ?? null) !== null) return { ok: false, error: "conflict" };
  // A task joins at the end: a position above every position the repository ever handed out.
  const position = task.state === "not_queued" || (task.queue_position ?? null) === null ? queuePositionAfterHighest(database, repositoryId) : task.queue_position;
  preparedStatement(database, "UPDATE tasks SET state = ?, scheduled_at = ?, queue_position = ?, updated_at = ? WHERE repository_id = ? AND number = ?")
    .run(input.at === null ? "queued" : "scheduled", input.at, position, Date.now(), repositoryId, input.number);
  return { ok: true };
}

function removeFromQueue({ database, repositoryId }, payload) {
  const input = normalizeQueueTaskPayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const task = preparedStatement(database, "SELECT state FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { ok: false, error: "not_found" };
  if (task.state !== "queued" && task.state !== "scheduled") return { ok: false, error: "conflict" };
  preparedStatement(database, "UPDATE tasks SET state = 'not_queued', queue_position = NULL, scheduled_at = NULL, updated_at = ? WHERE repository_id = ? AND number = ?")
    .run(Date.now(), repositoryId, input.number);
  return { ok: true };
}

// Moves a queued task to another step of its own feature. A task without a feature has no step: it runs in
// the order it was queued. A step from 1 to the feature's highest + 1 (a new last step), measured before the
// move, is valid, and a step that is already done refuses a task. The steps then close up around the move.
function reorderQueuedTask({ database, repositoryId }, payload) {
  const input = normalizeQueueReorderPayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const task = preparedStatement(database, "SELECT state, feature_id, step FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { ok: false, error: "not_found" };
  if (task.state !== "queued" || task.feature_id === null || task.feature_id === undefined) return { ok: false, error: "conflict" };
  const highest = highestStep(database, repositoryId, task.feature_id);
  if (stepWithin(input.step, highest) === undefined) return { ok: false, error: "invalid" };
  // Its own step, or a new last step for the lone task of the last step, leaves the task where it is.
  const current = Number(task.step);
  if (input.step === current || (input.step === highest + 1 && current === highest && stepCounts(database, repositoryId, task.feature_id, current).total === 1)) {
    return { ok: true };
  }
  if (stepIsDone(database, repositoryId, task.feature_id, input.step)) return { ok: false, error: "conflict" };
  preparedStatement(database, "UPDATE tasks SET step = ?, updated_at = ? WHERE repository_id = ? AND number = ?")
    .run(input.step, Date.now(), repositoryId, input.number);
  renumberSteps(database, repositoryId, task.feature_id);
  return { ok: true };
}

// Actions by name. Each takes `{ database, repositoryId }` and the payload inside the store's
// transaction, and returns `{ ok: true }` or a fixed error code. It validates the payload before
// its first write. A listed action absent from this table answers `unsupported` until its part lands.
const ACTIONS = Object.freeze({
  create: createTask, update: updateTask, delete: deleteTask, move: moveTask,
  column_create: createColumn, column_rename: renameColumn, column_reorder: reorderColumn, column_delete: deleteColumn, column_role: setColumnRole,
  feature_create: createFeature,
  queue_add: addToQueue, queue_remove: removeFromQueue, queue_reorder: reorderQueuedTask, queue_settings: queueSettings,
  resolve_done: resolveDone, resolve_requeue: resolveRequeue,
});

/** Raised inside a transaction to roll it back with a fixed error code. */
class ActionRejected extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Opens the task store in `directory`. Synchronous and never throws: a store that is missing
 * its directory, malformed, or newer than this build is `unavailable`, and is never rewritten.
 */
export function openTaskStore({ directory, now = Date.now } = {}) {
  let database = openDatabase(directory);

  function seedColumns(repositoryId) {
    if (preparedStatement(database, "SELECT 1 FROM repositories WHERE repository_id = ?").get(repositoryId)) return;
    runTransaction(database, () => ensureRepository(database, repositoryId));
  }

  function storedSchedule(repositoryId) {
    const { startAt, stopAfter } = readQueueSchedule(database, repositoryId);
    return { start_at: startAt, stop_after: stopAfter };
  }

  function loadRows(repositoryId) {
    const repository = preparedStatement(database, "SELECT queue_status, queue_blocked_by FROM repositories WHERE repository_id = ?").get(repositoryId);
    // A column's role is kept in `meta` like the pause reason (task-columns.mjs).
    const roles = readColumnRoles(database, repositoryId);
    return {
      // The pause reason and the queue's own times are kept in `meta` (task-queue-advance.mjs); the projection validates them.
      repository: repository ? { ...repository, pause_reason: readPauseReason(database, repositoryId), ...storedSchedule(repositoryId) } : repository,
      columns: preparedStatement(database, "SELECT id, name, position FROM columns WHERE repository_id = ? ORDER BY position, id").all(repositoryId)
        .map((column) => ({ ...column, role: roles.get(column.id) ?? null })),
      features: preparedStatement(database, "SELECT id, name FROM features WHERE repository_id = ? ORDER BY created_at, id").all(repositoryId),
      tasks: preparedStatement(database, "SELECT * FROM tasks WHERE repository_id = ? ORDER BY number").all(repositoryId),
    };
  }

  // `resolveSessionFacts(sessionId)` is supplied by the entry point from committed facts (see task-board.mjs).
  // Without it a linked session keeps the stored unknown defaults. `resolveGateFacts(repositoryId)` supplies the
  // committed start-gate facts the same way; without it every gate reads unknown. `resolveCheckFacts(sessionId)`
  // supplies the facts the done-when checks judge; without it a waiting task carries no reading of its checks.
  const served = (board, { resolveSessionFacts = null, resolveGateFacts = null, resolveCheckFacts = null }) =>
    fillQueueGates({ database, board: fillTaskSessions(board, resolveSessionFacts, resolveCheckFacts), resolveGateFacts, at: now() });

  function readBoard(repositoryId, resolvers = {}) {
    // An invalid ID is not echoed back, and a store that cannot be used serves no content.
    if (!isRepositoryId(repositoryId)) return emptyBoard("", "unavailable");
    if (!database) return emptyBoard(repositoryId, "unavailable");
    try {
      seedColumns(repositoryId);
      const board = projectBoard(repositoryId, loadRows(repositoryId), { at: now() });
      return board ? served(board, resolvers) : emptyBoard(repositoryId, "unavailable");
    } catch {
      return emptyBoard(repositoryId, "unavailable");
    }
  }

  function apply(repositoryId, action, payload, resolvers = {}) {
    if (!isRepositoryId(repositoryId)) return { ok: false, error: "invalid" };
    const handler = typeof action === "string" && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    if (!handler) return { ok: false, error: "unsupported" };
    // A store that cannot be used refuses the write before any handler can touch it.
    if (!database) return { ok: false, error: "conflict" };
    try {
      const board = runTransaction(database, () => {
        const result = handler({ database, repositoryId, ensureRepository, now }, payload);
        if (!result.ok) throw new ActionRejected(result.error);
        // The write stands only if the whole board, the new row included, still projects.
        const projected = projectBoard(repositoryId, loadRows(repositoryId), { at: now() });
        if (!projected) throw new ActionRejected("conflict");
        return projected;
      });
      return { ok: true, board: served(board, resolvers) };
    } catch (error) {
      return { ok: false, error: error instanceof ActionRejected ? error.code : "conflict" };
    }
  }

  // Dispatch (task-dispatch.mjs): a plan mints a token and keeps only its digest; a bind links the session that
  // reports the token once and discards the digest. Every call answers a fixed error.
  function dispatch(operation, input) {
    if (!database) return { ok: false, error: "unavailable" };
    try {
      return operation({ database, transaction: (work) => runTransaction(database, work), ...input });
    } catch {
      return { ok: false, error: "unavailable" };
    }
  }

  function close() {
    try { database?.close(); } catch { /* already closed or unusable */ }
    database = null;
  }

  // A start is held unless the gates pass on a board that still projects (task-queue-advance.mjs).
  const planStart = (repositoryId, payload, resolveFacts, resolveGateFacts = null) => dispatch(startPlan, {
    repositoryId, payload, resolveFacts, now,
    gatesHold: (taskId) => {
      const board = projectBoard(repositoryId, loadRows(repositoryId), { at: now() });
      return !board || !startGates({ database, repositoryId, board, taskId, resolveGateFacts, at: now() }).ok;
    },
  });
  const abortStart = (repositoryId, payload) => dispatch(startAbort, { repositoryId, payload });
  const bindSession = (payload) => dispatch(bindDispatch, { payload, now });
  // The agent's report (task-report.mjs): `resolveFacts()` supplies committed repository facts for the checks.
  const completeTask = (payload, resolveFacts) => dispatch(reportComplete, { payload, resolveFacts, now });
  const blockTask = (payload) => dispatch(reportBlock, { payload, now });
  // A session that ended without a report (task-stall.mjs): `resolveFacts(sessionId)` supplies committed session facts.
  const stallEnded = (resolveFacts) => dispatch(stallEndedTasks, { resolveFacts, now });
  // The queue (task-queue-advance.mjs): which tasks the running queues start now, and the pause a failed start reports.
  const nextStarts = ({ resolveGateFacts = null } = {}) => dispatch(nextQueueStarts, { loadRows, resolveGateFacts, now });
  const pauseAt = (repositoryId, payload) => dispatch(pauseQueue, { repositoryId, payload });
  // The Sessions list's task references (task-session-link.mjs): plain reads that answer null when the store cannot be used.
  const link = (read, input) => {
    if (!database) return null;
    try { return read({ database, ...input }); } catch { return null; }
  };
  const sessionTasks = (sessionIds) => link(sessionTaskReferences, { sessionIds });
  const featureLink = (featureId) => link(featureSessions, { featureId });
  const featureLinks = () => link(featureSessionGroups, {});
  return Object.freeze({ readBoard, apply, planStart, abortStart, bindSession, completeTask, blockTask, stallEndedTasks: stallEnded, nextQueueStarts: nextStarts, pauseQueue: pauseAt,
    sessionTasks, featureSessions: featureLink, featureSessionGroups: featureLinks, close });
}
