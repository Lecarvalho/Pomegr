import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { usageLimitSeverity } from "../../shared/usage-limit-severity.mjs";

const CACHE_FILE = "claude-api.json";
const CACHE_VERSION = 1;
const MAX_CACHE_BYTES = 8_192;
// Credential files are only fingerprinted. This bound admits normal Claude
// credential stores while rejecting an implausibly large metadata source.
const MAX_CREDENTIAL_BYTES = 1_048_576;
const MAX_TIMESTAMP_MS = Date.parse("2100-01-01T00:00:00.000Z");
const MAX_CLOCK_SKEW_MS = 60_000;
const FAILURE_KINDS = new Set(["authentication_required", "rate_limited", "unavailable"]);
const LIMIT_ORDER = ["current-session", "all-models", "model-fable"];
const STORAGE_KEYS = ["version", "sourceFingerprint", "fetchedAt", "attemptedAt", "failureKind", "nextAttemptAt", "limits"];
const LIMIT_KEYS = ["id", "percent", "resetsAt", "active"];

function ownKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : null;
}

function exactKeys(value, expected) {
  const keys = ownKeys(value);
  return Boolean(keys && keys.length === expected.length && expected.every((key) => keys.includes(key)));
}

function currentTime(now) {
  let value;
  try { value = typeof now === "function" ? now() : now; } catch { return Number.NaN; }
  if (value instanceof Date) value = value.getTime();
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function canonicalTimestamp(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_TIMESTAMP_MS) return null;
  return new Date(milliseconds).toISOString() === value ? value : null;
}

function canonicalInputTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_TIMESTAMP_MS) return null;
  return new Date(milliseconds).toISOString();
}

function canonicalEpochMilliseconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)
    || value < 0 || value > MAX_TIMESTAMP_MS) return null;
  return new Date(value).toISOString();
}

function fixedError(failureKind) {
  if (failureKind === "authentication_required") return "Anthropic usage endpoint returned 401";
  if (failureKind === "rate_limited") return "Anthropic usage endpoint returned 429";
  if (failureKind === "unavailable") return "Claude usage refresh failed.";
  return "";
}

function credentialsPath(configDir) {
  if (typeof configDir !== "string" || !configDir) return null;
  try { return path.resolve(configDir, ".credentials.json"); } catch { return null; }
}

function computeFingerprint(configDir) {
  const file = credentialsPath(configDir);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || !Number.isFinite(stat.size) || stat.size < 1 || stat.size > MAX_CREDENTIAL_BYTES) return null;
    const fields = ["dev", "ino", "size", "birthtimeMs", "mtimeMs", "ctimeMs"];
    if (fields.some((field) => typeof stat[field] !== "number" || !Number.isFinite(stat[field]) || stat[field] < 0)) return null;
    const identity = JSON.stringify({
      path: file,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      birthtimeMs: stat.birthtimeMs,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    });
    return crypto.createHash("sha256").update(identity, "utf8").digest("hex");
  } catch { return null; }
}

function validFingerprint(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function normalizedStoredLimit(limit) {
  if (!exactKeys(limit, LIMIT_KEYS)) return null;
  if (!LIMIT_ORDER.includes(limit.id) || typeof limit.percent !== "number" || !Number.isFinite(limit.percent)
    || limit.percent < 0 || limit.percent > 100 || typeof limit.active !== "boolean") return null;
  const resetsAt = canonicalTimestamp(limit.resetsAt, { nullable: true });
  if (resetsAt === null && limit.resetsAt !== null) return null;
  return { id: limit.id, percent: limit.percent, resetsAt, active: limit.active };
}

function normalizedStorage(value, expectedFingerprint, nowValue) {
  if (!exactKeys(value, STORAGE_KEYS) || value.version !== CACHE_VERSION || value.sourceFingerprint !== expectedFingerprint
    || !validFingerprint(value.sourceFingerprint)) return null;
  const fetchedAt = canonicalTimestamp(value.fetchedAt, { nullable: true });
  if (fetchedAt === null && value.fetchedAt !== null) return null;
  const attemptedAt = canonicalTimestamp(value.attemptedAt);
  const nextAttemptAt = canonicalTimestamp(value.nextAttemptAt);
  if (!attemptedAt || !nextAttemptAt) return null;
  const attemptedMs = Date.parse(attemptedAt);
  const fetchedMs = fetchedAt === null ? null : Date.parse(fetchedAt);
  const nextMs = Date.parse(nextAttemptAt);
  if (fetchedMs !== null && fetchedMs > attemptedMs) return null;
  if (Number.isFinite(nowValue) && (attemptedMs > nowValue + MAX_CLOCK_SKEW_MS || (fetchedMs !== null && fetchedMs > nowValue + MAX_CLOCK_SKEW_MS))) return null;
  if (nextMs < attemptedMs) return null;
  if (!FAILURE_KINDS.has(value.failureKind) && value.failureKind !== null) return null;
  if (!Array.isArray(value.limits) || value.limits.length > LIMIT_ORDER.length) return null;
  const limits = value.limits.map(normalizedStoredLimit);
  if (limits.some((limit) => !limit) || new Set(limits.map((limit) => limit.id)).size !== limits.length) return null;
  if (limits.length > 0 && fetchedAt === null) return null;
  if (value.failureKind === null && (fetchedAt === null || fetchedAt !== attemptedAt)) return null;
  if (!Number.isFinite(nowValue)) return null;
  return { version: CACHE_VERSION, sourceFingerprint: value.sourceFingerprint, fetchedAt, attemptedAt, failureKind: value.failureKind, nextAttemptAt, limits };
}

function normalizeInput(value, expectedFingerprint, nextAttemptAt, nowValue) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !validFingerprint(expectedFingerprint)) return null;
  const nextAttemptAtIso = canonicalEpochMilliseconds(nextAttemptAt);
  if (!nextAttemptAtIso || !Number.isFinite(nowValue)) return null;
  if (!Array.isArray(value.limits) || value.limits.length > LIMIT_ORDER.length) return null;
  const limits = value.limits.map((limit) => {
    if (!limit || typeof limit !== "object" || Array.isArray(limit)) return null;
    const resetsAt = canonicalInputTimestamp(limit.resetsAt);
    if (resetsAt === null && limit.resetsAt !== null) return null;
    return normalizedStoredLimit({ id: limit.id, percent: limit.percent, resetsAt, active: limit.active });
  });
  if (limits.some((limit) => !limit)) return null;
  return normalizedStorage({
    version: CACHE_VERSION,
    sourceFingerprint: expectedFingerprint,
    fetchedAt: value.fetchedAt,
    attemptedAt: value.attemptedAt,
    failureKind: value.failureKind,
    nextAttemptAt: nextAttemptAtIso,
    limits,
  }, expectedFingerprint, nowValue);
}

