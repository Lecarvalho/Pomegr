// Whether a done task's worktree and branch are removed, and which done tasks still wait for that removal.
// The desktop does the removal (desktop/runtime/task-worktree.mjs); the store holds only the two flags.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isRepositoryId, isTaskId, taskIdFromNumber } from "./task-record.mjs";

const ON = "1";
export const TASK_WORKTREE_CLEANUP_LIMIT = 64;
// Removal is the default, so a row exists only for a task that keeps its worktree.
const keepPrefixOf = (repositoryId) => `task_keep_worktree:${repositoryId}:`;
const PENDING_PREFIX = "task_worktree_cleanup:";

const hasExactKeys = (payload, keys) => payload !== null && typeof payload === "object" && !Array.isArray(payload)
  && Object.keys(payload).length === keys.length && keys.every((key) => Object.hasOwn(payload, key));

function writeFlag(database, key, on) {
  if (on === true) {
    preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, ON);
  } else {
    preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(key);
  }
}

// The numbers of one repository's tasks that keep their worktree.
export function readTaskKeepWorktrees(database, repositoryId) {
  const numbers = new Set();
  if (!isRepositoryId(repositoryId)) return numbers;
  const prefix = keepPrefixOf(repositoryId);
  const rows = preparedStatement(database, "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix);
  for (const row of rows) {
    const taskId = String(row.key).slice(prefix.length);
    if (isTaskId(taskId) && row.value === ON) numbers.add(Number(taskId.slice(2)));
  }
  return numbers;
}

export function readTaskKeepWorktree(database, repositoryId, taskNumber) {
  const taskId = taskIdFromNumber(taskNumber);
  if (!isRepositoryId(repositoryId) || taskId === undefined) return false;
  return preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(`${keepPrefixOf(repositoryId)}${taskId}`)?.value === ON;
}

export function writeTaskKeepWorktree(database, repositoryId, taskNumber, keep) {
  writeFlag(database, `${keepPrefixOf(repositoryId)}${taskIdFromNumber(taskNumber)}`, keep);
}

export function withTaskKeepWorktree(database, row) {
  return row ? { ...row, run_keep_worktree: readTaskKeepWorktree(database, row.repository_id, row.number) } : row;
}

const pendingKey = (repositoryId, taskNumber) => `${PENDING_PREFIX}${repositoryId}:${taskIdFromNumber(taskNumber)}`;

// Called in the write that marks the task done.
export function requestWorktreeCleanup(database, repositoryId, taskNumber) {
  if (!readTaskKeepWorktree(database, repositoryId, taskNumber)) writeFlag(database, pendingKey(repositoryId, taskNumber), true);
}

// Called in the write that deletes the task.
export function deleteTaskWorktreeCleanup(database, repositoryId, taskNumber) {
  writeFlag(database, pendingKey(repositoryId, taskNumber), false);
  writeTaskKeepWorktree(database, repositoryId, taskNumber, false);
}

// `worktree-cleanups`: the done tasks whose worktree the desktop has not removed yet, as IDs only.
export function pendingWorktreeCleanups({ database }) {
  const cleanups = [];
  const rows = preparedStatement(database, "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key").all(PENDING_PREFIX.length, PENDING_PREFIX);
  for (const row of rows) {
    if (cleanups.length >= TASK_WORKTREE_CLEANUP_LIMIT) break;
    const [repositoryId, taskId, ...rest] = String(row.key).slice(PENDING_PREFIX.length).split(":");
    if (rest.length === 0 && row.value === ON && isRepositoryId(repositoryId) && isTaskId(taskId)) cleanups.push({ repositoryId, taskId });
  }
  return { ok: true, cleanups };
}

// `worktree-cleaned`: the desktop reports that the worktree is gone, so the task is not listed again.
export function settleWorktreeCleanup({ database, transaction, repositoryId, payload }) {
  if (!isRepositoryId(repositoryId) || !hasExactKeys(payload, ["id"]) || !isTaskId(payload.id)) return { ok: false, error: "invalid" };
  transaction(() => { writeFlag(database, pendingKey(repositoryId, Number(payload.id.slice(2))), false); });
  return { ok: true };
}
