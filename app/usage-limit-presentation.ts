import type { ProviderSource, UsageLimits } from "../shared/monitor-contract";

export type UsageLimitFailureKind = "authentication_required" | "rate_limited" | "runtime_unavailable" | "unavailable";

const FAILURE_KINDS = new Set<UsageLimitFailureKind>([
  "authentication_required",
  "rate_limited",
  "runtime_unavailable",
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
  if (failureKind === "runtime_unavailable") {
    return source === "Codex" ? "Codex CLI required for usage limits" : "Provider setup required for usage limits";
  }
  if (failureKind === "authentication_required") {
    return source === "Claude Code"
      ? "Claude Code’s saved access was rejected. Pomegr will retry automatically; reconnect if this continues."
      : `Sign in to ${source} again. Pomegr will retry automatically.`;
  }
  if (failureKind === "rate_limited") {
    return "The last usage check was rate-limited. Pomegr will retry automatically.";
  }
  if (failureKind === "unavailable") {
    return "The last usage check failed. Pomegr will retry automatically.";
  }
  return "Connecting to plan usage…";
}

type UsageLimit = UsageLimits["limits"][number];

export type UsageLimitDisplay = {
  current: UsageLimit[];
  localFable: { kind: "retained"; limit: UsageLimit; fetchedAt: string } | { kind: "unavailable"; label: string; detail: string } | null;
};

/** Keeps a retained Fable API value supplemental to, rather than part of, a local observation. */
export function usageLimitDisplay(usageLimits: UsageLimits): UsageLimitDisplay {
  if (usageLimits.origin !== "local_observation") {
    return { current: usageLimits.limits, localFable: null };
  }
  const retained = usageLimits.retainedLimits?.limits.find((limit) => limit.id === "model-fable");
  const failure = usageLimitFailureKind(usageLimits);
  const pending = !usageLimits.attemptedAt && !failure;
  const detail = failure === "authentication_required" ? "Claude Code sign-in needs attention"
    : failure === "rate_limited" ? "Account check rate-limited; retrying automatically"
      : failure === "unavailable" ? "Account check failed; retrying automatically"
        : pending ? "Waiting for account check" : "Not reported by Claude";
  return {
    current: usageLimits.limits.filter((limit) => limit.id !== "model-fable"),
    localFable: retained && usageLimits.retainedLimits
      ? { kind: "retained", limit: retained, fetchedAt: usageLimits.retainedLimits.fetchedAt }
      : { kind: "unavailable", label: pending ? "Checking…" : "Unavailable", detail },
  };
}
