import crypto from "node:crypto";

const DAY_WINDOWS = Object.freeze([7, 30, 90]);
const SCOPES = Object.freeze(["all", "main", "delegated"]);
const MAX_PROJECTS = 100;
const MAX_RUNS = 2_000;
const MAX_ROSTER = 2_000;
const MAX_MODELS = 128;
const MAX_TEXT = 512;
const MAX_ID = 256;
const MAX_DEPTH = 64;
const VALID_STATUSES = new Set(["active", "waiting", "needs_input", "warm", "finished", "stopped", "idle", "unknown"]);
const VALID_ROLES = new Set(["orchestrator", "explore", "plan", "builder", "reviewer", "tester", "researcher", "general-purpose", "workflow-worker", "fork", "compaction", "unknown"]);
const VALID_WORK_KINDS = new Set(["shell", "search", "read", "write", "test", "build", "git", "git_push", "pull_request", "process", "web", "image", "input", "transfer", "skill", "report", "agent", "integration", "wait"]);

function safeText(value, fallback = "", maximum = MAX_TEXT) {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized.length > maximum ? normalized.slice(0, maximum) : normalized || fallback;
}

function safeTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function countWork(tasks) {
  const counts = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const workKind = safeText(task?.workKind, "", 32);
    if (!VALID_WORK_KINDS.has(workKind)) continue;
    counts.set(workKind, (counts.get(workKind) || 0) + 1);
  }
  return [...counts].map(([workKind, count]) => ({ workKind, count }))
    .sort((left, right) => right.count - left.count || left.workKind.localeCompare(right.workKind));
}

function runTime(run) {
  return Date.parse(run.startedAt || run.lastSeen || "") || 0;
}

function compareRuns(left, right) {
  return runTime(right) - runTime(left) || left.id.localeCompare(right.id);
}

function acceptedModel(value) {
  const model = safeText(value, "", MAX_ID);
  return model && model.toLowerCase() !== "unknown" ? model : null;
}

function boundedContext(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function runKey(sessionId, agentId) {
  return `run_${crypto.createHash("sha256").update(sessionId).update("\u0000").update(agentId).digest("base64url")}`;
}

function sessionRuns(snapshot) {
  const state = snapshot?.publicState;
  const session = state?.session;
  if (!session || !Array.isArray(state?.agents)) return [];
  const sessionId = safeText(session.id, snapshot.qualifiedId || "", MAX_ID);
  if (!sessionId) return [];
  const source = state.source === "Claude Code" || state.source === "Codex" ? state.source : null;
  if (!source) return [];
  const project = safeText(session.project, "Unknown project");
  const sessionTitle = safeText(session.title, "Untitled session");
  const byAgentId = new Map();
  for (const agent of state.agents) {
    const agentId = safeText(agent?.id, "", MAX_ID);
    if (agentId && !byAgentId.has(agentId)) byAgentId.set(agentId, agent);
  }
  const depthFor = (agentId, seen = new Set()) => {
    if (seen.has(agentId) || seen.size >= MAX_DEPTH) return 0;
    seen.add(agentId);
    const parentId = safeText(byAgentId.get(agentId)?.parentId, "", 256);
    return parentId && byAgentId.has(parentId) ? 1 + depthFor(parentId, seen) : 0;
  };
  const runs = [];
  for (const [agentId, agent] of byAgentId) {
    const parentAgentId = safeText(agent.parentId, "", MAX_ID);
    const parentId = parentAgentId && byAgentId.has(parentAgentId) ? runKey(sessionId, parentAgentId) : null;
    const model = acceptedModel(agent.model);
    const hasExecutionTaskEvidence = Array.isArray(agent.executionTasks);
    const tasks = hasExecutionTaskEvidence ? agent.executionTasks : [];
    runs.push(Object.freeze({
      id: runKey(sessionId, agentId),
      agentId,
      sessionId,
      source,
      project,
      sessionTitle,
      label: safeText(agent.label, "Agent"),
      assignment: safeText(agent.assignment, "") || null,
      role: VALID_ROLES.has(agent.role) ? agent.role : "unknown",
      model,
      modelEvidence: model ? "latest_reported" : "unavailable",
      scope: agentId === "primary" ? "main" : "delegated",
      parentId,
      depth: Math.min(MAX_DEPTH, depthFor(agentId)),
      status: VALID_STATUSES.has(agent.status) ? agent.status : "unknown",
      startedAt: safeTimestamp(agent.startedAt),
      lastSeen: safeTimestamp(agent.lastSeen || agent.updatedAt),
      latestContextTotal: boundedContext(agent.tokens?.total) || null,
      toolCalls: boundedContext(agent.toolCalls),
      executionTaskCount: hasExecutionTaskEvidence ? tasks.length : null,
      work: countWork(tasks),
    }));
  }
  return runs;
}

function projectList(runs, catalog = []) {
  return [...new Set([
    ...runs.map((run) => run.project),
    ...catalog.map((entry) => safeText(entry?.project, "Unknown project")),
  ])]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_PROJECTS);
}

