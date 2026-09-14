import { projectSessionDomains, unavailableSessionDomains } from "./session-domain-projection.mjs";

export const SESSION_DOMAIN_NAMES = Object.freeze([
  "session-summary", "agents", "agent", "signals", "repository", "resources", "details",
]);
const SESSION_DOMAIN_SET = new Set(SESSION_DOMAIN_NAMES);
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const DEFAULT_MAX_SESSIONS = 24;
const DEFAULT_IDLE_MS = 10 * 60_000;

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

/** Independently revisioned D projections. S reads exact committed JSON only. */
export function createSessionDomainStore(options = {}) {
  const now = options.now || Date.now;
  const maxSessions = Number.isSafeInteger(options.maxSessions)
    ? Math.max(1, Math.min(128, options.maxSessions)) : DEFAULT_MAX_SESSIONS;
  const idleMs = Number.isFinite(options.idleMs)
    ? Math.max(1_000, Math.min(60 * 60_000, options.idleMs)) : DEFAULT_IDLE_MS;
  let records = new Map();
  let revisionClocks = new Map(SESSION_DOMAIN_NAMES.map((domain) => [domain, 0]));
  const accessedAt = new Map();
  const subscribers = new Set();

  function key(sessionId, domain) { return `${sessionId}\u0000${domain}`; }
  function publish(event) {
    for (const subscriber of subscribers) {
      try { subscriber(event); } catch { /* one subscriber cannot interrupt a commit */ }
    }
  }
  function evictSession(sessionId) {
    for (const domain of SESSION_DOMAIN_NAMES) records.delete(key(sessionId, domain));
    accessedAt.delete(sessionId);
  }
  function evictIdle(at = now()) {
    const evicted = [];
    for (const [sessionId, touchedAt] of accessedAt) {
      if (at - touchedAt < idleMs) continue;
      evictSession(sessionId);
      evicted.push(sessionId);
    }
    return evicted;
  }
  function enforceBound() {
    while (accessedAt.size > maxSessions) {
      const oldest = [...accessedAt.entries()].sort((left, right) => left[1] - right[1])[0]?.[0];
      if (!oldest) break;
      evictSession(oldest);
    }
  }
  function commitProjection(sessionId, projection) {
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
    records = stagedRecords;
    revisionClocks = stagedClocks;
    accessedAt.delete(sessionId);
    accessedAt.set(sessionId, now());
    evictIdle();
    enforceBound();
    for (const event of changed) publish(event);
    return Object.freeze(changed);
  }
  return Object.freeze({
    commit(sessionId, snapshot, catalogEntry = null) {
      if (typeof sessionId !== "string" || sessionId.length < 3 || sessionId.length > 640) {
        throw new TypeError("Invalid session domain identity");
      }
      return commitProjection(sessionId, projectSessionDomains(sessionId, snapshot, {
        catalogEntry,
        forbiddenRoots: options.forbiddenRoots || [],
        repositoryRoot: options.repositoryRootForSession?.(sessionId) || null,
      }));
    },
    commitUnavailable(sessionId, catalogEntry, source, capabilities) {
      return commitProjection(sessionId, unavailableSessionDomains(sessionId, catalogEntry, source, capabilities, {
        forbiddenRoots: options.forbiddenRoots || [],
      }));
    },
    read(sessionId, domain, agentId, revision) {
      if (!SESSION_DOMAIN_SET.has(domain)) return Object.freeze({ status: "invalid", revision: 0, snapshot: null });
      evictIdle();
      const record = records.get(key(sessionId, domain));
      if (!record) return Object.freeze({ status: "empty", revision: 0, snapshot: null });
      accessedAt.delete(sessionId);
      accessedAt.set(sessionId, now());
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
    size() { return accessedAt.size; },
    clear() { records.clear(); accessedAt.clear(); },
  });
}
