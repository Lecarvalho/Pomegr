import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePomegrDataRoot } from "../../shared/pomegr-paths.mjs";
import { usageLimitSeverity } from "../../shared/usage-limit-severity.mjs";

const SNAPSHOT_FILE = "claude.json";
const MAX_FUTURE_TIMESTAMP = Date.parse("2100-01-01T00:00:00.000Z");
const MAX_SNAPSHOT_BYTES = 2_048;
const MAX_OBSERVATION_CLOCK_SKEW_MS = 60_000;

function canonicalEpochSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const milliseconds = value * 1_000;
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_FUTURE_TIMESTAMP) return null;
  return new Date(milliseconds).toISOString();
}

function canonicalStoredTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_FUTURE_TIMESTAMP) return null;
  return new Date(milliseconds).toISOString() === value ? value : null;
}

function normalizedStatuslineWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usedPercentage = value.used_percentage;
  const resetsAt = canonicalEpochSeconds(value.resets_at);
  if (typeof usedPercentage !== "number" || !Number.isFinite(usedPercentage)
    || usedPercentage < 0 || usedPercentage > 100 || !resetsAt) return null;
  return { usedPercentage, resetsAt };
}

function normalizedStoredWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usedPercentage = value.usedPercentage;
  const resetsAt = canonicalStoredTimestamp(value.resetsAt);
  if (typeof usedPercentage !== "number" || !Number.isFinite(usedPercentage)
    || usedPercentage < 0 || usedPercentage > 100 || !resetsAt) return null;
  return { usedPercentage, resetsAt };
}

function normalizedSnapshot(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const observedAt = canonicalStoredTimestamp(value.observedAt);
  const observedMs = Date.parse(observedAt || "");
  const fiveHour = normalizedStoredWindow(value.limits?.fiveHour);
  const sevenDay = normalizedStoredWindow(value.limits?.sevenDay);
  if (value.version !== 1 || !observedAt || !fiveHour || !sevenDay) return null;
  if (Number.isFinite(now) && observedMs > now + MAX_OBSERVATION_CLOCK_SKEW_MS) return null;
  return { version: 1, observedAt, limits: { fiveHour, sevenDay } };
}

export function claudeUsageSnapshotsRoot(options = {}) {
  const environment = options.environment || process.env;
  return environment.POMEGR_USAGE_SNAPSHOTS_DIR
    || path.join(resolvePomegrDataRoot({ environment, homeDir: options.homeDir || os.homedir(), platform: options.platform }), "usage-snapshots");
}

function snapshotPath(root = claudeUsageSnapshotsRoot()) {
  return path.join(root, SNAPSHOT_FILE);
}

/**
 * Captures only the two account-wide statusline windows.  The whole pair is
 * accepted or rejected together so independent window observations cannot be
 * mixed into a synthetic account snapshot.
 */
export function captureClaudeStatuslineUsage(input, options = {}) {
  const limits = input?.rate_limits;
  const fiveHour = normalizedStatuslineWindow(limits?.five_hour);
  const sevenDay = normalizedStatuslineWindow(limits?.seven_day);
  if (!fiveHour || !sevenDay) return null;

  const observed = typeof options.now === "function" ? options.now() : options.now || new Date();
  const observedAt = canonicalStoredTimestamp(observed instanceof Date ? observed.toISOString() : "");
  if (!observedAt) return null;
  const snapshot = { version: 1, observedAt, limits: { fiveHour, sevenDay } };
  const root = options.root || claudeUsageSnapshotsRoot(options);
  const file = snapshotPath(root);

  // A status line is emitted repeatedly for unchanged data.  Preserve the
  // original observation time so consumers do not treat that repetition as a
  // new provider observation.
  const previous = readClaudeUsageSnapshot({ root });
  if (previous && JSON.stringify(previous.limits) === JSON.stringify(snapshot.limits)) return previous;

  let temporary = "";
  try {
    fs.mkdirSync(root, { recursive: true });
    temporary = path.join(root, `.${SNAPSHOT_FILE}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
    return snapshot;
  } catch {
    return null;
  } finally {
    if (temporary) {
      try { fs.unlinkSync(temporary); } catch { /* Atomic replacement already consumed it, or it never existed. */ }
    }
  }
}

/** Reads the last complete, sanitized local observation without exposing its path. */
export function readClaudeUsageSnapshot(options = {}) {
  const file = snapshotPath(options.root || claudeUsageSnapshotsRoot(options));
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_SNAPSHOT_BYTES) return null;
    const current = typeof options.now === "function" ? options.now() : options.now ?? Date.now();
    return normalizedSnapshot(JSON.parse(fs.readFileSync(file, "utf8")), current instanceof Date ? current.getTime() : current);
  } catch {
    return null;
  }
}

export function claudeUsageLimitsFromSnapshot(snapshot, { freshness = "fresh", attemptedAt = null } = {}) {
  const checked = normalizedSnapshot(snapshot, Number.POSITIVE_INFINITY);
  if (!checked) return null;
  const limits = [
    { id: "current-session", label: "Current session", window: "5 hours", percent: checked.limits.fiveHour.usedPercentage, resetsAt: checked.limits.fiveHour.resetsAt },
    { id: "all-models", label: "All models", window: "7 days", percent: checked.limits.sevenDay.usedPercentage, resetsAt: checked.limits.sevenDay.resetsAt },
  ].map((limit) => ({ ...limit, severity: usageLimitSeverity(limit.percent), active: limit.percent >= 100 }));
  return {
    available: true,
    fetchedAt: checked.observedAt,
    attemptedAt: attemptedAt || checked.observedAt,
    failureKind: null,
    retryAt: null,
    error: "",
    limits,
    origin: "local_observation",
    freshness,
  };
}
