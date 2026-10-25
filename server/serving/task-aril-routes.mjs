const STATUS = Object.freeze({ invalid: 400, not_found: 404, limit: 409, conflict: 409, not_ready: 409, unsupported: 501 });
const json = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
};

export function serveArilActionRoute({ request, response, taskStore, repositoryId, action, payload }) {
  try {
    if (request.headers["x-pomegr-lan-gateway"] === "1") {
      if (action === "aril_settings_set" && payload.settings && typeof payload.settings === "object"
        && !Array.isArray(payload.settings) && Object.hasOwn(payload.settings, "pairedDevices")) {
        json(response, 400, { ok: false, error: "invalid" });
        return;
      }
      if (action !== "grant_stop" && taskStore?.readBoard(repositoryId)?.aril?.settings?.pairedDevices !== true) {
        json(response, 403, { ok: false, error: "unavailable" });
        return;
      }
    }
    if (typeof taskStore?.apply !== "function") {
      json(response, 503, { ok: false, error: "conflict" });
      return;
    }
    const result = taskStore.apply(repositoryId, action, payload);
    if (result?.ok === true) {
      if (action === "grant_start" && result.grant && typeof result.grant === "object") {
        json(response, 200, { ok: true, grant: result.grant });
        return;
      }
      if (action === "aril_settings_set" && result.settings && typeof result.settings === "object" && !Array.isArray(result.settings)) {
        json(response, 200, { ok: true, settings: result.settings });
        return;
      }
      if ((action === "aril_memory_add" || action === "aril_memory_update") && result.entry && typeof result.entry === "object" && !Array.isArray(result.entry)) {
        json(response, 200, { ok: true, entry: result.entry });
        return;
      }
      if (action === "aril_memory_remove" || action === "grant_stop") {
        json(response, 200, { ok: true });
        return;
      }
    }
    const error = Object.hasOwn(STATUS, result?.error) ? result.error : "conflict";
    json(response, STATUS[error], { ok: false, error });
  } catch {
    json(response, 503, { ok: false, error: "conflict" });
  }
}

const GRANT_STATUS = Object.freeze({ invalid: 400, not_found: 404, not_active: 409, unavailable: 503 });
const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const TASK_ID_PATTERN = /^T-[1-9][0-9]{0,8}$/u;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const rejected = (error) => ({ ok: false, error });

export function serveGrantRunner({ request, response, taskStore, resolveGateFacts, action, body }) {
  if (request.headers["x-pomegr-lan-gateway"] === "1") { json(response, 403, rejected("unavailable")); return; }
  const fields = action === "grant-next" ? [] : action === "grant-record" ? ["repositoryId", "taskId", "kind"]
    : action === "grant-end" ? ["repositoryId", "reason"] : action === "grant-end-all" ? ["reason"] : ["repositoryId"];
  if (!isPlainObject(body) || Object.keys(body).length !== fields.length || !fields.every((key) => Object.hasOwn(body, key))
    || (fields.includes("repositoryId") && (typeof body.repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(body.repositoryId)))
    || (action === "grant-record" && (typeof body.taskId !== "string" || !TASK_ID_PATTERN.test(body.taskId) || !["start", "review"].includes(body.kind)))
    || (action === "grant-end" && !["start_failed", "app_restart"].includes(body.reason))
    || (action === "grant-end-all" && body.reason !== "app_restart")) {
    json(response, 400, rejected("invalid")); return;
  }
  try {
    const result = action === "grant-end-all" ? taskStore?.endAllGrants?.({ reason: body.reason })
      : action === "grant-next" ? taskStore?.nextGrantSteps?.({ resolveGateFacts })
      : action === "grant-record" ? taskStore?.recordGrant?.(body.repositoryId, { taskId: body.taskId, kind: body.kind })
        : action === "grant-check" ? taskStore?.checkGrant?.(body.repositoryId) : taskStore?.endGrant?.(body.repositoryId, { reason: body.reason });
    if (result?.ok !== true) {
      const error = Object.hasOwn(GRANT_STATUS, result?.error) ? result.error : "unavailable";
      json(response, GRANT_STATUS[error], rejected(error)); return;
    }
    if (action === "grant-next") {
      if (!Array.isArray(result.steps)) throw new TypeError("Grant steps unavailable");
      const steps = result.steps.filter((entry) => isPlainObject(entry) && typeof entry.repositoryId === "string" && REPOSITORY_ID_PATTERN.test(entry.repositoryId)
        && typeof entry.taskId === "string" && TASK_ID_PATTERN.test(entry.taskId) && ["start", "review"].includes(entry.kind))
        .slice(0, 16).map(({ repositoryId, taskId, kind }) => ({ repositoryId, taskId, kind }));
      json(response, 200, { ok: true, steps });
    } else if (action === "grant-check") {
      if (typeof result.active !== "boolean") throw new TypeError("Grant state unavailable");
      json(response, 200, { ok: true, active: result.active });
    } else if (action === "grant-end-all") {
      if (!Number.isSafeInteger(result.ended) || result.ended < 0) throw new TypeError("Grant count unavailable");
      json(response, 200, { ok: true, ended: result.ended });
    } else json(response, 200, { ok: true });
  } catch { json(response, 503, rejected("unavailable")); }
}
