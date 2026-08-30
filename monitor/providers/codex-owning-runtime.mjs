import { codexTimestamp, codexThreadRuntimeStatus, isSafeCodexSessionId } from "./codex-session-metadata.mjs";
import { CODEX_ROLLOUT_LIVE_WINDOW_MS } from "./codex-lifecycle-constants.mjs";

const READ_METHODS = new Map([
  ["thread/list", "listThreads"],
  ["thread/read", "readThread"],
  ["account/rateLimits/read", "readRateLimits"],
]);

export function appServerLiveness(runtimeStatus, observedAt) {
  const type = runtimeStatus?.type;
  if (!["active", "idle", "systemError"].includes(type)) return null;
  const flags = new Set(Array.isArray(runtimeStatus.activeFlags) ? runtimeStatus.activeFlags : []);
  const needsInput = type === "active" && (flags.has("waitingOnApproval") || flags.has("waitingOnUserInput"));
  return {
    live: true,
    status: needsInput ? "needs_input" : type === "systemError" ? "stopped" : type,
    needsInput,
    source: "owning_app_server",
    observedAt: codexTimestamp(observedAt) || new Date(0).toISOString(),
    evidence: "observed",
    freshness: "current",
  };
}

/** An explicitly supplied owning connection. Never starts/resumes a task or spawns a server. */
export function createCodexOwningRuntime(connection, { now = () => Date.now() } = {}) {
  const observations = new Map();
  let catalogFailed = false;
  function record(thread) {
    if (!isSafeCodexSessionId(thread?.id)) return;
    const key = JSON.stringify(codexThreadRuntimeStatus(thread.status));
    const previous = observations.get(thread.id);
    observations.delete(thread.id);
    observations.set(thread.id, {
      key,
      observedAt: previous?.key === key && !previous.failed ? previous.observedAt : new Date(now()).toISOString(),
      failed: false,
      confirmedAt: new Date(now()).toISOString(),
    });
    while (observations.size > 500) observations.delete(observations.keys().next().value);
  }
  return {
    async request(method, params) {
      const legacyMethod = READ_METHODS.get(method);
      if (!legacyMethod) throw new Error("Unsupported read-only Codex operation");
      if (!connection) return null;
      try {
        const response = typeof connection.request === "function"
          ? await connection.request(method, params)
          : typeof connection[legacyMethod] === "function" ? await connection[legacyMethod](params) : null;
        const value = response?.result ?? response;
        if (method === "thread/read") {
          if (!value?.thread || value.thread.id !== params.threadId) throw new Error("Unavailable Codex runtime");
          record(value.thread);
        }
        if (method === "thread/list") {
          const rows = Array.isArray(value) ? value : value?.data;
          if (!Array.isArray(rows)) throw new Error("Unavailable Codex runtime");
          rows.forEach(record);
          catalogFailed = false;
        }
        return response;
      } catch {
        if (method === "thread/list") catalogFailed = true;
        if (method === "thread/read") {
          observations.set(params.threadId, { failed: true });
          while (observations.size > 500) observations.delete(observations.keys().next().value);
        }
        throw new Error("Codex runtime observation unavailable");
      }
    },
    decorate(metadata) {
      const observation = observations.get(metadata.localId);
      const failed = observation?.failed || catalogFailed;
      const age = now() - Date.parse(observation?.confirmedAt || "");
      const expired = !Number.isFinite(age) || age < 0 || age > CODEX_ROLLOUT_LIVE_WINDOW_MS;
      return {
        ...metadata,
        runtimeStatus: !connection || failed || expired ? null : metadata.runtimeStatus,
        runtimeObservedAt: observation?.observedAt || metadata.updatedAt,
        runtimeConfirmedAt: observation?.confirmedAt || null,
        runtimeAvailability: !connection ? "source_not_integrated" : failed ? "source_unavailable" : expired ? "observation_gap" : null,
      };
    },
  };
}
