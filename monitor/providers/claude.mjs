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
import { readSessionTasks } from "../session-tasks.mjs";
import { mergeTranscriptSignals, readTranscriptSignals } from "../session-signals.mjs";
import { latestSessionSummary } from "../session-summary.mjs";
import { readSessionCost } from "../session-cost.mjs";
import { latestSessionApprovalMode } from "../session-approval-mode.mjs";
import { buildSkillUsage, normalizedSkillName } from "../skill-usage.mjs";
import { mutationScopes, repetitionSignature } from "../tool-efficiency.mjs";
import { createUsageLimitsCoordinator } from "../usage-limits.mjs";
import { toolWorkKind } from "../work-kind.mjs";
import { defineProvider } from "./provider-contract.mjs";
import { createIncrementalProviderObserver, incrementalSourceSetDescriptor } from "./incremental-provider-observer.mjs";
import { createClaudeSourceEventRouter } from "./claude-source-routing.mjs";
import { readClaudePullRequestCreations } from "./claude-pull-requests.mjs";
import { parseClaudeContextRecords } from "./claude-context.mjs";
import { readLatestPomegrPluginMetadata } from "./pomegr-plugin-metadata.mjs";
import { readClaudeTranscriptPlanTasks } from "./claude-plan-tasks.mjs";
import { createClaudeBackgroundLifecycleReader } from "./claude-background-lifecycle.mjs";
import { buildClaudeWorkflows, discoverClaudeWorkflowAgents, terminalClaudeWorkflowAgentStates } from "./claude-workflows.mjs";
import {
  claudeLifecycleSource, createClaudeSessionStatusReader, normalizeClaudeSessionRegistryEntry,
  registryStatus, registryTimestamp, sessionActivityStatus,
} from "./claude-session-status.mjs";

const MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const MAX_LIVE_USAGE_SNAPSHOTS = 1_000;
const LIVE_USAGE_SUFFIX_BYTES = 256;
const MAX_SESSION_SUMMARY_BYTES = 256 * 1024;
const MAX_SESSION_TITLE_RECORD_BYTES = 16 * 1024;
const MAX_USAGE_LIMIT_REJECTION_WINDOWS = 16;

function normalizedResetTimestamp(value) {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  const milliseconds = numeric === null ? Date.parse(value) : numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

/**
 * Normalize only the first locally recorded Claude rejection for each five-hour
 * reset window. No other quota, message, or transcript fields leave the adapter.
 */
export function claudeFiveHourLimitRejections(recordGroups = []) {
  const earliestByReset = new Map();
  for (const records of recordGroups) {
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      const quota = record?.quotaLimits;
      if (!quota || quota.rateLimitType !== "five_hour" || quota.status !== "rejected") continue;
      const observedMs = Date.parse(record.timestamp || "");
      const resetsAt = normalizedResetTimestamp(quota.resetsAt);
      if (!Number.isFinite(observedMs) || !resetsAt) continue;
      const observedAt = new Date(observedMs).toISOString();
      const previous = earliestByReset.get(resetsAt);
      if (!previous || observedMs < Date.parse(previous.observedAt)) earliestByReset.set(resetsAt, { observedAt, resetsAt });
    }
  }
  return [...earliestByReset.values()]
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
    .slice(-MAX_USAGE_LIMIT_REJECTION_WINDOWS);
}

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

function fileIdentity(stat) {
  const device = Number.isFinite(stat?.dev) ? stat.dev : null;
  const inode = Number.isFinite(stat?.ino) && stat.ino > 0 ? stat.ino : null;
  return inode !== null
    ? `${device ?? "device"}:${inode}`
    : `birth:${Number.isFinite(stat?.birthtimeMs) ? stat.birthtimeMs : "unknown"}`;
}

function digestBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readFileSuffix(file, size, suffixBytes) {
  if (!Number.isInteger(size) || size < 1 || !Number.isInteger(suffixBytes) || suffixBytes < 1) return null;
  const bytes = Math.min(size, suffixBytes);
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(descriptor, buffer, 0, bytes, size - bytes);
    return read === bytes ? { bytes, digest: digestBuffer(buffer) } : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function priorFileSuffixStillMatches(file, generation) {
  if (!generation?.suffixDigest || !Number.isInteger(generation.size) || generation.size < 1) return false;
  const suffix = readFileSuffix(file, generation.size, generation.suffixBytes);
  return suffix?.bytes === generation.suffixBytes && suffix.digest === generation.suffixDigest;
}

function usageSnapshotGeneration(file, stat) {
  const suffix = readFileSuffix(file, stat.size, LIVE_USAGE_SUFFIX_BYTES);
  return suffix ? {
    identity: fileIdentity(stat),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    suffixBytes: suffix.bytes,
    suffixDigest: suffix.digest,
  } : null;
}

function mergeLiveUsageSnapshots(previous, current) {
  const byId = new Map(previous.map((snapshot) => [snapshot.dedupeId, snapshot]));
  for (const snapshot of current) byId.set(snapshot.dedupeId, snapshot);
  return [...byId.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId))
    .slice(-MAX_LIVE_USAGE_SNAPSHOTS);
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

function actorFor(file, mainFile, metadata, workflowFiles = new Map()) {
  if (file === mainFile) return { id: "primary", label: "Primary agent", kind: "orchestrator", parentId: null };
  const workflowAgent = workflowFiles.get(file);
  if (workflowAgent) return {
    id: workflowAgent.id,
    label: workflowAgent.fallbackLabel,
    kind: workflowAgent.metadata?.agentType || "workflow-subagent",
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

function sessionTitleState(records, initial = {}) {
  let aiTitle = initial.aiTitle || "";
  let customTitle = initial.customTitle || "";
  let createdAt = initial.createdAt || "";
  for (const record of records) {
    const timestamp = record.timestamp || record.message?.timestamp;
    const timestampMs = Date.parse(timestamp || "");
    if (Number.isFinite(timestampMs) && (!createdAt || timestampMs < Date.parse(createdAt))) {
      createdAt = new Date(timestampMs).toISOString();
    }
    if (record.type === "ai-title" && typeof record.aiTitle === "string") aiTitle = record.aiTitle;
    if (record.type === "custom-title") customTitle = record.customTitle || record.title || record.name || customTitle;
  }
  return { aiTitle, customTitle, createdAt };
}

function sessionTitle(records) {
  const { aiTitle, customTitle } = sessionTitleState(records);
  return customTitle || aiTitle || "Untitled session";
}

async function scanSessionTitleState(file, stat, initial = {}, start = 0) {
  if (!stat?.isFile() || stat.size <= 0) return sessionTitleState([], initial);
  let input;
  let lines;
  let firstLine = true;
  const state = sessionTitleState([], initial);
  try {
    input = fs.createReadStream(file, {
      encoding: "utf8",
      start,
      end: stat.size - 1,
    });
    lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (firstLine) {
        firstLine = false;
        if (start > 0) continue;
      }
      if ((state.createdAt && !line.includes("ai-title") && !line.includes("custom-title"))
        || Buffer.byteLength(line, "utf8") > MAX_SESSION_TITLE_RECORD_BYTES) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const next = sessionTitleState([record], state);
      state.aiTitle = next.aiTitle;
      state.customTitle = next.customTitle;
      state.createdAt = next.createdAt;
    }
    return state;
  } finally {
    lines?.close();
    input?.destroy();
  }
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

export function createClaudeProvider(options = {}) {
  const environment = options.env ?? process.env;
  const homeDir = options.homeDir || os.homedir();
  const projectsRoot = options.projectsRoot || environment.CLAUDE_PROJECTS_DIR || path.join(homeDir, ".claude", "projects");
  const explicitSession = options.explicitSession ?? environment.CLAUDE_SESSION_FILE;
  const tasksRoot = options.tasksRoot || path.join(homeDir, ".claude", "tasks");
  const registryRoot = options.registryRoot || path.join(homeDir, ".claude", "sessions");
  const now = options.now || (() => Date.now());
  const sessionSummaryCache = new Map();
  const sessionTitleCache = new Map();
  const contextMachineryCache = new Map();
  const contextCompactionsCache = new Map();
  const liveUsageSnapshotCache = new Map();
  const transcriptPlanTasksCache = new Map();
  const workflowManifestCache = new Map();
  const transcriptPathsBySessionId = new Map();
  const validateRegistryOwners = options.validateRegistryOwners || createSessionRegistryOwnerValidator({
    env: environment,
    now,
    platform: options.platform,
    processIdentities: options.registryProcessIdentities,
  });
  const usageLimits = createUsageLimitsCoordinator({
    request: options.usageRequest || usageRequest(homeDir, options.fetch || globalThis.fetch),
  }).get;

  const backgroundLifecycle = createClaudeBackgroundLifecycleReader();
  const nativeStatus = createClaudeSessionStatusReader({ homeDir, fetch: options.fetch || globalThis.fetch, now });

  async function cachedSessionTitle(file, stat) {
    const identity = fileIdentity(stat);
    const cached = sessionTitleCache.get(file);
    if (cached
      && cached.identity === identity
      && cached.size === stat.size
      && cached.mtimeMs === stat.mtimeMs) {
      sessionTitleCache.delete(file);
      sessionTitleCache.set(file, cached);
      return cached.customTitle || cached.aiTitle || "Untitled session";
    }

    const appendOnly = cached
      && cached.identity === identity
      && stat.size > cached.size
      && stat.mtimeMs >= cached.mtimeMs;
    const start = appendOnly ? Math.max(0, cached.size - MAX_SESSION_TITLE_RECORD_BYTES) : 0;
    const initial = appendOnly ? cached : {};
    try {
      const state = await scanSessionTitleState(file, stat, initial, start);
      const value = { identity, size: stat.size, mtimeMs: stat.mtimeMs, ...state };
      sessionTitleCache.delete(file);
      sessionTitleCache.set(file, value);
      while (sessionTitleCache.size > 64) sessionTitleCache.delete(sessionTitleCache.keys().next().value);
      return value.customTitle || value.aiTitle || "Untitled session";
    } catch {
      return sessionTitle(readJsonlTail(file, MAX_SESSION_SUMMARY_BYTES));
    }
  }

  function liveUsageSnapshots(file, records, actor, stat, historical, sessionId) {
    const parsed = parseClaudeContextRecords(records, {
      actorId: actor.id,
      sourceKey: actor.id,
      fallbackTimestamp: stat.mtime.toISOString(),
      completeHistory: stat.size <= MAX_BYTES_PER_FILE,
      expectedSessionId: sessionId,
    });
    if (historical) return parsed;

    const generation = usageSnapshotGeneration(file, stat);
    if (!generation) {
      liveUsageSnapshotCache.delete(file);
      return parsed;
    }
    const cached = liveUsageSnapshotCache.get(file);
    if (!cached || cached.actorId !== actor.id) {
      liveUsageSnapshotCache.set(file, { actorId: actor.id, generation, snapshots: parsed });
      return parsed;
    }

    const previous = cached.generation;
    const monotonic = previous
      && previous.identity === generation.identity
      && generation.size >= previous.size
      && generation.mtimeMs >= previous.mtimeMs
      && (generation.size > previous.size || generation.mtimeMs === previous.mtimeMs);
    if (!monotonic || !priorFileSuffixStillMatches(file, previous)) {
      liveUsageSnapshotCache.set(file, { actorId: actor.id, generation, snapshots: parsed });
      return parsed;
    }

    const snapshots = generation.size === previous.size && generation.mtimeMs === previous.mtimeMs
      ? cached.snapshots
      : mergeLiveUsageSnapshots(cached.snapshots, parsed);
    liveUsageSnapshotCache.set(file, { actorId: actor.id, generation, snapshots });
    return snapshots;
  }

  function discoveredSessions() {
    const files = listSessionFiles(projectsRoot);
    const registry = readSessionRegistry(registryRoot, { validateOwners: validateRegistryOwners, normalizeEntry: normalizeClaudeSessionRegistryEntry });
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
    backgroundLifecycle.prune(registry);
    await nativeStatus.refresh(registry, files.slice(0, 50).filter(({ file }) => liveFiles.has(file)).map(({ file }) => path.basename(file, ".jsonl")));
    const visibleFiles = new Set(files.slice(0, 50).map(({ file }) => file));
    for (const file of sessionTitleCache.keys()) {
      if (!visibleFiles.has(file) && !statSafe(file)) sessionTitleCache.delete(file);
    }
    const sessions = [];
    for (const { file, activityMs } of files.slice(0, 50)) {
      const stat = statSafe(file);
      if (!stat) continue;
      const cacheKey = `${stat.size}:${stat.mtimeMs}:${activityMs}`;
      const cached = sessionSummaryCache.get(file);
      const registryEntry = registry.get(path.basename(file, ".jsonl"));
      const isLive = liveFiles.has(file);
      const backgroundRunning = isLive ? await backgroundLifecycle.observe(file, registryEntry) : null;
      const liveState = {
        isLive,
        needsInput: Boolean(registryEntry?.needsInput),
        activityStatus: sessionActivityStatus(isLive, registryEntry, backgroundRunning),
        ...(isLive && registryEntry?.resourceOwner ? { resourceOwner: registryEntry.resourceOwner } : {}),
      };
      if (cached?.key === cacheKey) {
        sessions.push({ ...cached.value, ...liveState });
        continue;
      }
      const records = readJsonlTail(file, MAX_SESSION_SUMMARY_BYTES);
      const title = await cachedSessionTitle(file, stat);
      const cachedMetadata = sessionTitleCache.get(file);
      const fallbackCreatedAtMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      const value = {
        localId: path.basename(file, ".jsonl"),
        title,
        project: projectName(file, records),
        createdAt: cachedMetadata?.createdAt || new Date(fallbackCreatedAtMs).toISOString(),
        updatedAt: new Date(activityMs || stat.mtimeMs).toISOString(),
      };
      sessionSummaryCache.set(file, { key: cacheKey, value });
      sessions.push({ ...value, ...liveState });
    }
    return sessions;
  }

  async function readSession(localSessionId = "") {
    for (const file of liveUsageSnapshotCache.keys()) {
      if (!statSafe(file)) liveUsageSnapshotCache.delete(file);
    }
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
    if (!historical) nativeStatus.apply(registry, [sessionId]);
    const sessionRegistryEntry = registry.get(sessionId);
    const agentDir = path.join(path.dirname(mainFile), sessionId, "subagents");
    const workflowRoot = path.join(path.dirname(mainFile), sessionId, "workflows");
    const workflowDiscovery = discoverClaudeWorkflowAgents(agentDir);
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
    const usageLimitRejections = claudeFiveHourLimitRejections([...recordsByFile.values()]);
    const mainRecords = recordsByFile.get(mainFile) || [];
    const mainStat = statSafe(mainFile);
    const pomegrPlugin = await readLatestPomegrPluginMetadata(mainFile, "claude");
    const signalsByFile = new Map(/** @type {Array<[string, any]>} */ (await Promise.all(files.map(async (file) => [
      file,
      await readTranscriptSignals(file, recordsByFile.get(file) || []),
    ]))));
    const combinedSignals = { agent: null, session: null, tasks: new Map() };
    for (const signals of signalsByFile.values()) mergeTranscriptSignals(combinedSignals, signals);
    const taskSignals = combinedSignals.tasks;
    const sessionSignal = combinedSignals.session;
    // Session progress is intentionally primary-agent-only; child transcripts
    // may report agent/task signals but cannot overwrite session progress.
    const sessionProgress = signalsByFile.get(mainFile)?.progress || null;
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
    const transcriptPaths = new Map();
    let startedAt = null;
    let updatedAt = null;

    for (const file of files) {
      const stat = statSafe(file);
      if (!stat) continue;
      const actor = actorFor(file, mainFile, agentMetadata, workflowFiles);
      if (file !== mainFile) transcriptPaths.set(actor.id, file);
      const workflowAgent = workflowFiles.get(file) || null;
      const records = recordsByFile.get(file) || [];
      usageSnapshots.push(...liveUsageSnapshots(file, records, actor, stat, historical, sessionId));
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
          workKind: "input",
          detail: userInputType,
          status: null,
        });
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
            workKind: toolWorkKind(tool, { detail, input }),
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
      const needsInputAt = file === mainFile && sessionRegistryEntry?.remoteSessionId
        ? registryNeedsInputAt : registryNeedsInputAt || transcriptNeedsInputAt;
      const observedStatus = file === mainFile
        ? registryStatus(sessionRegistryEntry, statusFor(stat.mtimeMs, now()))
        : statusFor(stat.mtimeMs, now());
      agents.push({
        id: actor.id,
        label: actor.label,
        kind: actor.kind,
        parentId: actor.parentId,
        transcriptAvailable: file !== mainFile,
        workflowId: workflowAgent?.runId || null,
        workflowPhaseId: null,
        workflowOrder: null,
        workflowState: workflowAgent ? "unknown" : null,
        model: runtime.model === "unknown" ? workflowAgent?.metadata?.model || runtime.model : runtime.model,
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
        planTasks = await readClaudeTranscriptPlanTasks(mainFile);
        transcriptPlanTasksCache.set(mainFile, { key: cacheKey, value: planTasks });
      }
    }

    const workflows = buildClaudeWorkflows({
      mainRecords,
      workflowRoot,
      workflowDiscovery,
      agents,
      historical,
      manifestCache: workflowManifestCache,
    });
    for (const agent of agents) {
      if (agent.status !== "stopped" && terminalClaudeWorkflowAgentStates.has(agent.workflowState)) {
        agent.status = "finished";
      }
    }
    transcriptPathsBySessionId.delete(sessionId);
    transcriptPathsBySessionId.set(sessionId, transcriptPaths);
    while (transcriptPathsBySessionId.size > 64) transcriptPathsBySessionId.delete(transcriptPathsBySessionId.keys().next().value);

    return {
      localId: sessionId,
      historical,
      session: {
        title: mainStat ? await cachedSessionTitle(mainFile, mainStat) : sessionTitle(mainRecords),
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
        progress: sessionProgress,
        pomegrPlugin,
      },
      agents,
      workflows,
      usageSnapshots,
      usageLimitRejections,
      toolCalls,
      activity,
      planTasks,
      compactions,
      efficiencyRuleEvidence: {
        repetition: true,
        concurrentMutation: true,
        unsharedContext: true,
        healthyFallback: true,
        cacheUsageClassification: usageSnapshots.some((snapshot) => snapshot.cacheComparable === true),
      },
      pullRequestCreations: await readClaudePullRequestCreations([...recordsByFile].map(([file, records]) => ({
        file,
        records,
        actorId: actorFor(file, mainFile, agentMetadata, workflowFiles).id,
      }))),
    };
  }

  async function readTranscriptPath(localSessionId = "", agentId = "") {
    if (!transcriptPathsBySessionId.has(localSessionId)) await readSession(localSessionId);
    return transcriptPathsBySessionId.get(localSessionId)?.get(agentId) || null;
  }

  async function observerSource(localSessionId) {
    const discovered = discoveredSessions();
    const file = discovered.files.find(({ file: candidate }) => path.basename(candidate, ".jsonl") === localSessionId)?.file || null;
    if (!file) return null;
    const agentDir = path.join(path.dirname(file), localSessionId, "subagents");
    const workflowFiles = discoverClaudeWorkflowAgents(agentDir).files.map((item) => item.file);
    const historical = !discovered.liveFiles.has(file);
    if (!historical) await nativeStatus.refresh(discovered.registry, [localSessionId]);
    return claudeLifecycleSource(incrementalSourceSetDescriptor([file, ...walkJsonl(agentDir, 1), ...workflowFiles], file, historical), historical ? null : discovered.registry.get(localSessionId));
  }

  const routeClaudeSourceEvent = createClaudeSourceEventRouter(projectsRoot);

  return defineProvider({
    id: "claude",
    source: "Claude Code",
    capabilityManifest: {
      approvalMode: { status: "supported" },
      automaticCompactions: { status: "supported" },
      contextMachinery: { status: "supported" },
      estimatedCost: { status: "supported" },
      liveSessions: { status: "supported" },
      needsInput: { status: "supported" },
      planTasks: { status: "supported" },
      cacheWriteUsage: { status: "supported" },
      cacheUsageClassification: { status: "supported" },
      sessionSummary: { status: "supported" },
      signals: { status: "supported" },
      usageLimits: { status: "supported" },
      workflows: { status: "supported" },
    },
    homePolicy: {
      requestModelObservations: true,
      modelSelection: false,
      usageLimitActivity: {
        enabled: true,
        weeklyLimitIds: ["all-models", "model-fable"],
        trackedLimitIds: ["current-session", "all-models", "model-fable"],
        modelScopes: [{ limitId: "model-fable", modelSegments: ["fable"] }],
        selection: { mode: "all" },
      },
    },
    listSessions,
    readSession,
    createObserver() {
      return createIncrementalProviderObserver({
        providerId: "claude",
        list: listSessions,
        readEvidence: readSession,
        resolveSource: observerSource,
        routeSourceEvent: routeClaudeSourceEvent,
        intervalMs: options.observerIntervalMs ?? 10_000,
        concurrency: options.observerConcurrency ?? 2,
        watchTargets: [projectsRoot],
        watchSource: options.observerWatchSource,
      });
    },
    readTranscriptPath,
    readUsageLimits: usageLimits,
    unavailableMessage(localSessionId = "") {
      return localSessionId ? "The selected session is no longer available." : `No Claude Code sessions found under ${projectsRoot}`;
    },
    watchTargets: [projectsRoot],
  });
}

export const claudeProvider = createClaudeProvider();
