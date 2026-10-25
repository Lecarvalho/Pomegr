import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { readAril } from "./task-aril-settings.mjs";
import { readyColumnId, settleReadyColumn } from "./task-columns.mjs";
import { readTaskGroups } from "./task-groups.mjs";
import { startable } from "./task-dispatch.mjs";
import { appendTaskLog } from "./task-log.mjs";
import { readQueueSchedule, startGates } from "./task-queue-advance.mjs";
import { queueWindowHold } from "./task-queue.mjs";
import { isRepositoryId, isTaskId, projectBoard, rowInFlight } from "./task-record.mjs";
import { fillTaskReviews } from "./task-review.mjs";
import { resolveRequeue } from "./task-report.mjs";
import { splitTaskTags } from "./task-tags.mjs";

export function ensureArilGrants(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS aril_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL,
    started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, actions TEXT NOT NULL, limits TEXT NOT NULL,
    starts_used INTEGER NOT NULL DEFAULT 0, ended_at INTEGER, end_reason TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS aril_grants_open ON aril_grants(repository_id) WHERE ended_at IS NULL;`);
}
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const invalid = () => ({ ok: false, error: "invalid" });
const end = (database, repositoryId, at, reason) => preparedStatement(database,
  "UPDATE aril_grants SET ended_at = ?, end_reason = ? WHERE repository_id = ? AND ended_at IS NULL").run(at, reason, repositoryId);

// Every caller owns a transaction: an observed limit and its terminal reason commit together.
export function readGrant(database, repositoryId, at) {
  const row = preparedStatement(database, "SELECT * FROM aril_grants WHERE repository_id = ? ORDER BY id DESC LIMIT 1").get(repositoryId);
  if (!row) return null;
  const actions = JSON.parse(row.actions), limits = JSON.parse(row.limits);
  if (row.ended_at === null && (at >= row.ends_at || row.starts_used >= limits.starts)) {
    row.end_reason = at >= row.ends_at ? "expired" : "starts_used";
    row.ended_at = at;
    end(database, repositoryId, at, row.end_reason);
  }
  return { startedAt: row.started_at, endsAt: row.ends_at, startsUsed: row.starts_used, actions, limits,
    active: row.ended_at === null, ...(row.ended_at === null ? {} : { endedAt: row.ended_at, endReason: row.end_reason }) };
}

export function grantStart({ database, repositoryId, ensureRepository, now }, payload) {
  if (!exact(payload, [])) return invalid();
  const at = now();
  if (readGrant(database, repositoryId, at)?.active) return { ok: false, error: "conflict" };
  const { actions, limits } = readAril(database, repositoryId).settings;
  if ([limits.hours, limits.starts, limits.concurrent].some((limit) => limit === null) || (!actions.start && !actions.review && !actions.merge)
    || (actions.sendBack && limits.sendBacks === null)) return { ok: false, error: "not_ready" };
  ensureRepository(database, repositoryId);
  preparedStatement(database, "INSERT INTO aril_grants(repository_id, started_at, ends_at, actions, limits) VALUES (?, ?, ?, ?, ?)")
    .run(repositoryId, at, at + limits.hours * 3600000, JSON.stringify(actions), JSON.stringify(limits));
  return { ok: true, grant: readGrant(database, repositoryId, at) };
}
export function grantStop({ database, repositoryId, now }, payload) {
  if (!exact(payload, [])) return invalid();
  const at = now();
  if (readGrant(database, repositoryId, at)?.active) end(database, repositoryId, at, "stopped");
  return { ok: true };
}

function selected(task, rules) {
  return rules.some(({ kind, value }) => kind === "tag" ? splitTaskTags(task.text, 40).tags.includes(value)
    : kind === "text" ? task.text.toLowerCase().includes(value.toLowerCase())
      : kind === "feature" ? task.featureId === value : kind === "tasks" && value.includes(task.id));
}

export function grantStartAllowed(database, repositoryId, task, at) {
  const grant = readGrant(database, repositoryId, at);
  return grant?.active === true && grant.actions.start && selected(task, readAril(database, repositoryId).settings.workRules);
}

function sendBackFor(database, repositoryId, grant, task, rules) {
  if (!grant.actions.sendBack || grant.limits.sendBacks === null || task?.state !== "needs_review"
    || task.review?.state !== "failed" || !selected(task, rules)) return null;
  const grantId = preparedStatement(database, "SELECT id FROM aril_grants WHERE repository_id = ? AND ended_at IS NULL").get(repositoryId).id;
  const value = preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(`task_send_back:${repositoryId}:${task.id}`)?.value;
  const previous = value ? JSON.parse(value) : null;
  const count = previous?.grantId === grantId ? previous.count : 0;
  return count < grant.limits.sendBacks ? { grantId, count: count + 1, reasons: task.review.reasons } : null;
}

function sendBackGrant({ database, transaction, loadRows, repositoryId, payload, now }) {
  if (!isRepositoryId(repositoryId) || !exact(payload, ["taskId"]) || !isTaskId(payload.taskId)) return invalid();
  return transaction(() => {
    const at = now(), grant = readGrant(database, repositoryId, at);
    if (!grant?.active) return { ok: false, error: "not_active" };
    const board = projectBoard(repositoryId, loadRows(repositoryId), { at });
    const task = board && fillTaskReviews(database, board).tasks.find((task) => task.id === payload.taskId);
    const meta = sendBackFor(database, repositoryId, grant, task, readAril(database, repositoryId).settings.workRules);
    if (!meta) return { ok: false, error: "not_eligible" };
    const result = resolveRequeue({ database, repositoryId, now }, { id: task.id });
    if (!result.ok) return { ok: false, error: "not_eligible" };
    const number = Number(task.id.slice(2));
    settleReadyColumn(database, repositoryId, readTaskGroups(database, repositoryId));
    preparedStatement(database, "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`task_send_back:${repositoryId}:${task.id}`, JSON.stringify(meta));
    appendTaskLog(database, repositoryId, number, "sent_back", at);
    return { ok: true };
  });
}

export function grantReviewRun(run, reviewer) {
  const provider = reviewer.provider ?? (reviewer.differentFromBuilder ? (run.provider === "claude" ? "codex" : "claude") : run.provider ?? "claude");
  const model = reviewer.provider !== null && reviewer.model !== null ? reviewer.model : provider === run.provider ? run.model : null;
  const effort = provider === run.provider ? run.effort : null;
  return provider === run.provider && model === run.model && effort === run.effort ? null : { provider, model, effort };
}

const mergeKey = (repositoryId, taskId) => `task_merge_attempt:${repositoryId}:${taskId}`;
const headKnown = (head) => typeof head === "string" && /^[a-f0-9]{40}$/u.test(head);
function mergeFor(database, repositoryId, grant, task, settings, resolvePullRequestFacts) {
  if (!grant.actions.merge || task?.state !== "needs_review" || task.review?.state !== "passed" || !selected(task, settings.workRules)) return null;
  let facts;
  try { facts = resolvePullRequestFacts?.(task.session?.id, task.id); } catch { return null; }
  if (facts?.state !== "open" || facts.checks !== "passed" || !headKnown(facts.headOid)
    || !Number.isSafeInteger(facts.number) || facts.number < 1
    || preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(mergeKey(repositoryId, task.id))?.value === facts.headOid) return null;
  return { pullRequest: facts.number, headOid: facts.headOid, mergeMethod: settings.mergeMethod };
}

function attemptGrantMerge({ database, transaction, loadRows, repositoryId, payload, resolvePullRequestFacts, now }) {
  if (!isRepositoryId(repositoryId) || !exact(payload, ["taskId", "headOid"]) || !isTaskId(payload.taskId) || !headKnown(payload.headOid)) return invalid();
  return transaction(() => {
    const at = now(), grant = readGrant(database, repositoryId, at);
    if (!grant?.active) return { ok: false, error: "not_active" };
    const board = projectBoard(repositoryId, loadRows(repositoryId), { at });
    const task = board && fillTaskReviews(database, board).tasks.find((task) => task.id === payload.taskId);
    const merge = mergeFor(database, repositoryId, grant, task, readAril(database, repositoryId).settings, resolvePullRequestFacts);
    if (!merge || merge.headOid !== payload.headOid) return { ok: false, error: "not_eligible" };
    preparedStatement(database, "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(mergeKey(repositoryId, task.id), merge.headOid);
    return { ok: true, pullRequest: merge.pullRequest };
  });
}

function recordGrantMerge({ database, transaction, repositoryId, payload, now }) {
  if (!isRepositoryId(repositoryId) || !exact(payload, ["taskId", "headOid", "outcome"]) || !isTaskId(payload.taskId)
    || !headKnown(payload.headOid) || !["merged", "refused", "failed"].includes(payload.outcome)) return invalid();
  return transaction(() => {
    if (preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(mergeKey(repositoryId, payload.taskId))?.value !== payload.headOid
      || !preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, Number(payload.taskId.slice(2)))) return { ok: false, error: "not_eligible" };
    appendTaskLog(database, repositoryId, Number(payload.taskId.slice(2)), payload.outcome === "merged" ? "grant_merge" : "grant_merge_refused", now());
    return { ok: true };
  });
}

function grantAfterMet(database, repositoryId, task, board) {
  return (task.after ?? []).every((id) => {
    const parent = board.tasks.find((other) => other.id === id);
    return !parent || parent.state === "done" || (parent.state === "needs_review" && parent.review?.state === "passed")
      || Boolean(preparedStatement(database, "SELECT 1 FROM task_log WHERE repository_id = ? AND number = ? AND kind IN ('merged', 'grant_merge') LIMIT 1")
        .get(repositoryId, Number(id.slice(2))));
  });
}

export function grantStartGates(input) {
  const { database, repositoryId, board, taskId } = input;
  const task = board.tasks.find((candidate) => candidate.id === taskId);
  if (!grantAfterMet(database, repositoryId, task, board)) return { ok: false, reasons: [], early: true, after: true };
  // The grant has settled this task's dependencies; all other start gates keep their existing inputs.
  const gateBoard = { ...board, tasks: board.tasks.map((other) => other.id === taskId ? { ...other, after: [] } : other) };
  return startGates({ ...input, board: gateBoard });
}

function nextGrantSteps({ database, transaction, loadRows, resolveGateFacts, resolvePullRequestFacts, now }) {
  return transaction(() => {
    const at = now(), steps = [], sendBacks = [];
    for (const { repository_id: repositoryId } of preparedStatement(database, "SELECT repository_id FROM aril_grants WHERE ended_at IS NULL ORDER BY repository_id").all()) {
      const grant = readGrant(database, repositoryId, at);
      if (!grant.active || sendBacks.length >= 16) continue;
      const rows = loadRows(repositoryId);
      const projected = projectBoard(repositoryId, rows, { at });
      if (!projected) continue;
      const board = fillTaskReviews(database, projected);
      const settings = readAril(database, repositoryId).settings;
      const { workRules: rules, reviewer } = settings;
      const candidates = board.tasks.filter((task) => selected(task, rules));
      for (const task of candidates) {
        if (sendBacks.length >= 16) break;
        if (sendBackFor(database, repositoryId, grant, task, rules)) sendBacks.push({ repositoryId, taskId: task.id, kind: "send_back" });
        const merge = steps.length < 16 && mergeFor(database, repositoryId, grant, task, settings, resolvePullRequestFacts);
        if (merge) steps.push({ repositoryId, taskId: task.id, kind: "merge", ...merge });
      }
      const flying = rows.tasks.filter((row) => row.session_id !== null && row.report_at === null && rowInFlight(row, at)).length;
      const reviews = board.tasks.filter((task) => task.review?.state === "running").length;
      let available = grant.limits.concurrent - flying - reviews;
      const reviewMeta = (task, prefix) => preparedStatement(database, "SELECT 1 FROM meta WHERE key = ?").get(`${prefix}:${repositoryId}:${task.id}`);
      if (grant.actions.review) for (const task of candidates) {
        if (steps.length >= 16 || available <= 0) break;
        const row = rows.tasks.find((row) => `T-${row.number}` === task.id);
        if (task.state === "needs_review" && row.session_id !== null && task.review === null
          && !reviewMeta(task, "task_review_dispatch") && !reviewMeta(task, "task_reviewer")) {
          const run = grantReviewRun(task.run, reviewer);
          steps.push({ repositoryId, taskId: task.id, kind: "review", ...(run ? { run } : {}) });
          available -= 1;
        }
      }
      available = Math.min(available, grant.limits.starts - grant.startsUsed);
      const schedule = readQueueSchedule(database, repositoryId);
      if (!grant.actions.start || (schedule.stopAfter !== null && queueWindowHold(schedule, at))) continue;
      const ready = readyColumnId(database, repositoryId);
      for (const task of candidates.filter((task) => task.columnId === ready).sort((a, b) => a.position - b.position || Number(a.id.slice(2)) - Number(b.id.slice(2)))) {
        if (steps.length >= 16 || available <= 0) break;
        const row = rows.tasks.find((row) => `T-${row.number}` === task.id);
        if (!startable(row, at) || !grantStartGates({ database, repositoryId, board, rows, taskId: task.id, resolveGateFacts, at }).ok) continue;
        steps.push({ repositoryId, taskId: task.id, kind: "start" });
        available -= 1;
      }
    }
    return { ok: true, steps: [...sendBacks, ...steps].slice(0, 16) };
  });
}

function checkGrant({ database, transaction, repositoryId, now }) {
  if (!isRepositoryId(repositoryId)) return invalid();
  return transaction(() => ({ ok: true, active: readGrant(database, repositoryId, now())?.active === true }));
}
function recordGrant({ database, transaction, repositoryId, payload, now }) {
  if (!isRepositoryId(repositoryId) || !exact(payload, ["taskId", "kind"]) || !isTaskId(payload.taskId) || !["start", "review"].includes(payload.kind)) return invalid();
  return transaction(() => {
    const at = now();
    if (!readGrant(database, repositoryId, at)?.active) return { ok: false, error: "not_active" };
    const number = Number(payload.taskId.slice(2));
    if (!preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number)) return { ok: false, error: "not_found" };
    if (payload.kind === "start") preparedStatement(database, "UPDATE aril_grants SET starts_used = starts_used + 1 WHERE repository_id = ? AND ended_at IS NULL").run(repositoryId);
    appendTaskLog(database, repositoryId, number, payload.kind === "start" ? "grant_start" : "grant_review", at);
    readGrant(database, repositoryId, at);
    return { ok: true };
  });
}
function endGrant({ database, transaction, repositoryId, payload, now }) {
  if (!isRepositoryId(repositoryId) || !exact(payload, ["reason"]) || !["start_failed", "app_restart"].includes(payload.reason)) return invalid();
  return transaction(() => {
    const at = now();
    if (readGrant(database, repositoryId, at)?.active) end(database, repositoryId, at, payload.reason);
    return { ok: true };
  });
}
function endAllGrants({ database, transaction, payload, now }) {
  if (!exact(payload, ["reason"]) || payload.reason !== "app_restart") return invalid();
  return transaction(() => {
    const at = now();
    let ended = 0;
    for (const { repository_id: repositoryId } of preparedStatement(database, "SELECT repository_id FROM aril_grants WHERE ended_at IS NULL").all()) {
      if (!readGrant(database, repositoryId, at)?.active) continue;
      end(database, repositoryId, at, payload.reason);
      ended += 1;
    }
    return { ok: true, ended };
  });
}
export const grantOperations = (dispatch, loadRows, now) => ({
  attemptGrantMerge: (repositoryId, payload, resolvePullRequestFacts = null) => dispatch(attemptGrantMerge, { loadRows, repositoryId, payload, resolvePullRequestFacts, now }),
  recordGrantMerge: (repositoryId, payload) => dispatch(recordGrantMerge, { repositoryId, payload, now }),
  sendBackGrant: (repositoryId, payload) => dispatch(sendBackGrant, { loadRows, repositoryId, payload, now }),
  nextGrantSteps: ({ resolveGateFacts = null, resolvePullRequestFacts = null } = {}) => dispatch(nextGrantSteps, { loadRows, resolveGateFacts, resolvePullRequestFacts, now }),
  checkGrant: (repositoryId) => dispatch(checkGrant, { repositoryId, now }),
  recordGrant: (repositoryId, payload) => dispatch(recordGrant, { repositoryId, payload, now }),
  endGrant: (repositoryId, payload) => dispatch(endGrant, { repositoryId, payload, now }),
  endAllGrants: (payload) => dispatch(endAllGrants, { payload, now }),
});
