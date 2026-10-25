import crypto from "node:crypto";
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isLive, parseStoredDispatch } from "./task-dispatch-standing.mjs";
import { readFeature } from "./task-feature-details.mjs";
import { CHECK_LABELS, digestOf, featureLine, TASK_START_PROVIDERS, TOKEN_PATTERN } from "./task-dispatch-parts.mjs";
import { appendTaskLog } from "./task-log.mjs";
import { isRepositoryId, isTaskId, isTaskSessionId, normalizeRun, normalizeStoredTask, plainTaskText } from "./task-record.mjs";

export function buildReviewPrompt(task, feature = null) {
  const conditions = task.completeWhen.checks.map((check) => `- ${CHECK_LABELS[check]}`);
  if (task.completeWhen.own) conditions.push(`- ${task.completeWhen.own}`);
  return [
    `This is a review session started by Pomegr for Task ${task.id}; you must not edit, commit, or push anything.`,
    `Task ${task.id}:`, plainTaskText(task.text), ...featureLine(feature), "Complete when:",
    ...(conditions.length ? conditions : ["- No condition is checked."]),
    "Read the repository's own rules (AGENTS.md, CLAUDE.md, CONTRIBUTING or equivalent) and its documented verification commands.",
    `Review the changes on the current branch against the branch it was made from (the merge base with the default branch), and the open pull request for tasks/${task.id} if there is one.`,
    "Run the repository's focused and full checks. Then call the Pomegr tool report_review exactly once with verdict \"pass\", or \"fail\" and one-line reasons (at most 10, each at most 200 characters). When a rule fails, state met, unmet, or unknown for each repository rule. A reviewer that edits files fails its own review.",
  ].join("\n").slice(0, 8000);
}

