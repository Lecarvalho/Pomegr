import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { setTaskAfter } from "./task-after.mjs";
import { normalizeArilLimits, readAril } from "./task-aril-settings.mjs";
import { readColumnRoles, readyColumnId, settleReadyColumn } from "./task-columns.mjs";
import { readTaskGroups } from "./task-groups.mjs";
import { startable } from "./task-dispatch.mjs";
import { appendTaskLog } from "./task-log.mjs";
import { readQueueSchedule, startGates } from "./task-queue-advance.mjs";
import { queueWindowHold } from "./task-queue.mjs";
import { isRepositoryId, isTaskId, projectBoard, taskIdFromNumber } from "./task-record.mjs";
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
  if (!database.prepare("PRAGMA table_info(aril_grants)").all().some((column) => column.name === "tasks_written")) {
    database.exec("ALTER TABLE aril_grants ADD COLUMN tasks_written INTEGER NOT NULL DEFAULT 0");
  }
}
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const invalid = () => ({ ok: false, error: "invalid" });
const metaValue = (database, key) => preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(key)?.value;
const saveMeta = (database, key, value) => preparedStatement(database,
  "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
const end = (database, repositoryId, at, reason) => {
  const row = preparedStatement(database, "SELECT limits FROM aril_grants WHERE repository_id = ? AND ended_at IS NULL").get(repositoryId);
  if (row) preparedStatement(database, "UPDATE aril_grants SET ended_at = ?, end_reason = ?, limits = ? WHERE repository_id = ? AND ended_at IS NULL")
    .run(at, reason, JSON.stringify(normalizeArilLimits(JSON.parse(row.limits))), repositoryId);
};

function grantTasks(database, row, resolvePullRequestFacts) {
  const repositoryId = row.repository_id, key = `grant_tasks:${repositoryId}`;
  let ledger = JSON.parse(metaValue(database, key) ?? "null");
  if (ledger?.grantId !== row.id) ledger = { grantId: row.id, tasks: preparedStatement(database,
    "SELECT DISTINCT number FROM task_log WHERE repository_id = ? AND kind = 'grant_start' AND at >= ?").all(repositoryId, row.started_at).map(({ number }) => `T-${number}`), closed: [] };
  const limits = normalizeArilLimits(JSON.parse(row.limits)), actions = JSON.parse(row.actions);
  const tasks = fillTaskReviews(database, { repositoryId, tasks: preparedStatement(database,
    "SELECT number, state, session_id FROM tasks WHERE repository_id = ?").all(repositoryId).map((task) => ({ ...task, id: `T-${task.number}` })) }).tasks;
  const open = ledger.tasks.filter((id) => {
    if (ledger.closed.includes(id)) return false;
    const task = tasks.find((task) => task.id === id);
    const sent = JSON.parse(metaValue(database, `task_send_back:${repositoryId}:${id}`) ?? "null");
    if (!task || ["done", "blocked"].includes(task.state)
      || (task.review?.state === "failed" && (!actions.sendBack || limits.sendBacks === null || (sent?.grantId === row.id ? sent.count : 0) >= limits.sendBacks))
      || preparedStatement(database, "SELECT 1 FROM task_log WHERE repository_id = ? AND number = ? AND kind IN ('merged', 'grant_merge') AND at >= ?").get(repositoryId, task.number, row.started_at)) {
      ledger.closed.push(id); return false;
    }
    const refused = metaValue(database, `task_merge_refused:${repositoryId}:${id}`);
    if (refused) {
      let facts; try { facts = resolvePullRequestFacts?.(task.session_id, id); } catch { /* Unknown head keeps the owner hold. */ }
      if (!facts?.headOid || facts.headOid === refused) return false;
    }
    return true;
  });
  saveMeta(database, key, JSON.stringify(ledger));
  return { ...ledger, open };
}

// Every caller owns a transaction: an observed limit and its terminal reason commit together.
export function readGrant(database, repositoryId, at, resolvePullRequestFacts) {
  const row = preparedStatement(database, "SELECT * FROM aril_grants WHERE repository_id = ? ORDER BY id DESC LIMIT 1").get(repositoryId);
  if (!row) return null;
  const actions = JSON.parse(row.actions), limits = normalizeArilLimits(JSON.parse(row.limits));
  delete limits.plans;
  if (row.ended_at === null && (at >= row.ends_at || (row.starts_used >= limits.tasks && grantTasks(database, row, resolvePullRequestFacts).open.length === 0))) {
    row.end_reason = at >= row.ends_at ? "expired" : "tasks_used";
    row.ended_at = at;
    end(database, repositoryId, at, row.end_reason);
  }
  return { startedAt: row.started_at, endsAt: row.ends_at, startsUsed: row.starts_used, actions, limits,
    active: row.ended_at === null, ...(row.ended_at === null ? {} : { endedAt: row.ended_at, endReason: row.end_reason === "starts_used" ? "tasks_used" : row.end_reason }) };
}

export function grantStart({ database, repositoryId, ensureRepository, now }, payload) {
  if (!exact(payload, [])) return invalid();
  const at = now();
  if (readGrant(database, repositoryId, at)?.active) return { ok: false, error: "conflict" };
  const { actions, limits, workRules } = readAril(database, repositoryId).settings;
  const plans = workRules.filter((rule) => rule.kind === "plan").map((rule) => rule.value);
  if ([limits.hours, limits.tasks, limits.tasksAtATime, limits.usagePercent].some((limit) => limit === null) || (!actions.start && !actions.review && !actions.merge)
    || (actions.sendBack && limits.sendBacks === null) || (actions.writeTasks && (!actions.start || plans.length === 0))) return { ok: false, error: "not_ready" };
  ensureRepository(database, repositoryId);
  preparedStatement(database, "INSERT INTO aril_grants(repository_id, started_at, ends_at, actions, limits) VALUES (?, ?, ?, ?, ?)")
    .run(repositoryId, at, at + limits.hours * 3600000, JSON.stringify(actions), JSON.stringify({ ...limits, plans }));
  const { id } = preparedStatement(database, "SELECT id FROM aril_grants WHERE repository_id = ? AND ended_at IS NULL").get(repositoryId);
  saveMeta(database, `grant_tasks:${repositoryId}`, JSON.stringify({ grantId: id, tasks: [], closed: [] }));
  return { ok: true, grant: readGrant(database, repositoryId, at) };
}
export function grantStop({ database, repositoryId, now }, payload) {
  if (!exact(payload, [])) return invalid();
  const at = now();
  if (readGrant(database, repositoryId, at)?.active) end(database, repositoryId, at, "stopped");
  return { ok: true };
}

function selected(task, rules, database, repositoryId) {
  return rules.some(({ kind, value }) => kind === "tag" ? splitTaskTags(task.text, 40).tags.includes(value)
    : kind === "text" ? task.text.toLowerCase().includes(value.toLowerCase())
      : kind === "feature" ? task.featureId === value : kind === "tasks" && value.includes(task.id))
    || Boolean(preparedStatement(database, `SELECT 1 FROM meta JOIN aril_grants ON meta.value = CAST(aril_grants.id AS TEXT)
      WHERE meta.key = ? AND aril_grants.repository_id = ? AND ended_at IS NULL`).get(`task_grant_written:${repositoryId}:${task.id}`, repositoryId));
}

export function grantStartAllowed(database, repositoryId, task, at) {
  const grant = readGrant(database, repositoryId, at);
  return grant?.active === true && grant.actions.start && selected(task, readAril(database, repositoryId).settings.workRules, database, repositoryId);
}

function sendBackFor(database, repositoryId, grant, task, rules) {
  if (!grant.actions.sendBack || grant.limits.sendBacks === null || task?.state !== "needs_review"
    || task.review?.state !== "failed" || !selected(task, rules, database, repositoryId)) return null;
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
  if (!grant.actions.merge || task?.state !== "needs_review" || task.review?.state !== "passed" || !selected(task, settings.workRules, database, repositoryId)) return null;
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
    if (payload.outcome !== "merged") saveMeta(database, `task_merge_refused:${repositoryId}:${payload.taskId}`, payload.headOid);
    return { ok: true };
  });
}

