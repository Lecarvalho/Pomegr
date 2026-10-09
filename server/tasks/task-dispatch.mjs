// Session dispatch for one task: the start plan the desktop turns into a terminal, its abort, and the
// bind that links the started session to the task.
//
// A plan is minted only after every refusal passed. The opaque token leaves this module once, inside
// the plan; the store keeps only its SHA-256 digest and the mint time, in the existing `dispatch_token`
// column as `<digest>:<mintMs>`, so no schema change is needed. The digest is never projected onto the
// board. Task text is untrusted: it is concatenated only into the fixed prompt string, never into a
// path or command line. The store judges the start gates (capacity, incident, clean tree, previous step) through
// `gatesHold` before a token is minted, so a held start leaves nothing behind.
//
// The started session reports the token with its normalized session ID, and `bindDispatch` links the
// two once and discards the digest. The token is the only authority: the session is not looked up,
// because the catalog has no row for it yet at session start.

import crypto from "node:crypto";
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { TASK_DISPATCH_UNBOUND_TTL_MS, dispatchStanding, isLive, parseStoredDispatch } from "./task-dispatch-standing.mjs";
import { isRepositoryId, isTaskId, isTaskSessionId, normalizeStoredTask } from "./task-record.mjs";

export { TASK_DISPATCH_UNBOUND_TTL_MS, dispatchStanding };

export const TASK_START_ERRORS = Object.freeze(["invalid", "not_found", "not_startable", "unsupported_provider", "plugin_missing", "gate_held", "unavailable"]);

const STARTABLE_STATES = new Set(["not_queued", "queued", "scheduled"]);
/** Providers a session can be started on. A task with no provider runs on Claude Code. */
export const TASK_START_PROVIDERS = Object.freeze(["claude", "codex"]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const CHECK_LABELS = Object.freeze({
  pr_open: "Pull request open",
  tree_clean: "Working tree clean",
  commit_on_branch: "Commit on task branch",
  pr_merged: "Pull request merged",
  ci_passed: "CI passed",
});
export const TASK_PROMPT_OPENING = "You are working on one task from the Pomegr task board.";

const digestOf = (token) => crypto.createHash("sha256").update(token, "utf8").digest("hex");

/**
 * The fixed session prompt. It begins with a fixed non-dash sentence, so it can never parse as a CLI
 * flag, and holds the task text only as quoted data between fixed sentences.
 */
export function buildTaskPrompt(task) {
  const conditions = task.doneWhen.checks.map((check) => `- ${CHECK_LABELS[check]}`);
  if (task.doneWhen.own) conditions.push(`- ${task.doneWhen.own}`);
  return [
    TASK_PROMPT_OPENING,
    `Task ${task.id}:`,
    task.text,
    "Done when:",
    ...(conditions.length > 0 ? conditions : ["- No condition is checked: your report alone completes the task."]),
    "When the task is done, call the Pomegr MCP tool complete_task. If you cannot proceed, call the Pomegr MCP tool block_task with a short reason.",
  ].join("\n");
}

function taskNumber(payload, keys) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (!Object.keys(payload).every((key) => keys.includes(key)) || !keys.every((key) => Object.hasOwn(payload, key))) return undefined;
  return isTaskId(payload.id) ? Number(payload.id.slice(2)) : undefined;
}

