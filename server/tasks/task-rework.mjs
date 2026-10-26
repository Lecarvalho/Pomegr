import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { appendTaskLog } from "./task-log.mjs";
import { isRepositoryId } from "./task-record.mjs";

const CAUSES = ["missed_wiring", "spec_gap", "wrong_behavior", "stale_instructions", "latent", "other"];
const DECLARERS = ["session", "aril", "owner"];

export function ensureTaskRework(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS task_rework (
    repository_id TEXT NOT NULL,
    fix TEXT NOT NULL,
    reworks TEXT NOT NULL,
    cause TEXT NOT NULL CHECK (cause IN ('missed_wiring', 'spec_gap', 'wrong_behavior', 'stale_instructions', 'latent', 'other')),
    declared_by TEXT NOT NULL CHECK (declared_by IN ('session', 'aril', 'owner')),
    at INTEGER NOT NULL,
    PRIMARY KEY (repository_id, fix, reworks)
  ) WITHOUT ROWID`);
}

function reference(value) {
  if (typeof value !== "string" || !/^(?:T-|#)[1-9][0-9]*$/u.test(value)) return null;
  const task = value.startsWith("T-");
  const number = Number(value.slice(task ? 2 : 1));
  return Number.isSafeInteger(number) ? { task, number } : null;
}

function payloadValid(payload, keys) {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    && Object.keys(payload).length === keys.length && keys.every((key) => Object.hasOwn(payload, key));
}

// Internal callers own the transaction, including the one log append. A duplicate never replaces its declaration.
export function recordTaskRework({ database, repositoryId, now }, payload) {
  if (!isRepositoryId(repositoryId) || !payloadValid(payload, ["fix", "reworks", "cause", "declaredBy"])) return { ok: false, error: "invalid" };
  const fix = reference(payload.fix), reworks = reference(payload.reworks);
  if (!fix || !reworks || payload.fix === payload.reworks || !CAUSES.includes(payload.cause) || !DECLARERS.includes(payload.declaredBy)) return { ok: false, error: "invalid" };
  const pair = preparedStatement(database, "SELECT 1 FROM task_rework WHERE repository_id = ? AND fix = ? AND reworks = ?");
  if (pair.get(repositoryId, payload.fix, payload.reworks)) return { ok: true, status: "exists" };
  const task = preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ?");
  if ([fix, reworks].some((ref) => ref.task && !task.get(repositoryId, ref.number))) return { ok: false, error: "not_found" };
  if (preparedStatement(database, "SELECT COUNT(*) AS n FROM task_rework WHERE repository_id = ? AND fix = ?").get(repositoryId, payload.fix).n >= 5) return { ok: false, error: "limit" };
  const at = now();
  preparedStatement(database, "INSERT INTO task_rework (repository_id, fix, reworks, cause, declared_by, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(repositoryId, payload.fix, payload.reworks, payload.cause, payload.declaredBy, at);
  appendTaskLog(database, repositoryId, fix.task ? fix.number : -fix.number, "rework", at, reworks.task ? null : reworks.number);
  return { ok: true, status: "recorded" };
}

export function declareTaskRework(context, payload) {
  if (!payloadValid(payload, ["fix", "reworks", "cause"]) || !reference(payload.fix)?.task) return { ok: false, error: "invalid" };
  return recordTaskRework(context, { ...payload, declaredBy: "owner" });
}

export function removeTaskRework({ database, repositoryId }, payload) {
  if (!payloadValid(payload, ["fix", "reworks"]) || !reference(payload.fix) || !reference(payload.reworks) || payload.fix === payload.reworks) return { ok: false, error: "invalid" };
  const result = preparedStatement(database, "DELETE FROM task_rework WHERE repository_id = ? AND fix = ? AND reworks = ?").run(repositoryId, payload.fix, payload.reworks);
  return result.changes ? { ok: true } : { ok: false, error: "not_found" };
}

// Only the served board gains these fields; agent-task reads keep their existing projection.
export function fillTaskRework(database, board) {
  const byId = new Map(board.tasks.map((task) => [task.id, { ...task }]));
  for (const { fix, reworks, cause, declared_by: declaredBy } of preparedStatement(database, "SELECT fix, reworks, cause, declared_by FROM task_rework WHERE repository_id = ? ORDER BY at, fix, reworks").all(board.repositoryId)) {
    const task = byId.get(fix), original = byId.get(reworks);
    if (task) (task.reworks ??= []).push({ ref: reworks, cause, declaredBy });
    if (original) (original.reworkedBy ??= []).push({ ref: fix, cause, declaredBy });
  }
  return { ...board, tasks: [...byId.values()] };
}
