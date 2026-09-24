import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentTiming,
  applyWaitingStatus,
  externallyStoppedAgentTimes,
  isAgentTranscriptFinished,
  isExternalStopCurrent,
  pendingUserInputAt,
  resolveAgentMetadata,
} from "../agent-metadata.mjs";
import { claudeConversationActivity, claudeTaskNotificationActivity, createClaudeActivityReader, userInputContentType } from "./claude-activity-events.mjs";
import { boundedActivityDuration, boundedFileChanges, recentActivityEvents } from "../activity-events.mjs";
import { latestContextMachinery, readLatestContextMachinery } from "../context-machinery.mjs";
import { contextCompactions, mergeContextCompactions, readContextCompactions } from "../context-compactions.mjs";
import { buildExecutionTasks } from "../execution-tasks.mjs";
import { listSessionFiles, liveSessionFiles, statSafe, walkJsonl } from "../session-discovery.mjs";
import { createSessionRegistryOwnerValidator, preferredRegisteredSessionId } from "../session-registry.mjs";
import { readSessionTasks } from "../session-tasks.mjs";
import { mergeTranscriptSignals, readTranscriptSignals } from "../session-signals.mjs";
import { latestSessionSummary } from "../session-summary.mjs";
import { readSessionCost } from "../session-cost.mjs";
import { latestSessionApprovalMode } from "../session-approval-mode.mjs";
import { buildSkillUsage } from "../skill-usage.mjs";
import { mutationScopes, repetitionSignature } from "../tool-efficiency.mjs";
import { toolWorkKind } from "../work-kind.mjs";
import { defineProvider } from "./provider-contract.mjs";
import { createIncrementalProviderObserver, incrementalSourceSetDescriptor } from "./incremental-provider-observer.mjs";
import { createClaudeSourceEventRouter } from "./claude-source-routing.mjs";
import { createClaudeRegistryObservation, observeClaudeRegistryDepartures } from "./claude-registry-observation.mjs";
import { createClaudeCatalogPresence } from "./claude-catalog-presence.mjs";
import { readClaudePullRequestCreations } from "./claude-pull-requests.mjs";
import { claudeToolResultTimestamps, firstClaudeToolResultAfter, splitClaudeRequestCorrelationEvidence, stampClaudeActivityRequestIds } from "./claude-activity-correlation.mjs";
import { CLAUDE_SHELL_TOOLS, claudeFileChangeCandidates, claudeToolOutcomes, firstSuccessfulClaudeToolOutcome, safeDetail } from "./claude-tool-detail.mjs";
import { sameWorkingDirectory } from "./shell-file-writes.mjs";
import { applyClaudeCurrentActivities, createClaudeCurrentActivityReader } from "./claude-current-activity.mjs";
import { readLatestPomegrPluginMetadata } from "./pomegr-plugin-metadata.mjs";
import { readClaudeTranscriptPlanTasks } from "./claude-plan-tasks.mjs";
import { createClaudeAgentLifecycleReader, applyClaudeAgentTerminals } from "./claude-agent-lifecycle.mjs";
import { createClaudeBackgroundLifecycleReader } from "./claude-background-lifecycle.mjs";
import { claudeFiveHourLimitRejections, createClaudeUsageLimitsReader } from "./claude-usage-limits.mjs";
import { createClaudeLiveUsageSnapshotReader } from "./claude-live-usage-snapshots.mjs";
import { FILE_SUFFIX_SAMPLE_BYTES, fileIdentity, readFileSuffix } from "./claude-file-generation.mjs";
import {
  MAX_SESSION_TITLE_RECORD_BYTES,
  actorFor,
  projectCwd,
  projectName,
  recordedGitBranch,
  runtimeMetadata,
  scanSessionTitleState,
  sessionTitle,
  statusFor,
} from "./claude-session-identity.mjs";
export { claudeFiveHourLimitRejections };
import { buildClaudeWorkflows, discoverClaudeWorkflowAgents, terminalClaudeWorkflowAgentStates } from "./claude-workflows.mjs";
import {
  claudeLifecycleSource, createClaudeSessionStatusReader,
  registryStatus, registryTimestamp, sessionActivityStatus,
} from "./claude-session-status.mjs";
import { claudeRepositoryInventoryCaptureFromProviderOptions } from "./claude-repository-inventory.mjs";
import { createClaudePluginSetupReader } from "./claude-plugin-setup.mjs";
import { resolveClaudeProfileRoots } from "./claude-profile-roots.mjs";
import { normalizedSessionHistory, publishNormalizedHistoryActivity, publishNormalizedHistoryRequests } from "./session-history.mjs";
import { readClaudeHistoryRecords } from "./claude-history-reader.mjs";
const MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const MAX_SESSION_SUMMARY_BYTES = 256 * 1024;
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

