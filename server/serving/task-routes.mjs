import { validModelIdentifier, validModelLabel } from "../../shared/model-notification.mjs";
import { serveArilActionRoute, serveGrantRunner } from "./task-aril-routes.mjs";
// The serving layer may not import `server/tasks/` (dependency-cruiser `server-serving-layer`), so the fixed
export const TASK_ACTIONS = Object.freeze([
  "create", "update", "delete", "move", "feature_create", "feature_update", "feature_delete",
  "queue_add", "queue_remove", "queue_group", "queue_ungroup", "queue_settings", "resolve_done", "resolve_requeue",
  "session_assign", "session_unassign", "after_set", "rework_declare", "rework_remove", "aril_settings_set", "aril_memory_add", "aril_memory_update", "aril_memory_remove", "grant_start", "grant_stop",
]);
export const TASK_ACTION_PATH_PREFIX = "/internal/tasks/";
// The renderer caps the action payload at 16 KiB; the request adds only the fixed envelope around it.
const TASK_PAYLOAD_LIMIT_BYTES = 16 * 1024;
export const TASK_BODY_LIMIT_BYTES = TASK_PAYLOAD_LIMIT_BYTES + 1024;
const ACTION_STATUS = Object.freeze({ invalid: 400, not_found: 404, limit: 409, conflict: 409, unsupported: 501 });
// Desktop plan actions answer through their own handler, not the renderer's `pomegr:task-action` list above.
const START_ACTIONS = Object.freeze(["start-plan", "start-abort", "review-plan", "review-abort", "review-session"]);
const START_STATUS = Object.freeze({
  invalid: 400, not_found: 404, not_startable: 409, not_reviewable: 409, plugin_missing: 409, gate_held: 409, tree_dirty: 409, unsupported_provider: 422, unavailable: 503,
});
// Queue actions answer through their own handlers too.
const QUEUE_ACTIONS = Object.freeze(["queue-next", "queue-pause"]);
const QUEUE_STATUS = Object.freeze({ invalid: 400, not_found: 404, unavailable: 503 });
const QUEUE_START_LIMIT = 16;
const GRANT_ACTIONS = Object.freeze(["grant-next", "grant-record", "grant-check", "grant-end", "grant-end-all", "grant-send-back", "grant-merge-attempt", "grant-merge-result", "grant-branch-result", "grant-write-tasks"]);
// The removal of a done task's worktree: the desktop asks which wait, where a repository is, and reports one gone.
const WORKTREE_ACTIONS = Object.freeze(["worktree-cleanups", "worktree-root", "worktree-cleaned"]);
const WORKTREE_CLEANUP_LIMIT = 64;
const TASK_ID_PATTERN = /^T-[1-9][0-9]{0,8}$/u;
export const AGENT_SESSION_REF_PATTERN = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const SERVED_READINESS = new Set(["ready", "loading", "unavailable"]);
const RUN_MODEL_LIMIT = 64;
export const GATE_THRESHOLDS = Object.freeze([70, 85, 95]);
export const GATE_REASONS = Object.freeze([
  "earlier_task", "usage_over", "usage_unknown", "provider_incident", "provider_status_unknown", "tree_dirty", "tree_unknown",
  "before_queue_start", "after_queue_stop",
]);
// Why a waiting task has not started (`server/tasks/task-queue-waits.mjs`).
export const WAIT_REASONS = Object.freeze(["queue_off", "queue_blocked", "queue_paused", "own_schedule", "runs_after", "earlier_tasks", "running_work", ...GATE_REASONS, "unknown"]);
export const WAIT_TASK_LIMIT = 8;
const WAIT_LIMIT = 500;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const GATE_PROVIDERS = Object.freeze(["claude", "codex"]);
const GATE_USAGE_STATUSES = Object.freeze(["ok", "over", "unknown"]);
const GATE_PROVIDER_STATUSES = Object.freeze(["ok", "incident", "unknown"]);
const GATE_TREE_STATES = Object.freeze(["clean", "dirty", "unknown"]);
export const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function emptyBoard(readiness, repositoryId) {
  return {
    version: 1, readiness, repositoryId,
    columns: [], features: [], tasks: [],
    queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] },
    runModels: { codex: [] },
  };
}

export function projectRunModels(lookup) {
  const codex = [];
  try {
    const rows = typeof lookup === "function" ? lookup() : [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (codex.length >= RUN_MODEL_LIMIT) break;
      if (!row || !validModelIdentifier(row.id) || seen.has(row.id)) continue;
      seen.add(row.id);
      codex.push({ id: row.id, label: validModelLabel(row.label) ? row.label : null });
    }
  } catch { codex.length = 0; }
  return { codex };
}

const gatePercent = (value) => value === null || (Number.isInteger(value) && value >= 0 && value <= 100);

