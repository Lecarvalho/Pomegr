import { validModelIdentifier, validModelLabel } from "../../shared/model-notification.mjs";

// The serving layer may not import `server/tasks/` (dependency-cruiser `server-serving-layer`), so the fixed
// action list is mirrored here; tests/server/tasks/task-actions.test.mjs pins it to `TASK_ACTIONS` in task-record.mjs.
export const TASK_ACTIONS = Object.freeze([
  "create", "update", "delete", "move", "column_create", "column_rename", "column_reorder", "column_delete", "column_role",
  "feature_create", "queue_add", "queue_remove", "queue_reorder", "queue_settings", "resolve_done", "resolve_requeue",
]);
export const TASK_ACTION_PATH_PREFIX = "/internal/tasks/";
// The renderer caps the action payload at 16 KiB; the request adds only the fixed envelope around it.
const TASK_PAYLOAD_LIMIT_BYTES = 16 * 1024;
const TASK_BODY_LIMIT_BYTES = TASK_PAYLOAD_LIMIT_BYTES + 1024;
const ACTION_STATUS = Object.freeze({ invalid: 400, not_found: 404, limit: 409, conflict: 409, unsupported: 501 });
// Session-start actions answer through their own handler, not the renderer's `pomegr:task-action` list above.
const START_ACTIONS = Object.freeze(["start-plan", "start-abort"]);
const START_STATUS = Object.freeze({
  invalid: 400, not_found: 404, not_startable: 409, plugin_missing: 409, gate_held: 409, unsupported_provider: 422, unavailable: 503,
});
// Queue actions answer through their own handlers too. `queue-next` takes an empty body and answers the tasks the running
// queues start now; `queue-pause` takes the usual envelope and records that a start did not succeed. Neither carries a board.
const QUEUE_ACTIONS = Object.freeze(["queue-next", "queue-pause"]);
const QUEUE_STATUS = Object.freeze({ invalid: 400, not_found: 404, unavailable: 503 });
const QUEUE_START_LIMIT = 16;
const TASK_ID_PATTERN = /^T-[1-9][0-9]{0,8}$/u;
const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const SERVED_READINESS = new Set(["ready", "loading", "unavailable"]);
const RUN_MODEL_LIMIT = 64;
// The start gates, mirrored like the action list; tests/server/tasks/task-gates-serving.test.mjs pins them to task-gates.mjs.
export const GATE_THRESHOLDS = Object.freeze([70, 85, 95]);
export const GATE_REASONS = Object.freeze([
  "previous_step", "usage_over", "usage_unknown", "provider_incident", "provider_status_unknown", "tree_dirty", "tree_unknown",
  "before_queue_start", "after_queue_stop",
]);
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const GATE_PROVIDERS = Object.freeze(["claude", "codex"]);
const GATE_USAGE_STATUSES = Object.freeze(["ok", "over", "unknown"]);
const GATE_PROVIDER_STATUSES = Object.freeze(["ok", "incident", "unknown"]);
const GATE_TREE_STATES = Object.freeze(["clean", "dirty", "unknown"]);
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function emptyBoard(readiness, repositoryId) {
  return {
    version: 1, readiness, repositoryId,
    columns: [], features: [], tasks: [],
    queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] },
    runModels: { codex: [] },
  };
}

/**
 * The Run on list: the last committed Codex client catalog, at most 64 distinct rows with a validated identifier
 * and a validated one-line label (or null). A lookup that is missing or throws yields an empty list.
 * It is a client catalog, never account entitlement.
 */
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

/**
 * The queue's start gates, rebuilt field by field: fixed statuses, whole percentages, the threshold, and the next
 * task with its fixed reasons. One value outside the contract drops the whole block, so the board says nothing
 * about the gates instead of something partial.
 */
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

