import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";

export const TASK_ACTION_CHANNEL = "pomegr:task-action";
export const TASK_ACTION_NAMES = Object.freeze([
  "create", "update", "delete", "move",
  "column_create", "column_rename", "column_reorder", "column_delete", "column_role",
  "feature_create",
  "queue_add", "queue_remove", "queue_reorder", "queue_settings",
  "resolve_done", "resolve_requeue",
]);
export const TASK_ACTION_ERRORS = Object.freeze([
  "invalid", "not_found", "limit", "conflict", "unsupported", "unavailable",
]);
export const TASK_ACTION_PAYLOAD_MAX_BYTES = 16 * 1024;

const ACTION_SET = new Set(TASK_ACTION_NAMES);
const MONITOR_ERRORS = new Set(["invalid", "not_found", "limit", "conflict", "unsupported"]);
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const INVALID = Object.freeze({ ok: false, error: "invalid" });
const UNAVAILABLE = Object.freeze({ ok: false, error: "unavailable" });

function trustedMonitorOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "::1"].includes(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Serialized request body, or null when the payload is not a plain JSON object within the cap. */
function requestBody(repositoryId, payload) {
  if (!isPlainObject(payload)) return null;
  try {
    const serializedPayload = JSON.stringify(payload);
    if (typeof serializedPayload !== "string" || Buffer.byteLength(serializedPayload, "utf8") > TASK_ACTION_PAYLOAD_MAX_BYTES) return null;
    return `{"repositoryId":${JSON.stringify(repositoryId)},"payload":${serializedPayload}}`;
  } catch { return null; }
}

/** Maps a monitor answer to the bounded result the renderer sees. Board, text and HTTP details never cross. */
function boundedResult(response, body) {
  if (!isPlainObject(body)) return UNAVAILABLE;
  if (body.ok === true) return response.ok ? Object.freeze({ ok: true }) : UNAVAILABLE;
  if (body.ok === false && typeof body.error === "string" && MONITOR_ERRORS.has(body.error)) {
    return Object.freeze({ ok: false, error: body.error });
  }
  return UNAVAILABLE;
}

/**
 * Native-only bridge for task-board mutations. It validates only the fixed action name, the repository ID
 * pattern and the payload shape and size. The monitor validates the record, and this bridge never reads or
 * logs task content.
 */
export function createTaskAction(options = {}) {
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = options.authorizationToken;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let disposed = false;

  async function run(event, repositoryId, action, payload) {
    if (!isTrustedEvent(event)) return INVALID;
    if (typeof action !== "string" || !ACTION_SET.has(action)) return INVALID;
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return INVALID;
    const body = requestBody(repositoryId, payload);
    if (body === null) return INVALID;
    if (!monitorOrigin || !authorizationToken || disposed) return UNAVAILABLE;
    try {
      const response = await fetchImpl(`${monitorOrigin}/internal/tasks/${action}`, {
        method: "POST",
        cache: "no-store",
        headers: { [DESKTOP_AUTH_HEADER]: authorizationToken, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      let parsed = null;
      try { parsed = await response.json(); } catch { return UNAVAILABLE; }
      return boundedResult(response, parsed);
    } catch {
      return UNAVAILABLE;
    }
  }

  return Object.freeze({ run, dispose() { disposed = true; } });
}

export function installTaskActionIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Task actions require ipcMain");
  ipcMain.removeHandler(TASK_ACTION_CHANNEL);
  const action = options.action || createTaskAction(options);
  ipcMain.handle(TASK_ACTION_CHANNEL, async (event, repositoryId, name, payload) => {
    try { return await action.run(event, repositoryId, name, payload); } catch { return UNAVAILABLE; }
  });
  return () => { ipcMain.removeHandler(TASK_ACTION_CHANNEL); action.dispose?.(); };
}
