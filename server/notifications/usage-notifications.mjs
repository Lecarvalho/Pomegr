import { createHash } from "node:crypto";

export const USAGE_NOTIFICATION_WINDOWS = Object.freeze([
  "five_hour", "weekly", "model_weekly", "primary", "secondary",
]);
export const USAGE_NOTIFICATION_KINDS = Object.freeze([
  "usage_window_reset", "usage_capacity_restored", "usage_reset_available", "usage_authentication_required",
]);
const WINDOW_IDS = { claude: { "current-session": "five_hour", "all-models": "weekly", "model-fable": "model_weekly" },
  codex: { "codex-primary": "primary", "codex-secondary": "secondary" } };
const MAX_AGE_MS = 5 * 60_000;
const HASH = /^[a-f0-9]{64}$/u;
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function exact(value, keys) { return value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }

/** Whole-record persistence validation of the bounded private comparison baseline. */
export function validUsageNotificationState(value, now) {
  if (!exact(value, ["claude", "codex", "authentication"]) || !exact(value.authentication, ["claude", "codex"])) return false;
  return ["claude", "codex"].every((provider) => {
    const auth = value.authentication[provider];
    if (auth !== null && (!exact(auth, ["scope", "attemptedAt", "retryAt", "notified"])
      || typeof auth.scope !== "string" || !HASH.test(auth.scope) || !iso(auth.attemptedAt)
      || Date.parse(auth.attemptedAt) > now || (auth.retryAt !== null && (!iso(auth.retryAt) || Date.parse(auth.retryAt) <= Date.parse(auth.attemptedAt)))
      || typeof auth.notified !== "boolean" || (auth.retryAt === null && auth.notified))) return false;
    const row = value[provider];
    if (row === null) return true;
    if (!exact(row, ["scope", "origin", "observedAt", "signature", "windows", "count"])
      || typeof row.scope !== "string" || !HASH.test(row.scope)
      || !(provider === "claude" ? ["provider_api", "local_observation"] : ["provider_api"]).includes(row.origin)
      || !iso(row.observedAt) || Date.parse(row.observedAt) > now + 60_000
      || typeof row.signature !== "string" || !HASH.test(row.signature)
      || !(row.count === null || (provider === "codex" && Number.isSafeInteger(row.count) && row.count >= 0 && row.count <= 1000))
      || !Array.isArray(row.windows) || row.windows.length > 16) return false;
    const allowed = Object.values(WINDOW_IDS[provider]);
    return new Set(row.windows.map((window) => window.key)).size === row.windows.length
      && row.windows.every((window) => exact(window, ["key", "window", "percent", "exhausted", "resetsAt"])
        && typeof window.key === "string" && (provider === "codex" ? HASH.test(window.key) : allowed.includes(window.key))
        && allowed.includes(window.window) && typeof window.percent === "number" && Number.isFinite(window.percent)
        && window.percent >= 0 && window.percent <= 100 && typeof window.exhausted === "boolean" && iso(window.resetsAt));
  });
}

/** Only committed, complete, fresh observations can change a comparison baseline.
 * Unknown evidence breaks comparisons; old/duplicate evidence cannot rewind them.
 * All source identity and window comparisons remain private to the monitor.
 */
