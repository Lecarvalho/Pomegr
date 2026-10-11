import crypto from "node:crypto";

export const SESSION_EVENT_KINDS = Object.freeze([
  "agent_started", "agent_finished", "agent_stopped", "signal_reported", "estimate_updated",
  "user_message", "resource_peak", "commit_observed", "pull_request_opened",
  "cache_refill", "context_compacted",
]);
export const SESSION_EVENT_LIMIT = 50;
export const SESSION_EVENT_READINESS_SECTIONS = Object.freeze(["core", "agentEvidence", "activityEvidence"]);

const KIND_ORDER = new Map(SESSION_EVENT_KINDS.map((kind, index) => [kind, index]));
const SIGNAL_TONES = new Set(["neutral", "info", "positive", "warning", "negative"]);
const PROGRESS_PHASES = new Set(["planning", "implementing", "verifying", "blocked", "complete"]);
// The fixed floor a field's session high must reach to be an event.
const RESOURCE_PEAK_FLOORS = new Map([
  ["cpu_cores", 2],
  ["memory_bytes", 2 * 1024 ** 3],
  ["read_bps", 50 * 1024 ** 2],
  ["write_bps", 50 * 1024 ** 2],
]);
const PRIMARY_AGENT_ID = "primary";
const REFILL_KINDS = new Set(["possible_full", "provider_diagnosed", "lifetime_elapsed"]);
const COMPACTION_TRIGGERS = new Set(["automatic", "manual"]);

function instant(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function candidate(kind, atMs, scope, fields = {}, tie = "") {
  return {
    kind, atMs, scope, tie,
    event: {
      id: null,
      kind,
      at: new Date(atMs).toISOString(),
      agentId: fields.agentId ?? null,
      agentLabel: fields.agentLabel ?? null,
      durationMs: fields.durationMs ?? null,
      signal: fields.signal ?? null,
      progress: fields.progress ?? null,
      resource: fields.resource ?? null,
      pullRequestNumber: fields.pullRequestNumber ?? null,
      refill: fields.refill ?? null,
      compaction: fields.compaction ?? null,
    },
  };
}

function agentIdentity(agent) {
  if (typeof agent?.id !== "string" || agent.id.length === 0) return null;
  return { agentId: agent.id, agentLabel: typeof agent.label === "string" ? agent.label : null };
}

function signalFields(signal) {
  if (typeof signal?.label !== "string" || signal.label.length === 0 || !SIGNAL_TONES.has(signal.tone)) return null;
  return { label: signal.label, tone: signal.tone };
}

function agentLifecycleEvents(agents) {
  const events = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    const identity = agentIdentity(agent);
    if (!identity) continue;
    const scope = `agent:${identity.agentId}`;
    const startedMs = instant(agent.startedAt);
    // The primary agent starts with the session itself; only delegated agents are events.
    if (startedMs !== null && identity.agentId !== PRIMARY_AGENT_ID) events.push(candidate("agent_started", startedMs, scope, identity));
    if (agent.status === "finished" || agent.status === "stopped") {
      const endedMs = instant(agent.updatedAt) ?? instant(agent.lastSeen);
      const durationMs = Number.isFinite(agent.durationMs) && agent.durationMs >= 0 ? agent.durationMs : null;
      if (endedMs !== null) events.push(candidate(agent.status === "finished" ? "agent_finished" : "agent_stopped", endedMs, scope, { ...identity, durationMs }));
    }
  }
  return events;
}

// Only the latest signal and estimate survive in evidence, so each scope yields at most one event.
function reportedStateEvents(session, agents) {
  const events = [];
  const sessionSignal = signalFields(session?.signal);
  const sessionSignalMs = instant(session?.signal?.reportedAt);
  if (sessionSignal && sessionSignalMs !== null) events.push(candidate("signal_reported", sessionSignalMs, "session", { signal: sessionSignal }));
  for (const agent of Array.isArray(agents) ? agents : []) {
    const identity = agentIdentity(agent);
    const signal = signalFields(agent?.signal);
    const reportedMs = instant(agent?.signal?.reportedAt);
    if (identity && signal && reportedMs !== null) events.push(candidate("signal_reported", reportedMs, `agent:${identity.agentId}`, { ...identity, signal }));
  }
  const progress = session?.progress;
  const progressMs = instant(progress?.reportedAt);
  if (progressMs !== null && Number.isFinite(progress.percent) && PROGRESS_PHASES.has(progress.phase)) {
    events.push(candidate("estimate_updated", progressMs, "session", { progress: { percent: progress.percent, phase: progress.phase } }));
  }
  return events;
}

function userMessageEvents(userMessageTimes) {
  const events = [];
  for (const time of Array.isArray(userMessageTimes) ? userMessageTimes : []) {
    const atMs = instant(time);
    if (atMs !== null) events.push(candidate("user_message", atMs, "session"));
  }
  return events;
}

