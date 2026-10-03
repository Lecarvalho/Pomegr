export const CLAUDE_MODEL_SOURCE_CAPABILITIES = Object.freeze({
  clientCatalog: "unavailable",
  accountEntitlement: "unavailable",
  announcement: "unavailable",
  deprecation: "unavailable",
});

/** No documented read-only Claude Code subscription model catalog is used. */
export function createClaudeModelObservation() {
  return {
    capabilities: CLAUDE_MODEL_SOURCE_CAPABILITIES,
    async read() { return { provider: "claude", status: "unavailable", complete: false,
      observedAt: null, sourceScope: null, models: [] }; },
    stop() {},
  };
}
