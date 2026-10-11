import { mergeSessionEventRecord, sessionEventRecordIsEmpty } from "./session-event-record.mjs";
import {
  liveRepositoryFiles, projectSessionDomains, sessionDomainCatalogInputs, unavailableSessionDomains,
  UNAVAILABLE_SESSION_DOMAIN_CATALOG_FIELDS,
} from "./session-domain-projection.mjs";

export const SESSION_DOMAIN_NAMES = Object.freeze([
  "session-summary", "agents", "agent", "signals", "repository", "resources", "details",
]);
const SESSION_DOMAIN_SET = new Set(SESSION_DOMAIN_NAMES);
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const DEFAULT_MAX_SESSIONS = 24;
const DEFAULT_IDLE_MS = 10 * 60_000;
const MAX_PROTECTED_SESSIONS = 128;

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function committedResponse(value, revision, observedAt) {
  const revisioned = freeze({ ...structuredClone(value), revision });
  return Object.freeze({
    revision,
    value: revisioned,
    serialized: JSON.stringify(revisioned),
    committedAt: observedAt,
  });
}
function semanticValue(value) {
  const semantic = { ...value };
  delete semantic.observedAt;
  return semantic;
}

function immutable(value) {
  return value === null || value === undefined || typeof value !== "object" || Object.isFrozen(value);
}
function immutableSnapshot(snapshot) {
  return Boolean(snapshot) && typeof snapshot === "object" && Object.isFrozen(snapshot)
    && Boolean(snapshot.publicState) && typeof snapshot.publicState === "object" && Object.isFrozen(snapshot.publicState)
    && immutable(snapshot.evidence) && immutable(snapshot.readiness);
}
// The inputs of one evidence projection, held only by identity or as short strings.
const EVIDENCE_INPUT_NAMES = Object.freeze([
  "catalogKey", "repositoryRoot", "repositoryUnavailableReason", "retainedResources", "fileHistory",
  "gitObserved", "commitTimes", "recordedEvents", "liveFilesKey",
]);
// A value that cannot be serialized has no key, so it is never taken as unchanged.
function comparableKey(value) {
  try { return JSON.stringify(value); } catch { return null; }
}
function evidenceInputs(snapshot, values) {
  if (!immutableSnapshot(snapshot) || typeof values.catalogKey !== "string") return null;
  for (const name of EVIDENCE_INPUT_NAMES) if (!immutable(values[name])) return null;
  return { kind: "evidence", snapshot: new WeakRef(snapshot), ...values };
}
function sameEvidenceInputs(previous, next, snapshot) {
  // A collected snapshot dereferences to undefined, which must never match a missing argument.
  if (!snapshot || !previous || !next || previous.kind !== "evidence" || previous.snapshot.deref() !== snapshot) return false;
  return EVIDENCE_INPUT_NAMES.every((name) => previous[name] === next[name]);
}

