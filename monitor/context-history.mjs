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

/**
 * Build actual context levels from carried latest per-agent observations.
 * These are neither request throughput nor positive-delta token spend.
 */
export function buildContextHistory(usages, { startedAt = null, updatedAt = null, targetBuckets = 28 } = {}) {
  const points = usages.flatMap((usage, index) => {
    const timestamp = timestampMs(usage.timestamp);
    const total = snapshotTotal(usage);
    if (timestamp === null || typeof usage.actorId !== "string" || !usage.actorId || total === null || total === 0) return [];
    return [{ timestamp, index, actorId: usage.actorId, total }];
  }).sort((left, right) => left.timestamp - right.timestamp || left.index - right.index);
  if (points.length === 0) return { bucketMs: 0, buckets: [] };

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

  return { bucketMs, buckets };
}