export function projectGates(gates) {
  if (!isPlainObject(gates) || !GATE_THRESHOLDS.includes(gates.threshold) || !GATE_TREE_STATES.includes(gates.workingTree)
    || !isPlainObject(gates.usage) || !isPlainObject(gates.providerStatus)) return undefined;
  const usage = {};
  const providerStatus = {};
  for (const provider of GATE_PROVIDERS) {
    const reading = gates.usage[provider];
    if (!isPlainObject(reading) || !GATE_USAGE_STATUSES.includes(reading.status) || !gatePercent(reading.fiveHourPercent)
      || !gatePercent(reading.sevenDayPercent) || !GATE_PROVIDER_STATUSES.includes(gates.providerStatus[provider])) return undefined;
    usage[provider] = { status: reading.status, fiveHourPercent: reading.fiveHourPercent, sevenDayPercent: reading.sevenDayPercent };
    providerStatus[provider] = gates.providerStatus[provider];
  }
  let next = null;
  if (gates.next !== null) {
    const held = gates.next;
    if (!isPlainObject(held) || typeof held.taskId !== "string" || !TASK_ID_PATTERN.test(held.taskId) || !GATE_PROVIDERS.includes(held.provider)
      || !(held.blockedBy === null || (typeof held.blockedBy === "string" && TASK_ID_PATTERN.test(held.blockedBy)))
      || !Array.isArray(held.reasons) || held.reasons.length > GATE_REASONS.length
      || !held.reasons.every((reason) => GATE_REASONS.includes(reason))) return undefined;
    next = { taskId: held.taskId, provider: held.provider, blockedBy: held.blockedBy, reasons: [...held.reasons] };
  }
  return { threshold: gates.threshold, usage, providerStatus, workingTree: gates.workingTree, next };
}

// Rebuilds the waits field by field, and drops them whole when one value is outside the contract.
export function projectWaits(waits) {
  if (!Array.isArray(waits) || waits.length === 0 || waits.length > WAIT_LIMIT) return undefined;
  const taskId = (value) => typeof value === "string" && TASK_ID_PATTERN.test(value);
  const projected = [];
  for (const wait of waits) {
    if (!isPlainObject(wait) || !taskId(wait.taskId) || !(wait.place === null || (Number.isSafeInteger(wait.place) && wait.place >= 1 && wait.place <= WAIT_LIMIT))
      || !Array.isArray(wait.reasons) || wait.reasons.length > WAIT_REASONS.length) return undefined;
    const reasons = [];
    for (const entry of wait.reasons) {
      if (!isPlainObject(entry) || !WAIT_REASONS.includes(entry.reason) || !Array.isArray(entry.taskIds) || entry.taskIds.length > WAIT_TASK_LIMIT
        || !entry.taskIds.every(taskId) || !Number.isSafeInteger(entry.more) || entry.more < 0 || entry.more > WAIT_LIMIT) return undefined;
      reasons.push({ reason: entry.reason, taskIds: [...entry.taskIds], more: entry.more });
    }
    projected.push({ taskId: wait.taskId, place: wait.place, reasons });
  }
  return projected;
}

export function projectSchedule(schedule) {
  if (!isPlainObject(schedule)) return undefined;
  const instant = (value) => value === null || (typeof value === "string" && INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value)));
  if (!instant(schedule.startAt) || !instant(schedule.stopAfter) || (schedule.startAt === null && schedule.stopAfter === null)) return undefined;
  return { startAt: schedule.startAt, stopAfter: schedule.stopAfter };
}

function projectSource(source) {
  return source !== null && typeof source === "object" && source.kind === "github_issue"
    && Number.isSafeInteger(source.number) && source.number >= 1 && source.number <= 999_999_999
    ? { kind: "github_issue", number: source.number }
    : null;
}

const projectTask = (task) => (task !== null && typeof task === "object" ? { ...task, source: projectSource(task.source) } : task);
function projectBoard(repositoryId, board, runModels) {
  if (!board || typeof board !== "object" || !SERVED_READINESS.has(board.readiness)
    || !Array.isArray(board.columns) || !Array.isArray(board.features) || !Array.isArray(board.tasks)
    || !board.queue || typeof board.queue !== "object" || !Array.isArray(board.queue.order)
    || (board.readiness === "ready" && (!isPlainObject(board.aril) || !isPlainObject(board.aril.settings) || !Array.isArray(board.aril.memory)))) {
    throw new TypeError("Task board unavailable");
  }
  const gates = projectGates(board.queue.gates); const schedule = projectSchedule(board.queue.schedule); const waits = projectWaits(board.queue.waits);
  return {
    version: 1, readiness: board.readiness, repositoryId,
    columns: board.columns, features: board.features, tasks: board.tasks.map(projectTask),
    queue: { status: board.queue.status, blockedBy: board.queue.blockedBy ?? null, pauseReason: board.queue.pauseReason ?? null, order: board.queue.order, ...(schedule ? { schedule } : {}), ...(gates ? { gates } : {}), ...(waits ? { waits } : {}) },
    ...(board.readiness === "ready" ? { aril: board.aril } : {}),
    runModels: projectRunModels(runModels),
  };
}
export function serveTaskRoute({ request, response, requestUrl, taskStore, authorized, runModels = null, resolveSessionFacts = null, resolveGateFacts = null, resolveCheckFacts = null }) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end();
    return;
  }
  const requestedId = requestUrl.searchParams.get("repositoryId") || "";
  const repositoryId = REPOSITORY_ID_PATTERN.test(requestedId) ? requestedId : "";
  if (!authorized) {
    response.writeHead(200, JSON_HEADERS);
    response.end(JSON.stringify(emptyBoard("desktop_only", repositoryId)));
    return;
  }
  const validQuery = [...requestUrl.searchParams.keys()].every((key) => key === "repositoryId"
    && requestUrl.searchParams.getAll(key).length === 1)
    && repositoryId !== ""
    && !(Number(request.headers["content-length"] || 0) > 0) && request.headers["transfer-encoding"] === undefined;
  if (!validQuery) {
    response.writeHead(400, JSON_HEADERS);
    response.end(JSON.stringify({ error: "Invalid tasks query" }));
    return;
  }
  try {
    const board = projectBoard(repositoryId, taskStore?.readBoard(repositoryId, { resolveSessionFacts, resolveGateFacts, resolveCheckFacts }), runModels);
    response.writeHead(200, JSON_HEADERS);
    response.end(JSON.stringify(board));
  } catch {
    // A missing store or a throwing read is unavailable, never an empty ready board.
    response.writeHead(503, JSON_HEADERS);
    response.end(JSON.stringify(emptyBoard("unavailable", repositoryId)));
  }
}

