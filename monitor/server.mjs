import crypto from "node:crypto";
import http from "node:http";
import { recentActivityEvents, shellFailureActivityEvents } from "./activity-events.mjs";
import { isRunningAgent } from "./agent-metadata.mjs";
import { buildCacheEvents } from "./cache-events.mjs";
import { buildContextHistory } from "./context-history.mjs";
import { EFFICIENCY_SIGNAL_RULES, evaluateEfficiencySignals } from "./efficiency-signals.mjs";
import { readGitStateAsync } from "./git-state.mjs";
import { readPullRequests } from "./pull-requests.mjs";
import { createResourceUsageSampler } from "./resource-usage.mjs";
import { concurrentMutationOverlaps } from "./tool-efficiency.mjs";
import { providerRegistry } from "./providers/index.mjs";
import { createEmptyMonitorState, createEmptyUsageLimits } from "../shared/monitor-state.mjs";
import { requestHasDesktopAuthorization, requireDesktopToken } from "../shared/local-auth.mjs";
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
const RESOURCE_USAGE_STATUSES = new Set(["collecting", "ready", "unavailable"]);
const RESOURCE_USAGE_REASONS = new Set([
  "unsupported_platform",
  "missing_owner",
  "shared_owner",
  "owner_not_found",
  "owner_identity_mismatch",
  "collection_failed",
]);

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

function unavailableResourceUsage() {
  return {
    status: "unavailable",
    reason: "collection_failed",
    current: null,
    observedPeak: null,
    samples: [],
  };
}

