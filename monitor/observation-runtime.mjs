import path from "node:path";
import { resolvePomegrDataRoot } from "../shared/pomegr-paths.mjs";
import { projectProviderSessionEvidence } from "./session-projection.mjs";
import { parseProviderSessionEvidence } from "./providers/provider-contract.mjs";
import { createCommittedResponseCache } from "./committed-response-cache.mjs";
import { isObservationWorkingSetEntry } from "./observation-working-set.mjs";
import { createHomeReadiness, createSessionReadiness } from "./observation-readiness.mjs";
import { SessionObservationCheckpointStore } from "./session-observation-checkpoints.mjs";
import { createSessionObservationCoordinator } from "./session-observation-coordinator.mjs";
import { SessionObservationStore } from "./session-observation-store.mjs";
import { createProviderStatusObservation } from "./provider-status-observation.mjs";
import { createAgentsObservation } from "./agents-observation.mjs";
import { createAgentQueryProjectionCache } from "./agent-query-projection.mjs";
import { createRepositoryInventoryRuntime } from "./repository-inventory-runtime.mjs";
import { SessionHistoryStore } from "./session-history-store.mjs";

function qualifiedSessionId(providerId, localSessionId) {
  return `${providerId}:${localSessionId}`;
}

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
      maxEntries: options.checkpointMaxEntries,
      maxBytes: options.checkpointMaxBytes,
    });
  const repositoryInventory = options.repositoryInventory || createRepositoryInventoryRuntime({
    registry,
    now,
    persistence: options.checkpointStore !== false,
    storeFile: path.join(resolvePomegrDataRoot(pomegrPaths), "repository-inventory-v1.json"),
    ...options.repositoryInventoryOptions,
  });
  const historyStore = options.historyStore || new SessionHistoryStore({
    directory: path.join(resolvePomegrDataRoot(pomegrPaths), "session-history-v1"),
    maxSessions: options.historyMaxSessions,
    maxResident: options.historyMaxResident ?? 0,
  });
  const historyRefreshes = new Map();
  const historyDirty = new Set();
  const historyContributionRetries = new Map();
  const historyTrace = options.pipelineTrace;

  function retryHistoryContribution(domain, sessionId, contribution, attempt = 1) {
    if (!observationServingActive) return;
    const key = `${domain}:${sessionId}`;
    const existing = historyContributionRetries.get(key);
    if (existing) { existing.contribution = contribution; existing.version += 1; return; }
    if (attempt > 3) return;
    const pending = { contribution, timer: null, version: 1 };
    historyContributionRetries.set(key, pending);
    pending.timer = setTimeout(() => {
      const current = historyContributionRetries.get(key);
      if (current !== pending || !observationServingActive) {
        if (current === pending) historyContributionRetries.delete(key);
        return;
      }
      const version = current.version;
      const retryContribution = current.contribution;
      const publish = domain === "requests" ? historyStore.publishRequestContribution.bind(historyStore) : historyStore.publishActivityContribution.bind(historyStore);
      publish(sessionId, retryContribution).then(
        () => {
          if (historyContributionRetries.get(key) !== pending) return;
          historyContributionRetries.delete(key);
          if (observationServingActive && pending.version !== version) retryHistoryContribution(domain, sessionId, pending.contribution, attempt);
        },
        () => {
          if (historyContributionRetries.get(key) !== pending) return;
          historyContributionRetries.delete(key);
          if (observationServingActive) retryHistoryContribution(domain, sessionId, pending.contribution, attempt + 1);
        },
      );
    }, attempt * 100);
  }

  function publishHistoryContribution(providerId, localSessionId, contribution) {
    if (!observationServingActive) return Promise.resolve(null);
    const sessionId = qualifiedSessionId(providerId, localSessionId);
    const flow = historyTrace?.createFlow?.() || null;
    const span = historyTrace?.begin?.({ stage: "history_contribution", domain: "activity", flow }) || null;
    return historyStore.publishActivityContribution(sessionId, contribution).then(
      (record) => {
        historyTrace?.end?.(span, { outcome: record ? "accepted" : "unchanged" });
        historyTrace?.finishFlow?.(flow, { outcome: record ? "completed" : "rejected" });
        return record;
      },
      () => {
        historyTrace?.end?.(span, { outcome: "failed" });
        historyTrace?.finishFlow?.(flow, { outcome: "failed" });
        retryHistoryContribution("activity", sessionId, contribution);
        return null;
      },
    );
  }
  function publishHistoryRequestContribution(providerId, localSessionId, contribution) {
    if (!observationServingActive) return Promise.resolve(null);
    const sessionId = qualifiedSessionId(providerId, localSessionId);
    const flow = historyTrace?.createFlow?.() || null;
    const span = historyTrace?.begin?.({ stage: "history_contribution", domain: "requests", flow }) || null;
    return historyStore.publishRequestContribution(sessionId, contribution).then(
      (record) => {
        historyTrace?.end?.(span, { outcome: record ? "accepted" : "unchanged" });
        historyTrace?.finishFlow?.(flow, { outcome: record ? "completed" : "rejected" });
        return record;
      },
      () => { historyTrace?.end?.(span, { outcome: "failed" }); historyTrace?.finishFlow?.(flow, { outcome: "failed" }); retryHistoryContribution("requests", sessionId, contribution); return null; },
    );
  }

  function refreshSessionHistory(qualifiedId) {
    if (!observationServingActive) return;
    if (historyRefreshes.has(qualifiedId)) { historyDirty.add(qualifiedId); return; }
    const snapshot = observationStore.getByQualifiedId(qualifiedId);
    const provider = snapshot && registry.providers?.find((entry) => entry.id === snapshot.providerId);
    if (!snapshot || typeof provider?.readSessionHistory !== "function") return;
    const flow = historyTrace?.createFlow?.() || null;
    const readSpan = historyTrace?.begin?.({ stage: "history_read", domain: "activity", flow }) || null;
    let historyOutcome = "completed";
    const task = Promise.resolve(historyStore.activityFence(qualifiedId))
      .then((activityFence) => provider.readSessionHistory(snapshot.localSessionId)
        .then((history) => {
          historyTrace?.end?.(readSpan, { outcome: "completed" });
          const publishSpan = historyTrace?.begin?.({ stage: "history_publish", domain: "activity", flow }) || null;
          return historyStore.publish(qualifiedId, history, { activityFence }).then(
            (record) => {
              historyTrace?.end?.(publishSpan, { outcome: record ? "accepted" : "unchanged" });
              return record;
            },
            (error) => {
              historyTrace?.end?.(publishSpan, { outcome: "failed" });
              throw error;
            },
          );
        }))
      .catch(() => { historyOutcome = "failed"; return null; })
      .finally(() => {
        historyTrace?.end?.(readSpan, { outcome: "failed" });
        historyTrace?.finishFlow?.(flow, { outcome: historyOutcome });
        historyRefreshes.delete(qualifiedId);
        const dirty = historyDirty.delete(qualifiedId);
        if (dirty && observationServingActive) refreshSessionHistory(qualifiedId);
      });
    historyRefreshes.set(qualifiedId, task);
  }

  function checkpointPublicState({ providerId, localSessionId, evidence }) {
    const provider = registry.providers?.find((candidate) => candidate.id === providerId) || registry.defaultProvider;
    const historical = Boolean(evidence.historical);
    try {
      return {
        ...projectProviderSessionEvidence({
          evidence,
          sessionId: qualifiedSessionId(providerId, localSessionId),
          source: provider.source,
          capabilities: provider.capabilities,
          repositoryRoles: repositoryRoleMappings(evidence.session.cwd),
          repository: historical ? recordedGitState(evidence.session.recordedGitBranch) : { ...unavailableGitState(), historical: false },
          pullRequests: unavailablePullRequests(),
          usageLimits: createEmptyUsageLimits(),
          resources: historical ? null : unavailableResourceUsage(),
        }),
        readiness: createSessionReadiness("loading", {
          core: "ready",
          agentEvidence: "ready",
          contextEvidence: "ready",
          activityEvidence: "ready",
        }),
      };
    } catch {
      return {
        ...createEmptyMonitorState({ connected: true, source: provider.source, view: historical ? "history" : "live" }),
        readiness: createSessionReadiness("loading"),
      };
    }
  }

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
        await resourceUsageSampler.sample(resourceTargets);
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

  async function projectSelection(selection, { useObservedUsage = false } = {}) {
    const { evidence, provider, sessionId } = selection;
    const historical = evidence.historical;
    const capabilities = typeof registry.resolveCapabilities === "function"
      ? await registry.resolveCapabilities(provider, { historical })
      : provider.capabilities;
    let repository;
    let pullRequests;
    let enqueueLiveEnrichment = null;
    if (historical) {
      repository = recordedGitState(evidence.session.recordedGitBranch);
      try {
        pullRequests = await pullRequestReader([], {
          cwd: evidence.session.cwd,
          branch: repository.branch,
          historical: true,
          sessionCreations: evidence.pullRequestCreations,
        });
      } catch {
        pullRequests = unavailablePullRequests();
      }
    } else {
      const live = liveEnrichment(sessionId, evidence);
      ({ repository, pullRequests } = live.value);
      enqueueLiveEnrichment = live.enqueue;
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
    const state = projectProviderSessionEvidence({
      evidence,
      sessionId,
      source: provider.source,
      capabilities,
      repositoryRoles: repositoryRoleMappings(evidence.session.cwd),
      repository,
      pullRequests,
      usageLimits: currentUsageLimits,
      resources,
    });
    enqueueLiveEnrichment?.();
    return state;
  }

  const observationCoordinator = createSessionObservationCoordinator({
    registry,
    store: observationStore,
    checkpointStore,
    schedule: scheduleObservation,
    cancel: cancelObservation,
    commitDelayMs: options.observationCommitDelayMs,
    checkpointDelayMs: options.checkpointDelayMs,
    checkpointMaxDelayMs: options.checkpointMaxDelayMs,
    now,
    pipelineTrace: options.pipelineTrace,
    onHistoryContribution: publishHistoryContribution,
    onHistoryRequestContribution: publishHistoryRequestContribution,
    restoreState: checkpointPublicState,
    async deriveSession(candidate) {
      const provider = registry.providers?.find((entry) => entry.id === candidate.providerId);
      if (!provider) throw new TypeError("Unknown observed provider");
      const basePublicState = await projectSelection({
        provider,
        evidence: candidate.evidence,
        sessionId: qualifiedSessionId(candidate.providerId, candidate.localSessionId),
      }, { useObservedUsage: true });
      const association = await repositoryInventory.associateSession({
        sessionId: qualifiedSessionId(candidate.providerId, candidate.localSessionId),
        provider: candidate.providerId,
        startedAt: candidate.evidence.session.startedAt,
        cwd: candidate.evidence.session.cwd,
        previousReference: observationStore.get(candidate.providerId, candidate.localSessionId)?.publicState?.session?.contextInventoryRef,
      });
      const publicState = basePublicState.session ? {
        ...basePublicState,
        session: { ...basePublicState.session, ...association },
      } : basePublicState;
      const usageReadiness = usageResponseCache.current()?.value?.readiness?.[candidate.providerId] || "loading";
      const readiness = createSessionReadiness("ready", {
        repository: candidate.evidence.historical || publicState.session?.repository?.available ? "ready" : "loading",
        resources: candidate.evidence.historical
          ? "ready"
          : publicState.metrics?.resources?.status === "unavailable" ? "unavailable"
            : publicState.metrics?.resources?.status === "ready" ? "ready" : "loading",
        usageLimits: candidate.evidence.historical ? "unavailable" : usageReadiness,
      });
      return { publicState: { ...publicState, readiness }, readiness };
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
    // This D-only cache begins from the committed store and catalog. It never
    // invokes observers, hydration, parsing, or any provider read.
    agentsObservation.start();
    providerStatus.start();
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
        options.onSessionCommitted?.(event.qualifiedId);
        // Provider history acquisition belongs to the background observation
        // lifecycle. Serving only reads the committed, normalized history file.
        refreshSessionHistory(event.qualifiedId);
      }
      if (event.type === "catalog") cacheUnavailableSessionResponses();
      if (event.type === "session" || event.type === "catalog") agentQueryProjection.refresh();
      if (event.type === "session" || event.type === "catalog") {
        void repositoryInventory.reconcile(observationCoordinator.catalog()?.snapshot?.value?.sessions || []);
      }
      scheduleObservedHomeRefresh();
    });
    observationStartPromise = (async () => {
      await repositoryInventory.ready;
      await repositoryInventory.reconcile([]);
      repositoryInventory.startPluginObservation?.();
      await observationCoordinator.start();
      // Checkpoint-restored sessions may rederive unchanged and therefore do
      // not emit a fresh session commit. They still receive history hydration
      // from this background lifecycle, never from a serving request.
      for (const snapshot of observationStore.entries()) refreshSessionHistory(snapshot.qualifiedId);
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
      await repositoryInventory.stopPluginObservation?.();
      agentsObservation.stop();
      await providerStatus.stop();
      observationStartPromise = null;
      unsubscribeObservation?.();
      unsubscribeObservation = null;
      throw error;
    }
  }

  async function stopObservation() {
    observationServingActive = false;
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
    for (const pending of historyContributionRetries.values()) clearTimeout(pending.timer);
    historyContributionRetries.clear();
    historyDirty.clear();
    await observationCoordinator.stop();
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
    return () => { unsubscribe(); unsubscribeRepositories(); unsubscribeHistory(); };
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
    serveSession(sessionId, revision) {
      const result = observationCoordinator.session(sessionId, revision);
      if (result.status === "unavailable") {
        return { ...result, unavailableSnapshot: unavailableSessionResponses.get(result.selectedId) || null };
      }
      return result.status === "loading" || result.status === "empty"
        ? { ...result, loadingState: loadingState(result.selectedId, result.catalogEntry) }
        : result;
    },
    serveHome: (revision) => homeResponseCache.read(revision),
    serveUsageLimits: (revision) => usageResponseCache.read(revision),
    async serveSessionHistory(sessionId, query) {
      const servedAt = performance.now();
      const page = await historyStore.read(sessionId, query);
      historyTrace?.recordDuration?.({ stage: "cache_serve", domain: "serving", durationMs: Math.max(0, performance.now() - servedAt),
        outcome: page.status === "ready" ? "accepted" : page.status === "loading" ? "unchanged" : "rejected" });
      if (page.status !== "unavailable" || !observationServingActive) return page;
      const snapshot = observationStore.getByQualifiedId(sessionId);
      const provider = snapshot && registry.providers?.find((entry) => entry.id === snapshot.providerId);
      if (snapshot && typeof provider?.readSessionHistory === "function") {
        return { ...page, status: "loading" };
      }
      return page;
    },
    serveAgents: (query, revision) => agentsObservation.read(query, revision),
    serveProviderStatus: (revision) => providerStatus.read(revision),
    serveRepositories: (revision) => repositoryInventory.readRepositories(revision),
    readRepositoryInventory: (repositoryId, provider, revisionId) => repositoryInventory.readRevision(repositoryId, provider, revisionId),
    captureRepositoryInventory: (repositoryId, provider) => repositoryInventory.capture(repositoryId, provider),
    refreshRepositoryPluginSetup: (repositoryId, provider) => repositoryInventory.refreshPluginSetup(repositoryId, provider),
    readRepositoryPluginSetup: (repositoryId, provider) => repositoryInventory.readPluginSetup(repositoryId, provider),
    prepareRepositoryPluginAction: (repositoryId, provider, action) => repositoryInventory.preparePluginAction(repositoryId, provider, action),
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
    }),
  });
}
