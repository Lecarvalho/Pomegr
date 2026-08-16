import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  agentTiming,
  applyWaitingStatus,
  externallyStoppedAgentTimes,
  isAgentTranscriptFinished,
  isExternalStopCurrent,
  pendingUserInputAt,
  resolveAgentMetadata,
} from "../agent-metadata.mjs";
import { userInputContentType } from "../activity-events.mjs";
import { latestContextMachinery, readLatestContextMachinery } from "../context-machinery.mjs";
import { contextCompactions, mergeContextCompactions, readContextCompactions } from "../context-compactions.mjs";
import { buildExecutionTasks } from "../execution-tasks.mjs";
import { listSessionFiles, liveSessionFiles, repositoryProjectName, statSafe, walkJsonl } from "../session-discovery.mjs";
import { createSessionRegistryOwnerValidator, preferredRegisteredSessionId, readSessionRegistry } from "../session-registry.mjs";
import { normalizeSessionTask, readSessionTasks } from "../session-tasks.mjs";
import { mergeTranscriptSignals, readTranscriptSignals } from "../session-signals.mjs";
import { latestSessionSummary } from "../session-summary.mjs";
import { readSessionCost } from "../session-cost.mjs";
import { latestSessionApprovalMode } from "../session-approval-mode.mjs";
import { buildSkillUsage, normalizedSkillName } from "../skill-usage.mjs";
import { mutationScopes, repetitionSignature } from "../tool-efficiency.mjs";
import { createUsageLimitsCoordinator } from "../usage-limits.mjs";
import { defineProvider } from "./provider-contract.mjs";
import { readClaudePullRequestCreations } from "./claude-pull-requests.mjs";

const MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const MAX_SESSION_SUMMARY_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_PLAN_TASKS = 40;
const MAX_PENDING_TASK_CALLS = 80;
const MAX_WORKFLOWS = 24;
const MAX_WORKFLOW_AGENTS = 64;
const MAX_WORKFLOW_PHASES = 32;
const MAX_WORKFLOW_PROGRESS_ITEMS = 256;
const MAX_WORKFLOW_MANIFEST_BYTES = 512 * 1024;
const MAX_WORKFLOW_DURATION_MS = 366 * 24 * 60 * 60 * 1_000;
const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);
const SAFE_WORKFLOW_RUN_ID = /^wf_[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SAFE_WORKFLOW_AGENT_FILE = /^agent-([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.jsonl$/;

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
  if (tool === "TaskCreate" && typeof input.subject === "string") {
    return input.subject.replace(/\s+/g, " ").trim().slice(0, 54);
  }
  if (tool === "TaskUpdate" && typeof input.taskId === "string") return `task ${input.taskId}`;
  const file = input.file_path || input.path;
  if (typeof file === "string") return path.basename(file);
  if (typeof input.pattern === "string") return input.pattern.slice(0, 54);
  if (typeof input.description === "string") return input.description.replace(/\s+/g, " ").slice(0, 54);
  if (typeof input.taskId === "string") return `task ${input.taskId}`;
  if (typeof input.delaySeconds === "number") return `${input.delaySeconds}s`;
  return "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanTaskId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? id : "";
}

function cleanTaskSubject(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 160) : "";
}

function cleanWorkflowText(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function workflowTimestamp(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function workflowDuration(value) {
  if (typeof value !== "number") return null;
  const duration = value;
  return Number.isFinite(duration) && duration >= 0
    ? Math.min(Math.round(duration), MAX_WORKFLOW_DURATION_MS)
    : null;
}

function workflowLaunches(records) {
  const launches = new Map();
  for (const record of records) {
    const result = record?.toolUseResult;
    if (!plainObject(result)
      || result.status !== "async_launched"
      || result.taskType !== "local_workflow"
      || !SAFE_WORKFLOW_RUN_ID.test(result.runId || "")) continue;
    const runId = result.runId;
    if (!launches.has(runId) && launches.size >= MAX_WORKFLOWS) continue;
    const observedAt = workflowTimestamp(record.timestamp || record.message?.timestamp);
    launches.set(runId, {
      runId,
      name: cleanWorkflowText(result.workflowName, 80) || "Workflow",
      summary: cleanWorkflowText(result.summary, 240) || null,
      observedAt,
    });
  }
  return launches;
}

function discoverWorkflowAgents(agentDir) {
  const root = path.join(agentDir, "workflows");
  const runs = new Map();
  if (!fs.existsSync(root)) return { runs, files: [] };
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { runs, files: [] }; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (runs.size >= MAX_WORKFLOWS) break;
    if (!entry.isDirectory() || !SAFE_WORKFLOW_RUN_ID.test(entry.name)) continue;
    const run = { runId: entry.name, agents: [] };
    let agentEntries = [];
    try { agentEntries = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true }); } catch { /* ignore one run */ }
    for (const agentEntry of agentEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (run.agents.length >= MAX_WORKFLOW_AGENTS || !agentEntry.isFile()) continue;
      const match = agentEntry.name.match(SAFE_WORKFLOW_AGENT_FILE);
      if (!match) continue;
      const file = path.join(root, entry.name, agentEntry.name);
      run.agents.push({
        file,
        rawAgentId: match[1],
        id: `workflow-${entry.name}-agent-${match[1]}`,
        runId: entry.name,
      });
    }
    runs.set(entry.name, run);
  }
  return { runs, files: [...runs.values()].flatMap((run) => run.agents) };
}

