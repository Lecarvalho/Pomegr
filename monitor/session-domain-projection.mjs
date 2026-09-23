import { repositoryRelativePath } from "./repository-path.mjs";
import { isSafeRecordedRepositoryPath } from "./repository-snapshot.mjs";
import { projectAgentSessionActivityFallback } from "./session-current-activity.mjs";

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
function publicRepositoryFile(value, cwd, forbiddenRoots, historical) {
  // A historical repository has no live root to resolve against (cwd is null), so it is
  // validated shape-only against the recorded snapshot's own path rule; a live repository
  // keeps validating against its actual session cwd.
  if (historical === true) return isSafeRecordedRepositoryPath(value?.path) ? { status: value.status, path: value.path } : null;
  const safePath = repositoryRelativePath(value?.path, cwd, { forbiddenRoots });
  return safePath ? { status: value.status, path: safePath } : null;
}
function publicRepository(value, cwd, forbiddenRoots) {
  if (!value) return null;
  return {
    ...fields(value, ["available", "branch", "historical", "isMain"]),
    comparison: fields(value.comparison, ["branch", "kind", "ahead", "behind", "integrated"]),
    commits: list(value.commits, (commit) => fields(commit, ["hash", "subject", "committedAt"])),
    remote: fields(value.remote, ["status", "checkedAt"]),
    files: list(value.files, (file) => publicRepositoryFile(file, cwd, forbiddenRoots, value.historical)),
  };
}
function repositoryRecordedAt(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
function repositoryCommitsInSession(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
const GIT_OBSERVED_SOURCES = new Set(["committed", "uncommitted"]);
const MAX_GIT_OBSERVED_FILES = 200;
function publicGitObservedFile(value) {
  if (!isSafeRecordedRepositoryPath(value?.path) || !GIT_OBSERVED_SOURCES.has(value?.source)) return null;
  return { path: value.path, source: value.source };
}
// Re-validates the already recorded Git-observed block passed in via options.gitObserved (the
// recorder's persisted snapshot for this session, live or historical); never reads the current
// working tree itself, so a historical session can never pick up live drift here.
function publicGitObservedFiles(value) {
  if (!value || !Array.isArray(value.files) || value.files.length > MAX_GIT_OBSERVED_FILES || typeof value.truncated !== "boolean") return null;
  const files = [];
  for (const file of value.files) {
    const normalized = publicGitObservedFile(file);
    if (!normalized) return null;
    files.push(normalized);
  }
  return { files, truncated: value.truncated };
}
const GIT_TASK_WORK_KINDS = new Set(["git", "git_push", "pull_request"]);
function gitTaskTally(executionTasks) {
  const relevant = (Array.isArray(executionTasks) ? executionTasks : []).filter((task) => GIT_TASK_WORK_KINDS.has(task?.workKind));
  return { total: relevant.length, failed: relevant.filter((task) => task?.status === "failed").length };
}
const FILE_HISTORY_READINESS = new Set(["loading", "ready", "unavailable", "rebuilding"]);
const FILE_CHANGE_KINDS = new Set(["created", "edited", "deleted", "moved"]);
const FILE_ID_PATTERN = /^f[1-9][0-9]{0,15}$/u;
const MAX_SESSION_FILE_HISTORY_FILES = 200;
function publicSessionFileHistoryEntry(value) {
  if (!value || typeof value.fileId !== "string" || !FILE_ID_PATTERN.test(value.fileId)) return null;
  if (!isSafeRecordedRepositoryPath(value.path) || !FILE_CHANGE_KINDS.has(value.kind)) return null;
  if (!Number.isSafeInteger(value.changeCount) || value.changeCount < 0) return null;
  if (typeof value.lastObservedAt !== "string" || !Number.isFinite(Date.parse(value.lastObservedAt))) return null;
  return { fileId: value.fileId, path: value.path, kind: value.kind, changeCount: value.changeCount, lastObservedAt: value.lastObservedAt };
}
// Re-validates the committed file-history-domain block: an invalid or missing block degrades
// to unavailable rather than ever letting an unvalidated path or count reach the browser.
function publicFileHistory(value) {
  const readiness = FILE_HISTORY_READINESS.has(value?.readiness) ? value.readiness : "unavailable";
  return {
    readiness,
    files: list(value?.files, publicSessionFileHistoryEntry).slice(0, MAX_SESSION_FILE_HISTORY_FILES),
    truncated: Boolean(value?.truncated),
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
    samples: list(value.samples, (sample) => fields(sample, ["timestamp", "cpuCores", "cpuMachinePercent", "memoryBytes", "readBytesPerSecond", "writeBytesPerSecond"])),
  };
}

const RESOURCE_RETAINED_READINESS = new Set(["loading", "ready", "unavailable", "rebuilding"]);
const RESOURCE_RETENTION_REASONS = new Set(["age_retention", "size_cleanup", "not_recorded"]);
const MAX_RESOURCE_TASK_DURATION_MS = 24 * 60 * 60 * 1000;

/** Combined top-level domain readiness: ready when either side is ready, loading when
 * either side is still loading (never a stored SQLite "rebuilding" for the outer readiness,
 * only for retained.readiness), otherwise unavailable. */
function resourcesDomainReadiness(liveReadiness, retainedBlock) {
  const retainedReadiness = retainedBlock?.readiness === "ready" ? "ready"
    : retainedBlock?.readiness === "loading" || retainedBlock?.readiness === "rebuilding" ? "loading"
      : "unavailable";
  if (liveReadiness === "ready" || retainedReadiness === "ready") return "ready";
  if (liveReadiness === "loading" || retainedReadiness === "loading") return "loading";
  return "unavailable";
}

function resourceAvailabilityHasData(liveReadiness, retainedBlock, state) {
  const liveHasData = Boolean(state.metrics?.resources?.samples?.length || state.metrics?.resources?.current);
  const retainedHasData = Boolean(retainedBlock?.minutes?.length || retainedBlock?.peaks?.length);
  if (liveHasData || retainedHasData) return true;
  const liveResolved = liveReadiness === "ready";
  // No retained block at all (a caller that never wired a resources retained source)
  // behaves like the live-only rule this replaces: it never blocks a definitive false.
  // A present block must itself reach "ready" before its absence of rows counts.
  const retainedResolved = retainedBlock == null || retainedBlock.readiness === "ready";
  return liveResolved && retainedResolved ? false : null;
}

function publicResourceAggregate(value) {
  return fields(value, ["min", "avg", "max", "maxAt"]);
}
function publicResourceMinute(value) {
  const result = fields(value, ["minuteStart"]);
  return result ? {
    ...result,
    cpuCores: publicResourceAggregate(value.cpuCores),
    memoryBytes: publicResourceAggregate(value.memoryBytes),
    readBytesPerSecond: publicResourceAggregate(value.readBytesPerSecond),
    writeBytesPerSecond: publicResourceAggregate(value.writeBytesPerSecond),
  } : null;
}
function publicCurveRemoval(value) {
  const reason = RESOURCE_RETENTION_REASONS.has(value?.reason) ? value.reason : null;
  if (!reason) return null;
  const removedAt = typeof value.removedAt === "string" && Number.isFinite(Date.parse(value.removedAt)) ? value.removedAt : null;
  return { reason, removedAt };
}
function resolveResourcePeakTask(taskId, tasksById) {
  const task = typeof taskId === "string" ? tasksById.get(taskId) : null;
  if (!task) return null;
  const startedAtMs = Date.parse(task.startedAt);
  const finishedAtMs = typeof task.finishedAt === "string" ? Date.parse(task.finishedAt) : null;
  let durationMs = null;
  if (Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs) && finishedAtMs >= startedAtMs) {
    durationMs = Math.min(finishedAtMs - startedAtMs, MAX_RESOURCE_TASK_DURATION_MS);
  }
  return {
    id: task.id,
    workKind: task.workKind,
    label: task.label,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt ?? null,
    durationMs,
  };
}
function publicResourceWindow(value) {
  return {
    status: value?.status === "retained" ? "retained" : "not_retained",
    samples: list(value?.samples, (sample) => fields(sample, ["at", "value"])),
    minute: publicResourceMinute(value?.minute),
  };
}
function publicResourcePeak(value, tasksById) {
  const result = fields(value, ["id", "field", "observedAt", "value", "matchedTaskCount"]);
  if (!result) return null;
  const matchedTaskIds = Array.isArray(value.matchedTaskIds) ? value.matchedTaskIds : [];
  return {
    ...result,
    tasks: matchedTaskIds.map((taskId) => resolveResourcePeakTask(taskId, tasksById)).filter(Boolean),
    // resource_peaks.matched_request_number is always null today; request numbers live
    // only in the async session-history store. See docs/internal/plans/ia-redesign.md T09.
    request: null,
    window: publicResourceWindow(value.window),
  };
}
function publicRetainedResources(retainedBlock, tasksById) {
  return {
    readiness: RESOURCE_RETAINED_READINESS.has(retainedBlock?.readiness) ? retainedBlock.readiness : "unavailable",
    minutes: list(retainedBlock?.minutes, publicResourceMinute),
    minutesTruncated: Boolean(retainedBlock?.minutesTruncated),
    curveRemoval: publicCurveRemoval(retainedBlock?.curveRemoval),
    peaks: list(retainedBlock?.peaks, (peak) => publicResourcePeak(peak, tasksById)),
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

function sessionSummary(sessionId, observedAt, state, ready, catalogEntry, agents, toolCalls, repository, pullRequests, resourcesReadiness, resourceHasData) {
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
      // An agent waiting for input is idle in these totals, as in the roster's status tally.
      idleAgents: ready.agentEvidence === "ready" ? agents.filter((agent) => ["idle", "waiting", "warm", "needs_input"].includes(agent.status)).length : null,
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
      // Private normalized tool calls carry the owning agent ID; public activity items carry only its label.
      activityFallback: projectAgentSessionActivityFallback(catalogEntry || {
        isLive: state.view === "live",
        activityStatus: "unknown",
      }, agent, toolCalls),
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
      // Like the Repository tab, a comparison counts only after its remote check succeeded.
      comparison: repository?.remote?.status === "ready" ? repository.comparison : null,
    },
    resourceAvailability: {
      readiness: resourcesReadiness,
      hasData: resourceHasData,
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
  const retainedResources = options.retainedResources || null;
  const liveResourcesReadiness = readiness(ready.resources);
  // Historical sessions are no longer forced to unavailable: ready when live is ready OR
  // retained (SQLite-backed) data is ready.
  const resourcesReadiness = resourcesDomainReadiness(liveResourcesReadiness, retainedResources);
  const resourceHasData = resourceAvailabilityHasData(liveResourcesReadiness, retainedResources, state);
  const requests = publicRequestFeed(state.metrics?.tokens?.requestSnapshots);
  const cacheEvents = publicCacheEvents(state.metrics?.tokens?.cacheEvents);
  const cacheReadDrops = publicCacheReadDrops(state.metrics?.tokens?.cacheReadDrops);
  const insights = list(state.insights, publicInsight);
  const loops = list(state.loops, publicLoop);
  const toolCalls = Array.isArray(snapshot.evidence?.toolCalls) ? snapshot.evidence.toolCalls : [];
  const domains = new Map();
  domains.set("session-summary", sessionSummary(sessionId, observedAt, state, ready, options.catalogEntry, agents, toolCalls, repository, pullRequests, resourcesReadiness, resourceHasData));
  domains.set("agents", {
    ...base("agents", sessionId, observedAt, state, ready.agentEvidence),
    agents,
    workflows,
    insights,
    loops,
    cacheRefills: cacheEvents.possibleFullRefills,
    cacheReadDrops: cacheReadDrops.items,
    contextBoundaries: boundaries,
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
    insights,
    loops,
    toolPatterns: list(state.toolPatterns, publicToolPattern),
    sessionSignal: publicSignal(session?.signal),
    agents: agents.map(({ id, label, cacheLifetime, signal }) => ({ id, label, cacheLifetime, signal })),
    cacheEvents,
    cacheReadDrops,
  });
  domains.set("repository", {
    ...base("repository", sessionId, observedAt, state, repositoryReadiness),
    repositoryId: session?.repositoryId || null,
    contextInventoryRef: publicInventoryRef(session?.contextInventoryRef),
    repository,
    pullRequests,
    recordedAt: repositoryRecordedAt(session?.repository?.recordedAt),
    commitsInSession: repositoryCommitsInSession(session?.repository?.commitsInSession),
    gitTasks: ready.activityEvidence === "ready" ? gitTaskTally(state.executionTasks) : null,
    fileHistory: publicFileHistory(options.fileHistory),
    // Never read from session.repository: that object is publicState.session.repository, which
    // /api/state serializes verbatim, and gitObserved must never reach that endpoint. It arrives
    // here only through options.gitObserved, a side channel exactly like options.fileHistory.
    gitObservedFiles: publicGitObservedFiles(options.gitObserved),
  });
  const executionTasksById = new Map((Array.isArray(state.executionTasks) ? state.executionTasks : [])
    .filter((task) => typeof task?.id === "string")
    .map((task) => [task.id, task]));
  domains.set("resources", {
    ...base("resources", sessionId, observedAt, state, resourcesReadiness),
    live: publicResources(state.metrics?.resources),
    retained: publicRetainedResources(retainedResources, executionTasksById),
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
