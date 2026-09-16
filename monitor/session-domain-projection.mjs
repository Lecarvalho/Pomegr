import { repositoryRelativePath } from "./repository-path.mjs";

const EMPTY_ACTIVITY = Object.freeze({ total: 0, toolCalls: 0, byKind: [], messages: 0, failed: 0 });

function readiness(value, fallback = "unavailable") {
  return ["loading", "ready", "unavailable"].includes(value) ? value : fallback;
}
function sectionReadiness(ready, names) {
  return Object.fromEntries(names.map((name) => [name, readiness(ready?.[name])]));
}
function aggregateReadiness(sections) {
  const values = Object.values(sections);
  if (values.includes("loading")) return "loading";
  return values.some((value) => value === "ready") ? "ready" : "unavailable";
}

function fields(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(names.filter((name) => Object.hasOwn(value, name)).map((name) => [name, value[name]]));
}
function list(value, project) { return Array.isArray(value) ? value.map(project).filter(Boolean) : []; }
function publicSignal(value) { return fields(value, ["label", "tone", "reportedAt", "description"]); }
function publicTask(value) {
  const result = fields(value, ["id", "label", "kind", "workKind", "status", "background", "backgroundId", "startedAt", "finishedAt", "exitCode", "failureCause"]);
  return result ? { ...result, signal: publicSignal(value.signal) } : null;
}
function publicReviewFeed(value) {
  const result = fields(value, ["total", "allowed", "denied", "truncated"]);
  return result ? { ...result, items: list(value.items, (item) => fields(item, ["action", "outcome", "risk", "durationMs", "reviewedAt"])) } : null;
}
function publicAgent(value) {
  const result = fields(value, ["id", "parentId", "transcriptAvailable", "workflowId", "workflowPhaseId", "workflowOrder", "workflowState",
    "assignment", "label", "role", "customType", "model", "effort", "status", "toolCalls", "lastSeen", "startedAt", "updatedAt", "durationMs", "cacheLifetime"]);
  if (!result) return null;
  return {
    ...result,
    liveness: fields(value.liveness, ["source", "observedAt", "evidence", "freshness", "reason"]),
    signal: publicSignal(value.signal),
    currentActivity: fields(value.currentActivity, ["label", "observedAt"]),
    skills: list(value.skills, (skill) => fields(skill, ["name", "calls", "lastUsed"])),
    executionTasks: list(value.executionTasks, publicTask),
    reviewDecisions: publicReviewFeed(value.reviewDecisions),
    tokens: fields(value.tokens, ["total", "input", "output", "cacheWrite", "cacheRead", "reasoningOutput", "modelContextWindow"]) || {},
  };
}
function publicWorkflow(value) {
  const result = fields(value, ["id", "name", "summary", "status", "metadataStatus", "startedAt", "updatedAt", "durationMs", "agentIds"]);
  return result ? { ...result, phases: list(value.phases, (phase) => fields(phase, ["id", "label", "agentIds"])) } : null;
}
function publicPlanTask(value) { return fields(value, ["id", "subject", "status", "blocks", "blockedBy"]); }
function publicInsight(value) { return fields(value, ["id", "level", "title", "detail", "agentId"]); }
function publicLoop(value) { return fields(value, ["id", "agent", "agentId", "tool", "detail", "calls", "repeats"]); }
function publicToolPattern(value) { return fields(value, ["id", "agent", "tool", "detail", "calls"]); }
function publicRequest(value) {
  const result = fields(value, ["id", "agentId", "observedAt", "cacheLifetime", "uncachedInputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens",
    "totalTokens", "precedingAssociation", "issuedAssociation"]);
  return result ? { ...result,
    precedingWork: list(value.precedingWork, (work) => fields(work, ["kind", "count"])),
    issuedWork: list(value.issuedWork, (work) => fields(work, ["kind", "count"])),
  } : null;
}
function publicRequestFeed(value, project = (item) => item) {
  return {
    status: value?.status === "ready" ? "ready" : "unavailable",
    items: list(value?.items, publicRequest).map(project).filter(Boolean),
  };
}
function publicContext(value) {
  return {
    bucketMs: value?.bucketMs || 0,
    buckets: list(value?.buckets, (bucket) => {
      const result = fields(bucket, ["start", "end", "total"]);
      return result ? { ...result, agents: list(bucket.agents, (agent) => fields(agent, ["agentId", "total"])) } : null;
    }),
    boundaries: list(value?.boundaries, (boundary) => fields(boundary, ["id", "agentId", "timestamp", "kind", "preTokens"])),
  };
}
function publicCacheEvents(value) {
  return {
    status: value?.status || "unavailable",
    items: list(value?.items, (item) => fields(item, ["id", "agentId", "kind", "observedAt", "promptInputTokens", "cacheReadPercent", "cacheWriteTokens",
      "previousCacheReadPercent", "gapMs", "relatedEventId"])),
    possibleFullRefills: list(value?.possibleFullRefills, (refill) => ({
      ...fields(refill, ["agentId", "count"]),
      occurrences: list(refill.occurrences, (occurrence) => ({
        ...fields(occurrence, ["observedAt", "reason", "providerStatus", "messageChangeSequence"]),
        cacheLifetimeInference: fields(occurrence.cacheLifetimeInference, ["cause", "cacheLifetime", "elapsedMs"]),
        toolChangeAttribution: occurrence.toolChangeAttribution ? {
          ...fields(occurrence.toolChangeAttribution, ["cause"]),
          changes: list(occurrence.toolChangeAttribution.changes, (change) => fields(change, ["tool", "kind"])),
        } : null,
      })),
      reasons: list(refill.reasons, (reason) => fields(reason, ["reason", "count"])),
      toolChangeAttributions: list(refill.toolChangeAttributions, (attribution) => ({
        ...fields(attribution, ["cause", "count"]),
        changes: list(attribution.changes, (change) => fields(change, ["tool", "kind"])),
      })),
    })),
  };
}
function publicCacheReadDrops(value) {
  return { status: value?.status || "unavailable", items: list(value?.items, (item) => ({
    ...fields(item, ["agentId", "count"]),
    occurrences: list(item.occurrences, (occurrence) => fields(occurrence, ["id", "observedAt", "previousCacheReadPercent", "cacheReadPercent", "gapMs", "kind"])),
  })) };
}
function publicCapabilities(value) {
  return fields(value, ["approvalMode", "automaticCompactions", "contextMachinery", "repositoryContextInventory", "repositoryPluginSetup", "estimatedCost",
    "liveSessions", "needsInput", "planTasks", "cacheWriteUsage", "cacheUsageClassification", "sessionSummary", "signals", "usageLimits", "workflows"]) || {};
}
function publicContextAllocation(value) {
  return fields(value, ["initialTokens", "deferredTokens", "reservedTokens"]);
}
function publicInventoryRef(value) {
  const result = fields(value, ["repositoryId", "provider", "revisionId", "capturedAt", "model", "machineryTokens", "categoryCount", "itemCount", "detailRetained"]);
  return result ? { ...result, contextAllocation: publicContextAllocation(value.contextAllocation) } : null;
}
function publicRepository(value, cwd, forbiddenRoots) {
  if (!value) return null;
  return {
    ...fields(value, ["available", "branch", "historical", "isMain"]),
    comparison: fields(value.comparison, ["branch", "kind", "ahead", "behind", "integrated"]),
    commits: list(value.commits, (commit) => fields(commit, ["hash", "subject", "committedAt"])),
    remote: fields(value.remote, ["status", "checkedAt"]),
    files: list(value.files, (file) => {
      const safePath = repositoryRelativePath(file?.path, cwd, { forbiddenRoots });
      return safePath ? { status: file.status, path: safePath } : null;
    }),
  };
}
function publicPullRequests(value) {
  if (!value) return null;
  return { ...fields(value, ["status", "checkedAt"]), items: list(value.items, (item) => fields(item,
    ["host", "repository", "number", "title", "url", "state", "draft", "headBranch", "baseBranch", "additions", "deletions", "updatedAt", "association"])) };
}
function publicResources(value) {
  if (!value) return null;
  return {
    ...fields(value, ["status", "reason"]),
    current: fields(value.current, ["cpuCores", "cpuMachinePercent", "memoryBytes", "readBytesPerSecond", "writeBytesPerSecond"]),
    observedPeak: fields(value.observedPeak, ["memoryBytes"]),
    samples: list(value.samples, (sample) => fields(sample, ["timestamp", "cpuCores", "cpuMachinePercent", "memoryBytes", "readBytesPerSecond", "writeBytesPerSecond"])),
  };
}
function publicSessionFacts(value) {
  if (!value) return null;
  return {
    ...fields(value, ["id", "title", "project", "repositoryId", "startedAt", "updatedAt", "durationMs"]),
    cost: fields(value.cost, ["amount", "currency", "type", "observedAt"]),
    approvalMode: fields(value.approvalMode, ["id", "label", "observedAt", "source"]),
    contextMachinery: value.contextMachinery ? {
      ...fields(value.contextMachinery, ["observedAt", "model", "machineryTokens"]),
      contextAllocation: publicContextAllocation(value.contextMachinery.contextAllocation),
      total: fields(value.contextMachinery.total, ["used", "limit", "percentage"]),
      categories: list(value.contextMachinery.categories, (category) => fields(category, ["name", "tokens", "percentage", "kind"])),
      groups: list(value.contextMachinery.groups, (group) => ({
        ...fields(group, ["id", "label"]), items: list(group.items, (item) => fields(item, ["name", "detail", "tokens"])),
      })),
    } : null,
    contextInventoryRef: publicInventoryRef(value.contextInventoryRef),
    summary: fields(value.summary, ["text", "observedAt", "source"]),
    pomegrPlugin: fields(value.pomegrPlugin, ["status", "version", "policyStatus", "policyVersion", "observedAt"]),
  };
}

