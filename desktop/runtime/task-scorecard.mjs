import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";

export const TASK_SCORECARD_CHANNEL = "pomegr:task-scorecard";
export const TASK_SCORECARD_ERRORS = Object.freeze(["invalid", "unavailable"]);

const MONITOR_ERRORS = new Set(TASK_SCORECARD_ERRORS);
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

function boundedSnapshot(value) {
  if (!isPlainObject(value) || typeof value.version !== "string" || value.version.length < 1 || value.version.length > 40
    || !Number.isSafeInteger(value.takenAt) || !isPlainObject(value.measures)) return null;
  const measures = {};
  for (const name of ["ownerTurns", "reviewToDoneMs", "firstPass"]) {
    const measure = value.measures[name];
    if (!isPlainObject(measure) || !Number.isSafeInteger(measure.sample) || measure.sample < 0
      || (measure.value !== null && (!Number.isFinite(measure.value) || measure.value < 0 || (name === "firstPass" && measure.value > 1)))) return null;
    measures[name] = { value: measure.value, sample: measure.sample };
  }
  return { version: value.version, takenAt: value.takenAt, measures };
}

/** Native-only scorecard read; only the app's own version is sent to the monitor. */
export function createTaskScorecard(options = {}) {
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = options.authorizationToken;
  const appVersion = options.appVersion;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let disposed = false;

  async function run(event, repositoryId) {
    if (!isTrustedEvent(event)) return INVALID;
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return INVALID;
    if (typeof appVersion !== "string" || appVersion.length < 1 || appVersion.length > 40 || !/^[0-9A-Za-z.+-]+$/u.test(appVersion)) return UNAVAILABLE;
    if (!monitorOrigin || !authorizationToken || disposed) return UNAVAILABLE;
    try {
      const response = await fetchImpl(`${monitorOrigin}/internal/tasks/scorecard-read`, {
        method: "POST",
        cache: "no-store",
        headers: { [DESKTOP_AUTH_HEADER]: authorizationToken, "content-type": "application/json" },
        body: JSON.stringify({ repositoryId, payload: { appVersion } }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      const parsed = await response.json();
      if (!isPlainObject(parsed)) return UNAVAILABLE;
      if (parsed.ok === true) {
        if (!response.ok || !isPlainObject(parsed.scorecard) || !Number.isSafeInteger(parsed.scorecard.formula)) return UNAVAILABLE;
        const current = boundedSnapshot(parsed.scorecard.current);
        const baseline = parsed.scorecard.baseline === null ? null : boundedSnapshot(parsed.scorecard.baseline);
        if (!current || (parsed.scorecard.baseline !== null && !baseline)) return UNAVAILABLE;
        const scorecard = { formula: parsed.scorecard.formula, current, baseline };
        return Object.freeze({ ok: true, scorecard });
      }
      return parsed.ok === false && typeof parsed.error === "string" && MONITOR_ERRORS.has(parsed.error)
        ? Object.freeze({ ok: false, error: parsed.error }) : UNAVAILABLE;
    } catch { return UNAVAILABLE; }
  }

  return Object.freeze({ run, dispose() { disposed = true; } });
}

export function installTaskScorecardIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Task scorecards require ipcMain");
  ipcMain.removeHandler(TASK_SCORECARD_CHANNEL);
  const action = options.action || createTaskScorecard(options);
  ipcMain.handle(TASK_SCORECARD_CHANNEL, async (event, repositoryId) => {
    try { return await action.run(event, repositoryId); } catch { return UNAVAILABLE; }
  });
  return () => { ipcMain.removeHandler(TASK_SCORECARD_CHANNEL); action.dispose?.(); };
}
