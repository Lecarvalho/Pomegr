const STATUS = Object.freeze({ invalid: 400, not_found: 404, limit: 409, conflict: 409, unsupported: 501 });
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
      if (taskStore?.readBoard(repositoryId)?.aril?.settings?.pairedDevices !== true) {
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
      if (action === "aril_settings_set" && result.settings && typeof result.settings === "object" && !Array.isArray(result.settings)) {
        json(response, 200, { ok: true, settings: result.settings });
        return;
      }
      if ((action === "aril_memory_add" || action === "aril_memory_update") && result.entry && typeof result.entry === "object" && !Array.isArray(result.entry)) {
        json(response, 200, { ok: true, entry: result.entry });
        return;
      }
      if (action === "aril_memory_remove") {
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
