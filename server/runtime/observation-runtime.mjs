import { createHistoryContributionPublisher } from "../sessions/history/history-contribution-publisher.mjs";
import path from "node:path";
import { resolvePomegrDataRoot } from "../../shared/pomegr-paths.mjs";
import { createObservationMonitorStoreRuntime, wrapCheckpointStoreForStore } from "../persistence/monitor-store-runtime.mjs";
import { attachResourceHistory } from "../resources/resource-history.mjs";
import { createResourceDomainSource } from "../resources/resource-domain.mjs";
import { projectProviderSessionEvidence } from "../sessions/domain/session-projection.mjs";
import { parseProviderSessionEvidence } from "../providers/provider-contract.mjs";
import { createCommittedResponseCache } from "../persistence/committed-response-cache.mjs";
import { isObservationWorkingSetEntry } from "../normalize/observation-working-set.mjs";
import { createHomeReadiness, createSessionReadiness } from "../normalize/observation-readiness.mjs";
import { SessionObservationCheckpointStore } from "../sessions/checkpoints/session-observation-checkpoints.mjs";
import { createSessionObservationCoordinator } from "./session-observation-coordinator.mjs";
import { SessionObservationStore } from "../sessions/checkpoints/session-observation-store.mjs";
import { createProviderStatusObservation } from "./provider-status-observation.mjs";
import { createAgentsObservation } from "./agents-observation.mjs";
import { createAgentQueryProjectionCache } from "../sessions/domain/agent-query-projection.mjs";
import { createRepositoryInventoryRuntime } from "../repository/repository-inventory-runtime.mjs";
import { attachFileHistory } from "../repository/file-history-domain.mjs";
import { createSessionRepositoryAssociations } from "../repository/session-repository-association.mjs";
import { liveRepositoryReadiness } from "../repository/session-repository-enrichment.mjs";
import { SessionHistoryStore } from "../sessions/history/session-history-store.mjs";
import { createSessionHistoryRuntime } from "../sessions/history/session-history-runtime.mjs";
import { createSessionDomainStore } from "../sessions/domain/session-domain-store.mjs";
import { createSessionDomainServing } from "../sessions/domain/session-domain-serving.mjs";
import { createRepositorySnapshotRecorder, gitObservedFilesFromSnapshot, resolveHistoricalRepositoryAndPullRequests, sessionRepositorySnapshot, withLegacyRepositoryAttribution } from "../repository/repository-snapshot.mjs";
import { createObservationStartupRepository } from "./observation-startup-repository.mjs";
import { createCheckpointStateProjector } from "../sessions/checkpoints/checkpoint-state-projector.mjs";
import { createPersistenceMaintenance } from "../persistence/persistence-maintenance.mjs";
import { qualifiedSessionId } from "../normalize/primitives.mjs";

/**
 * Owns the monitor-side observation lifecycle, response caches, and
 * provider-neutral projection hooks. The HTTP server only consumes the
 * immutable serving methods returned by this factory.
 */