function rosterOrder(runs) {
  const bySession = new Map();
  for (const run of runs) {
    const group = bySession.get(run.sessionId) || [];
    group.push(run);
    bySession.set(run.sessionId, group);
  }
  const sessions = [...bySession.entries()].sort((left, right) => {
    const leftLatest = Math.max(...left[1].map(runTime));
    const rightLatest = Math.max(...right[1].map(runTime));
    return rightLatest - leftLatest || left[0].localeCompare(right[0]);
  });
  const ordered = [];
  for (const [, group] of sessions) {
    const byId = new Map(group.map((run) => [run.id, run]));
    const children = new Map();
    for (const run of group) {
      if (!run.parentId || !byId.has(run.parentId)) continue;
      const items = children.get(run.parentId) || [];
      items.push(run);
      children.set(run.parentId, items);
    }
    for (const items of children.values()) items.sort(compareRuns);
    const visited = new Set();
    const visit = (run) => {
      if (visited.has(run.id)) return;
      visited.add(run.id);
      ordered.push(run);
      for (const child of children.get(run.id) || []) visit(child);
    };
    const roots = group.filter((run) => !run.parentId || !byId.has(run.parentId)).sort(compareRuns);
    for (const root of roots) visit(root);
    // Cycles and parent-only filtered rows have no root. Keep their persisted
    // depth, but emit each component once in a deterministic safe order.
    for (const run of [...group].sort(compareRuns)) visit(run);
  }
  return ordered;
}

/** Normalize once from committed public state, then bound a coherent v1 evidence set. */
export function collectAgentsAnalyticsInput({ entries = [], catalog = [] } = {}) {
  if (!Array.isArray(entries) || !Array.isArray(catalog)) throw new TypeError("Agents analytics requires committed array snapshots");
  const rawRuns = [];
  for (const snapshot of entries) rawRuns.push(...sessionRuns(snapshot));
  rawRuns.sort(compareRuns);
  const retained = [];
  const models = new Set();
  let truncated = false;
  for (const run of rawRuns) {
    const modelKey = run.model || "\u0000";
    if (retained.length >= MAX_RUNS || (!models.has(modelKey) && models.size >= MAX_MODELS)) {
      truncated = true;
      continue;
    }
    models.add(modelKey);
    retained.push(run);
  }
  const catalogRows = [...catalog];
  return Object.freeze({
    runs: Object.freeze(retained),
    catalog: Object.freeze(catalogRows),
    projects: Object.freeze(projectList(retained, catalogRows)),
    truncated,
  });
}

function matches(run, { project, days, scope, now }) {
  if (project !== "all" && run.project !== project) return false;
  if (scope !== "all" && run.scope !== scope) return false;
  const startedAt = Date.parse(run.startedAt || "");
  return Number.isFinite(startedAt) && startedAt >= now - days * 24 * 60 * 60_000 && startedAt <= now;
}

