import crypto from "node:crypto";

const MAX_REQUEST_SNAPSHOTS_PER_AGENT = 100;
const CACHE_LIFETIMES = new Set(["5m", "1h", "mixed"]);

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function observedAt(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizedParts(snapshot) {
  const uncachedInputTokens = count(snapshot?.input);
  const cacheWriteTokens = count(snapshot?.cacheWrite);
  const cacheReadTokens = count(snapshot?.cacheRead);
  const outputTokens = count(snapshot?.output);
  if ([uncachedInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens].some((value) => value === null)) return null;
  const totalTokens = uncachedInputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) return null;
  return { uncachedInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, totalTokens };
}

function opaqueId(sessionId, snapshot, timestamp) {
  return `request-${crypto.createHash("sha256")
    .update(`${sessionId}|${snapshot.actorId}|${snapshot.dedupeId}|${timestamp}`)
    .digest("hex").slice(0, 16)}`;
}

// Private evidence; callers must serialize an explicit allowlist.
export function normalizedRequestEvidence(agents, usageSnapshots, maximumPerAgent = MAX_REQUEST_SNAPSHOTS_PER_AGENT) {
  const visibleAgentIds = new Set(agents.map((agent) => agent.id));
  const dedupedByAgent = new Map();

  for (const snapshot of usageSnapshots) {
    if (!snapshot || !visibleAgentIds.has(snapshot.actorId)) continue;
    if (typeof snapshot.dedupeId !== "string" || snapshot.dedupeId.length === 0) continue;
    const timestamp = observedAt(snapshot.timestamp);
    const parts = normalizedParts(snapshot);
    if (!timestamp || !parts) continue;
    const agentSnapshots = dedupedByAgent.get(snapshot.actorId) || new Map();
    const previous = agentSnapshots.get(snapshot.dedupeId);
    if (!previous || Date.parse(timestamp) >= Date.parse(previous.timestamp)) {
      agentSnapshots.set(snapshot.dedupeId, { snapshot, timestamp, parts });
      dedupedByAgent.set(snapshot.actorId, agentSnapshots);
    }
  }

  return [...dedupedByAgent.values()].flatMap((agentSnapshots) => (
    [...agentSnapshots.values()]
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)
        || left.snapshot.dedupeId.localeCompare(right.snapshot.dedupeId))
      .slice(-maximumPerAgent)
  )).sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)
    || left.snapshot.dedupeId.localeCompare(right.snapshot.dedupeId));
}

/**
 * Normalize independent request-local usage observations. This feed never
 * carries values forward, computes deltas, or consumes cumulative totals.
 */
export function buildRequestSnapshots({ sessionId = "session", agents = [], usageSnapshots = [] } = {}) {
  const items = normalizedRequestEvidence(agents, usageSnapshots).map((item) => requestSnapshotFromEvidence(sessionId, item));

  return { status: items.length > 0 ? "ready" : "unavailable", items };
}

/** Serialize public request-local fields from validated evidence. */
export function requestSnapshotFromEvidence(sessionId, { snapshot, timestamp, parts }) {
  return {
    id: opaqueId(sessionId, snapshot, timestamp),
    agentId: snapshot.actorId,
    observedAt: timestamp,
    cacheLifetime: typeof snapshot.cacheLifetime === "string" && CACHE_LIFETIMES.has(snapshot.cacheLifetime)
      ? snapshot.cacheLifetime
      : null,
    uncachedInputTokens: parts.uncachedInputTokens,
    cacheWriteTokens: parts.cacheWriteTokens,
    cacheReadTokens: parts.cacheReadTokens,
    outputTokens: parts.outputTokens,
    totalTokens: parts.totalTokens,
  };
}

/** Monitor-private model evidence corresponding exactly to valid request snapshots. */
export function buildRequestModelObservations({ sessionId = "session", agents = [], usageSnapshots = [] } = {}) {
  return normalizedRequestEvidence(agents, usageSnapshots).flatMap(({ snapshot, timestamp }) => {
    if (typeof snapshot.model !== "string") return [];
    const model = snapshot.model.trim();
    return model && model.length <= 120 ? [{ id: opaqueId(sessionId, snapshot, timestamp), observedAt: timestamp, model }] : [];
  });
}