/** The queue's own start and stop times: two instants or nulls, and nothing when neither is set or one is not an instant. */
export function projectSchedule(schedule) {
  if (!isPlainObject(schedule)) return undefined;
  const instant = (value) => value === null || (typeof value === "string" && INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value)));
  if (!instant(schedule.startAt) || !instant(schedule.stopAfter) || (schedule.startAt === null && schedule.stopAfter === null)) return undefined;
  return { startAt: schedule.startAt, stopAfter: schedule.stopAfter };
}

// The store validated every record; the route only pins the contract's top-level keys, the queue's keys, and the requested ID.
function projectBoard(repositoryId, board, runModels) {
  if (!board || typeof board !== "object" || !SERVED_READINESS.has(board.readiness)
    || !Array.isArray(board.columns) || !Array.isArray(board.features) || !Array.isArray(board.tasks)
    || !board.queue || typeof board.queue !== "object" || !Array.isArray(board.queue.order)) {
    throw new TypeError("Task board unavailable");
  }
  const gates = projectGates(board.queue.gates);
  const schedule = projectSchedule(board.queue.schedule);
  return {
    version: 1, readiness: board.readiness, repositoryId,
    columns: board.columns, features: board.features, tasks: board.tasks,
    queue: { status: board.queue.status, blockedBy: board.queue.blockedBy ?? null, pauseReason: board.queue.pauseReason ?? null, order: board.queue.order, ...(schedule ? { schedule } : {}), ...(gates ? { gates } : {}) },
    runModels: projectRunModels(runModels),
  };
}

/**
 * Committed-store task board GET. `authorized` is the same-computer decision the request handler
 * shares with `GET /api/provider-folders`; a denied client learns nothing beyond `desktop_only`.
 * `runModels` reads the last committed Codex client catalog from memory, and `resolveSessionFacts(sessionId)`
 * reads a linked session's title, state, and model from committed facts in memory (task-board.mjs validates them).
 * `resolveGateFacts(repositoryId)` reads the start-gate facts the same way (task-gates.mjs validates them); it may
 * queue an asynchronous refresh of the working-tree observation, never a synchronous read.
 * `resolveCheckFacts(sessionId)` reads the facts the done-when checks judge, from committed memory only, for the
 * reading a waiting task carries (task-board.mjs).
 * The route never acquires provider evidence and has no write path.
 */
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

function writeActionResult(response, status, body, { close = false } = {}) {
  response.writeHead(status, { ...JSON_HEADERS, "Cache-Control": "no-store", ...(close ? { Connection: "close" } : {}) });
  response.end(JSON.stringify(body));
}

const rejected = (error) => ({ ok: false, error });