function resourceNumber(value, nullable = false) {
  if (nullable && value === null) return null;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function publicResourceUsage(value) {
  if (!value || !RESOURCE_USAGE_STATUSES.has(value.status)) return null;
  const status = value.status;
  const reason = status === "unavailable" && RESOURCE_USAGE_REASONS.has(value.reason)
    ? value.reason
    : null;
  if (status === "unavailable" && !reason) return unavailableResourceUsage();
  const memoryBytes = resourceNumber(value.current?.memoryBytes);
  const current = value.current && memoryBytes !== null ? {
    cpuCores: resourceNumber(value.current.cpuCores, true),
    cpuMachinePercent: resourceNumber(value.current.cpuMachinePercent, true),
    memoryBytes,
    readBytesPerSecond: resourceNumber(value.current.readBytesPerSecond, true),
    writeBytesPerSecond: resourceNumber(value.current.writeBytesPerSecond, true),
  } : null;
  const peakMemoryBytes = resourceNumber(value.observedPeak?.memoryBytes);
  const samples = Array.isArray(value.samples) ? value.samples.flatMap((sample) => {
    const timestamp = typeof sample?.timestamp === "string" && Number.isFinite(Date.parse(sample.timestamp))
      ? sample.timestamp
      : null;
    if (!timestamp) return [];
    return [{
      timestamp,
      cpuCores: resourceNumber(sample.cpuCores, true),
      cpuMachinePercent: resourceNumber(sample.cpuMachinePercent, true),
      memoryBytes: resourceNumber(sample.memoryBytes, true),
      readBytesPerSecond: resourceNumber(sample.readBytesPerSecond, true),
      writeBytesPerSecond: resourceNumber(sample.writeBytesPerSecond, true),
    }];
  }) : [];
  return {
    status,
    reason,
    current,
    observedPeak: peakMemoryBytes === null ? null : { memoryBytes: peakMemoryBytes },
    samples,
  };
}

function groupToolEvidence(toolCalls) {
  const repetitionMap = new Map();
  const patternMap = new Map();
  const mutationEvents = [];
  for (const call of toolCalls) {
    const repetitionKey = `${call.actor.id}|${call.repetitionSignature}`;
    const repetition = repetitionMap.get(repetitionKey);
    repetitionMap.set(repetitionKey, {
      count: (repetition?.count || 0) + 1,
      actor: call.actor,
      tool: call.tool,
      detail: call.detail,
      sig: call.repetitionSignature,
    });
    const patternKey = `${call.actor.id}|${call.tool}|${call.detail}`;
    const pattern = patternMap.get(patternKey);
    patternMap.set(patternKey, {
      count: (pattern?.count || 0) + 1,
      actor: call.actor,
      tool: call.tool,
      detail: call.detail,
    });
    if (call.mutation) mutationEvents.push({
      actorId: call.actor.id,
      timestamp: call.timestamp,
      display: call.mutation.display,
      scopes: call.mutation.scopes,
    });
  }
  return {
    repetitionCandidates: [...repetitionMap.values()],
    groupedTools: [...patternMap.values()].sort((a, b) => b.count - a.count),
    mutationEvents,
  };
}

function applyLatestUsage(agents, usageSnapshots, startedAt, updatedAt) {
  const snapshotsById = new Map(usageSnapshots.map((snapshot) => [snapshot.dedupeId, snapshot]));
  const visibleAgentIds = new Set(agents.map((agent) => agent.id));
  const boundedByAgent = new Map();
  for (const snapshot of snapshotsById.values()) {
    if (!visibleAgentIds.has(snapshot.actorId)) continue;
    boundedByAgent.set(snapshot.actorId, [...(boundedByAgent.get(snapshot.actorId) || []), snapshot]);
  }
  const snapshots = [...boundedByAgent.values()].flatMap((items) => items
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId))
    .slice(-100));
  const latestByAgent = new Map();
  for (const usage of snapshots) {
    const usageTime = new Date(usage.timestamp).getTime();
    const previous = latestByAgent.get(usage.actorId);
    const snapshotTotal = usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
    if (snapshotTotal > 0 && (!previous || usageTime >= new Date(previous.timestamp).getTime())) {
      latestByAgent.set(usage.actorId, usage);
    }
  }
  for (const agent of agents) {
    const latest = latestByAgent.get(agent.id) || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const total = latest.input + latest.output + latest.cacheWrite + latest.cacheRead;
    agent.tokens = {
      input: latest.input,
      output: latest.output,
      cacheWrite: latest.cacheWrite,
      cacheRead: latest.cacheRead,
      total,
      ...(Number.isFinite(latest.reasoningOutput) ? { reasoningOutput: latest.reasoningOutput } : {}),
      ...(Number.isFinite(latest.modelContextWindow) ? { modelContextWindow: latest.modelContextWindow } : {}),
    };
  }
  return {
    allAgents: agents.reduce((total, agent) => total + agent.tokens.total, 0),
    input: agents.reduce((total, agent) => total + agent.tokens.input, 0),
    output: agents.reduce((total, agent) => total + agent.tokens.output, 0),
    cacheWrite: agents.reduce((total, agent) => total + agent.tokens.cacheWrite, 0),
    cacheRead: agents.reduce((total, agent) => total + agent.tokens.cacheRead, 0),
    contextHistory: buildContextHistory(snapshots, { startedAt, updatedAt }),
    cacheEvents: { status: "unavailable", items: [] },
  };
}

