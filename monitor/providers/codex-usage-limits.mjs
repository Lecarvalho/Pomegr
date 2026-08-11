import { createCoordinatedUsageLimitsReader } from "../usage-limits.mjs";

const MAX_BUCKETS = 12;
const MAX_WINDOW_MINUTES = 366 * 24 * 60;
const MAX_RESET_SECONDS = Date.parse("2100-01-01T00:00:00.000Z") / 1000;
const SAFE_LIMIT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i;
const SAFE_LIMIT_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._()/-]{0,62}[\p{L}\p{N})])?$/u;
const PRIVATE_LABEL_HINT = /account|auth|credit|email|entitlement|organi[sz]ation|secret|tenant|token|user|workspace/i;
const REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

function responseValue(response) {
  return response?.result ?? response;
}

function safeIdentifier(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return SAFE_LIMIT_ID.test(trimmed) && !PRIVATE_LABEL_HINT.test(trimmed) ? trimmed.toLowerCase() : "";
}

function safeLabel(value) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  return SAFE_LIMIT_NAME.test(normalized) && !PRIVATE_LABEL_HINT.test(normalized) ? normalized : "";
}

function windowLabel(minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > MAX_WINDOW_MINUTES) return "Usage window";
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function resetTimestamp(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_RESET_SECONDS) return null;
  const timestamp = new Date(value * 1000);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function normalizedWindow(window, { id, label, kind, reached }) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return null;
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return null;
  const percent = Math.min(100, Math.max(0, window.usedPercent));
  const active = reached || percent >= 100;
  return {
    id: `${id}-${kind}`,
    label,
    window: windowLabel(window.windowDurationMins),
    percent,
    resetsAt: resetTimestamp(window.resetsAt),
    severity: active ? "danger" : percent >= 80 ? "warning" : "normal",
    active,
  };
}

function rateLimitBuckets(value) {
  const byId = value?.rateLimitsByLimitId;
  if (byId && typeof byId === "object" && !Array.isArray(byId)) {
    const entries = Object.entries(byId).filter(([, snapshot]) => (
      snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ));
    if (entries.length) return entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).slice(0, MAX_BUCKETS);
  }
  return value?.rateLimits && typeof value.rateLimits === "object" && !Array.isArray(value.rateLimits)
    ? [["", value.rateLimits]]
    : null;
}

export function normalizeCodexRateLimits(response) {
  const value = responseValue(response);
  const buckets = rateLimitBuckets(value);
  if (buckets === null) return null;
  const usedIds = new Set();
  return buckets.flatMap(([key, snapshot], index) => {
    const baseId = safeIdentifier(key) || safeIdentifier(snapshot.limitId) || `usage-${index + 1}`;
    const id = usedIds.has(baseId) ? `${baseId}-${index + 1}` : baseId;
    usedIds.add(id);
    const label = safeLabel(snapshot.limitName) || (id === "codex" ? "Codex" : `Usage bucket ${index + 1}`);
    const reached = REACHED_TYPES.has(snapshot.rateLimitReachedType);
    return [
      normalizedWindow(snapshot.primary, { id, label, kind: "primary", reached }),
      normalizedWindow(snapshot.secondary, { id, label, kind: "secondary", reached }),
    ].filter(Boolean);
  });
}

export function createCodexUsageLimitsCoordinator({ request, now = () => Date.now() }) {
  return createCoordinatedUsageLimitsReader({
    now,
    async read() {
      const limits = normalizeCodexRateLimits(await request());
      if (limits === null) throw new TypeError("Invalid Codex rate-limit response");
      return limits;
    },
    errorMessage: () => "Codex usage limits are temporarily unavailable.",
  });
}