export function createSessionDomainStore(options = {}) {
  const now = options.now || Date.now;
  const maxSessions = Number.isSafeInteger(options.maxSessions)
    ? Math.max(1, Math.min(128, options.maxSessions)) : DEFAULT_MAX_SESSIONS;
  const idleMs = Number.isFinite(options.idleMs)
    ? Math.max(1_000, Math.min(60 * 60_000, options.idleMs)) : DEFAULT_IDLE_MS;
  const isProtected = typeof options.isProtected === "function" ? options.isProtected : () => false;
  let records = new Map();
  let revisionClocks = new Map(SESSION_DOMAIN_NAMES.map((domain) => [domain, 0]));
  const sessions = new Map();
  // Requests for a session without a committed projection yet.
  const pendingDemand = new Map();
  const lastCommitTimes = new Map();
  const lastEventRecords = new Map();
  const lastInputs = new Map();
  const counts = { projections: 0, unchangedInputs: 0, liveRepositoryValidations: 0 };
  const subscribers = new Set();

  function key(sessionId, domain) { return `${sessionId}\u0000${domain}`; }
  function publish(event) {
    for (const subscriber of subscribers) {
      try { subscriber(event); } catch { /* one subscriber cannot interrupt a commit */ }
    }
  }
  function protectedSession(sessionId) {
    try { return isProtected(sessionId) === true; } catch { return false; }
  }
  function lastUse(meta) { return Math.max(meta.changedAt, meta.demandedAt ?? -Infinity); }
  function mostRecentlyDemanded() {
    let selected = null;
    let selectedAt = -Infinity;
    for (const [sessionId, meta] of sessions) {
      if (meta.demandedAt !== null && meta.demandedAt >= selectedAt) {
        selected = sessionId;
        selectedAt = meta.demandedAt;
      }
    }
    return selected;
  }
  function evictSession(sessionId) {
    for (const domain of SESSION_DOMAIN_NAMES) records.delete(key(sessionId, domain));
    sessions.delete(sessionId);
    lastCommitTimes.delete(sessionId);
    lastEventRecords.delete(sessionId);
    lastInputs.delete(sessionId);
  }
  function evictIdle(at = now()) {
    const evicted = [];
    for (const [sessionId, meta] of sessions) {
      if (at - lastUse(meta) < idleMs) continue;
      evictSession(sessionId);
      evicted.push(sessionId);
    }
    for (const [sessionId, demandedAt] of pendingDemand) {
      if (at - demandedAt >= idleMs) pendingDemand.delete(sessionId);
    }
    return evicted;
  }
  function evictionOrder(candidates) {
    return candidates.sort((left, right) => {
      const a = sessions.get(left);
      const b = sessions.get(right);
      return (Number(a.demandedAt !== null) - Number(b.demandedAt !== null)) || lastUse(a) - lastUse(b);
    });
  }
  function enforceBound() {
    if (sessions.size <= maxSessions) return;
    const selected = mostRecentlyDemanded();
    const candidates = [...sessions.keys()].filter((sessionId) => sessionId !== selected);
    for (const sessionId of evictionOrder(candidates.filter((id) => !protectedSession(id)))) {
      if (sessions.size <= maxSessions) return;
      evictSession(sessionId);
    }
    // Protected sessions may exceed the soft bound, never the hard ceiling.
    for (const sessionId of evictionOrder(candidates.filter((id) => sessions.has(id)))) {
      if (sessions.size <= MAX_PROTECTED_SESSIONS) return;
      evictSession(sessionId);
    }
  }
  function recordDemand(sessionId, at) {
    const meta = sessions.get(sessionId);
    pendingDemand.delete(sessionId);
    if (meta) {
      meta.demandedAt = at;
      return;
    }
    pendingDemand.set(sessionId, at);
    while (pendingDemand.size > MAX_PROTECTED_SESSIONS) pendingDemand.delete(pendingDemand.keys().next().value);
  }
  function commitProjection(sessionId, projection, kind) {
    const existing = sessions.get(sessionId);
    // A placeholder never replaces a last-known-good evidence projection.
    if (kind === "unavailable" && existing?.kind === "evidence") return Object.freeze([]);
    const changed = [];
    const stagedRecords = new Map(records);
    const stagedClocks = new Map(revisionClocks);
    for (const domain of SESSION_DOMAIN_NAMES.filter((name) => name !== "agent")) {
      const recordKey = key(sessionId, domain);
      const candidate = projection.domains.get(domain);
      if (!candidate) continue;
      const comparable = JSON.stringify(semanticValue(candidate));
      const previous = records.get(recordKey);
      if (previous?.comparable === comparable) continue;
      const revision = (stagedClocks.get(domain) || 0) + 1;
      stagedClocks.set(domain, revision);
      const snapshot = committedResponse(candidate, revision, candidate.observedAt || new Date(now()).toISOString());
      stagedRecords.set(recordKey, { comparable, snapshot, agents: null });
      changed.push(Object.freeze({ domain, sessionId, revision }));
    }
    const agentKey = key(sessionId, "agent");
    const comparableAgents = [...projection.agentResponses].map(([agentId, value]) => [agentId, semanticValue(value)]);
    const agentCandidate = JSON.stringify(comparableAgents);
    const previousAgent = records.get(agentKey);
    if (previousAgent?.comparable !== agentCandidate) {
      const revision = (stagedClocks.get("agent") || 0) + 1;
      stagedClocks.set("agent", revision);
      const agents = new Map([...projection.agentResponses].map(([agentId, value]) => [
        agentId,
        committedResponse(value, revision, value.observedAt || new Date(now()).toISOString()),
      ]));
      stagedRecords.set(agentKey, { comparable: agentCandidate, snapshot: null, agents, revision });
      changed.push(Object.freeze({ domain: "agent", sessionId, revision }));
    }
    if (existing && changed.length === 0 && existing.kind === kind) return Object.freeze([]);
    const at = now();
    records = stagedRecords;
    revisionClocks = stagedClocks;
    if (existing) {
      if (changed.length > 0) existing.changedAt = at;
      existing.kind = kind;
    } else {
      sessions.set(sessionId, { changedAt: at, demandedAt: pendingDemand.get(sessionId) ?? null, kind });
      pendingDemand.delete(sessionId);
    }
    evictIdle(at);
    enforceBound();
    const retained = sessions.has(sessionId) ? changed : [];
    for (const event of retained) publish(event);
    return Object.freeze(retained);
  }
  return Object.freeze({
    commit(sessionId, snapshot, catalogEntry = null) {
      if (typeof sessionId !== "string" || sessionId.length < 3 || sessionId.length > 640) {
        throw new TypeError("Invalid session domain identity");
      }
      const recorded = options.repositoryRecordForSession?.(sessionId) ?? null;
      const commitTimes = Array.isArray(recorded?.commitTimes) ? recorded.commitTimes : lastCommitTimes.get(sessionId) ?? null;
      const lastEventRecord = lastEventRecords.get(sessionId) ?? null;
      const recordedEvents = options.eventRecordForSession?.(sessionId) ?? null;
      const projectionOptions = {
        catalogEntry: sessionDomainCatalogInputs(catalogEntry),
        forbiddenRoots: options.forbiddenRoots || [],
        repositoryRoot: options.repositoryRootForSession?.(sessionId) || null,
        repositoryUnavailableReason: options.repositoryUnavailableReasonForSession?.(sessionId) || null,
        retainedResources: options.retainedResourcesForSession?.(sessionId) ?? null,
        fileHistory: options.fileHistoryForSession?.(sessionId) ?? null,
        gitObserved: recorded?.gitObserved ?? null,
        commitTimes,
      };
      // The filesystem is not a committed input, so its answer is read again and compared.
      const liveFiles = liveRepositoryFiles(snapshot, projectionOptions);
      if (liveFiles) counts.liveRepositoryValidations += 1;
      const inputs = {
        catalogKey: comparableKey(projectionOptions.catalogEntry),
        repositoryRoot: projectionOptions.repositoryRoot,
        repositoryUnavailableReason: projectionOptions.repositoryUnavailableReason,
        retainedResources: projectionOptions.retainedResources,
        fileHistory: projectionOptions.fileHistory,
        gitObserved: projectionOptions.gitObserved,
        commitTimes,
        recordedEvents,
        liveFilesKey: liveFiles ? JSON.stringify(liveFiles) : null,
      };
      if (sameEvidenceInputs(lastInputs.get(sessionId), inputs, snapshot)) {
        counts.unchangedInputs += 1;
        return Object.freeze([]);
      }
      const eventRecord = mergeSessionEventRecord(lastEventRecord, recordedEvents);
      counts.projections += 1;
      const projection = projectSessionDomains(sessionId, snapshot, { ...projectionOptions, liveRepositoryFiles: liveFiles, eventRecord });
      const published = commitProjection(sessionId, projection, "evidence");
      const retained = sessions.has(sessionId);
      if (retained && Array.isArray(commitTimes)) lastCommitTimes.set(sessionId, commitTimes);
      if (retained) lastEventRecords.set(sessionId, projection.eventRecord);
      const settled = retained && projection.eventRecord === lastEventRecord ? evidenceInputs(snapshot, inputs) : null;
      if (settled) lastInputs.set(sessionId, settled);
      else lastInputs.delete(sessionId);
      if (projection.eventRecord !== lastEventRecord && !sessionEventRecordIsEmpty(projection.eventRecord)) options.onEventRecord?.(sessionId, projection.eventRecord);
      return published;
    },
    commitUnavailable(sessionId, catalogEntry, source, capabilities) {
      if (sessions.get(sessionId)?.kind === "evidence") return Object.freeze([]);
      // The placeholder derives from the row, the provider's label, and its capabilities only.
      const key = comparableKey([sessionDomainCatalogInputs(catalogEntry, UNAVAILABLE_SESSION_DOMAIN_CATALOG_FIELDS), source ?? null, capabilities ?? null]);
      const previous = lastInputs.get(sessionId);
      if (key !== null && previous?.kind === "unavailable" && previous.key === key) {
        counts.unchangedInputs += 1;
        return Object.freeze([]);
      }
      counts.projections += 1;
      const published = commitProjection(sessionId, unavailableSessionDomains(sessionId, catalogEntry, source, capabilities, {
        forbiddenRoots: options.forbiddenRoots || [],
      }), "unavailable");
      if (sessions.get(sessionId)?.kind === "unavailable") lastInputs.set(sessionId, { kind: "unavailable", key });
      else lastInputs.delete(sessionId);
      return published;
    },
    read(sessionId, domain, agentId, revision) {
      if (!SESSION_DOMAIN_SET.has(domain)) return Object.freeze({ status: "invalid", revision: 0, snapshot: null });
      const at = now();
      evictIdle(at);
      recordDemand(sessionId, at);
      options.onDemand?.(sessionId);
      const record = records.get(key(sessionId, domain));
      if (!record) return Object.freeze({ status: "empty", revision: 0, snapshot: null });
      if (domain === "agent") {
        const validAgentId = typeof agentId === "string" && SAFE_AGENT_ID.test(agentId);
        const snapshot = validAgentId ? record.agents?.get(agentId) || null : null;
        if (!snapshot) return Object.freeze({ status: "unavailable", revision: record.revision || 0, snapshot: null });
        return Object.freeze({ status: Number(revision) === snapshot.revision ? "unchanged" : "ready", revision: snapshot.revision, snapshot });
      }
      return Object.freeze({
        status: Number(revision) === record.snapshot.revision ? "unchanged" : "ready",
        revision: record.snapshot.revision,
        snapshot: record.snapshot,
      });
    },
    subscribe(subscriber) {
      if (typeof subscriber !== "function") throw new TypeError("Session domain subscriber must be a function");
      subscribers.add(subscriber);
      for (const [recordKey, record] of records) {
        const separator = recordKey.lastIndexOf("\u0000");
        const sessionId = recordKey.slice(0, separator);
        const domain = recordKey.slice(separator + 1);
        const revision = record.snapshot?.revision || record.revision || 0;
        subscriber(Object.freeze({ domain, sessionId, revision }));
      }
      return () => subscribers.delete(subscriber);
    },
    evictIdle,
    agentLabel(sessionId, agentId) {
      if (typeof agentId !== "string" || !SAFE_AGENT_ID.test(agentId)) return null;
      const agents = records.get(key(sessionId, "agents"))?.snapshot?.value?.agents;
      const label = Array.isArray(agents) ? agents.find((agent) => agent?.id === agentId)?.label : null;
      return typeof label === "string" && label ? label : null;
    },
    has(sessionId) { return sessions.has(sessionId); },
    sessionIds() { return Object.freeze([...sessions.keys()]); },
    size() { return sessions.size; },
    stats() { return Object.freeze({ ...counts }); },
    clear() { records.clear(); sessions.clear(); pendingDemand.clear(); lastCommitTimes.clear(); lastEventRecords.clear(); lastInputs.clear(); },
  });
}
