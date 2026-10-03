import { createCoordinatedUsageLimitsReader } from "../../normalize/usage-limits.mjs";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { withUsageNotificationSource } from "../../normalize/usage-notification-facts.mjs";
import { clampUsageLimitPercent, usageLimitSeverity } from "../../../shared/usage-limit-severity.mjs";

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
  const percent = clampUsageLimitPercent(window.usedPercent);
  const active = reached || percent >= 100;
  return {
    id: `${id}-${kind}`,
    label,
    window: windowLabel(window.windowDurationMins),
    percent,
    resetsAt: resetTimestamp(window.resetsAt),
    severity: usageLimitSeverity(percent),
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

export function normalizeCodexRateLimits(response, comparisonWindows = []) {
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
    const windows = [
      normalizedWindow(snapshot.primary, { id, label, kind: "primary", reached }),
      normalizedWindow(snapshot.secondary, { id, label, kind: "secondary", reached }),
    ].filter(Boolean);
    for (const window of windows) {
      const kind = window.id.endsWith("-primary") ? "primary" : "secondary";
      const identity = key || snapshot.limitId || "legacy";
      if (typeof identity !== "string" || identity.length > 256) continue;
      comparisonWindows.push({ id: window.id, window: kind,
        key: createHash("sha256").update(JSON.stringify([identity, kind])).digest("hex") });
    }
    return windows;
  }).slice(0, MAX_BUCKETS);
}

export function normalizeCodexResetCredits(response) {
  const count = responseValue(response)?.rateLimitResetCredits?.availableCount;
  return Number.isSafeInteger(count) && count >= 0 && count <= 1000
    ? { status: "supported", availableCount: count }
    : { status: "unknown", availableCount: null };
}

// Stat only, never credential contents. Keyring-only sources have no comparable
// local identity and remain unavailable to transition notifications.
export function codexUsageSourceScope(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile() || stat.size > 1_048_576n) return null;
    return createHash("sha256").update(`${file}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`).digest("hex");
  } catch { return null; }
}

function completeRateLimits(response, limits) {
  const value = responseValue(response);
  const raw = value?.rateLimitsByLimitId;
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > MAX_BUCKETS
    || Object.values(raw).some((bucket) => !bucket || typeof bucket !== "object" || Array.isArray(bucket)))) return false;
  const buckets = rateLimitBuckets(value);
  if (!buckets?.length) return false;
  let count = 0;
  for (const [, bucket] of buckets) {
    for (const window of [bucket.primary, bucket.secondary]) {
      if (window == null) continue;
      count += 1;
      if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)
        || window.usedPercent < 0 || window.usedPercent > 100 || !resetTimestamp(window.resetsAt)
        || !Number.isInteger(window.windowDurationMins) || window.windowDurationMins <= 0
        || window.windowDurationMins > MAX_WINDOW_MINUTES) return false;
    }
  }
  return count === limits.length && count > 0;
}

export function createCodexUsageLimitsCoordinator({ request, now = () => Date.now(), sourceScope = () => null }) {
  return createCoordinatedUsageLimitsReader({
    now,
    async read() {
      const scope = sourceScope();
      const response = await request();
      const windows = [];
      const limits = normalizeCodexRateLimits(response, windows);
      if (limits === null) throw new TypeError("Invalid Codex rate-limit response");
      return withUsageNotificationSource({ limits, resetCredits: normalizeCodexResetCredits(response) },
        scope && scope === sourceScope() ? scope : null,
        completeRateLimits(response, limits) && windows.length === limits.length, windows);
    },
    errorMessage: () => "Codex usage limits are temporarily unavailable.",
  });
}