export function ensureTaskReviews(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS task_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL, number INTEGER NOT NULL,
    session_id TEXT NOT NULL, at INTEGER NOT NULL, verdict TEXT NOT NULL, reasons TEXT
  )`);
}

const dispatchKey = (repositoryId, number) => `task_review_dispatch:${repositoryId}:T-${number}`;
const reviewerKey = (repositoryId, number) => `task_reviewer:${repositoryId}:T-${number}`;
const valueOf = (database, key) => preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(key)?.value;
const writeMeta = (database, key, value) => preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
const rowOf = (database, repositoryId, number) => preparedStatement(database, "SELECT * FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number);
const shaped = (payload, keys) => payload !== null && typeof payload === "object" && !Array.isArray(payload)
  && Object.keys(payload).length === keys.length && keys.every((key) => Object.hasOwn(payload, key));
const startable = (database, row, at) => row?.state === "needs_review" && row.session_id !== null
  && !isLive(parseStoredDispatch(valueOf(database, dispatchKey(row.repository_id, row.number))), at);

function planReview({ database, transaction, repositoryId, payload, resolveFacts, now }) {
  const override = shaped(payload, ["id", "provider", "model", "effort"]);
  if ((!override && !shaped(payload, ["id"])) || !isRepositoryId(repositoryId) || !isTaskId(payload.id)) return { ok: false, error: "invalid" };
  const run = override ? normalizeRun({ provider: payload.provider, model: payload.model, effort: payload.effort }) : null;
  if (override && (!run || !TASK_START_PROVIDERS.includes(run.provider))) return { ok: false, error: "invalid" };
  const number = Number(payload.id.slice(2));
  const row = rowOf(database, repositoryId, number);
  if (!row) return { ok: false, error: "not_found" };
  const task = normalizeStoredTask(row);
  if (!task) return { ok: false, error: "unavailable" };
  const at = now();
  if (!startable(database, row, at)) return { ok: false, error: "not_startable" };
  const { model, effort } = run ?? task.run;
  const provider = (run ?? task.run).provider ?? "claude";
  let facts;
  try { facts = resolveFacts(provider); } catch { facts = null; }
  if (typeof facts?.root !== "string" || facts.root.length === 0) return { ok: false, error: "unavailable" };
  if (facts.pluginReady !== true) return { ok: false, error: "plugin_missing" };
  const token = crypto.randomBytes(32).toString("base64url");
  return transaction(() => {
    if (!startable(database, rowOf(database, repositoryId, number), at)) return { ok: false, error: "not_startable" };
    const feature = task.featureId === null ? null : readFeature({ database, repositoryId, feature: task.featureId });
    writeMeta(database, dispatchKey(repositoryId, number), `${digestOf(token)}:${at}`);
    return { ok: true, plan: { taskId: task.id, provider, model, effort, repositoryRoot: facts.root, prompt: buildReviewPrompt(task, feature), token } };
  });
}

function abortReview({ database, transaction, repositoryId, payload }) {
  if (!shaped(payload, ["id", "token"]) || !isRepositoryId(repositoryId) || !isTaskId(payload.id)
    || typeof payload.token !== "string" || !TOKEN_PATTERN.test(payload.token)) return { ok: false, error: "invalid" };
  const number = Number(payload.id.slice(2));
  if (!rowOf(database, repositoryId, number)) return { ok: false, error: "not_found" };
  return transaction(() => {
    const key = dispatchKey(repositoryId, number);
    const stored = parseStoredDispatch(valueOf(database, key));
    if (stored && crypto.timingSafeEqual(Buffer.from(digestOf(payload.token), "hex"), Buffer.from(stored.digest, "hex"))) {
      preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(key);
    }
    return { ok: true };
  });
}

// Called inside the binding transaction after all builder candidates were compared.
export function bindReview(database, supplied, sessionId, at) {
  let match = null;
  for (const row of preparedStatement(database, `SELECT tasks.*, meta.value FROM tasks JOIN meta
    ON meta.key = 'task_review_dispatch:' || tasks.repository_id || ':T-' || tasks.number`).all()) {
    const stored = parseStoredDispatch(row.value);
    const matches = stored !== null && crypto.timingSafeEqual(supplied, Buffer.from(stored.digest, "hex"));
    if (matches && isLive(stored, at)) match = row;
  }
  if (!match || match.state !== "needs_review"
    || preparedStatement(database, "SELECT 1 FROM tasks WHERE session_id = ?").get(sessionId)
    || preparedStatement(database, "SELECT 1 FROM meta WHERE key GLOB 'task_reviewer:*' AND key != ? AND value = ?")
      .get(reviewerKey(match.repository_id, match.number), sessionId)) return { ok: false, error: "not_found" };
  writeMeta(database, reviewerKey(match.repository_id, match.number), sessionId);
  preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(dispatchKey(match.repository_id, match.number));
  appendTaskLog(database, match.repository_id, match.number, "review_started", at);
  return { ok: true };
}

function reportReview({ database, transaction, payload, now }) {
  const keys = ["sessionId", "verdict", ...(Object.hasOwn(payload ?? {}, "taskId") ? ["taskId"] : []), ...(Object.hasOwn(payload ?? {}, "reasons") ? ["reasons"] : [])];
  if (!shaped(payload, keys) || !isTaskSessionId(payload.sessionId) || (Object.hasOwn(payload, "taskId") && !isTaskId(payload.taskId))
    || !["pass", "fail"].includes(payload.verdict)
    || (payload.verdict === "pass" ? Object.hasOwn(payload, "reasons") : !Array.isArray(payload.reasons) || payload.reasons.length < 1 || payload.reasons.length > 10
      || !payload.reasons.every((reason) => typeof reason === "string" && reason.trim().length > 0 && reason.length <= 200 && !/[\r\n\u2028\u2029]/u.test(reason)))) return { ok: false, error: "invalid" };
  return transaction(() => {
    const rows = preparedStatement(database, `SELECT tasks.* FROM tasks JOIN meta
      ON meta.key = 'task_reviewer:' || tasks.repository_id || ':T-' || tasks.number WHERE meta.value = ?`).all(payload.sessionId)
      .filter((row) => payload.taskId === undefined || `T-${row.number}` === payload.taskId);
    if (rows.length !== 1) return { ok: false, error: "not_found" };
    const row = rows[0];
    if (row.state !== "needs_review") return { ok: false, error: "not_reviewable" };
    const reasons = payload.verdict === "pass" ? null : JSON.stringify(payload.reasons);
    const last = preparedStatement(database, "SELECT * FROM task_reviews WHERE repository_id = ? AND number = ? ORDER BY id DESC LIMIT 1").get(row.repository_id, row.number);
    if (last?.session_id === payload.sessionId && last.verdict === payload.verdict && last.reasons === reasons) return { ok: true };
    const at = now();
    preparedStatement(database, "INSERT INTO task_reviews (repository_id, number, session_id, at, verdict, reasons) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.repository_id, row.number, payload.sessionId, at, payload.verdict, reasons);
    appendTaskLog(database, row.repository_id, row.number, payload.verdict === "pass" ? "review_passed" : "review_failed", at);
    return { ok: true };
  });
}

export function clearTaskReviewer(database, repositoryId, number) {
  preparedStatement(database, "DELETE FROM meta WHERE key IN (?, ?)").run(dispatchKey(repositoryId, number), reviewerKey(repositoryId, number));
}

export function deleteTaskReviews(database, repositoryId, number) {
  clearTaskReviewer(database, repositoryId, number);
  preparedStatement(database, "DELETE FROM task_reviews WHERE repository_id = ? AND number = ?").run(repositoryId, number);
}

export function taskReviewOutcome(database, repositoryId, number) {
  const rows = preparedStatement(database, "SELECT verdict FROM task_reviews WHERE repository_id = ? AND number = ? ORDER BY id").all(repositoryId, number);
  return { reviews: rows.length, first_review_passed: rows.length ? Number(rows[0].verdict === "pass") : null };
}

export const reviewOperations = (dispatch, now) => ({
  planReview: (repositoryId, payload, resolveFacts) => dispatch(planReview, { repositoryId, payload, resolveFacts, now }),
  abortReview: (repositoryId, payload) => dispatch(abortReview, { repositoryId, payload }),
  reportReview: (payload) => dispatch(reportReview, { payload, now }),
});