function publicValue(stored) {
  const limits = stored.limits.slice().sort((left, right) => LIMIT_ORDER.indexOf(left.id) - LIMIT_ORDER.indexOf(right.id)).map((limit) => {
    const label = limit.id === "current-session" ? "Current session" : limit.id === "all-models" ? "All models" : "Fable";
    return {
      id: limit.id,
      label,
      window: limit.id === "current-session" ? "5 hours" : "7 days",
      percent: limit.percent,
      resetsAt: limit.resetsAt,
      severity: usageLimitSeverity(limit.percent),
      active: limit.active,
    };
  });
  const failed = stored.failureKind !== null;
  return {
    available: limits.length > 0,
    fetchedAt: stored.fetchedAt,
    attemptedAt: stored.attemptedAt,
    failureKind: stored.failureKind,
    retryAt: failed ? stored.nextAttemptAt : null,
    error: fixedError(stored.failureKind),
    limits,
    origin: "provider_api",
    freshness: "stale",
  };
}

/** A bounded, credential-metadata-bound cache for sanitized Claude API usage. */
/** @param {{ root?: string, configDir?: string, now?: () => number }} [options] */
export function createClaudeUsageApiCache({ root, configDir, now = () => Date.now() } = {}) {
  const cacheRoot = typeof root === "string" && root ? path.resolve(root) : null;
  const file = cacheRoot ? path.join(cacheRoot, CACHE_FILE) : null;
  const fingerprint = () => computeFingerprint(configDir);

  return {
    fingerprint,
    read(expectedFingerprint) {
      if (!file || !validFingerprint(expectedFingerprint)) return null;
      try {
        if (fingerprint() !== expectedFingerprint) return null;
        const nowValue = currentTime(now);
        if (!Number.isFinite(nowValue)) return null;
        const fd = fs.openSync(file, "r");
        let bytesRead = 0;
        let contents;
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CACHE_BYTES) return null;
          const buffer = Buffer.allocUnsafe(MAX_CACHE_BYTES + 1);
          bytesRead = fs.readSync(fd, buffer, 0, MAX_CACHE_BYTES + 1, 0);
          if (bytesRead > MAX_CACHE_BYTES || fs.fstatSync(fd).size > MAX_CACHE_BYTES) return null;
          contents = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
        if (fingerprint() !== expectedFingerprint) return null;
        const stored = normalizedStorage(JSON.parse(contents), expectedFingerprint, nowValue);
        if (!stored) return null;
        return { value: publicValue(stored), nextAttemptAt: Date.parse(stored.nextAttemptAt) };
      } catch { return null; }
    },
    write(value, nextAttemptAt, expectedFingerprint) {
      if (!file || !validFingerprint(expectedFingerprint)) return false;
      try {
        if (fingerprint() !== expectedFingerprint) return false;
        const stored = normalizeInput(value, expectedFingerprint, nextAttemptAt, currentTime(now));
        if (!stored) return false;
        const serialized = `${JSON.stringify(stored)}\n`;
        if (Buffer.byteLength(serialized, "utf8") > MAX_CACHE_BYTES) return false;
        fs.mkdirSync(cacheRoot, { recursive: true });
        const temporary = path.join(cacheRoot, `.${CACHE_FILE}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
        try {
          fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
          try { fs.chmodSync(temporary, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
          if (fingerprint() !== expectedFingerprint) return false;
          fs.renameSync(temporary, file);
        } finally {
          try { fs.unlinkSync(temporary); } catch { /* Atomic replacement already consumed it. */ }
        }
        return true;
      } catch { return false; }
    },
  };
}
