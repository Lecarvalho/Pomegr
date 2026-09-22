import { mkdir, rm, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";

export const MONITOR_STORE_SCHEMA_VERSION = 1;

const DATABASE_FILENAME = "monitor.sqlite";
const SQLITE_WARNING_PREFIX = "SQLite is an experimental feature";

let sqliteModulePromise = null;
let warningFilterInstalled = false;

/**
 * Node prints an ExperimentalWarning on every `node:sqlite` import; `process.on("warning")`
 * cannot suppress it, only `process.emitWarning` interception can. Every other warning
 * (including a future non-SQLite ExperimentalWarning) still passes through unchanged.
 */
export function installSqliteExperimentalWarningFilter() {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] && typeof rest[0] === "object" ? rest[0].type : undefined);
    const message = typeof warning === "string" ? warning : warning?.message;
    if (type === "ExperimentalWarning" && typeof message === "string" && message.startsWith(SQLITE_WARNING_PREFIX)) return;
    return original(warning, ...rest);
  };
}

function loadSqliteModule() {
  if (!sqliteModulePromise) {
    installSqliteExperimentalWarningFilter();
    sqliteModulePromise = import("node:sqlite");
  }
  return sqliteModulePromise;
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeDatabaseFiles(directory) {
  const base = path.join(directory, DATABASE_FILENAME);
  await Promise.all([
    rm(base, { force: true }),
    rm(`${base}-wal`, { force: true }),
    rm(`${base}-shm`, { force: true }),
  ]);
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      repository_id TEXT NOT NULL,
      current_path TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS files_repository_path ON files (repository_id, current_path);
    CREATE TABLE IF NOT EXISTS file_paths (
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      source TEXT NOT NULL CHECK (source IN ('recorded', 'git', 'shell_move')),
      PRIMARY KEY (file_id, valid_from)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS file_paths_path ON file_paths (path);
    CREATE TABLE IF NOT EXISTS file_changes (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      session_id TEXT,
      agent_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('created', 'edited', 'deleted', 'moved')),
      observed_at INTEGER NOT NULL,
      request_number INTEGER
    );
    CREATE INDEX IF NOT EXISTS file_changes_session_time ON file_changes (session_id, observed_at);
    CREATE INDEX IF NOT EXISTS file_changes_file_time ON file_changes (file_id, observed_at);
    CREATE TABLE IF NOT EXISTS resource_minutes (
      session_id TEXT NOT NULL,
      minute_start INTEGER NOT NULL,
      cpu_cores_min REAL, cpu_cores_avg REAL, cpu_cores_max REAL, cpu_cores_max_at INTEGER,
      cpu_machine_percent_min REAL, cpu_machine_percent_avg REAL, cpu_machine_percent_max REAL, cpu_machine_percent_max_at INTEGER,
      memory_bytes_min REAL, memory_bytes_avg REAL, memory_bytes_max REAL, memory_bytes_max_at INTEGER,
      read_bps_min REAL, read_bps_avg REAL, read_bps_max REAL, read_bps_max_at INTEGER,
      write_bps_min REAL, write_bps_avg REAL, write_bps_max REAL, write_bps_max_at INTEGER,
      PRIMARY KEY (session_id, minute_start)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS resource_minutes_time ON resource_minutes (minute_start);
    CREATE TABLE IF NOT EXISTS resource_peaks (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      field TEXT NOT NULL CHECK (field IN ('cpu_cores', 'cpu_machine_percent', 'memory_bytes', 'read_bps', 'write_bps')),
      observed_at INTEGER NOT NULL,
      value REAL NOT NULL,
      matched_task_ids TEXT NOT NULL DEFAULT '[]',
      matched_request_number INTEGER
    );
    CREATE INDEX IF NOT EXISTS resource_peaks_session_field ON resource_peaks (session_id, field, value DESC);
    CREATE TABLE IF NOT EXISTS resource_peak_samples (
      session_id TEXT NOT NULL,
      peak_id INTEGER NOT NULL REFERENCES resource_peaks(id) ON DELETE CASCADE,
      observed_at INTEGER NOT NULL,
      cpu_cores REAL, cpu_machine_percent REAL, memory_bytes REAL, read_bps REAL, write_bps REAL,
      PRIMARY KEY (peak_id, observed_at)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS resource_peak_samples_session_time ON resource_peak_samples (session_id, observed_at);
  `);
}

function openFreshDatabase(DatabaseSync, databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA auto_vacuum = INCREMENTAL");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 2000");
  createSchema(database);
  const insertMeta = database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  insertMeta.run("schema_version", String(MONITOR_STORE_SCHEMA_VERSION));
  insertMeta.run("created_at", String(Date.now()));
  return database;
}

function openExistingDatabase(DatabaseSync, databasePath) {
  let database;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 2000");
    const check = database.prepare("PRAGMA quick_check").get();
    const checkValue = check ? Object.values(check)[0] : null;
    const versionRow = database.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
    if (checkValue !== "ok" || !versionRow || Number(versionRow.value) !== MONITOR_STORE_SCHEMA_VERSION) {
      throw new Error("MONITOR_STORE_SCHEMA_MISMATCH");
    }
    createSchema(database); // idempotent: backfills a missing table/index without touching existing rows
    return database;
  } catch (error) {
    // Any failure here (open, pragma, quick_check, or a mismatch) must release the file
    // handle before the caller deletes and recreates it.
    try { database?.close(); } catch { /* already unusable */ }
    throw error;
  }
}

function runTransaction(database, fn) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* connection may already be unusable */ }
    throw error;
  }
}

function sizeBytesSync(directory) {
  const base = path.join(directory, DATABASE_FILENAME);
  let total = 0;
  for (const file of [base, `${base}-wal`]) {
    try { total += statSync(file).size; } catch { /* absent file contributes 0 */ }
  }
  return total;
}

/**
 * Opens (or rebuilds) the monitor-owned SQLite index. `rebuilt` is true whenever the
 * database file was missing, corrupt, or on a different schema version: the store is a
 * rebuildable index, never a migration target. Never throws a path or raw SQLite error.
 */
export async function openMonitorStore({ directory } = {}) {
  try {
    if (typeof directory !== "string" || directory.length === 0) throw new Error("invalid directory");
    await mkdir(directory, { recursive: true });
    const databasePath = path.join(directory, DATABASE_FILENAME);
    const { DatabaseSync } = await loadSqliteModule();
    const existedBefore = await fileExists(databasePath);
    let database;
    let rebuilt = !existedBefore;
    if (existedBefore) {
      try {
        database = openExistingDatabase(DatabaseSync, databasePath);
      } catch {
        await removeDatabaseFiles(directory);
        database = openFreshDatabase(DatabaseSync, databasePath);
        rebuilt = true;
      }
    } else {
      database = openFreshDatabase(DatabaseSync, databasePath);
    }
    return Object.freeze({
      database,
      transaction: (fn) => runTransaction(database, fn),
      sizeBytes: () => sizeBytesSync(directory),
      vacuumIncremental: () => {
        database.exec("PRAGMA incremental_vacuum");
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      },
      close: () => { try { database.close(); } catch { /* already closed or unusable */ } },
      rebuilt,
    });
  } catch {
    throw new Error("MONITOR_STORE_UNAVAILABLE");
  }
}
