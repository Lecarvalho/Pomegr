import http from "node:http";
import path from "node:path";
import { repositoryRoleMappings } from "./agent-roles.mjs";
import { homeSessionSummary, median, unavailableHomeSessionSummary } from "./home-session-summary.mjs";
import { readGitStateAsync } from "./git-state.mjs";
import { createHomeLimitActivityTracker } from "./limit-activity.mjs";
import { readPullRequests } from "./pull-requests.mjs";
import { publicResourceUsage, unavailableResourceUsage } from "./public-resource-usage.mjs";
import { createResourceUsageSampler } from "./resource-usage.mjs";
import { providerRegistry } from "./providers/index.mjs";
import { createEmptyMonitorState, createEmptyUsageLimits } from "../shared/monitor-state.mjs";
import { createObservationRuntime } from "./observation-runtime.mjs";
import { createRequestHandler } from "./request-handler.mjs";
import {
  closeServer,
  createLocalServiceHandle,
  listen,
  requireLoopbackHost,
  requirePort,
  safeServiceError,
} from "../shared/local-service.mjs";

const PORT = Number(process.env.SESSION_PULSE_PORT || 4317);
const HOST = "127.0.0.1";
const HOME_FIVE_HOUR_LIMIT_WINDOW_MS = 5 * 60 * 60_000;
const HOME_SEVEN_DAY_LIMIT_WINDOW_MS = 7 * 24 * 60 * 60_000;
const MAX_HOME_LIMIT_ACTIVITY_SESSIONS = 24;
const MAX_HOME_MODEL_SELECTION_SESSIONS = 50;

function isLimitActivityWindow(value) {
  const window = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  return window === "5 hours" || window === "5 hour" || window === "5h"
    || window === "7 days" || window === "7 day" || window === "7d";
}

function limitActivityWindowMs(provider, providerLimits, homePolicy) {
  const weeklyLimitIds = homePolicy?.usageLimitActivity?.weeklyLimitIds;
  const limits = providerLimits.find((item) => item?.provider === provider)?.usageLimits?.limits;
  return Array.isArray(limits) && limits.some((limit) => {
    const window = String(limit?.window || "").trim().toLowerCase().replace(/\s+/g, " ");
    const isSevenDays = window === "7 days" || window === "7 day" || window === "7d";
    return isSevenDays && (weeklyLimitIds === null || weeklyLimitIds?.includes(limit?.id));
  }) ? HOME_SEVEN_DAY_LIMIT_WINDOW_MS : HOME_FIVE_HOUR_LIMIT_WINDOW_MS;
}

function emptyUsageLimits(error = "") {
  return createEmptyUsageLimits(error ? { error } : {});
}

function unavailableGitState() {
  return {
    available: false,
    branch: "Not a Git repository",
    files: [],
    isMain: false,
    comparison: null,
    commits: [],
    remote: { status: "unavailable", checkedAt: null },
  };
}

function recordedGitState(branch) {
  return {
    available: Boolean(branch),
    branch,
    files: [],
    historical: true,
    isMain: false,
    comparison: null,
    commits: [],
    remote: { status: "unavailable", checkedAt: null },
  };
}

function unavailablePullRequests() {
  return { status: "unavailable", checkedAt: null, items: [] };
}

function safeTranscriptPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768) return null;
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export function createMonitorRuntime(options = {}) {
  const registry = options.providerRegistry || providerRegistry;
  const resourceUsageSampler = options.resourceUsageSampler || createResourceUsageSampler();
  const gitReader = options.readGitState || readGitStateAsync;
  const pullRequestReader = options.readPullRequests || readPullRequests;
  const now = options.now || (() => Date.now());
  const scheduleEnrichment = options.scheduleEnrichment || ((task) => setImmediate(task));
  const scheduleHomeRefresh = options.scheduleHomeRefresh || ((task) => setImmediate(task));
  const enrichmentCacheMs = Math.max(0, Number(options.enrichmentCacheMs ?? 2500));
  const enrichmentCache = new Map();
  const homeSummaryCacheMs = Math.max(0, Number(options.homeSummaryCacheMs ?? 5000));
  const homeHistorySummaryCacheMs = Math.max(0, Number(options.homeHistorySummaryCacheMs ?? 5 * 60_000));
  const homeSnapshotCacheMs = Math.max(0, Number(options.homeSnapshotCacheMs ?? 10_000));
  const deferHomeHistory = options.deferHomeHistory !== false;
  const yieldHomeHistory = options.yieldHomeHistory || (() => new Promise((resolve) => setImmediate(resolve)));
  const homeSummaryCache = new Map();
  const homeSummaryInFlight = new Map();
  const homeLimitActivityTracker = createHomeLimitActivityTracker();
  let homeSnapshotCached = null;
  let homeSnapshotInFlight = null;
  let homeSnapshotRefreshScheduled = false;
  let homeHistoryRefreshInFlight = null;
  let homeHistoryRefreshScheduled = false;

  async function refreshLiveEnrichment(entry, input) {
    let repository;
    try {
      repository = { ...await gitReader(input.cwd), historical: false };
    } catch {
      repository = { ...unavailableGitState(), historical: false };
    }
    let pullRequests;
    try {
      pullRequests = await pullRequestReader([], {
        cwd: input.cwd,
        branch: repository.branch,
        historical: false,
        sessionCreations: input.sessionCreations,
      });
    } catch {
      pullRequests = unavailablePullRequests();
    }
    const refreshedAt = now();
    if (entry.generation === input.generation) {
      entry.value = { repository, pullRequests };
      entry.refreshedAt = refreshedAt;
    }
  }

  function liveEnrichment(sessionId, evidence) {
    const sessionCreations = [...evidence.pullRequestCreations];
    const fingerprint = JSON.stringify([evidence.session.cwd, sessionCreations]);
    let entry = enrichmentCache.get(sessionId);
    if (!entry) {
      entry = {
        fingerprint,
        generation: 1,
        cwd: evidence.session.cwd,
        sessionCreations,
        refreshedAt: null,
        refreshing: false,
        value: {
          repository: { ...unavailableGitState(), historical: false },
          pullRequests: unavailablePullRequests(),
        },
      };
      enrichmentCache.set(sessionId, entry);
    } else if (entry.fingerprint !== fingerprint) {
      entry.fingerprint = fingerprint;
      entry.generation += 1;
      entry.cwd = evidence.session.cwd;
      entry.sessionCreations = sessionCreations;
      entry.refreshedAt = null;
      entry.refreshing = false;
      entry.value = {
        repository: { ...unavailableGitState(), historical: false },
        pullRequests: unavailablePullRequests(),
      };
    }
    const expired = entry.refreshedAt === null || now() - entry.refreshedAt >= enrichmentCacheMs;
    let enqueue = null;
    if (expired && !entry.refreshing) {
      entry.refreshing = true;
      const input = {
        generation: entry.generation,
        cwd: entry.cwd,
        sessionCreations: entry.sessionCreations,
      };
      enqueue = () => {
        try {
          scheduleEnrichment(() => {
            const work = refreshLiveEnrichment(entry, input)
              .catch(() => {
                if (entry.generation === input.generation) {
                  entry.value = {
                    repository: { ...unavailableGitState(), historical: false },
                    pullRequests: unavailablePullRequests(),
                  };
                  entry.refreshedAt = null;
                }
              })
              .finally(() => {
                if (entry.generation === input.generation) entry.refreshing = false;
              });
            void work.catch(() => {});
            return work;
          });
        } catch {
          if (entry.generation === input.generation) {
            entry.refreshing = false;
          }
        }
      };
    }
    return { value: entry.value, enqueue };
  }

  async function sessionCatalog() {
    if (observation.observationActive()) {
      return observation.coordinator?.catalog()?.snapshot?.value?.sessions || [];
    }
    const inspected = typeof registry.inspectSessions === "function"
      ? await registry.inspectSessions()
      : { sessions: await registry.listSessions(), resourceTargets: [] };
    try {
      await resourceUsageSampler.sample(inspected.resourceTargets);
    } catch {
      // Resource telemetry must never make session discovery unavailable.
    }
    return Array.isArray(inspected.sessions) ? inspected.sessions : [];
  }

  function liveSessionSummary(entry, summary) {
    return {
      id: entry.id,
      provider: entry.provider,
      source: entry.source,
      title: entry.title,
      project: entry.project,
      updatedAt: entry.updatedAt,
      isLive: Boolean(entry.isLive),
      needsInput: Boolean(entry.needsInput),
      activityStatus: entry.activityStatus || "unknown",
      agentCount: Number.isFinite(summary?.agentCount) ? summary.agentCount : null,
      activeAgentCount: Number.isFinite(summary?.activeAgentCount) ? summary.activeAgentCount : null,
      latestContextTotal: Number.isFinite(summary?.latestContextTotal) ? summary.latestContextTotal : null,
      progress: summary?.progress ?? null,
    };
  }

  async function sessionFeed() {
    const sessions = await sessionCatalog();
    const endMs = now();
    const liveSessions = await Promise.all(sessions.filter((entry) => entry?.isLive).map(async (entry) => {
      const cached = cachedHomeSummary(entry, endMs, () => null);
      const summary = cached.found ? cached.summary : await loadHomeSummary(entry, endMs, null);
      return liveSessionSummary(entry, summary);
    }));
    return {
      sessions,
      liveSessions,
    };
  }

  function homeSummaryCacheKey(entry) {
    return `${entry.id}|${entry.updatedAt}|${entry.isLive ? "live" : "history"}|${entry.needsInput ? "input" : entry.activityStatus || "unknown"}`;
  }

  function cachedHomeSummary(entry, endMs, resourceUsageFor) {
    const cached = homeSummaryCache.get(homeSummaryCacheKey(entry));
    if (!cached || cached.expiresAt <= endMs) return { found: false, summary: null };
    return { found: true, summary: decorateHomeSummary(entry, cached.summary, resourceUsageFor(entry.id)) };
  }

  function decorateHomeSummary(entry, summary, resourceUsage) {
    if (!summary || !entry.isLive) return summary;
    return { ...summary, resources: resourceUsage ? publicResourceUsage(resourceUsage) : null };
  }

  async function loadHomeSummary(entry, endMs, resourceUsage = null) {
    const cacheKey = homeSummaryCacheKey(entry);
    let refresh = homeSummaryInFlight.get(cacheKey);
    if (!refresh) {
      refresh = (async () => {
        let summary;
        try {
          const observed = observation.observationActive() ? observation.store.getByQualifiedId(entry.id) : null;
          const selection = observed
            ? { evidence: observed.evidence, provider: registry.providerForSessionId(entry.id), sessionId: entry.id }
            : observation.observationActive() ? null : await registry.readSession(entry.id, { catalogEntry: entry });
          summary = selection?.evidence
            ? homeSessionSummary(entry, selection.evidence, selection.provider?.homePolicy)
            : entry.isLive
              ? unavailableHomeSessionSummary(entry)
              : null;
        } catch {
          summary = entry.isLive ? unavailableHomeSessionSummary(entry, null) : null;
        }
        const cacheMs = entry.isLive ? homeSummaryCacheMs : homeHistorySummaryCacheMs;
        homeSummaryCache.set(cacheKey, { expiresAt: endMs + cacheMs, summary });
        return summary;
      })().finally(() => {
        if (homeSummaryInFlight.get(cacheKey) === refresh) homeSummaryInFlight.delete(cacheKey);
      });
      homeSummaryInFlight.set(cacheKey, refresh);
    }
    return decorateHomeSummary(entry, await refresh, resourceUsage);
  }

  function queueHomeHistoryRefresh(entries) {
    if (homeHistoryRefreshInFlight || homeHistoryRefreshScheduled || entries.length === 0) return;
    homeHistoryRefreshScheduled = true;
    try {
      scheduleHomeRefresh(() => {
        homeHistoryRefreshScheduled = false;
        const refresh = (async () => {
          for (const entry of entries) {
            const observedAt = now();
            const cached = cachedHomeSummary(entry, observedAt, () => null);
            if (!cached.found) await loadHomeSummary(entry, observedAt);
            try {
              await yieldHomeHistory();
            } catch {
              // A failed cooperative yield must not discard safely parsed history.
            }
          }
          homeSnapshotCached = null;
        })().finally(() => {
          if (homeHistoryRefreshInFlight === refresh) homeHistoryRefreshInFlight = null;
        });
        homeHistoryRefreshInFlight = refresh;
        void refresh.catch(() => {});
        return refresh;
      });
    } catch {
      homeHistoryRefreshScheduled = false;
    }
  }

  async function buildHomeSnapshot() {
    const providers = Array.isArray(registry.providers) ? registry.providers : [];
    const policiesById = new Map(providers.map((provider) => [provider.id, provider.homePolicy]));
    const providerLimitsPromise = observation.observationActive()
      ? Promise.resolve(providers
        .filter((provider) => provider?.homePolicy?.usageLimitActivity?.enabled)
        .map((provider) => ({
          provider: provider.id,
          source: provider.source,
          usageLimits: observation.observedUsageLimits(provider.id),
        })))
      : Promise.all(providers
        .filter((provider) => provider?.homePolicy?.usageLimitActivity?.enabled)
        .map(async (provider) => {
          let usageLimits = createEmptyUsageLimits();
          if (typeof registry.readUsageLimits === "function") {
            try {
              usageLimits = await registry.readUsageLimits(provider);
            } catch {
              usageLimits = createEmptyUsageLimits({ error: "Usage limits are temporarily unavailable." });
            }
          }
          return { provider: provider.id, source: provider.source, usageLimits };
        }));
    const inspectedPromise = observation.observationActive()
      ? Promise.resolve({ sessions: observation.coordinator?.catalog()?.snapshot?.value?.sessions || [], resourceTargets: [] })
      : typeof registry.inspectSessions === "function"
        ? registry.inspectSessions()
        : Promise.resolve(registry.listSessions()).then((sessions) => ({ sessions, resourceTargets: [] }));
    const [providerLimits, inspected] = await Promise.all([providerLimitsPromise, inspectedPromise]);
    homeLimitActivityTracker.observe(providerLimits, policiesById);
    if (!observation.observationActive()) {
      try {
        await resourceUsageSampler.sample(inspected.resourceTargets || []);
      } catch {
        // Resource telemetry must never make the home snapshot unavailable.
      }
    }
    const catalog = Array.isArray(inspected.sessions) ? inspected.sessions : [];
    const resourceUsageFor = (sessionId) => {
      try {
        return resourceUsageSampler.get(sessionId);
      } catch {
        return null;
      }
    };
    const liveEntries = catalog.filter((entry) => entry?.isLive);
    const endMs = now();
    const generatedAt = new Date(endMs).toISOString();
    for (const [cacheKey, cached] of homeSummaryCache) {
      if (!cached || cached.expiresAt <= endMs) homeSummaryCache.delete(cacheKey);
    }

    const activityProviderIds = new Set(providerLimits.flatMap(({ provider, usageLimits }) => (
      policiesById.get(provider)?.usageLimitActivity?.enabled
        && usageLimits?.limits?.some((limit) => isLimitActivityWindow(limit?.window))
        ? [provider]
        : []
    )));
    const activityEntries = [];
    const limitedActivityProviders = new Set();
    for (const provider of activityProviderIds) {
      const activityWindowMs = limitActivityWindowMs(provider, providerLimits, policiesById.get(provider));
      const candidates = catalog
        .filter((entry) => entry?.provider === provider && (
          entry.isLive || Date.parse(entry.updatedAt || "") >= endMs - activityWindowMs
        ))
        .sort((left, right) => Number(Boolean(right.isLive)) - Number(Boolean(left.isLive))
          || Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
      if (candidates.length > MAX_HOME_LIMIT_ACTIVITY_SESSIONS) limitedActivityProviders.add(provider);
      activityEntries.push(...candidates.slice(0, MAX_HOME_LIMIT_ACTIVITY_SESSIONS));
    }
    const modelSelectionProviderIds = new Set(providers
      .filter((provider) => provider?.homePolicy?.modelSelection)
      .map((provider) => provider.id));
    const modelSelectionEntries = catalog
      .filter((entry) => activityProviderIds.has(entry?.provider)
        && modelSelectionProviderIds.has(entry?.provider) && (
        entry.isLive || Date.parse(entry.updatedAt || "") >= endMs - HOME_SEVEN_DAY_LIMIT_WINDOW_MS
      ))
      .sort((left, right) => Number(Boolean(right.isLive)) - Number(Boolean(left.isLive))
        || Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""))
      .slice(0, MAX_HOME_MODEL_SELECTION_SESSIONS);
    const displayImmediateEntries = [...new Map([...liveEntries, ...activityEntries].map((entry) => [entry.id, entry])).values()];
    const displayImmediateEntryIds = new Set(displayImmediateEntries.map((entry) => entry.id));
    const modelSelectionEntryIds = new Set(modelSelectionEntries.map((entry) => entry.id));
    const immediateEntries = [...new Map([...displayImmediateEntries, ...modelSelectionEntries].map((entry) => [entry.id, entry])).values()];
    const loadedImmediate = await Promise.all(immediateEntries.map(async (entry) => {
      const cached = cachedHomeSummary(entry, endMs, resourceUsageFor);
      const summary = cached.found
        ? cached.summary
        : await loadHomeSummary(entry, endMs, entry.isLive ? resourceUsageFor(entry.id) : null);
      if ((!summary || summary.requestObservationsAvailable === false)
        && activityEntries.some((activityEntry) => activityEntry.id === entry.id)) {
        limitedActivityProviders.add(entry.provider);
      }
      return { entry, summary };
    }));
    const immediate = loadedImmediate.filter(({ entry }) => displayImmediateEntryIds.has(entry.id));
    const modelSelection = loadedImmediate.filter(({ entry }) => modelSelectionEntryIds.has(entry.id));

    const projectNames = new Set(liveEntries.map((entry) => entry.project || "Unknown project"));
    const startMs = endMs - 7 * 24 * 60 * 60_000;
    const relevantHistory = catalog.filter((entry) => !entry.isLive
      && !displayImmediateEntryIds.has(entry.id)
      && Date.parse(entry.updatedAt || "") >= startMs
      && projectNames.has(entry.project || "Unknown project"));
    const history = [];
    const missingHistory = [];
    for (const entry of relevantHistory) {
      const cached = cachedHomeSummary(entry, endMs, () => null);
      if (cached.found) history.push({ entry, summary: cached.summary });
      else missingHistory.push(entry);
    }
    const historyLoading = deferHomeHistory && missingHistory.length > 0;
    if (historyLoading) {
      queueHomeHistoryRefresh(missingHistory);
    } else if (missingHistory.length > 0) {
      history.push(...await Promise.all(missingHistory.map(async (entry) => ({
        entry,
        summary: await loadHomeSummary(entry, endMs),
      }))));
    }
    const summaries = [...immediate, ...history];
    const limitActivities = homeLimitActivityTracker.build({
      providerLimits,
      generatedAt,
      sessions: immediate.map(({ summary }) => summary).filter(Boolean),
      modelSelectionSessions: modelSelection.map(({ summary }) => summary).filter(Boolean),
      policiesByProvider: policiesById,
    }).map((activity) => limitedActivityProviders.has(activity.provider)
      ? { ...activity, eventsTruncated: true }
      : activity);
    const projects = [...projectNames].sort((left, right) => left.localeCompare(right)).map((project) => {
      const projectEntries = liveEntries.filter((entry) => (entry.project || "Unknown project") === project);
      const projectLive = summaries
        .filter(({ entry }) => entry.isLive && (entry.project || "Unknown project") === project)
        .map(({ summary }) => summary)
        .filter(Boolean);
      const projectHistory = summaries
        .filter(({ entry }) => !entry.isLive && (entry.project || "Unknown project") === project)
        .map(({ summary }) => summary)
        .filter((summary) => {
          const recordedMs = Date.parse(summary?.recordedUpdatedAt || "");
          return summary && Number.isFinite(recordedMs) && recordedMs >= startMs && recordedMs <= endMs;
        });
      const finalContexts = projectHistory
        .filter((summary) => Number.isFinite(summary.latestContextTotal)
          && Number.isFinite(Date.parse(summary.recordedUpdatedAt || "")))
        .sort((left, right) => Date.parse(left.recordedUpdatedAt) - Date.parse(right.recordedUpdatedAt))
        .slice(-6)
        .map((summary) => ({ endedAt: summary.recordedUpdatedAt, total: summary.latestContextTotal }));
      return {
        project,
        updatedAt: projectEntries.map((entry) => entry.updatedAt).sort().at(-1) || null,
        liveCount: projectEntries.length,
        sessions: projectLive.map((summary) => {
          const session = { ...summary };
          delete session.recordedUpdatedAt;
          delete session.wallTimeMs;
          delete session.isLive;
          delete session.createdAt;
          delete session.requestObservationsAvailable;
          delete session.requestObservations;
          delete session.requestModelObservations;
          delete session.usageLimitRejections;
          return session;
        }),
        history: {
          status: historyLoading ? "loading" : "ready",
          windowDays: 7,
          completed: projectHistory.length,
          medianWallTimeMs: median(projectHistory.map((summary) => summary.wallTimeMs)),
          medianFinalContext: median(projectHistory.map((summary) => summary.latestContextTotal)),
          finalContexts,
        },
      };
    });
    return {
      generatedAt,
      providerLimits,
      limitActivities,
      projects,
    };
  }

  function refreshHomeSnapshot() {
    if (homeSnapshotInFlight) return homeSnapshotInFlight;
    const refresh = buildHomeSnapshot()
      .then((snapshot) => {
        homeSnapshotCached = {
          expiresAt: now() + homeSnapshotCacheMs,
          snapshot,
        };
        return snapshot;
      })
      .finally(() => {
        if (homeSnapshotInFlight === refresh) homeSnapshotInFlight = null;
      });
    homeSnapshotInFlight = refresh;
    return refresh;
  }

  function queueHomeSnapshotRefresh() {
    if (homeSnapshotInFlight || homeSnapshotRefreshScheduled) return;
    homeSnapshotRefreshScheduled = true;
    try {
      scheduleHomeRefresh(() => {
        homeSnapshotRefreshScheduled = false;
        const refresh = refreshHomeSnapshot();
        void refresh.catch(() => {});
        return refresh;
      });
    } catch {
      homeSnapshotRefreshScheduled = false;
    }
  }

  async function homeSnapshot() {
    if (homeSnapshotCacheMs === 0) return refreshHomeSnapshot();
    if (homeSnapshotCached?.expiresAt > now()) return homeSnapshotCached.snapshot;
    if (homeSnapshotCached) {
      queueHomeSnapshotRefresh();
      return homeSnapshotCached.snapshot;
    }
    return refreshHomeSnapshot();
  }

  async function analyze(requestedSessionId = "") {
  const selection = await registry.readSession(requestedSessionId);
  if (!selection) {
    const historical = Boolean(requestedSessionId);
    const provider = requestedSessionId
      ? registry.providerForSessionId(requestedSessionId)
      : registry.defaultProvider;
    const capabilities = typeof registry.resolveCapabilities === "function"
      ? await registry.resolveCapabilities(provider, { historical })
      : provider?.capabilities || registry.defaultProvider.capabilities;
    return createEmptyMonitorState({
      connected: true,
      source: provider?.source || registry.defaultProvider.source,
      capabilities,
      view: historical ? "history" : "live",
      usageLimits: await registry.readUsageLimits(provider, { historical, capabilities }),
      error: registry.unavailableMessage(requestedSessionId),
    });
  }

  return observation.projectSelection(selection);
  }

  async function transcriptPath(requestedSessionId = "", agentId = "") {
    if (typeof requestedSessionId !== "string" || requestedSessionId.length === 0 || requestedSessionId.length > 256) return null;
    if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 256 || /[\u0000-\u001f\u007f]/.test(agentId)) return null;
    const selection = await registry.readSession(requestedSessionId);
    const agent = selection?.evidence?.agents?.find((candidate) => candidate?.id === agentId);
    if (!agent?.transcriptAvailable || typeof selection.provider?.readTranscriptPath !== "function") return null;
    return safeTranscriptPath(await selection.provider.readTranscriptPath(selection.evidence.localId, agentId));
  }

  function analyzeEmpty() {
    return createEmptyMonitorState({ source: registry.defaultProvider.source, usageLimits: emptyUsageLimits() });
  }

  const observation = createObservationRuntime({
    ...options,
    registry,
    resourceUsageSampler,
    pullRequestReader,
    now,
    scheduleHomeRefresh,
    buildHomeSnapshot: () => buildHomeSnapshot(),
    liveEnrichment,
    recordedGitState,
    unavailableGitState,
    unavailablePullRequests,
    repositoryRoleMappings,
    publicResourceUsage,
    unavailableResourceUsage,
    createEmptyMonitorState,
    createEmptyUsageLimits,
    onSessionCommitted(qualifiedId) {
      for (const key of homeSummaryCache.keys()) {
        if (key.startsWith(`${qualifiedId}|`)) homeSummaryCache.delete(key);
      }
      homeSnapshotCached = null;
    },
  });

  return Object.freeze({
    analyze,
    analyzeEmpty,
    sessionCatalog,
    sessionFeed,
    homeSnapshot,
    transcriptPath,
    startObservation: observation.startObservation,
    stopObservation: observation.stopObservation,
    observationActive: observation.observationActive,
    serveCatalog: observation.serveCatalog,
    serveSession: observation.serveSession,
    serveHome: observation.serveHome,
    serveUsageLimits: observation.serveUsageLimits,
    observationDiagnostics: observation.diagnostics,
  });
}

