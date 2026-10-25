import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { appendTaskLog } from "./task-log.mjs";

export function ensureTaskEvents(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY,
      repository_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('started','assigned','review','blocked','requeued','done')),
      at INTEGER NOT NULL,
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS task_events_task ON task_events (repository_id, number, id);
  `);
}

export function recordTaskEvent(database, repositoryId, number, kind, at, sessionId = null) {
  preparedStatement(database, "INSERT INTO task_events (repository_id, number, kind, at, session_id) VALUES (?, ?, ?, ?, ?)")
    .run(repositoryId, number, kind, at, sessionId);
  appendTaskLog(database, repositoryId, number, kind, at);
}

export function readTaskEvents(database, repositoryId, number) {
  return preparedStatement(database, "SELECT kind, at, session_id FROM task_events WHERE repository_id = ? AND number = ? ORDER BY id")
    .all(repositoryId, number).map((row) => ({ kind: row.kind, at: row.at, sessionId: row.session_id }));
}

export function deleteTaskEvents(database, repositoryId, number) {
  preparedStatement(database, "DELETE FROM task_events WHERE repository_id = ? AND number = ?").run(repositoryId, number);
}
