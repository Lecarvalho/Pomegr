import crypto from "node:crypto";
import http from "node:http";
import { recentActivityEvents, shellFailureActivityEvents } from "./activity-events.mjs";
import { isRunningAgent } from "./agent-metadata.mjs";
import { buildContextGrowthTimeline } from "./context-growth-timeline.mjs";
import { EFFICIENCY_SIGNAL_RULES, evaluateEfficiencySignals } from "./efficiency-signals.mjs";
import { readGitState } from "./git-state.mjs";
import { readPullRequests } from "./pull-requests.mjs";
import { concurrentMutationOverlaps } from "./tool-efficiency.mjs";
import { providerRegistry } from "./providers/index.mjs";
import { createEmptyMonitorState, createEmptyUsageLimits } from "../shared/monitor-state.mjs";

const PORT = Number(process.env.SESSION_PULSE_PORT || 4317);
const gitCache = new Map();

function emptyUsageLimits(error = "") {
  return createEmptyUsageLimits(error ? { error } : {});
}

function gitState(cwd) {
  const cached = gitCache.get(cwd);
  if (cached && Date.now() - cached.timestamp < 2500) return cached.value;
  const value = readGitState(cwd);
  gitCache.set(cwd, { timestamp: Date.now(), value });
  return value;
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

async function sessionCatalog() {
  return providerRegistry.listSessions();
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
  const snapshots = [...snapshotsById.values()];
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
    contextGrowthTimeline: buildContextGrowthTimeline(snapshots, { startedAt, updatedAt }),
  };
}

async function analyze(requestedSessionId = "") {
  const selection = await providerRegistry.readSession(requestedSessionId);
  if (!selection) {
    const historical = Boolean(requestedSessionId);
    const provider = requestedSessionId
      ? providerRegistry.providerForSessionId(requestedSessionId)
      : providerRegistry.defaultProvider;
    return createEmptyMonitorState({
      connected: true,
      source: provider?.source || providerRegistry.defaultProvider.source,
      capabilities: provider?.capabilities || providerRegistry.defaultProvider.capabilities,
      view: historical ? "history" : "live",
      usageLimits: await providerRegistry.readUsageLimits(provider, { historical }),
      error: providerRegistry.unavailableMessage(requestedSessionId),
    });
  }

  const { evidence, provider, sessionId } = selection;
  const historical = evidence.historical;
  const agents = evidence.agents.map((agent) => ({ ...agent }));
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
  const { insights, loops } = evaluateEfficiencySignals({
    agents,
    repetitionCandidates,
    overlaps,
    compactions,
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

  const repository = historical
    ? recordedGitState(evidence.session.recordedGitBranch)
    : { ...gitState(evidence.session.cwd), historical: false };
  const pullRequests = await readPullRequests([], {
    cwd: evidence.session.cwd,
    branch: repository.branch,
    historical,
    sessionCreations: evidence.pullRequestCreations,
  });
  const currentUsageLimits = await providerRegistry.readUsageLimits(provider, { historical });
  const score = Math.max(25, 100 - Math.min(45, repeatedCalls * 4) - Math.min(25, overlaps.length * 7));
  const activeAgents = agents.filter(isRunningAgent).length;
  agents.sort((a, b) => (a.id === "primary" ? -1 : b.id === "primary" ? 1 : new Date(b.lastSeen) - new Date(a.lastSeen)));

  return {
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
      tokens: tokenUsage,
    },
    agents,
    toolPatterns,
    loops: loopPatterns,
    activity: recentActivityEvents(allEvents),
    executionTasks,
    planTasks: evidence.planTasks,
    insights,
    usageLimits: currentUsageLimits,
  };
}

function analyzeEmpty() {
  return createEmptyMonitorState({ source: providerRegistry.defaultProvider.source, usageLimits: emptyUsageLimits() });
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/api/sessions") {
    try {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ sessions: await sessionCatalog() }));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ sessions: [], error: error instanceof Error ? error.message : "Session catalog error" }));
    }
    return;
  }
  if (requestUrl.pathname === "/api/state") {
    try {
      const sessionId = requestUrl.searchParams.get("sessionId") || "";
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(await analyze(sessionId)));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ...analyzeEmpty(), error: error instanceof Error ? error.message : "Monitor error" }));
    }
    return;
  }
  if (requestUrl.pathname === "/health") { response.writeHead(204); response.end(); return; }
  response.writeHead(404); response.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Threadlight monitor: http://127.0.0.1:${PORT}`);
  const watchTargets = providerRegistry.watchTargets();
  if (watchTargets.length) console.log(`Watching: ${watchTargets.join(", ")}`);
});
