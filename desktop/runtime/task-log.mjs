import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";

export const TASK_LOG_CHANNEL = "pomegr:task-log";
export const TASK_LOG_ERRORS = Object.freeze(["invalid", "unavailable"]);

const MONITOR_ERRORS = new Set(TASK_LOG_ERRORS);
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

export const TASK_LOG_KINDS = Object.freeze(["started", "assigned", "review", "blocked", "requeued", "done", "stalled", "recovered", "checks_passed", "checks_failed", "merged", "review_started", "review_passed", "review_failed", "grant_start", "grant_review", "sent_back", "grant_merge", "grant_merge_refused", "grant_task_written", "grant_usage_hold", "grant_usage_resume"]);

function boundedLog(value) {
  if (!isPlainObject(value) || !Array.isArray(value.entries) || value.entries.length > 200
    || typeof value.more !== "boolean" || !isPlainObject(value.cursors)
    || !Number.isSafeInteger(value.cursors.aril) || value.cursors.aril < 0) return null;
  const entries = [];
  for (const entry of value.entries) {
    if (!isPlainObject(entry) || !Number.isSafeInteger(entry.id) || entry.id <= 0
      || !TASK_LOG_KINDS.includes(entry.kind)
      || !Number.isSafeInteger(entry.at) || (entry.pullRequest !== null && (!Number.isSafeInteger(entry.pullRequest) || entry.pullRequest <= 0))) return null;
    const usageTransition = entry.kind === "grant_usage_hold" || entry.kind === "grant_usage_resume";
    if (usageTransition ? entry.task !== null || !["claude", "codex"].includes(entry.reason) || entry.pullRequest !== null
      : typeof entry.task !== "string" || !/^T-[1-9]\d*$/u.test(entry.task) || Object.hasOwn(entry, "reason")) return null;
    const { id, task, kind, at, pullRequest } = entry;
    entries.push(usageTransition ? { id, task, kind, at, pullRequest, reason: entry.reason } : { id, task, kind, at, pullRequest });
  }
  return { entries, more: value.more, arilCursor: value.cursors.aril };
}

/** Desktop-main task log read; viewing never advances a consumer cursor. */
export function createTaskLog(options = {}) {
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = options.authorizationToken;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let disposed = false;

  async function readLog(repositoryId) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return INVALID;
    if (!monitorOrigin || !authorizationToken || disposed) return UNAVAILABLE;
    try {
      const response = await fetchImpl(`${monitorOrigin}/internal/tasks/log-read`, {
        method: "POST",
        cache: "no-store",
        headers: { [DESKTOP_AUTH_HEADER]: authorizationToken, "content-type": "application/json" },
        body: JSON.stringify({ repositoryId, payload: { limit: 200 } }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      const parsed = await response.json();
      if (!isPlainObject(parsed)) return UNAVAILABLE;
      if (parsed.ok === true) {
        const log = response.ok ? boundedLog(parsed.log) : null;
        return log ? Object.freeze({ ok: true, log }) : UNAVAILABLE;
      }
      return parsed.ok === false && typeof parsed.error === "string" && MONITOR_ERRORS.has(parsed.error)
        ? Object.freeze({ ok: false, error: parsed.error }) : UNAVAILABLE;
    } catch { return UNAVAILABLE; }
  }

  async function run(event, repositoryId) {
    return isTrustedEvent(event) ? readLog(repositoryId) : INVALID;
  }

  return Object.freeze({ run, readLog, dispose() { disposed = true; } });
}

export function installTaskLogIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Task logs require ipcMain");
  ipcMain.removeHandler(TASK_LOG_CHANNEL);
  const action = options.action || createTaskLog(options);
  ipcMain.handle(TASK_LOG_CHANNEL, async (event, repositoryId) => {
    try { return await action.run(event, repositoryId); } catch { return UNAVAILABLE; }
  });
  return () => { ipcMain.removeHandler(TASK_LOG_CHANNEL); action.dispose?.(); };
}