export function createObservationRuntime(options = {}) {
  const {
    registry,
    resourceUsageSampler,
    pullRequestReader,
    now = () => Date.now(),
    scheduleHomeRefresh = (task) => setImmediate(task),
    scheduleObservation = (task, delay) => setTimeout(task, delay),
    cancelObservation = clearTimeout,
    pomegrPaths,
    buildHomeSnapshot,
    liveEnrichment,
    recordedGitState,
    unavailableGitState,
    unavailablePullRequests,
    repositoryRoleMappings,
    publicResourceUsage,
    unavailableResourceUsage,
    createEmptyMonitorState,
    createEmptyUsageLimits,
  } = options;
  if (!registry || typeof buildHomeSnapshot !== "function" || typeof liveEnrichment !== "function"
    || typeof recordedGitState !== "function" || typeof unavailableGitState !== "function"
    || typeof unavailablePullRequests !== "function" || typeof repositoryRoleMappings !== "function"
    || typeof publicResourceUsage !== "function" || typeof unavailableResourceUsage !== "function"
    || typeof createEmptyMonitorState !== "function" || typeof createEmptyUsageLimits !== "function") {
    throw new TypeError("Observation runtime requires monitor projection hooks");
  }

  const usageResponseCache = createCommittedResponseCache({ includeRevision: true, now });
  const providerStatus = createProviderStatusObservation({
    readStatus: (providerId, requestOptions) => registry.readServiceStatus(providerId, requestOptions),
    now,
    onUpdate: () => agentQueryProjection?.refresh?.(),
    ...options.providerStatusObservationOptions,
  });
  const usageByProvider = new Map();
  const homeResponseCache = createCommittedResponseCache({ includeRevision: true, now });
  // Registry-only sessions have catalog identity but no L1 transcript evidence.
  // Keep their presentation response separate from the observation store and
  // checkpoints: it is rebuilt solely from a committed catalog revision.
  const unavailableSessionResponses = new Map();
  let usageRefreshInFlight = null;
  let homeResponseRefreshScheduled = false;
  let usageRefreshTimer = null;
  let resourceRefreshTimer = null;
  let resourceRefreshInFlight = null;
  let observationServingActive = false;
  let observationStartPromise = null;
  let unsubscribeObservation = null;

  // A provider whose legacy evidence was launch-bound recorded launch-bound sidecars without a repository ID.
  const adoptsUnboundSidecar = (providerId) => registry.legacyRepositoryAttribution?.(providerId) === "launch";
  const validateObservation = ({ localSessionId, evidence }) => {
    parseProviderSessionEvidence(evidence, localSessionId);
    return true;
  };
  const observationStore = options.observationStore || new SessionObservationStore({
    validateCandidate: validateObservation,
    maxEntries: options.observationMaxEntries,
    maxBytes: options.observationMaxBytes,
    now,
  });
  const checkpointStore = options.checkpointStore === false
    ? null
    : options.checkpointStore || new SessionObservationCheckpointStore({
      directory: path.join(resolvePomegrDataRoot(pomegrPaths), "observation-cache-v1"),
      validateCandidate: validateObservation,
      upgradeEvidence: (providerId, evidence) => withLegacyRepositoryAttribution(evidence, registry.legacyRepositoryAttribution?.(providerId)),
      maxEntries: options.checkpointMaxEntries,
      maxBytes: options.checkpointMaxBytes,
    });
  // Bounded historical snapshots persist as sidecars next to checkpoints; disabled together,
  // and also when an injected checkpoint store (a minimal test double) predates the sidecar.
  const repositorySnapshotRecorder = typeof checkpointStore?.writeRepositorySnapshot === "function" ? createRepositorySnapshotRecorder({ store: checkpointStore, now, adoptsUnboundSidecar }) : null;
  const monitorStoreRuntime = options.monitorStoreRuntime || createObservationMonitorStoreRuntime({ options, dataRoot: resolvePomegrDataRoot(pomegrPaths), now });
  const resourceHistory = attachResourceHistory({ enabled: options.monitorStore !== false, monitorStoreRuntime, sampler: resourceUsageSampler, observationStore, now });
  // Registered after resource-history so its cycle contributor reads fresh writes; onChange
  // commits directly (refreshProjection no-ops on byte-identical re-derivation).
  const resourceDomainSource = createResourceDomainSource({
    monitorStoreRuntime, demandedSessionIds: () => sessionDomains.sessionIds(), now, onChange: (sessionId) => sessionDomainServing.commit(sessionId),
  });
  const checkpointStoreForCoordinator = wrapCheckpointStoreForStore(checkpointStore, (snapshot) => monitorStoreRuntime.afterCheckpointWrite(snapshot));
  const repositoryInventory = options.repositoryInventory || createRepositoryInventoryRuntime({
    registry, now, persistence: options.checkpointStore !== false,
    storeFile: path.join(resolvePomegrDataRoot(pomegrPaths), "repository-inventory-v1.json"),
    ...options.repositoryInventoryOptions,
  });
  for (const provider of registry.providers || []) {
    provider.setRepositoryResolver?.(repositoryInventory.resolveRepository);
  }
  // Registers the file-change index contributor plus this committed cache; forward-references sessionDomains/observationCoordinator below, same pattern as resourceDomainSource above.
  const fileHistorySource = attachFileHistory(monitorStoreRuntime, {
    resolveRepository: repositoryInventory.resolveRepository, checkpointStore, now, demandedSessionIds: () => sessionDomains.sessionIds(),
    catalog: () => observationCoordinator.catalog()?.snapshot?.value?.sessions || [], onSessionChange: (sessionId) => sessionDomainServing.commit(sessionId),
    agentLabel: (sessionId, agentId) => sessionDomains.agentLabel?.(sessionId, agentId) ?? null,
  });
  const historyStore = options.historyStore || new SessionHistoryStore({
    directory: path.join(resolvePomegrDataRoot(pomegrPaths), "session-history-v1"),
    maxSessions: options.historyMaxSessions, maxResident: options.historyMaxResident ?? 0,
  });
  let sessionDomainServing; // assigned once observationCoordinator exists below; the store only calls it later
  // The session's own recorded sidecar, live or historical, gated by its repository identity.
  function recordedRepositorySnapshotForSession(sessionId) {
    // The recorder holds fewer sidecars than the disk. One it has dropped is read back off
    // the request path, and the session's domains recommit when it holds a snapshot.
    if (repositorySnapshotRecorder && !repositorySnapshotRecorder.has(sessionId)) {
      void repositorySnapshotRecorder.ensure(sessionId).then((found) => {
        if (found && observationServingActive) sessionDomainServing.commit(sessionId);
      }).catch(() => {});
    }
    return sessionRepositorySnapshot(
      observationStore.getByQualifiedId(sessionId)?.evidence, repositorySnapshotRecorder?.recorded(sessionId) || null,
      { adoptsUnboundSidecar: adoptsUnboundSidecar(sessionId.split(":")[0]) },
    );
  }
  const sessionDomains = options.sessionDomainStore || createSessionDomainStore({
    now, maxSessions: options.sessionDomainMaxSessions, idleMs: options.sessionDomainIdleMs,
    isProtected: (sessionId) => sessionDomainServing.protectedSessionIds().has(sessionId),
    forbiddenRoots: Object.values(registry.providerFolders?.folders || {}).filter(Boolean),
    repositoryRootForSession: options.repositoryRootForSession,
    retainedResourcesForSession: (sessionId) => resourceDomainSource.retained(sessionId), fileHistoryForSession: (sessionId) => fileHistorySource.sessionFiles(sessionId),
    // One recorded-snapshot read per projection. The commit times are monitor-private and feed
    // only the session-event derivation.
    repositoryRecordForSession: (sessionId) => {
      const recorded = recordedRepositorySnapshotForSession(sessionId);
      return { gitObserved: gitObservedFilesFromSnapshot(recorded), commitTimes: recorded?.commitTimesInWindow ?? null };
    },
    onDemand: (sessionId) => { resourceDomainSource.request(sessionId); fileHistorySource.requestSessionFiles(sessionId); },
  });
  const repositoryAssociations = createSessionRepositoryAssociations({
    registry, inventory: repositoryInventory,
    previousReference: (candidate) => observationStore.get(candidate.providerId, candidate.localSessionId)?.publicState?.session?.contextInventoryRef,
    previousAssociation: (candidate) => {
      const session = observationStore.get(candidate.providerId, candidate.localSessionId)?.publicState?.session;
      return session ? { repositoryId: session.repositoryId ?? null, contextInventoryRef: session.contextInventoryRef ?? null } : null;
    },
    onChange: (sessionId) => observationCoordinator.refreshProjection(sessionId),
  });
  const historyTrace = options.pipelineTrace;
  const traceScopeForSession = typeof options.traceScopeForSession === "function"
    ? options.traceScopeForSession
    : null;

  function ownedTraceScope(sessionId) {
    if (!traceScopeForSession) return null;
    try {
      const scope = traceScopeForSession(sessionId);
      return scope && typeof scope === "object" && !Array.isArray(scope) ? scope : null;
    } catch { return null; }
  }

  const sessionHistory = createSessionHistoryRuntime({
    registry, observationStore, historyStore, trace: historyTrace, ownedTraceScope,
    isActive: () => observationServingActive,
    foregroundConcurrency: options.historyForegroundConcurrency ?? 1,
    backgroundConcurrency: options.historyBackgroundConcurrency ?? 1,
  });

  const historyPublisher = createHistoryContributionPublisher({
    store: historyStore, isActive: () => observationServingActive, trace: historyTrace, scopeForSession: ownedTraceScope,
  });
  const publishHistoryContribution = (providerId, localSessionId, contribution) =>
    historyPublisher.publish("activity", qualifiedSessionId(providerId, localSessionId), contribution);
  const publishHistoryRequestContribution = (providerId, localSessionId, contribution) =>
    historyPublisher.publish("requests", qualifiedSessionId(providerId, localSessionId), contribution);

  const checkpointPublicState = createCheckpointStateProjector({
    registry, recordedSnapshot: (sessionId) => repositorySnapshotRecorder?.recorded(sessionId) || null,
    recordedGitState, unavailableGitState, unavailablePullRequests, repositoryRoleMappings,
    createEmptyMonitorState, createEmptyUsageLimits, unavailableResourceUsage,
  });

  function observedUsageLimits(providerId, historical = false) {
    if (historical) return createEmptyUsageLimits();
    return usageResponseCache.current()?.value?.providers
      ?.find((entry) => entry.provider === providerId)?.usageLimits || createEmptyUsageLimits();
  }

  function scheduleObservedHomeRefresh() {
    if (!observationServingActive || homeResponseRefreshScheduled) return;
    homeResponseRefreshScheduled = true;
    try {
      scheduleHomeRefresh(() => {
        homeResponseRefreshScheduled = false;
        const work = refreshObservedHomeResponse();
        void work.catch(() => {});
        return work;
      });
    } catch {
      homeResponseRefreshScheduled = false;
    }
  }

  async function refreshUsageResponses() {
    if (usageRefreshInFlight) return usageRefreshInFlight;
    const publish = () => {
      const committed = usageResponseCache.commit({
        generatedAt: new Date(now()).toISOString(),
        readiness: Object.fromEntries((registry.providers || []).map((provider) => [
          provider.id,
          usageByProvider.get(provider.id)?.readiness || "loading",
        ])),
        providers: (registry.providers || []).flatMap((provider) => {
          const entry = usageByProvider.get(provider.id);
          return entry ? [entry] : [];
        }),
      });
      agentQueryProjection?.refresh?.();
      return committed;
    };
    const tasks = (registry.providers || []).map(async (provider) => {
      let usageLimits = createEmptyUsageLimits();
      try {
        usageLimits = await registry.readUsageLimits(provider);
      } catch {
        usageLimits = createEmptyUsageLimits({ error: "Usage limits are temporarily unavailable." });
      }
      // A provider task is recorded only after its read completes. A completed
      // empty value therefore cannot remain loading: capability-disabled reads
      // carry runtime_unavailable, while malformed/custom empty reads settle
      // to unavailable as well. An actually pending read has no provider entry
      // yet and remains represented by the initial loading response.
      const readiness = usageLimits.available || usageLimits.fetchedAt
        ? "ready"
        : "unavailable";
      usageByProvider.set(provider.id, { provider: provider.id, source: provider.source, readiness, usageLimits });
      publish();
      scheduleObservedHomeRefresh();
    });
    const refresh = Promise.allSettled(tasks).finally(() => {
      if (usageRefreshInFlight === refresh) usageRefreshInFlight = null;
    });
    usageRefreshInFlight = refresh;
    return refresh;
  }

  async function refreshObservedResources() {
    if (resourceRefreshInFlight || typeof registry.inspectSessions !== "function") return resourceRefreshInFlight;
    const refresh = registry.inspectSessions()
      .then(async (inspected) => {
        const resourceTargets = inspected.resourceTargets || [];
        await resourceHistory.sampleAndSchedule(resourceTargets);
        for (const target of resourceTargets) observationCoordinator.refreshProjection(target.sessionId);
      })
      .catch(() => {})
      .finally(() => {
        if (resourceRefreshInFlight === refresh) resourceRefreshInFlight = null;
      });
    resourceRefreshInFlight = refresh;
    return refresh;
  }

  async function refreshObservedHomeResponse() {
    const usageRevision = usageResponseCache.current()?.revision || 0;
    const snapshot = await buildHomeSnapshot();
    if ((usageResponseCache.current()?.revision || 0) !== usageRevision) {
      scheduleObservedHomeRefresh();
      return homeResponseCache.current();
    }
    const catalogEntries = observationCoordinator?.catalog()?.snapshot?.value?.sessions || [];
    const homeEntries = catalogEntries.filter((entry) => isObservationWorkingSetEntry(entry, now()));
    const providerLimitReadiness = usageResponseCache.current()?.value?.readiness || {};
    const limitActivityReadiness = {};
    for (const { provider, usageLimits } of snapshot.providerLimits) {
      for (const limit of usageLimits.limits || []) {
        const key = `${provider}:${limit.id}`;
        const providerReady = providerLimitReadiness[provider] === "ready";
        const summariesReady = homeEntries
          .filter((entry) => entry.provider === provider)
          .every((entry) => observationStore.getByQualifiedId(entry.id));
        limitActivityReadiness[key] = providerReady && summariesReady ? "ready" : "loading";
      }
    }
    const readiness = createHomeReadiness({
      catalog: observationCoordinator?.catalog()?.status === "empty" ? "loading" : "ready",
      providerLimits: providerLimitReadiness,
      limitActivity: limitActivityReadiness,
      sessionSummaries: Object.fromEntries(homeEntries.map((entry) => [
        entry.id,
        observationStore.getByQualifiedId(entry.id) ? "ready" : "loading",
      ])),
    });
    return homeResponseCache.commit({
      ...snapshot,
      readiness,
      providerLimitRevision: usageRevision,
      limitActivities: snapshot.limitActivities.map((activity) => ({ ...activity, providerLimitRevision: usageRevision })),
    });
  }

  // Private per-projection live repository check state (none, pending or
  // confirmed), keyed by the projected state object; never serialized.
  const liveRepositoryChecks = new WeakMap();

  async function projectSelection(selection, { useObservedUsage = false, trace = null, scope = null } = {}) {
    const { evidence, provider, sessionId } = selection;
    const historical = evidence.historical;
    const capabilitiesSpan = trace?.begin?.({ stage: "session_capabilities", domain: "derivation", scope });
    let capabilities;
    try {
      capabilities = typeof registry.resolveCapabilities === "function"
        ? await registry.resolveCapabilities(provider, { historical })
        : provider.capabilities;
      trace?.end?.(capabilitiesSpan, { outcome: "completed" });
    } catch (error) {
      trace?.end?.(capabilitiesSpan, { outcome: "failed" });
      throw error;
    }
    let repository;
    let pullRequests;
    let enqueueLiveEnrichment = null;
    let repositoryCheck = "pending";
    const repositoryAttribution = selection.repositoryAttribution
      || options.repositoryAttributionForSession?.(sessionId)
      || registry.repositoryAttributionForSession?.(sessionId)
      || null;
    if (historical) {
      // A live historical source can arrive while the private sidecar cache is
      // still loading, or for a session whose sidecar that load did not cover.
      // Wait only for that projection dependency so its saved repository state
      // wins over the no-snapshot Git fallback.
      await repositoryStartup.checkpointRestoreReady(sessionId);
      // A recorded snapshot serves instantly; only the no-snapshot fallback calls Git/GitHub.
      ({ repository, pullRequests } = await resolveHistoricalRepositoryAndPullRequests({
        adoptsUnboundSidecar: adoptsUnboundSidecar(provider.id),
        evidence, snapshot: repositorySnapshotRecorder?.recorded(sessionId) || null,
        recordedGitState, pullRequestReader, unavailablePullRequests,
      }));
    } else {
      // Root binding is private runtime state. It deliberately stays out of
      // normalized evidence/checkpoints, where a filesystem root is forbidden.
      const live = liveEnrichment(sessionId, evidence, repositoryAttribution);
      ({ repository, pullRequests } = live.value);
      enqueueLiveEnrichment = live.enqueue;
      repositoryCheck = live.check || "pending";
    }
    const currentUsageLimits = useObservedUsage
      ? observedUsageLimits(provider.id, historical)
      : await registry.readUsageLimits(provider, { historical, capabilities });
    const resources = historical ? null : (() => {
      try {
        return publicResourceUsage(resourceUsageSampler.get(sessionId));
      } catch {
        return unavailableResourceUsage();
      }
    })();
    const stateProjectionSpan = trace?.begin?.({ stage: "session_state_projection", domain: "derivation", scope });
    let state;
    try {
      state = projectProviderSessionEvidence({
        evidence,
        sessionId,
        source: provider.source,
        capabilities,
        repositoryRoles: repositoryRoleMappings(repositoryAttribution
          ? repositoryAttribution.state === "single" ? repositoryAttribution.root : ""
          : evidence.session.cwd),
        repository,
        pullRequests,
        usageLimits: currentUsageLimits,
        resources,
      });
      trace?.end?.(stateProjectionSpan, { outcome: "completed" });
    } catch (error) {
      trace?.end?.(stateProjectionSpan, { outcome: "failed" });
      throw error;
    }
    enqueueLiveEnrichment?.();
    if (!historical && state && typeof state === "object") liveRepositoryChecks.set(state, repositoryCheck);
    return state;
  }

  function initializeCommittedSessions() {
    if (!observationServingActive) return;
    for (const snapshot of observationStore.entries()) {
      sessionDomainServing.commit(snapshot.qualifiedId, snapshot);
      sessionHistory.ensureObserved(snapshot.qualifiedId, snapshot.revision);
    }
    agentQueryProjection.refresh();
  }

  const observationCoordinator = createSessionObservationCoordinator({
    registry,
    store: observationStore,
    monitorStoreRuntime,
    checkpointStore: checkpointStoreForCoordinator,
    schedule: scheduleObservation,
    cancel: cancelObservation,
    commitDelayMs: options.observationCommitDelayMs,
    checkpointDelayMs: options.checkpointDelayMs,
    checkpointMaxDelayMs: options.checkpointMaxDelayMs,
    persistenceQueueOptions: options.persistenceQueueOptions,
    now,
    pipelineTrace: options.pipelineTrace,
    traceScopeForSession,
    onHistoryContribution: publishHistoryContribution,
    onHistoryRequestContribution: publishHistoryRequestContribution,
    restoreState: checkpointPublicState,
    checkpointRestoreReady: (sessionId) => repositoryStartup.checkpointRestoreReady(sessionId),
    onRestoreComplete: initializeCommittedSessions,
    async deriveSession(candidate) {
      const provider = registry.providers?.find((entry) => entry.id === candidate.providerId);
      if (!provider) throw new TypeError("Unknown observed provider");
      const scope = traceScopeForSession?.(qualifiedSessionId(candidate.providerId, candidate.localSessionId)) || null;
      const projectionSpan = options.pipelineTrace?.begin?.({ stage: "session_projection", domain: "derivation", scope });
      let basePublicState;
      try {
        basePublicState = await projectSelection({
          provider,
          evidence: candidate.evidence,
          sessionId: qualifiedSessionId(candidate.providerId, candidate.localSessionId),
        }, { useObservedUsage: true, trace: options.pipelineTrace, scope });
        options.pipelineTrace?.end?.(projectionSpan, { outcome: "completed" });
      } catch (error) {
        options.pipelineTrace?.end?.(projectionSpan, { outcome: "failed" });
        throw error;
      }
      // Repository inventory is optional local enrichment. Refresh its binding
      // association after projection and rederive when it settles; it must
      // never hold back the already-normalized session publication.
      const sessionId = qualifiedSessionId(candidate.providerId, candidate.localSessionId);
      const association = repositoryAssociations.get(candidate);
      const publicState = basePublicState.session && association ? {
        ...basePublicState,
        session: { ...basePublicState.session, ...association },
      } : basePublicState;
      const usageReadiness = usageResponseCache.current()?.value?.readiness?.[candidate.providerId] || "loading";
      const readiness = createSessionReadiness("ready", {
        repository: liveRepositoryReadiness({
          historical: candidate.evidence.historical,
          available: publicState.session?.repository?.available,
          check: liveRepositoryChecks.get(basePublicState),
        }),
        resources: candidate.evidence.historical
          ? "ready"
          : publicState.metrics?.resources?.status === "unavailable" ? "unavailable"
            : publicState.metrics?.resources?.status === "ready" ? "ready" : "loading",
        usageLimits: candidate.evidence.historical ? "unavailable" : usageReadiness,
      });
      return { publicState: { ...publicState, readiness }, readiness };
    },
  });
  const persistenceMaintenance = createPersistenceMaintenance({
    ...options.persistenceMaintenanceOptions,
    steps: [
      ...(typeof checkpointStore?.maintenanceStep === "function" ? [(batch) => checkpointStore.maintenanceStep(batch)] : []),
      ...(typeof historyStore.maintenanceStep === "function" ? [(batch) => historyStore.maintenanceStep(batch)] : []),
    ],
    isBusy() {
      if (!observationServingActive || observationCoordinator.persistenceBusy()) return true;
      const history = sessionHistory.diagnostics();
      if (history.active || history.pending || historyPublisher.busy() || historyStore.persistenceBusy?.()) return true;
      return Object.values(observationCoordinator.diagnostics().observers).some((observer) =>
        observer.activeHydrations > 0 || observer.pendingHydrations > 0);
    },
  });
  const agentsObservation = createAgentsObservation({
    store: observationStore,
    catalog: () => observationCoordinator.catalog()?.snapshot?.value?.sessions || [],
    subscribe: observationCoordinator.subscribe,
    isReady: () => observationCoordinator.catalog()?.snapshot?.value?.readiness?.catalog === "ready",
    readiness: () => observationCoordinator.catalog()?.snapshot?.value?.readiness?.catalog || "loading",
    now,
    schedule: scheduleObservation,
    cancel: cancelObservation,
    intervalMs: options.agentsDerivationIntervalMs,
  });
  // Agent queries are a separate D-only projection. Every source below is a
  // committed snapshot; refresh never calls a provider, parser, or hydrator.
  const agentQueryProjection = createAgentQueryProjectionCache({
    now: options.agentQueryNow || Date.now,
    sources: {
      catalog: () => {
        const snapshot = observationCoordinator.catalog()?.snapshot;
        const providerReadiness = observationCoordinator.catalogReadiness?.() || {};
        return snapshot
          ? { ...snapshot.value, observedAt: snapshot.committedAt, providerReadiness }
          : { sessions: [], readiness: { catalog: "loading" }, providerReadiness };
      },
      entries: () => observationStore.entries(),
      providerStatus: () => providerStatus.read()?.snapshot?.value || null,
      usageLimits: () => usageResponseCache.current()?.value || null,
    },
  });

  function loadingState(selectedId, catalogEntry) {
    const provider = registry.providerForSessionId(selectedId) || registry.defaultProvider;
    return {
      ...createEmptyMonitorState({
        connected: true,
        source: provider.source,
        capabilities: provider.capabilities,
        view: catalogEntry?.isLive ? "live" : "history",
      }),
      readiness: createSessionReadiness("loading"),
      catalogIdentity: catalogEntry || null,
    };
  }

  function unavailableState(selectedId, catalogEntry) {
    const provider = registry.providerForSessionId(selectedId) || registry.defaultProvider;
    return {
      ...createEmptyMonitorState({
        connected: true,
        source: provider.source,
        capabilities: provider.capabilities,
        view: catalogEntry?.isLive || catalogEntry?.activityStatus === "open" ? "live" : "history",
      }),
      readiness: createSessionReadiness("unavailable"),
      catalogIdentity: catalogEntry || null,
    };
  }

  // Session-domain commit/serve bookkeeping (indexing, hydration, probing, rebuilds) lives here now.
  sessionDomainServing = createSessionDomainServing({
    registry, sessionDomains, observationStore, coordinator: observationCoordinator,
    scheduleObservation, isServingActive: () => observationServingActive,
  });
  const repositoryStartup = createObservationStartupRepository({
    repositoryInventory,
    repositorySnapshotRecorder,
    isActive: () => observationServingActive,
    catalog: () => observationCoordinator.catalog()?.snapshot?.value?.sessions || [],
    onRecorded: (sessionId) => sessionDomainServing.commit(sessionId),
  });

  function cacheUnavailableSessionResponses() {
    const catalog = observationCoordinator.catalog()?.snapshot?.value?.sessions || [];
    const next = new Map();
    for (const entry of catalog) {
      if (entry?.summaryReadiness !== "unavailable" || next.size >= 100) continue;
      const state = unavailableState(entry.id, entry);
      next.set(entry.id, Object.freeze({ serialized: JSON.stringify(state) }));
    }
    unavailableSessionResponses.clear();
    for (const [sessionId, response] of next) unavailableSessionResponses.set(sessionId, response);
  }

  async function startObservation() {
    if (observationStartPromise) return observationStartPromise;
    observationServingActive = true;
    historyStore.start?.();
    sessionHistory.start();
    // This D-only cache begins from the committed store and catalog. It never
    // invokes observers, hydration, parsing, or any provider read.
    agentsObservation.start();
    providerStatus.start();
    void monitorStoreRuntime.start();
    usageResponseCache.commit({
      generatedAt: null,
      readiness: Object.fromEntries((registry.providers || []).map((provider) => [provider.id, "loading"])),
      providers: [],
    });
    homeResponseCache.commit({
      generatedAt: null,
      providerLimits: [],
      limitActivities: [],
      projects: [],
      providerLimitRevision: usageResponseCache.current().revision,
      readiness: createHomeReadiness(),
    });
    agentQueryProjection.refresh();
    unsubscribeObservation = observationCoordinator.subscribe((event) => {
      if (event.type === "session") {
        const committed = observationStore.getByQualifiedId(event.qualifiedId);
        if (committed) { sessionDomainServing.forget(event.qualifiedId); sessionDomainServing.commit(event.qualifiedId, committed); }
        options.onSessionCommitted?.(event.qualifiedId);
        // Complete history is intentionally demand-only. New evidence updates
        // the committed cache, but neither observation nor state polling may
        // replay an arbitrary historical transcript.
        if (event.freshObservation) {
          sessionHistory.observe(event.qualifiedId, event.revision);
        }
      }
      if (event.type === "invalidation") sessionDomainServing.commit(event.qualifiedId);
      if (event.type === "catalog") {
        cacheUnavailableSessionResponses();
        // Catalog rows only change lifecycle inputs of already retained projections. Unretained
        // rows project on demand; identical re-projections are store no-ops that never re-revision or evict.
        for (const retainedId of sessionDomains.sessionIds()) sessionDomainServing.commit(retainedId);
      }
      if (event.type === "session" || event.type === "catalog") agentQueryProjection.refresh();
      if (event.type === "session" || event.type === "catalog") {
        void repositoryInventory.reconcile(observationCoordinator.catalog()?.snapshot?.value?.sessions || []);
      }
      scheduleObservedHomeRefresh();
    });
    repositoryStartup.start();
    observationStartPromise = (async () => {
      await observationCoordinator.start();
      persistenceMaintenance.start();
      agentQueryProjection.refresh();
      void refreshUsageResponses().then(scheduleObservedHomeRefresh).catch(() => {});
      void refreshObservedResources();
      usageRefreshTimer = setInterval(() => {
        void refreshUsageResponses().then(scheduleObservedHomeRefresh).catch(() => {});
      }, Math.max(60_000, Number(options.usageObservationIntervalMs ?? 60_000)));
      resourceRefreshTimer = setInterval(() => { void refreshObservedResources(); }, 5_000);
      usageRefreshTimer.unref?.();
      resourceRefreshTimer.unref?.();
    })();
    try { await observationStartPromise; }
    catch (error) {
      observationServingActive = false;
      await persistenceMaintenance.stop();
      repositoryStartup.stop();
      await repositoryInventory.stopPluginObservation?.();
      agentsObservation.stop();
      await providerStatus.stop();
      await monitorStoreRuntime.stop();
      observationStartPromise = null;
      unsubscribeObservation?.();
      unsubscribeObservation = null;
      throw error;
    }
  }

  async function stopObservation() {
    observationServingActive = false;
    await persistenceMaintenance.stop();
    repositoryStartup.stop();
    await repositoryInventory.stopPluginObservation?.();
    agentsObservation.stop();
    await providerStatus.stop();
    if (usageRefreshTimer) clearInterval(usageRefreshTimer);
    if (resourceRefreshTimer) clearInterval(resourceRefreshTimer);
    usageRefreshTimer = null;
    resourceRefreshTimer = null;
    unsubscribeObservation?.();
    unsubscribeObservation = null;
    unavailableSessionResponses.clear();
    sessionDomains.clear();
    sessionDomainServing.clear();
    historyPublisher.stop();
    await sessionHistory.stop();
    repositoryAssociations.clear();
    await observationCoordinator.stop();
    await historyStore.stop?.();
    await checkpointStore?.closeMaintenance?.();
    // The last checkpoint may still notify SQLite contributors. Close their
    // store only after all accepted P work has drained.
    await monitorStoreRuntime.stop();
    await Promise.allSettled([usageRefreshInFlight, resourceRefreshInFlight].filter(Boolean));
    observationStartPromise = null;
  }

  function subscribeRevisionEvents(subscriber) {
    if (typeof subscriber !== "function") throw new TypeError("Revision subscriber must be a function");
    const publish = (event) => {
      if (event?.type !== "catalog" || !Number.isSafeInteger(event.revision) || event.revision < 0) return;
      subscriber(Object.freeze({ domain: "sessions", revision: event.revision }));
    };
    const unsubscribe = observationCoordinator.subscribe(publish);
    const unsubscribeRepositories = repositoryInventory.subscribe(subscriber);
    const unsubscribeSessionDomains = sessionDomains.subscribe(subscriber);
    const currentRevision = observationCoordinator.catalog()?.snapshot?.revision;
    if (Number.isSafeInteger(currentRevision) && currentRevision >= 0) {
      subscriber(Object.freeze({ domain: "sessions", revision: currentRevision }));
    }
    const repositoryRevision = repositoryInventory.readRepositories()?.snapshot?.revision;
    if (Number.isSafeInteger(repositoryRevision) && repositoryRevision >= 0) {
      subscriber(Object.freeze({ domain: "repositories", revision: repositoryRevision }));
    }
    // History publishes its current revision synchronously on subscription.
    // Send the existing catalog envelope first so a newly opened SSE stream
    // starts with the same catalog/repository baseline every client expects.
    const unsubscribeHistory = historyStore.subscribeRevisionEvents(subscriber);
    return () => { unsubscribe(); unsubscribeRepositories(); unsubscribeSessionDomains(); unsubscribeHistory(); };
  }

  return Object.freeze({
    projectSelection,
    store: observationStore,
    coordinator: observationCoordinator,
    observedUsageLimits,
    startObservation,
    stopObservation,
    observationActive: () => observationServingActive,
    serveCatalog: (revision) => observationCoordinator.catalog(revision),
    serveCatalogShell: (selection) => observationCoordinator.shell(selection),
    serveSessionDirectory: (query) => observationCoordinator.directory(query),
    serveSession(sessionId, revision) {
      const result = observationCoordinator.session(sessionId, revision);
      if (result.status === "unavailable") {
        return { ...result, unavailableSnapshot: unavailableSessionResponses.get(result.selectedId) || null };
      }
      return result.status === "loading" || result.status === "empty"
        ? { ...result, loadingState: loadingState(result.selectedId, result.catalogEntry) }
        : result;
    },
    serveSessionDomain: sessionDomainServing.serveSessionDomain,
    serveHome: (revision) => homeResponseCache.read(revision),
    serveUsageLimits: (revision) => usageResponseCache.read(revision),
    async serveSessionHistory(sessionId, query) {
      // The Activity/Requests surface is the sole demand signal for a full
      // replay. The scheduler coalesces duplicate requests by session id.
      const selection = observationCoordinator.session(sessionId);
      sessionHistory.refresh(sessionId, 0, false);
      const servedAt = performance.now();
      const page = await historyStore.read(sessionId, query);
      historyTrace?.recordDuration?.({ stage: "cache_serve", domain: "serving", durationMs: Math.max(0, performance.now() - servedAt),
        outcome: page.status === "ready" ? "accepted" : page.status === "loading" ? "unchanged" : "rejected" });
      if (page.status !== "unavailable" || !observationServingActive) return page;
      if (selection.status === "loading") return { ...page, status: "loading" };
      const snapshot = observationStore.getByQualifiedId(sessionId);
      const provider = snapshot && registry.providers?.find((entry) => entry.id === snapshot.providerId);
      if (snapshot && typeof provider?.readSessionHistory === "function") {
        return { ...page, status: "loading" };
      }
      return page;
    },
    serveAgents: (query, revision) => agentsObservation.read(query, revision),
    serveProviderStatus: (revision) => providerStatus.read(revision),
    serveStorage: (revision) => monitorStoreRuntime.serveStorage(revision),
    monitorStore: monitorStoreRuntime,
    serveRepositories: (revision) => repositoryInventory.readRepositories(revision),
    serveRepositoryFiles: (query) => ((query?.fileId || query?.path) ? fileHistorySource.fileHistory(query.repositoryId, query.fileId ? { fileId: query.fileId } : { path: query.path }) : fileHistorySource.repositoryFiles(query?.repositoryId)),
    readRepositoryInventory: (repositoryId, provider, revisionId) => repositoryInventory.readRevision(repositoryId, provider, revisionId),
    captureRepositoryInventory: (repositoryId, provider) => repositoryInventory.capture(repositoryId, provider),
    refreshRepositoryPluginSetup: (repositoryId, provider) => repositoryInventory.refreshPluginSetup(repositoryId, provider),
    readRepositoryPluginSetup: (repositoryId, provider) => repositoryInventory.readPluginSetup(repositoryId, provider),
    prepareRepositoryPluginAction: (repositoryId, provider, action) => repositoryInventory.preparePluginAction(repositoryId, provider, action),
    // Only while actually observing: record the live check, then recommit its domains.
    onRepositoryCheck(sessionId, live) {
      repositoryStartup.record(sessionId, live);
    },
    serveAgentQuery: (name, args, revision) => agentQueryProjection.read(name, args, revision),
    subscribeRevisionEvents,
    diagnostics: () => Object.freeze({
      coordinator: observationCoordinator.diagnostics(),
      providers: registry.diagnostics?.() || {},
      responseRevisions: Object.freeze({
        catalog: observationCoordinator.catalog()?.snapshot?.revision || 0,
        home: homeResponseCache.current()?.revision || 0,
        usageLimits: usageResponseCache.current()?.revision || 0,
        agents: agentsObservation.read({ project: "all", days: 30, scope: "all" })?.revision || 0,
      }),
      agents: agentsObservation.diagnostics(),
      historyRefresh: sessionHistory.diagnostics(),
      persistenceMaintenance: persistenceMaintenance.stats(),
    }),
  });
}
