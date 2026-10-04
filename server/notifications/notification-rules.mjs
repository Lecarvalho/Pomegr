import { createHash } from "node:crypto";
import { USAGE_NOTIFICATION_RULE } from "./usage-notifications.mjs";
import { RELEASE_NOTIFICATION_RULE } from "./release-notifications.mjs";
import { MODEL_NOTIFICATION_RULE } from "./model-notifications.mjs";
import { inputNotificationTime } from "../normalize/input-notification-facts.mjs";

const SESSION_ID = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_TEXT = /^[^<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/u;
const PROVIDERS = new Set(["claude", "codex"]);
const ISSUE = new Set(["degraded", "outage", "maintenance"]);
const READINESS = new Set(["loading", "ready", "partial", "stale", "unavailable"]);

export function isSafeSessionId(value) { return typeof value === "string" && SESSION_ID.test(value); }
export function safeSessionTitle(value) {
  if (typeof value !== "string" || !SAFE_TEXT.test(value)) return "Session";
  return value.replace(/\s+/gu, " ").trim().slice(0, 96) || "Session";
}
export function opaqueNotificationId(kind, key, generation) {
  return createHash("sha256").update(`${kind}\0${key}\0${generation}`).digest("hex").slice(0, 32);
}
export function sourceReadiness(value) { return READINESS.has(value) ? value : "unavailable"; }

/** Each rule declares the policy consumed by the occurrence ledger. */
export const NOTIFICATION_RULES = Object.freeze([
  USAGE_NOTIFICATION_RULE,
  RELEASE_NOTIFICATION_RULE,
  MODEL_NOTIFICATION_RULE,
  Object.freeze({
    kind: "needs_input", source: "catalog", capability: "session_catalog", scope: "session",
    identity: "normalized_session_id", freshness: "ready_row", transition: "false_to_true",
    resolution: "explicit_ready_false", retentionDays: 30, category: "attention", severity: "warning",
    priority: 100, action: "open_session", delivery: "native_eligible",
    derive: deriveNeedsInput,
  }),
  Object.freeze({
    kind: "provider_incident", source: "providerStatus", capability: "public_provider_status", scope: "provider",
    identity: "provider", freshness: "fresh_ready", transition: "healthy_to_issue",
    resolution: "fresh_operational", retentionDays: 30, category: "provider_service", severity: "warning",
    priority: 70, action: "open_providers", delivery: "in_app",
    recovery: Object.freeze({ kind: "provider_recovery", severity: "info", data: Object.freeze({ status: "operational" }) }),
    derive: deriveProviderStatus,
  }),
]);

function validIso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }

/** Only explicit ready rows may clear an active session; absence is never false. */
export function deriveNeedsInput(facts) {
  if (!facts || sourceReadiness(facts.readiness) !== "ready" || !Array.isArray(facts.sessions)) return [];
  const seen = new Set();
  return facts.sessions.flatMap((row) => {
    if (!isSafeSessionId(row?.id) || seen.has(row.id)) return [];
    seen.add(row.id);
    if (row.detailReadiness === "unavailable" || (row.summaryReadiness !== undefined && row.summaryReadiness !== "ready")) return [];
    if (typeof row.isLive !== "boolean" || typeof row.needsInput !== "boolean") return [];
    const provider = row.id.split(":", 1)[0];
    if (row.provider !== provider) return [];
    return [{ key: row.id, active: row.isLive && row.needsInput, provider,
      at: inputNotificationTime(row) ?? (validIso(row.updatedAt) ? row.updatedAt : null),
      data: { sessionId: row.id, sessionTitle: safeSessionTitle(row.title) } }];
  });
}

/** Incident and recovery are one provider condition with one coalesced recovery transition. */
export function deriveProviderStatus(facts) {
  if (!facts || !Array.isArray(facts.providers)) return [];
  const seen = new Set();
  return facts.providers.flatMap((row) => {
    if (!PROVIDERS.has(row?.provider) || seen.has(row.provider)) return [];
    seen.add(row.provider);
    if (row.readiness !== "ready" || row.freshness !== "fresh" || !validIso(row.checkedAt)) return [];
    if (!ISSUE.has(row.status) && row.status !== "operational") return [];
    return [{ key: row.provider, active: ISSUE.has(row.status), provider: row.provider,
      observedAt: row.checkedAt,
      at: validIso(row.updatedAt) ? row.updatedAt : row.checkedAt,
      status: row.status,
      data: { status: row.status } }];
  });
}

/** Test-only producers use this same registration seam, without presentation changes. */
export function createNotificationRuleRegistry(rules = NOTIFICATION_RULES) {
  if (!Array.isArray(rules) || new Set(rules.map((rule) => rule.kind)).size !== rules.length) throw new TypeError("Invalid notification rules");
  for (const rule of rules) {
    if (typeof rule.kind !== "string" || typeof rule.source !== "string" || typeof rule.derive !== "function"
      || !Number.isInteger(rule.priority) || rule.priority < 0 || rule.priority > 100) throw new TypeError("Invalid notification rule");
  }
  return Object.freeze([...rules]);
}