export function writeActionResult(response, status, body, { close = false } = {}) {
  response.writeHead(status, { ...JSON_HEADERS, "Cache-Control": "no-store", ...(close ? { Connection: "close" } : {}) });
  response.end(JSON.stringify(body));
}

const rejected = (error) => ({ ok: false, error });

// Reads the request body up to `limit` bytes.
export function readLimitedBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) { request.pause(); finish(null); return; }
      chunks.push(chunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks));
    const onError = (error) => { if (!settled) { settled = true; reject(error); } };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Plan actions answer `{ ok: true, plan }` and abort actions `{ ok: true }`; a refusal is a fixed code only.
function serveStartAction({ response, taskStore, resolveStart, resolveGateFacts, action, repositoryId, payload }) {
  try {
    const planning = action === "start-plan" || action === "review-plan";
    const call = action === "start-plan" ? taskStore?.planStart
      : action === "start-abort" ? taskStore?.abortStart
        : action === "review-plan" ? taskStore?.planReview : action === "review-session" ? taskStore?.reviewSession : taskStore?.abortReview;
    if (typeof call !== "function") {
      writeActionResult(response, 503, rejected("unavailable"));
      return;
    }
    const result = action === "start-plan"
      ? call(repositoryId, payload, (provider) => (typeof resolveStart === "function" ? resolveStart(repositoryId, provider) : null), resolveGateFacts)
      : action === "review-plan"
        ? call(repositoryId, payload, (provider) => (typeof resolveStart === "function" ? resolveStart(repositoryId, provider) : null))
      : call(repositoryId, payload);
    if (result?.ok === true) {
      writeActionResult(response, 200, action === "review-session" ? { ok: true, sessionId: result.sessionId } : planning ? { ok: true, plan: result.plan } : { ok: true });
      return;
    }
    const error = Object.hasOwn(START_STATUS, result?.error) ? result.error : "unavailable";
    writeActionResult(response, START_STATUS[error], rejected(error));
  } catch {
    writeActionResult(response, 503, rejected("unavailable"));
  }
}

function serveQueueNext({ response, taskStore, resolveGateFacts, body }) {
  try {
    if (!isPlainObject(body) || Object.keys(body).length > 0) {
      writeActionResult(response, 400, rejected("invalid"));
      return;
    }
    const result = typeof taskStore?.nextQueueStarts === "function" ? taskStore.nextQueueStarts({ resolveGateFacts }) : null;
    if (result?.ok !== true || !Array.isArray(result.starts)) {
      writeActionResult(response, 503, rejected("unavailable"));
      return;
    }
    const starts = [];
    for (const entry of result.starts) {
      if (starts.length >= QUEUE_START_LIMIT) break;
      if (isPlainObject(entry) && typeof entry.repositoryId === "string" && REPOSITORY_ID_PATTERN.test(entry.repositoryId)
        && typeof entry.taskId === "string" && TASK_ID_PATTERN.test(entry.taskId)) starts.push({ repositoryId: entry.repositoryId, taskId: entry.taskId });
    }
    writeActionResult(response, 200, { ok: true, starts });
  } catch {
    writeActionResult(response, 503, rejected("unavailable"));
  }
}

function serveQueuePause({ response, taskStore, repositoryId, payload }) {
  try {
    const result = typeof taskStore?.pauseQueue === "function" ? taskStore.pauseQueue(repositoryId, payload) : null;
    if (result?.ok === true) {
      writeActionResult(response, 200, { ok: true });
      return;
    }
    const error = Object.hasOwn(QUEUE_STATUS, result?.error) ? result.error : "unavailable";
    writeActionResult(response, QUEUE_STATUS[error], rejected(error));
  } catch {
    writeActionResult(response, 503, rejected("unavailable"));
  }
}

const startRoot = (resolveStart, repositoryId) => {
  try {
    const root = typeof resolveStart === "function" ? resolveStart(repositoryId, "claude")?.root : null;
    return typeof root === "string" && root.length > 0 ? root : null;
  } catch { return null; }
};

// `worktree-cleanups` answers `{ ok: true, cleanups }`: IDs from the store, each with the root the monitor holds for its repository.
function serveWorktreeCleanups({ response, taskStore, resolveStart, body }) {
  try {
    if (!isPlainObject(body) || Object.keys(body).length > 0) {
      writeActionResult(response, 400, rejected("invalid"));
      return;
    }
    const result = typeof taskStore?.worktreeCleanups === "function" ? taskStore.worktreeCleanups() : null;
    if (result?.ok !== true || !Array.isArray(result.cleanups)) {
      writeActionResult(response, 503, rejected("unavailable"));
      return;
    }
    const cleanups = [];
    const roots = new Map();
    for (const entry of result.cleanups) {
      if (cleanups.length >= WORKTREE_CLEANUP_LIMIT) break;
      if (!isPlainObject(entry) || typeof entry.repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(entry.repositoryId)
        || typeof entry.taskId !== "string" || !TASK_ID_PATTERN.test(entry.taskId)) continue;
      if (!roots.has(entry.repositoryId)) roots.set(entry.repositoryId, startRoot(resolveStart, entry.repositoryId));
      const repositoryRoot = roots.get(entry.repositoryId);
      // A repository the monitor has not located in this run is asked about again later.
      if (repositoryRoot !== null) cleanups.push({ repositoryId: entry.repositoryId, taskId: entry.taskId, repositoryRoot });
    }
    writeActionResult(response, 200, { ok: true, cleanups });
  } catch {
    writeActionResult(response, 503, rejected("unavailable"));
  }
}

