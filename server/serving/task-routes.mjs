// The serving layer may not import `server/tasks/` (dependency-cruiser `server-serving-layer`), so the fixed
// action list is mirrored here; tests/server/tasks/task-actions.test.mjs pins it to `TASK_ACTIONS` in task-record.mjs.
export const TASK_ACTIONS = Object.freeze([
  "create", "update", "delete", "move", "column_create", "column_rename", "column_reorder", "column_delete",
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
  invalid: 400, not_found: 404, not_startable: 409, plugin_missing: 409, unsupported_provider: 422, unavailable: 503,
});
const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const SERVED_READINESS = new Set(["ready", "loading", "unavailable"]);
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function emptyBoard(readiness, repositoryId) {
  return {
    version: 1, readiness, repositoryId,
    columns: [], features: [], tasks: [],
    queue: { status: "idle", blockedBy: null, order: [] },
  };
}

// The store validated every record; the route only pins the contract's top-level keys and the requested ID.
function projectBoard(repositoryId, board) {
  if (!board || typeof board !== "object" || !SERVED_READINESS.has(board.readiness)
    || !Array.isArray(board.columns) || !Array.isArray(board.features) || !Array.isArray(board.tasks)
    || !board.queue || typeof board.queue !== "object" || !Array.isArray(board.queue.order)) {
    throw new TypeError("Task board unavailable");
  }
  return {
    version: 1, readiness: board.readiness, repositoryId,
    columns: board.columns, features: board.features, tasks: board.tasks, queue: board.queue,
  };
}

/**
 * Committed-store task board GET. `authorized` is the same-computer decision the request handler
 * shares with `GET /api/provider-folders`; a denied client learns nothing beyond `desktop_only`.
 * The route never acquires provider evidence and has no write path.
 */
export function serveTaskRoute({ request, response, requestUrl, taskStore, authorized }) {
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
    const board = projectBoard(repositoryId, taskStore?.readBoard(repositoryId));
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
// `resolveStart(repositoryId)` supplies committed facts `{ root, pluginReady }` and is never called for a refusal
// that precedes it. Neither answer ever carries the stored digest or an echo of task content.
function serveStartAction({ response, taskStore, resolveStart, action, repositoryId, payload }) {
  try {
    const planning = action === "start-plan";
    const call = planning ? taskStore?.planStart : taskStore?.abortStart;
    if (typeof call !== "function") {
      writeActionResult(response, 503, rejected("unavailable"));
      return;
    }
    const result = planning
      ? call(repositoryId, payload, () => (typeof resolveStart === "function" ? resolveStart(repositoryId) : null))
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

/**
 * `POST /internal/tasks/<action>`. The request handler has already applied the private-action gate
 * (desktop token, loopback host, no Origin, POST), so a refused request never reaches this function
 * and never writes. The body is `{ repositoryId, payload }`; the answer is `{ ok: true, board }` or
 * `{ ok: false, error }`, never an echo of the input. The monitor validates the whole record.
 */
export async function serveTaskActionRoute({ request, response, requestUrl, taskStore, resolveStart = null }) {
  const action = requestUrl.pathname.slice(TASK_ACTION_PATH_PREFIX.length);
  if (!TASK_ACTIONS.includes(action) && !START_ACTIONS.includes(action)) {
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
  if (START_ACTIONS.includes(action)) {
    serveStartAction({ response, taskStore, resolveStart, action, repositoryId: body.repositoryId, payload: body.payload });
    return;
  }
  try {
    if (typeof taskStore?.apply !== "function") {
      writeActionResult(response, 503, rejected("conflict"));
      return;
    }
    const result = taskStore.apply(body.repositoryId, action, body.payload);
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

/**
 * `POST /api/agent/v1/tasks/add`, the first agent write. The request handler has already applied the
 * agent-query gate (loopback host, no Origin, agent token); this route adds the content-type check,
 * the strict body, and the bound session's repository from `resolveSession` (committed facts only).
 * The answer carries the new task ID and never an echo of task content. The store validates the record.
 */
export async function serveAgentTaskAddRoute({ request, response, requestUrl, taskStore, resolveSession }) {
  const mediaType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (requestUrl.search || mediaType !== "application/json" || request.headers["transfer-encoding"] !== undefined
    || Number(request.headers["content-length"] || 0) > TASK_PAYLOAD_LIMIT_BYTES) {
    writeAgentAddResult(response, "invalid", null, { close: true });
    return;
  }
  let raw;
  try {
    raw = await readLimitedBody(request, TASK_PAYLOAD_LIMIT_BYTES);
  } catch {
    writeAgentAddResult(response, "invalid", null, { close: true });
    return;
  }
  if (raw === null) {
    writeAgentAddResult(response, "invalid", null, { close: true });
    return;
  }
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; }
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
    const session = resolveSession(body.sessionRef);
    if (!session || session.found !== true) {
      writeAgentAddResult(response, "session_not_found");
      return;
    }
    const repositoryId = session.repositoryId;
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
