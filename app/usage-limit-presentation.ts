import type { ProviderSource, UsageLimits } from "../shared/monitor-contract";

export type UsageLimitFailureKind = "authentication_required" | "rate_limited" | "unavailable";

const FAILURE_KINDS = new Set<UsageLimitFailureKind>([
  "authentication_required",
  "rate_limited",
  "unavailable",
]);

/** Transitional string checks support cached responses from monitors without failureKind. */
export function usageLimitFailureKind(usageLimits: UsageLimits): UsageLimitFailureKind | null {
  if (usageLimits.failureKind && FAILURE_KINDS.has(usageLimits.failureKind)) return usageLimits.failureKind;
  if (/returned 401\b/i.test(usageLimits.error || "")) return "authentication_required";
  if (/returned 429\b/i.test(usageLimits.error || "")) return "rate_limited";
  return usageLimits.error ? "unavailable" : null;
}

export function usageLimitFailureMessage(source: ProviderSource, usageLimits: UsageLimits) {
  const failureKind = usageLimitFailureKind(usageLimits);
  if (failureKind === "authentication_required") {
    return `Sign in to ${source} again. Pomegr will retry automatically.`;
  }
  if (failureKind === "rate_limited") {
    return "The last usage check was rate-limited. Pomegr will retry automatically.";
  }
  if (failureKind === "unavailable") {
    return "The last usage check failed. Pomegr will retry automatically.";
  }
  return "Connecting to plan usage…";
}
