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

const PART_NAMES = ["input", "output", "cacheWrite", "cacheRead"];

function timestampMs(value) {
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function tokenParts(usage) {
  const count = (value) => {
    const number = Number(value || 0);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
  };
  return {
    input: count(usage.input),
    output: count(usage.output),
    cacheWrite: count(usage.cacheWrite),
    cacheRead: count(usage.cacheRead),
  };
}

function totalParts(parts) {
  return PART_NAMES.reduce((total, name) => total + parts[name], 0);
}

function aggregateSnapshots(latestByActor) {
  const aggregate = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const snapshot of latestByActor.values()) {
    for (const name of PART_NAMES) aggregate[name] += snapshot[name];
  }
  return aggregate;
}

// Attribute only the net context increase. A context category can move from
// cache-write to cache-read between snapshots, so raw positive category deltas
// are scaled to the net increase instead of being presented as extra growth.
function attributedGrowth(previous, current) {
  const total = Math.max(0, totalParts(current) - totalParts(previous));
  const positive = Object.fromEntries(PART_NAMES.map((name) => [name, Math.max(0, current[name] - previous[name])]));
  const positiveTotal = totalParts(positive);
  if (total === 0 || positiveTotal === 0) return { total: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  const exact = PART_NAMES.map((name) => ({ name, value: positive[name] * total / positiveTotal }));
  const allocated = Object.fromEntries(exact.map(({ name, value }) => [name, Math.floor(value)]));
  let remainder = total - totalParts(allocated);
  for (const { name } of [...exact].sort((a, b) => (b.value % 1) - (a.value % 1))) {
    if (remainder-- <= 0) break;
    allocated[name] += 1;
  }
  return { total, ...allocated };
}

export function buildContextGrowthTimeline(usages, { startedAt = null, updatedAt = null, targetBuckets = 28 } = {}) {
  const points = usages.flatMap((usage, index) => {
    const timestamp = timestampMs(usage.timestamp);
    if (timestamp === null || typeof usage.actorId !== "string" || !usage.actorId) return [];
    const parts = tokenParts(usage);
    return totalParts(parts) > 0 ? [{ timestamp, index, actorId: usage.actorId, ...parts }] : [];
  }).sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
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
  const buckets = [];
  const latestByActor = new Map();
  let previous = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let pointIndex = 0;

  for (let index = 0; index < bucketCount; index += 1) {
    const start = rangeStart + index * bucketMs;
    const end = start + bucketMs;
    while (pointIndex < points.length && points[pointIndex].timestamp < end) {
      const point = points[pointIndex++];
      latestByActor.set(point.actorId, tokenParts(point));
    }
    const current = aggregateSnapshots(latestByActor);
    buckets.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      ...attributedGrowth(previous, current),
    });
    previous = current;
  }

  return { bucketMs, buckets };
}