export function createMonitorRuntime(options = {}) {
  const registry = options.providerRegistry || providerRegistry;
  const resourceUsageSampler = options.resourceUsageSampler || createResourceUsageSampler();
  const gitReader = options.readGitState || readGitStateAsync;
  const pullRequestReader = options.readPullRequests || readPullRequests;
  const now = options.now || (() => Date.now());
  const scheduleEnrichment = options.scheduleEnrichment || ((task) => setImmediate(task));
  const enrichmentCacheMs = Math.max(0, Number(options.enrichmentCacheMs ?? 2500));
  const enrichmentCache = new Map();

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
    const inspected = typeof registry.inspectSessions === "function"
      ? await registry.inspectSessions()
      : { sessions: await registry.listSessions(), resourceTargets: [] };
    try {
      await resourceUsageSampler.sample(inspected.resourceTargets);
    } catch {
      // Resource telemetry must never make session discovery unavailable.
    }
    return inspected.sessions;
  }

  async function analyze(requestedSessionId = "") {
  const selection = await registry.readSession(requestedSessionId);
  if (!selection) {
    const historical = Boolean(requestedSessionId);
    const provider = requestedSessionId
      ? registry.providerForSessionId(requestedSessionId)
      : registry.defaultProvider;
    return createEmptyMonitorState({
      connected: true,
      source: provider?.source || registry.defaultProvider.source,
      capabilities: provider?.capabilities || registry.defaultProvider.capabilities,
      view: historical ? "history" : "live",
      usageLimits: await registry.readUsageLimits(provider, { historical }),
      error: registry.unavailableMessage(requestedSessionId),
    });
  }

  const { evidence, provider, sessionId } = selection;
  const historical = evidence.historical;
  const agents = evidence.agents.map((agent) => ({ workflowId: null, workflowPhaseId: null, ...agent }));
  const tokenUsage = applyLatestUsage(agents, evidence.usageSnapshots, evidence.session.startedAt, evidence.session.updatedAt);
  const { groupedTools, repetitionCandidates, mutationEvents } = groupToolEvidence(evidence.toolCalls);
  const overlaps = concurrentMutationOverlaps(mutationEvents, EFFICIENCY_SIGNAL_RULES.concurrentMutation.windowMs);
  const compactions = evidence.compactions.map((compaction) => ({
    ...compaction,
    actor: {
      id: compaction.actorId,
      label: agents.find((agent) => agent.id === compaction.actorId)?.label || "Agent",
    },
  }));
  tokenUsage.cacheEvents = buildCacheEvents({
    sessionId,
    agents,
    usageSnapshots: evidence.usageSnapshots,
    compactions,
    enabled: evidence.efficiencyRuleEvidence.cacheUsageClassification,
  });
  const { insights, loops } = evaluateEfficiencySignals({
    agents,
    repetitionCandidates,
    overlaps,
    compactions,
    cacheEvents: tokenUsage.cacheEvents.items,
    availableEvidence: evidence.efficiencyRuleEvidence,
  });
  const repeatedCalls = loops.reduce((total, item) => total + item.count - 1, 0);
  const toolPatterns = groupedTools.map((item) => ({
    id: crypto.createHash("sha1").update(`${item.actor.id}|${item.tool}|${item.detail}`).digest("hex").slice(0, 12),
    agent: item.actor.label,
    tool: item.tool,
    detail: item.detail,
    calls: item.count,
  }));
  const loopPatterns = loops.map((loop, loopIndex) => ({
    id: `loop-${loop.actor.id}-${loopIndex}`,
    agent: loop.actor.label,
    tool: loop.tool,
    detail: loop.detail,
    calls: loop.count,
    repeats: loop.count - 1,
  }));
  const allEvents = [
    ...evidence.activity,
    ...evidence.toolCalls.map((call) => ({
      id: call.id,
      timestamp: call.timestamp,
      actor: call.actor.label,
      tool: call.tool,
      detail: call.detail,
      status: call.status === "failed" ? "failed" : null,
    })),
  ];
  const executionTasks = agents.find((agent) => agent.id === "primary")?.executionTasks || [];
  const primaryActor = agents.find((agent) => agent.id === "primary")?.label || "Primary agent";
  allEvents.push(...shellFailureActivityEvents(executionTasks, primaryActor));

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
  const currentUsageLimits = await registry.readUsageLimits(provider, { historical });
  const score = Math.max(25, 100 - Math.min(45, repeatedCalls * 4) - Math.min(25, overlaps.length * 7));
  const activeAgents = agents.filter(isRunningAgent).length;
  agents.sort((a, b) => (a.id === "primary" ? -1 : b.id === "primary" ? 1 : new Date(b.lastSeen) - new Date(a.lastSeen)));

  const state = {
    connected: true,
    source: provider.source,
    capabilities: provider.capabilities,
    view: historical ? "history" : "live",
    session: {
      id: sessionId,
      title: evidence.session.title,
      project: evidence.session.project,
      cwd: evidence.session.cwd,
      repository,
      pullRequests,
      startedAt: evidence.session.startedAt,
      updatedAt: evidence.session.updatedAt,
      durationMs: evidence.session.startedAt && evidence.session.updatedAt
        ? Math.max(0, new Date(evidence.session.updatedAt).getTime() - new Date(evidence.session.startedAt).getTime())
        : 0,
      cost: evidence.session.cost,
      approvalMode: evidence.session.approvalMode,
      contextMachinery: evidence.session.contextMachinery,
      summary: evidence.session.summary,
      signal: evidence.session.signal,
    },
    score,
    metrics: {
      agents: agents.length,
      activeAgents,
      toolCalls: agents.reduce((total, agent) => total + agent.toolCalls, 0),
      repeatedCalls,
      resources: historical ? null : (() => {
        try {
          return publicResourceUsage(resourceUsageSampler.get(sessionId));
        } catch {
          return unavailableResourceUsage();
        }
      })(),
      tokens: tokenUsage,
    },
    agents,
    workflows: evidence.workflows || [],
    toolPatterns,
    loops: loopPatterns,
    activity: recentActivityEvents(allEvents),
    executionTasks,
    planTasks: evidence.planTasks,
    insights,
    usageLimits: currentUsageLimits,
  };
  enqueueLiveEnrichment?.();
  return state;
  }

  function analyzeEmpty() {
    return createEmptyMonitorState({ source: registry.defaultProvider.source, usageLimits: emptyUsageLimits() });
  }

  return Object.freeze({ analyze, analyzeEmpty, sessionCatalog });
}

