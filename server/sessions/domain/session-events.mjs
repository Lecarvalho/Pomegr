import crypto from "node:crypto";

// Mirrors SESSION_EVENT_KINDS and SESSION_EVENT_LIMIT in shared/session-domain-contract.ts, a
// TypeScript module the monitor cannot import. tests/server/sessions/domain/session-events.test.mjs
// pins both copies together.
export const SESSION_EVENT_KINDS = Object.freeze([
  "agent_started", "agent_finished", "agent_stopped", "signal_reported", "estimate_updated",
  "user_message", "resource_peak", "commit_observed", "pull_request_opened",
  "cache_refill", "context_compacted",
]);
export const SESSION_EVENT_LIMIT = 50;
// The session-summary sections that gate the feed. The repository section is deliberately not
// one: it returns to loading whenever its live check restarts (a new recorded pull request, a
// branch change, a failing Git reader), which would withdraw a served feed. Commit times are
// recorded evidence and a pull-request number is nullable, so neither needs that section.
// Retained resources are not a summary section: their own readiness is checked where peaks are derived.
// Cache refills and compactions are best-effort the same way: context evidence never holds the feed.
export const SESSION_EVENT_READINESS_SECTIONS = Object.freeze(["core", "agentEvidence", "activityEvidence"]);

const KIND_ORDER = new Map(SESSION_EVENT_KINDS.map((kind, index) => [kind, index]));
const SIGNAL_TONES = new Set(["neutral", "info", "positive", "warning", "negative"]);
const PROGRESS_PHASES = new Set(["planning", "implementing", "verifying", "blocked", "complete"]);
const RESOURCE_FIELDS = new Set(["cpu_cores", "memory_bytes", "read_bps", "write_bps"]);
const PRIMARY_AGENT_ID = "primary";
const REFILL_KINDS = new Set(["possible_full", "provider_diagnosed", "lifetime_elapsed"]);
const COMPACTION_TRIGGERS = new Set(["automatic", "manual"]);

function instant(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One candidate event. `atMs` and `scope` order and identify it; `tie` only breaks otherwise equal
 * ordering. Every contract field is listed explicitly, never copied from a source object.
 */
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

// The adapter's recorded user-message times, a bounded list of timestamps and nothing else. The
// windowed activity evidence is deliberately not read: its rows age out as other work arrives.
function userMessageEvents(userMessageTimes) {
  const events = [];
  for (const time of Array.isArray(userMessageTimes) ? userMessageTimes : []) {
    const atMs = instant(time);
    if (atMs !== null) events.push(candidate("user_message", atMs, "session"));
  }
  return events;
}

// The retained session high per resource field; with equal highs the earlier observation wins.
function resourcePeakEvents(retainedResources) {
  if (retainedResources?.readiness !== "ready" || !Array.isArray(retainedResources.peaks)) return [];
  const highs = new Map();
  for (const peak of retainedResources.peaks) {
    if (!RESOURCE_FIELDS.has(peak?.field) || !Number.isFinite(peak.value)) continue;
    const atMs = instant(peak.observedAt);
    if (atMs === null) continue;
    const high = highs.get(peak.field);
    if (!high || peak.value > high.value || (peak.value === high.value && atMs < high.atMs)) highs.set(peak.field, { value: peak.value, atMs });
  }
  return [...highs].map(([field, high]) => candidate("resource_peak", high.atMs, `resource:${field}`, { resource: field }));
}

// The session's recorded in-window commit times: the same recorded snapshot that backs "Commits
// in session", read identically for a live and a historical session. The live repository value
// and its short commit list are never read, and current Git state is never substituted.
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

// The session's recorded refill times: the recorded request time, the agent, and the fixed kind,
// nothing else. The live cache-event feed is deliberately not read: its usage evidence is a
// window that slides. An entry whose agent is not visible is skipped.
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

// The session's recorded automatic and manual compaction times.
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

// Loading while any gating section is loading, so a partial list is never served as ready;
// unavailable while one is unavailable and none is loading; otherwise ready.
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

/**
 * Derives the session-summary event feed from already-normalized, committed inputs. Pure and
 * deterministic: identical inputs yield an identical feed, and no timestamp comes from the
 * projection time.
 *
 * Inputs (every one optional; a missing one contributes no events):
 * - readiness: { core, agentEvidence, activityEvidence } section readiness (see feedReadiness).
 * - session: the public session facts (signal, progress).
 * - agents: the public agents.
 * - userMessageTimes: the adapter's recorded user-message times (timestamps only).
 * - pullRequestCreations / pullRequests: recorded creations and the public pull-request list.
 * - commitTimes: the recorded in-window commit times from the repository snapshot (timestamps only).
 * - retainedResources: the committed retained-resource block.
 * - eventRecord: the session's recorded refill and compaction times (see session-event-record.mjs).
 *
 * Returns { readiness, items, total }: `items` is the newest SESSION_EVENT_LIMIT events and
 * `total` counts the events derivable from the retained evidence before that cap. It is not a
 * count of everything that happened in the session: the sources are themselves bounded. Each
 * item has exactly the twelve SessionEvent keys, with every field its kind does not use set to null.
 */
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
  // Equal (kind, scope, time) events are interchangeable, so an ordinal in sorted order keeps
  // their IDs distinct and stable. Only the capped items are hashed.
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