// `worktree-root` answers `{ ok: true, root }` and `worktree-cleaned` `{ ok: true }`; a refusal is a fixed code only.
function serveWorktreeAction({ response, taskStore, resolveStart, action, repositoryId, payload }) {
  try {
    if (action === "worktree-root") {
      const root = Object.keys(payload).length === 0 ? startRoot(resolveStart, repositoryId) : undefined;
      if (typeof root === "string") writeActionResult(response, 200, { ok: true, root });
      else writeActionResult(response, root === null ? 404 : 400, rejected(root === null ? "not_found" : "invalid"));
      return;
    }
    const result = typeof taskStore?.worktreeCleaned === "function" ? taskStore.worktreeCleaned(repositoryId, payload) : null;
    if (result?.ok === true) {
      writeActionResult(response, 200, { ok: true });
      return;
    }
    const error = Object.hasOwn(QUEUE_STATUS, result?.error) ? result.error : "unavailable";
    writeActionResult(response, QUEUE_STATUS[error], rejected(error));
  } catch {
    writeActionResult(response, 503, rejected("unavailable"));
  }
}

function sessionOfRepository(resolveSession, sessionId, repositoryId) {
  if (typeof resolveSession !== "function" || typeof sessionId !== "string" || !AGENT_SESSION_REF_PATTERN.test(sessionId)) return false;
  try {
    const session = resolveSession(sessionId);
    return session?.found === true && session.repositoryId === repositoryId;
  } catch {
    return false;
  }
}

// `POST /internal/tasks/<action>`.
export async function serveTaskActionRoute({ request, response, requestUrl, taskStore, resolveStart = null, resolveSession = null, resolveSessionFacts = null, resolveGateFacts = null, resolveUsage = null, resolveCheckFacts = null, resolveOutcomeFacts = null, resolvePullRequestFacts = null }) {
  const action = requestUrl.pathname.slice(TASK_ACTION_PATH_PREFIX.length);
  if (!TASK_ACTIONS.includes(action) && !START_ACTIONS.includes(action) && !QUEUE_ACTIONS.includes(action) && !WORKTREE_ACTIONS.includes(action) && !GRANT_ACTIONS.includes(action)) {
    writeActionResult(response, 404, rejected("invalid"));
    return;
  }
  const declared = Number(request.headers["content-length"] || 0);
  if (requestUrl.search) {
    writeActionResult(response, 400, rejected("invalid"));
    return;
  }
  if (declared > TASK_BODY_LIMIT_BYTES) {
    writeActionResult(response, 413, rejected("invalid"), { close: true });
    return;
  }
  let raw;
  try {
    raw = await readLimitedBody(request, TASK_BODY_LIMIT_BYTES);
  } catch {
    writeActionResult(response, 400, rejected("invalid"), { close: true });
    return;
  }
  if (raw === null) {
    writeActionResult(response, 413, rejected("invalid"), { close: true });
    return;
  }
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    writeActionResult(response, 400, rejected("invalid"));
    return;
  }
  if (GRANT_ACTIONS.includes(action)) return serveGrantRunner({ request, response, taskStore, resolveGateFacts, resolveUsage, resolvePullRequestFacts, action, body });
  if (action === "queue-next") {
    serveQueueNext({ response, taskStore, resolveGateFacts, body });
    return;
  }
  if (action === "worktree-cleanups") {
    serveWorktreeCleanups({ response, taskStore, resolveStart, body });
    return;
  }
  const validEnvelope = isPlainObject(body) && Object.keys(body).every((key) => key === "repositoryId" || key === "payload")
    && typeof body.repositoryId === "string" && REPOSITORY_ID_PATTERN.test(body.repositoryId) && isPlainObject(body.payload);
  if (!validEnvelope) {
    writeActionResult(response, 400, rejected("invalid"));
    return;
  }
  if (Buffer.byteLength(JSON.stringify(body.payload), "utf8") > TASK_PAYLOAD_LIMIT_BYTES) {
    writeActionResult(response, 413, rejected("invalid"));
    return;
  }
  if (action === "queue-pause") {
    serveQueuePause({ response, taskStore, repositoryId: body.repositoryId, payload: body.payload });
    return;
  }
  if (WORKTREE_ACTIONS.includes(action)) {
    serveWorktreeAction({ response, taskStore, resolveStart, action, repositoryId: body.repositoryId, payload: body.payload });
    return;
  }
  if (START_ACTIONS.includes(action)) {
    serveStartAction({ response, taskStore, resolveStart, resolveGateFacts, action, repositoryId: body.repositoryId, payload: body.payload });
    return;
  }
  if (action.startsWith("aril_") || action === "grant_start" || action === "grant_stop") return serveArilActionRoute({ request, response, taskStore, repositoryId: body.repositoryId, action, payload: body.payload });
  try {
    if (typeof taskStore?.apply !== "function") {
      writeActionResult(response, 503, rejected("conflict"));
      return;
    }
    // The owner assigns only a session the monitor has committed for this repository; any other reads as not there.
    if (action === "session_assign" && !sessionOfRepository(resolveSession, body.payload.sessionId, body.repositoryId)) {
      writeActionResult(response, 404, rejected("not_found"));
      return;
    }
    const result = taskStore.apply(body.repositoryId, action, body.payload, { resolveSessionFacts, resolveGateFacts, resolveCheckFacts, resolveOutcomeFacts });
    if (result?.ok === true) {
      const taskId = action === "create" && typeof result.taskId === "string" && TASK_ID_PATTERN.test(result.taskId) ? result.taskId : null;
      writeActionResult(response, 200, { ok: true, board: projectBoard(body.repositoryId, result.board), ...(action === "rework_declare" && ["recorded", "exists"].includes(result.status) ? { status: result.status } : {}), ...(taskId === null ? {} : { taskId }) });
      return;
    }
    const error = Object.hasOwn(ACTION_STATUS, result?.error) ? result.error : "conflict";
    writeActionResult(response, ACTION_STATUS[error], rejected(error));
  } catch {
    writeActionResult(response, 503, rejected("conflict"));
  }
}

