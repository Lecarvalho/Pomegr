import crypto from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { installSqliteExperimentalWarningFilter } from "../persistence/monitor-store.mjs";
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { fillTaskSessions } from "./task-board.mjs";
import { arilMemoryAdd, arilMemoryRemove, arilMemoryUpdate, arilSettingsSet, ensureArilSettings, pruneArilTask, readAril } from "./task-aril-settings.mjs";
import { followUpOperations } from "./task-aril-follow-ups.mjs";
import { ensureArilGrants, grantOperations, grantStart, grantStartAllowed, grantStartGates, grantStop, readGrant } from "./task-aril-grant.mjs";
import { TASK_HOME_BOARD_LIMIT, summarizeTaskHome } from "./task-home.mjs";
import { hasFixedColumns, readColumnRoles, reconcileFixedColumns, seedColumnRoles, settleReadyColumn } from "./task-columns.mjs";
import { bindDispatch, startAbort, startBind, startPlan } from "./task-dispatch.mjs";
import { deleteTaskReviews, ensureTaskReviews, fillTaskReviews, reviewOperations } from "./task-review.mjs";
import { fillQueueGates, fillQueueWaits, nextQueueStarts, pauseQueue, queueSettings, readPauseReason, readQueueSchedule, releaseDanglingPause, releasePause, startGates } from "./task-queue-advance.mjs";
import { releaseQueue, reportableChecks, reportBlock, reportComplete, resolveDone, resolveRequeue } from "./task-report.mjs";
import { deleteTaskReportHistory } from "./task-report-history.mjs";
import { deleteTaskEvents, ensureTaskEvents } from "./task-events.mjs";
import { deleteTaskOutcome, ensureTaskOutcomes } from "./task-outcomes.mjs";
import { ensureScorecardSnapshots, readScorecardSnapshot } from "./task-scorecard.mjs";
import { ackTaskLog, ensureTaskLog, readTaskLog } from "./task-log.mjs";
import { declareArilTaskRework, declareTaskRework, ensureTaskRework, fillTaskRework, removeTaskRework } from "./task-rework.mjs";
import { deleteTaskBlockHold } from "./task-block-holds.mjs";
import { featureSessionGroups, featureSessions, sessionAssignedReferences, sessionReviewReferences, sessionTaskReferences } from "./task-session-link.mjs";
import { stallEndedTasks } from "./task-stall.mjs";
import { deleteTaskPullRequestSeen, logPullRequests } from "./task-pull-request-log.mjs";
import { deleteTaskAdder, readTaskAdder, writeTaskAdder } from "./task-adder.mjs";
import { assignSession, deleteTaskAssigned, readTaskAssignments, unassignSession } from "./task-assignments.mjs";
import { createRecentAdds, recentAddKey } from "./task-recent-adds.mjs";
import { deleteTaskAttention, readTaskAttentions } from "./task-attention.mjs";
import { deleteFeatureDetails, findFeature, readFeature, readFeatureDone, readFeaturesDone, writeFeatureDetails, writeFeatureDone } from "./task-feature-details.mjs";
import { deleteFeature } from "./task-feature-actions.mjs";
import { agentSetAfter, deleteTaskAfter, readTaskAfter, setTaskAfter } from "./task-after.mjs";
import { agentTaskEntries } from "./task-agent-read.mjs";
import { moveTask, queueGroupCards } from "./task-card-moves.mjs";
import { groupTasks, markReadyGroupsMigrated, migrateStepGroups, pruneTaskGroups, readTaskGroups, settleGroupLanes, ungroupTasks, writeTaskGroup } from "./task-groups.mjs";
import { dispatchStanding } from "./task-dispatch-standing.mjs";
import { addTaskImage, deleteTaskImageList, readTaskImage, readTaskImages, removeTaskImage, removeTaskImageFiles, taskImagePaths } from "./task-images.mjs";
import { readTaskRemoteControl, readTaskRemoteControls, writeTaskRemoteControl } from "./task-remote-control.mjs";
import { deleteTaskSource, readTaskSource, readTaskSources, writeTaskSource } from "./task-source.mjs";
import { deleteTaskWorktreeCleanup, pendingWorktreeCleanups, readTaskKeepWorktree, readTaskKeepWorktrees, settleWorktreeCleanup, writeTaskKeepWorktree } from "./task-worktree-cleanup.mjs";
import {
  DEFAULT_TASK_COLUMNS, TASK_BOUNDS, emptyBoard, isRepositoryId, isTaskId, isTaskSessionId, normalizeCreatePayload, normalizeDeletePayload,
  composePromotedText, normalizeAgentFeatureCreatePayload, normalizeAgentFeatureDeletePayload, normalizeAgentFeatureUpdatePayload, normalizeFeatureCreatePayload, normalizeFeatureUpdatePayload,  normalizePromotePayload, normalizeQueueAddPayload, normalizeRecordIssuePayload, normalizeQueueTaskPayload, normalizeUpdatePayload,
  plainTaskText, projectBoard, rowStarted, taskIdFromNumber,
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
function ensureAdditionalTables(database) {
  for (const ensure of [
    ensureTaskEvents, ensureTaskOutcomes, ensureScorecardSnapshots, ensureTaskLog,
    ensureTaskRework, ensureTaskReviews, ensureArilSettings, ensureArilGrants,
  ]) ensure(database);
}
function createFreshStore(database) {
  runTransaction(database, () => {
    createSchema(database);
    ensureAdditionalTables(database);
    preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?)").run("schema_version", String(TASK_STORE_SCHEMA_VERSION));
    preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?)").run("created_at", String(Date.now()));
  });
  database.exec("PRAGMA journal_mode = WAL");
}
// Throws unless the file is an intact store of exactly this version.
function verifyExistingStore(database) {
  const check = database.prepare("PRAGMA quick_check").get();
  if ((check ? Object.values(check)[0] : null) !== "ok") throw new Error("TASK_STORE_MALFORMED");
  const version = database.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
  if (!version || version.value !== String(TASK_STORE_SCHEMA_VERSION)) throw new Error("TASK_STORE_VERSION");
  for (const table of TABLES) database.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all();
}
// The open database, or null when the store cannot be used.
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
    else {
      verifyExistingStore(database);
      ensureAdditionalTables(database);
    }
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