export function createMonitorRequestHandler(options = {}) {
  const runtime = options.runtime || createMonitorRuntime(options);
  return createRequestHandler({ runtime, authorizationToken: options.authorizationToken });
}

export function createMonitorServer(options = {}) {
  return http.createServer(createMonitorRequestHandler(options));
}

export async function startMonitorServer(options = {}) {
  let server;
  let handle;
  let runtime;
  try {
    const port = requirePort(options.port ?? PORT, "MONITOR_INVALID_PORT");
    const host = requireLoopbackHost(options.host ?? HOST, "MONITOR_INVALID_HOST");
    const registry = options.providerRegistry || providerRegistry;
    runtime = options.runtime || createMonitorRuntime(options);
    server = (options.serverFactory || createMonitorServer)({ ...options, runtime });
    await listen(server, { host, port, startupErrorCode: "MONITOR_START_FAILED" });
    handle = createLocalServiceHandle(server, {
      host,
      normalExitCode: "MONITOR_CLOSED",
      unexpectedExitCode: "MONITOR_EXIT_UNEXPECTED",
      onClose: () => { void runtime.stopObservation?.(); },
    });
    await runtime.startObservation?.();
    // Provider-owned watch targets remain private and are initialized only
    // after the listener and background observation lifecycle are ready.
    await registry.watchTargets();
    options.logger?.log?.(`[pomegr] Monitor ready on ${handle.origin}.`);
    let closePromise = null;
    const close = () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await runtime.stopObservation?.();
        await handle.close();
      })();
      return closePromise;
    };
    return Object.freeze({ ...handle, close });
  } catch (error) {
    try { await runtime?.stopObservation?.(); } catch { /* preserve bounded startup failure */ }
    if (handle) await handle.close();
    else await closeServer(server);
    throw safeServiceError(error, "MONITOR_START_FAILED");
  }
}
