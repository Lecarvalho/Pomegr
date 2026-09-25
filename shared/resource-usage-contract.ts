export type ResourceUsageUnavailableReason =
  | "unsupported_platform"
  | "missing_owner"
  | "shared_owner"
  | "owner_not_found"
  | "owner_identity_mismatch"
  | "collection_failed";

export type ResourceUsageSample = {
  timestamp: string;
  cpuCores: number | null;
  cpuMachinePercent: number | null;
  memoryBytes: number | null;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
};

/** Live process-tree telemetry. Process identity and sampling internals stay monitor-private. */
export type ResourceUsage = {
  status: "collecting" | "ready" | "unavailable";
  reason: ResourceUsageUnavailableReason | null;
  current: {
    cpuCores: number | null;
    cpuMachinePercent: number | null;
    memoryBytes: number;
    readBytesPerSecond: number | null;
    writeBytesPerSecond: number | null;
  } | null;
  samples: ResourceUsageSample[];
};
