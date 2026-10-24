import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";

export const SESSION_HISTORY_CHANNEL = "pomegr:session-history";
export const SESSION_HISTORY_ERRORS = Object.freeze(["invalid", "not_found", "unavailable"]);

const MONITOR_ERRORS = new Set(SESSION_HISTORY_ERRORS);
const SESSION_ID = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
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

function position(value) {
  return isPlainObject(value) && Object.keys(value).length === 2
    && typeof value.fingerprint === "string" && value.fingerprint.length > 0 && value.fingerprint.length <= 256
    && Number.isSafeInteger(value.offset) && value.offset >= 0;
}

function historyRequest(value) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !["cursor", "before", "limit"].includes(key))) return null;
  if (value.cursor !== undefined && !position(value.cursor)) return null;
  if (value.before !== undefined && !position(value.before)) return null;
  if (value.cursor !== undefined && value.before !== undefined) return null;
  const limit = value.limit === undefined ? 100 : value.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return null;
  return { ...(value.cursor ? { cursor: value.cursor } : {}), ...(value.before ? { before: value.before } : {}), limit };
}

function historyMessage(value) {
  if (!isPlainObject(value) || !Object.hasOwn(value, "at")
    || value.at !== null && (typeof value.at !== "number" || !Number.isFinite(value.at))) return false;
  if (value.kind === "owner" || value.kind === "agent") {
    return Object.keys(value).length === 3 && typeof value.text === "string" && value.text.length <= 32_000;
  }
  return value.kind === "tool" && Object.keys(value).length === 4
    && typeof value.name === "string" && value.name.length <= 64
    && ["completed", "failed", "pending"].includes(value.outcome);
}

function historyPage(value) {
  return isPlainObject(value) && Object.keys(value).length === 5
    && Array.isArray(value.messages) && value.messages.length <= 200 && value.messages.every(historyMessage)
    && (value.cursor === null || position(value.cursor)) && (value.older === null || position(value.older))
    && typeof value.reset === "boolean" && ["ok", "missing", "unsupported"].includes(value.status);
}

function boundedResult(response, body) {
  if (!isPlainObject(body)) return UNAVAILABLE;
  if (Object.keys(body).length === 1 && typeof body.error === "string" && MONITOR_ERRORS.has(body.error)) {
    return Object.freeze({ ok: false, error: body.error });
  }
  return response.ok && historyPage(body) ? Object.freeze({ ok: true, page: body }) : UNAVAILABLE;
}

/** Desktop-only read-through for bounded, normalized session messages. */
export function createSessionHistory(options = {}) {
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = options.authorizationToken;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let disposed = false;

  async function run(event, sessionId, request) {
    if (!isTrustedEvent(event)) return INVALID;
    if (typeof sessionId !== "string" || sessionId.length > 640 || !SESSION_ID.test(sessionId)) return INVALID;
    const payload = historyRequest(request);
    if (!payload) return INVALID;
    if (!monitorOrigin || !authorizationToken || disposed) return UNAVAILABLE;
    try {
      const response = await fetchImpl(`${monitorOrigin}/internal/sessions/history-read`, {
        method: "POST",
        cache: "no-store",
        headers: { [DESKTOP_AUTH_HEADER]: authorizationToken, "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...payload }),
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

export function installSessionHistoryIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Session history requires ipcMain");
  ipcMain.removeHandler(SESSION_HISTORY_CHANNEL);
  const action = options.action || createSessionHistory(options);
  ipcMain.handle(SESSION_HISTORY_CHANNEL, async (event, sessionId, request) => {
    try { return await action.run(event, sessionId, request); } catch { return UNAVAILABLE; }
  });
  return () => { ipcMain.removeHandler(SESSION_HISTORY_CHANNEL); action.dispose?.(); };
}
