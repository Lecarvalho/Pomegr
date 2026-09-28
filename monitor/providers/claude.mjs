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
import { claudeConversationActivity, claudeSessionWorkStartedAt, claudeTaskNotificationActivity, createClaudeActivityReader, userInputContentType } from "./claude-activity-events.mjs";
import { boundedActivityDuration, boundedFileChanges, recentActivityEvents } from "../activity-events.mjs";
import { latestContextMachinery, readLatestContextMachinery } from "../context-machinery.mjs";
import { contextCompactions, mergeContextCompactions, readContextCompactions } from "../context-compactions.mjs";
import { buildExecutionTasks } from "../execution-tasks.mjs";
import { listSessionFiles, liveSessionFiles, isLiveSessionActivity, SESSION_LIVE_WINDOW_MS, SESSION_REGISTRY_GRACE_MS, statSafe, walkJsonl } from "../session-discovery.mjs";
import { createSessionRegistryOwnerValidator, preferredRegisteredSessionId, processAlive } from "../session-registry.mjs";
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
import { claudeFileChangeCandidates, claudeToolOutcomes, firstSuccessfulClaudeToolOutcome, safeDetail } from "./claude-tool-detail.mjs";
import { applyClaudeCurrentActivities, createClaudeCurrentActivityReader } from "./claude-current-activity.mjs";
import { readLatestPomegrPluginMetadata } from "./pomegr-plugin-metadata.mjs";
import { readClaudeTranscriptPlanTasks } from "./claude-plan-tasks.mjs";
import { createClaudeAgentLifecycleReader, applyClaudeAgentTerminals } from "./claude-agent-lifecycle.mjs";
import { createClaudeBackgroundLifecycleReader } from "./claude-background-lifecycle.mjs";
import { claudeFiveHourLimitRejections, createClaudeUsageLimitsReader } from "./claude-usage-limits.mjs";
import { createClaudeLiveUsageSnapshotReader } from "./claude-live-usage-snapshots.mjs";
import { FILE_SUFFIX_SAMPLE_BYTES, fileIdentity, readFileSuffix } from "./claude-file-generation.mjs";
import {
  actorFor,
  projectCwd,
  projectName,
  recordedGitBranch,
  runtimeMetadata,
  sessionTitle,
  statusFor,
} from "./claude-session-identity.mjs";
import { createClaudeCatalogTitleEnrichment } from "./claude-catalog-title-enrichment.mjs";
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
import { createClaudeSessionWorkStartReader } from "./claude-session-work-start.mjs";
import { createSourceLedger } from "./source-ledger.mjs";
import { createClaudeSessionResolver, ingestClaudeDiscovery, parseClaudeSessionLedgerHeader } from "./claude-session-ledger.mjs";
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
  const titleEnrichment = createClaudeCatalogTitleEnrichment({ statSafe, scanTitleState: options.scanTitleState });
  const contextMachineryCache = new Map();
  const contextCompactionsCache = new Map();
  const liveUsageSnapshots = createClaudeLiveUsageSnapshotReader({ maximumBytesPerFile: MAX_BYTES_PER_FILE });
  const transcriptPlanTasksCache = new Map();
  const workflowManifestCache = new Map();
  const historyCache = new Map();
  // Same 4,096-entry bound the prior Claude-private locator used; Claude sessions have no
  // provider-native family relation, so only locate()/noticeSource() are exercised here.
  const sourceLedger = createSourceLedger({ parseHeader: parseClaudeSessionLedgerHeader, maxEntries: 4_096, now });
  const transcriptPathsBySessionId = new Map();
  const sessionWorkStartReader = createClaudeSessionWorkStartReader({ yieldControl: options.yieldControl });
  const catalogPresence = createClaudeCatalogPresence();
  const validateRegistryOwners = options.validateRegistryOwners || createSessionRegistryOwnerValidator({
    env: environment,
    now,
    platform: options.platform,
    processIdentities: options.registryProcessIdentities,
    processExists: options.registryProcessExists ?? (options.registryProcessIdentities ? undefined : processAlive),
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
    const main = resolveSession(localSessionId)?.mainFile;
    if (!main) return null;
    const subagents = walkJsonl(path.join(path.dirname(main), path.basename(main, ".jsonl"), "subagents"), 1);
    const workflows = discoverClaudeWorkflowAgents(path.join(path.dirname(main), path.basename(main, ".jsonl"), "subagents")).files.map((item) => item.file);
    return [main, ...subagents, ...workflows].map((file) => { const stat = statSafe(file); const suffix = stat && readFileSuffix(file, stat.size, FILE_SUFFIX_SAMPLE_BYTES); return stat && suffix ? `${fileIdentity(stat)}:${stat.size}:${stat.mtimeMs}:${suffix.digest}` : "invalid"; }).sort().join("|");
  }
  async function cachedSessionTitle(file, stat, records, { fast = false } = {}) {
    return fast ? titleEnrichment.fast(file, stat, records) : titleEnrichment.exact(file, stat, records);
  }

  function discoveredSessions() {
    const files = listSessionFiles(projectsRoot);
    const { registry, closedSessionIds } = registryObservation.read();
    const explicitFile = explicitSession && fs.existsSync(explicitSession) ? explicitSession : null;
    if (explicitFile && !files.some(({ file }) => file === explicitFile)) {
      files.unshift({ file: explicitFile, activityMs: statSafe(explicitFile)?.mtimeMs || 0 });
    }
    ingestClaudeDiscovery(sourceLedger, files);
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

  async function listSessions(listOptions = {}) {
    const fastCatalog = listOptions.fastCatalog === true;
    const { files, liveFiles, registry, closedSessionIds } = discoveredSessions();
    sourceLedger.markLive([...liveFiles].map((file) => path.basename(file, ".jsonl")));
    backgroundLifecycle.prune(registry);
    const transcriptStatusIds = files.slice(0, 50).filter(({ file }) => liveFiles.has(file)).map(({ file }) => path.basename(file, ".jsonl"));
    nativeStatus.apply(registry, transcriptStatusIds);
    // Local provider evidence is sufficient for initial catalog publication.
    // Remote Control lifecycle is optional enrichment; its reader wakes the
    // observer after a changed normalized lifecycle arrives later.
    if (transcriptStatusIds.length) void nativeStatus.refresh(registry, transcriptStatusIds).catch(() => {});
    const visibleFiles = new Set(files.slice(0, 50).map(({ file }) => file));
    titleEnrichment.prune(visibleFiles);
    const sessions = [];
    for (const { file, activityMs } of files.slice(0, 50)) {
      const stat = statSafe(file);
      if (!stat) continue;
      const cacheKey = `${stat.size}:${stat.mtimeMs}:${activityMs}`;
      const cached = sessionSummaryCache.get(file);
      const registryEntry = registry.get(path.basename(file, ".jsonl"));
      const isLive = liveFiles.has(file);
      const backgroundRunning = isLive
        ? fastCatalog ? backgroundLifecycle.peek(file, registryEntry) : await backgroundLifecycle.observe(file, registryEntry)
        : null;
      if (fastCatalog && isLive) void backgroundLifecycle.observe(file, registryEntry).catch(() => {});
      const liveState = {
        isLive,
        needsInput: Boolean(registryEntry?.needsInput),
        activityStatus: !isLive && closedSessionIds.has(path.basename(file, ".jsonl"))
          ? "closed" : sessionActivityStatus(isLive, registryEntry, backgroundRunning),
        ...(isLive && registryEntry?.resourceOwner ? { resourceOwner: registryEntry.resourceOwner } : {}),
      };
      if (cached?.key === cacheKey) {
        if (fastCatalog) titleEnrichment.ensure(file, stat);
        sessions.push({ ...cached.value, ...liveState });
        continue;
      }
      const records = readJsonlTail(file, MAX_SESSION_SUMMARY_BYTES);
      const titleMetadata = await cachedSessionTitle(file, stat, records, { fast: fastCatalog });
      const fallbackCreatedAtMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      const value = {
        localId: path.basename(file, ".jsonl"),
        title: titleMetadata.title,
        project: projectName(file, records),
        createdAt: titleMetadata.createdAt || new Date(fallbackCreatedAtMs).toISOString(),
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

  const resolveSession = createClaudeSessionResolver({
    ledger: sourceLedger, discover: discoveredSessions, readRegistry: () => registryObservation.read(),
    explicitFile: () => (explicitSession && fs.existsSync(explicitSession) ? explicitSession : null),
    registryAvailable: () => fs.existsSync(registryRoot), now, selectFile: selectedSessionFile,
  });

  async function readSession(localSessionId = "", readOptions = {}) {
    liveUsageSnapshots.pruneMissingFiles();
    const resolved = resolveSession(localSessionId);
    if (!resolved) return null;
    const { mainFile, historical, registry } = resolved;
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
    const fastCatalog = readOptions.fastCatalog === true;
    const completeReads = new Map();
    for (const file of files) completeReads.set(file, completeHistory ? await readClaudeHistoryRecords(file, options.yieldControl) : null);
    if (completeHistory && [...completeReads.values()].some((item) => !item.complete)) return null;
    const recordsByFile = new Map(files.map((file) => [file, completeReads.get(file)?.records || readJsonlTail(file)]));
    const usageLimitRejections = claudeFiveHourLimitRejections([...recordsByFile.values()]);
    const mainRecords = recordsByFile.get(mainFile) || [];
    const primaryStartedAt = completeHistory
      ? claudeSessionWorkStartedAt(mainRecords)
      : await sessionWorkStartReader.read(mainFile);
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
    let startedAt = primaryStartedAt;
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
          const fileChanges = successfulOutcome
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
      const recordedTiming = agentTiming(records, stat.mtime.toISOString());
      const timing = actor.id === "primary" && primaryStartedAt
        ? {
          ...recordedTiming,
          startedAt: primaryStartedAt,
          durationMs: Math.max(0, Date.parse(recordedTiming.updatedAt) - Date.parse(primaryStartedAt)),
        }
        : recordedTiming;
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
        title: mainStat ? (await cachedSessionTitle(mainFile, mainStat, mainRecords, { fast: fastCatalog })).title : sessionTitle(mainRecords),
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
    const mainFile = localSessionId ? resolveSession(localSessionId)?.mainFile : null;
    if (!mainFile) return null;
    const agentDir = path.join(path.dirname(mainFile), path.basename(mainFile, ".jsonl"), "subagents");
    return discoverClaudeWorkflowAgents(agentDir).files.find((item) => item.id === agentId)?.file
      || walkJsonl(agentDir, 1).find((file) => path.basename(file, ".jsonl") === agentId)
      || null;
  }
  async function readSessionHistory(localSessionId = "") { const key = historyKey(localSessionId); const cached = key && historyCache.get(localSessionId); if (cached?.key === key) return cached.value; const value = normalizedSessionHistory("claude", localSessionId, await readSession(localSessionId, { completeHistory: true })); if (!key || historyKey(localSessionId) !== key) return { requests: [], activity: [], complete: false }; if (value.complete) historyCache.set(localSessionId, { key, value }); while (historyCache.size > 64) historyCache.delete(historyCache.keys().next().value); return value; }

  /**
   * Enumerate transcript identities only.  The inventory does not need titles
   * inferred from a JSONL tail, and this must never contend with selected
   * session hydration or retain an unbounded catalog in the provider.
   */
  /** @param {{ onBatch?: (batch: unknown[]) => boolean | Promise<boolean>, signal?: AbortSignal }} [options] */
  async function enumerateSessionHeaders(options = {}) {
    const { onBatch, signal } = options;
    if (typeof onBatch !== "function") return { complete: false };
    let batch = [];
    const emit = async () => {
      if (!batch.length) return true;
      const next = batch;
      batch = [];
      try { return (await onBatch(next)) !== false; } catch { return false; }
    };
    async function walk(directory, nestedSubagent, depth) {
      if (depth > 16 || signal?.aborted) return false;
      let handle;
      try { handle = await fs.promises.opendir(directory, { bufferSize: 32 }); } catch { return false; }
      try {
        for await (const entry of handle) {
          if (signal?.aborted) return false;
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            // Subagent trees are never top-level session candidates and need
            // not consume traversal work or memory.
            if (entry.name !== "subagents" && !nestedSubagent && !await walk(file, false, depth + 1)) return false;
            continue;
          }
          if (nestedSubagent || !entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
          const localId = path.basename(entry.name, ".jsonl");
          if (!/^[a-zA-Z0-9_-]+$/.test(localId)) continue;
          let stat, descriptor, header;
          try {
            stat = fs.statSync(file);
            if (!stat.isFile() || stat.size <= 0) return false;
            descriptor = fs.openSync(file, "r");
            const bytes = Math.min(stat.size, 64 * 1024);
            const buffer = Buffer.alloc(bytes);
            if (fs.readSync(descriptor, buffer, 0, bytes, 0) !== bytes) return false;
            header = buffer.toString("utf8");
          } catch { return false; }
          finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
          let recognized = false;
          for (const line of header.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const record = JSON.parse(line);
              const sessionId = record?.sessionId ?? record?.session_id;
              if (sessionId === localId) { recognized = true; break; }
            } catch { /* A complete malformed candidate is explicitly invalid below. */ }
          }
          // A complete, readable non-session JSONL is an explicit non-candidate.
          // A larger source whose first bounded window cannot validate identity
          // may be incomplete, so exact inventory coverage must degrade.
          if (!recognized) {
            if (stat.size <= 64 * 1024) continue;
            return false;
          }
          batch.push({
            localId, title: "Untitled session", project: "Unknown project",
            createdAt: new Date(Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs).toISOString(),
            updatedAt: stat.mtime.toISOString(), isLive: false, needsInput: false,
            activityStatus: "unknown",
          });
          if (batch.length === 100 && !await emit()) return false;
        }
        return true;
      } catch { return false; }
      finally { try { await handle?.close(); } catch { /* iteration may already close it */ } }
    }
    const projectsComplete = await walk(projectsRoot, false, 0);
    if (!projectsComplete && !signal?.aborted) await emit();
    // A configured one-off transcript can sit outside the projects root.
    // Validate its bounded leading records under the same identity rule.
    const explicitRelative = explicitSession ? path.relative(projectsRoot, explicitSession) : "";
    const explicitOutsideProjects = explicitSession && fs.existsSync(explicitSession)
      && explicitRelative && !explicitRelative.startsWith("..") && !path.isAbsolute(explicitRelative) ? null : explicitSession;
    if (explicitOutsideProjects) {
      const localId = path.basename(explicitOutsideProjects, ".jsonl");
      let stat, descriptor, header;
      try {
        if (!/^[a-zA-Z0-9_-]+$/.test(localId)) return { complete: false };
        stat = fs.statSync(explicitOutsideProjects);
        if (!stat.isFile() || stat.size <= 0) return { complete: false };
        descriptor = fs.openSync(explicitOutsideProjects, "r");
        const bytes = Math.min(stat.size, 64 * 1024), buffer = Buffer.alloc(bytes);
        if (fs.readSync(descriptor, buffer, 0, bytes, 0) !== bytes) return { complete: false };
        header = buffer.toString("utf8");
      } catch { return { complete: false }; }
      finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
      const recognized = header.split(/\r?\n/).some((line) => {
        try { const record = JSON.parse(line); return (record?.sessionId ?? record?.session_id) === localId; } catch { return false; }
      });
      if (!recognized && stat.size > 64 * 1024) return { complete: false };
      if (recognized) batch.push({
        localId, title: "Untitled session", project: "Unknown project",
        createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(), updatedAt: stat.mtime.toISOString(),
        isLive: false, needsInput: false, activityStatus: "unknown",
      });
    }
    // Native registrations may legitimately precede transcript creation. They
    // are complete provider identities with unavailable detail, so preserve
    // their existing catalog semantics in the inventory stream as well.
    let registry, registryComplete = true;
    try { ({ registry, complete: registryComplete } = registryObservation.read()); }
    catch { registry = new Map(); registryComplete = false; }
    for (const entry of registry.values()) {
      if (signal?.aborted) return { complete: false };
      if (!entry?.resourceOwner || !/^[a-zA-Z0-9_-]+$/.test(entry.sessionId || "") || !Number.isFinite(entry.ownerStartedAt)) continue;
      const timestamp = new Date(entry.ownerStartedAt).toISOString();
      batch.push({
        localId: entry.sessionId, title: "Untitled session", project: "Unknown project",
        createdAt: timestamp, updatedAt: timestamp, isLive: true,
        needsInput: Boolean(entry.needsInput), activityStatus: sessionActivityStatus(true, entry),
      });
      if (batch.length === 100 && !await emit()) return { complete: false };
    }
    const emitted = await emit();
    return { complete: Boolean(projectsComplete) && Boolean(registryComplete) && emitted };
  }

  async function observerSource(localSessionId) {
    const resolved = localSessionId ? resolveSession(localSessionId) : null;
    if (!resolved) return null;
    const { mainFile: file, historical, registry } = resolved;
    const agentDir = path.join(path.dirname(file), localSessionId, "subagents");
    const workflowFiles = discoverClaudeWorkflowAgents(agentDir).files.map((item) => item.file);
    if (!historical) {
      nativeStatus.apply(registry, [localSessionId]);
      void nativeStatus.refresh(registry, [localSessionId]).catch(() => {});
    }
    const source = claudeLifecycleSource(incrementalSourceSetDescriptor([file, ...walkJsonl(agentDir, 1), ...workflowFiles], file, historical), historical ? null : registry.get(localSessionId));
    // Rebuild pre-fix checkpoints even when the native transcript is unchanged.
    const entry = historical ? null : registry.get(localSessionId);
    return source ? {
      ...source,
      identity: `${source.identity}:conversation-activity-v7:${titleEnrichment.metadata(file, statSafe(file))}:${backgroundLifecycle.sourceState(file, entry)}`,
    } : null;
  }

  const routeClaudeSourceEvent = createClaudeSourceEventRouter(projectsRoot, {
    registryRoot, liveSessionIds: catalogPresence.liveSessionIds, ledger: sourceLedger,
  });
  const catalogTitleUpdates = {
    subscribe(listener) {
      return titleEnrichment.subscribe((file) => {
        sessionSummaryCache.delete(file);
        listener([path.basename(file, ".jsonl")]);
      });
    },
  };

  return defineProvider({
    id: "claude",
    source: "Claude Code",
    catalogSourceScope: crypto.createHash("sha256").update(JSON.stringify({ projectsRoot, registryRoot, explicitSession: explicitSession || null })).digest("hex"),
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
    enumerateSessionHeaders,
    readSession,
    readSessionHistory,
    captureRepositoryContextInventory,
    readRepositoryPluginSetup,
    createObserver() {
      const observer = observeClaudeRegistryDepartures(createIncrementalProviderObserver({
        providerId: "claude",
        list: (listOptions) => listSessions({ ...listOptions, fastCatalog: true }),
        readEvidence: (localSessionId, readOptions) => readSession(localSessionId, { ...readOptions, fastCatalog: true }),
        resolveSource: observerSource,
        routeSourceEvent: routeClaudeSourceEvent,
        intervalMs: options.observerIntervalMs ?? 10_000,
        concurrency: options.observerConcurrency ?? 2,
        interactiveConcurrency: options.observerInteractiveConcurrency ?? options.observerConcurrency ?? 3,
        backgroundConcurrency: options.observerBackgroundConcurrency ?? 1,
        watchTargets: [projectsRoot, registryRoot],
        watchSource: options.observerWatchSource,
      }), registryObservation, nativeStatus, backgroundLifecycle, catalogTitleUpdates);
      let cleanup = () => {};
      return Object.freeze({
        ...observer,
        async start(...args) {
          titleEnrichment.activate();
          backgroundLifecycle.activate();
          const signal = args[1];
          const stopEnrichment = () => {
            titleEnrichment.stop();
            backgroundLifecycle.stop();
          };
          cleanup = () => {
            signal?.removeEventListener?.("abort", stopEnrichment);
            stopEnrichment();
          };
          signal?.addEventListener?.("abort", stopEnrichment, { once: true });
          try { return await observer.start(...args); }
          catch (error) { cleanup(); throw error; }
        },
        stop() {
          cleanup();
          observer.stop();
        },
      });
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
