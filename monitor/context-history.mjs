import crypto from "node:crypto";

const NICE_BUCKET_SIZES = [
  10_000,
  30_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
];

function timestampMs(value) {
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function count(value) {
  if (value === undefined || value === null || value === "") return 0;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function snapshotTotal(usage) {
  const parts = [usage.input, usage.output, usage.cacheWrite, usage.cacheRead].map(count);
  if (parts.some((part) => part === null)) return null;
  const total = parts.reduce((sum, part) => sum + part, 0);
  return Number.isSafeInteger(total) ? total : null;
}

const MAX_CONTEXT_BOUNDARIES = 100;

function compactionActorId(compaction) {
  const value = compaction?.actorId ?? compaction?.actor?.id;
  return typeof value === "string" ? value : "";
}

function boundaryId(sessionId, agentId, timestamp, kind, preTokens) {
  return `boundary-${crypto.createHash("sha256")
    .update(`${sessionId}|${agentId}|${timestamp}|${kind}|${preTokens ?? "unknown"}`)
    .digest("hex").slice(0, 16)}`;
}

function recognizedCompactionBoundary(compaction, sessionId, visibleAgentIds) {
  const agentId = compactionActorId(compaction);
  const milliseconds = timestampMs(compaction?.timestamp);
  const kind = compaction?.trigger === "auto"
    ? "automatic_compaction"
    : compaction?.trigger === "manual" ? "manual_compaction" : null;
  if (!kind || milliseconds === null || !visibleAgentIds.has(agentId)) return null;
  const rawPreTokens = compaction?.preTokens;
  const preTokens = rawPreTokens === null || rawPreTokens === undefined
    ? null
    : Number.isSafeInteger(rawPreTokens) && rawPreTokens >= 0 ? rawPreTokens : null;
  if (preTokens === null && rawPreTokens !== null && rawPreTokens !== undefined) return null;
  const timestamp = new Date(milliseconds).toISOString();
  return {
    id: boundaryId(sessionId, agentId, timestamp, kind, preTokens),
    agentId,
    timestamp,
    kind,
    preTokens,
  };
}

export function buildContextBoundaryEvidence(usages, {
  sessionId = "session",
  agentIds = [],
  compactions = [],
} = {}) {
  const visibleAgentIds = new Set(agentIds);
  const recognized = compactions
    .map((compaction) => recognizedCompactionBoundary(compaction, sessionId, visibleAgentIds))
    .filter(Boolean);
  const recognizedByAgent = new Map();
  for (const boundary of recognized) {
    recognizedByAgent.set(boundary.agentId, [...(recognizedByAgent.get(boundary.agentId) || []), boundary]);
  }

  const pointsByAgent = new Map();
  for (const [index, usage] of usages.entries()) {
    const milliseconds = timestampMs(usage.timestamp);
    const total = snapshotTotal(usage);
    if (!visibleAgentIds.has(usage.actorId) || milliseconds === null || total === null || total === 0) continue;
    pointsByAgent.set(usage.actorId, [...(pointsByAgent.get(usage.actorId) || []), { index, milliseconds, total }]);
  }
  const drops = [];
  for (const [agentId, points] of pointsByAgent) {
    points.sort((left, right) => left.milliseconds - right.milliseconds || left.index - right.index);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      if (current.total >= previous.total) continue;
      const explained = (recognizedByAgent.get(agentId) || []).some((boundary) => {
        const boundaryTime = timestampMs(boundary.timestamp);
        return boundaryTime >= previous.milliseconds && boundaryTime <= current.milliseconds;
      });
      if (explained) continue;
      const timestamp = new Date(current.milliseconds).toISOString();
      drops.push({
        id: boundaryId(sessionId, agentId, timestamp, "snapshot_drop", previous.total),
        agentId,
        timestamp,
        kind: "snapshot_drop",
        preTokens: previous.total,
      });
    }
  }

  const unique = new Map([...recognized, ...drops].map((boundary) => [boundary.id, boundary]));
  return [...unique.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || right.id.localeCompare(left.id));
}

/** Preserve the existing bounded UI feed; report counts use retained evidence. */
export function buildContextBoundaries(usages, options = {}) {
  return buildContextBoundaryEvidence(usages, options)
    .slice(-MAX_CONTEXT_BOUNDARIES)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id));
}

/**
 * Build actual context levels from carried latest per-agent observations.
 * These are neither request throughput nor positive-delta token spend.
 */
export function buildContextHistory(usages, {
  startedAt = null,
  updatedAt = null,
  targetBuckets = 28,
  sessionId = "session",
  agentIds = [],
  compactions = [],
} = {}) {
  const boundaries = buildContextBoundaries(usages, { sessionId, agentIds, compactions });
  const points = usages.flatMap((usage, index) => {
    const timestamp = timestampMs(usage.timestamp);
    const total = snapshotTotal(usage);
    if (timestamp === null || typeof usage.actorId !== "string" || !usage.actorId || total === null || total === 0) return [];
    return [{ timestamp, index, actorId: usage.actorId, total }];
  }).sort((left, right) => left.timestamp - right.timestamp || left.index - right.index);
  if (points.length === 0) return { bucketMs: 0, buckets: [], boundaries };

  const pointTimes = points.map((point) => point.timestamp);
  const requestedStart = timestampMs(startedAt);
  const requestedEnd = timestampMs(updatedAt);
  const first = Math.min(...pointTimes, requestedStart ?? Infinity);
  const last = Math.max(...pointTimes, requestedEnd ?? -Infinity);
  const desiredSize = Math.max(1, last - first) / Math.max(1, targetBuckets);
  const largestBucket = NICE_BUCKET_SIZES.at(-1);
  const bucketMs = NICE_BUCKET_SIZES.find((size) => size >= desiredSize)
    || Math.ceil(desiredSize / largestBucket) * largestBucket;
  const rangeStart = Math.floor(first / bucketMs) * bucketMs;
  const rangeEnd = Math.max(rangeStart + bucketMs, Math.ceil((last + 1) / bucketMs) * bucketMs);
  const bucketCount = Math.ceil((rangeEnd - rangeStart) / bucketMs);
  const latestByActor = new Map();
  const buckets = [];
  let pointIndex = 0;

  for (let index = 0; index < bucketCount; index += 1) {
    const start = rangeStart + index * bucketMs;
    const end = start + bucketMs;
    while (pointIndex < points.length && points[pointIndex].timestamp < end) {
      const point = points[pointIndex++];
      latestByActor.set(point.actorId, point.total);
    }
    const agents = [...latestByActor]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agentId, total]) => ({ agentId, total }));
    buckets.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      total: agents.reduce((sum, agent) => sum + agent.total, 0),
      agents,
    });
  }

  return { bucketMs, buckets, boundaries };
}
