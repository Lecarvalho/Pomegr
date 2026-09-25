const CACHE_LIFETIMES = new Set(["5m", "1h", "mixed", "30m+"]);

/**
 * Bounded catalog evidence for the sessions page cache indication: the primary
 * agent's newest retained request with cache activity and its allowlisted
 * lifetime. The browser derives nearing/elapsed states from its live clock.
 * Historical rows keep their recorded evidence because a resumed session
 * still depends on that cache; rows without a primary agent carry none.
 */
export function projectSessionCacheTiming(agents, requestSnapshots) {
  if (requestSnapshots?.status !== "ready" || !Array.isArray(requestSnapshots.items)) return null;
  if (!Array.isArray(agents) || !agents.some((agent) => agent?.id === "primary")) return null;
  let newest = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const item of requestSnapshots.items) {
    if (item?.agentId !== "primary") continue;
    if (!(item.cacheReadTokens > 0 || item.cacheWriteTokens > 0)) continue;
    const observedAt = Date.parse(item.observedAt);
    if (!Number.isFinite(observedAt) || observedAt < newestAt) continue;
    newest = item;
    newestAt = observedAt;
  }
  if (!newest) return null;
  return {
    lastCacheTouchAt: new Date(newestAt).toISOString(),
    cacheLifetime: CACHE_LIFETIMES.has(newest.cacheLifetime) ? newest.cacheLifetime : null,
  };
}
