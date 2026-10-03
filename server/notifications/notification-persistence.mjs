import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { isSafeSessionId } from "./notification-rules.mjs";
import { NOTIFICATION_MAX_ACTIVE_SESSIONS, NOTIFICATION_MAX_BYTES, NOTIFICATION_MAX_OCCURRENCES, NOTIFICATION_RETENTION_MS } from "./notification-ledger.mjs";

const VERSION = 1;
const FILE = "notifications-v1.json";
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[a-f0-9]{32}$/u;
const SEED = /^[a-f0-9]{32}$/u;
const READINESS = new Set(["loading", "ready", "partial", "stale", "unavailable"]);
const STATUS = new Set(["degraded", "outage", "maintenance"]);
const MAX_BASELINES = 16;
const MAX_EVIDENCE = 300;
const MAX_KEY = 300;

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function iso(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function group(value) {
  return typeof value === "string" && /^(needs_input|provider_incident)\u0000[a-f0-9]{64}$/u.test(value);
}
function evidenceKey(value) {
  if (typeof value !== "string" || value.length > MAX_KEY) return false;
  const parts = value.split("\u0000");
  if (parts.length !== 3 || !group(`${parts[0]}\u0000${parts[1]}`)) return false;
  return parts[0] === "needs_input" ? isSafeSessionId(parts[2]) : ["claude", "codex"].includes(parts[2]);
}
function validRow(row) {
  const keys = ["id", "kind", "category", "severity", "lifecycle", "priority", "occurredAt", "timeBasis", "deliveryEligible", "action", "provider", "data"];
  if (!exact(row, keys) || typeof row.id !== "string" || !ID.test(row.id) || !["active", "resolved"].includes(row.lifecycle)
    || !Number.isSafeInteger(row.priority) || row.priority < 0 || row.priority > 100
    || !iso(row.occurredAt) || !["recorded", "observed"].includes(row.timeBasis)
    || typeof row.deliveryEligible !== "boolean" || !["claude", "codex"].includes(row.provider)) return false;
  if (row.kind === "needs_input") return row.category === "attention" && row.severity === "warning"
    && row.action === "open_session" && row.priority === 100
    && exact(row.data, ["sessionId", "sessionTitle"]) && isSafeSessionId(row.data.sessionId)
    && row.data.sessionId.startsWith(`${row.provider}:`)
    && typeof row.data.sessionTitle === "string" && row.data.sessionTitle.length <= 96
    && !/[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(row.data.sessionTitle);
  return ["provider_incident", "provider_recovery"].includes(row.kind)
    && row.category === "provider_service" && row.action === "open_providers" && row.priority === 70
    && row.severity === (row.kind === "provider_incident" ? "warning" : "info")
    && row.lifecycle === (row.kind === "provider_recovery" ? "resolved" : row.lifecycle)
    && exact(row.data, ["status"])
    && (row.kind === "provider_recovery" ? row.data.status === "operational" : STATUS.has(row.data.status));
}

/** Full-record validation. No partial salvage: a bad record cannot supply comparison state. */
export function normalizeNotificationPersistence(value, expectedProfile, now = Date.now()) {
  if (typeof expectedProfile !== "string" || !HASH.test(expectedProfile)
    || !exact(value, ["version", "profileScope", "identitySeed", "sequence", "snapshot", "baselines", "active", "evidence"])
    || value.version !== VERSION || typeof value.profileScope !== "string" || !HASH.test(value.profileScope)
    || typeof value.identitySeed !== "string" || !SEED.test(value.identitySeed)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return null;
  const snapshot = value.snapshot;
  if (!exact(snapshot, ["version", "revision", "generatedAt", "readiness", "occurrences", "activeSessionOverflow"])
    || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    || (snapshot.generatedAt !== null && !iso(snapshot.generatedAt))
    || (snapshot.revision === 0) !== (snapshot.generatedAt === null)
    || !exact(snapshot.readiness, ["catalog", "providerStatus"])
    || !READINESS.has(snapshot.readiness.catalog) || !READINESS.has(snapshot.readiness.providerStatus)
    || !Number.isSafeInteger(snapshot.activeSessionOverflow) || snapshot.activeSessionOverflow < 0 || snapshot.activeSessionOverflow > 1_000_000
    || !Array.isArray(snapshot.occurrences) || snapshot.occurrences.length > NOTIFICATION_MAX_OCCURRENCES
    || snapshot.occurrences.some((row) => !validRow(row))) return null;
  const ids = new Set(snapshot.occurrences.map((row) => row.id));
  if (ids.size !== snapshot.occurrences.length || value.sequence < ids.size
    || snapshot.occurrences.filter((row) => row.kind === "needs_input" && row.lifecycle === "active").length > NOTIFICATION_MAX_ACTIVE_SESSIONS) return null;
  if (!Array.isArray(value.baselines) || value.baselines.length > MAX_BASELINES || value.baselines.some((entry) => !group(entry))
    || new Set(value.baselines).size !== value.baselines.length
    || !Array.isArray(value.active) || value.active.length > NOTIFICATION_MAX_ACTIVE_SESSIONS + 2
    || !Array.isArray(value.evidence) || value.evidence.length > MAX_EVIDENCE) return null;
  const activeKeys = new Set();
  const activeIds = new Set();
  for (const pair of value.active) {
    if (!Array.isArray(pair) || pair.length !== 2 || !evidenceKey(pair[0]) || typeof pair[1] !== "string" || !ID.test(pair[1])
      || activeKeys.has(pair[0]) || activeIds.has(pair[1])) return null;
    const row = snapshot.occurrences.find((item) => item.id === pair[1]);
    const parts = pair[0].split("\u0000");
    if (!row || row.lifecycle !== "active" || row.kind !== parts[0]
      || (row.kind === "needs_input" ? row.data.sessionId !== parts[2] : row.provider !== parts[2])
      || !value.baselines.includes(`${parts[0]}\u0000${parts[1]}`)) return null;
    activeKeys.add(pair[0]); activeIds.add(pair[1]);
  }
  if (snapshot.occurrences.some((row) => row.lifecycle === "active" && !activeIds.has(row.id))) return null;
  const evidenceKeys = new Set();
  for (const pair of value.evidence) {
    if (!Array.isArray(pair) || pair.length !== 2 || !evidenceKey(pair[0]) || evidenceKeys.has(pair[0])
      || !Number.isSafeInteger(pair[1]) || pair[1] < 0 || pair[1] > now + 60_000) return null;
    evidenceKeys.add(pair[0]);
  }
  if ([...activeKeys].some((key) => !evidenceKeys.has(key))) return null;
  const cutoff = now - NOTIFICATION_RETENTION_MS;
  const retained = snapshot.occurrences.filter((row) => row.lifecycle === "active" || Date.parse(row.occurredAt) >= cutoff);
  const normalized = { identitySeed: value.identitySeed, sequence: value.sequence,
    snapshot: { ...snapshot, occurrences: retained }, baselines: value.baselines,
    active: value.active, evidence: value.evidence };
  return { profileMatches: value.profileScope === expectedProfile, state: normalized };
}

/** Atomically replaces one monitor-private normalized ledger; invalid/newer files are protected. */
export function createNotificationPersistence({ directory, profileScope, now = Date.now, filesystem = fs } = {}) {
  if (typeof directory !== "string" || !directory || typeof profileScope !== "string" || !HASH.test(profileScope)) throw new TypeError("Invalid notification persistence configuration");
  const target = path.join(directory, FILE);
  let writable = false;
  let loaded = false;
  let pending = null;
  let writing = false;
  const drainWaiters = [];
  async function load() {
    if (loaded) throw new TypeError("Notification persistence already loaded");
    loaded = true;
    try {
      const info = await filesystem.stat(target);
      if (info.size > NOTIFICATION_MAX_BYTES) return { status: "invalid", state: null };
      const contents = await filesystem.readFile(target, "utf8");
      if (Buffer.byteLength(contents, "utf8") > NOTIFICATION_MAX_BYTES) return { status: "invalid", state: null };
      const parsed = JSON.parse(contents);
      const normalized = normalizeNotificationPersistence(parsed, profileScope, now());
      if (!normalized) return { status: "invalid", state: null };
      writable = true;
      return normalized.profileMatches ? { status: "restored", state: normalized.state }
        : { status: "profile_changed", state: null };
    } catch (error) {
      if (error?.code === "ENOENT") { writable = true; return { status: "missing", state: null }; }
      return { status: "invalid", state: null };
    }
  }
  async function replace(serialized) {
    let temporary;
    try {
      await filesystem.mkdir(directory, { recursive: true });
      temporary = path.join(directory, `.${FILE}.${randomUUID()}.tmp`);
      await filesystem.writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await filesystem.rename(temporary, target);
      return true;
    } catch { return false; }
    finally { if (temporary) await filesystem.unlink(temporary).catch(() => {}); }
  }
  async function pump() {
    if (writing) return;
    writing = true;
    while (pending) {
      const current = pending;
      pending = null;
      const result = await replace(current.serialized);
      for (const resolve of current.resolvers) resolve(result);
    }
    writing = false;
    for (const resolve of drainWaiters.splice(0)) resolve();
  }
  function write(state) {
    if (!loaded || !writable) return Promise.resolve(false);
    const record = { version: VERSION, profileScope, ...state };
    const normalized = normalizeNotificationPersistence(record, profileScope, now());
    if (!normalized) return Promise.resolve(false);
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > NOTIFICATION_MAX_BYTES) return Promise.resolve(false);
    return new Promise((resolve) => {
      if (pending) for (const previous of pending.resolvers) previous(false);
      pending = { serialized, resolvers: [resolve] };
      queueMicrotask(() => { void pump(); });
    });
  }
  function drain() {
    if (!writing && !pending) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.push(resolve));
  }
  return Object.freeze({ load, write, drain, writable: () => writable });
}