export function createClaudeProvider(options = {}) {
  const captureRepositoryContextInventory = claudeRepositoryInventoryCaptureFromProviderOptions(options);
  const environment = options.env ?? process.env;
  const homeDir = options.homeDir || os.homedir();
  const { configRoot, projectsRoot, registryRoot, tasksRoot } = resolveClaudeProfileRoots({ ...options, env: environment, homeDir });
  const readRepositoryPluginSetup = createClaudePluginSetupReader({ env: environment, homeDir, configRoot });
  // File-change evidence never rebases into the adapter's own config/session roots.
  const fileChangeForbiddenRoots = [configRoot, projectsRoot].filter(Boolean);
  const explicitSession = options.explicitSession ?? environment.CLAUDE_SESSION_FILE;
  const now = options.now || (() => Date.now());
  const sessionSummaryCache = new Map();
  const sessionTitleCache = new Map();
  const contextMachineryCache = new Map();
  const contextCompactionsCache = new Map();
  const liveUsageSnapshots = createClaudeLiveUsageSnapshotReader({ maximumBytesPerFile: MAX_BYTES_PER_FILE });
  const transcriptPlanTasksCache = new Map();
  const workflowManifestCache = new Map();
  const historyCache = new Map();
  const transcriptPathsBySessionId = new Map();
  const catalogPresence = createClaudeCatalogPresence();
  const validateRegistryOwners = options.validateRegistryOwners || createSessionRegistryOwnerValidator({
    env: environment,
    now,
    platform: options.platform,
    processIdentities: options.registryProcessIdentities,
  });
  const usageLimits = createClaudeUsageLimitsReader({
    env: environment,
    homeDir,
    platform: options.platform,
    now,
    fetch: options.fetch,
    usageRequest: options.usageRequest,
    claudeConfigDir: configRoot,
    usageSnapshotsRoot: options.usageSnapshotsRoot,
    usageFeedFreshMs: options.usageFeedFreshMs,
  });
  const registryObservation = createClaudeRegistryObservation({
    root: registryRoot, validateOwners: validateRegistryOwners, now, ownerExists: options.registryProcessExists,
  });
  const backgroundLifecycle = createClaudeBackgroundLifecycleReader();
  const readAgentLifecycle = createClaudeAgentLifecycleReader();
  const readCurrentActivity = createClaudeCurrentActivityReader({ yieldControl: options.yieldControl });
  const readActivity = createClaudeActivityReader();
  const nativeStatus = createClaudeSessionStatusReader({ configRoot, fetch: options.fetch || globalThis.fetch, now });
  function historyKey(localSessionId) {
    const { files, liveFile } = discoveredSessions();
    const main = explicitSession && path.basename(explicitSession, ".jsonl") === localSessionId ? explicitSession : files.find((item) => path.basename(item.file, ".jsonl") === localSessionId)?.file || (localSessionId ? null : liveFile);
    if (!main) return null;
    const subagents = walkJsonl(path.join(path.dirname(main), path.basename(main, ".jsonl"), "subagents"), 1);
    const workflows = discoverClaudeWorkflowAgents(path.join(path.dirname(main), path.basename(main, ".jsonl"), "subagents")).files.map((item) => item.file);
    return [main, ...subagents, ...workflows].map((file) => { const stat = statSafe(file); const suffix = stat && readFileSuffix(file, stat.size, FILE_SUFFIX_SAMPLE_BYTES); return stat && suffix ? `${fileIdentity(stat)}:${stat.size}:${stat.mtimeMs}:${suffix.digest}` : "invalid"; }).sort().join("|");
  }
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

  function discoveredSessions() {
    const files = listSessionFiles(projectsRoot);
    const { registry, closedSessionIds } = registryObservation.read();
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
      closedSessionIds, nowMs: now(),
    });
    return { files, liveFile, liveFiles, registry, closedSessionIds };
  }

  async function listSessions() {
    const { files, liveFiles, registry, closedSessionIds } = discoveredSessions();
    backgroundLifecycle.prune(registry);
    const transcriptStatusIds = files.slice(0, 50).filter(({ file }) => liveFiles.has(file)).map(({ file }) => path.basename(file, ".jsonl"));
    nativeStatus.apply(registry, transcriptStatusIds);
    await nativeStatus.refresh(registry, transcriptStatusIds);
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
        activityStatus: !isLive && closedSessionIds.has(path.basename(file, ".jsonl"))
          ? "closed" : sessionActivityStatus(isLive, registryEntry, backgroundRunning),
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
    let catalog = catalogPresence.merge(sessions, files, registry, { explicitSession });
    const deferredStatusIds = catalog.filter((entry) => entry.detailReadiness === "unavailable").map((entry) => entry.localId);
    // A visible native identity publishes first; cached lifecycle can refine it
    // now, while a new optional Remote Control read finishes in the background.
    nativeStatus.apply(registry, deferredStatusIds);
    catalog = catalogPresence.merge(sessions, files, registry, { explicitSession });
    if (deferredStatusIds.length) void nativeStatus.refresh(registry, deferredStatusIds).catch(() => {});
    return catalog;
  }

  function selectedSessionFile(localSessionId, sessionFiles) {
    const explicitMatch = explicitSession
      && path.basename(explicitSession, ".jsonl") === localSessionId
      && fs.existsSync(explicitSession)
      ? explicitSession
      : null;
    const selectedMatch = /^[a-zA-Z0-9_-]+$/.test(localSessionId || "")
      ? sessionFiles.find(({ file }) => path.basename(file, ".jsonl") === localSessionId)?.file || null
      : null;
    return explicitMatch || selectedMatch;
  }

  async function readSession(localSessionId = "", readOptions = {}) {
    liveUsageSnapshots.pruneMissingFiles();
    const { files: sessionFiles, liveFile, liveFiles, registry } = discoveredSessions();
    const mainFile = localSessionId ? selectedSessionFile(localSessionId, sessionFiles) : liveFile;
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
    const completeHistory = readOptions.completeHistory === true;
    const completeReads = new Map();
    for (const file of files) completeReads.set(file, completeHistory ? await readClaudeHistoryRecords(file, options.yieldControl) : null);
    if (completeHistory && [...completeReads.values()].some((item) => !item.complete)) return null;
    const recordsByFile = new Map(files.map((file) => [file, completeReads.get(file)?.records || readJsonlTail(file)]));
    const usageLimitRejections = claudeFiveHourLimitRejections([...recordsByFile.values()]);
    const mainRecords = recordsByFile.get(mainFile) || [];
    const cwd = projectCwd(mainRecords);
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
    const activityRequestLinks = { toolUseIdsByRequest: new Map(), replyIdsByRequest: new Map() };
    const compactions = [];
    const transcriptPaths = new Map();
    let startedAt = null;
    let updatedAt = null;

    for (const file of files) {
      const stat = statSafe(file);
      if (!stat) continue;
      const actor = actorFor(file, mainFile, agentMetadata, workflowFiles);
      if (completeHistory) {
        const state = { calls: new Map(), launches: new Map(), events: new Map() };
        if (actor.id === "primary") claudeTaskNotificationActivity(recordsByFile.get(file) || [], state, Infinity);
        activity.push(...claudeConversationActivity(recordsByFile.get(file) || [], actor, state.events, Infinity).map((event) => ({ ...event, _historyAgentId: actor.id })));
      } else activity.push(...await readActivity(file, actor));
      if (file !== mainFile) transcriptPaths.set(actor.id, file);
      const workflowAgent = workflowFiles.get(file) || null;
      const records = recordsByFile.get(file) || [];
      let observedCompactions = contextCompactionsCache.get(file);
      if (observedCompactions === undefined) observedCompactions = await readContextCompactions(file);
      observedCompactions = mergeContextCompactions(observedCompactions, contextCompactions(records));
      contextCompactionsCache.set(file, observedCompactions);
      const requestEvidence = splitClaudeRequestCorrelationEvidence(liveUsageSnapshots.read(file, records, actor, stat, historical, sessionId,
        observedCompactions.map((compaction) => compaction.timestamp), completeHistory));
      for (const [key, toolUseIds] of requestEvidence.toolUseIdsByRequest) activityRequestLinks.toolUseIdsByRequest.set(key, toolUseIds);
      for (const [key, replyId] of requestEvidence.replyIdsByRequest) activityRequestLinks.replyIdsByRequest.set(key, replyId);
      usageSnapshots.push(...requestEvidence.normalizedSnapshots);
      compactions.push(...observedCompactions.map((compaction) => ({
        actorId: actor.id,
        timestamp: compaction.timestamp,
        trigger: compaction.trigger,
        preTokens: compaction.preTokens,
      })));
      const requestedInputIds = new Set();
      const resultTimes = claudeToolResultTimestamps(records);
      const toolOutcomes = claudeToolOutcomes(records);
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
          const successfulOutcome = firstSuccessfulClaudeToolOutcome(toolOutcomes, content.id, timestamp);
          // Bash keeps its directory across calls, so a shell write counts only
          // when the record shows it ran in the session cwd its targets resolve against.
          const shellCwdMatches = !CLAUDE_SHELL_TOOLS.has(tool) || sameWorkingDirectory(record.cwd, cwd);
          const fileChanges = successfulOutcome && shellCwdMatches
            ? boundedFileChanges(claudeFileChangeCandidates(tool, input, successfulOutcome.toolUseResult), cwd, { forbiddenRoots: fileChangeForbiddenRoots })
            : null;
          toolCalls.push({
            id: content.id || crypto.createHash("sha1").update(`${file}:${timestamp}:${calls}:${tool}`).digest("hex").slice(0, 12),
            timestamp: timestamp || stat.mtime.toISOString(),
            actor: { id: actor.id, label: actor.label },
            tool,
            workKind: toolWorkKind(tool, { detail, input }),
            detail,
            status: null,
            durationMs: boundedActivityDuration(timestamp, firstClaudeToolResultAfter(resultTimes, content.id, timestamp)),
            requestId: null,
            repetitionSignature: repetitionSignature(tool, input),
            mutation: scopes.length ? { display: path.basename(target), scopes } : null,
            fileChanges,
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
    await applyClaudeAgentTerminals(agents, recordsByFile, fileByAgentId, readAgentLifecycle);
    if (!historical) applyWaitingStatus(agents);
    for (const agent of agents) {
      const file = fileByAgentId.get(agent.id);
      agent.executionTasks = file
        ? buildExecutionTasks(recordsByFile.get(file) || [], { historical, sessionUpdatedAt: updatedAt, taskSignals })
        : [];
    }
    publishNormalizedHistoryActivity(readOptions.onHistoryActivity, "claude", sessionId, { agents, activity, toolCalls });
    stampClaudeActivityRequestIds({ sessionId, agents, usageSnapshots, toolCalls, activity, ...activityRequestLinks, unlimited: completeHistory });
    publishNormalizedHistoryRequests(readOptions.onHistoryRequests, "claude", sessionId, { agents, activity, toolCalls, usageSnapshots });
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
      if (agent.status !== "stopped" && terminalClaudeWorkflowAgentStates.has(agent.workflowState)) agent.status = "finished";
    }
    await applyClaudeCurrentActivities(agents, { fileByAgentId, historical, reader: readCurrentActivity, registryEntry: sessionRegistryEntry });
    transcriptPathsBySessionId.delete(sessionId);
    transcriptPathsBySessionId.set(sessionId, transcriptPaths);
    while (transcriptPathsBySessionId.size > 64) transcriptPathsBySessionId.delete(transcriptPathsBySessionId.keys().next().value);

    return {
      localId: sessionId,
      historical,
      session: {
        title: mainStat ? await cachedSessionTitle(mainFile, mainStat) : sessionTitle(mainRecords),
        project: projectName(mainFile, mainRecords),
        cwd,
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
      activity: completeHistory ? activity : recentActivityEvents(activity, 256),
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

  // One copy action needs one file location, so resolve it with readSession's discovery rules
  // (primary excluded, workflow agents over ordinary files) instead of parsing every transcript.
  async function readTranscriptPath(localSessionId = "", agentId = "") {
    if (agentId === "primary") return null;
    const recorded = transcriptPathsBySessionId.get(localSessionId)?.get(agentId);
    if (recorded && statSafe(recorded)) return recorded;
    const mainFile = selectedSessionFile(localSessionId, discoveredSessions().files);
    if (!mainFile) return null;
    const agentDir = path.join(path.dirname(mainFile), path.basename(mainFile, ".jsonl"), "subagents");
    return discoverClaudeWorkflowAgents(agentDir).files.find((item) => item.id === agentId)?.file
      || walkJsonl(agentDir, 1).find((file) => path.basename(file, ".jsonl") === agentId)
      || null;
  }
  async function readSessionHistory(localSessionId = "") { const key = historyKey(localSessionId); const cached = key && historyCache.get(localSessionId); if (cached?.key === key) return cached.value; const value = normalizedSessionHistory("claude", localSessionId, await readSession(localSessionId, { completeHistory: true })); if (!key || historyKey(localSessionId) !== key) return { requests: [], activity: [], complete: false }; if (value.complete) historyCache.set(localSessionId, { key, value }); while (historyCache.size > 64) historyCache.delete(historyCache.keys().next().value); return value; }

  async function observerSource(localSessionId) {
    const discovered = discoveredSessions();
    const file = discovered.files.find(({ file: candidate }) => path.basename(candidate, ".jsonl") === localSessionId)?.file || null;
    if (!file) return null;
    const agentDir = path.join(path.dirname(file), localSessionId, "subagents");
    const workflowFiles = discoverClaudeWorkflowAgents(agentDir).files.map((item) => item.file);
    const historical = !discovered.liveFiles.has(file);
    if (!historical) await nativeStatus.refresh(discovered.registry, [localSessionId]);
    const source = claudeLifecycleSource(incrementalSourceSetDescriptor([file, ...walkJsonl(agentDir, 1), ...workflowFiles], file, historical), historical ? null : discovered.registry.get(localSessionId));
    // Rebuild pre-fix checkpoints even when the native transcript is unchanged.
    return source ? { ...source, identity: `${source.identity}:conversation-activity-v6` } : null;
  }

  const routeClaudeSourceEvent = createClaudeSourceEventRouter(projectsRoot, {
    registryRoot, liveSessionIds: catalogPresence.liveSessionIds,
  });

  return defineProvider({
    id: "claude",
    source: "Claude Code",
    capabilityManifest: {
      approvalMode: { status: "supported" },
      automaticCompactions: { status: "supported" },
      contextMachinery: { status: "supported" },
      repositoryContextInventory: { status: "supported" },
      repositoryPluginSetup: { status: "supported" },
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
    providerFolders: { claudeConfigDir: configRoot, claudeProjectsDir: projectsRoot },
    listSessions,
    readSession,
    readSessionHistory,
    captureRepositoryContextInventory,
    readRepositoryPluginSetup,
    createObserver() {
      return observeClaudeRegistryDepartures(createIncrementalProviderObserver({
        providerId: "claude",
        list: listSessions,
        readEvidence: readSession,
        resolveSource: observerSource,
        routeSourceEvent: routeClaudeSourceEvent,
        intervalMs: options.observerIntervalMs ?? 10_000,
        concurrency: options.observerConcurrency ?? 2,
        interactiveConcurrency: options.observerInteractiveConcurrency ?? options.observerConcurrency ?? 2,
        backgroundConcurrency: options.observerBackgroundConcurrency ?? 1,
        watchTargets: [projectsRoot, registryRoot],
        watchSource: options.observerWatchSource,
      }), registryObservation, nativeStatus);
    },
    readTranscriptPath,
    readUsageLimits: usageLimits,
    unavailableMessage(localSessionId = "") {
      return localSessionId ? "The selected session is no longer available." : `No Claude Code sessions found under ${projectsRoot}`;
    },
    watchTargets: [projectsRoot, registryRoot],
  });
}

export const claudeProvider = createClaudeProvider();