export const AGENT_TASK_ADD_PATH = "/api/agent/v1/tasks/add";
// `doneWhen` is the name an installed plugin from before the rename still sends for `completeWhen`.
const AGENT_TASK_KEYS = new Set(["sessionRef", "text", "run", "completeWhen", "doneWhen", "feature", "after"]);
const AGENT_FEATURE_NAME_LIMIT = 80;
const AGENT_ADD_STATUS = Object.freeze({
  invalid: 400, session_not_found: 404, repository_unavailable: 409, feature_not_found: 404, limit: 409,
  after_not_found: 404, after_loop: 409, unavailable: 503,
});
// What an agent may ask a task to run after: task IDs only. The store applies the board's bounds and loop refusal.
const isAgentAfter = (value) => value === undefined || (Array.isArray(value) && value.every((id) => typeof id === "string"));

function writeAgentAddResult(response, reason, taskId = null, { close = false } = {}) {
  const ok = reason === null;
  response.writeHead(ok ? 200 : AGENT_ADD_STATUS[reason], {
    ...JSON_HEADERS, "Cache-Control": "no-store", ...(close ? { Connection: "close" } : {}),
  });
  response.end(JSON.stringify(ok ? { schemaVersion: 1, ok: true, taskId } : { schemaVersion: 1, ok: false, reason }));
}

export async function readAgentJson(request, requestUrl, limit) {
  const mediaType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (requestUrl.search || mediaType !== "application/json" || request.headers["transfer-encoding"] !== undefined
    || Number(request.headers["content-length"] || 0) > limit) return { failed: true };
  let raw;
  try {
    raw = await readLimitedBody(request, limit);
  } catch {
    return { failed: true };
  }
  if (raw === null) return { failed: true };
  try { return { body: JSON.parse(raw.toString("utf8")) }; } catch { return { body: null }; }
}

function linkedBoardRepositoryId(taskStore, sessionRef) {
  try {
    const repositoryId = typeof taskStore?.sessionTasks === "function" ? taskStore.sessionTasks([sessionRef])?.get(sessionRef)?.repositoryId : null;
    return typeof repositoryId === "string" && REPOSITORY_ID_PATTERN.test(repositoryId) ? repositoryId : null;
  } catch {
    return null;
  }
}

// The tasks of a session, as references: the one Pomegr started it for, then the ones it is assigned to.
function agentSessionTasks(taskStore, sessionRef) {
  const started = taskStore.sessionTasks?.([sessionRef])?.get(sessionRef) ?? null;
  const assigned = typeof taskStore.sessionAssignedTasks === "function" ? taskStore.sessionAssignedTasks([sessionRef])?.get(sessionRef) ?? [] : [];
  return [...(started ? [started] : []), ...assigned];
}

export function agentBoardRepository(taskStore, resolveSession, sessionRef) {
  const linkedRepositoryId = linkedBoardRepositoryId(taskStore, sessionRef);
  let session = null;
  try {
    session = resolveSession(sessionRef);
  } catch (error) {
    if (linkedRepositoryId === null) throw error;
  }
  if (linkedRepositoryId === null && (!session || session.found !== true)) return { reason: "session_not_found" };
  const repositoryId = linkedRepositoryId ?? session.repositoryId;
  return typeof repositoryId === "string" && REPOSITORY_ID_PATTERN.test(repositoryId) ? { repositoryId } : { reason: "repository_unavailable" };
}

