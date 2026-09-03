import crypto from "node:crypto";
import { createEmptyProviderStatusSnapshot } from "../shared/provider-status.mjs";
import { AGENT_ROLES } from "./agent-roles.mjs";
import { normalizedWorkKind, toolWorkKind } from "./work-kind.mjs";

const SCHEMA_VERSION = 1;
const MAX_SESSIONS = 100;
const MAX_AGENTS = 128;
const MAX_FAILURES = 256;
const MAX_FAILURE_WINDOW_MINUTES = 1_440;
const AGENT_ROLE_SET = new Set(AGENT_ROLES);
const AGENT_STATUS_SET = new Set(["active", "waiting", "needs_input", "warm", "finished", "stopped", "idle", "unknown"]);
const ACTIVITY_STATUS_SET = new Set(["working", "needs_input", "idle", "unknown"]);
const FAILURE_CATEGORY_SET = new Set(["command_not_found", "invalid_path", "network_error", "not_found", "non_zero_exit", "permission_denied", "provider_error", "syntax_error", "tests_failed", "timed_out"]);
const PROVIDER_STATUS_SET = new Set(["operational", "degraded", "outage", "maintenance", "unknown"]);
const PROVIDER_FRESHNESS_SET = new Set(["fresh", "stale", "unknown"]);
const INCIDENT_STATUS_SET = new Set(["investigating", "identified", "monitoring", "maintenance"]);
const INCIDENT_IMPACT_SET = new Set(["none", "minor", "major", "critical"]);
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const WORK_LABELS = Object.freeze({
  shell: "shell task", search: "search", read: "file read", write: "file edit",
  test: "test run", build: "build", git: "Git operation", git_push: "Git push",
  pull_request: "pull request operation", process: "process task", web: "web activity",
  image: "image activity", input: "input request", transfer: "file transfer",
  skill: "skill use", report: "status report", agent: "agent coordination",
  integration: "integration activity", wait: "wait",
});

function iso(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function boundedText(value, fallback, max = 256) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.replace(/[\u0000-\u001f\u007f<>\u202a-\u202e\u2066-\u2069]/gu, " ").trim().slice(0, max) || fallback;
}

function readiness(value, fallback = "unavailable") {
  return ["loading", "ready", "unavailable"].includes(value) ? value : fallback;
}

function collectionReadiness(rows) {
  if (!rows.length || rows.every((row) => row.readiness === "unavailable")) return "unavailable";
  return rows.some((row) => row.readiness === "ready") ? "ready" : "loading";
}

