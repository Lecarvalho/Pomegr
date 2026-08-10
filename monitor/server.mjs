import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { agentTiming, applyWaitingStatus, externallyStoppedAgentTimes, isAgentTranscriptFinished, isExternalStopCurrent, isRunningAgent, pendingUserInputAt, resolveAgentMetadata } from "./agent-metadata.mjs";
import { shellFailureActivityEvents, userInputContentType } from "./activity-events.mjs";
import { buildContextGrowthTimeline } from "./context-growth-timeline.mjs";
import { latestContextMachinery, readLatestContextMachinery } from "./context-machinery.mjs";
import { contextCompactions, mergeContextCompactions, readContextCompactions } from "./context-compactions.mjs";
import { buildExecutionTasks } from "./execution-tasks.mjs";
import { EFFICIENCY_SIGNAL_RULES, evaluateEfficiencySignals } from "./efficiency-signals.mjs";
import { readGitState } from "./git-state.mjs";
import { listSessionFiles, liveSessionFiles, repositoryProjectName, statSafe, walkJsonl } from "./session-discovery.mjs";
import { preferredRegisteredSessionId, readSessionRegistry } from "./session-registry.mjs";
import { readPullRequests } from "./pull-requests.mjs";
import { readSessionTasks } from "./session-tasks.mjs";
import { readTranscriptSignals } from "./session-signals.mjs";
import { latestSessionSummary } from "./session-summary.mjs";
import { readSessionCost } from "./session-cost.mjs";
import { latestSessionApprovalMode } from "./session-approval-mode.mjs";
import { buildSkillUsage, normalizedSkillName } from "./skill-usage.mjs";
import { concurrentMutationOverlaps, mutationScopes, repetitionSignature } from "./tool-efficiency.mjs";
import { createEmptyMonitorState, createEmptyUsageLimits } from "../shared/monitor-state.mjs";
import { createUsageLimitsCoordinator } from "./usage-limits.mjs";

const PORT = Number(process.env.SESSION_PULSE_PORT || 4317);
const CLAUDE_PROJECTS = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
const EXPLICIT_SESSION = process.env.CLAUDE_SESSION_FILE;
const TASKS_ROOT = path.join(os.homedir(), ".claude", "tasks");
const SESSION_REGISTRY_ROOT = path.join(os.homedir(), ".claude", "sessions");
const MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const MAX_SESSION_SUMMARY_BYTES = 256 * 1024;
const gitCache = new Map();
const sessionSummaryCache = new Map();
const contextMachineryCache = new Map();
const contextCompactionsCache = new Map();

function emptyUsageLimits(error = "") {
  return createEmptyUsageLimits(error ? { error } : {});
}

const usageLimits = createUsageLimitsCoordinator({
  request: async () => {
    const credentialPath = path.join(os.homedir(), ".claude", ".credentials.json");
    const credentials = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    const token = credentials.claudeAiOauth?.accessToken;
    if (!token) throw new Error("Claude OAuth session not found");
    return fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "user-agent": "threadlight/0.1",
      },
      signal: AbortSignal.timeout(6000),
    });
  },
}).get;

function readJsonlTail(file, maxBytes = MAX_BYTES_PER_FILE) {
  const stat = statSafe(file);
  if (!stat) return [];
  const bytes = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, bytes, Math.max(0, stat.size - bytes)); }
  finally { fs.closeSync(fd); }
  let text = buffer.toString("utf8");
  if (stat.size > bytes) text = text.slice(text.indexOf("\n") + 1);
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function safeDetail(tool, input = {}) {
  const skill = tool === "Skill" ? normalizedSkillName(input) : "";
  if (skill) return skill;
  const file = input.file_path || input.path;
  if (typeof file === "string") return path.basename(file);
  if (typeof input.pattern === "string") return input.pattern.slice(0, 54);
  if (typeof input.command === "string") return input.command.replace(/\s+/g, " ").slice(0, 54);
  if (typeof input.description === "string") return input.description.slice(0, 54);
  if (typeof input.taskId === "string") return `task ${input.taskId}`;
  if (typeof input.delaySeconds === "number") return `${input.delaySeconds}s`;
  return "";
}

function actorFor(file, mainFile, metadata) {
  if (file === mainFile) return { id: "primary", label: "Primary agent", kind: "orchestrator", parentId: null };
  const id = path.basename(file, ".jsonl");
  const agentId = id.replace(/^agent-/, "");
  const resolved = metadata.get(agentId);
  return {
    id,
    label: resolved?.description || "Unnamed subagent",
    kind: resolved?.kind || "subagent",
    parentId: resolved?.parentId || null,
  };
}