function base(domain, sessionId, observedAt, state, domainReadiness) {
  return {
    domain,
    sessionId,
    readiness: readiness(domainReadiness),
    observedAt: typeof observedAt === "string" && Number.isFinite(Date.parse(observedAt)) ? observedAt : null,
    source: state?.source,
    view: state?.view,
  };
}

function sessionSummary(sessionId, observedAt, state, ready, catalogEntry, agents, repository, pullRequests, resourcesReadiness) {
  const session = state?.session;
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const sections = sectionReadiness(ready, ["core", "agentEvidence", "contextEvidence", "activityEvidence", "repository"]);
  const requests = publicRequestFeed(state.metrics?.tokens?.requestSnapshots, (request) => ({
    ...request,
    agentRole: agentById.get(request.agentId)?.role || "unknown",
    agentLabel: agentById.get(request.agentId)?.label || "Agent",
  }));
  return {
    ...base("session-summary", sessionId, observedAt, state, aggregateReadiness(sections)),
    sectionReadiness: sections,
    source: state.source,
    capabilities: publicCapabilities(state.capabilities),
    view: state.view,
    session: session ? {
      id: session.id,
      title: session.title,
      project: session.project,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      durationMs: session.durationMs,
      cost: fields(session.cost, ["amount", "currency", "type", "observedAt"]),
      summary: fields(session.summary, ["text", "observedAt", "source"]),
      progress: fields(session.progress, ["phase", "percent", "remainingMinutesMin", "remainingMinutesMax", "confidence", "reportedAt"]),
      pomegrPlugin: fields(session.pomegrPlugin, ["status", "version", "policyStatus", "policyVersion", "observedAt"]),
    } : null,
    metrics: {
      agents: state.metrics?.agents || 0,
      activeAgents: ready.agentEvidence === "ready" ? agents.filter((agent) => agent.status === "active").length : 0,
      idleAgents: ready.agentEvidence === "ready" ? agents.filter((agent) => ["idle", "waiting", "warm"].includes(agent.status)).length : null,
      finishedAgents: ready.agentEvidence === "ready" ? agents.filter((agent) => ["finished", "stopped"].includes(agent.status)).length : null,
      toolCalls: state.metrics?.toolCalls || 0,
      repeatedCalls: state.metrics?.repeatedCalls || 0,
    },
    activity: state.activity ? {
      total: state.activity.total,
      toolCalls: state.activity.toolCalls,
      byKind: list(state.activity.byKind, (item) => fields(item, ["kind", "count", "medianDurationMs"])),
      messages: state.activity.messages,
      failed: state.activity.failed,
    } : EMPTY_ACTIVITY,
    allAgentContext: state.metrics?.tokens?.allAgents || 0,
    lifecycle: {
      isLive: catalogEntry?.isLive ?? state.view === "live",
      needsInput: catalogEntry?.needsInput ?? agents.some((agent) => agent.status === "needs_input"),
      activityStatus: catalogEntry?.activityStatus || "unknown",
      currentActivity: catalogEntry?.currentActivity || null,
      activityFallback: catalogEntry?.activityFallback || null,
    },
    rightNow: agents.filter((agent) => agent.status === "active" || agent.currentActivity).slice(0, 32).map((agent) => ({
      id: agent.id,
      label: agent.label,
      role: agent.role,
      customType: agent.customType || null,
      model: agent.model,
      status: agent.status,
      currentActivity: agent.currentActivity || null,
      tokens: { total: agent.tokens?.total || 0 },
      lastSeen: agent.lastSeen,
      updatedAt: agent.updatedAt,
    })),
    topSignals: list(state.insights, publicInsight).slice(0, 2),
    repository: {
      readiness: readiness(ready.repository),
      available: repository?.available === true,
      branch: typeof repository?.branch === "string" ? repository.branch : null,
      changedFiles: repository?.available === true && Array.isArray(repository.files) ? repository.files.length : null,
      pullRequestCount: pullRequests?.status === "ready" && Array.isArray(pullRequests.items) ? pullRequests.items.length : null,
      comparison: fields(repository?.comparison, ["branch", "kind", "ahead", "behind", "integrated"]),
    },
    resourceAvailability: {
      readiness: resourcesReadiness,
      hasData: resourcesReadiness === "ready" ? Boolean(state.metrics?.resources?.samples?.length || state.metrics?.resources?.current) : null,
    },
    requestSnapshots: { ...requests, items: requests.items.slice(-48) },
    planTasks: list(state.planTasks, publicPlanTask),
  };
}