// `POST /api/agent/v1/tasks/add`, the first agent write.
export async function serveAgentTaskAddRoute({ request, response, requestUrl, taskStore, resolveSession }) {
  const read = await readAgentJson(request, requestUrl, TASK_PAYLOAD_LIMIT_BYTES);
  if (read.failed) {
    writeAgentAddResult(response, "invalid", null, { close: true });
    return;
  }
  const { body } = read;
  const feature = isPlainObject(body) ? body.feature : undefined;
  const valid = isPlainObject(body) && Object.keys(body).every((key) => AGENT_TASK_KEYS.has(key))
    && typeof body.sessionRef === "string" && AGENT_SESSION_REF_PATTERN.test(body.sessionRef)
    && typeof body.text === "string"
    && (feature === undefined || (typeof feature === "string" && feature.length > 0 && feature.length <= AGENT_FEATURE_NAME_LIMIT))
    && isAgentAfter(body.after);
  if (!valid) {
    writeAgentAddResult(response, "invalid");
    return;
  }
  try {
    if (typeof taskStore?.apply !== "function" || typeof taskStore?.readBoard !== "function" || typeof resolveSession !== "function") {
      writeAgentAddResult(response, "unavailable");
      return;
    }
    const { repositoryId, reason: boardReason } = agentBoardRepository(taskStore, resolveSession, body.sessionRef);
    if (boardReason) {
      writeAgentAddResult(response, boardReason);
      return;
    }
    const payload = { text: body.text };
    if (body.run !== undefined) payload.run = body.run;
    if (body.completeWhen !== undefined && body.doneWhen !== undefined) {
      writeAgentAddResult(response, "invalid");
      return;
    }
    const completeWhen = body.completeWhen ?? body.doneWhen;
    if (completeWhen !== undefined) payload.completeWhen = completeWhen;
    if (feature !== undefined) {
      // Exact name of a feature that is not done; a done feature reads as not found.
      const match = projectBoard(repositoryId, taskStore.readBoard(repositoryId)).features
        .find((candidate) => candidate.name === feature && candidate.done !== true);
      if (!match) {
        writeAgentAddResult(response, "feature_not_found");
        return;
      }
      payload.featureId = match.id;
    }
    const result = taskStore.apply(repositoryId, "agent_create", { sessionId: body.sessionRef, task: payload, ...(body.after === undefined ? {} : { after: body.after }) });
    if (result?.ok !== true) {
      const reason = ["invalid", "limit", "after_not_found", "after_loop"].includes(result?.error) ? result.error
        : feature !== undefined && (result?.error === "not_found" || result?.error === "conflict") ? "feature_not_found" : "unavailable";
      writeAgentAddResult(response, reason);
      return;
    }
    if (typeof result.taskId === "string" && TASK_ID_PATTERN.test(result.taskId)) {
      writeAgentAddResult(response, null, result.taskId);
      return;
    }
    const numbers = projectBoard(repositoryId, result.board).tasks.map((task) => ({ id: task.id, number: Number(String(task.id).slice(2)) }));
    const newest = numbers.reduce((best, task) => (best === null || task.number > best.number ? task : best), null);
    if (!newest) {
      writeAgentAddResult(response, "unavailable");
      return;
    }
    writeAgentAddResult(response, null, newest.id);
  } catch {
    writeAgentAddResult(response, "unavailable");
  }
}

export const AGENT_TASK_REMOVE_PATH = "/api/agent/v1/tasks/remove";
export const AGENT_REMOVE_BODY_LIMIT_BYTES = 1024;
const AGENT_REMOVE_STATUS = Object.freeze({ invalid: 400, not_found: 404, unavailable: 503 });
export const AGENT_TASK_ID_PATTERN = /^T-[1-9][0-9]{0,8}$/u;

// The answer of a write that carries nothing but its outcome: `ok`, or one fixed reason with its status.
export function writeAgentOutcome(statuses, response, reason, { close = false } = {}) {
  const ok = reason === null;
  response.writeHead(ok ? 200 : statuses[reason], {
    ...JSON_HEADERS, "Cache-Control": "no-store", ...(close ? { Connection: "close" } : {}),
  });
  response.end(JSON.stringify(ok ? { schemaVersion: 1, ok: true } : { schemaVersion: 1, ok: false, reason }));
}
const writeAgentRemoveResult = writeAgentOutcome.bind(null, AGENT_REMOVE_STATUS);

// `POST /api/agent/v1/tasks/remove`: the bound session deletes a task it added itself.
export async function serveAgentTaskRemoveRoute({ request, response, requestUrl, taskStore, resolveSession }) {
  const read = await readAgentJson(request, requestUrl, AGENT_REMOVE_BODY_LIMIT_BYTES);
  if (read.failed) {
    writeAgentRemoveResult(response, "invalid", { close: true });
    return;
  }
  const { body } = read;
  const valid = isPlainObject(body) && Object.keys(body).length === 2
    && typeof body.sessionRef === "string" && AGENT_SESSION_REF_PATTERN.test(body.sessionRef)
    && typeof body.taskId === "string" && AGENT_TASK_ID_PATTERN.test(body.taskId);
  if (!valid) {
    writeAgentRemoveResult(response, "invalid");
    return;
  }
  try {
    if (typeof taskStore?.apply !== "function" || typeof resolveSession !== "function") {
      writeAgentRemoveResult(response, "unavailable");
      return;
    }
    const { repositoryId } = agentBoardRepository(taskStore, resolveSession, body.sessionRef);
    if (!repositoryId) {
      writeAgentRemoveResult(response, "not_found");
      return;
    }
    const result = taskStore.apply(repositoryId, "agent_remove", { sessionId: body.sessionRef, id: body.taskId });
    if (result?.ok === true) writeAgentRemoveResult(response, null);
    else writeAgentRemoveResult(response, result?.error === "not_found" || result?.error === "invalid" ? result.error : "unavailable");
  } catch {
    writeAgentRemoveResult(response, "unavailable");
  }
}

