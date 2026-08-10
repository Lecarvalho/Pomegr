/** @typedef {import("./monitor-contract").MonitorState} MonitorState */
/** @typedef {import("./monitor-contract").ProviderSource} ProviderSource */
/** @typedef {import("./monitor-contract").UsageLimits} UsageLimits */

/**
 * @param {{ error?: string }} [options]
 * @returns {UsageLimits}
 */
export function createEmptyUsageLimits(options = {}) {
  return { available: false, fetchedAt: null, attemptedAt: null, limits: [], error: options.error ?? "" };
}

/**
 * @param {{
 *   connected?: boolean,
 *   source?: ProviderSource,
 *   view?: "live" | "history",
 *   usageLimits?: UsageLimits,
 *   error?: string,
 * }} [options]
 * @returns {MonitorState}
 */
export function createEmptyMonitorState(options = {}) {
  const state = {
    connected: options.connected ?? false,
    source: options.source ?? "Claude Code",
    view: options.view ?? "live",
    session: null,
    score: 100,
    metrics: {
      agents: 0,
      activeAgents: 0,
      toolCalls: 0,
      repeatedCalls: 0,
      tokens: {
        allAgents: 0,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        contextGrowthTimeline: { bucketMs: 0, buckets: [] },
      },
    },
    agents: [],
    toolPatterns: [],
    loops: [],
    activity: [],
    executionTasks: [],
    planTasks: [],
    insights: [],
    usageLimits: options.usageLimits ?? createEmptyUsageLimits(),
  };
  return options.error ? { ...state, error: options.error } : state;
}
