import crypto from "node:crypto";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_COMPONENTS = 128;
const MAX_SOURCE_INCIDENTS = 64;
const MAX_INCIDENTS = 8;
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_LABEL_LENGTH = 160;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const INCIDENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const PROVIDERS = Object.freeze({
  codex: Object.freeze({
    origin: "https://status.openai.com",
    summaryUrl: "https://status.openai.com/api/v2/summary.json",
    // The public summary has no incident collection. The Statuspage-style unresolved
    // endpoint is unavailable, while incidents.json is a large historical feed
    // without affected-component data. Components remain the authoritative,
    // conservative live signal for Codex until an equivalent live feed exists.
    components: new Set([
      "01KMP3KP5MGE23B80K1EK4S8PV", // Codex API
      "01KMKFAMWKQ81YWSE1Z18R6VHR", // Codex in ChatGPT Desktop
      "01KMP3KP5M8X0EBTVW6KN327EE", // VS Code extension
    ]),
    requiredComponents: new Set(["01KMP3KP5MGE23B80K1EK4S8PV"]),
    authComponents: new Set(),
    summaryEvents: false,
  }),
  claude: Object.freeze({
    origin: "https://status.claude.com",
    summaryUrl: "https://status.claude.com/api/v2/summary.json",
    components: new Set([
      "yyzkbfz2thpt", // Claude Code
      "k8w3r06qmzrp", // Claude API
    ]),
    requiredComponents: new Set(["yyzkbfz2thpt", "k8w3r06qmzrp"]),
    // claude.ai is included only for an explicitly authentication-related event.
    authComponents: new Set(["rwppv331jlwc"]),
    summaryEvents: true,
  }),
});

const COMPONENT_STATUSES = Object.freeze({
  operational: "operational",
  degraded_performance: "degraded",
  partial_outage: "degraded",
  major_outage: "outage",
  under_maintenance: "maintenance",
});

const INCIDENT_STATUSES = Object.freeze({
  investigating: "investigating",
  identified: "identified",
  monitoring: "monitoring",
  scheduled: "maintenance",
  in_progress: "maintenance",
  verifying: "maintenance",
});

const IMPACTS = new Set(["none", "minor", "major", "critical"]);
const AUTH_EVENT = /\b(?:auth(?:entication|orization)?|login|log[ -]?in|sign[ -]?in|sso|oauth|account[ -]?access)\b/i;
const STATUS_WEIGHT = Object.freeze({ unknown: 0, operational: 1, degraded: 2, maintenance: 3, outage: 4 });