export const AGENT_TASK_UPDATE_PATH = "/api/agent/v1/tasks/update";
const AGENT_UPDATE_STATUS = Object.freeze({
  invalid: 400, session_not_found: 404, repository_unavailable: 409, not_found: 404, after_not_found: 404, after_loop: 409, unavailable: 503,
});
const AGENT_UPDATE_FIELDS = Object.freeze(["text", "run", "completeWhen", "after"]);

const writeAgentUpdateResult = writeAgentOutcome.bind(null, AGENT_UPDATE_STATUS);

// `POST /api/agent/v1/tasks/update`: the bound session edits a task of its own board that has not started.
// The answer is a fixed status; it never carries the task's text or any stored field.
export async function serveAgentTaskUpdateRoute({ request, response, requestUrl, taskStore, resolveSession }) {
  const read = await readAgentJson(request, requestUrl, TASK_PAYLOAD_LIMIT_BYTES);
  if (read.failed) {
    writeAgentUpdateResult(response, "invalid", { close: true });
    return;
  }
  const { body } = read;
  const valid = isPlainObject(body) && Object.keys(body).every((key) => key === "sessionRef" || key === "taskId" || AGENT_UPDATE_FIELDS.includes(key))
    && typeof body.sessionRef === "string" && AGENT_SESSION_REF_PATTERN.test(body.sessionRef)
    && typeof body.taskId === "string" && AGENT_TASK_ID_PATTERN.test(body.taskId)
    && AGENT_UPDATE_FIELDS.some((key) => body[key] !== undefined)
    && (body.text === undefined || typeof body.text === "string")
    && isAgentAfter(body.after);
  if (!valid) {
    writeAgentUpdateResult(response, "invalid");
    return;
  }
  try {
    if (typeof taskStore?.apply !== "function" || typeof resolveSession !== "function") {
      writeAgentUpdateResult(response, "unavailable");
      return;
    }
    const { repositoryId, reason: boardReason } = agentBoardRepository(taskStore, resolveSession, body.sessionRef);
    if (boardReason) {
      writeAgentUpdateResult(response, boardReason);
      return;
    }
    const payload = { id: body.taskId };
    for (const key of AGENT_UPDATE_FIELDS) if (body[key] !== undefined) payload[key] = body[key];
    const result = taskStore.apply(repositoryId, "agent_update", payload);
    if (result?.ok === true) writeAgentUpdateResult(response, null);
    else writeAgentUpdateResult(response, ["not_found", "invalid", "after_not_found", "after_loop"].includes(result?.error) ? result.error : "unavailable");
  } catch {
    writeAgentUpdateResult(response, "unavailable");
  }
}

export const AGENT_FEATURE_GET_PATH ="/api/agent/v1/tasks/feature-get";
export const AGENT_FEATURE_CREATE_PATH = "/api/agent/v1/tasks/feature-create";
export const AGENT_FEATURE_UPDATE_PATH = "/api/agent/v1/tasks/feature-update";
export const AGENT_FEATURE_DELETE_PATH = "/api/agent/v1/tasks/feature-delete";
export const AGENT_FEATURE_PATHS = Object.freeze([AGENT_FEATURE_GET_PATH, AGENT_FEATURE_CREATE_PATH, AGENT_FEATURE_UPDATE_PATH, AGENT_FEATURE_DELETE_PATH]);
const AGENT_FEATURE_STATUS = Object.freeze({
  invalid: 400, session_not_found: 404, repository_unavailable: 409, not_found: 404, task_required: 409, conflict: 409, limit: 409, unavailable: 503,
});
const AGENT_FEATURE_ID_PATTERN = /^feat-[0-9a-f]{12}$/u;
const AGENT_FEATURE_DESCRIPTION_LIMIT = 2000;
const AGENT_FEATURE_APP_VERSION_LIMIT = 40;
// The keys each path takes beside `sessionRef`, and the ones it requires.
const AGENT_FEATURE_KEYS = Object.freeze({
  [AGENT_FEATURE_GET_PATH]: { allowed: ["feature", "taskId"], required: [] },
  [AGENT_FEATURE_CREATE_PATH]: { allowed: ["title", "description", "appVersion"], required: ["title"] },
  [AGENT_FEATURE_UPDATE_PATH]: { allowed: ["feature", "title", "description", "appVersion"], required: ["feature"] },
  [AGENT_FEATURE_DELETE_PATH]: { allowed: ["feature"], required: ["feature"] },
});

function writeAgentFeatureResult(response, reason, answer = null, { close = false } = {}) {
  const ok = reason === null;
  response.writeHead(ok ? 200 : AGENT_FEATURE_STATUS[reason], {
    ...JSON_HEADERS, "Cache-Control": "no-store", ...(close ? { Connection: "close" } : {}),
  });
  response.end(JSON.stringify(ok ? { schemaVersion: 1, ok: true, ...answer } : { schemaVersion: 1, ok: false, reason }));
}

const boundedString = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit;
const clearableString = (value, limit) => value === undefined || value === null || (typeof value === "string" && value.length <= limit);

// Only the four fields of a feature the store answered, each inside its bound, reach the agent.
function servedFeature(feature) {
  if (!isPlainObject(feature) || typeof feature.id !== "string" || !AGENT_FEATURE_ID_PATTERN.test(feature.id)
    || !boundedString(feature.title, AGENT_FEATURE_NAME_LIMIT)) return null;
  return {
    id: feature.id, title: feature.title,
    description: boundedString(feature.description, AGENT_FEATURE_DESCRIPTION_LIMIT) ? feature.description : null,
    appVersion: boundedString(feature.appVersion, AGENT_FEATURE_APP_VERSION_LIMIT) ? feature.appVersion : null,
  };
}