function agentDetails(agentId, agents, workflows, boundaries) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const agent = byId.get(agentId) || null;
  const ancestors = [];
  let parent = agent ? byId.get(agent.parentId) : null;
  while (parent && ancestors.length < 64) {
    ancestors.push(parent);
    parent = parent.parentId ? byId.get(parent.parentId) : null;
  }
  const descendants = agent ? agents.filter((candidate) => {
    let current = candidate;
    for (let depth = 0; current?.parentId && depth < 64; depth += 1) {
      if (current.parentId === agent.id) return true;
      current = byId.get(current.parentId);
    }
    return false;
  }) : [];
  return {
    agentId,
    agent,
    ancestors,
    descendants,
    workflow: agent?.workflowId ? workflows.find((workflow) => workflow.id === agent.workflowId) || null : null,
    contextBoundaries: boundaries.filter((boundary) => boundary.agentId === agentId),
  };
}

/** Derive complete browser-safe domain candidates from one committed public state. */
export function projectSessionDomains(sessionId, snapshot, options = {}) {
  const state = snapshot?.publicState;
  if (!state || typeof state !== "object") throw new TypeError("Session domain projection requires committed public state");
  const ready = snapshot.readiness || state.readiness || {};
  const observedAt = snapshot.observedAt || null;
  const agents = list(state.agents, publicAgent);
  const workflows = list(state.workflows, publicWorkflow);
  const context = publicContext(state.metrics?.tokens?.contextHistory);
  const boundaries = context.boundaries;
  const session = state.session;
  const repository = publicRepository(session?.repository, options.repositoryRoot, options.forbiddenRoots);
  const pullRequests = publicPullRequests(session?.pullRequests);
  const repositoryReadiness = readiness(ready.repository);
  const resourcesReadiness = state.view === "history" && !state.metrics?.resources
    ? "unavailable"
    : readiness(ready.resources);
  const domains = new Map();
  domains.set("session-summary", sessionSummary(sessionId, observedAt, state, ready, options.catalogEntry, agents, repository, pullRequests, resourcesReadiness));
  domains.set("agents", {
    ...base("agents", sessionId, observedAt, state, ready.agentEvidence),
    agents,
    workflows,
  });
  domains.set("signals", {
    ...base("signals", sessionId, observedAt, state, aggregateReadiness(sectionReadiness(ready, ["activityEvidence", "contextEvidence"]))),
    sectionReadiness: sectionReadiness(ready, ["activityEvidence", "contextEvidence"]),
    score: state.score || 0,
    flowScore: {
      score: state.score || 0,
      repeatedCalls: ready.activityEvidence === "ready" && Number.isSafeInteger(state.metrics?.repeatedCalls) && state.metrics.repeatedCalls >= 0 ? state.metrics.repeatedCalls : null,
      overlappingTargets: ready.activityEvidence === "ready" && Number.isSafeInteger(state.metrics?.overlappingTargets) && state.metrics.overlappingTargets >= 0 ? state.metrics.overlappingTargets : null,
    },
    insights: list(state.insights, publicInsight),
    loops: list(state.loops, publicLoop),
    toolPatterns: list(state.toolPatterns, publicToolPattern),
    sessionSignal: publicSignal(session?.signal),
    agents: agents.map(({ id, label, cacheLifetime, signal }) => ({ id, label, cacheLifetime, signal })),
    cacheEvents: publicCacheEvents(state.metrics?.tokens?.cacheEvents),
    cacheReadDrops: publicCacheReadDrops(state.metrics?.tokens?.cacheReadDrops),
  });
  domains.set("repository", {
    ...base("repository", sessionId, observedAt, state, repositoryReadiness),
    repositoryId: session?.repositoryId || null,
    contextInventoryRef: publicInventoryRef(session?.contextInventoryRef),
    repository,
    pullRequests,
    fileHistory: { readiness: "unavailable", items: [] },
  });
  domains.set("resources", {
    ...base("resources", sessionId, observedAt, state, resourcesReadiness),
    live: publicResources(state.metrics?.resources),
    retained: { readiness: "unavailable", reason: "producer_not_implemented", minutes: [], peaks: [], peakSamples: [] },
  });
  const detailsSession = publicSessionFacts(session);
  domains.set("details", {
    ...base("details", sessionId, observedAt, state, aggregateReadiness(sectionReadiness(ready, ["core", "contextEvidence"]))),
    sectionReadiness: sectionReadiness(ready, ["core", "contextEvidence"]),
    source: state.source,
    capabilities: publicCapabilities(state.capabilities),
    view: state.view,
    session: detailsSession,
    context,
  });
  const requests = publicRequestFeed(state.metrics?.tokens?.requestSnapshots);
  const cacheEvents = publicCacheEvents(state.metrics?.tokens?.cacheEvents);
  const cacheReadDrops = publicCacheReadDrops(state.metrics?.tokens?.cacheReadDrops);
  const insights = list(state.insights, publicInsight);
  const agentSections = sectionReadiness(ready, ["agentEvidence", "contextEvidence", "activityEvidence"]);
  const agentResponses = new Map(agents.map((agent) => [agent.id, {
    ...base("agent", sessionId, observedAt, state, aggregateReadiness(agentSections)),
    sectionReadiness: agentSections,
    ...agentDetails(agent.id, agents, workflows, boundaries),
    requestSnapshots: { status: requests.status, items: requests.items.filter((item) => item.agentId === agent.id).slice(-48) },
    insights: insights.filter((item) => item.agentId === agent.id),
    cacheEvents: {
      status: cacheEvents.status,
      items: cacheEvents.items.filter((item) => item.agentId === agent.id),
      possibleFullRefills: cacheEvents.possibleFullRefills.filter((item) => item.agentId === agent.id),
    },
    cacheReadDrops: { status: cacheReadDrops.status, items: cacheReadDrops.items.filter((item) => item.agentId === agent.id) },
    planTasks: list(state.planTasks, publicPlanTask),
  }]));
  return Object.freeze({ domains, agentResponses });
}

export function unavailableSessionDomains(sessionId, catalogEntry, source, capabilities, options = {}) {
  const state = {
    source,
    capabilities,
    view: catalogEntry?.isLive || catalogEntry?.activityStatus === "open" ? "live" : "history",
    session: null,
    metrics: { agents: 0, activeAgents: 0, toolCalls: 0, repeatedCalls: 0, resources: null,
      tokens: { contextHistory: { bucketMs: 0, buckets: [], boundaries: [] } } },
    activity: EMPTY_ACTIVITY,
    agents: [], workflows: [], insights: [], loops: [], toolPatterns: [], score: 0,
  };
  return projectSessionDomains(sessionId, {
    publicState: state,
    readiness: { core: "unavailable", agentEvidence: "unavailable", contextEvidence: "unavailable",
      activityEvidence: "unavailable", repository: "unavailable", resources: "unavailable", usageLimits: "unavailable" },
    observedAt: catalogEntry?.updatedAt || null,
  }, { ...options, catalogEntry });
}