function discoverWorkflowManifestIds(workflowRoot) {
  if (!fs.existsSync(workflowRoot)) return [];
  try {
    return fs.readdirSync(workflowRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.basename(entry.name, ".json"))
      .filter((runId) => SAFE_WORKFLOW_RUN_ID.test(runId))
      .sort()
      .slice(0, MAX_WORKFLOWS);
  } catch {
    return [];
  }
}

function readCompletedWorkflowManifest(file, expectedRunId, cache) {
  const stat = statSafe(file);
  if (!stat || stat.size <= 0 || stat.size > MAX_WORKFLOW_MANIFEST_BYTES) return null;
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = cache.get(file);
  if (cached?.key === key) return cached.value;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); } catch { manifest = null; }
  let value = null;
  if (plainObject(manifest) && manifest.status === "completed" && manifest.runId === expectedRunId) {
    const phaseByIndex = new Map();
    if (Array.isArray(manifest.phases)) {
      for (const [offset, phase] of manifest.phases.slice(0, MAX_WORKFLOW_PHASES).entries()) {
        const label = cleanWorkflowText(phase?.title, 80);
        if (label) phaseByIndex.set(offset + 1, label);
      }
    }
    if (Array.isArray(manifest.workflowProgress)) {
      for (const item of manifest.workflowProgress.slice(0, MAX_WORKFLOW_PROGRESS_ITEMS)) {
        if (item?.type !== "workflow_phase") continue;
        const index = Number(item.index);
        const label = cleanWorkflowText(item.title, 80);
        if (Number.isInteger(index) && index > 0 && index <= MAX_WORKFLOW_PHASES && label && !phaseByIndex.has(index)) {
          phaseByIndex.set(index, label);
        }
      }
    }
    const workers = [];
    if (Array.isArray(manifest.workflowProgress)) {
      for (const item of manifest.workflowProgress.slice(0, MAX_WORKFLOW_PROGRESS_ITEMS)) {
        if (workers.length >= MAX_WORKFLOW_AGENTS || item?.type !== "workflow_agent") continue;
        const rawAgentId = String(item.agentId || "").replace(/^agent-/, "");
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(rawAgentId)) continue;
        const phaseIndex = Number(item.phaseIndex);
        workers.push({
          rawAgentId,
          label: cleanWorkflowText(item.label, 80) || null,
          phaseIndex: Number.isInteger(phaseIndex) && phaseByIndex.has(phaseIndex) ? phaseIndex : null,
        });
      }
    }
    const startedAt = workflowTimestamp(manifest.startTime);
    const updatedAt = workflowTimestamp(manifest.timestamp);
    const derivedDuration = startedAt && updatedAt ? Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)) : 0;
    value = {
      name: cleanWorkflowText(manifest.workflowName, 80) || null,
      summary: cleanWorkflowText(manifest.summary, 240) || null,
      startedAt,
      updatedAt,
      durationMs: workflowDuration(manifest.durationMs) ?? Math.min(derivedDuration, MAX_WORKFLOW_DURATION_MS),
      phases: [...phaseByIndex].sort((left, right) => left[0] - right[0]).map(([index, label]) => ({ index, label })),
      workers,
    };
  }
  cache.set(file, { key, value });
  return value;
}

function cleanDependencyIds(value) {
  return Array.isArray(value) ? [...new Set(value.map(cleanTaskId).filter(Boolean))].slice(0, 40) : [];
}