function resourcePeakEvents(retainedResources) {
  if (retainedResources?.readiness !== "ready" || !Array.isArray(retainedResources.peaks)) return [];
  const highs = new Map();
  for (const peak of retainedResources.peaks) {
    if (!RESOURCE_PEAK_FLOORS.has(peak?.field) || !Number.isFinite(peak.value)) continue;
    const atMs = instant(peak.observedAt);
    if (atMs === null) continue;
    const high = highs.get(peak.field);
    if (!high || peak.value > high.value || (peak.value === high.value && atMs < high.atMs)) highs.set(peak.field, { value: peak.value, atMs });
  }
  return [...highs]
    .filter(([field, high]) => high.value >= RESOURCE_PEAK_FLOORS.get(field))
    .map(([field, high]) => candidate("resource_peak", high.atMs, `resource:${field}`, { resource: field }));
}

function commitEvents(commitTimes) {
  const events = [];
  for (const time of Array.isArray(commitTimes) ? commitTimes : []) {
    const atMs = instant(time);
    if (atMs !== null) events.push(candidate("commit_observed", atMs, "session"));
  }
  return events;
}

function pullRequestEvents(creations, pullRequests) {
  const numbersByUrl = new Map();
  for (const item of Array.isArray(pullRequests?.items) ? pullRequests.items : []) {
    if (typeof item?.url === "string" && Number.isSafeInteger(item.number) && item.number > 0 && !numbersByUrl.has(item.url)) numbersByUrl.set(item.url, item.number);
  }
  const events = [];
  for (const creation of Array.isArray(creations) ? creations : []) {
    const atMs = instant(creation?.timestamp);
    if (atMs === null) continue;
    const pullRequestNumber = typeof creation.url === "string" ? numbersByUrl.get(creation.url) ?? null : null;
    events.push(candidate("pull_request_opened", atMs, "session", { pullRequestNumber }, String(pullRequestNumber ?? "")));
  }
  return events;
}

function labelsById(agents) {
  const labels = new Map();
  for (const agent of Array.isArray(agents) ? agents : []) {
    const identity = agentIdentity(agent);
    if (identity) labels.set(identity.agentId, identity.agentLabel);
  }
  return labels;
}

function cacheRefillEvents(eventRecord, agents) {
  const labels = labelsById(agents);
  const events = [];
  for (const refill of Array.isArray(eventRecord?.refills) ? eventRecord.refills : []) {
    const atMs = instant(refill?.at);
    if (atMs === null || !REFILL_KINDS.has(refill.kind) || !labels.has(refill.agentId)) continue;
    events.push(candidate("cache_refill", atMs, `agent:${refill.agentId}`, { agentId: refill.agentId, agentLabel: labels.get(refill.agentId), refill: refill.kind }, refill.kind));
  }
  return events;
}

function compactionEvents(eventRecord, agents) {
  const labels = labelsById(agents);
  const events = [];
  for (const compaction of Array.isArray(eventRecord?.compactions) ? eventRecord.compactions : []) {
    const atMs = instant(compaction?.at);
    if (atMs === null || !COMPACTION_TRIGGERS.has(compaction.trigger) || !labels.has(compaction.agentId)) continue;
    events.push(candidate("context_compacted", atMs, `agent:${compaction.agentId}`, { agentId: compaction.agentId, agentLabel: labels.get(compaction.agentId), compaction: compaction.trigger }, compaction.trigger));
  }
  return events;
}

function feedReadiness(readiness) {
  if (SESSION_EVENT_READINESS_SECTIONS.some((section) => readiness?.[section] === "loading")) return "loading";
  return SESSION_EVENT_READINESS_SECTIONS.every((section) => readiness?.[section] === "ready") ? "ready" : "unavailable";
}

function compare(left, right) {
  return right.atMs - left.atMs
    || KIND_ORDER.get(left.kind) - KIND_ORDER.get(right.kind)
    || (left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0)
    || (left.tie < right.tie ? -1 : left.tie > right.tie ? 1 : 0);
}

export function sessionEvents({
  readiness, session, agents, userMessageTimes, pullRequestCreations, pullRequests, commitTimes, retainedResources,
  eventRecord,
} = {}) {
  const feed = feedReadiness(readiness);
  if (feed !== "ready") return { readiness: feed, items: [], total: 0 };
  const candidates = [
    ...agentLifecycleEvents(agents),
    ...reportedStateEvents(session, agents),
    ...userMessageEvents(userMessageTimes),
    ...resourcePeakEvents(retainedResources),
    ...commitEvents(commitTimes),
    ...pullRequestEvents(pullRequestCreations, pullRequests),
    ...cacheRefillEvents(eventRecord, agents),
    ...compactionEvents(eventRecord, agents),
  ].sort(compare);
  const ordinals = new Map();
  const items = [];
  for (const { kind, scope, event } of candidates) {
    const key = JSON.stringify([kind, scope, event.at]);
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    if (items.length >= SESSION_EVENT_LIMIT) continue;
    const digest = crypto.createHash("sha256").update(JSON.stringify([kind, scope, event.at, ordinal])).digest("hex").slice(0, 16);
    items.push({ ...event, id: `event-${digest}` });
  }
  return { readiness: "ready", items, total: candidates.length };
}
