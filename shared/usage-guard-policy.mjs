/** Deterministic advisory policy over normalized, already committed observations. */
export const USAGE_GUARD_DEFAULTS = Object.freeze({
  version: 1,
  mode: "advisory",
  checkIntervalSeconds: 60,
  warnAt: 70,
  handoffAt: 80,
  stopAt: 90,
  concurrencyReservePercent: 5,
  maxConcurrencyReservePercent: 15,
});
export const USAGE_GUARD_MAX_AGE_MS = 5 * 60_000;

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/** A missing or invalid configuration never enables an integration. */
export function normalizeUsageGuardConfig(input) {
  if (!record(input) || input.version !== 1 || !["advisory", "off"].includes(input.mode)
    || Object.keys(input).some((key) => !Object.hasOwn(USAGE_GUARD_DEFAULTS, key))) return null;
  const config = { ...USAGE_GUARD_DEFAULTS, ...input };
  if (!integer(config.checkIntervalSeconds, 60, 300)
    || !integer(config.warnAt, 20, 95) || !integer(config.handoffAt, 25, 98)
    || !integer(config.stopAt, 30, 100)
    || !(config.warnAt < config.handoffAt && config.handoffAt < config.stopAt)
    || !integer(config.concurrencyReservePercent, 0, 10)
    || !integer(config.maxConcurrencyReservePercent, 0, 20)
    || config.maxConcurrencyReservePercent >= config.warnAt) return null;
  return Object.freeze(config);
}

function timestamp(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function freshAt(value, now) {
  const at = timestamp(value);
  return Number.isFinite(at) && at <= now && now - at <= USAGE_GUARD_MAX_AGE_MS;
}

function localActivity(value, now) {
  if (!record(value) || value.scope !== "machine_provider" || value.readiness !== "ready"
    || !freshAt(value.observedAt, now)
    || ![value.liveSessions, value.workingSessions, value.unknownSessions].every((count) => integer(count, 0, 10_000))
    || value.workingSessions + value.unknownSessions > value.liveSessions
    || typeof value.truncated !== "boolean") return null;
  return {
    liveSessions: value.liveSessions,
    workingSessions: value.workingSessions,
    unknownSessions: value.unknownSessions,
    truncated: value.truncated,
  };
}

function validWindow(window, now) {
  return record(window) && typeof window.id === "string" && window.id.length <= 80
    && typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
    && window.usedPercent >= 0 && window.usedPercent <= 100
    && typeof window.active === "boolean"
    // A missing reset still permits a warning about an observed percentage.
    // A passed/malformed reset never turns an old window into a fresh allowance.
    && (window.resetsAt === null || timestamp(window.resetsAt) > now);
}

function windowKind(provider, id) {
  if (provider === "claude") {
    return id === "current-session" ? "five_hour" : id === "all-models" ? "weekly" : "model_specific";
  }
  return /-primary$/.test(id) ? "primary" : /-secondary$/.test(id) ? "secondary" : "model_specific";
}

/** Concurrency adjusts a reserve heuristic, never the account percentage or a token rate. */
export function evaluateUsageGuard(snapshot, provider, config, now = Date.now()) {
  const unavailable = (activity = null) => ({ stage: "unknown", activity, reserve: 0, usedPercent: null, kind: null, resetsAt: null });
  if (!["claude", "codex"].includes(provider) || !Number.isFinite(now)
    || snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.providers)) return unavailable();
  const matches = snapshot.providers.filter((entry) => entry?.provider === provider);
  if (matches.length !== 1) return unavailable();
  const entry = matches[0];
  const activity = localActivity(entry.localActivity, now);
  if (entry.readiness !== "ready" || entry.available !== true || entry.freshness !== "fresh"
    || !freshAt(entry.observedAt, now) || !Array.isArray(entry.windows)
    || entry.windows.length === 0 || entry.windows.length > 8) return unavailable(activity);

  const reserve = activity
    ? Math.min(config.maxConcurrencyReservePercent, Math.max(0, activity.workingSessions - 1) * config.concurrencyReservePercent)
    : 0;
  const thresholds = { warn: config.warnAt - reserve, handoff: config.handoffAt - reserve, stop: config.stopAt - reserve };
  const valid = entry.windows.filter((window) => validWindow(window, now));
  const common = valid.filter((window) => windowKind(provider, window.id) !== "model_specific");
  const incomplete = entry.windows.some((window) => !validWindow(window, now))
    || new Set(entry.windows.map((window) => window?.id)).size !== entry.windows.length
    || (provider === "claude" && !["current-session", "all-models"].every((id) => common.some((window) => window.id === id)));
  const limiting = common.sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (!limiting) return unavailable(activity);
  let stage = limiting.usedPercent >= thresholds.stop ? "stop"
    : limiting.usedPercent >= thresholds.handoff ? "handoff"
    : limiting.usedPercent >= thresholds.warn ? "warn" : "normal";
  // Preserve actionable high readings even when another window is missing.
  if (stage === "normal" && incomplete) return unavailable(activity);
  const scoped = valid.some((window) => windowKind(provider, window.id) === "model_specific" && window.usedPercent >= thresholds.warn);
  if (stage === "normal" && scoped) stage = "model_warning";
  return {
    stage, activity, reserve, thresholds, usedPercent: limiting.usedPercent,
    kind: windowKind(provider, limiting.id), resetsAt: limiting.resetsAt,
    observedAt: new Date(timestamp(entry.observedAt)).toISOString(), incomplete,
  };
}