function taskToolCalls(record) {
  if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) return [];
  return record.message.content.flatMap((content) => {
    const id = cleanTaskId(content?.id);
    if (content?.type !== "tool_use" || !id || !plainObject(content.input)) return [];
    if (content.name === "TaskCreate") return [{
      id,
      name: content.name,
      input: {
        subject: cleanTaskSubject(content.input.subject),
        blocks: cleanDependencyIds(content.input.blocks),
        blockedBy: cleanDependencyIds(content.input.blockedBy),
      },
    }];
    if (content.name === "TaskUpdate") return [{
      id,
      name: content.name,
      input: {
        taskId: cleanTaskId(content.input.taskId),
        subject: content.input.subject === undefined ? undefined : cleanTaskSubject(content.input.subject),
        status: content.input.status,
        addBlocks: cleanDependencyIds(content.input.addBlocks),
        addBlockedBy: cleanDependencyIds(content.input.addBlockedBy),
      },
    }];
    return [];
  });
}

function successfulTaskResult(record, call) {
  if (record?.type !== "user" || !Array.isArray(record.message?.content)) return null;
  const matched = record.message.content.some((content) => content?.type === "tool_result"
    && content.tool_use_id === call.id
    && content.is_error !== true);
  if (!matched || !plainObject(record.toolUseResult)) return null;
  if (call.name === "TaskCreate") {
    return plainObject(record.toolUseResult.task) ? {
      id: cleanTaskId(record.toolUseResult.task.id),
      subject: cleanTaskSubject(record.toolUseResult.task.subject),
    } : null;
  }
  return record.toolUseResult.success === true ? {
    success: true,
    taskId: cleanTaskId(record.toolUseResult.taskId),
  } : null;
}

function applySuccessfulTaskCall(tasks, call, result) {
  if (call.name === "TaskCreate") {
    if (tasks.size >= MAX_TRANSCRIPT_PLAN_TASKS) return;
    const resultSubject = cleanTaskSubject(result.subject);
    const task = normalizeSessionTask({
      id: result.id,
      subject: call.input.subject,
      status: "pending",
      blocks: call.input.blocks,
      blockedBy: call.input.blockedBy,
    });
    if (task && resultSubject === task.subject) tasks.set(task.id, task);
    return;
  }

  const taskId = cleanTaskId(call.input.taskId);
  if (!taskId || cleanTaskId(result.taskId) !== taskId || !tasks.has(taskId)) return;
  if (call.input.status !== undefined && !TASK_STATUSES.has(call.input.status)) return;
  const previous = tasks.get(taskId);
  const appendDependencies = (current, added) => Array.isArray(added) ? [...current, ...added] : current;
  const task = normalizeSessionTask({
    ...previous,
    subject: typeof call.input.subject === "string" ? call.input.subject : previous.subject,
    status: typeof call.input.status === "string" ? call.input.status : previous.status,
    blocks: appendDependencies(previous.blocks, call.input.addBlocks),
    blockedBy: appendDependencies(previous.blockedBy, call.input.addBlockedBy),
  });
  if (task) tasks.set(taskId, task);
}

