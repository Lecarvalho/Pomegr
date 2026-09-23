/**
 * Bounded read-only readiness for the monitor's private SQLite store. Database paths,
 * table contents, and raw retention error text never appear here.
 */
export const RETENTION_DAY_CHOICES = [30, 90, 180, 365, null] as const;
export const STORE_THRESHOLD_MB_CHOICES = [250, 500, 1024, 2048] as const;

export type StorageReadiness = "loading" | "rebuilding" | "ready" | "unavailable";
export type StorageCleanupStatus = "normal" | "cleanup_pending" | "protected_excess";
export type StorageRetentionDays = (typeof RETENTION_DAY_CHOICES)[number];
export type StorageThresholdMb = (typeof STORE_THRESHOLD_MB_CHOICES)[number];

export type StorageSnapshot = {
  revision: number;
  readiness: StorageReadiness;
  databaseBytes: number | null;
  thresholdBytes: number;
  percent: number | null;
  oldestRetainedDay: string | null;
  lastPrunedAt: string | null;
  retentionDays: StorageRetentionDays;
  cleanupStatus: StorageCleanupStatus | null;
};

const DEFAULT_THRESHOLD_BYTES = 500 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS: StorageRetentionDays = 90;

export function createUnavailableStorageSnapshot(): StorageSnapshot {
  return {
    revision: 0,
    readiness: "unavailable",
    databaseBytes: null,
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
    percent: null,
    oldestRetainedDay: null,
    lastPrunedAt: null,
    retentionDays: DEFAULT_RETENTION_DAYS,
    cleanupStatus: null,
  };
}
