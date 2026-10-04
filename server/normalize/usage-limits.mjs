import { createEmptyUsageLimits } from "../../shared/monitor-state.mjs";
import { clampUsageLimitPercent, usageLimitSeverity } from "../../shared/usage-limit-severity.mjs";
import { isoTimestampFromDateInput } from "./primitives.mjs";
import { copyUsageNotificationSource } from "./usage-notification-facts.mjs";

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

function sanitizedUsageError(error) {
  const message = error instanceof Error ? error.message : "";
  if (/credentials|oauth|enoent/i.test(message)) return "Claude usage credentials are unavailable.";
  if (/returned \d+/i.test(message)) return message.slice(0, 120);
  return "Claude usage refresh failed.";
}

function normalizedUsageLimits(body) {
  if (!Array.isArray(body?.limits)) throw new TypeError("Usage response has no complete limits array");
  const normalized = body.limits.flatMap((limit) => {
    if (["session", "weekly_all", "weekly_scoped"].includes(limit.kind)
      && (typeof limit.percent !== "number" || !Number.isFinite(limit.percent) || limit.percent < 0 || limit.percent > 100)) {
      throw new TypeError("Invalid usage percentage");
    }
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
 *   read: () => Promise<any[] | { limits: any[], resetCredits?: any }>,
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
        const result = await read();
        const limits = Array.isArray(result) ? result : result?.limits;
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
          ...(!Array.isArray(result) && result?.resetCredits ? { resetCredits: {
            ...result.resetCredits, observedAt: checkedAt,
          } } : {}),
        };
        copyUsageNotificationSource(result, value);
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
          ? { ...cache.value, attemptedAt, failureKind: safeFailureKind, retryAt: isoTimestampFromDateInput(nextAttemptAt), error: safeError }
          : { ...emptyUsageLimits(safeError), attemptedAt, failureKind: safeFailureKind, retryAt: isoTimestampFromDateInput(nextAttemptAt) };
        if (cache.value) copyUsageNotificationSource(cache.value, value);
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

  async function get({ afterSignIn = false } = {}) {
    // A local feed may have returned while an older account request was still
    // pending. Its rejection must not consume the native recovery trigger.
    if (afterSignIn && cache.pending) await cache.pending;
    if (cache.pending) return afterSignIn ? cache.pending : cache.value || cache.pending;
    if (afterSignIn && (cache.value?.failureKind === "authentication_required"
      || cache.value?.error === "Claude usage credentials are unavailable.")) {
      return startRefresh();
    }
    if (now() < cache.nextAttemptAt) return cachedValue();
    const pending = startRefresh();
    return afterSignIn ? pending : cache.value || pending;
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