async function readTranscriptPlanTasks(file) {
  const tasks = new Map();
  const pending = new Map();
  let input;
  try {
    input = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      for (const call of taskToolCalls(record)) {
        if (pending.size >= MAX_PENDING_TASK_CALLS) pending.delete(pending.keys().next().value);
        pending.set(call.id, call);
      }
      if (record?.type !== "user" || !Array.isArray(record.message?.content)) continue;
      for (const content of record.message.content) {
        if (content?.type !== "tool_result" || typeof content.tool_use_id !== "string") continue;
        const call = pending.get(content.tool_use_id);
        if (!call) continue;
        pending.delete(content.tool_use_id);
        const result = successfulTaskResult(record, call);
        if (result) applySuccessfulTaskCall(tasks, call, result);
      }
    }
  } catch {
    return [];
  } finally {
    input?.destroy();
  }
  return [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function actorFor(file, mainFile, metadata, workflowFiles = new Map()) {
  if (file === mainFile) return { id: "primary", label: "Primary agent", kind: "orchestrator", parentId: null };
  const workflowAgent = workflowFiles.get(file);
  if (workflowAgent) return {
    id: workflowAgent.id,
    label: "Workflow worker",
    kind: "workflow-subagent",
    parentId: "primary",
  };
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

function statusFor(mtimeMs, now = Date.now()) {
  const age = now - mtimeMs;
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

function recordedGitBranch(records) {
  let branch = "";
  for (const record of records) {
    if (typeof record.gitBranch === "string") branch = record.gitBranch;
  }
  return branch;
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

function buildWorkflows({
  mainRecords,
  workflowRoot,
  workflowDiscovery,
  agents,
  historical,
  manifestCache,
}) {
  const launches = workflowLaunches(mainRecords);
  const runIds = [];
  const rememberRun = (runId) => {
    if (!runIds.includes(runId) && runIds.length < MAX_WORKFLOWS) runIds.push(runId);
  };
  for (const runId of launches.keys()) rememberRun(runId);
  for (const runId of workflowDiscovery.runs.keys()) rememberRun(runId);
  for (const runId of discoverWorkflowManifestIds(workflowRoot)) rememberRun(runId);

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  return runIds.map((runId) => {
    const launch = launches.get(runId) || null;
    const discovered = workflowDiscovery.runs.get(runId)?.agents || [];
    const manifest = readCompletedWorkflowManifest(path.join(workflowRoot, `${runId}.json`), runId, manifestCache);
    const agentIds = discovered.map((item) => item.id).filter((id) => agentsById.has(id));
    const rawAgentIds = new Map(discovered.map((item) => [item.rawAgentId, item.id]));
    const phaseAgents = new Map();

    if (manifest) {
      for (const worker of manifest.workers) {
        const agentId = rawAgentIds.get(worker.rawAgentId);
        const agent = agentId ? agentsById.get(agentId) : null;
        if (!agent) continue;
        agent.workflowId = runId;
        if (worker.label) agent.label = worker.label;
        if (worker.phaseIndex !== null) {
          const phaseId = `${runId}-phase-${worker.phaseIndex}`;
          agent.workflowPhaseId = phaseId;
          if (!phaseAgents.has(worker.phaseIndex)) phaseAgents.set(worker.phaseIndex, []);
          phaseAgents.get(worker.phaseIndex).push(agentId);
        }
      }
    }

    const linkedAgents = agentIds.map((id) => agentsById.get(id)).filter(Boolean);
    const strongLiveEvidence = !historical && linkedAgents.some((agent) => (
      agent.status === "active" || agent.status === "warm" || agent.status === "waiting" || agent.status === "needs_input"
    ));
    const status = manifest ? "completed" : strongLiveEvidence ? "running" : "unknown";
    const agentStartedAt = linkedAgents.map((agent) => agent.startedAt).filter(Boolean).sort()[0] || null;
    const agentUpdatedAt = linkedAgents.map((agent) => agent.updatedAt).filter(Boolean).sort().at(-1) || null;
    const startedAt = manifest?.startedAt || launch?.observedAt || agentStartedAt;
    const updatedAt = manifest?.updatedAt || agentUpdatedAt || launch?.observedAt;
    const elapsed = startedAt && updatedAt ? Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)) : 0;

    for (const agent of linkedAgents) agent.workflowId = runId;
    return {
      id: runId,
      name: manifest?.name || launch?.name || "Workflow",
      summary: manifest?.summary || launch?.summary || null,
      status,
      startedAt,
      updatedAt,
      durationMs: manifest?.durationMs ?? Math.min(elapsed, MAX_WORKFLOW_DURATION_MS),
      agentIds,
      phases: manifest ? manifest.phases.map((phase) => ({
        id: `${runId}-phase-${phase.index}`,
        label: phase.label,
        agentIds: [...new Set(phaseAgents.get(phase.index) || [])],
      })) : [],
    };
  });
}

function usageRequest(homeDir, fetchImpl) {
  return async () => {
    const credentialPath = path.join(homeDir, ".claude", ".credentials.json");
    const credentials = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    const token = credentials.claudeAiOauth?.accessToken;
    if (!token) throw new Error("Claude OAuth session not found");
    return fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "user-agent": "pomegr/0.1",
      },
      signal: AbortSignal.timeout(6000),
    });
  };
}