function aggregate(runs) {
  const modelCounts = new Map();
  const workCounts = new Map();
  const sessionIds = new Set();
  let mainRunCount = 0;
  let delegatedRunCount = 0;
  for (const run of runs) {
    sessionIds.add(run.sessionId);
    if (run.scope === "main") mainRunCount += 1;
    else delegatedRunCount += 1;
    const modelKey = run.model || "";
    const model = modelCounts.get(modelKey) || { model: run.model, runCount: 0, mainRunCount: 0, delegatedRunCount: 0, roles: new Map() };
    model.runCount += 1;
    if (run.scope === "main") model.mainRunCount += 1;
    else model.delegatedRunCount += 1;
    model.roles.set(run.role, (model.roles.get(run.role) || 0) + 1);
    modelCounts.set(modelKey, model);
    for (const item of run.work) workCounts.set(item.workKind, (workCounts.get(item.workKind) || 0) + item.count);
  }
  const allModels = [...modelCounts.values()].map((entry) => ({
    model: entry.model,
    runCount: entry.runCount,
    mainRunCount: entry.mainRunCount,
    delegatedRunCount: entry.delegatedRunCount,
    roles: [...entry.roles].map(([role, runCount]) => ({ role, runCount }))
      .sort((left, right) => right.runCount - left.runCount || left.role.localeCompare(right.role)),
  })).sort((left, right) => right.runCount - left.runCount || String(left.model || "").localeCompare(String(right.model || "")));
  return {
    summary: {
      runCount: runs.length,
      sessionCount: sessionIds.size,
      modelCount: allModels.filter((model) => model.model !== null).length,
      mainRunCount,
      delegatedRunCount,
    },
    models: allModels,
    work: [...workCounts].map(([workKind, count]) => ({ workKind, count }))
      .sort((left, right) => right.count - left.count || left.workKind.localeCompare(right.workKind)),
  };
}

/** Build one bounded, browser-safe response solely from retained public snapshots. */
export function buildAgentsAnalytics({ input = null, entries = [], catalog = [], project = "all", days = 30, scope = "all", now = Date.now(), refreshReadiness = "ready" } = {}) {
  const normalized = input || collectAgentsAnalyticsInput({ entries, catalog });
  const catalogRows = normalized.catalog;
  const catalogById = new Map(catalogRows.map((entry) => [entry?.id, entry]));
  const retained = normalized.runs;
  const projects = normalized.projects;
  const selectedProject = project === "all" || projects.includes(project) ? project : "all";
  const selected = retained.filter((run) => matches(run, { project: selectedProject, days, scope, now }));
  const liveCandidates = retained.filter((run) => {
    const row = catalogById.get(run.sessionId);
    return Boolean(row?.isLive) && (selectedProject === "all" || run.project === selectedProject)
      && (scope === "all" || run.scope === scope);
  });
  const liveRoster = rosterOrder(liveCandidates).slice(0, MAX_ROSTER);
  const eligibleRows = catalogRows.filter((entry) => selectedProject === "all" || safeText(entry?.project, "Unknown project") === selectedProject);
  const projectRuns = retained.filter((run) => selectedProject === "all" || run.project === selectedProject);
  const retainedSessionIds = new Set(projectRuns.map((run) => run.sessionId));
  const missingSessions = eligibleRows.filter((entry) => !retainedSessionIds.has(entry?.id)).length;
  const earliest = retained.map((run) => run.startedAt).filter(Boolean).sort()[0] || null;
  const aggregates = aggregate(selected);
  return Object.freeze({
    readiness: "ready",
    refreshReadiness,
    generatedAt: new Date(now).toISOString(),
    coverage: {
      retainedSessions: retainedSessionIds.size,
      eligibleSessions: eligibleRows.length,
      missingSessions,
      retainedRuns: projectRuns.length,
      truncated: normalized.truncated || liveCandidates.length > liveRoster.length,
      earliestStartedAt: earliest,
    },
    filters: { project: selectedProject, days, scope, projects },
    summary: aggregates.summary,
    models: aggregates.models,
    work: aggregates.work,
    runs: selected,
    roster: liveRoster,
  });
}

export function agentsVariantKey({ project = "all", days = 30, scope = "all" } = {}) {
  return `${project}\u0000${days}\u0000${scope}`;
}

export function normalizeAgentsQuery(value = {}) {
  const project = value.project === undefined || value.project === "" ? "all" : safeText(value.project, "", MAX_TEXT);
  const days = Number(value.days ?? 30);
  const scope = value.scope === undefined || value.scope === "" ? "all" : value.scope;
  if (!project || !DAY_WINDOWS.includes(days) || !SCOPES.includes(scope)) return null;
  return Object.freeze({ project, days, scope });
}

export const agentsAnalyticsLimits = Object.freeze({ MAX_PROJECTS, MAX_RUNS, MAX_ROSTER, MAX_MODELS, MAX_TEXT, MAX_ID, MAX_DEPTH });