function writeGrantTasks({ database, transaction, repositoryId, payload, now, createTask }) {
  if (!isRepositoryId(repositoryId) || !exact(payload, ["plan", "tasks"])
    || typeof payload.plan !== "string" || !Array.isArray(payload.tasks) || payload.tasks.length < 1 || payload.tasks.length > 5) return { ok: false, error: "invalid" };
  try {
    return transaction(() => {
      const at = now(), grant = readGrant(database, repositoryId, at);
      if (!grant?.active) return { ok: false, error: "not_active" };
      const stored = preparedStatement(database, "SELECT id, limits, tasks_written FROM aril_grants WHERE repository_id = ? AND ended_at IS NULL").get(repositoryId);
      if (!grant.actions.writeTasks || !(JSON.parse(stored.limits).plans ?? []).includes(payload.plan)) return { ok: false, error: "not_allowed" };
      if (stored.tasks_written + payload.tasks.length > grant.limits.tasks) return { ok: false, error: "limit" };
      const columnId = readyColumnId(database, repositoryId), taskIds = [];
      if (columnId === null) return { ok: false, error: "invalid" };
      for (const task of payload.tasks) {
        if ((task === null || typeof task !== "object" || Array.isArray(task)) || Object.keys(task).some((key) => !["text", "completeWhen", "after"].includes(key))
          || (task.after !== undefined && !Array.isArray(task.after))) throw new Error("invalid");
        const after = (task.after ?? []).map((id) => typeof id === "string" && /^#[1-5]$/u.test(id) ? taskIds[Number(id.slice(1)) - 1] : id);
        const created = createTask({ database, repositoryId, columnId }, { text: task.text, completeWhen: task.completeWhen });
        if (!created.ok) throw new Error(created.error === "limit" ? "limit" : "invalid");
        const taskId = taskIdFromNumber(created.number);
        if (!setTaskAfter({ database, repositoryId, now }, { id: taskId, after }).ok) throw new Error("invalid");
        preparedStatement(database, "INSERT INTO meta(key, value) VALUES (?, ?)").run(`task_grant_written:${repositoryId}:${taskId}`, String(stored.id));
        appendTaskLog(database, repositoryId, created.number, "grant_task_written", at);
        taskIds.push(taskId);
      }
      preparedStatement(database, "UPDATE aril_grants SET tasks_written = tasks_written + ?, limits = ? WHERE id = ?")
        .run(taskIds.length, JSON.stringify(normalizeArilLimits(JSON.parse(stored.limits))), stored.id);
      return { ok: true, taskIds };
    });
  } catch (error) { return { ok: false, error: error.message === "limit" ? "limit" : "invalid" }; }
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

function nextGrantSteps({ database, transaction, loadRows, resolveGateFacts, resolvePullRequestFacts, resolveUsage, now }) {
  return transaction(() => {
    const at = now(), steps = [], sendBacks = [], usageStates = [], stepProviders = new Map();
    for (const { repository_id: repositoryId } of preparedStatement(database, "SELECT repository_id FROM aril_grants WHERE ended_at IS NULL ORDER BY repository_id").all()) {
      const grant = readGrant(database, repositoryId, at, resolvePullRequestFacts);
      if (!grant.active || sendBacks.length >= 16) continue;
      const rows = loadRows(repositoryId);
      const projected = projectBoard(repositoryId, rows, { at });
      if (!projected) continue;
      const board = fillTaskReviews(database, projected);
      const settings = readAril(database, repositoryId).settings;
      const { workRules: rules, reviewer } = settings;
      const stored = preparedStatement(database, "SELECT * FROM aril_grants WHERE repository_id = ? AND ended_at IS NULL").get(repositoryId);
      const ledger = grantTasks(database, stored, resolvePullRequestFacts), held = new Set();
      const usage = Object.fromEntries(["claude", "codex"].map((provider) => {
        let value; try { value = resolveUsage?.(provider); } catch { value = null; }
        return [provider, typeof value === "number" && Number.isFinite(value) ? value : null];
      }));
      const offer = (step, provider, target = steps) => {
        if (usage[provider] == null || usage[provider] >= grant.limits.usagePercent || grant.limits.usagePercent === null) { held.add(provider); return false; }
        target.push(step); stepProviders.set(step, provider); return true;
      };
      usageStates.push({ repositoryId, grantId: stored.id, held });
      const candidates = board.tasks.filter((task) => selected(task, rules, database, repositoryId));
      for (const task of candidates) {
        if (sendBacks.length >= 16) break;
        if (sendBackFor(database, repositoryId, grant, task, rules)) offer({ repositoryId, taskId: task.id, kind: "send_back" }, task.run.provider ?? "claude", sendBacks);
        const merge = steps.length < 16 && mergeFor(database, repositoryId, grant, task, settings, resolvePullRequestFacts);
        if (merge) steps.push({ repositoryId, taskId: task.id, kind: "merge", ...merge });
      }
      let available = Math.min(grant.limits.tasksAtATime - ledger.open.length, grant.limits.tasks - grant.startsUsed);
      const ready = readyColumnId(database, repositoryId);
      const roles = readColumnRoles(database, repositoryId);
      if (grant.actions.writeTasks && !candidates.some((task) => task.columnId === ready || task.inFlight || task.state === "needs_review" || roles.get(task.columnId) === "review")) {
        const key = `grant_write_offered:${repositoryId}`;
        const offered = JSON.parse(preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(key)?.value ?? "null");
        const plans = JSON.parse(stored.limits).plans ?? [];
        if (steps.length + sendBacks.length < 16 && plans.length > 0 && stored.tasks_written < grant.limits.tasks
          && (offered?.grantId !== stored.id || at - offered.at > 600000)) {
          const providers = reviewer.provider ? [reviewer.provider] : Object.keys(usage).filter((provider) => usage[provider] !== null);
          const provider = providers.find((provider) => usage[provider] < grant.limits.usagePercent);
          if (provider) offer({ repositoryId, kind: "write_tasks", plans }, provider);
          else for (const provider of providers.length ? providers : Object.keys(usage)) held.add(provider);
        }
      }
      const reviewMeta = (task, prefix) => preparedStatement(database, "SELECT 1 FROM meta WHERE key = ?").get(`${prefix}:${repositoryId}:${task.id}`);
      if (grant.actions.review) for (const task of candidates) {
        if (steps.length >= 16) break;
        const row = rows.tasks.find((row) => `T-${row.number}` === task.id);
        if (task.state === "needs_review" && row.session_id !== null && task.review === null
          && !reviewMeta(task, "task_review_dispatch") && !reviewMeta(task, "task_reviewer")) {
          const run = grantReviewRun(task.run, reviewer);
          offer({ repositoryId, taskId: task.id, kind: "review", ...(run ? { run } : {}) }, (run ?? task.run).provider ?? "claude");
        }
      }
      const schedule = readQueueSchedule(database, repositoryId);
      if (!grant.actions.start || (schedule.stopAfter !== null && queueWindowHold(schedule, at))) continue;
      for (const task of candidates.filter((task) => task.columnId === ready).sort((a, b) => a.position - b.position || Number(a.id.slice(2)) - Number(b.id.slice(2)))) {
        if (steps.length >= 16) break;
        const taken = ledger.tasks.includes(task.id);
        if (taken ? !ledger.open.includes(task.id) : available <= 0) continue;
        const row = rows.tasks.find((row) => `T-${row.number}` === task.id);
        if (!startable(row, at) || !grantStartGates({ database, repositoryId, board, rows, taskId: task.id, resolveGateFacts, at }).ok) continue;
        if (offer({ repositoryId, taskId: task.id, kind: "start" }, task.run.provider ?? "claude") && !taken) available -= 1;
      }
    }
    const offeredSteps = [...sendBacks, ...steps].slice(0, 16);
    for (const { repositoryId, grantId, held } of usageStates) {
      for (const provider of ["claude", "codex"]) {
        const key = `grant_usage:${repositoryId}:${provider}`, previous = metaValue(database, key) === String(grantId);
        const resumed = offeredSteps.some((step) => step.repositoryId === repositoryId && stepProviders.get(step) === provider);
        if ((!previous && held.has(provider)) || (previous && resumed)) {
          appendTaskLog(database, repositoryId, 0, previous ? "grant_usage_resume" : "grant_usage_hold", at, null, provider);
          saveMeta(database, key, previous ? "" : String(grantId));
        }
      }
    }
    for (const step of offeredSteps.filter((step) => step.kind === "write_tasks")) {
      const { id: grantId } = preparedStatement(database, "SELECT id FROM aril_grants WHERE repository_id = ? AND ended_at IS NULL").get(step.repositoryId);
      preparedStatement(database, "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(`grant_write_offered:${step.repositoryId}`, JSON.stringify({ grantId, at }));
    }
    return { ok: true, steps: offeredSteps };
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
    const row = preparedStatement(database, "SELECT * FROM aril_grants WHERE repository_id = ? AND ended_at IS NULL").get(repositoryId);
    const ledger = grantTasks(database, row), first = payload.kind === "start" && !ledger.tasks.includes(payload.taskId);
    if (first) {
      ledger.tasks.push(payload.taskId);
      saveMeta(database, `grant_tasks:${repositoryId}`, JSON.stringify({ grantId: row.id, tasks: ledger.tasks, closed: ledger.closed }));
    }
    preparedStatement(database, "UPDATE aril_grants SET starts_used = starts_used + ?, limits = ? WHERE id = ?")
      .run(Number(first), JSON.stringify(normalizeArilLimits(JSON.parse(row.limits))), row.id);
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
export const grantOperations = (dispatch, loadRows, now, createTask) => ({
  writeGrantTasks: (repositoryId, payload) => dispatch(writeGrantTasks, { repositoryId, payload, now, createTask }),
  attemptGrantMerge: (repositoryId, payload, resolvePullRequestFacts = null) => dispatch(attemptGrantMerge, { loadRows, repositoryId, payload, resolvePullRequestFacts, now }),
  recordGrantMerge: (repositoryId, payload) => dispatch(recordGrantMerge, { repositoryId, payload, now }),
  sendBackGrant: (repositoryId, payload) => dispatch(sendBackGrant, { loadRows, repositoryId, payload, now }),
  nextGrantSteps: ({ resolveGateFacts = null, resolvePullRequestFacts = null, resolveUsage = null } = {}) => dispatch(nextGrantSteps, { loadRows, resolveGateFacts, resolvePullRequestFacts, resolveUsage, now }),
  checkGrant: (repositoryId) => dispatch(checkGrant, { repositoryId, now }),
  recordGrant: (repositoryId, payload) => dispatch(recordGrant, { repositoryId, payload, now }),
  endGrant: (repositoryId, payload) => dispatch(endGrant, { repositoryId, payload, now }),
  endAllGrants: (payload) => dispatch(endAllGrants, { payload, now }),
});