// `POST /api/agent/v1/tasks/feature-get|feature-create|feature-update|feature-delete`: the bound session reads or
// changes a feature of its own board. No body names a repository or a path.
export async function serveAgentFeatureRoute({ request, response, requestUrl, taskStore, resolveSession }) {
  const read = await readAgentJson(request, requestUrl, TASK_PAYLOAD_LIMIT_BYTES);
  if (read.failed) {
    writeAgentFeatureResult(response, "invalid", null, { close: true });
    return;
  }
  const { body } = read;
  const operation = requestUrl.pathname;
  const keys = AGENT_FEATURE_KEYS[operation];
  const valid = isPlainObject(body) && typeof body.sessionRef === "string" && AGENT_SESSION_REF_PATTERN.test(body.sessionRef)
    && Object.keys(body).every((key) => key === "sessionRef" || keys.allowed.includes(key))
    && keys.required.every((key) => Object.hasOwn(body, key))
    && (body.feature === undefined || boundedString(body.feature, AGENT_FEATURE_NAME_LIMIT))
    && (body.taskId === undefined || (body.feature === undefined && typeof body.taskId === "string" && AGENT_TASK_ID_PATTERN.test(body.taskId)))
    && (body.title === undefined || boundedString(body.title, AGENT_FEATURE_NAME_LIMIT))
    && clearableString(body.description, AGENT_FEATURE_DESCRIPTION_LIMIT) && clearableString(body.appVersion, AGENT_FEATURE_APP_VERSION_LIMIT);
  if (!valid) {
    writeAgentFeatureResult(response, "invalid");
    return;
  }
  try {
    if (typeof taskStore?.apply !== "function" || typeof taskStore?.readFeature !== "function" || typeof resolveSession !== "function") {
      writeAgentFeatureResult(response, "unavailable");
      return;
    }
    const { repositoryId, reason: boardReason } = agentBoardRepository(taskStore, resolveSession, body.sessionRef);
    if (boardReason) {
      writeAgentFeatureResult(response, boardReason);
      return;
    }
    if (operation === AGENT_FEATURE_GET_PATH) {
      // Without a feature the read is of the feature one task of the session belongs to: the named one, or its only one.
      let reference = body.feature ?? null;
      if (reference === null) {
        const tasks = agentSessionTasks(taskStore, body.sessionRef).filter((task) => body.taskId === undefined || task.id === body.taskId);
        if (tasks.length > 1) {
          writeAgentFeatureResult(response, "task_required");
          return;
        }
        reference = tasks[0]?.featureId ?? null;
      }
      const feature = reference === null ? null : servedFeature(taskStore.readFeature(repositoryId, reference));
      if (feature) writeAgentFeatureResult(response, null, { feature });
      else writeAgentFeatureResult(response, "not_found");
      return;
    }
    const { sessionRef: _sessionRef, ...payload } = body;
    const action = operation === AGENT_FEATURE_CREATE_PATH ? "agent_feature_create" : operation === AGENT_FEATURE_UPDATE_PATH ? "agent_feature_update" : "agent_feature_delete";
    const result = taskStore.apply(repositoryId, action, payload);
    if (result?.ok !== true) {
      writeAgentFeatureResult(response, ["invalid", "not_found", "conflict", "limit"].includes(result?.error) ? result.error : "unavailable");
      return;
    }
    if (operation === AGENT_FEATURE_DELETE_PATH) writeAgentFeatureResult(response, null);
    else if (typeof result.featureId === "string" && AGENT_FEATURE_ID_PATTERN.test(result.featureId)) writeAgentFeatureResult(response, null, { featureId: result.featureId });
    else writeAgentFeatureResult(response, "unavailable");
  } catch {
    writeAgentFeatureResult(response, "unavailable");
  }
}

export const AGENT_TASK_BIND_PATH = "/api/agent/v1/tasks/bind";
const AGENT_BIND_BODY_LIMIT_BYTES = 1024;
const AGENT_BIND_STATUS = Object.freeze({ invalid: 400, not_found: 404, unavailable: 503 });

const writeAgentBindResult = writeAgentOutcome.bind(null, AGENT_BIND_STATUS);

export async function serveAgentTaskBindRoute({ request, response, requestUrl, taskStore }) {
  const read = await readAgentJson(request, requestUrl, AGENT_BIND_BODY_LIMIT_BYTES);
  if (read.failed) {
    writeAgentBindResult(response, "invalid", { close: true });
    return;
  }
  const { body } = read;
  const valid = isPlainObject(body) && Object.keys(body).every((key) => key === "token" || key === "sessionRef")
    && typeof body.token === "string" && typeof body.sessionRef === "string" && AGENT_SESSION_REF_PATTERN.test(body.sessionRef);
  if (!valid) {
    writeAgentBindResult(response, "invalid");
    return;
  }
  try {
    if (typeof taskStore?.bindSession !== "function") {
      writeAgentBindResult(response, "unavailable");
      return;
    }
    const result = taskStore.bindSession({ token: body.token, sessionId: body.sessionRef });
    if (result?.ok === true) writeAgentBindResult(response, null);
    else writeAgentBindResult(response, Object.hasOwn(AGENT_BIND_STATUS, result?.error) ? result.error : "unavailable");
  } catch {
    writeAgentBindResult(response, "unavailable");
  }
}
