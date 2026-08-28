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

function sanitizedUsageError(error) {
  const message = error instanceof Error ? error.message : "";
  if (/credentials|oauth|enoent/i.test(message)) return "Claude usage credentials are unavailable.";
  if (/returned \d+/i.test(message)) return message.slice(0, 120);
  return "Claude usage refresh failed.";
}

function normalizedUsageLimits(body) {
  const normalized = (Array.isArray(body?.limits) ? body.limits : []).flatMap((limit) => {
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
 *   retryDelay?: (error: any, currentTime: number) => number,
 *   now?: () => number,
 * }} options
 */
export function createCoordinatedUsageLimitsReader({
  read,
  errorMessage = () => "Usage limits are temporarily unavailable.",
  retryDelay = () => USAGE_REFRESH_INTERVAL_MS,
  now = () => Date.now(),
}) {
  let cache = { value: null, nextAttemptAt: 0, pending: null };

  function cachedValue() {
    return cache.value || emptyUsageLimits();
  }

  function startRefresh() {
    let nextRetryDelay = USAGE_REFRESH_INTERVAL_MS;
    cache.pending = (async () => {
      try {
        const limits = await read();
        if (!Array.isArray(limits)) throw new TypeError("Usage limit reader returned an invalid value");
        const checkedAt = new Date(now()).toISOString();
        const value = { available: limits.length > 0, fetchedAt: checkedAt, attemptedAt: checkedAt, limits, error: "" };
        cache.value = value;
        return value;
      } catch (error) {
        nextRetryDelay = Math.max(USAGE_REFRESH_INTERVAL_MS, Number(retryDelay(error, now())) || 0);
        const attemptedAt = new Date(now()).toISOString();
        const safeError = String(errorMessage(error) || "Usage limits are temporarily unavailable.").slice(0, 120);
        const value = cache.value
          ? { ...cache.value, attemptedAt, error: safeError }
          : { ...emptyUsageLimits(safeError), attemptedAt };
        cache.value = value;
        return value;
      } finally {
        cache.nextAttemptAt = now() + nextRetryDelay;
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

  return { get };
}

export function createUsageLimitsCoordinator({ request, now = () => Date.now() }) {
  return createCoordinatedUsageLimitsReader({
    now,
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
    retryDelay(error, currentTime) {
      if (error?.status !== 429) return USAGE_REFRESH_INTERVAL_MS;
      return Math.max(
        USAGE_REFRESH_INTERVAL_MS,
        retryAfterDelay(error.retryAfter, currentTime) ?? 0,
      );
    },
  });
}