function unavailable() {
  return new Error("Provider service status unavailable.");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeTimestamp(value) {
  if (typeof value !== "string" || value.length > 40 || !TIMESTAMP.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function plainLabel(value) {
  if (typeof value !== "string" || value.length > 4_096) return "";
  return value
    .replace(/<[^>]{0,256}>/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\p{L}\p{N} .,:;!?()&+/'"-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

function opaqueIncidentId(providerId, value) {
  if (typeof value !== "string" || !INCIDENT_ID.test(value)) return "";
  return "status-" + crypto.createHash("sha256").update(providerId).update("\0").update(value).digest("hex").slice(0, 24);
}

function officialIncidentUrl(value, origin) {
  return typeof value === "string" && INCIDENT_ID.test(value) ? `${origin}/incidents/${value}` : null;
}

function componentIds(record) {
  if (!Array.isArray(record?.components) || record.components.length > MAX_COMPONENTS) return null;
  const ids = [];
  for (const component of record.components) {
    if (!isObject(component) || typeof component.id !== "string" || component.id.length > 128) return null;
    ids.push(component.id);
  }
  return ids;
}

function isAuthenticationEvent(record) {
  return AUTH_EVENT.test(String(record?.name || ""));
}

function eventIsRelevant(record, provider) {
  const ids = componentIds(record);
  if (!ids) return false;
  return ids.some((id) => provider.components.has(id))
    || (isAuthenticationEvent(record) && ids.some((id) => provider.authComponents.has(id)));
}

function incidentServiceStatus(status, impact, record) {
  if (status === "maintenance" && (record.status === "in_progress" || record.status === "verifying")) return "maintenance";
  if (status === "maintenance") {
    const startsAt = Date.parse(record.scheduled_for || "");
    const endsAt = Date.parse(record.scheduled_until || "");
    if (Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt <= Date.now() && Date.now() <= endsAt) return "maintenance";
    return "operational";
  }
  if (impact === "major" || impact === "critical") return "outage";
  return "degraded";
}

function normalizeIncident(providerId, record, provider) {
  if (!isObject(record) || !componentIds(record)) throw unavailable();
  if (!eventIsRelevant(record, provider)) return null;
  if (record.status === "resolved" || record.status === "completed") return null;
  const status = INCIDENT_STATUSES[record.status];
  if (!status || !IMPACTS.has(record.impact)) throw unavailable();
  const serviceStatus = incidentServiceStatus(status, record.impact, record);
  // This domain carries current issues only; planned maintenance must not invalidate
  // an otherwise operational candidate or participate in notice identity.
  if (serviceStatus === "operational") return null;
  const id = opaqueIncidentId(providerId, record.id);
  const label = plainLabel(record.name);
  const url = officialIncidentUrl(record.id, provider.origin);
  const updatedAt = safeTimestamp(record.updated_at);
  if (!id || !label || !url) return { value: null, updatedAt, serviceStatus };
  return {
    value: { id, label, status, impact: record.impact, updatedAt, url },
    updatedAt,
    serviceStatus,
  };
}

function normalizedComponents(summary, provider) {
  if (!isObject(summary) || !Array.isArray(summary.components) || summary.components.length > MAX_COMPONENTS) throw unavailable();
  const statuses = [];
  let unknownKnownComponent = false;
  let updatedAt = null;
  const seenRequired = new Set();
  const seenComponents = new Set();
  for (const component of summary.components) {
    if (!isObject(component) || typeof component.id !== "string" || component.id.length > 128) throw unavailable();
    if (seenComponents.has(component.id)) throw unavailable();
    seenComponents.add(component.id);
    if (!provider.components.has(component.id)) continue;
    if (provider.requiredComponents.has(component.id)) seenRequired.add(component.id);
    const componentUpdatedAt = safeTimestamp(component.updated_at);
    if (componentUpdatedAt && (!updatedAt || Date.parse(componentUpdatedAt) > Date.parse(updatedAt))) updatedAt = componentUpdatedAt;
    const status = COMPONENT_STATUSES[component.status];
    if (status) statuses.push(status);
    else unknownKnownComponent = true;
  }
  if (!statuses.length) return { status: "unknown", updatedAt };
  const highest = statuses.reduce((current, status) => (
    STATUS_WEIGHT[status] > STATUS_WEIGHT[current] ? status : current
  ), "unknown");
  const missingRequired = [...provider.requiredComponents].some((id) => !seenRequired.has(id));
  return { status: highest === "operational" && (unknownKnownComponent || missingRequired) ? "unknown" : highest, updatedAt };
}

async function boundedJson(response) {
  if (!response?.ok || !response.body) throw unavailable();
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    try { await response.body.cancel(); } catch { /* bounded failure */ }
    throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw unavailable();
      chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw unavailable();
  } finally {
    try { await reader.cancel(); } catch { /* reader is already closed */ }
  }
}

function requestSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw unavailable();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function requestJson(url, fetchImpl, signal) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: requestSignal(signal),
  });
  return boundedJson(response);
}

function sourceEvents(summary, provider) {
  const incidents = summary.incidents ?? (provider.summaryEvents ? null : []);
  const maintenance = summary.scheduled_maintenances ?? (provider.summaryEvents ? null : []);
  if (!Array.isArray(incidents) || !Array.isArray(maintenance)
    || incidents.length > MAX_SOURCE_INCIDENTS || maintenance.length > MAX_SOURCE_INCIDENTS) throw unavailable();
  return [...incidents, ...maintenance];
}

function strongest(left, right) {
  return STATUS_WEIGHT[right] > STATUS_WEIGHT[left] ? right : left;
}

/**
 * Fetch and normalize public provider status data. The returned value contains
 * only bounded public health metadata; provider records and transport errors
 * are intentionally discarded before this boundary.
 *
 * @param {"claude" | "codex"} providerId
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{status: "operational" | "degraded" | "outage" | "maintenance" | "unknown", updatedAt: string | null, incidents: {id: string, label: string, status: "investigating" | "identified" | "monitoring" | "maintenance", impact: "none" | "minor" | "major" | "critical", updatedAt: string | null, url: string}[]}>}
 */
export async function readProviderServiceStatus(providerId, { signal, fetchImpl = globalThis.fetch } = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider || typeof fetchImpl !== "function") throw unavailable();
  try {
    const summary = await requestJson(provider.summaryUrl, fetchImpl, signal);
    if (!isObject(summary) || !isObject(summary.page)) throw unavailable();
    const componentState = normalizedComponents(summary, provider);
    let status = componentState.status;
    let updatedAt = componentState.updatedAt || safeTimestamp(summary.page.updated_at);
    const incidents = new Map();
    for (const event of sourceEvents(summary, provider)) {
      const normalized = normalizeIncident(providerId, event, provider);
      if (!normalized) continue;
      status = strongest(status, normalized.serviceStatus);
      if (normalized.updatedAt && (!updatedAt || Date.parse(normalized.updatedAt) > Date.parse(updatedAt))) updatedAt = normalized.updatedAt;
      if (normalized.value) incidents.set(normalized.value.id, normalized.value);
    }
    return {
      status,
      updatedAt,
      incidents: [...incidents.values()]
        .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0) || left.id.localeCompare(right.id))
        .slice(0, MAX_INCIDENTS),
    };
  } catch {
    throw unavailable();
  }
}