function statusFor(mtimeMs) {
  const age = Date.now() - mtimeMs;
  if (age < 45_000) return "active";
  if (age < 5 * 60_000) return "warm";
  return "idle";
}

function registryStatus(entry, fallback) {
  if (!entry) return fallback;
  if (entry.status === "active") return "active";
  if (entry.status === "waiting") return "waiting";
  if (entry.status === "idle") return "idle";
  return fallback;
}

function registryTimestamp(entry) {
  return entry?.updatedAt ? new Date(entry.updatedAt).toISOString() : null;
}

function projectCwd(records) {
  return records.find((record) => typeof record.cwd === "string")?.cwd || "";
}

function projectName(mainFile, records) {
  const cwd = projectCwd(records);
  if (cwd) return repositoryProjectName(cwd);
  return path.basename(path.dirname(mainFile)).replace(/^[A-Z]--/, "").replaceAll("-", " ");
}

function gitState(cwd) {
  const cached = gitCache.get(cwd);
  if (cached && Date.now() - cached.timestamp < 2500) return cached.value;
  const value = readGitState(cwd);
  gitCache.set(cwd, { timestamp: Date.now(), value });
  return value;
}

function recordedGitState(records) {
  let branch = "";
  for (const record of records) {
    if (typeof record.gitBranch === "string") branch = record.gitBranch;
  }
  return { available: Boolean(branch), branch, files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } };
}

function sessionTitle(records) {
  let aiTitle = "";
  let customTitle = "";
  for (const record of records) {
    if (record.type === "ai-title" && typeof record.aiTitle === "string") aiTitle = record.aiTitle;
    if (record.type === "custom-title") customTitle = record.customTitle || record.title || record.name || customTitle;
  }
  return customTitle || aiTitle || "Untitled session";
}

function discoveredSessions() {
  const files = listSessionFiles(CLAUDE_PROJECTS);
  const registry = readSessionRegistry(SESSION_REGISTRY_ROOT);
  const explicitFile = EXPLICIT_SESSION && fs.existsSync(EXPLICIT_SESSION) ? EXPLICIT_SESSION : null;
  if (explicitFile && !files.some(({ file }) => file === explicitFile)) {
    files.unshift({ file: explicitFile, activityMs: statSafe(explicitFile)?.mtimeMs || 0 });
  }
  const filesBySessionId = new Map(files.map(({ file }) => [path.basename(file, ".jsonl"), file]));
  const preferredRegisteredId = preferredRegisteredSessionId(registry, [...filesBySessionId.keys()]);
  const liveFile = explicitFile
    || filesBySessionId.get(preferredRegisteredId)
    || files[0]?.file
    || null;
  const liveFiles = liveSessionFiles(files, registry.keys(), {
    explicitFile,
    registryAvailable: fs.existsSync(SESSION_REGISTRY_ROOT),
  });
  return { files, liveFile, liveFiles, registry };
}

function sessionCatalog() {
  const { files, liveFiles, registry } = discoveredSessions();

  return files.slice(0, 50).flatMap(({ file, activityMs }) => {
    const stat = statSafe(file);
    if (!stat) return [];
    const cacheKey = `${stat.size}:${stat.mtimeMs}:${activityMs}`;
    const cached = sessionSummaryCache.get(file);
    const registryEntry = registry.get(path.basename(file, ".jsonl"));
    const liveState = { isLive: liveFiles.has(file), needsInput: Boolean(registryEntry?.needsInput) };
    if (cached?.key === cacheKey) return [{ ...cached.value, ...liveState }];
    const records = readJsonlTail(file, MAX_SESSION_SUMMARY_BYTES);
    const value = {
      id: path.basename(file, ".jsonl"),
      title: sessionTitle(records),
      project: projectName(file, records),
      updatedAt: new Date(activityMs || stat.mtimeMs).toISOString(),
    };
    sessionSummaryCache.set(file, { key: cacheKey, value });
    return [{ ...value, ...liveState }];
  });
}

function runtimeMetadata(records) {
  let model = "unknown";
  let effort = "unspecified";
  for (const record of records) {
    if (record.type !== "assistant" || record.message?.model === "<synthetic>") continue;
    if (typeof record.message?.model === "string") model = record.message.model;
    if (typeof record.effort === "string") effort = record.effort;
  }
  return { model, effort };
}

