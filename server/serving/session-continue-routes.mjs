import { parseProviderSessionId } from "../providers/provider-contract.mjs";
import { TASK_BODY_LIMIT_BYTES, isPlainObject, readLimitedBody, writeActionResult } from "./task-routes.mjs";

export const SESSION_CONTINUE_PLAN_PATH = "/internal/sessions/continue-plan";

// Only desktop main receives this private launch plan; no public projection includes its cwd.
export async function serveSessionContinuePlanRoute({ request, response, requestUrl, runtime }) {
  const refuse = (error, status, options) => writeActionResult(response, status, { error }, options);
  if (request.method !== "POST") { refuse("invalid", 405); return; }
  if (requestUrl.search || Number(request.headers["content-length"] || 0) > TASK_BODY_LIMIT_BYTES) {
    refuse("invalid", 400, { close: Number(request.headers["content-length"] || 0) > TASK_BODY_LIMIT_BYTES }); return;
  }
  let raw;
  try { raw = await readLimitedBody(request, TASK_BODY_LIMIT_BYTES); }
  catch { refuse("invalid", 400, { close: true }); return; }
  if (raw === null) { refuse("invalid", 400, { close: true }); return; }
  let body;
  try { body = JSON.parse(raw.toString("utf8")); }
  catch { refuse("invalid", 400); return; }
  if (!isPlainObject(body) || Object.keys(body).length !== 1 || !parseProviderSessionId(body.sessionId)) {
    refuse("invalid", 400); return;
  }
  try {
    const result = await runtime.readSessionContinuePlan?.(body.sessionId);
    if (result === null) { refuse("not_found", 404); return; }
    if (!result || ![true, false].includes(result.ok)) { refuse("unavailable", 503); return; }
    if (!result.ok) {
      if (!["live", "unknown", "folder_missing", "history_missing"].includes(result.reason)) { refuse("unavailable", 503); return; }
      writeActionResult(response, 200, { ok: false, reason: result.reason }); return;
    }
    const { provider, sessionId, localId, cwd, title } = result.plan;
    writeActionResult(response, 200, { ok: true, plan: { provider, sessionId, localId, cwd, title } });
  } catch { refuse("unavailable", 503); }
}
