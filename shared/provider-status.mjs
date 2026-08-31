/** These are public service identities, never account or session metadata. */
export const PROVIDER_STATUS_STALE_MS = 15 * 60_000;

/** @type {ReadonlyArray<Readonly<{provider: import('./monitor-contract').ProviderId, source: import('./monitor-contract').ProviderSource, statusPageUrl: string}>>} */
export const PROVIDER_STATUS_SOURCES = Object.freeze([
  Object.freeze({ provider: "claude", source: "Claude Code", statusPageUrl: "https://status.claude.com/" }),
  Object.freeze({ provider: "codex", source: "Codex", statusPageUrl: "https://status.openai.com/" }),
]);

/** @returns {import('./monitor-contract').ProviderStatusSnapshot} */
export function createEmptyProviderStatusSnapshot(readiness = "loading") {
  return {
    revision: null,
    generatedAt: null,
    providers: PROVIDER_STATUS_SOURCES.map((source) => ({
      ...source,
      status: "unknown",
      readiness: readiness === "unavailable" ? "unavailable" : "loading",
      freshness: "unknown",
      checkedAt: null,
      updatedAt: null,
      incidentKey: null,
      incidents: [],
    })),
  };
}
