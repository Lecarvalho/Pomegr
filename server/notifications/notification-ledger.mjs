import { createHash, randomBytes } from "node:crypto";
import { NOTIFICATION_RULES, createNotificationRuleRegistry, opaqueNotificationId, sourceReadiness } from "./notification-rules.mjs";

export const NOTIFICATION_MAX_OCCURRENCES = 200;
export const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const NOTIFICATION_MAX_BYTES = 1024 * 1024;
export const NOTIFICATION_MAX_ACTIVE_SESSIONS = 100;
const MAX_PRIVATE_EVIDENCE_KEYS = 300;

function iso(now) { const value = now(); if (!Number.isFinite(value)) throw new TypeError("Invalid clock"); return new Date(value).toISOString(); }
function stable(value) { return JSON.stringify(value); }
function freezeSnapshot(value) {
  const snapshot = structuredClone(value);
  Object.freeze(snapshot.readiness);
  for (const row of snapshot.occurrences) { Object.freeze(row.data); Object.freeze(row); }
  Object.freeze(snapshot.occurrences);
  return Object.freeze(snapshot);
}
function sourceRevision(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function providerReadiness(input) {
  const states = Array.isArray(input.providers) ? input.providers.map((row) => row.readiness === "ready" && row.freshness !== "fresh" ? "stale" : sourceReadiness(row.readiness)) : [];
  return states.length && states.every((state) => state === "ready") ? "ready"
    : states.includes("ready") ? "partial" : states.includes("unavailable") ? "unavailable"
      : states.includes("stale") ? "stale" : states.includes("loading") ? "loading" : "unavailable";
}
function privateScope(value) {
  if (value === undefined) value = "default";
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("Invalid private source scope");
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Accepts already committed normalized facts; it performs no acquisition.
 * One accepted batch is transactional. Exceptions preserve the prior snapshot.
 * The runtime may persist its bounded exported comparison state after each commit.
 */
export function createNotificationLedger({ now = Date.now, rules = NOTIFICATION_RULES, onUpdate = () => {}, onCommit = () => {} } = {}) {
  const registry = createNotificationRuleRegistry(rules);
  let active = new Map(); // private rule/scope/key -> occurrence ID
  let baselines = new Set(); // private rule/scope
  let lastEvidence = new Map(); // private rule/scope/key -> observed timestamp
  let sourceVersions = new Map(); // private rule/scope -> committed revision
  let usageState = null;
  let sequence = 0;
  let identitySeed = randomBytes(16).toString("hex");
  let snapshot = freezeSnapshot({ version: 1, revision: 0, generatedAt: null,
    readiness: { catalog: "loading", providerStatus: "loading" }, occurrences: [], activeSessionOverflow: 0 });
  const listeners = new Set();

  function acceptFacts(facts = {}) {
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) throw new TypeError("Invalid notification facts");
    const clockIso = iso(now);
    const clockMs = Date.parse(clockIso);
    const nextActive = new Map(active);
    const nextBaselines = new Set(baselines);
    const nextEvidence = new Map(lastEvidence);
    const nextVersions = new Map(sourceVersions);
    let nextSequence = sequence;
    let nextUsageState = usageState;
    let rows = snapshot.occurrences.map((row) => ({ ...row, data: { ...row.data } }));
    const nextReadiness = { ...snapshot.readiness };
    let overflow = snapshot.activeSessionOverflow;

    for (const rule of registry) {
      const input = facts[rule.source];
      if (input === undefined) continue;
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid source facts");
      const scope = privateScope(input.sourceScope);
      const group = `${rule.kind}\0${scope}`;
      const revision = sourceRevision(input.revision);
      if (revision !== null && nextVersions.has(group) && revision <= nextVersions.get(group)) continue;
      const result = rule.derive(input, rule.source === "usage" ? nextUsageState : undefined, clockMs);
      const derived = rule.occurrence ? result.items : result;
      if (rule.source === "usage") nextUsageState = result.state;
      if (!Array.isArray(derived) || derived.length > 1000) throw new TypeError("Invalid derived notification facts");
      const ready = rule.occurrence || (rule.source === "catalog" ? input.readiness === "ready" : derived.length > 0);
      // A source/profile switch retires all of that producer's old history at
      // once, including when the new source has no usable evidence yet.
      for (const old of [...nextBaselines]) {
        if (!old.startsWith(`${rule.kind}\0`) || old === group) continue;
        nextBaselines.delete(old);
        nextVersions.delete(old);
        rows = rows.filter((row) => row.kind !== rule.kind && row.kind !== rule.recovery?.kind);
        if (rule.source === "catalog") overflow = 0;
        for (const key of [...nextActive.keys()]) if (key.startsWith(`${old}\0`)) nextActive.delete(key);
        for (const key of [...nextEvidence.keys()]) if (key.startsWith(`${old}\0`)) nextEvidence.delete(key);
      }
      // A failed or incomplete observation cannot establish a new private source.
      // Readiness still reaches clients for an already established source.
      if (!ready) {
        if (rule.source === "catalog") nextReadiness.catalog = sourceReadiness(input.readiness);
        else if (rule.source === "providerStatus") nextReadiness.providerStatus = providerReadiness(input);
        continue;
      }
      if (rule.source === "catalog") {
        nextReadiness.catalog = sourceReadiness(input.readiness);
        if (input.readiness === "ready") {
          overflow = Number.isSafeInteger(input.activeSessionOverflow) && input.activeSessionOverflow >= 0
            ? Math.min(input.activeSessionOverflow, 1_000_000) : 0;
        }
      } else if (rule.source === "providerStatus") {
        nextReadiness.providerStatus = providerReadiness(input);
      }
      const seen = new Set();
      const baseline = !nextBaselines.has(group);
      for (const item of derived) {
        if (!item || typeof item.key !== "string" || !item.key || item.key.length > 160 || seen.has(item.key)
          || typeof item.active !== "boolean" || !["claude", "codex"].includes(item.provider)
          || !item.data || typeof item.data !== "object" || Array.isArray(item.data)) throw new TypeError("Invalid derived notification fact");
        seen.add(item.key);
        const key = `${group}\0${item.key}`;
        const observed = item.observedAt || item.at || clockIso;
        const observedMs = Date.parse(observed);
        if (!Number.isFinite(observedMs) || observedMs > clockMs + 60_000) continue;
        if (nextEvidence.has(key) && observedMs < nextEvidence.get(key)) continue;
        nextEvidence.set(key, observedMs);
        if (rule.occurrence) {
          if (!rule.kinds.includes(item.kind)) throw new TypeError("Invalid occurrence kind");
          const policy = rule.policies?.[item.kind] || rule;
          const id = opaqueNotificationId(item.kind, key, `${identitySeed}:${++nextSequence}`);
          rows.unshift({ id, kind: item.kind, category: policy.category, severity: policy.severity,
            lifecycle: "resolved", priority: policy.priority, occurredAt: item.at, timeBasis: "observed",
            deliveryEligible: true, action: policy.action, provider: item.provider, data: { ...item.data } });
          continue;
        }
        const previousId = nextActive.get(key);
        if (item.active) {
          if (previousId) {
            const row = rows.find((value) => value.id === previousId);
            if (row) row.data = { ...item.data };
            continue;
          }
          if (rule.kind === "needs_input" && [...nextActive.keys()].filter((value) => value.startsWith("needs_input\0")).length >= NOTIFICATION_MAX_ACTIVE_SESSIONS) {
            overflow = Math.min(1_000_000, overflow + 1);
            continue;
          }
          const id = opaqueNotificationId(rule.kind, key, `${identitySeed}:${++nextSequence}`);
          rows.unshift({ id, kind: rule.kind, category: rule.category, severity: rule.severity,
            lifecycle: "active", priority: rule.priority, occurredAt: item.at || clockIso,
            timeBasis: item.at ? "recorded" : "observed", deliveryEligible: !baseline && rule.delivery === "native_eligible",
            action: rule.action, provider: item.provider, data: { ...item.data } });
          nextActive.set(key, id);
        } else if (previousId) {
          const row = rows.find((value) => value.id === previousId);
          if (row) row.lifecycle = "resolved";
          nextActive.delete(key);
          if (rule.recovery) {
            const id = opaqueNotificationId(rule.recovery.kind, key, `${identitySeed}:${++nextSequence}`);
            rows.unshift({ id, kind: rule.recovery.kind, category: rule.category, severity: rule.recovery.severity,
              lifecycle: "resolved", priority: rule.priority, occurredAt: item.at || clockIso,
              timeBasis: item.at ? "recorded" : "observed", deliveryEligible: !baseline && rule.delivery === "native_eligible",
              action: rule.action, provider: item.provider, data: { ...rule.recovery.data } });
          }
        }
      }
      nextBaselines.add(group);
      if (revision !== null) nextVersions.set(group, revision);
    }

    rows = rows.filter((row) => row.lifecycle === "active" || clockMs - Date.parse(row.occurredAt) <= NOTIFICATION_RETENTION_MS);
    // Keep current conditions before retained history. Display priority must not
    // evict a still-active lower-priority condition and manufacture a recurrence.
    rows.sort((a, b) => Number(b.lifecycle === "active") - Number(a.lifecycle === "active") || Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    rows = rows.slice(0, NOTIFICATION_MAX_OCCURRENCES);
    // Keep a response below the serialized budget even if a future registered rule is too verbose.
    while (rows.length && Buffer.byteLength(stable(rows), "utf8") > NOTIFICATION_MAX_BYTES - 1024) rows.pop();
    rows.sort((a, b) => b.priority - a.priority || Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    const retained = new Set(rows.map((row) => row.id));
    for (const [key, id] of nextActive) if (!retained.has(id)) nextActive.delete(key);
    if (nextEvidence.size > MAX_PRIVATE_EVIDENCE_KEYS) {
      const inactive = [...nextEvidence].filter(([key]) => !nextActive.has(key)).sort((a, b) => a[1] - b[1]);
      for (const [key] of inactive) {
        if (nextEvidence.size <= MAX_PRIVATE_EVIDENCE_KEYS) break;
        nextEvidence.delete(key);
      }
    }
    const candidate = { version: 1, revision: snapshot.revision + 1, generatedAt: clockIso,
      readiness: nextReadiness, occurrences: rows, activeSessionOverflow: overflow };
    if (Buffer.byteLength(stable(candidate), "utf8") > NOTIFICATION_MAX_BYTES) throw new TypeError("Notification snapshot exceeds bound");
    const material = stable({ ...candidate, revision: 0, generatedAt: null }) !== stable({ ...snapshot, revision: 0, generatedAt: null });
    active = nextActive; baselines = nextBaselines; lastEvidence = nextEvidence; sourceVersions = nextVersions; sequence = nextSequence;
    usageState = nextUsageState;
    if (material) {
      snapshot = freezeSnapshot(candidate);
      try { onUpdate(snapshot); } catch { /* Subscriber failure cannot break catalog observation. */ }
      for (const listener of listeners) try { listener(snapshot); } catch { /* Independent consumers. */ }
    }
    try { onCommit(exportState()); } catch { /* Persistence failure cannot break committed observation. */ }
    return snapshot;
  }

  function exportState() {
    return { identitySeed, sequence, snapshot: structuredClone(snapshot),
      baselines: [...baselines], active: [...active], evidence: [...lastEvidence], usageState: structuredClone(usageState) };
  }

  function restore(state) {
    if (snapshot.revision !== 0 || baselines.size || active.size) throw new TypeError("Notification ledger already initialized");
    identitySeed = state.identitySeed;
    sequence = state.sequence;
    baselines = new Set(state.baselines);
    active = new Map(state.active);
    lastEvidence = new Map(state.evidence);
    usageState = structuredClone(state.usageState ?? null);
    // Producer revisions are process-local clocks. The first fresh commit after
    // restart must compare against restored conditions regardless of its number.
    sourceVersions = new Map();
    snapshot = freezeSnapshot(state.snapshot);
    try { onUpdate(snapshot); } catch { /* Subscriber failure cannot break restore. */ }
    return snapshot;
  }

  return Object.freeze({ acceptFacts, restore, exportState, readSnapshot: () => snapshot,
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("Invalid notification listener");
      listeners.add(listener);
      return () => listeners.delete(listener);
    } });
}