/** Reads the request body up to `limit` bytes. Resolves null when the body is larger, without buffering the rest. */
function readLimitedBody(request, limit) {
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// `start-plan` answers `{ ok: true, plan }` and `start-abort` `{ ok: true }`; a refusal is a fixed code only.
// `resolveStart(repositoryId, provider)` supplies committed facts `{ root, pluginReady }` and is never called for a refusal
// that precedes it. A start the gates hold answers the fixed `gate_held`, never which gate or its facts.
// Neither answer ever carries the stored digest or an echo of task content.
function serveStartAction({ response, taskStore, resolveStart, resolveGateFacts, action, repositoryId, payload }) {
  try {
    const planning = action === "start-plan";
    const call = planning ? taskStore?.planStart : taskStore?.abortStart;
    if (typeof call !== "function") {
      writeActionResult(response, 503, rejected("unavailable"));
      return;
    }
    const result = planning
      ? call(repositoryId, payload, (provider) => (typeof resolveStart === "function" ? resolveStart(repositoryId, provider) : null), resolveGateFacts)
      : call(repositoryId, payload);
    if (result?.ok === true) {
      writeActionResult(response, 200, planning ? { ok: true, plan: result.plan } : { ok: true });
      return;
    }
    const error = Object.hasOwn(START_STATUS, result?.error) ? result.error : "unavailable";
    writeActionResult(response, START_STATUS[error], rejected(error));
  } catch {
    writeActionResult(response, 503, rejected("unavailable"));
  }
}

// `queue-next` answers only `{ ok: true, starts }`, each start a repository ID and a task ID re-validated here, at most 16.
// It starts nothing and carries no board and no task content. A start the gates hold is simply not in the answer.
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

// `queue-pause`: the store validates the payload and the task; the answer is `{ ok: true }` or a fixed code only.
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

/**
 * `POST /internal/tasks/<action>`. The request handler has already applied the private-action gate
 * (desktop token, loopback host, no Origin, POST), so a refused request never reaches this function
 * and never writes. The body is `{ repositoryId, payload }`; the answer is `{ ok: true, board }` or
 * `{ ok: false, error }`, never an echo of the input. The monitor validates the whole record.
 */
export async function serveTaskActionRoute({ request, response, requestUrl, taskStore, resolveStart = null, resolveSessionFacts = null, resolveGateFacts = null, resolveCheckFacts = null }) {
  const action = requestUrl.pathname.slice(TASK_ACTION_PATH_PREFIX.length);
  if (!TASK_ACTIONS.includes(action) && !START_ACTIONS.includes(action) && !QUEUE_ACTIONS.includes(action)) {
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
  if (action === "queue-next") {
    serveQueueNext({ response, taskStore, resolveGateFacts, body });
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
  if (START_ACTIONS.includes(action)) {
    serveStartAction({ response, taskStore, resolveStart, resolveGateFacts, action, repositoryId: body.repositoryId, payload: body.payload });
    return;
  }
  try {
    if (typeof taskStore?.apply !== "function") {
      writeActionResult(response, 503, rejected("conflict"));
      return;
    }
    const result = taskStore.apply(body.repositoryId, action, body.payload, { resolveSessionFacts, resolveGateFacts, resolveCheckFacts });
    if (result?.ok === true) {
      writeActionResult(response, 200, { ok: true, board: projectBoard(body.repositoryId, result.board) });
      return;
    }
    const error = Object.hasOwn(ACTION_STATUS, result?.error) ? result.error : "conflict";
    writeActionResult(response, ACTION_STATUS[error], rejected(error));
  } catch {
    writeActionResult(response, 503, rejected("conflict"));
  }
}

export const AGENT_TASK_ADD_PATH = "/api/agent/v1/tasks/add";
const AGENT_SESSION_REF_PATTERN = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const AGENT_TASK_KEYS = new Set(["sessionRef", "text", "run", "doneWhen", "feature"]);
const AGENT_FEATURE_NAME_LIMIT = 80;
const AGENT_ADD_STATUS = Object.freeze({
  invalid: 400, session_not_found: 404, repository_unavailable: 409, feature_not_found: 404, limit: 409, unavailable: 503,
});

function writeAgentAddResult(response, reason, taskId = null, { close = false } = {}) {
  const ok = reason === null;
  response.writeHead(ok ? 200 : AGENT_ADD_STATUS[reason], {
    ...JSON_HEADERS, "Cache-Control": "no-store", ...(close ? { Connection: "close" } : {}),
  });
  response.end(JSON.stringify(ok ? { schemaVersion: 1, ok: true, taskId } : { schemaVersion: 1, ok: false, reason }));
}

// The shared prelude of the agent write routes: a JSON content type, no query or chunked body, and a body within
// `limit` bytes that parses. `failed` means the connection is closed after an `invalid` answer; a body that does
// not parse is `null`, which each route refuses as `invalid` without closing.
async function readAgentJson(request, requestUrl, limit) {
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

// The repository whose board holds the task this session was started for, or null when the session is not
// linked, the store cannot say, or the stored identity is not a repository ID.
function linkedBoardRepositoryId(taskStore, sessionRef) {
  try {
    const repositoryId = typeof taskStore?.sessionTasks === "function" ? taskStore.sessionTasks([sessionRef])?.get(sessionRef)?.repositoryId : null;
    return typeof repositoryId === "string" && REPOSITORY_ID_PATTERN.test(repositoryId) ? repositoryId : null;
  } catch {
    return null;
  }
}

/**
 * `POST /api/agent/v1/tasks/add`, the first agent write. The request handler has already applied the
 * agent-query gate (loopback host, no Origin, agent token); this route adds the content-type check,
 * the strict body, and the bound session's repository from `resolveSession` (committed facts only).
 * The answer carries the new task ID and never an echo of task content. The store validates the record.
 */
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
    && (feature === undefined || (typeof feature === "string" && feature.length > 0 && feature.length <= AGENT_FEATURE_NAME_LIMIT));
  if (!valid) {
    writeAgentAddResult(response, "invalid");
    return;
  }
  try {
    if (typeof taskStore?.apply !== "function" || typeof taskStore?.readBoard !== "function" || typeof resolveSession !== "function") {
      writeAgentAddResult(response, "unavailable");
      return;
    }
    // A session started for a task adds to the board that holds that task, even when it runs in a task
    // worktree whose committed repository identity is another one. The task store's link wins; it is
    // read from the store alone, and a store that cannot answer leaves the committed identity in charge.
    const linkedRepositoryId = linkedBoardRepositoryId(taskStore, body.sessionRef);
    let session = null;
    try {
      session = resolveSession(body.sessionRef);
    } catch (error) {
      if (linkedRepositoryId === null) throw error;
    }
    if (linkedRepositoryId === null && (!session || session.found !== true)) {
      writeAgentAddResult(response, "session_not_found");
      return;
    }
    const repositoryId = linkedRepositoryId ?? session.repositoryId;
    if (typeof repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(repositoryId)) {
      writeAgentAddResult(response, "repository_unavailable");
      return;
    }
    const payload = { text: body.text };
    if (body.run !== undefined) payload.run = body.run;
    if (body.doneWhen !== undefined) payload.doneWhen = body.doneWhen;
    if (feature !== undefined) {
      // Exact name of an unfinished feature; agents never create features.
      const match = projectBoard(repositoryId, taskStore.readBoard(repositoryId)).features
        .find((candidate) => candidate.name === feature && candidate.done !== true);
      if (!match) {
        writeAgentAddResult(response, "feature_not_found");
        return;
      }
      payload.featureId = match.id;
    }
    const result = taskStore.apply(repositoryId, "create", payload);
    if (result?.ok !== true) {
      const reason = result?.error === "invalid" ? "invalid" : result?.error === "limit" ? "limit"
        : feature !== undefined && (result?.error === "not_found" || result?.error === "conflict") ? "feature_not_found" : "unavailable";
      writeAgentAddResult(response, reason);
      return;
    }
    // Task numbers only grow, so the newest task of the committed board is the one just created.
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

export const AGENT_TASK_BIND_PATH = "/api/agent/v1/tasks/bind";
// A token (at most 128 characters) and a session reference (at most 135) fit well inside this.
const AGENT_BIND_BODY_LIMIT_BYTES = 1024;
const AGENT_BIND_STATUS = Object.freeze({ invalid: 400, not_found: 404, unavailable: 503 });

function writeAgentBindResult(response, reason, { close = false } = {}) {
  const ok = reason === null;
  response.writeHead(ok ? 200 : AGENT_BIND_STATUS[reason], {
    ...JSON_HEADERS, "Cache-Control": "no-store", ...(close ? { Connection: "close" } : {}),
  });
  response.end(JSON.stringify(ok ? { schemaVersion: 1, ok: true } : { schemaVersion: 1, ok: false, reason }));
}

/**
 * `POST /api/agent/v1/tasks/bind`: the started session reports its dispatch token and its normalized session ID,
 * and the store links the two once. The request handler has already applied the agent-query gate. The token is
 * the only authority, so the route does not look the session up, and every refusal after a well-formed request
 * (wrong or reused token, expired dispatch, task or session already linked) is the same `not_found`. The answer
 * never carries a task, repository, or any task content. The store validates the token and the session ID.
 */
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

export const AGENT_TASK_COMPLETE_PATH = "/api/agent/v1/tasks/complete";
export const AGENT_TASK_BLOCK_PATH = "/api/agent/v1/tasks/block";
// A session reference (at most 135 characters) and a block reason (at most 200) fit well inside this.
const AGENT_REPORT_BODY_LIMIT_BYTES = 2048;
const AGENT_BLOCK_REASON_LIMIT = 200;
const AGENT_REPORT_STATUS = Object.freeze({ invalid: 400, not_found: 404, already_reported: 409, unavailable: 503 });
const REPORT_CHECKS = Object.freeze(["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed"]);

function writeAgentReportResult(response, reason, answer = null, { close = false } = {}) {
  const ok = reason === null;
  response.writeHead(ok ? 200 : AGENT_REPORT_STATUS[reason], {
    ...JSON_HEADERS, "Cache-Control": "no-store", ...(close ? { Connection: "close" } : {}),
  });
  response.end(JSON.stringify(ok ? { schemaVersion: 1, ok: true, ...answer } : { schemaVersion: 1, ok: false, reason }));
}

// Only the fixed check names and booleans the store recorded reach the agent.
function reportResults(results) {
  return (Array.isArray(results) ? results : [])
    .filter((result) => REPORT_CHECKS.includes(result?.check) && typeof result.passed === "boolean")
    .map((result) => ({ check: result.check, passed: result.passed }));
}

/**
 * `POST /api/agent/v1/tasks/complete` and `/block`: the bound session reports on the task it was started for.
 * The request handler has already applied the agent-query gate. The body is `{ sessionRef }`, plus a one-line
 * `reason` for a block; the session is the only input that names a task, so a session with no linked task is
 * `not_found`, and a task takes one report per dispatch (`already_reported`). On `complete` the store verifies
 * the checked conditions from `resolveCheckFacts(sessionRef)`, committed repository facts read from memory.
 * The answer carries the resulting state and, for `complete`, one `{ check, passed }` per checked condition;
 * never a task ID, task content, command output, or any repository fact.
 */
export async function serveAgentTaskReportRoute({ request, response, requestUrl, taskStore, resolveCheckFacts = null }) {
  const blocking = requestUrl.pathname === AGENT_TASK_BLOCK_PATH;
  const read = await readAgentJson(request, requestUrl, AGENT_REPORT_BODY_LIMIT_BYTES);
  if (read.failed) {
    writeAgentReportResult(response, "invalid", null, { close: true });
    return;
  }
  const { body } = read;
  const keys = blocking ? ["sessionRef", "reason"] : ["sessionRef"];
  const valid = isPlainObject(body) && Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key))
    && typeof body.sessionRef === "string" && AGENT_SESSION_REF_PATTERN.test(body.sessionRef)
    && (!blocking || (typeof body.reason === "string" && body.reason.trim().length > 0 && body.reason.length <= AGENT_BLOCK_REASON_LIMIT));
  if (!valid) {
    writeAgentReportResult(response, "invalid");
    return;
  }
  try {
    const call = blocking ? taskStore?.blockTask : taskStore?.completeTask;
    if (typeof call !== "function") {
      writeAgentReportResult(response, "unavailable");
      return;
    }
    const result = blocking
      ? call({ sessionId: body.sessionRef, reason: body.reason })
      : call({ sessionId: body.sessionRef }, () => (typeof resolveCheckFacts === "function" ? resolveCheckFacts(body.sessionRef) : null));
    if (result?.ok === true && blocking) writeAgentReportResult(response, null, { state: "blocked" });
    else if (result?.ok === true && (result.state === "done" || result.state === "needs_review")) {
      writeAgentReportResult(response, null, { state: result.state, results: reportResults(result.results) });
    } else writeAgentReportResult(response, Object.hasOwn(AGENT_REPORT_STATUS, result?.error) ? result.error : "unavailable");
  } catch {
    writeAgentReportResult(response, "unavailable");
  }
}
