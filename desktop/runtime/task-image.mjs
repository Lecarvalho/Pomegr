import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";

export const TASK_IMAGE_CHANNEL = "pomegr:task-image";
export const TASK_IMAGE_OPERATIONS = Object.freeze(["add", "remove", "read"]);
export const TASK_IMAGE_ERRORS = Object.freeze(["invalid", "not_found", "limit", "conflict", "unavailable"]);
export const TASK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const TASK_IMAGE_TYPES = Object.freeze(["png", "jpeg", "gif", "webp"]);

const ROUTES = Object.freeze({ add: "image-add", remove: "image-remove", read: "image-read" });
const MEDIA_TYPES = Object.freeze({ "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp" });
const OPERATION_SET = new Set(TASK_IMAGE_OPERATIONS);
const MONITOR_ERRORS = new Set(TASK_IMAGE_ERRORS);
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const IMAGE_ID = /^img-[0-9a-f]{12}$/u;
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

/** The validated payload of one operation, or null: a task ID, an image ID and, for `add` only, the image bytes. */
function validPayload(operation, payload) {
  const adding = operation === "add";
  if (!isPlainObject(payload) || Object.keys(payload).length !== (adding ? 3 : 2) || typeof payload.taskId !== "string" || !TASK_ID.test(payload.taskId)
    || typeof payload.imageId !== "string" || !IMAGE_ID.test(payload.imageId)) return null;
  if (!adding) return { taskId: payload.taskId, imageId: payload.imageId };
  const { bytes } = payload;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > TASK_IMAGE_MAX_BYTES) return null;
  return { taskId: payload.taskId, imageId: payload.imageId, bytes };
}

function refusal(body) {
  return isPlainObject(body) && body.ok === false && typeof body.error === "string" && MONITOR_ERRORS.has(body.error)
    ? Object.freeze({ ok: false, error: body.error })
    : UNAVAILABLE;
}

/**
 * Native-only bridge for the images of a task. It validates the fixed operation, the identifiers, and the size of
 * the bytes; the monitor decides the image type from the bytes and validates the rest. Image bytes cross only between
 * the trusted renderer and the monitor: this bridge never writes them to disk, logs them, or names a file.
 */
export function createTaskImage(options = {}) {
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = options.authorizationToken;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let disposed = false;

  async function run(event, repositoryId, operation, payload) {
    if (!isTrustedEvent(event)) return INVALID;
    if (typeof operation !== "string" || !OPERATION_SET.has(operation)) return INVALID;
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return INVALID;
    const input = validPayload(operation, payload);
    if (input === null) return INVALID;
    if (!monitorOrigin || !authorizationToken || disposed) return UNAVAILABLE;
    try {
      const adding = operation === "add";
      const query = adding ? `?repositoryId=${repositoryId}&taskId=${input.taskId}&imageId=${input.imageId}` : "";
      const response = await fetchImpl(`${monitorOrigin}/internal/tasks/${ROUTES[operation]}${query}`, {
        method: "POST",
        cache: "no-store",
        headers: { [DESKTOP_AUTH_HEADER]: authorizationToken, "content-type": adding ? "application/octet-stream" : "application/json" },
        body: adding ? Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength) : JSON.stringify({ repositoryId, payload: { taskId: input.taskId, imageId: input.imageId } }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (operation === "read" && response.ok) {
        const type = MEDIA_TYPES[String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()];
        if (!type) return UNAVAILABLE;
        const bytes = new Uint8Array(await response.arrayBuffer());
        return bytes.byteLength > 0 && bytes.byteLength <= TASK_IMAGE_MAX_BYTES ? Object.freeze({ ok: true, type, bytes }) : UNAVAILABLE;
      }
      let parsed = null;
      try { parsed = await response.json(); } catch { return UNAVAILABLE; }
      if (!isPlainObject(parsed) || parsed.ok !== true) return refusal(parsed);
      if (!response.ok || operation === "read") return UNAVAILABLE;
      if (!adding) return Object.freeze({ ok: true });
      // Only the image's ID crosses, and only the one that was asked for: anything else the monitor said is dropped.
      return parsed.imageId === input.imageId ? Object.freeze({ ok: true, imageId: input.imageId }) : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }

  return Object.freeze({ run, dispose() { disposed = true; } });
}

export function installTaskImageIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Task images require ipcMain");
  ipcMain.removeHandler(TASK_IMAGE_CHANNEL);
  const action = options.action || createTaskImage(options);
  ipcMain.handle(TASK_IMAGE_CHANNEL, async (event, repositoryId, operation, payload) => {
    try { return await action.run(event, repositoryId, operation, payload); } catch { return UNAVAILABLE; }
  });
  return () => { ipcMain.removeHandler(TASK_IMAGE_CHANNEL); action.dispose?.(); };
}
