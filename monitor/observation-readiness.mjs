export const READINESS_LOADING = "loading";
export const READINESS_READY = "ready";
export const READINESS_UNAVAILABLE = "unavailable";

const READINESS_VALUES = new Set([
  READINESS_LOADING,
  READINESS_READY,
  READINESS_UNAVAILABLE,
]);

export function isReadiness(value) {
  return READINESS_VALUES.has(value);
}

export function createSessionReadiness(value = READINESS_LOADING, overrides = {}) {
  if (!isReadiness(value)) throw new TypeError("Invalid session readiness");
  const readiness = {
    core: value,
    agentEvidence: value,
    contextEvidence: value,
    activityEvidence: value,
    repository: value,
    resources: value,
    usageLimits: value,
    ...overrides,
  };
  for (const state of Object.values(readiness)) {
    if (!isReadiness(state)) throw new TypeError("Invalid session readiness region");
  }
  return Object.freeze(readiness);
}

export function createHomeReadiness(options = {}) {
  const catalog = options.catalog || READINESS_LOADING;
  if (!isReadiness(catalog)) throw new TypeError("Invalid Home catalog readiness");
  const maps = {};
  for (const key of ["providerLimits", "limitActivity", "sessionSummaries"]) {
    const source = options[key] || {};
    const entries = Object.entries(source);
    if (entries.some(([, value]) => !isReadiness(value))) throw new TypeError(`Invalid Home ${key} readiness`);
    maps[key] = Object.freeze(Object.fromEntries(entries));
  }
  return Object.freeze({ catalog, ...maps });
}

export function hasLoadingReadiness(readiness) {
  if (!readiness || typeof readiness !== "object") return false;
  return Object.values(readiness).some((value) => value === READINESS_LOADING
    || (value && typeof value === "object" && Object.values(value).includes(READINESS_LOADING)));
}
