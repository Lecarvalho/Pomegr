const RESOURCE_USAGE_STATUSES = new Set(["collecting", "ready", "unavailable"]);
const RESOURCE_USAGE_REASONS = new Set([
  "unsupported_platform",
  "missing_owner",
  "shared_owner",
  "owner_not_found",
  "owner_identity_mismatch",
  "collection_failed",
]);

export function unavailableResourceUsage() {
  return {
    status: "unavailable",
    reason: "collection_failed",
    current: null,
    observedPeak: null,
    samples: [],
  };
}

function resourceNumber(value, nullable = false) {
  if (nullable && value === null) return null;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function publicResourceUsage(value) {
  if (!value || !RESOURCE_USAGE_STATUSES.has(value.status)) return null;
  const status = value.status;
  const reason = status === "unavailable" && RESOURCE_USAGE_REASONS.has(value.reason)
    ? value.reason
    : null;
  if (status === "unavailable" && !reason) return unavailableResourceUsage();
  const memoryBytes = resourceNumber(value.current?.memoryBytes);
  const current = value.current && memoryBytes !== null ? {
    cpuCores: resourceNumber(value.current.cpuCores, true),
    cpuMachinePercent: resourceNumber(value.current.cpuMachinePercent, true),
    memoryBytes,
    readBytesPerSecond: resourceNumber(value.current.readBytesPerSecond, true),
    writeBytesPerSecond: resourceNumber(value.current.writeBytesPerSecond, true),
  } : null;
  const peakMemoryBytes = resourceNumber(value.observedPeak?.memoryBytes);
  const samples = Array.isArray(value.samples) ? value.samples.flatMap((sample) => {
    const timestamp = typeof sample?.timestamp === "string" && Number.isFinite(Date.parse(sample.timestamp))
      ? sample.timestamp
      : null;
    if (!timestamp) return [];
    return [{
      timestamp,
      cpuCores: resourceNumber(sample.cpuCores, true),
      cpuMachinePercent: resourceNumber(sample.cpuMachinePercent, true),
      memoryBytes: resourceNumber(sample.memoryBytes, true),
      readBytesPerSecond: resourceNumber(sample.readBytesPerSecond, true),
      writeBytesPerSecond: resourceNumber(sample.writeBytesPerSecond, true),
    }];
  }) : [];
  return {
    status,
    reason,
    current,
    observedPeak: peakMemoryBytes === null ? null : { memoryBytes: peakMemoryBytes },
    samples,
  };
}
