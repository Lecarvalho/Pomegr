import { TASK_BODY_LIMIT_BYTES, isPlainObject, readLimitedBody, writeActionResult } from "./task-routes.mjs";

// Feature and scorecard reads (desktop token only; the request handler applies the private-action gate).
export const TASK_FEATURE_ACTIONS = Object.freeze(["feature-read", "scorecard-read"]);

const PREFIX = "/internal/tasks/";
const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const FEATURE_ID_PATTERN = /^feat-[0-9a-f]{12}$/u;
const DESCRIPTION_LIMIT = 2000;
const APP_VERSION_LIMIT = 40;
const rejected = (error) => ({ ok: false, error });
const refuse = (response, error, status, options) => writeActionResult(response, status, rejected(error), options);
const bounded = (value, limit) => (typeof value === "string" && value.length > 0 && value.length <= limit ? value : null);

// `POST /internal/tasks/feature-read`: `{ repositoryId, payload: { id } }` answers `{ ok: true, feature: { description, appVersion } }`.
// `POST /internal/tasks/scorecard-read`: `{ repositoryId, payload: { appVersion } }` upserts a snapshot and answers `{ ok: true, scorecard }`.
// Only the desktop main process calls it; no Next route proxies it.
export async function serveTaskFeatureRoute({ request, response, requestUrl, taskStore }) {
  const action = requestUrl.pathname.slice(PREFIX.length);
  if (!TASK_FEATURE_ACTIONS.includes(action)) { refuse(response, "invalid", 404); return; }
  try {
    if (typeof taskStore?.[action === "scorecard-read" ? "readScorecard" : "readFeature"] !== "function") { refuse(response, "unavailable", 503, { close: true }); return; }
    if (requestUrl.search) { refuse(response, "invalid", 400); return; }
    if (Number(request.headers["content-length"] || 0) > TASK_BODY_LIMIT_BYTES) { refuse(response, "invalid", 413, { close: true }); return; }
    let raw;
    try {
      raw = await readLimitedBody(request, TASK_BODY_LIMIT_BYTES);
    } catch {
      refuse(response, "invalid", 400, { close: true });
      return;
    }
    if (raw === null) { refuse(response, "invalid", 413, { close: true }); return; }
    let body;
    try { body = JSON.parse(raw.toString("utf8")); } catch { refuse(response, "invalid", 400); return; }
    const valid = isPlainObject(body) && Object.keys(body).every((key) => key === "repositoryId" || key === "payload")
      && typeof body.repositoryId === "string" && REPOSITORY_ID_PATTERN.test(body.repositoryId)
      && isPlainObject(body.payload) && Object.keys(body.payload).length === 1;
    if (!valid) { refuse(response, "invalid", 400); return; }
    if (action === "scorecard-read") {
      const appVersion = bounded(body.payload.appVersion, APP_VERSION_LIMIT);
      if (appVersion === null || !/^[0-9A-Za-z.+-]+$/u.test(appVersion)) { refuse(response, "invalid", 400); return; }
      const scorecard = taskStore.readScorecard(body.repositoryId, appVersion);
      if (scorecard === null || typeof scorecard !== "object") { refuse(response, "unavailable", 503); return; }
      writeActionResult(response, 200, { ok: true, scorecard });
      return;
    }
    if (typeof body.payload.id !== "string" || !FEATURE_ID_PATTERN.test(body.payload.id)) { refuse(response, "invalid", 400); return; }
    const feature = taskStore.readFeature(body.repositoryId, body.payload.id);
    if (!isPlainObject(feature) || feature.id !== body.payload.id) { refuse(response, "not_found", 404); return; }
    writeActionResult(response, 200, { ok: true, feature: { description: bounded(feature.description, DESCRIPTION_LIMIT), appVersion: bounded(feature.appVersion, APP_VERSION_LIMIT) } });
  } catch {
    refuse(response, "unavailable", 503);
  }
}
