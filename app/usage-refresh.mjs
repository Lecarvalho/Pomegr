export const USAGE_REFRESH_INTERVAL_MS = 60_000;

const CACHE_BOUNDARY_BUFFER_MS = 100;

export function usageRefreshDelay(attemptedAt, now = Date.now()) {
  if (!attemptedAt) return 0;
  const attemptedAtMs = Date.parse(attemptedAt);
  if (!Number.isFinite(attemptedAtMs)) return 0;

  const remaining = USAGE_REFRESH_INTERVAL_MS - (now - attemptedAtMs);
  if (remaining <= 0) return 0;
  return Math.min(USAGE_REFRESH_INTERVAL_MS, remaining + CACHE_BOUNDARY_BUFFER_MS);
}