async function analyze(requestedSessionId = "") {
  const { files: sessionFiles, liveFile, liveFiles, registry } = discoveredSessions();
  const explicitMatch = EXPLICIT_SESSION
    && path.basename(EXPLICIT_SESSION, ".jsonl") === requestedSessionId
    && fs.existsSync(EXPLICIT_SESSION)
    ? EXPLICIT_SESSION
    : null;
  const selectedMatch = /^[a-zA-Z0-9_-]+$/.test(requestedSessionId || "")
    ? sessionFiles.find(({ file }) => path.basename(file, ".jsonl") === requestedSessionId)?.file || null
    : null;
  const mainFile = requestedSessionId ? explicitMatch || selectedMatch : liveFile;
  const historical = mainFile ? !liveFiles.has(mainFile) : Boolean(requestedSessionId);
  if (!mainFile) return createEmptyMonitorState({
    connected: true,
    view: historical ? "history" : "live",
    usageLimits: historical ? emptyUsageLimits() : await usageLimits(),
    error: requestedSessionId ? "The selected session is no longer available." : `No Claude Code sessions found under ${CLAUDE_PROJECTS}`,
  });

  const sessionId = path.basename(mainFile, ".jsonl");
  const sessionCost = readSessionCost(sessionId);
  const sessionRegistryEntry = registry.get(sessionId);
  const agentDir = path.join(path.dirname(mainFile), sessionId, "subagents");
  const files = [mainFile, ...walkJsonl(agentDir, 1)];
  const recordsByFile = new Map(files.map((file) => [file, readJsonlTail(file)]));
  const mainRecords = recordsByFile.get(mainFile) || [];
  const signalsByFile = new Map(await Promise.all(files.map(async (file) => [
    file,
    await readTranscriptSignals(file, recordsByFile.get(file) || []),
  ])));
  const taskSignals = new Map();
  let sessionSignal = null;
  for (const signals of signalsByFile.values()) {
    if (signals.session && (!sessionSignal || new Date(signals.session.reportedAt || 0) >= new Date(sessionSignal.reportedAt || 0))) {
      sessionSignal = signals.session;
    }
    for (const [taskId, signal] of signals.tasks) {
      const previous = taskSignals.get(taskId);
      if (!previous || new Date(signal.reportedAt || 0) >= new Date(previous.reportedAt || 0)) taskSignals.set(taskId, signal);
    }
  }
  let contextMachinery = contextMachineryCache.get(mainFile);
  if (contextMachinery === undefined) {
    contextMachinery = await readLatestContextMachinery(mainFile);
    contextMachineryCache.set(mainFile, contextMachinery);
  }
  const tailContextMachinery = latestContextMachinery(mainRecords);
  if (tailContextMachinery && (!contextMachinery?.observedAt || new Date(tailContextMachinery.observedAt) >= new Date(contextMachinery.observedAt))) {
    contextMachinery = tailContextMachinery;
    contextMachineryCache.set(mainFile, contextMachinery);
  }
  const agentMetadata = resolveAgentMetadata([...recordsByFile].map(([file, records]) => ({
    id: file === mainFile ? "primary" : path.basename(file, ".jsonl"),
    agentId: file === mainFile ? null : path.basename(file, ".jsonl").replace(/^agent-/, ""),
    records,
  })));
  const stoppedAtByAgent = new Map();
  for (const records of recordsByFile.values()) {
    for (const [agentId, stoppedAt] of externallyStoppedAgentTimes(records)) {
      const previous = stoppedAtByAgent.get(agentId);
      if (!previous || new Date(stoppedAt) > new Date(previous)) stoppedAtByAgent.set(agentId, stoppedAt);
    }
  }
  const allEvents = [];
  const agents = [];
  const repetitionMap = new Map();
  const patternMap = new Map();
  const mutationEvents = [];
  const usageByMessage = new Map();
  const compactions = [];
  let startedAt = null;
  let updatedAt = null;

  for (const file of files) {
    const stat = statSafe(file);
    if (!stat) continue;
    const actor = actorFor(file, mainFile, agentMetadata);
    const records = recordsByFile.get(file) || [];
    let observedCompactions = contextCompactionsCache.get(file);
    if (observedCompactions === undefined) observedCompactions = await readContextCompactions(file);
    observedCompactions = mergeContextCompactions(observedCompactions, contextCompactions(records));
    contextCompactionsCache.set(file, observedCompactions);
    compactions.push(...observedCompactions.map((compaction) => ({
      ...compaction,
      actor: { id: actor.id, label: actor.label },
    })));
    const requestedInputIds = new Set();
    let calls = 0;
    for (const record of records) {
      const timestamp = record.timestamp || record.message?.timestamp;
      if (timestamp) {
        if (!startedAt || new Date(timestamp) < new Date(startedAt)) startedAt = timestamp;
        if (!updatedAt || new Date(timestamp) > new Date(updatedAt)) updatedAt = timestamp;
      }
      const userInputType = file === mainFile ? userInputContentType(record, requestedInputIds) : null;
      if (userInputType) {
        allEvents.push({
          id: record.uuid || crypto.createHash("sha1").update(`${file}:${timestamp}:user-input`).digest("hex").slice(0, 12),
          timestamp: timestamp || stat.mtime.toISOString(),
          actor: "User",
          tool: "User input",
          detail: userInputType,
        });
      }
      if (record.type === "assistant" && record.message?.usage) {
        const usage = record.message.usage;
        const messageId = record.message.id || record.requestId || record.uuid;
        if (messageId) usageByMessage.set(`${file}|${messageId}`, {
          actorId: actor.id,
          timestamp: timestamp || stat.mtime.toISOString(),
          input: Number(usage.input_tokens || 0),
          output: Number(usage.output_tokens || 0),
          cacheWrite: Number(usage.cache_creation_input_tokens || 0),
          cacheRead: Number(usage.cache_read_input_tokens || 0),
        });
      }
      if (record.type !== "assistant" || !Array.isArray(record.message?.content)) continue;
      for (const content of record.message.content) {
        if (content.type !== "tool_use") continue;
        calls += 1;
        const tool = content.name || "Tool";
        if (tool === "AskUserQuestion" && content.id) requestedInputIds.add(content.id);
        const input = content.input || {};
        const sig = repetitionSignature(tool, input);
        const detail = safeDetail(tool, input);
        const repetitionKey = `${actor.id}|${sig}`;
        repetitionMap.set(repetitionKey, { count: (repetitionMap.get(repetitionKey)?.count || 0) + 1, actor, tool, detail, sig });
        const patternKey = `${actor.id}|${tool}|${detail}`;
        patternMap.set(patternKey, { count: (patternMap.get(patternKey)?.count || 0) + 1, actor, tool, detail });
        const target = input.file_path || input.path;
        if (typeof target === "string") {
          const scopes = mutationScopes(tool, input);
          if (scopes.length) mutationEvents.push({
            actorId: actor.id,
            timestamp: timestamp || stat.mtime.toISOString(),
            display: path.basename(target),
            scopes,
          });
        }
        allEvents.push({
          id: content.id || crypto.createHash("sha1").update(`${file}:${timestamp}:${calls}:${tool}`).digest("hex").slice(0, 12),
          timestamp: timestamp || stat.mtime.toISOString(), actor: actor.label, tool, detail, sig,
        });
      }
    }
    const runtime = runtimeMetadata(records);
    const timing = agentTiming(records, stat.mtime.toISOString());
    const finished = file !== mainFile && isAgentTranscriptFinished(records);
    const externallyStoppedAt = file === mainFile ? null : stoppedAtByAgent.get(actor.id.replace(/^agent-/, ""));
    const externallyStopped = externallyStoppedAt && isExternalStopCurrent(records, externallyStoppedAt);
    const transcriptNeedsInputAt = pendingUserInputAt(records);
    const registryNeedsInputAt = file === mainFile && sessionRegistryEntry?.needsInput
      ? registryTimestamp(sessionRegistryEntry)
      : null;
    const needsInputAt = registryNeedsInputAt || transcriptNeedsInputAt;
    const observedStatus = file === mainFile
      ? registryStatus(sessionRegistryEntry, statusFor(stat.mtimeMs))
      : statusFor(stat.mtimeMs);
    agents.push({
      id: actor.id,
      label: actor.label,
      kind: actor.kind,
      parentId: actor.parentId,
      model: runtime.model,
      effort: runtime.effort,
      status: externallyStopped ? "stopped" : historical ? "idle" : needsInputAt ? "needs_input" : finished ? "finished" : observedStatus,
      toolCalls: calls,
      signal: signalsByFile.get(file)?.agent || null,
      skills: buildSkillUsage(records),
      lastSeen: externallyStopped ? externallyStoppedAt : needsInputAt || (file === mainFile ? registryTimestamp(sessionRegistryEntry) : null) || stat.mtime.toISOString(),
      ...timing,
    });
  }
  if (!historical) applyWaitingStatus(agents);
  for (const agent of agents) {
    const file = agent.id === "primary"
      ? mainFile
      : files.find((candidate) => path.basename(candidate, ".jsonl") === agent.id);
    agent.executionTasks = file
      ? buildExecutionTasks(recordsByFile.get(file) || [], { historical, sessionUpdatedAt: updatedAt, taskSignals })
      : [];
  }

  const groupedTools = [...patternMap.values()].sort((a, b) => b.count - a.count);
  const overlaps = concurrentMutationOverlaps(mutationEvents, EFFICIENCY_SIGNAL_RULES.concurrentMutation.windowMs);
  const activeAgents = agents.filter(isRunningAgent).length;
  const latestByAgent = new Map();
  for (const usage of usageByMessage.values()) {
    const usageTime = new Date(usage.timestamp).getTime();
    const previous = latestByAgent.get(usage.actorId);
    const snapshotTotal = usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
    if (snapshotTotal > 0 && (!previous || usageTime >= new Date(previous.timestamp).getTime())) {
      latestByAgent.set(usage.actorId, usage);
    }
  }
  for (const agent of agents) {
    const latest = latestByAgent.get(agent.id) || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    agent.tokens = {
      input: latest.input,
      output: latest.output,
      cacheWrite: latest.cacheWrite,
      cacheRead: latest.cacheRead,
      total: latest.input + latest.output + latest.cacheWrite + latest.cacheRead,
    };
  }
  const allAgents = agents.reduce((total, agent) => total + agent.tokens.total, 0);
  const tokenUsage = {
    allAgents,
    input: agents.reduce((total, agent) => total + agent.tokens.input, 0),
    output: agents.reduce((total, agent) => total + agent.tokens.output, 0),
    cacheWrite: agents.reduce((total, agent) => total + agent.tokens.cacheWrite, 0),
    cacheRead: agents.reduce((total, agent) => total + agent.tokens.cacheRead, 0),
    contextGrowthTimeline: buildContextGrowthTimeline([...usageByMessage.values()], { startedAt, updatedAt }),
  };
  const { insights, loops } = evaluateEfficiencySignals({
    agents,
    repetitionCandidates: [...repetitionMap.values()],
    overlaps,
    compactions,
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
  const executionTasks = buildExecutionTasks(mainRecords, { historical, sessionUpdatedAt: updatedAt });
  const primaryActor = agents.find((agent) => agent.id === "primary")?.label || "Primary agent";
  allEvents.push(...shellFailureActivityEvents(executionTasks, primaryActor));

  const cwd = projectCwd(mainRecords);
  const repository = historical ? recordedGitState(mainRecords) : { ...gitState(cwd), historical: false };
  const pullRequests = await readPullRequests([...recordsByFile.values()].flat(), {
    cwd,
    branch: repository.branch,
    historical,
    transcripts: [...recordsByFile].map(([file, records]) => ({ file, records })),
  });
  const currentUsageLimits = historical ? emptyUsageLimits() : await usageLimits();
  const score = Math.max(25, 100 - Math.min(45, repeatedCalls * 4) - Math.min(25, overlaps.length * 7));
  allEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  agents.sort((a, b) => (a.id === "primary" ? -1 : b.id === "primary" ? 1 : new Date(b.lastSeen) - new Date(a.lastSeen)));

  return {
    connected: true,
    source: "Claude Code",
    view: historical ? "history" : "live",
    session: {
      id: sessionId,
      title: sessionTitle(mainRecords),
      project: projectName(mainFile, mainRecords),
      cwd,
      repository,
      pullRequests,
      startedAt,
      updatedAt: updatedAt || statSafe(mainFile)?.mtime.toISOString(),
      durationMs: startedAt && updatedAt ? Math.max(0, new Date(updatedAt).getTime() - new Date(startedAt).getTime()) : 0,
      cost: sessionCost,
      approvalMode: latestSessionApprovalMode(mainRecords),
      contextMachinery,
      summary: latestSessionSummary(mainRecords),
      signal: sessionSignal,
    },
    score,
    metrics: { agents: agents.length, activeAgents, toolCalls: agents.reduce((total, agent) => total + agent.toolCalls, 0), repeatedCalls, tokens: tokenUsage },
    agents,
    toolPatterns,
    loops: loopPatterns,
    activity: allEvents.slice(0, 30).map(({ id, timestamp, actor, tool, detail, status }) => ({ id, timestamp, actor, tool, detail, status: status || null })),
    executionTasks: agents.find((agent) => agent.id === "primary")?.executionTasks || [],
    planTasks: readSessionTasks(TASKS_ROOT, sessionId),
    insights,
    usageLimits: currentUsageLimits,
  };
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
      response.end(JSON.stringify({ sessions: sessionCatalog() }));
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

function analyzeEmpty() {
  return createEmptyMonitorState({ usageLimits: emptyUsageLimits() });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Threadlight monitor: http://127.0.0.1:${PORT}`);
  console.log(`Watching: ${CLAUDE_PROJECTS}`);
});