export function createMonitorRequestHandler(options = {}) {
  const runtime = options.runtime || createMonitorRuntime(options);
  const authorizationToken = options.authorizationToken
    ? requireDesktopToken(options.authorizationToken, "MONITOR_INVALID_AUTHORIZATION")
    : "";
  return async (request, response) => {
  const localAddress = request.socket?.localAddress;
  const localPort = request.socket?.localPort;
  const expectedHost = localAddress && localPort ? `${localAddress}:${localPort}` : "";
  const desktopRequestAllowed = !authorizationToken || (
    ["GET", "HEAD"].includes(request.method || "")
    && request.headers.host === expectedHost
    && request.headers.origin === undefined
    && requestHasDesktopAuthorization(request, authorizationToken)
  );
  if (!desktopRequestAllowed) {
    response.writeHead(401, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Unauthorized");
    return;
  }
  if (!authorizationToken) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  }
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/api/sessions") {
    try {
      const body = JSON.stringify({ sessions: await runtime.sessionCatalog() });
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(body);
    } catch {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ sessions: [], error: "Session catalog error" }));
    }
    return;
  }
  if (requestUrl.pathname === "/api/state") {
    try {
      const sessionId = requestUrl.searchParams.get("sessionId") || "";
      const body = JSON.stringify(await runtime.analyze(sessionId));
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(body);
    } catch {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ...runtime.analyzeEmpty(), error: "Monitor error" }));
    }
    return;
  }
  if (requestUrl.pathname === "/health") { response.writeHead(204); response.end(); return; }
  response.writeHead(404); response.end("Not found");
  };
}

export function createMonitorServer(options = {}) {
  return http.createServer(createMonitorRequestHandler(options));
}

export async function startMonitorServer(options = {}) {
  let server;
  let handle;
  try {
    const port = requirePort(options.port ?? PORT, "MONITOR_INVALID_PORT");
    const host = requireLoopbackHost(options.host ?? HOST, "MONITOR_INVALID_HOST");
    const registry = options.providerRegistry || providerRegistry;
    server = (options.serverFactory || createMonitorServer)(options);
    await listen(server, { host, port, startupErrorCode: "MONITOR_START_FAILED" });
    handle = createLocalServiceHandle(server, {
      host,
      normalExitCode: "MONITOR_CLOSED",
      unexpectedExitCode: "MONITOR_EXIT_UNEXPECTED",
    });
    // Initialize provider-owned watch targets only after the listener is ready.
    // The values are intentionally neither logged nor exposed by this seam.
    await registry.watchTargets();
    options.logger?.log?.(`[pomegr] Monitor ready on ${handle.origin}.`);
    return handle;
  } catch (error) {
    if (handle) await handle.close();
    else await closeServer(server);
    throw safeServiceError(error, "MONITOR_START_FAILED");
  }
}
