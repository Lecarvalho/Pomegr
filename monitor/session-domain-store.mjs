import { projectSessionDomains, unavailableSessionDomains } from "./session-domain-projection.mjs";

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

/**
 * Independently revisioned D projections. S reads exact committed JSON only.
 *
 * Retention is demand-ordered. A commit whose semantic JSON is unchanged is a
 * no-op: it neither advances a revision nor refreshes retention, so catalog
 * churn cannot reorder or evict retained sessions. Idle eviction applies only
 * after no request and no semantic change for the idle window. Sessions the
 * runtime marks as protected (live or open catalog rows) and the most recently
 * requested session are exempt from the soft session bound, up to a hard
 * ceiling. Otherwise never-requested sessions evict first, then the least
 * recently used.
 */
export function createSessionDomainStore(options = {}) {
  const now = options.now || Date.now;
  const maxSessions = Number.isSafeInteger(options.maxSessions)
    ? Math.max(1, Math.min(128, options.maxSessions)) : DEFAULT_MAX_SESSIONS;
  const idleMs = Number.isFinite(options.idleMs)
    ? Math.max(1_000, Math.min(60 * 60_000, options.idleMs)) : DEFAULT_IDLE_MS;
  const isProtected = typeof options.isProtected === "function" ? options.isProtected : () => false;
  let records = new Map();
  let revisionClocks = new Map(SESSION_DOMAIN_NAMES.map((domain) => [domain, 0]));
  // sessionId -> { changedAt, demandedAt, kind: "evidence" | "unavailable" }
  const sessions = new Map();
  // Requests for a session without a committed projection yet. The first commit
  // after asynchronous hydration or rebuild inherits that demand.
  const pendingDemand = new Map();
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
    // Semantically identical re-commits change neither revisions nor retention.
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
    // A commit displaced at once by higher-priority sessions publishes nothing;
    // the domain clock floor is still retained.
    const retained = sessions.has(sessionId) ? changed : [];
    for (const event of retained) publish(event);
    return Object.freeze(retained);
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
        retainedResources: options.retainedResourcesForSession?.(sessionId) ?? null,
      }), "evidence");
    },
    commitUnavailable(sessionId, catalogEntry, source, capabilities) {
      if (sessions.get(sessionId)?.kind === "evidence") return Object.freeze([]);
      return commitProjection(sessionId, unavailableSessionDomains(sessionId, catalogEntry, source, capabilities, {
        forbiddenRoots: options.forbiddenRoots || [],
      }), "unavailable");
    },
    read(sessionId, domain, agentId, revision) {
      if (!SESSION_DOMAIN_SET.has(domain)) return Object.freeze({ status: "invalid", revision: 0, snapshot: null });
      const at = now();
      evictIdle(at);
      recordDemand(sessionId, at);
      // Lets a source (the resource-domain SQLite cache) queue its own asynchronous
      // hydration for a session this store now tracks; never a synchronous read here.
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
    has(sessionId) { return sessions.has(sessionId); },
    sessionIds() { return Object.freeze([...sessions.keys()]); },
    size() { return sessions.size; },
    clear() { records.clear(); sessions.clear(); pendingDemand.clear(); },
  });
}
