import { parseProviderSessionId, sessionMessagePageSchema, sessionMessageRequestSchema } from "../providers/provider-contract.mjs";
import { TASK_BODY_LIMIT_BYTES, isPlainObject, readLimitedBody, writeActionResult } from "./task-routes.mjs";

export const SESSION_HISTORY_READ_PATH = "/internal/sessions/history-read";

const refuse = (response, error, status, options) => writeActionResult(response, status, { error }, options);

// Desktop main is the only caller. History text never crosses a GET route or the web server.
export async function serveSessionHistoryReadRoute({ request, response, requestUrl, runtime }) {
  if (requestUrl.pathname !== SESSION_HISTORY_READ_PATH) { refuse(response, "invalid", 404); return; }
  if (request.method !== "POST") { refuse(response, "invalid", 405); return; }
  if (requestUrl.search || Number(request.headers["content-length"] || 0) > TASK_BODY_LIMIT_BYTES) {
    refuse(response, "invalid", 400, { close: Number(request.headers["content-length"] || 0) > TASK_BODY_LIMIT_BYTES });
    return;
  }
  let raw;
  try { raw = await readLimitedBody(request, TASK_BODY_LIMIT_BYTES); }
  catch { refuse(response, "invalid", 400, { close: true }); return; }
  if (raw === null) { refuse(response, "invalid", 400, { close: true }); return; }
  let body;
  try { body = JSON.parse(raw.toString("utf8")); }
  catch { refuse(response, "invalid", 400); return; }
  if (!isPlainObject(body) || Object.keys(body).some((key) => !["sessionId", "cursor", "before", "limit"].includes(key))
    || typeof body.sessionId !== "string" || body.sessionId.length > 640 || !parseProviderSessionId(body.sessionId)) {
    refuse(response, "invalid", 400); return;
  }
  const pageRequest = {
    ...(Object.hasOwn(body, "cursor") ? { cursor: body.cursor } : {}),
    ...(Object.hasOwn(body, "before") ? { before: body.before } : {}),
    limit: body.limit === undefined ? 100 : body.limit,
  };
  if (!sessionMessageRequestSchema.safeParse(pageRequest).success) { refuse(response, "invalid", 400); return; }
  try {
    const page = await runtime.readSessionMessages?.(body.sessionId, pageRequest);
    if (page === null) { refuse(response, "not_found", 404); return; }
    if (!sessionMessagePageSchema.safeParse(page).success) {
      refuse(response, "unavailable", 503); return;
    }
    writeActionResult(response, 200, page);
  } catch {
    refuse(response, "unavailable", 503);
  }
}