/** @returns {import("./provider-contract").ProviderAdapter} */
export function createClaudeProvider(options = {}) {
  const environment = options.env ?? process.env;
  const homeDir = options.homeDir || os.homedir();
  const projectsRoot = options.projectsRoot || environment.CLAUDE_PROJECTS_DIR || path.join(homeDir, ".claude", "projects");
  const explicitSession = options.explicitSession ?? environment.CLAUDE_SESSION_FILE;
  const tasksRoot = options.tasksRoot || path.join(homeDir, ".claude", "tasks");
  const registryRoot = options.registryRoot || path.join(homeDir, ".claude", "sessions");
  const now = options.now || (() => Date.now());
  const sessionSummaryCache = new Map();
  const contextMachineryCache = new Map();
  const contextCompactionsCache = new Map();
  const transcriptPlanTasksCache = new Map();
  const workflowManifestCache = new Map();
  const validateRegistryOwners = options.validateRegistryOwners || createSessionRegistryOwnerValidator({
    env: environment,
    now,
    platform: options.platform,
    processIdentities: options.registryProcessIdentities,
  });
  const usageLimits = createUsageLimitsCoordinator({
    request: options.usageRequest || usageRequest(homeDir, options.fetch || globalThis.fetch),
  }).get;

  function discoveredSessions() {
    const files = listSessionFiles(projectsRoot);
    const registry = readSessionRegistry(registryRoot, { validateOwners: validateRegistryOwners });
    const explicitFile = explicitSession && fs.existsSync(explicitSession) ? explicitSession : null;
    if (explicitFile && !files.some(({ file }) => file === explicitFile)) {
      files.unshift({ file: explicitFile, activityMs: statSafe(explicitFile)?.mtimeMs || 0 });
    }
    const filesBySessionId = new Map(files.map(({ file }) => [path.basename(file, ".jsonl"), file]));
    const preferredRegisteredId = preferredRegisteredSessionId(registry, [...filesBySessionId.keys()]);
    const liveFile = explicitFile || filesBySessionId.get(preferredRegisteredId) || files[0]?.file || null;
    const liveFiles = liveSessionFiles(files, registry.keys(), {
      explicitFile,
      registryAvailable: fs.existsSync(registryRoot),
    });
    return { files, liveFile, liveFiles, registry };
  }

  async function listSessions() {
    const { files, liveFiles, registry } = discoveredSessions();
    return files.slice(0, 50).flatMap(({ file, activityMs }) => {
      const stat = statSafe(file);
      if (!stat) return [];
      const cacheKey = `${stat.size}:${stat.mtimeMs}:${activityMs}`;
      const cached = sessionSummaryCache.get(file);
      const registryEntry = registry.get(path.basename(file, ".jsonl"));
      const isLive = liveFiles.has(file);
      const liveState = {
        isLive,
        needsInput: Boolean(registryEntry?.needsInput),
        ...(isLive && registryEntry?.resourceOwner ? { resourceOwner: registryEntry.resourceOwner } : {}),
      };
      if (cached?.key === cacheKey) return [{ ...cached.value, ...liveState }];
      const records = readJsonlTail(file, MAX_SESSION_SUMMARY_BYTES);
      const value = {
        localId: path.basename(file, ".jsonl"),
        title: sessionTitle(records),
        project: projectName(file, records),
        updatedAt: new Date(activityMs || stat.mtimeMs).toISOString(),
      };
      sessionSummaryCache.set(file, { key: cacheKey, value });
      return [{ ...value, ...liveState }];
    });
  }

  async function readSession(localSessionId = "") {
    const { files: sessionFiles, liveFile, liveFiles, registry } = discoveredSessions();
    const explicitMatch = explicitSession
      && path.basename(explicitSession, ".jsonl") === localSessionId
      && fs.existsSync(explicitSession)
      ? explicitSession
      : null;
    const selectedMatch = /^[a-zA-Z0-9_-]+$/.test(localSessionId || "")
      ? sessionFiles.find(({ file }) => path.basename(file, ".jsonl") === localSessionId)?.file || null
      : null;
    const mainFile = localSessionId ? explicitMatch || selectedMatch : liveFile;
    if (!mainFile) return null;
    const historical = !liveFiles.has(mainFile);
    const sessionId = path.basename(mainFile, ".jsonl");
    const sessionRegistryEntry = registry.get(sessionId);
    const agentDir = path.join(path.dirname(mainFile), sessionId, "subagents");
    const workflowRoot = path.join(path.dirname(mainFile), sessionId, "workflows");
    const workflowDiscovery = discoverWorkflowAgents(agentDir);
    const workflowRawAgentIdCounts = new Map();
    for (const workflowAgent of workflowDiscovery.files) {
      workflowRawAgentIdCounts.set(
        workflowAgent.rawAgentId,
        (workflowRawAgentIdCounts.get(workflowAgent.rawAgentId) || 0) + 1,
      );
    }
    const ordinaryAgentFiles = walkJsonl(agentDir, 1);
    const files = [mainFile, ...ordinaryAgentFiles, ...workflowDiscovery.files.map((item) => item.file)];
    const workflowFiles = new Map(workflowDiscovery.files.map((item) => [item.file, item]));
    const fileByAgentId = new Map(workflowDiscovery.files.map((item) => [item.id, item.file]));
    fileByAgentId.set("primary", mainFile);
    for (const file of ordinaryAgentFiles) fileByAgentId.set(path.basename(file, ".jsonl"), file);
    const recordsByFile = new Map(files.map((file) => [file, readJsonlTail(file)]));
    const mainRecords = recordsByFile.get(mainFile) || [];
    const signalsByFile = new Map(await Promise.all(files.map(async (file) => [
      file,
      await readTranscriptSignals(file, recordsByFile.get(file) || []),
    ])));
    const combinedSignals = { agent: null, session: null, tasks: new Map() };
    for (const signals of signalsByFile.values()) mergeTranscriptSignals(combinedSignals, signals);
    const taskSignals = combinedSignals.tasks;
    const sessionSignal = combinedSignals.session;
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
    const agentMetadata = resolveAgentMetadata([...recordsByFile]
      .filter(([file]) => !workflowFiles.has(file))
      .map(([file, records]) => ({
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
    const activity = [];
    const agents = [];
    const toolCalls = [];
    const usageSnapshots = [];
    const compactions = [];
    let startedAt = null;
    let updatedAt = null;

    for (const file of files) {
      const stat = statSafe(file);
      if (!stat) continue;
      const actor = actorFor(file, mainFile, agentMetadata, workflowFiles);
      const workflowAgent = workflowFiles.get(file) || null;
      const records = recordsByFile.get(file) || [];
      let observedCompactions = contextCompactionsCache.get(file);
      if (observedCompactions === undefined) observedCompactions = await readContextCompactions(file);
      observedCompactions = mergeContextCompactions(observedCompactions, contextCompactions(records));
      contextCompactionsCache.set(file, observedCompactions);
      compactions.push(...observedCompactions.map((compaction) => ({
        actorId: actor.id,
        timestamp: compaction.timestamp,
        trigger: compaction.trigger,
        preTokens: compaction.preTokens,
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
        if (userInputType) activity.push({
          id: record.uuid || crypto.createHash("sha1").update(`${file}:${timestamp}:user-input`).digest("hex").slice(0, 12),
          timestamp: timestamp || stat.mtime.toISOString(),
          actor: "User",
          tool: "User input",
          detail: userInputType,
          status: null,
        });
        if (record.type === "assistant" && record.message?.usage) {
          const usage = record.message.usage;
          const messageId = record.message.id || record.requestId || record.uuid;
          if (messageId) usageSnapshots.push({
            dedupeId: `${actor.id}|${messageId}`,
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
          const detail = safeDetail(tool, input);
          const target = input.file_path || input.path;
          const scopes = typeof target === "string"
            ? mutationScopes(tool, input).map((scope) => crypto.createHash("sha256").update(scope).digest("hex").slice(0, 20))
            : [];
          toolCalls.push({
            id: content.id || crypto.createHash("sha1").update(`${file}:${timestamp}:${calls}:${tool}`).digest("hex").slice(0, 12),
            timestamp: timestamp || stat.mtime.toISOString(),
            actor: { id: actor.id, label: actor.label },
            tool,
            detail,
            status: null,
            repetitionSignature: repetitionSignature(tool, input),
            mutation: scopes.length ? { display: path.basename(target), scopes } : null,
          });
        }
      }
      const runtime = runtimeMetadata(records);
      const timing = agentTiming(records, stat.mtime.toISOString());
      const finished = file !== mainFile && isAgentTranscriptFinished(records);
      const externalStopAgentId = workflowAgent
        ? workflowRawAgentIdCounts.get(workflowAgent.rawAgentId) === 1 ? workflowAgent.rawAgentId : null
        : actor.id.replace(/^agent-/, "");
      const externallyStoppedAt = file === mainFile || !externalStopAgentId
        ? null
        : stoppedAtByAgent.get(externalStopAgentId);
      const externallyStopped = externallyStoppedAt && isExternalStopCurrent(records, externallyStoppedAt);
      const transcriptNeedsInputAt = pendingUserInputAt(records);
      const registryNeedsInputAt = file === mainFile && sessionRegistryEntry?.needsInput ? registryTimestamp(sessionRegistryEntry) : null;
      const needsInputAt = registryNeedsInputAt || transcriptNeedsInputAt;
      const observedStatus = file === mainFile
        ? registryStatus(sessionRegistryEntry, statusFor(stat.mtimeMs, now()))
        : statusFor(stat.mtimeMs, now());
      agents.push({
        id: actor.id,
        label: actor.label,
        kind: actor.kind,
        parentId: actor.parentId,
        workflowId: workflowAgent?.runId || null,
        workflowPhaseId: null,
        model: runtime.model,
        effort: runtime.effort,
        status: externallyStopped ? "stopped" : historical ? "idle" : needsInputAt ? "needs_input" : finished ? "finished" : observedStatus,
        toolCalls: calls,
        signal: signalsByFile.get(file)?.agent || null,
        skills: buildSkillUsage(records),
        lastSeen: externallyStopped ? externallyStoppedAt : needsInputAt || (file === mainFile ? registryTimestamp(sessionRegistryEntry) : null) || stat.mtime.toISOString(),
        executionTasks: [],
        ...timing,
      });
    }
    if (!historical) applyWaitingStatus(agents);
    for (const agent of agents) {
      const file = fileByAgentId.get(agent.id);
      agent.executionTasks = file
        ? buildExecutionTasks(recordsByFile.get(file) || [], { historical, sessionUpdatedAt: updatedAt, taskSignals })
        : [];
    }

    const storedPlanTasks = readSessionTasks(tasksRoot, sessionId);
    let planTasks = storedPlanTasks;
    if (!planTasks.length) {
      const stat = statSafe(mainFile);
      const cacheKey = stat ? `${stat.size}:${stat.mtimeMs}` : "missing";
      const cached = transcriptPlanTasksCache.get(mainFile);
      if (cached?.key === cacheKey) planTasks = cached.value;
      else {
        planTasks = await readTranscriptPlanTasks(mainFile);
        transcriptPlanTasksCache.set(mainFile, { key: cacheKey, value: planTasks });
      }
    }

    const workflows = buildWorkflows({
      mainRecords,
      workflowRoot,
      workflowDiscovery,
      agents,
      historical,
      manifestCache: workflowManifestCache,
    });

    return {
      localId: sessionId,
      historical,
      session: {
        title: sessionTitle(mainRecords),
        project: projectName(mainFile, mainRecords),
        cwd: projectCwd(mainRecords),
        startedAt,
        updatedAt: updatedAt || statSafe(mainFile)?.mtime.toISOString(),
        recordedGitBranch: recordedGitBranch(mainRecords),
        cost: readSessionCost(sessionId),
        approvalMode: latestSessionApprovalMode(mainRecords),
        contextMachinery,
        summary: latestSessionSummary(mainRecords),
        signal: sessionSignal,
      },
      agents,
      workflows,
      usageSnapshots,
      toolCalls,
      activity,
      planTasks,
      compactions,
      efficiencyRuleEvidence: {
        repetition: true,
        concurrentMutation: true,
        unsharedContext: true,
        healthyFallback: true,
        cacheUsageClassification: false,
      },
      pullRequestCreations: await readClaudePullRequestCreations([...recordsByFile].map(([file, records]) => ({
        file,
        records,
        actorId: actorFor(file, mainFile, agentMetadata, workflowFiles).id,
      }))),
    };
  }

  return defineProvider({
    id: "claude",
    source: "Claude Code",
    capabilities: {
      approvalMode: true,
      automaticCompactions: true,
      contextMachinery: true,
      estimatedCost: true,
      liveSessions: true,
      needsInput: true,
      planTasks: true,
      sessionSummary: true,
      signals: true,
      usageLimits: true,
      workflows: true,
    },
    listSessions,
    readSession,
    readUsageLimits: usageLimits,
    unavailableMessage(localSessionId = "") {
      return localSessionId ? "The selected session is no longer available." : `No Claude Code sessions found under ${projectsRoot}`;
    },
    watchTargets: [projectsRoot],
  });
}

export const claudeProvider = createClaudeProvider();