export function reduceUsageNotifications(input, previous = null, now = Date.now()) {
  const state = structuredClone(previous || { claude: null, codex: null, authentication: { claude: null, codex: null } });
  const items = [];
  for (const provider of ["claude", "codex"]) {
    const row = input.providers?.find((candidate) => candidate.provider === provider);
    if (!row) continue; // A provider still in flight is not a failed observation.
    const usage = row.usageLimits;
    const source = row.comparison;
    const scope = typeof source?.sourceScope === "string" && HASH.test(source.sourceScope) ? source.sourceScope : null;
    const auth = state.authentication[provider];
    const attempt = usage?.attemptedAt;
    // Only an adapter-recognized authentication failure on a later completed
    // retry qualifies. Generic failures, cached attempts, and the clock do not.
    if (scope && iso(attempt) && Date.parse(attempt) <= now && now - Date.parse(attempt) <= MAX_AGE_MS) {
      if (!auth || auth.scope !== scope || Date.parse(attempt) > Date.parse(auth.attemptedAt)) {
        if (usage.failureKind === "authentication_required" && iso(usage.retryAt)
          && Date.parse(usage.retryAt) > Date.parse(attempt)) {
          const persistent = auth?.scope === scope && iso(auth.retryAt) && Date.parse(attempt) >= Date.parse(auth.retryAt);
          if (persistent && !auth.notified) items.push({ kind: "usage_authentication_required", key: `${provider}:authentication`,
            provider, active: true, at: attempt, data: {} });
          state.authentication[provider] = { scope, attemptedAt: attempt, retryAt: usage.retryAt,
            notified: persistent ? true : auth?.scope === scope && auth.notified === true };
        } else state.authentication[provider] = { scope, attemptedAt: attempt, retryAt: null, notified: false };
      }
    } else if (!scope || auth?.scope !== scope) state.authentication[provider] = null;
    const origin = usage?.origin || "provider_api";
    const old = state[provider];
    if (!scope || (old && (old.scope !== scope || old.origin !== origin))) state[provider] = null;
    const prior = state[provider];
    const observedAt = usage?.fetchedAt;
    if (prior && iso(observedAt) && Date.parse(observedAt) <= Date.parse(prior.observedAt)) {
      // Aging a previously accepted cached reading is not a new observation.
      // Keep it for a later fresh comparison; never emit from this old copy.
      if (usage.failureKind || usage.error || source?.complete !== true) state[provider] = { ...prior, windows: [], count: null };
      continue;
    }
    const limits = usage?.limits;
    const identities = provider === "claude" ? null : source?.windows;
    const complete = source?.complete === true && Array.isArray(limits) && limits.length > 0 && limits.length <= 16
      && new Set(limits.map((limit) => limit.id)).size === limits.length
      && limits.every((limit) => typeof limit.id === "string" && typeof limit.window === "string"
        && typeof limit.percent === "number" && Number.isFinite(limit.percent) && limit.percent >= 0 && limit.percent <= 100
        && typeof limit.active === "boolean" && iso(limit.resetsAt))
      && (provider !== "claude" || ["current-session", "all-models"].every((id) => limits.some((limit) => limit.id === id)))
      && (provider !== "codex" || (Array.isArray(identities) && identities.length === limits.length
        && new Set(identities.map((identity) => identity.key)).size === identities.length
        && limits.every((limit) => identities.some((identity) => identity.id === limit.id && typeof identity.key === "string"
          && HASH.test(identity.key) && ["primary", "secondary"].includes(identity.window)))));
    if (!scope || !complete || !iso(observedAt) || Date.parse(observedAt) > now
      || now - Date.parse(observedAt) > MAX_AGE_MS || usage.freshness === "stale"
      || usage.failureKind || usage.error || !usage.available
      || !(provider === "claude" ? ["provider_api", "local_observation"] : ["provider_api"]).includes(origin)) {
      if (prior) state[provider] = { ...prior, windows: [], count: null };
      continue;
    }
    const identityFor = (limit) => provider === "claude"
      ? { key: WINDOW_IDS.claude[limit.id], window: WINDOW_IDS.claude[limit.id] }
      : identities.find((identity) => identity.id === limit.id);
    const signature = hash(JSON.stringify(limits.map((limit) => [identityFor(limit)?.key || limit.id, limit.window]).sort()));
    const windows = limits.flatMap((limit) => {
      const identity = identityFor(limit);
      return identity?.key ? [{ key: identity.key, window: identity.window, percent: limit.percent, exhausted: limit.active || limit.percent >= 100, resetsAt: limit.resetsAt }] : [];
    });
    const credits = usage.resetCredits;
    const count = provider === "codex" && credits?.status === "supported" && credits.observedAt === observedAt
      && Number.isSafeInteger(credits.availableCount) && credits.availableCount >= 0 && credits.availableCount <= 1000
      ? credits.availableCount : null;
    const current = { scope, origin, observedAt, signature, windows, count };
    if (prior && prior.signature === signature) {
      for (const window of windows) {
        const before = prior.windows.find((entry) => entry.key === window.key);
        if (!before || Date.parse(window.resetsAt) <= Date.parse(observedAt)) continue;
        const rollover = Date.parse(before.resetsAt) <= Date.parse(observedAt)
          && Date.parse(before.resetsAt) > Date.parse(prior.observedAt)
          && Date.parse(window.resetsAt) > Date.parse(before.resetsAt);
        const recovery = before.exhausted && !window.exhausted && window.resetsAt === before.resetsAt;
        if (!rollover && !recovery) continue;
        items.push({ kind: rollover ? "usage_window_reset" : "usage_capacity_restored",
          key: `${provider}:${window.key}`, provider, active: true, at: observedAt,
          data: { window: window.window, origin, otherExhausted: limits.some((limit) => identityFor(limit)?.key !== window.key
            && (limit.active || limit.percent >= 100)) } });
      }
    }
    if (prior && count !== null && prior.count !== null && count > prior.count) {
      items.push({ kind: "usage_reset_available", key: `${provider}:credits`, provider, active: true, at: observedAt,
        data: { availableCount: count } });
    }
    state[provider] = current;
  }
  return { state, items };
}

export const USAGE_NOTIFICATION_RULE = Object.freeze({
  kind: "usage_window_reset", source: "usage", capability: "committed_usage", scope: "provider",
  identity: "comparable_observation", freshness: "complete_fresh", transition: "confirmed_usage_change",
  resolution: "occurrence", retentionDays: 30, category: "usage", severity: "info", priority: 60,
  action: "open_usage_limits", delivery: "native_eligible", occurrence: true,
  kinds: USAGE_NOTIFICATION_KINDS, derive: reduceUsageNotifications,
  policies: { usage_authentication_required: { category: "provider_news", severity: "warning", priority: 75, action: "open_usage_limits" } },
});
