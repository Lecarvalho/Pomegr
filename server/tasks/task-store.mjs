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
import {
  DEFAULT_TASK_COLUMNS, TASK_BOUNDS, emptyBoard, isRepositoryId, normalizeCreatePayload, normalizeDeletePayload,
  normalizeUpdatePayload, projectBoard, taskIdFromNumber,
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
  DEFAULT_TASK_COLUMNS.forEach((name, position) => insertColumn.run(newOpaqueId("col"), repositoryId, name, position));
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

function createTask({ database, repositoryId }, payload) {
  const input = normalizeCreatePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  ensureRepository(database, repositoryId);
  const count = Number(preparedStatement(database, "SELECT COUNT(*) AS n FROM tasks WHERE repository_id = ?").get(repositoryId).n);
  if (count >= TASK_BOUNDS.tasksPerRepository) return { ok: false, error: "limit" };
  // A new task always lands as the last card of the first column.
  const first = preparedStatement(database, "SELECT id FROM columns WHERE repository_id = ? ORDER BY position, id LIMIT 1").get(repositoryId);
  if (!first) return { ok: false, error: "conflict" };
  const last = preparedStatement(database, "SELECT MAX(position) AS last FROM tasks WHERE repository_id = ? AND column_id = ?").get(repositoryId, first.id);
  const position = last?.last === null || last?.last === undefined ? 0 : Number(last.last) + 1;
  const number = nextTaskNumber(database, repositoryId);
  if (taskIdFromNumber(number) === undefined) return { ok: false, error: "limit" };
  const now = Date.now();
  preparedStatement(database, "INSERT INTO tasks (repository_id, number, text, column_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(repositoryId, number, input.text, first.id, position, now, now);
  reserveTaskNumber(database, repositoryId, number + 1);
  return { ok: true };
}

function updateTask({ database, repositoryId }, payload) {
  const input = normalizeUpdatePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const updated = preparedStatement(database, "UPDATE tasks SET text = ?, updated_at = ? WHERE repository_id = ? AND number = ?")
    .run(input.text, Date.now(), repositoryId, input.number);
  return Number(updated.changes) === 0 ? { ok: false, error: "not_found" } : { ok: true };
}

function deleteTask({ database, repositoryId }, payload) {
  const input = normalizeDeletePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  const task = preparedStatement(database, "SELECT column_id, position FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { ok: false, error: "not_found" };
  const reserved = nextTaskNumber(database, repositoryId);
  preparedStatement(database, "DELETE FROM tasks WHERE repository_id = ? AND number = ?").run(repositoryId, input.number);
  // The deleted number stays retired even when it was newer than the stored counter.
  reserveTaskNumber(database, repositoryId, Math.max(reserved, input.number + 1));
  preparedStatement(database, "UPDATE tasks SET position = position - 1 WHERE repository_id = ? AND column_id = ? AND position > ?")
    .run(repositoryId, task.column_id, task.position);
  return { ok: true };
}

// Actions by name. Each takes `{ database, repositoryId }` and the payload inside the store's
// transaction, and returns `{ ok: true }` or a fixed error code. It validates the payload before
// its first write. A listed action absent from this table answers `unsupported` until its part lands.
const ACTIONS = Object.freeze({ create: createTask, update: updateTask, delete: deleteTask });

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
export function openTaskStore({ directory } = {}) {
  let database = openDatabase(directory);

  function seedColumns(repositoryId) {
    if (preparedStatement(database, "SELECT 1 FROM repositories WHERE repository_id = ?").get(repositoryId)) return;
    runTransaction(database, () => ensureRepository(database, repositoryId));
  }

  function loadRows(repositoryId) {
    return {
      repository: preparedStatement(database, "SELECT queue_status, queue_blocked_by FROM repositories WHERE repository_id = ?").get(repositoryId),
      columns: preparedStatement(database, "SELECT id, name, position FROM columns WHERE repository_id = ? ORDER BY position, id").all(repositoryId),
      features: preparedStatement(database, "SELECT id, name FROM features WHERE repository_id = ? ORDER BY created_at, id").all(repositoryId),
      tasks: preparedStatement(database, "SELECT * FROM tasks WHERE repository_id = ? ORDER BY number").all(repositoryId),
    };
  }

  function readBoard(repositoryId) {
    // An invalid ID is not echoed back, and a store that cannot be used serves no content.
    if (!isRepositoryId(repositoryId)) return emptyBoard("", "unavailable");
    if (!database) return emptyBoard(repositoryId, "unavailable");
    try {
      seedColumns(repositoryId);
      return projectBoard(repositoryId, loadRows(repositoryId)) ?? emptyBoard(repositoryId, "unavailable");
    } catch {
      return emptyBoard(repositoryId, "unavailable");
    }
  }

  function apply(repositoryId, action, payload) {
    if (!isRepositoryId(repositoryId)) return { ok: false, error: "invalid" };
    const handler = typeof action === "string" && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    if (!handler) return { ok: false, error: "unsupported" };
    // A store that cannot be used refuses the write before any handler can touch it.
    if (!database) return { ok: false, error: "conflict" };
    try {
      const board = runTransaction(database, () => {
        const result = handler({ database, repositoryId }, payload);
        if (!result.ok) throw new ActionRejected(result.error);
        // The write stands only if the whole board, the new row included, still projects.
        const projected = projectBoard(repositoryId, loadRows(repositoryId));
        if (!projected) throw new ActionRejected("conflict");
        return projected;
      });
      return { ok: true, board };
    } catch (error) {
      return { ok: false, error: error instanceof ActionRejected ? error.code : "conflict" };
    }
  }

  function close() {
    try { database?.close(); } catch { /* already closed or unusable */ }
    database = null;
  }

  return Object.freeze({ readBoard, apply, close });
}
