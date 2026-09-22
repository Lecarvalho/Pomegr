import { parseProviderSessionId } from "./providers/provider-contract.mjs";

/**
 * Owns session-domain commit and serving bookkeeping: indexing the observed
 * catalog for lookup and soft-bound protection, committing observed evidence
 * (or a catalog-derived unavailable placeholder) into the session-domain
 * store, requesting bounded deduplicated asynchronous hydration for
 * hydratable rows, and probing sessions absent from every provider catalog
 * window. Extracted from observation-runtime.mjs to keep that module within
 * the repository's file-size budget; the runtime calls this factory at the
 * same points, in the same order, as the inlined code it replaced.
 */
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
    return indexedCatalog().get(sessionId) || null;
  }
  function domainCatalogComplete() {
    if (!isServingActive() || !coordinator.catalog()?.snapshot) return false;
    const providerReadiness = coordinator.catalogReadiness?.();
    return !providerReadiness || Object.values(providerReadiness).every((value) => value !== "loading");
  }

  const pendingDomainRebuilds = new Set();
  // sessionId -> monotonic request time of a domain-requested hydration. One
  // queued hydration serves every domain and poll until evidence commits.
  const pendingDomainHydrations = new Map();
  const DOMAIN_HYDRATION_RETRY_MS = 30_000;
  // sessionId -> { state: "pending" | "found" | "absent", at } for session-domain requests whose
  // session has neither committed evidence nor a row in the bounded provider catalog window. Both
  // the retained outcomes and the concurrently outstanding probes are bounded, so requests for
  // absent or made-up IDs cannot queue unbounded hydration work.
  const uncataloguedProbes = new Map();
  const MAX_UNCATALOGUED_PROBE_RECORDS = 128;
  const MAX_PENDING_UNCATALOGUED_PROBES = 4;

  function commitSessionDomains(sessionId, snapshot = observationStore.getByQualifiedId(sessionId)) {
    if (snapshot) return sessionDomains.commit(sessionId, snapshot, domainCatalogEntry(sessionId));
    const catalogEntry = domainCatalogEntry(sessionId);
    // A hydratable row has no placeholder: it stays loading until evidence
    // commits, and any retained projection remains last-known-good.
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
  // A session-domain request for a session outside every provider catalog. Catalog absence is not
  // proof of absence (catalogs are bounded windows), so the request queues one deduplicated,
  // bounded asynchronous hydration and serves loading. It answers unavailable only after that
  // hydration published no evidence; a proven absence is re-probed at most once per retry window
  // and keeps answering unavailable meanwhile. A found session commits normally, and its domain
  // revision event lets an open page recover.
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
    // Without committed L1 evidence, a requested hydratable row queues the
    // same asynchronous, pinned selection hydration as /api/state. Serving
    // itself never acquires, parses, or normalizes provider data.
    const hydratable = !committed && catalogEntry && catalogEntry.summaryReadiness !== "unavailable";
    if (committed || catalogEntry) uncataloguedProbes.delete(sessionId);
    // Like /api/state, a request for a checkpoint-restored live session prioritizes its
    // deduplicated revalidation instead of waiting for eager live hydration.
    if (committed) coordinator.prioritizeRestoredLive(sessionId);
    if (result.status !== "empty") {
      if (hydratable && result.snapshot?.value?.readiness === "unavailable") requestDomainHydration(sessionId);
      return result;
    }
    if (!committed && !catalogEntry) {
      // Catalog absence is never proof of absence. Before every provider
      // catalog has published (monitor startup) the request is loading and
      // queues the same asynchronous selection hydration; its commit publishes
      // the revision event a browser entry recovers from. Afterwards the
      // session may still exist outside the bounded catalog window, so a
      // bounded probe decides (see serveUncataloguedSessionDomain).
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
    // Consumed by the sessionDomains store's `isProtected` option: live and
    // open catalog rows are exempt from its soft session bound, so commits
    // for other sessions cannot displace them.
    protectedSessionIds: () => { indexedCatalog(); return protectedCatalogIds; },
    serveSessionDomain,
  });
}