function opaqueId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`;
}

function providerFromRef(ref) {
  const index = String(ref).indexOf(":");
  return index > 0 ? String(ref).slice(0, index) : null;
}

function normalizeAgent(agent) {
  if (!agent || typeof agent !== "object" || typeof agent.id !== "string" || !SAFE_AGENT_ID.test(agent.id)) return null;
  const id = agent.id;
  return {
    id,
    scope: id === "primary" ? "main" : "delegated",
    parentId: id === "primary" ? null : (typeof agent.parentId === "string" && SAFE_AGENT_ID.test(agent.parentId) ? agent.parentId : null),
    label: boundedText(agent.label, id === "primary" ? "Primary agent" : "Subagent", 256),
    role: AGENT_ROLE_SET.has(agent.role) ? agent.role : "unknown",
    status: AGENT_STATUS_SET.has(agent.status) ? agent.status : "unknown",
    assignment: agent.assignment == null ? null : boundedText(agent.assignment, "", 512),
    currentActivity: agent.currentActivity && typeof agent.currentActivity === "object"
      ? { label: boundedText(agent.currentActivity.label, "Activity", 256), observedAt: iso(agent.currentActivity.observedAt) }
      : null,
    startedAt: iso(agent.startedAt),
    updatedAt: iso(agent.updatedAt),
    lastSeen: iso(agent.lastSeen),
  };
}

function nonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeTokens(tokens) {
  const value = tokens && typeof tokens === "object" ? tokens : {};
  const result = {
    total: nonNegative(value.total),
    input: nonNegative(value.input),
    cacheRead: nonNegative(value.cacheRead),
    cacheWrite: nonNegative(value.cacheWrite),
    output: nonNegative(value.output),
  };
  if (Number.isSafeInteger(value.reasoningOutput) && value.reasoningOutput >= 0) result.reasoningOutput = value.reasoningOutput;
  if (Number.isSafeInteger(value.modelContextWindow) && value.modelContextWindow >= 0) result.modelContextWindow = value.modelContextWindow;
  return result;
}

function normalizeProviderHealth(snapshot) {
  const source = snapshot || createEmptyProviderStatusSnapshot();
  const providers = (Array.isArray(source.providers) ? source.providers : []).filter((provider) => ["claude", "codex"].includes(provider?.provider)).map((provider) => ({
    provider: provider.provider,
    status: PROVIDER_STATUS_SET.has(provider.status) ? provider.status : "unknown",
    readiness: readiness(provider.readiness, "loading"),
    freshness: PROVIDER_FRESHNESS_SET.has(provider.freshness) ? provider.freshness : "unknown",
    checkedAt: iso(provider.checkedAt),
    updatedAt: iso(provider.updatedAt),
    statusPageUrl: boundedText(provider.statusPageUrl, "", 300),
    incidents: (Array.isArray(provider.incidents) ? provider.incidents : []).slice(0, 8).map((incident) => ({
      id: opaqueId("incident", incident.id),
      label: boundedText(incident.label, "Provider incident", 200),
      status: INCIDENT_STATUS_SET.has(incident.status) ? incident.status : "investigating",
      impact: INCIDENT_IMPACT_SET.has(incident.impact) ? incident.impact : "none",
      updatedAt: iso(incident.updatedAt),
      url: boundedText(incident.url, "", 300),
    })),
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    readiness: collectionReadiness(providers),
    observedAt: iso(source.generatedAt),
    generatedAt: iso(source.generatedAt),
    revision: Number.isSafeInteger(source.revision) ? source.revision : null,
    caveat: "Public provider reporting does not confirm impact on a specific account, model, or session.",
    providers,
  };
}

function normalizeUsageLimits(snapshot) {
  const providers = (Array.isArray(snapshot?.providers) ? snapshot.providers : []).filter((entry) => ["claude", "codex"].includes(entry?.provider));
  return {
    schemaVersion: SCHEMA_VERSION,
    readiness: collectionReadiness(providers),
    observedAt: iso(snapshot?.generatedAt),
    generatedAt: iso(snapshot?.generatedAt),
    revision: Number.isSafeInteger(snapshot?.revision) ? snapshot.revision : null,
    caveat: "Usage limits are current account observations. They are not per-agent consumption and are not attached to historical sessions.",
    providers: providers.map((entry) => {
      const usage = entry.usageLimits || {};
      return {
        provider: entry.provider,
        readiness: readiness(entry.readiness, "unavailable"),
        available: Boolean(usage.available),
        origin: ["local_observation", "provider_api"].includes(usage.origin)
          ? usage.origin
          : entry.provider === "codex" && usage.fetchedAt ? "provider_api" : "unavailable",
        freshness: ["fresh", "stale"].includes(usage.freshness)
          ? usage.freshness
          : usage.fetchedAt ? (usage.failureKind ? "stale" : "fresh") : "unknown",
        observedAt: iso(usage.fetchedAt),
        attemptedAt: iso(usage.attemptedAt),
        retryAt: iso(usage.retryAt),
        failureCategory: ["authentication_required", "rate_limited", "unavailable", "runtime_unavailable"].includes(usage.failureKind) ? usage.failureKind : null,
        windows: (Array.isArray(usage.limits) ? usage.limits : []).slice(0, 8).map((limit) => ({
          id: boundedText(limit.id, "unknown", 80),
          window: boundedText(limit.window, "unknown", 80),
          usedPercent: Number.isFinite(limit.percent) ? Math.max(0, Math.min(100, limit.percent)) : null,
          resetsAt: iso(limit.resetsAt),
          severity: ["normal", "warning", "critical"].includes(limit.severity) ? limit.severity : "normal",
          active: Boolean(limit.active),
        })),
      };
    }),
  };
}

function sessionRows(catalog) {
  return (Array.isArray(catalog) ? catalog : []).slice(0, MAX_SESSIONS).map((entry) => ({
      sessionRef: entry.id,
      provider: entry.provider || providerFromRef(entry.id),
      title: boundedText(entry.title, "Untitled session", 256),
      project: boundedText(entry.project, "Unknown project", 256),
      state: entry.isLive ? "live" : "history",
      activityStatus: ACTIVITY_STATUS_SET.has(entry.activityStatus) ? entry.activityStatus : "unknown",
      createdAt: iso(entry.createdAt),
      updatedAt: iso(entry.updatedAt),
    }));
}

function agentRows(entry) {
  const agents = (entry?.publicState?.agents || []).map(normalizeAgent).filter(Boolean).slice(0, MAX_AGENTS);
  return agents;
}

function latestContext(entry, agentId) {
  const agent = (entry?.publicState?.agents || []).find((candidate) => candidate.id === agentId);
  if (!agent) return null;
  const snapshots = (Array.isArray(entry?.evidence?.usageSnapshots) ? entry.evidence.usageSnapshots : [])
    .filter((snapshot) => snapshot.actorId === agentId && iso(snapshot.timestamp))
    .map((snapshot) => ({ snapshot, total: nonNegative(snapshot.input) + nonNegative(snapshot.output) + nonNegative(snapshot.cacheWrite) + nonNegative(snapshot.cacheRead) }))
    .filter((item) => item.total > 0)
    .sort((left, right) => Date.parse(left.snapshot.timestamp) - Date.parse(right.snapshot.timestamp));
  const latest = snapshots.at(-1)?.snapshot;
  if (!latest) return null;
  const tokens = normalizeTokens({
    ...latest,
    total: nonNegative(latest.input) + nonNegative(latest.output) + nonNegative(latest.cacheWrite) + nonNegative(latest.cacheRead),
  });
  return {
    agentId,
    kind: "latest_context_snapshot",
    observedAt: iso(latest.timestamp),
    total: tokens.total,
    uncachedInput: tokens.input,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    output: tokens.output,
    ...(Object.hasOwn(tokens, "reasoningOutput") ? { reasoningOutput: tokens.reasoningOutput } : {}),
    ...(Object.hasOwn(tokens, "modelContextWindow") ? { modelContextWindow: tokens.modelContextWindow } : {}),
    cacheLifetime: ["5m", "1h", "mixed", "30m+"].includes(agent.cacheLifetime) ? agent.cacheLifetime : null,
  };
}

function normalizeFailure(entry, agentId, raw, task = false) {
  const timestamp = iso(task ? raw.finishedAt || raw.startedAt : raw.timestamp);
  if (!timestamp) return null;
  const workKind = normalizedWorkKind(raw.workKind, toolWorkKind(raw.tool));
  return {
    id: opaqueId("failure", `${entry.qualifiedId}:${agentId}:${task ? "task" : "tool"}:${raw.id}`),
    agentId,
    observedAt: timestamp,
    workKind,
    toolLabel: WORK_LABELS[workKind] || "agent work",
    lifecycle: task ? raw.status : "failed",
    failureCategory: task && FAILURE_CATEGORY_SET.has(raw.failureCause) ? raw.failureCause : null,
    _dedupe: `${agentId}:${raw.id}`,
    _priority: task ? 0 : 1,
  };
}

function publicFailure(item) {
  return {
    id: item.id,
    agentId: item.agentId,
    observedAt: item.observedAt,
    workKind: item.workKind,
    toolLabel: item.toolLabel,
    lifecycle: item.lifecycle,
    failureCategory: item.failureCategory,
  };
}

function recentFailures(entry, now) {
  const publicAgents = entry?.publicState?.agents || [];
  const evidence = entry?.evidence || {};
  const values = [];
  for (const call of Array.isArray(evidence.toolCalls) ? evidence.toolCalls : []) {
    if (call.status !== "failed" || !call.actor?.id) continue;
    const item = normalizeFailure(entry, call.actor.id, call);
    if (item) values.push(item);
  }
  for (const agent of publicAgents) {
    for (const task of Array.isArray(agent.executionTasks) ? agent.executionTasks : []) {
      if (!["failed", "stopped"].includes(task.status)) continue;
      const item = normalizeFailure(entry, agent.id, task, true);
      if (item) values.push(item);
    }
  }
  const cutoff = now - MAX_FAILURE_WINDOW_MINUTES * 60_000;
  const deduped = new Map();
  for (const item of values) {
    if (Date.parse(item.observedAt) < cutoff) continue;
    const previous = deduped.get(item._dedupe);
    if (!previous || item._priority < previous._priority) deduped.set(item._dedupe, item);
  }
  const eligible = [...deduped.values()].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || a.id.localeCompare(b.id));
  return {
    items: eligible.slice(0, MAX_FAILURES).map(publicFailure),
    truncated: eligible.length > MAX_FAILURES,
  };
}

function response(readiness, value, revision, generatedAt, reason = null) {
  return { schemaVersion: SCHEMA_VERSION, readiness, observedAt: generatedAt, generatedAt, revision, ...(reason ? { reason } : {}), ...value };
}

/** Build all agent-query views from committed monitor projections only. */
export function buildAgentQueryProjection({ catalog = [], entries = [], providerStatus, usageLimits, now = Date.now } = {}) {
  const catalogValue = Array.isArray(catalog) ? { sessions: catalog, readiness: null } : (catalog || {});
  const catalogSessions = Array.isArray(catalogValue.sessions) ? catalogValue.sessions : [];
  const retainedEntries = Array.isArray(entries) ? entries : [];
  const revision = Math.max(0, ...retainedEntries.map((entry) => entry.revision || 0), providerStatus?.revision || 0, usageLimits?.revision || 0);
  const projectionTime = now();
  const generatedAt = new Date(projectionTime).toISOString();
  const normalizedCatalog = sessionRows(catalogSessions);
  const knownSessionRefs = new Set(normalizedCatalog.map((session) => session.sessionRef));
  const catalogReadinessValues = Object.values(catalogValue.readiness || {}).filter((value) => ["loading", "ready", "unavailable"].includes(value));
  const catalogReadiness = catalogReadinessValues.includes("ready")
    ? "ready"
    : catalogReadinessValues.includes("loading") ? "loading" : catalogReadinessValues.length ? "unavailable" : (catalogSessions.length ? "ready" : "loading");
  const sessionDetails = new Map();
  for (const entry of retainedEntries) {
    const agents = agentRows(entry);
    const agentIds = new Set(agents.map((agent) => agent.id));
    const contexts = new Map((entry.publicState?.agents || []).flatMap((agent) => {
      const context = latestContext(entry, agent.id);
      return context ? [[agent.id, context]] : [];
    }));
    const failureProjection = recentFailures(entry, projectionTime);
    sessionDetails.set(entry.qualifiedId, Object.freeze({
      agentReadiness: readiness(entry.readiness?.agentEvidence, "ready"),
      contextReadiness: readiness(entry.readiness?.contextEvidence, "ready"),
      activityReadiness: readiness(entry.readiness?.activityEvidence, "ready"),
      agents,
      agentIds,
      contexts,
      failures: failureProjection.items,
      failuresTruncated: failureProjection.truncated,
    }));
  }
  const normalizedHealth = normalizeProviderHealth(providerStatus);
  const normalizedUsage = normalizeUsageLimits(usageLimits);
  return Object.freeze({
    providerHealth({ provider = null } = {}) {
      const providers = provider ? normalizedHealth.providers.filter((entry) => entry.provider === provider) : normalizedHealth.providers;
      const value = { ...normalizedHealth, readiness: collectionReadiness(providers), providers };
      return value;
    },
    usageLimits({ provider = null } = {}) {
      const providers = provider ? normalizedUsage.providers.filter((entry) => entry.provider === provider) : normalizedUsage.providers;
      const value = { ...normalizedUsage, readiness: collectionReadiness(providers), providers };
      return value;
    },
    listSessions({ scope = "live", provider = null, limit = 20 } = {}) {
      const matching = normalizedCatalog.filter((entry) => (!provider || entry.provider === provider) && (scope === "all" || entry.state === "live"));
      const rows = matching.slice(0, limit);
      return response(catalogReadiness, { sessions: rows, truncated: matching.length > limit || catalogSessions.length > MAX_SESSIONS }, revision, generatedAt);
    },
    listSessionAgents(input) {
      const sessionRef = typeof input === "string" ? input : input?.sessionRef;
      const details = sessionDetails.get(sessionRef) || null;
      return details ? response(details.agentReadiness, { sessionRef, agents: details.agents }, revision, generatedAt)
        : response("unavailable", { sessionRef, agents: [] }, revision, generatedAt, knownSessionRefs.has(sessionRef) ? "session_unavailable" : "session_not_found");
    },
    getAgentContext(input, directAgentId) {
      const sessionRef = typeof input === "string" ? input : input?.sessionRef;
      const agentId = typeof input === "string" ? directAgentId : input?.agentId;
      const details = sessionDetails.get(sessionRef) || null;
      const context = details?.contexts.get(agentId) || null;
      if (!details) return response("unavailable", { sessionRef, agentId, context: null }, revision, generatedAt, knownSessionRefs.has(sessionRef) ? "session_unavailable" : "session_not_found");
      if (!details.agentIds.has(agentId)) return response("unavailable", { sessionRef, agentId, context: null }, revision, generatedAt, "agent_not_found");
      return context
        ? response(details.contextReadiness, { sessionRef, agentId, context }, revision, generatedAt)
        : response("unavailable", { sessionRef, agentId, context: null }, revision, generatedAt, "context_unavailable");
    },
    getRecentFailures(input, directAgentId = null, directWithinMinutes = 15, directLimit = 10) {
      const sessionRef = typeof input === "string" ? input : input?.sessionRef;
      const agentId = typeof input === "string" ? directAgentId : (input?.agentId || null);
      const withinMinutes = typeof input === "string" ? directWithinMinutes : (input?.withinMinutes ?? 15);
      const limit = typeof input === "string" ? directLimit : (input?.limit ?? 10);
      const details = sessionDetails.get(sessionRef) || null;
      const cutoff = projectionTime - withinMinutes * 60_000;
      const matching = details ? details.failures.filter((failure) => (!agentId || failure.agentId === agentId) && Date.parse(failure.observedAt) >= cutoff) : [];
      const failures = matching.slice(0, limit);
      const coverage = {
        maximumWindowMinutes: MAX_FAILURE_WINDOW_MINUTES,
        maximumRetained: MAX_FAILURES,
        oldestObservedAt: matching.at(-1)?.observedAt || null,
        newestObservedAt: matching[0]?.observedAt || null,
        truncated: Boolean(details?.failuresTruncated) || matching.length > limit,
      };
      if (details && agentId && !details.agentIds.has(agentId)) {
        return response("unavailable", { sessionRef, agentId, withinMinutes, failures: [], retainedCoverage: { ...coverage, oldestObservedAt: null, newestObservedAt: null } }, revision, generatedAt, "agent_not_found");
      }
      return details ? response(details.activityReadiness, {
        sessionRef, agentId, withinMinutes, failures, retainedCoverage: coverage,
      }, revision, generatedAt) : response("unavailable", { sessionRef, agentId, withinMinutes, failures: [], retainedCoverage: coverage }, revision, generatedAt, knownSessionRefs.has(sessionRef) ? "session_unavailable" : "session_not_found");
    },
  });
}

/** Small immutable revision cache around the projection. Refresh is D-only. */
export function createAgentQueryProjectionCache({ sources = {}, now = Date.now } = {}) {
  let revision = 0;
  let serialized = new Map();
  const materialize = () => Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, typeof value === "function" ? value() : value]));
  let projection = buildAgentQueryProjection({ ...materialize(), now });
  function refresh() {
    projection = buildAgentQueryProjection({ ...materialize(), now });
    revision += 1;
    serialized = new Map();
    return projection;
  }
  function read(name, args = {}, requestedRevision = null) {
    if (requestedRevision !== null && requestedRevision === revision) return { status: "unchanged", revision };
    const key = `${revision}:${name}:${JSON.stringify(args)}`;
    const cached = serialized.get(key);
    if (cached) return { status: "ready", revision, snapshot: cached };
    const value = typeof projection[name] === "function" ? projection[name](args) : projection[name];
    const snapshot = { revision, value, serialized: JSON.stringify({ ...value, revision }) };
    serialized.set(key, snapshot);
    return { status: "ready", revision, snapshot };
  }
  return Object.freeze({ refresh, read, current: () => ({ revision, projection }) });
}
