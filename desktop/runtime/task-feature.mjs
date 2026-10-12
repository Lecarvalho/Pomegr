import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";

export const TASK_FEATURE_CHANNEL = "pomegr:task-feature";
export const TASK_FEATURE_ERRORS = Object.freeze(["invalid", "not_found", "unavailable"]);
export const TASK_FEATURE_DESCRIPTION_MAX = 2000;
export const TASK_FEATURE_APP_VERSION_MAX = 40;

const MONITOR_ERRORS = new Set(TASK_FEATURE_ERRORS);
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const FEATURE_ID = /^feat-[0-9a-f]{12}$/u;
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

const boundedField = (value, limit) => (typeof value === "string" && value.length > 0 && value.length <= limit ? value : null);

/** Native-only read of a feature's description and app version; it never logs, stores, or forwards them beyond the answer. */
export function createTaskFeature(options = {}) {
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = options.authorizationToken;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let disposed = false;

  async function run(event, repositoryId, featureId) {
    if (!isTrustedEvent(event)) return INVALID;
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return INVALID;
    if (typeof featureId !== "string" || !FEATURE_ID.test(featureId)) return INVALID;
    if (!monitorOrigin || !authorizationToken || disposed) return UNAVAILABLE;
    try {
      const response = await fetchImpl(`${monitorOrigin}/internal/tasks/feature-read`, {
        method: "POST",
        cache: "no-store",
        headers: { [DESKTOP_AUTH_HEADER]: authorizationToken, "content-type": "application/json" },
        body: JSON.stringify({ repositoryId, payload: { id: featureId } }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      let parsed = null;
      try { parsed = await response.json(); } catch { return UNAVAILABLE; }
      if (!isPlainObject(parsed)) return UNAVAILABLE;
      if (parsed.ok === true) {
        if (!response.ok || !isPlainObject(parsed.feature)) return UNAVAILABLE;
        return Object.freeze({
          ok: true,
          description: boundedField(parsed.feature.description, TASK_FEATURE_DESCRIPTION_MAX),
          appVersion: boundedField(parsed.feature.appVersion, TASK_FEATURE_APP_VERSION_MAX),
        });
      }
      return parsed.ok === false && typeof parsed.error === "string" && MONITOR_ERRORS.has(parsed.error)
        ? Object.freeze({ ok: false, error: parsed.error })
        : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }

  return Object.freeze({ run, dispose() { disposed = true; } });
}

export function installTaskFeatureIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Task features require ipcMain");
  ipcMain.removeHandler(TASK_FEATURE_CHANNEL);
  const action = options.action || createTaskFeature(options);
  ipcMain.handle(TASK_FEATURE_CHANNEL, async (event, repositoryId, featureId) => {
    try { return await action.run(event, repositoryId, featureId); } catch { return UNAVAILABLE; }
  });
  return () => { ipcMain.removeHandler(TASK_FEATURE_CHANNEL); action.dispose?.(); };
}