function ensureRepository(database, repositoryId) {
  const inserted = preparedStatement(database, "INSERT OR IGNORE INTO repositories (repository_id, created_at) VALUES (?, ?)").run(repositoryId, Date.now());
  if (Number(inserted.changes) === 0) return;
  // A new board never held steps, so it has nothing to bring to parallel groups.
  markReadyGroupsMigrated(database, repositoryId);
  const insertColumn = preparedStatement(database, "INSERT INTO columns (id, repository_id, name, position) VALUES (?, ?, ?, ?)");
  const ids = DEFAULT_TASK_COLUMNS.map(() => newOpaqueId("col"));
  DEFAULT_TASK_COLUMNS.forEach((name, position) => insertColumn.run(ids[position], repositoryId, name, position));
  seedColumnRoles(database, repositoryId, ids);
}

// Task numbers are monotonic per repository and never reused.
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

const featureExists = (database, repositoryId, id) =>
  preparedStatement(database, "SELECT 1 FROM features WHERE repository_id = ? AND id = ?").get(repositoryId, id) !== undefined;

// A feature is done when the owner marked it done, whatever its tasks' states; only a feature that is not done takes a task.
const featureIsDone = readFeatureDone;

// The schema requires a step for a task of a feature. Nothing reads it since steps went, so it is always 1.
const storedStep = (featureId) => (featureId === null ? null : 1);

