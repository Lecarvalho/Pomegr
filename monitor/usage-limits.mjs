import { createEmptyUsageLimits } from "../shared/monitor-state.mjs";

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
    if (limit.kind === "session") return [{
      id: "current-session", label: "Current session", window: "5 hours",
      percent: Number(limit.percent || 0), resetsAt: limit.resets_at || null,
      severity: limit.severity || "normal", active: Boolean(limit.is_active),
    }];
    if (limit.kind === "weekly_all") return [{
      id: "all-models", label: "All models", window: "7 days",
      percent: Number(limit.percent || 0), resetsAt: limit.resets_at || null,
      severity: limit.severity || "normal", active: Boolean(limit.is_active),
    }];
    if (limit.kind === "weekly_scoped" && limit.scope?.model?.display_name) return [{
      id: `model-${String(limit.scope.model.display_name).toLowerCase()}`,
      label: String(limit.scope.model.display_name), window: "7 days",
      percent: Number(limit.percent || 0), resetsAt: limit.resets_at || null,
      severity: limit.severity || "normal", active: Boolean(limit.is_active),
    }];
    return [];
  });
  const wanted = ["current-session", "all-models", "model-fable"];
  return wanted.map((id) => normalized.find((limit) => limit.id === id)).filter(Boolean);
}

export function createUsageLimitsCoordinator({ request, now = () => Date.now() }) {
  let cache = { value: null, nextAttemptAt: 0, pending: null };

  function cachedValue() {
    return cache.value || emptyUsageLimits();
  }

  function startRefresh() {
    let retryDelay = USAGE_REFRESH_INTERVAL_MS;
    cache.pending = (async () => {
      try {
        const response = await request();
        if (!response.ok) {
          if (response.status === 429) {
            retryDelay = Math.max(
              USAGE_REFRESH_INTERVAL_MS,
              retryAfterDelay(response.headers.get("retry-after"), now()) ?? 0,
            );
          }
          throw new Error(`Anthropic usage endpoint returned ${response.status}`);
        }
        const limits = normalizedUsageLimits(await response.json());
        const checkedAt = new Date(now()).toISOString();
        const value = { available: limits.length > 0, fetchedAt: checkedAt, attemptedAt: checkedAt, limits, error: "" };
        cache.value = value;
        return value;
      } catch (error) {
        const attemptedAt = new Date(now()).toISOString();
        const errorMessage = sanitizedUsageError(error);
        const value = cache.value
          ? { ...cache.value, attemptedAt, error: errorMessage }
          : { ...emptyUsageLimits(errorMessage), attemptedAt };
        cache.value = value;
        return value;
      } finally {
        cache.nextAttemptAt = now() + retryDelay;
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
