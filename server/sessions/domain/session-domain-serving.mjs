import { parseProviderSessionId } from "../../providers/provider-contract.mjs";

export function createSessionDomainServing({
  registry,
  sessionDomains,
  observationStore,
  coordinator,
  scheduleObservation,
  isServingActive,
}) {
  let catalogIndexSource = null;
  let catalogIndex = new Map();
  let protectedCatalogIds = new Set();
  function indexedCatalog() {
    const sessions = coordinator.catalog()?.snapshot?.value?.sessions || [];
    if (sessions !== catalogIndexSource) {
      catalogIndexSource = sessions;
      catalogIndex = new Map(sessions.map((entry) => [entry.id, entry]));
      protectedCatalogIds = new Set(sessions
        .filter((entry) => entry.isLive || ["working", "needs_input", "open"].includes(entry.activityStatus))
        .map((entry) => entry.id));
    }
    return catalogIndex;
  }
  function domainCatalogEntry(sessionId) {
    return indexedCatalog().get(sessionId) || (() => {
      const identity = coordinator.catalogIdentity?.(sessionId);
      return identity ? { ...identity, summaryReadiness: "loading" } : null;
    })();
  }
  function domainCatalogComplete() {
    if (!isServingActive() || !coordinator.catalog()?.snapshot) return false;
    const providerReadiness = coordinator.catalogReadiness?.();
    return !providerReadiness || Object.values(providerReadiness).every((value) => value !== "loading");
  }

  const pendingDomainRebuilds = new Set();
  const pendingDomainHydrations = new Map();
  const DOMAIN_HYDRATION_RETRY_MS = 30_000;
  const uncataloguedProbes = new Map();
  const MAX_UNCATALOGUED_PROBE_RECORDS = 128;
  const MAX_PENDING_UNCATALOGUED_PROBES = 4;

  function projectionCatalogEntry(sessionId) {
    const row = indexedCatalog().get(sessionId);
    return row ? coordinator.rowWithCommittedEvidence?.(row) ?? row : domainCatalogEntry(sessionId);
  }

  function commitSessionDomains(sessionId, snapshot = observationStore.getByQualifiedId(sessionId)) {
    if (snapshot) return sessionDomains.commit(sessionId, snapshot, projectionCatalogEntry(sessionId));
    const catalogEntry = domainCatalogEntry(sessionId);
    if (catalogEntry?.summaryReadiness !== "unavailable") return null;
    const provider = registry.providerForSessionId(sessionId) || registry.defaultProvider;
    return sessionDomains.commitUnavailable(sessionId, catalogEntry, provider.source, provider.capabilities);
  }
  function requestDomainHydration(sessionId) {
    const at = performance.now();
    const requestedAt = pendingDomainHydrations.get(sessionId);
    if (requestedAt !== undefined && at - requestedAt < DOMAIN_HYDRATION_RETRY_MS) return;
    pendingDomainHydrations.delete(sessionId);
    pendingDomainHydrations.set(sessionId, at);
    while (pendingDomainHydrations.size > 128) pendingDomainHydrations.delete(pendingDomainHydrations.keys().next().value);
    coordinator.session(sessionId);
  }
  function startUncataloguedProbe(sessionId, at) {
    let pending = 0;
    for (const record of uncataloguedProbes.values()) if (record.state === "pending") pending += 1;
    if (pending >= MAX_PENDING_UNCATALOGUED_PROBES) return false;
    const request = coordinator.probeUncatalogued(sessionId);
    if (!request || typeof request.then !== "function") return false;
    const record = { state: "pending", at };
    uncataloguedProbes.delete(sessionId);
    uncataloguedProbes.set(sessionId, record);
    for (const [id, candidate] of uncataloguedProbes) {
      if (uncataloguedProbes.size <= MAX_UNCATALOGUED_PROBE_RECORDS) break;
      if (candidate.state !== "pending") uncataloguedProbes.delete(id);
    }
    void request.then((found) => {
      if (uncataloguedProbes.get(sessionId) !== record) return;
      record.state = found ? "found" : "absent";
      record.at = performance.now();
    });
    return true;
  }
  function serveUncataloguedSessionDomain(sessionId) {
    const unavailable = { status: "unavailable", revision: 0, snapshot: null };
    const loading = { status: "loading", revision: 0, snapshot: null };
    const at = performance.now();
    const parsed = parseProviderSessionId(sessionId);
    if (!parsed || !registry.providers?.some((provider) => provider.id === parsed.providerId)) return unavailable;
    const probe = uncataloguedProbes.get(sessionId);
    if (probe?.state === "pending") return loading;
    if (probe && at - probe.at < DOMAIN_HYDRATION_RETRY_MS) return probe.state === "absent" ? unavailable : loading;
    startUncataloguedProbe(sessionId, at);
    return probe?.state === "absent" ? unavailable : loading;
  }
  function scheduleSessionDomainRebuild(sessionId) {
    if (pendingDomainRebuilds.has(sessionId)) return;
    pendingDomainRebuilds.add(sessionId);
    scheduleObservation(() => {
      try { if (isServingActive()) commitSessionDomains(sessionId); }
      finally { pendingDomainRebuilds.delete(sessionId); }
    }, 0);
  }

  function serveSessionDomain(sessionId, domain, agentId, revision) {
    const result = sessionDomains.read(sessionId, domain, agentId, revision);
    const committed = observationStore.getByQualifiedId(sessionId);
    const catalogEntry = domainCatalogEntry(sessionId);
    const hydratable = !committed && catalogEntry && catalogEntry.summaryReadiness !== "unavailable";
    if (committed || catalogEntry) uncataloguedProbes.delete(sessionId);
    if (committed) coordinator.prioritizeRestoredLive(sessionId);
    if (result.status !== "empty") {
      if (hydratable && result.snapshot?.value?.readiness === "unavailable") requestDomainHydration(sessionId);
      return result;
    }
    if (!committed && !catalogEntry) {
      // Catalog absence is never proof of absence.
      if (domainCatalogComplete()) return serveUncataloguedSessionDomain(sessionId);
      requestDomainHydration(sessionId);
      return { status: "loading", revision: 0, snapshot: null };
    }
    if (hydratable) requestDomainHydration(sessionId);
    else scheduleSessionDomainRebuild(sessionId);
    return { status: "loading", revision: 0, snapshot: null };
  }

  return Object.freeze({
    commit: commitSessionDomains,
    forget(sessionId) { pendingDomainHydrations.delete(sessionId); },
    clear() {
      pendingDomainRebuilds.clear();
      pendingDomainHydrations.clear();
      uncataloguedProbes.clear();
    },
    protectedSessionIds: () => { indexedCatalog(); return protectedCatalogIds; },
    serveSessionDomain,
  });
}
