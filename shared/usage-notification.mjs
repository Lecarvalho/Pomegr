const WINDOWS = Object.freeze({ five_hour: "five-hour window", weekly: "weekly window", model_weekly: "model weekly window",
  primary: "primary window", secondary: "secondary window" });
export function isUsageNotificationKind(kind) {
  return ["usage_window_reset", "usage_capacity_restored", "usage_reset_available", "usage_authentication_required"].includes(kind);
}
export function usageNotificationPolicy(kind) {
  return kind === "usage_authentication_required"
    ? { category: "provider_news", severity: "warning", priority: 75 }
    : { category: "usage", severity: "info", priority: 60 };
}
/** A shared public-data allowlist, never a provider transition rule. */
export function normalizeUsageNotificationData(kind, provider, data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !["claude", "codex"].includes(provider)) return null;
  if (kind === "usage_authentication_required") return {};
  if (kind === "usage_reset_available") return provider === "codex" && Number.isSafeInteger(data.availableCount)
    && data.availableCount > 0 && data.availableCount <= 1000 ? { availableCount: data.availableCount } : null;
  if (!["usage_window_reset", "usage_capacity_restored"].includes(kind)
    || !(provider === "claude" ? ["five_hour", "weekly", "model_weekly"] : ["primary", "secondary"]).includes(data.window)
    || !(provider === "claude" ? ["local_observation", "provider_api"] : ["provider_api"]).includes(data.origin)
    || typeof data.otherExhausted !== "boolean") return null;
  return { window: data.window, origin: data.origin, otherExhausted: data.otherExhausted };
}
export function usageNotificationPayload(record) {
  const data = normalizeUsageNotificationData(record.kind, record.provider, record.data);
  if (!data) return null;
  if (record.kind === "usage_authentication_required") return {
    title: `${record.provider === "claude" ? "Claude Code" : "Codex"} usage sign-in needs attention`,
    body: "Account usage access still requires sign-in after a retry. Open Usage limits to review it.",
  };
  if (record.kind === "usage_reset_available") return {
    title: "Codex reset available",
    body: `${data.availableCount} earned ${data.availableCount === 1 ? "reset is" : "resets are"} available. Eligibility depends on Codex; no reset has been used.`,
  };
  const provider = record.provider === "claude" ? "Claude Code" : "Codex";
  return {
    title: `${record.provider === "codex" ? "A " : ""}${provider} ${WINDOWS[data.window]} ${record.kind === "usage_window_reset" ? "rolled over" : "has capacity again"}`,
    body: `${data.origin === "local_observation" ? "Observed in the local status line." : "Confirmed by a fresh usage observation."} ${data.otherExhausted ? "Another usage window remains exhausted." : "This describes this window only."}`,
  };
}