export function usageGuardNotice(decision, provider) {
  const label = provider === "claude" ? "Claude" : "Codex";
  const activity = decision.activity;
  const concurrency = activity
    ? `This machine: ${activity.workingSessions} observed working ${label} sessions, ${activity.liveSessions} live, ${activity.unknownSessions} with unknown activity${activity.truncated ? " (bounded lower counts)" : ""}. Other machines and shared billing identity are not established.`
    : "Same-machine concurrency is unavailable or stale; do not assume only one session is working.";
  const checkpoint = "Follow the repository's existing handoff workflow, location, format, and privacy/version-control conventions. Preserve the objective, decisions and reasons, changed files, verification results, unresolved issues, and precise next steps. If no workflow is defined, leave a concise handoff in the conversation instead of creating a new directory. Pomegr does not read handoff contents.";
  if (decision.stage === "unknown") {
    return `[Pomegr usage guard] Usage evidence is unavailable, stale, or incomplete. Capacity is unknown, not zero usage. ${concurrency} Before lengthy work, check get_usage_limits if a newer observation would change your decision. Preserve a workspace handoff before a long break. No automatic stop is enabled.`;
  }
  if (decision.stage === "normal") return null;
  const window = { five_hour: "five-hour", weekly: "weekly", primary: "primary", secondary: "secondary" }[decision.kind] || "shared";
  const evidence = `${label} ${window} allowance: ${decision.usedPercent}% used, observed ${decision.observedAt}${decision.resetsAt ? `; reset ${new Date(timestamp(decision.resetsAt)).toISOString()}` : "; reset unknown"}.`;
  const reserve = decision.reserve ? ` A concurrency heuristic moved the warning/handoff/pause-request thresholds earlier by ${decision.reserve} percentage points; it does not predict consumption.` : "";
  const action = decision.stage === "stop"
    ? `Request: finish preserving the handoff and pause voluntarily. Do not expand scope or spawn more work. Resume only after a fresh usage observation supports it; a reset time alone is not confirmation. ${checkpoint}`
    : decision.stage === "handoff"
      ? `Request: save the handoff now, then prioritize only essential verification before pausing. Avoid new concurrent work. ${checkpoint}`
      : decision.stage === "model_warning"
        ? "A model-specific allowance is near its threshold. It may not apply to your current model: check applicability before proceeding or delegating. Prepare a handoff if it applies."
        : `Request: finish the current bounded step, avoid expanding scope or concurrency, and prepare a handoff before the next phase. ${checkpoint}`;
  return `[Pomegr usage guard: ${decision.stage}] ${evidence} ${concurrency}${reserve} ${decision.incomplete ? "Some usage windows remain unknown. " : ""}${action} Guidance is advisory; no agent was stopped. Cheaper agents on the same account still share its quota.`;
}
