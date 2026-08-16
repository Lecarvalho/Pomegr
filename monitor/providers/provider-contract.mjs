/** @typedef {import("./provider-contract").ProviderAdapter} ProviderAdapter */
/** @typedef {import("./provider-contract").ProviderCapabilities} ProviderCapabilities */
/** @typedef {import("../../shared/monitor-contract").ProviderId} ProviderId */
/** @typedef {import("../../shared/monitor-contract").ProviderSource} ProviderSource */

export const PROVIDER_IDS = Object.freeze(["claude", "codex"]);

export const PROVIDER_SOURCES = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
});

export const PROVIDER_CAPABILITY_KEYS = Object.freeze([
  "approvalMode",
  "automaticCompactions",
  "contextMachinery",
  "estimatedCost",
  "liveSessions",
  "needsInput",
  "planTasks",
  "cacheWriteUsage",
  "cacheUsageClassification",
  "sessionSummary",
  "signals",
  "usageLimits",
  "workflows",
]);

const providerIdSet = new Set(PROVIDER_IDS);
const capabilityKeySet = new Set(PROVIDER_CAPABILITY_KEYS);
const SAFE_LOCAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** @param {unknown} value @returns {value is ProviderId} */
export function isProviderId(value) {
  return typeof value === "string" && providerIdSet.has(value);
}

/** @param {ProviderId} providerId @returns {ProviderSource} */
export function providerSource(providerId) {
  if (!isProviderId(providerId)) throw new TypeError(`Unknown provider: ${String(providerId)}`);
  return PROVIDER_SOURCES[providerId];
}

/**
 * Optional capabilities are deny-by-default so adding a provider never causes
 * the UI to imply support for metadata the adapter did not explicitly supply.
 *
 * @param {Partial<ProviderCapabilities>} [overrides]
 * @returns {Readonly<ProviderCapabilities>}
 */
export function createProviderCapabilities(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Provider capabilities must be an object");
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!capabilityKeySet.has(key)) throw new TypeError(`Unknown provider capability: ${key}`);
    if (typeof value !== "boolean") throw new TypeError(`Provider capability ${key} must be boolean`);
  }
  return Object.freeze(Object.fromEntries(PROVIDER_CAPABILITY_KEYS.map((key) => [key, overrides[key] ?? false])));
}

/**
 * Create the opaque browser/API identifier for a provider-local session.
 * Local IDs are data identifiers only; path separators, traversal, and extra
 * namespace delimiters are rejected.
 *
 * @param {ProviderId} providerId
 * @param {string} localSessionId
 */
export function qualifyProviderSessionId(providerId, localSessionId) {
  if (!isProviderId(providerId)) throw new TypeError(`Unknown provider: ${String(providerId)}`);
  if (typeof localSessionId !== "string" || !SAFE_LOCAL_SESSION_ID.test(localSessionId)) {
    throw new TypeError("Unsafe provider-local session ID");
  }
  return `${providerId}:${localSessionId}`;
}

/**
 * Parse an opaque browser/API identifier without resolving or accepting paths.
 *
 * @param {unknown} value
 * @returns {{ providerId: ProviderId, localSessionId: string } | null}
 */
export function parseProviderSessionId(value) {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(":");
  if (separator < 1 || separator !== value.lastIndexOf(":")) return null;
  const providerId = value.slice(0, separator);
  const localSessionId = value.slice(separator + 1);
  return isProviderId(providerId) && SAFE_LOCAL_SESSION_ID.test(localSessionId)
    ? { providerId, localSessionId }
    : null;
}

/**
 * Validate and freeze an adapter declaration. This establishes the runtime
 * side of the TypeScript/JSDoc contract before providers are registered.
 *
 * @param {ProviderAdapter} adapter
 * @returns {Readonly<ProviderAdapter>}
 */
export function defineProvider(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("Provider adapter must be an object");
  if (!isProviderId(adapter.id)) throw new TypeError(`Unknown provider: ${String(adapter.id)}`);
  const expectedSource = providerSource(adapter.id);
  if (adapter.source !== expectedSource) throw new TypeError(`Provider ${adapter.id} source must be ${expectedSource}`);
  if (typeof adapter.listSessions !== "function") throw new TypeError("Provider adapter must implement listSessions");
  if (typeof adapter.readSession !== "function") throw new TypeError("Provider adapter must implement readSession");
  if (adapter.unavailableMessage !== undefined && typeof adapter.unavailableMessage !== "function") {
    throw new TypeError("Provider unavailableMessage must be a function");
  }
  if (adapter.watchTargets !== undefined && (!Array.isArray(adapter.watchTargets)
    || adapter.watchTargets.some((target) => typeof target !== "string" || !target))) {
    throw new TypeError("Provider watchTargets must contain non-empty strings");
  }
  const capabilities = createProviderCapabilities(adapter.capabilities);
  if (capabilities.usageLimits && typeof adapter.readUsageLimits !== "function") {
    throw new TypeError("Provider with usageLimits capability must implement readUsageLimits");
  }
  const watchTargets = adapter.watchTargets ? Object.freeze([...adapter.watchTargets]) : undefined;
  return Object.freeze({ ...adapter, capabilities, ...(watchTargets ? { watchTargets } : {}) });
}
