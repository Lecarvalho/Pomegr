const CACHE_LIFETIMES = new Set(["5m", "1h", "mixed", "30m+"]);

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
