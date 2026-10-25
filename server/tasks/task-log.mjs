import { preparedStatement } from "../persistence/prepared-statements.mjs";

export const TASK_LOG_KINDS = Object.freeze(["started", "assigned", "review", "blocked", "requeued", "done", "stalled", "recovered", "checks_passed", "checks_failed", "merged", "review_started", "review_passed", "review_failed", "grant_start", "grant_review", "sent_back", "grant_merge", "grant_merge_refused", "grant_task_written", "grant_usage_hold", "grant_usage_resume"]);
export const TASK_LOG_CONSUMERS = Object.freeze(["aril"]);
export const TASK_LOG_KEEP = 1000;

export function ensureTaskLog(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_log_repository ON task_log (repository_id, id);
    CREATE TABLE IF NOT EXISTS task_log_cursors (
      repository_id TEXT NOT NULL,
      consumer TEXT NOT NULL,
      last_id INTEGER NOT NULL,
      PRIMARY KEY (repository_id, consumer)
    ) WITHOUT ROWID;
  `);
  if (!database.prepare("PRAGMA table_info(task_log)").all().some((column) => column.name === "pull_request")) {
    database.exec("ALTER TABLE task_log ADD COLUMN pull_request INTEGER");
  }
  if (!database.prepare("PRAGMA table_info(task_log)").all().some((column) => column.name === "reason")) {
    database.exec("ALTER TABLE task_log ADD COLUMN reason TEXT");
  }
}

// The transition's caller owns the transaction, including retention.
export function appendTaskLog(database, repositoryId, number, kind, at, pullRequest = null, reason = null) {
  if (!TASK_LOG_KINDS.includes(kind)) throw new Error("TASK_LOG_KIND");
  const usageTransition = kind === "grant_usage_hold" || kind === "grant_usage_resume";
  if (usageTransition ? number !== 0 || !["claude", "codex"].includes(reason) || pullRequest !== null : reason !== null || number < 1) throw new Error("TASK_LOG_ENTRY");
  preparedStatement(database, "INSERT INTO task_log (repository_id, number, kind, at, pull_request, reason) VALUES (?, ?, ?, ?, ?, ?)").run(repositoryId, number, kind, at, pullRequest, reason);
  preparedStatement(database, `DELETE FROM task_log WHERE repository_id = ? AND id <= (
    SELECT id FROM task_log WHERE repository_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
  )`).run(repositoryId, repositoryId, TASK_LOG_KEEP);
}

const latestId = (database, repositoryId) => preparedStatement(database, "SELECT COALESCE(MAX(id), 0) AS id FROM task_log WHERE repository_id = ?").get(repositoryId).id;

export function readTaskLog(database, repositoryId, { after = null, limit }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
    || (after !== null && (!Number.isSafeInteger(after) || after < 0))) throw new Error("TASK_LOG_PAGE");
  const rows = after === null
    ? preparedStatement(database, "SELECT id, number, kind, at, pull_request, reason FROM task_log WHERE repository_id = ? ORDER BY id DESC LIMIT ?").all(repositoryId, limit + 1)
    : preparedStatement(database, "SELECT id, number, kind, at, pull_request, reason FROM task_log WHERE repository_id = ? AND id > ? ORDER BY id LIMIT ?").all(repositoryId, after, limit + 1);
  const page = rows.slice(0, limit);
  if (after === null) page.reverse();
  const cursor = preparedStatement(database, "SELECT last_id FROM task_log_cursors WHERE repository_id = ? AND consumer = 'aril'").get(repositoryId);
  return {
    entries: page.map(({ id, number, kind, at, pull_request, reason }) => number === 0
      ? { id, task: null, kind, at, pullRequest: pull_request, reason }
      : { id, task: `T-${number}`, kind, at, pullRequest: pull_request }),
    more: rows.length > limit, cursors: { aril: cursor?.last_id ?? 0 }, latestId: latestId(database, repositoryId),
  };
}

export function ackTaskLog(database, repositoryId, consumer, through) {
  if (!TASK_LOG_CONSUMERS.includes(consumer) || !Number.isSafeInteger(through) || through < 0) throw new Error("TASK_LOG_CURSOR");
  return preparedStatement(database, `INSERT INTO task_log_cursors (repository_id, consumer, last_id) VALUES (?, ?, ?)
    ON CONFLICT(repository_id, consumer) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)
    RETURNING last_id`).get(repositoryId, consumer, Math.min(through, latestId(database, repositoryId))).last_id;
}