const loadRow = (database, repositoryId, number) =>
  preparedStatement(database, "SELECT * FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number);

// A task of a feature step that holds more than one task runs in a Git worktree of its own, because the tasks of one
// step run in parallel. A task alone in its step, and a task without a feature, runs in the repository root.
function worktreeRequired(database, row) {
  if ((row.feature_id ?? null) === null || (row.step ?? null) === null) return false;
  const inStep = preparedStatement(database, "SELECT COUNT(*) AS count FROM tasks WHERE repository_id = ? AND feature_id = ? AND step = ?")
    .get(row.repository_id, row.feature_id, row.step);
  return Number(inStep?.count) > 1;
}

// Startable: a startable state, no linked session, no live dispatch.
const startable = (row, now) => STARTABLE_STATES.has(row.state) && (row.session_id ?? null) === null
  && !isLive(parseStoredDispatch(row.dispatch_token), now);

/**
 * `start-plan`. `resolveFacts(provider)` returns `{ root, pluginReady }` from committed facts, `pluginReady`
 * for the plugin of the provider the session runs on, and is called only after the task, provider, and state
 * refusals. `gatesHold(taskId)` is the store's start-gate judgement for this task from committed facts; a held
 * start answers `gate_held` and mints nothing. `transaction(work)` runs `work` in one write transaction. The plan's
 * `worktree` says whether the session must run in a worktree of its own; where that worktree is, only the desktop knows.
 */
export function startPlan({ database, transaction, repositoryId, payload, resolveFacts, gatesHold, now }) {
  const number = isRepositoryId(repositoryId) ? taskNumber(payload, ["id"]) : undefined;
  if (number === undefined) return { ok: false, error: "invalid" };
  const row = loadRow(database, repositoryId, number);
  if (!row) return { ok: false, error: "not_found" };
  const task = normalizeStoredTask(row);
  if (!task) return { ok: false, error: "unavailable" };
  const at = now();
  if (!startable(row, at)) return { ok: false, error: "not_startable" };
  const provider = task.run.provider ?? "claude";
  if (!TASK_START_PROVIDERS.includes(provider)) return { ok: false, error: "unsupported_provider" };
  let facts;
  try { facts = resolveFacts(provider); } catch { facts = null; }
  if (typeof facts?.root !== "string" || facts.root.length === 0) return { ok: false, error: "unavailable" };
  if (facts.pluginReady !== true) return { ok: false, error: "plugin_missing" };
  if (gatesHold(task.id) !== false) return { ok: false, error: "gate_held" };
  const token = crypto.randomBytes(32).toString("base64url");
  const minted = transaction(() => {
    // The state may have moved since the read above; the mint stands only if the task is still startable.
    const fresh = loadRow(database, repositoryId, number);
    if (!fresh || !startable(fresh, at)) return null;
    preparedStatement(database, "UPDATE tasks SET dispatch_token = ? WHERE repository_id = ? AND number = ?")
      .run(`${digestOf(token)}:${at}`, repositoryId, number);
    return { worktree: worktreeRequired(database, fresh) };
  });
  if (!minted) return { ok: false, error: "not_startable" };
  return {
    ok: true,
    plan: {
      taskId: task.id, provider, model: task.run.model, effort: task.run.effort,
      repositoryRoot: facts.root, worktree: minted.worktree, prompt: buildTaskPrompt(task), token,
    },
  };
}

/** `start-abort`: clears the unbound dispatch only when the token matches. Idempotent for an existing task. */
export function startAbort({ database, transaction, repositoryId, payload }) {
  const number = isRepositoryId(repositoryId) ? taskNumber(payload, ["id", "token"]) : undefined;
  if (number === undefined || typeof payload.token !== "string" || !TOKEN_PATTERN.test(payload.token)) return { ok: false, error: "invalid" };
  const row = loadRow(database, repositoryId, number);
  if (!row) return { ok: false, error: "not_found" };
  const stored = parseStoredDispatch(row.dispatch_token);
  if (stored !== null) {
    const supplied = Buffer.from(digestOf(payload.token), "hex");
    const matches = crypto.timingSafeEqual(supplied, Buffer.from(stored.digest, "hex"));
    if (matches) {
      transaction(() => {
        preparedStatement(database, "UPDATE tasks SET dispatch_token = NULL WHERE repository_id = ? AND number = ? AND dispatch_token = ?")
          .run(repositoryId, number, row.dispatch_token);
      });
    }
  }
  return { ok: true };
}

const BIND_REFUSED = Object.freeze({ ok: false, error: "not_found" });

/**
 * `bind`: links the session that reported a live dispatch token to the task that minted it, in one write
 * transaction, and clears the digest. The lookup is monitor-wide: the token is the only input that names a
 * task. A wrong or reused token, an expired unbound dispatch, a task that already has a session, and a session
 * already linked to another task all answer the same `not_found`, so the answer says nothing about which
 * one failed and never carries a task or repository. The link is single assignment; it changes no state,
 * column, or queue position, and a linked task is never startable again.
 */
export function bindDispatch({ database, transaction, payload, now }) {
  const shaped = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    && Object.keys(payload).length === 2 && Object.hasOwn(payload, "token") && Object.hasOwn(payload, "sessionId");
  if (!shaped || typeof payload.token !== "string" || !TOKEN_PATTERN.test(payload.token) || !isTaskSessionId(payload.sessionId)) {
    return { ok: false, error: "invalid" };
  }
  const supplied = Buffer.from(digestOf(payload.token), "hex");
  const at = now();
  return transaction(() => {
    // Every unlinked dispatch is compared, so the time taken does not depend on which row matches.
    let match = null;
    const candidates = preparedStatement(database, "SELECT repository_id, number, dispatch_token FROM tasks WHERE session_id IS NULL AND dispatch_token IS NOT NULL").all();
    for (const row of candidates) {
      const stored = parseStoredDispatch(row.dispatch_token);
      const matches = stored !== null && crypto.timingSafeEqual(supplied, Buffer.from(stored.digest, "hex"));
      if (matches && isLive(stored, at)) match = row;
    }
    if (match === null) return BIND_REFUSED;
    if (preparedStatement(database, "SELECT 1 FROM tasks WHERE session_id = ?").get(payload.sessionId) !== undefined) return BIND_REFUSED;
    try {
      const linked = preparedStatement(database, "UPDATE tasks SET session_id = ?, dispatch_token = NULL, updated_at = ? WHERE repository_id = ? AND number = ? AND session_id IS NULL AND dispatch_token = ?")
        .run(payload.sessionId, Date.now(), match.repository_id, match.number, match.dispatch_token);
      return Number(linked.changes) === 1 ? { ok: true } : BIND_REFUSED;
    } catch (error) {
      // The unique `tasks_session` index is the last guard of single assignment; anything else is unavailable.
      if (/constraint/iu.test(String(error?.message))) return BIND_REFUSED;
      throw error;
    }
  });
}