function createTask({ database, repositoryId, columnId = null }, payload) {
  const input = normalizeCreatePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  ensureRepository(database, repositoryId);
  const count = Number(preparedStatement(database, "SELECT COUNT(*) AS n FROM tasks WHERE repository_id = ?").get(repositoryId).n);
  if (count >= TASK_BOUNDS.tasksPerRepository) return { ok: false, error: "limit" };
  if (input.featureId !== null) {
    if (!featureExists(database, repositoryId, input.featureId)) return { ok: false, error: "not_found" };
    if (featureIsDone(database, repositoryId, input.featureId)) return { ok: false, error: "conflict" };
  }
  const first = columnId === null ? preparedStatement(database, "SELECT id FROM columns WHERE repository_id = ? ORDER BY position, id LIMIT 1").get(repositoryId) : { id: columnId };
  if (!first) return { ok: false, error: "conflict" };
  const last = preparedStatement(database, "SELECT MAX(position) AS last FROM tasks WHERE repository_id = ? AND column_id = ?").get(repositoryId, first.id);
  const position = last?.last === null || last?.last === undefined ? 0 : Number(last.last) + 1;
  const number = nextTaskNumber(database, repositoryId);
  if (taskIdFromNumber(number) === undefined) return { ok: false, error: "limit" };
  const now = Date.now();
  preparedStatement(database, `INSERT INTO tasks (repository_id, number, text, column_id, position, run_provider, run_model, run_effort, checks, own_condition, created_at, updated_at, feature_id, step)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(repositoryId, number, input.text, first.id, position, input.run.provider, input.run.model, input.run.effort,
      JSON.stringify(input.completeWhen.checks), input.completeWhen.own, now, now, input.featureId, storedStep(input.featureId));
  if (input.run.remoteControl) writeTaskRemoteControl(database, repositoryId, number, true);
  if (input.run.keepWorktree) writeTaskKeepWorktree(database, repositoryId, number, true);
  reserveTaskNumber(database, repositoryId, number + 1);
  return { ok: true, number };
}

function promoteIssue({ database, repositoryId }, payload) {
  const input = normalizePromotePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  for (const issueNumber of readTaskSources(database, repositoryId).values()) if (issueNumber === input.number) return { ok: false, error: "conflict" };
  const text = composePromotedText(input);
  if (text.length > TASK_BOUNDS.textLength) return { ok: false, error: "limit" };
  const created = createTask({ database, repositoryId }, { text });
  if (!created.ok) return created;
  writeTaskSource(database, repositoryId, created.number, input.number);
  return { ok: true, number: created.number };
}

function recordIssue({ database, repositoryId }, payload) {
  const input = normalizeRecordIssuePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const stored = preparedStatement(database, "SELECT number FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.taskNumber);
  if (!stored) return { ok: false, error: "not_found" };
  if (readTaskSource(database, repositoryId, input.taskNumber) !== null) return { ok: false, error: "conflict" };
  for (const issueNumber of readTaskSources(database, repositoryId).values()) if (issueNumber === input.issueNumber) return { ok: false, error: "conflict" };
  writeTaskSource(database, repositoryId, input.taskNumber, input.issueNumber);
  return { ok: true };
}

function updateTask({ database, repositoryId, now }, payload) {
  const input = normalizeUpdatePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const stored = preparedStatement(database, "SELECT text, feature_id, step, run_provider, run_model, run_effort, checks, own_condition, state, session_id, dispatch_token FROM tasks WHERE repository_id = ? AND number = ?")
    .get(repositoryId, input.number);
  if (!stored) return { ok: false, error: "not_found" };
  // The session was started from the stored task, so a later edit would never reach it.
  if (rowStarted(stored, now())) return { ok: false, error: "conflict" };
  const run = input.run ?? { provider: stored.run_provider, model: stored.run_model, effort: stored.run_effort, remoteControl: readTaskRemoteControl(database, repositoryId, input.number), keepWorktree: readTaskKeepWorktree(database, repositoryId, input.number) };
  const completeWhen = input.completeWhen ? { checks: JSON.stringify(input.completeWhen.checks), own: input.completeWhen.own } : { checks: stored.checks, own: stored.own_condition };
  const placement = updatedPlacement(database, repositoryId, stored, input);
  if (placement.error) return { ok: false, error: placement.error };
  preparedStatement(database, `UPDATE tasks SET text = ?, run_provider = ?, run_model = ?, run_effort = ?, checks = ?, own_condition = ?, feature_id = ?, step = ?, updated_at = ?
    WHERE repository_id = ? AND number = ?`)
    .run(input.text ?? stored.text, run.provider, run.model, run.effort, completeWhen.checks, completeWhen.own, placement.featureId, storedStep(placement.featureId), Date.now(), repositoryId, input.number);
  if (input.run) writeTaskRemoteControl(database, repositoryId, input.number, run.remoteControl);
  if (input.run) writeTaskKeepWorktree(database, repositoryId, input.number, run.keepWorktree === true);
  return { ok: true };
}

// The feature an update leaves the task in.
function updatedPlacement(database, repositoryId, stored, input) {
  const current = stored.feature_id ?? null;
  if (input.featureId === undefined || input.featureId === current) return { featureId: current };
  if (input.featureId === null) return { featureId: null };
  if (!featureExists(database, repositoryId, input.featureId)) return { error: "not_found" };
  return featureIsDone(database, repositoryId, input.featureId) ? { error: "conflict" } : { featureId: input.featureId };
}
function deleteTask({ database, repositoryId, now }, payload) {
  const input = normalizeDeletePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const task = preparedStatement(database, "SELECT column_id, position FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { ok: false, error: "not_found" };
  const reserved = nextTaskNumber(database, repositoryId);
  preparedStatement(database, "DELETE FROM tasks WHERE repository_id = ? AND number = ?").run(repositoryId, input.number);
  deleteTaskSource(database, repositoryId, input.number);
  deleteTaskAttention(database, repositoryId, input.number);
  deleteTaskReportHistory(database, repositoryId, input.number);
  deleteTaskEvents(database, repositoryId, input.number);
  deleteTaskOutcome(database, repositoryId, input.number);
  deleteTaskReviews(database, repositoryId, input.number);
  pruneArilTask({ database, repositoryId, now }, payload.id);
  deleteTaskPullRequestSeen(database, repositoryId, input.number);
  deleteTaskBlockHold(database, repositoryId, input.number);
  deleteTaskImageList(database, repositoryId, input.number);
  deleteTaskAdder(database, repositoryId, input.number);
  deleteTaskAssigned(database, repositoryId, input.number);
  writeTaskRemoteControl(database, repositoryId, input.number, false);
  writeTaskGroup(database, repositoryId, input.number, null);
  deleteTaskAfter(database, repositoryId, input.number);
  deleteTaskWorktreeCleanup(database, repositoryId, input.number);
  reserveTaskNumber(database, repositoryId, Math.max(reserved, input.number + 1));
  preparedStatement(database, "UPDATE tasks SET position = position - 1 WHERE repository_id = ? AND column_id = ? AND position > ?")
    .run(repositoryId, task.column_id, task.position);
  // A blocked or paused queue must not keep naming a task that is gone.
  releaseQueue(database, repositoryId);
  releasePause({ database, repositoryId, now }, taskIdFromNumber(input.number));
  return { ok: true };
}

// The agent's `add_task`, `remove_task` (task-adder.mjs), and `update_task`.
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function agentCreateTask(context, payload) {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== "sessionId" && key !== "task" && key !== "after") || !isTaskSessionId(payload.sessionId)
    || (payload.after !== undefined && !Array.isArray(payload.after))) {
    return { ok: false, error: "invalid" };
  }
  const { database, repositoryId, recentAdds } = context;
  const input = normalizeCreatePayload(payload.task);
  const addKey = input && recentAdds ? recentAddKey(repositoryId, payload.sessionId, input.text, input.featureId) : null;
  const earlier = addKey === null ? null : recentAdds.find(addKey);
  if (earlier !== null) {
    const stillThere = preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, earlier) !== undefined
      && readTaskAdder(database, repositoryId, earlier) === payload.sessionId;
    if (stillThere) return { ok: true, number: earlier };
    recentAdds.forget(addKey);
  }
  const created = createTask(context, payload.task);
  if (created.ok) writeTaskAdder(database, repositoryId, created.number, payload.sessionId);
  if (created.ok && payload.after !== undefined && payload.after.length > 0) {
    const set = agentSetAfter(context, taskIdFromNumber(created.number), payload.after);
    if (!set.ok) return set;
  }
  return created.ok && addKey !== null ? { ...created, addKey } : created;
}

function agentRemoveTask(context, payload) {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== "sessionId" && key !== "id") || !isTaskSessionId(payload.sessionId)) {
    return { ok: false, error: "invalid" };
  }
  const input = normalizeDeletePayload({ id: payload.id });
  if (!input) return { ok: false, error: "invalid" };
  const { database, repositoryId, now } = context;
  const task = preparedStatement(database, "SELECT state, session_id, dispatch_token, report_at FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  const waits = task && (task.state === "not_queued" || task.state === "queued" || task.state === "scheduled")
    && (task.session_id ?? null) === null && (task.report_at ?? null) === null && dispatchStanding(task.dispatch_token, now()) !== "live";
  if (!waits || readTaskAdder(database, repositoryId, input.number) !== payload.sessionId) return { ok: false, error: "not_found" };
  return deleteTask(context, { id: payload.id });
}

const AGENT_UPDATE_KEYS = Object.freeze({ payload: ["id", "text", "run", "completeWhen", "after"], run: ["provider", "model", "effort"], completeWhen: ["checks", "own"] });
// A part an agent may set field by field: a record with at least one of its keys and no other.
const agentUpdatePart = (value, keys) => value === undefined
  || (isRecord(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => keys.includes(key)));

function storedChecks(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// The agent's `update_task`: any task of the board that has not started. A field that is absent stays as stored, and
// the rules of each field are the ones of the desktop `update`.
function agentUpdateTask(context, payload) {
  if (!isRecord(payload) || Object.keys(payload).some((key) => !AGENT_UPDATE_KEYS.payload.includes(key))
    || !agentUpdatePart(payload.run, AGENT_UPDATE_KEYS.run) || !agentUpdatePart(payload.completeWhen, AGENT_UPDATE_KEYS.completeWhen)
    || (payload.run && Object.values(payload.run).some((value) => value === null || value === undefined))
    || (payload.completeWhen && payload.completeWhen.checks === null)
    || (payload.after !== undefined && !Array.isArray(payload.after))
    || AGENT_UPDATE_KEYS.payload.every((key) => key === "id" || payload[key] === undefined)) return { ok: false, error: "invalid" };
  const input = normalizeDeletePayload({ id: payload.id });
  if (!input) return { ok: false, error: "invalid" };
  const { database, repositoryId, now } = context;
  const stored = preparedStatement(database, "SELECT run_provider, run_model, run_effort, checks, own_condition, state, session_id, dispatch_token FROM tasks WHERE repository_id = ? AND number = ?")
    .get(repositoryId, input.number);
  // One refusal for a task that is not there and a task that started, so the answer tells nothing about a task.
  if (!stored || rowStarted(stored, now())) return { ok: false, error: "not_found" };
  const update = { id: payload.id };
  if (payload.text !== undefined) update.text = payload.text;
  if (payload.run) {
    const provider = payload.run.provider ?? stored.run_provider;
    update.run = {
      provider,
      // A model belongs to its provider, so another provider without a model takes that provider's default.
      model: payload.run.model ?? (provider === stored.run_provider ? stored.run_model : null),
      effort: payload.run.effort ?? stored.run_effort,
      remoteControl: provider !== "codex" && readTaskRemoteControl(database, repositoryId, input.number),
      keepWorktree: readTaskKeepWorktree(database, repositoryId, input.number),
    };
  }
  if (payload.completeWhen) {
    update.completeWhen = {
      checks: payload.completeWhen.checks ?? storedChecks(stored.checks),
      own: payload.completeWhen.own === undefined ? stored.own_condition : payload.completeWhen.own,
    };
  }
  // A call that sets only what the task runs after leaves the task's own fields untouched.
  if (Object.keys(update).length > 1) {
    const result = updateTask(context, update);
    if (!result.ok) return result.error === "invalid" ? result : { ok: false, error: "not_found" };
  }
  return payload.after === undefined ? { ok: true } : agentSetAfter(context, payload.id, payload.after);
}

function insertFeature(database, repositoryId, name) {
  ensureRepository(database, repositoryId);
  const stored = preparedStatement(database, "SELECT name, created_at FROM features WHERE repository_id = ?").all(repositoryId);
  if (stored.length >= TASK_BOUNDS.featuresPerRepository) return { ok: false, error: "limit" };
  if (stored.some((feature) => feature.name === name)) return { ok: false, error: "conflict" };
  // Features list in creation order, so a creation time never ties with or precedes an earlier one.
  const createdAt = Math.max(Date.now(), ...stored.map((feature) => Number(feature.created_at) + 1));
  const featureId = newOpaqueId("feat");
  preparedStatement(database, "INSERT INTO features (id, repository_id, name, created_at) VALUES (?, ?, ?, ?)").run(featureId, repositoryId, name, createdAt);
  return { ok: true, featureId };
}

function createFeature({ database, repositoryId }, payload) {
  const input = normalizeFeatureCreatePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const created = insertFeature(database, repositoryId, input.name);
  if (created.ok) writeFeatureDetails(database, repositoryId, created.featureId, input);
  return created.ok ? { ok: true } : created;
}

// The agent's `create_feature`, `update_feature`, and `delete_feature` (task-feature-details.mjs).
function agentCreateFeature({ database, repositoryId }, payload) {
  const input = normalizeAgentFeatureCreatePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const created = insertFeature(database, repositoryId, input.name);
  if (created.ok) writeFeatureDetails(database, repositoryId, created.featureId, input);
  return created;
}

const agentUpdateFeature = (context, payload) => applyFeatureUpdate(context, normalizeAgentFeatureUpdatePayload(payload));
// The desktop's `feature_update`; it answers no ID, and a rename to the feature's own title is no conflict.
const updateFeature = (context, payload) => {
  const result = applyFeatureUpdate(context, normalizeFeatureUpdatePayload(payload));
  return result.ok ? { ok: true } : result;
};

function applyFeatureUpdate({ database, repositoryId }, input) {
  if (!input) return { ok: false, error: "invalid" };
  const stored = findFeature(database, repositoryId, input.feature);
  if (!stored) return { ok: false, error: "not_found" };
  if (input.name !== undefined && input.name !== stored.name) {
    if (findFeature(database, repositoryId, { name: input.name })) return { ok: false, error: "conflict" };
    preparedStatement(database, "UPDATE features SET name = ? WHERE repository_id = ? AND id = ?").run(input.name, repositoryId, stored.id);
  }
  writeFeatureDetails(database, repositoryId, stored.id, input);
  // Only the desktop's `feature_update` carries `done`; marking done or reopening moves, unqueues, and deletes no task.
  if (input.done !== undefined) writeFeatureDone(database, repositoryId, stored.id, input.done);
  return { ok: true, featureId: stored.id };
}

// Only a feature with no task is deleted, so no task loses its feature.
function agentDeleteFeature({ database, repositoryId }, payload) {
  const input = normalizeAgentFeatureDeletePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const stored = findFeature(database, repositoryId, input.feature);
  if (!stored) return { ok: false, error: "not_found" };
  if (preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND feature_id = ? LIMIT 1").get(repositoryId, stored.id) !== undefined) return { ok: false, error: "conflict" };
  preparedStatement(database, "DELETE FROM features WHERE repository_id = ? AND id = ?").run(repositoryId, stored.id);
  deleteFeatureDetails(database, repositoryId, stored.id);
  return { ok: true };
}

function addToQueue({ database, repositoryId, now }, payload) {
  const input = normalizeQueueAddPayload(payload, now());
  if (!input) return { ok: false, error: "invalid" };
  const task = preparedStatement(database, "SELECT state, session_id FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { ok: false, error: "not_found" };
  const waiting = task.state === "not_queued" || task.state === "queued" || task.state === "scheduled";
  if (!input.block && ((task.session_id ?? null) !== null || (input.at === null ? task.state !== "not_queued" && task.state !== "scheduled" : !waiting))) return { ok: false, error: "conflict" };
  const queue = preparedStatement(database, "UPDATE tasks SET state = ?, scheduled_at = ?, queue_position = NULL, updated_at = ? WHERE repository_id = ? AND number = ?");
  if (!input.block) {
    queue.run(input.at === null ? "queued" : "scheduled", input.at, Date.now(), repositoryId, input.number);
    return { ok: true };
  }
  return queueGroupCards({ database, repositoryId, now }, input.number, queue);
}

function removeFromQueue({ database, repositoryId, now }, payload) {
  const input = normalizeQueueTaskPayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const task = preparedStatement(database, "SELECT state, session_id FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { ok: false, error: "not_found" };
  // A task with a linked session has left the queue already: it is in progress, and only Mark done or Requeue resolves it.
  if ((task.state !== "queued" && task.state !== "scheduled") || (task.session_id ?? null) !== null) return { ok: false, error: "conflict" };
  preparedStatement(database, "UPDATE tasks SET state = 'not_queued', queue_position = NULL, scheduled_at = NULL, updated_at = ? WHERE repository_id = ? AND number = ?")
    .run(Date.now(), repositoryId, input.number);
  writeTaskGroup(database, repositoryId, input.number, null);
  releasePause({ database, repositoryId, now }, taskIdFromNumber(input.number));
  return { ok: true };
}
// Actions by name.
const ACTIONS = Object.freeze({
  grant_start: grantStart, grant_stop: grantStop, aril_settings_set: arilSettingsSet, aril_memory_add: arilMemoryAdd, aril_memory_update: arilMemoryUpdate, aril_memory_remove: arilMemoryRemove,
  create: createTask, update: updateTask, delete: deleteTask, move: moveTask,
  feature_create: createFeature, feature_update: updateFeature, feature_delete: deleteFeature,
  queue_add: addToQueue, queue_remove: removeFromQueue, queue_group: groupTasks, queue_ungroup: ungroupTasks, queue_settings: queueSettings,
  resolve_done: resolveDone, resolve_requeue: resolveRequeue,
  session_assign: assignSession, session_unassign: unassignSession, after_set: setTaskAfter,
  rework_declare: declareTaskRework, rework_remove: removeTaskRework,
  // Store only: absent from TASK_ACTIONS, so the route and the desktop never accept it.
  promote_issue: promoteIssue, record_issue: recordIssue,
  agent_create: agentCreateTask, agent_remove: agentRemoveTask, agent_update: agentUpdateTask,
  agent_feature_create: agentCreateFeature, agent_feature_update: agentUpdateFeature, agent_feature_delete: agentDeleteFeature,
});
class ActionRejected extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
// Opens the task store in `directory`.
export function openTaskStore({ directory, now = Date.now } = {}) {
  let database = openDatabase(directory);
  // Memory only: what makes the agent's `add_task` safe to repeat for a few minutes (task-recent-adds.mjs).
  const recentAdds = createRecentAdds({ now });

  const repositoryExists = (repositoryId) => preparedStatement(database, "SELECT 1 FROM repositories WHERE repository_id = ?").get(repositoryId) !== undefined;

  const reconcileColumns = (repositoryId) => reconcileFixedColumns(database, repositoryId, () => newOpaqueId("col"));

  function seedColumns(repositoryId) {
    if (!repositoryExists(repositoryId)) {
      runTransaction(database, () => ensureRepository(database, repositoryId));
      return;
    }
    if (hasFixedColumns(database, repositoryId)) return;
    runTransaction(database, () => {
      reconcileColumns(repositoryId);
      if (!projectBoard(repositoryId, loadRows(repositoryId), { at: now() })) throw new ActionRejected("conflict");
    });
  }

  // A group is whole only after both: memberships that no longer count go, then each group's cards stand together.
  function settleGroupsAndReady(repositoryId) {
    pruneTaskGroups(database, repositoryId);
    settleReadyColumn(database, repositoryId, readTaskGroups(database, repositoryId));
    settleGroupLanes(database, repositoryId, now());
  }
  const newGroupId = () => newOpaqueId("grp");
  function migrateGroups(repositoryId) {
    runTransaction(database, () => {
      migrateStepGroups(database, repositoryId, newGroupId);
      if (!projectBoard(repositoryId, loadRows(repositoryId), { at: now() })) throw new ActionRejected("conflict");
    });
  }

  function settleReady(repositoryId) {
    runTransaction(database, () => {
      settleGroupsAndReady(repositoryId);
      if (!projectBoard(repositoryId, loadRows(repositoryId), { at: now() })) throw new ActionRejected("conflict");
    });
  }
  function storedSchedule(repositoryId) {
    const { startAt, stopAfter } = readQueueSchedule(database, repositoryId);
    return { start_at: startAt, stop_after: stopAfter };
  }

  function loadRows(repositoryId) {
    const repository = preparedStatement(database, "SELECT queue_status, queue_blocked_by FROM repositories WHERE repository_id = ?").get(repositoryId);
    const roles = readColumnRoles(database, repositoryId);
    const sources = readTaskSources(database, repositoryId);
    const attentions = readTaskAttentions(database, repositoryId);
    // A task's image list is kept there as well; the bytes are files beside the database (task-images.mjs).
    const images = readTaskImages(database, repositoryId);
    const remoteControls = readTaskRemoteControls(database, repositoryId);
    const keepWorktrees = readTaskKeepWorktrees(database, repositoryId);
    const assignments = readTaskAssignments(database, repositoryId);
    const groups = readTaskGroups(database, repositoryId);
    const after = readTaskAfter(database, repositoryId);
    const featuresDone = readFeaturesDone(database, repositoryId);
    return {
      repository: repository ? { ...repository, pause_reason: readPauseReason(database, repositoryId), ...storedSchedule(repositoryId) } : repository,
      columns: preparedStatement(database, "SELECT id, name, position FROM columns WHERE repository_id = ? ORDER BY position, id").all(repositoryId)
        .map((column) => ({ ...column, role: roles.get(column.id) ?? null })),
      features: preparedStatement(database, "SELECT id, name FROM features WHERE repository_id = ? ORDER BY created_at, id").all(repositoryId)
        .map((feature) => ({ ...feature, done: featuresDone.has(feature.id) })),
      tasks: preparedStatement(database, "SELECT * FROM tasks WHERE repository_id = ? ORDER BY number").all(repositoryId)
        .map((row) => ({ ...row, group: groups.get(Number(row.number)) ?? null, after: after.get(Number(row.number)) ?? [], source_issue: sources.get(Number(row.number)) ?? null, report_attention: attentions.get(Number(row.number)) ?? null, images: images.get(Number(row.number)) ?? [], run_remote_control: remoteControls.has(Number(row.number)), run_keep_worktree: keepWorktrees.has(Number(row.number)), assigned_sessions: assignments.get(Number(row.number)) ?? [] })),
    };
  }

  // `resolveSessionFacts(sessionId)` is supplied by the entry point from committed facts (see task-board.mjs).
  if (database) {
    try {
      for (const { repository_id: repositoryId } of preparedStatement(database, "SELECT repository_id FROM repositories").all()) {
        try { seedColumns(repositoryId); } catch { /* stays unavailable until it projects */ }
        try { migrateGroups(repositoryId); } catch { /* brought to groups by the first action instead */ }
        try { settleReady(repositoryId); } catch { /* settled by the next action instead */ }
        try { runTransaction(database, () => releaseQueue(database, repositoryId)); } catch { /* released by the next resolution instead */ }
        try { runTransaction(database, () => releaseDanglingPause({ database, repositoryId, now })); } catch { /* served without the task's ID until the queue is turned on or off */ }
      }
    } catch { /* the store is read again on the first board read */ }
  }

  // `rows` are the stored rows the board was projected from: the gates and the waits read what a board does not carry, a live dispatch.
  const served = (board, rows, { resolveSessionFacts = null, resolveGateFacts = null, resolveCheckFacts = null }) => {
    const at = now();
    // One board asks for its gate facts once, so the gates and the waits judge the same reading.
    let asked = null;
    const gateFacts = typeof resolveGateFacts === "function" ? (id) => (asked ??= { facts: resolveGateFacts(id) }).facts : null;
    const gated = fillQueueGates({ database, board: fillTaskSessions(board, resolveSessionFacts, resolveCheckFacts), rows, resolveGateFacts: gateFacts, at });
    const aril = { ...readAril(database, board.repositoryId), grant: runTransaction(database, () => readGrant(database, board.repositoryId, at)) };
    return { ...fillTaskRework(database, fillTaskReviews(database, fillQueueWaits({ database, board: gated, rows, resolveGateFacts: gateFacts, at }))), aril };
  };
  function readBoard(repositoryId, resolvers = {}) {
    // An invalid ID is not echoed back, and a store that cannot be used serves no content.
    if (!isRepositoryId(repositoryId)) return emptyBoard("", "unavailable");
    if (!database) return emptyBoard(repositoryId, "unavailable");
    try {
      seedColumns(repositoryId);
      const rows = loadRows(repositoryId);
      const board = projectBoard(repositoryId, rows, { at: now() });
      return board ? served(board, rows, resolvers) : emptyBoard(repositoryId, "unavailable");
    } catch {
      return emptyBoard(repositoryId, "unavailable");
    }
  }

  // What `get_task` and `list_tasks` read (task-agent-read.mjs): each task of one board in the served-task shape, or null.
  // It seeds nothing and writes nothing; a board that was never written has no task.
  function readAgentTasks(repositoryId, { includeChatReport = false } = {}) {
    if (!database || !isRepositoryId(repositoryId)) return null;
    try {
      const rows = loadRows(repositoryId);
      if (!rows.repository) return [];
      const at = now();
      const board = projectBoard(repositoryId, rows, { at });
      return board ? agentTaskEntries(board, rows, at, { includeChatReport }) : null;
    } catch {
      return null;
    }
  }

  // The Tasks home (task-home.mjs): every stored board, summarized. It seeds nothing and writes nothing.
  function readHome({ resolveSessionFacts = null } = {}) {
    if (!database) return null;
    try {
      const entries = [];
      for (const { repository_id: repositoryId } of preparedStatement(database, "SELECT repository_id FROM repositories ORDER BY repository_id LIMIT ?").all(TASK_HOME_BOARD_LIMIT)) {
        if (!isRepositoryId(repositoryId)) continue;
        let board = null;
        try { board = projectBoard(repositoryId, loadRows(repositoryId), { at: now() }); } catch { board = null; }
        entries.push({ repositoryId, board: board ? fillTaskSessions(board, resolveSessionFacts) : null });
      }
      return summarizeTaskHome(entries);
    } catch {
      return null;
    }
  }
  function apply(repositoryId, action, payload, resolvers = {}) {
    if (!isRepositoryId(repositoryId)) return { ok: false, error: "invalid" };
    let taskId = null;
    let featureId = null;
    let added = null;
    let arilResult = null;
    const rework = action === "rework_declare" || action === "rework_remove";
    const handler = typeof action === "string" && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    if (!handler) return { ok: false, error: "unsupported" };
    // A store that cannot be used refuses the write before any handler can touch it.
    if (!database) return { ok: false, error: "conflict" };
    try {
      if (action === "grant_start" || action === "grant_stop") return runTransaction(database, () => handler({ database, repositoryId, ensureRepository, now }, payload));
      const board = runTransaction(database, () => {
        if (!rework && repositoryExists(repositoryId)) {
          reconcileColumns(repositoryId);
          migrateStepGroups(database, repositoryId, newGroupId);
        }
        const result = handler({ database, repositoryId, ensureRepository, now, recentAdds, newGroupId, resolveOutcomeFacts: resolvers.resolveOutcomeFacts ?? null }, payload);
        if (!result.ok) throw new ActionRejected(result.error);
        if (action.startsWith("aril_")) arilResult = result;
        added = typeof result.addKey === "string" ? { key: result.addKey, number: result.number } : null;
        featureId = typeof result.featureId === "string" ? result.featureId : null;
        if (!rework) settleGroupsAndReady(repositoryId);
        // Only `create`, `agent_create`, and `promote_issue` answer the task they made.
        taskId = action === "promote_issue" || action === "create" || action === "agent_create" ? taskIdFromNumber(result.number) ?? null : null;
        // The write stands only if the whole board, the new row included, still projects.
        const rows = loadRows(repositoryId);
        const projected = projectBoard(repositoryId, rows, { at: now() });
        if (!projected) throw new ActionRejected("conflict");
        return { projected, rows, status: result.status };
      });
      // An agent's add is remembered only once it has committed, so a rolled-back add is never answered as made.
      if (added) recentAdds.remember(added.key, added.number);
      if (arilResult) return arilResult;
      if (action === "delete" || action === "agent_remove") removeTaskImageFiles(directory, repositoryId, payload?.id);
      return { ok: true, board: served(board.projected, board.rows, resolvers), ...(rework && board.status ? { status: board.status } : {}), ...(taskId === null ? {} : { taskId }), ...(featureId === null ? {} : { featureId }) };
    } catch (error) {
      return { ok: false, error: error instanceof ActionRejected ? error.code : "conflict" };
    }
  }
  function promotedIssues(repositoryId) {
    const promoted = new Map();
    if (!database || !isRepositoryId(repositoryId)) return promoted;
    try {
      const existing = new Set(preparedStatement(database, "SELECT number FROM tasks WHERE repository_id = ?").all(repositoryId).map((row) => Number(row.number)));
      for (const [taskNumber, issueNumber] of readTaskSources(database, repositoryId)) {
        const taskId = taskIdFromNumber(taskNumber);
        if (existing.has(taskNumber) && taskId !== undefined && !promoted.has(issueNumber)) promoted.set(issueNumber, taskId);
      }
    } catch { /* an unreadable store promotes nothing */ }
    return promoted;
  }

  function issueDraft(repositoryId, taskId) {
    if (!database || !isRepositoryId(repositoryId) || !isTaskId(taskId)) return null;
    try {
      const number = Number(taskId.slice(2));
      const row = preparedStatement(database, "SELECT text FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number);
      if (!row || typeof row.text !== "string") return null;
      // GitHub gets the text only: where an image sits reads as the plain word, never an image or its ID.
      return { text: plainTaskText(row.text), hasSource: readTaskSource(database, repositoryId, number) !== null };
    } catch { return null; }
  }

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
  const planStart = (repositoryId, payload, resolveFacts, resolveGateFacts = null) => dispatch(startPlan, {
    repositoryId, payload, resolveFacts, now,
    featureOf: (featureId) => readFeature({ database, repositoryId, feature: featureId }),
    imagePaths: (taskId) => taskImagePaths({ database, directory, repositoryId, taskId }),
    grantAllows: (task, at) => grantStartAllowed(database, repositoryId, task, at),
    gatesHold: (taskId, grant) => {
      const rows = loadRows(repositoryId);
      const board = projectBoard(repositoryId, rows, { at: now() });
      if (!board) return true;
      const gates = (grant ? grantStartGates : startGates)({ database, repositoryId, board: grant ? fillTaskReviews(database, board) : board, rows, taskId, resolveGateFacts, at: now(), manual: !grant });
      if (gates.ok) return false;
      return gates.early !== true && gates.reasons.length === 1 && gates.reasons[0] === "tree_dirty" ? "tree_dirty" : true;
    },
  });
  const abortStart = (repositoryId, payload) => dispatch(startAbort, { repositoryId, payload });
  const bindSession = (payload) => dispatch(bindDispatch, { payload, now });
  const bindStart = (repositoryId, payload) => dispatch(startBind, { repositoryId, payload, now });
  const completeTask = (payload, resolveFacts) => dispatch(reportComplete, { payload, resolveFacts, now });
  const blockTask = (payload) => dispatch(reportBlock, { payload, now });
  const stallEnded = (resolveFacts, confirmation = null, recovery = null) => dispatch(stallEndedTasks, { resolveFacts, confirmation, recovery, now });
  const nextStarts = ({ resolveGateFacts = null } = {}) => dispatch(nextQueueStarts, { loadRows, resolveGateFacts, now });
  const pauseAt = (repositoryId, payload) => dispatch(pauseQueue, { repositoryId, payload });
  const worktreeCleanups = () => dispatch(pendingWorktreeCleanups, {});
  const worktreeCleaned = (repositoryId, payload) => dispatch(settleWorktreeCleanup, { repositoryId, payload });
  const link = (read, input) => {
    if (!database) return null;
    try { return read({ database, ...input }); } catch { return null; }
  };
  const sessionTasks = (sessionIds) => link(sessionTaskReferences, { sessionIds });
  const featureLink = (featureId) => link(featureSessions, { featureId });
  const featureLinks = () => link(featureSessionGroups, {});
  const reportChecks = (sessionId, taskId) => link(reportableChecks, { sessionId, taskId });
  const sessionAssigned = (sessionIds) => link(sessionAssignedReferences, { sessionIds });
  const sessionReviews = (sessionIds) => link(sessionReviewReferences, { sessionIds });
  const feature = (repositoryId, reference) => link(readFeature, { repositoryId, feature: reference });
  // A task's images (task-images.mjs): the bytes are files beside the database, the list is in `meta`.
  const image = (operation, repositoryId, payload) => {
    if (!database) return { ok: false, error: "conflict" };
    try {
      return operation({ database, transaction: (work) => runTransaction(database, work), directory, repositoryId, payload, now });
    } catch {
      return { ok: false, error: "conflict" };
    }
  };
  const addImage = (repositoryId, payload) => image(addTaskImage, repositoryId, payload);
  const removeImage = (repositoryId, payload) => image(removeTaskImage, repositoryId, payload);
  const readImage = (repositoryId, payload) => image(readTaskImage, repositoryId, payload);
  const readScorecard = (repositoryId, appVersion) => link(() => runTransaction(database, () => readScorecardSnapshot(database, repositoryId, appVersion, now())));
  const readLog = (repositoryId, options) => link(() => runTransaction(database, () => readTaskLog(database, repositoryId, options)));
  const ackLog = (repositoryId, consumer, through) => link(() => runTransaction(database, () => ackTaskLog(database, repositoryId, consumer, through)));
  const declareArilRework = (repositoryId, payload) => dispatch(({ database, transaction }) => transaction(() => declareArilTaskRework({ database, repositoryId, now }, payload)), {});
  return Object.freeze({ ...grantOperations(dispatch, loadRows, now, createTask), ...followUpOperations(dispatch, now), ...reviewOperations(dispatch, now), readBoard, readHome, readAgentTasks, apply, promotedIssues, issueDraft, planStart, abortStart, bindSession, bindStart, completeTask, blockTask, reportChecks, stallEndedTasks: stallEnded, logPullRequests: (resolveFacts) => dispatch(logPullRequests, { resolveFacts, now }), nextQueueStarts: nextStarts, pauseQueue: pauseAt, worktreeCleanups, worktreeCleaned,
    addImage, removeImage, readImage, readScorecard, readLog, ackLog, declareArilRework, sessionTasks, sessionAssignedTasks: sessionAssigned, sessionReviews, readFeature: feature, featureSessions: featureLink, featureSessionGroups: featureLinks, close });
}
