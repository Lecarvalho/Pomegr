import { createEmptyUsageLimits } from "../shared/monitor-state.mjs";
import { clampUsageLimitPercent, usageLimitSeverity } from "../shared/usage-limit-severity.mjs";

export const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;

export function retryAfterDelay(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.max(0, Math.ceil(Number(trimmed) * 1000));
  const retryAt = Date.parse(trimmed);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : null;
}

function emptyUsageLimits(error = "") {
  return createEmptyUsageLimits(error ? { error } : {});
}

const USAGE_FAILURE_KINDS = new Set(["authentication_required", "rate_limited", "unavailable", "runtime_unavailable"]);

function safeTimestamp(value) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function sanitizedUsageError(error) {
  const message = error instanceof Error ? error.message : "";
  if (/credentials|oauth|enoent/i.test(message)) return "Claude usage credentials are unavailable.";
  if (/returned \d+/i.test(message)) return message.slice(0, 120);
  return "Claude usage refresh failed.";
}

function normalizedUsageLimits(body) {
  if (!Array.isArray(body?.limits)) throw new TypeError("Usage response has no complete limits array");
  const normalized = body.limits.flatMap((limit) => {
    const percent = clampUsageLimitPercent(limit.percent);
    if (limit.kind === "session") return [{
      id: "current-session", label: "Current session", window: "5 hours",
      percent, resetsAt: limit.resets_at || null,
      severity: usageLimitSeverity(percent), active: Boolean(limit.is_active),
    }];
    if (limit.kind === "weekly_all") return [{
      id: "all-models", label: "All models", window: "7 days",
      percent, resetsAt: limit.resets_at || null,
      severity: usageLimitSeverity(percent), active: Boolean(limit.is_active),
    }];
    if (limit.kind === "weekly_scoped" && limit.scope?.model?.display_name) return [{
      id: `model-${String(limit.scope.model.display_name).toLowerCase()}`,
      label: String(limit.scope.model.display_name), window: "7 days",
      percent, resetsAt: limit.resets_at || null,
      severity: usageLimitSeverity(percent), active: Boolean(limit.is_active),
    }];
    return [];
  });
  const wanted = ["current-session", "all-models", "model-fable"];
  return wanted.map((id) => normalized.find((limit) => limit.id === id)).filter(Boolean);
}

/**
 * @param {{
 *   read: () => Promise<any[]>,
 *   errorMessage?: (error: any) => string,
 *   failureKind?: (error: any) => "authentication_required" | "rate_limited" | "unavailable" | "runtime_unavailable",
 *   retryDelay?: (error: any, currentTime: number) => number,
 *   now?: () => number,
 *   initialState?: { value: any, nextAttemptAt: number } | null,
 *   onUpdate?: (value: any, nextAttemptAt: number) => void,
 * }} options
 */
export function createCoordinatedUsageLimitsReader({
  read,
  errorMessage = () => "Usage limits are temporarily unavailable.",
  failureKind = () => "unavailable",
  retryDelay = () => USAGE_REFRESH_INTERVAL_MS,
  now = () => Date.now(),
  initialState = null,
  onUpdate = () => {},
}) {
  const cache = { value: initialState?.value ?? null, nextAttemptAt: initialState?.nextAttemptAt ?? 0, pending: null };

  function cachedValue() {
    return cache.value || emptyUsageLimits();
  }

  function startRefresh() {
    let nextAttemptAt = 0;
    cache.pending = (async () => {
      try {
        const limits = await read();
        if (!Array.isArray(limits)) throw new TypeError("Usage limit reader returned an invalid value");
        const checkedAtMs = now();
        const checkedAt = new Date(checkedAtMs).toISOString();
        nextAttemptAt = checkedAtMs + USAGE_REFRESH_INTERVAL_MS;
        const value = {
          available: limits.length > 0,
          fetchedAt: checkedAt,
          attemptedAt: checkedAt,
          failureKind: null,
          retryAt: null,
          limits,
          error: "",
        };
        cache.value = value;
        return value;
      } catch (error) {
        const attemptedAtMs = now();
        const nextRetryDelay = Math.max(USAGE_REFRESH_INTERVAL_MS, Number(retryDelay(error, attemptedAtMs)) || 0);
        nextAttemptAt = attemptedAtMs + nextRetryDelay;
        const attemptedAt = new Date(attemptedAtMs).toISOString();
        const safeError = String(errorMessage(error) || "Usage limits are temporarily unavailable.").slice(0, 120);
        let classifiedFailure;
        try { classifiedFailure = failureKind(error); }
        catch { classifiedFailure = "unavailable"; }
        const safeFailureKind = USAGE_FAILURE_KINDS.has(classifiedFailure) ? classifiedFailure : "unavailable";
        const value = cache.value
          ? { ...cache.value, attemptedAt, failureKind: safeFailureKind, retryAt: safeTimestamp(nextAttemptAt), error: safeError }
          : { ...emptyUsageLimits(safeError), attemptedAt, failureKind: safeFailureKind, retryAt: safeTimestamp(nextAttemptAt) };
        cache.value = value;
        return value;
      } finally {
        cache.nextAttemptAt = nextAttemptAt || now() + USAGE_REFRESH_INTERVAL_MS;
        try { onUpdate(cache.value, cache.nextAttemptAt); } catch { /* Persistence must not break live observations. */ }
        cache.pending = null;
      }
    })();
    return cache.pending;
  }

  async function get() {
    if (cache.pending) return cache.value || cache.pending;
    if (now() < cache.nextAttemptAt) return cachedValue();
    const pending = startRefresh();
    return cache.value || pending;
  }

  // Observation adapters can inspect an already completed check without acquiring data.
  return { get, peek: () => cache.value };
}

export function createUsageLimitsCoordinator({ request, now = () => Date.now(), initialState = null, onUpdate = undefined }) {
  return createCoordinatedUsageLimitsReader({
    now,
    initialState,
    onUpdate,
    async read() {
      const response = await request();
      if (!response.ok) {
        const error = Object.assign(new Error(`Anthropic usage endpoint returned ${response.status}`), {
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
        });
        throw error;
      }
      return normalizedUsageLimits(await response.json());
    },
    errorMessage: sanitizedUsageError,
    failureKind(error) {
      if (error?.status === 401) return "authentication_required";
      if (error?.status === 429) return "rate_limited";
      return "unavailable";
    },
    retryDelay(error, currentTime) {
      if (error?.status !== 429) return USAGE_REFRESH_INTERVAL_MS;
      return Math.max(
        USAGE_REFRESH_INTERVAL_MS,
        retryAfterDelay(error.retryAfter, currentTime) ?? 0,
      );
    },
  });
}
