import assert from "node:assert/strict";
import test from "node:test";
import { createMonitorRuntime, createMonitorServer } from "../monitor/server.mjs";
import { createEmptyProviderCapabilities } from "../shared/monitor-state.mjs";

const provider = { source: "Codex", capabilities: createEmptyProviderCapabilities() };

function providerFixture(id, source) {
  return {
    id,
    source,
    capabilities: createEmptyProviderCapabilities(),
    homePolicy: {
      requestModelObservations: true,
      modelSelection: id === "codex",
      usageLimitActivity: {
        enabled: true,
        weeklyLimitIds: id === "claude" ? ["all-models", "model-fable"] : null,
        trackedLimitIds: id === "claude" ? ["current-session", "all-models", "model-fable"] : null,
        modelScopes: id === "claude" ? [{ limitId: "model-fable", modelSegments: ["fable"] }] : [],
        selection: id === "codex" ? {
          mode: "dominant_model_window",
          defaultWindow: "7d",
          defaultExcludedLimitSegments: ["gpt-5.3-codex-spark"],
          overrides: [{ models: ["gpt-5.3-codex-spark"], window: "5h", preferredLimitSegments: ["gpt-5.3-codex-spark"] }],
        } : { mode: "all" },
      },
    },
  };
}

function evidence({ project = "pomegr", startedAt = "2026-08-23T11:00:00.000Z", updatedAt = "2026-08-23T12:00:00.000Z", agents = [], usageSnapshots = [], usageLimitRejections = [], progress = null, progressPrivate = undefined } = {}) {
  return {
    historical: false,
    session: { title: "Home fixture", project, cwd: "C:\\synthetic\\pomegr", startedAt, updatedAt, recordedGitBranch: "main", cost: null, approvalMode: null, contextMachinery: null, summary: null, signal: null, progress, ...(progressPrivate === undefined ? {} : { progressPrivate }) },
    agents, usageSnapshots, usageLimitRejections, toolCalls: [], activity: [], planTasks: [], compactions: [],
    efficiencyRuleEvidence: { repetition: true, concurrentMutation: true, unsharedContext: true, healthyFallback: true },
    pullRequestCreations: [],
  };
}

function agent(id, status = "active", model = "test") {
  return { id, parentId: null, label: id, kind: "orchestrator", model, effort: null, status, signal: null, toolCalls: 0, skills: [], executionTasks: [], lastSeen: "2026-08-23T12:00:00.000Z", startedAt: "2026-08-23T11:00:00.000Z", updatedAt: "2026-08-23T12:00:00.000Z", durationMs: 3600000 };
}

function runtimeFixture(entries, evidenceById, options = {}) {
  const registry = {
    defaultProvider: provider,
    async inspectSessions() { return { sessions: entries, resourceTargets: options.resourceTargets || [] }; },
    async readSession(id) {
      const value = evidenceById.get(id);
      if (value instanceof Error) throw value;
      const selectedProvider = this.providers?.find((candidate) => candidate.id === id.split(":", 1)[0])
        || this.defaultProvider;
      return { evidence: value, provider: selectedProvider, sessionId: id };
    },
    providerForSessionId() { return provider; },
    ...options.registry,
  };
  return createMonitorRuntime({
    providerRegistry: registry,
    now: options.now || (() => Date.parse("2026-08-23T12:00:00.000Z")),
    resourceUsageSampler: options.resourceUsageSampler,
    homeSummaryCacheMs: options.homeSummaryCacheMs ?? 0,
    homeHistorySummaryCacheMs: options.homeHistorySummaryCacheMs ?? 0,
    homeSnapshotCacheMs: options.homeSnapshotCacheMs ?? 0,
    deferHomeHistory: options.deferHomeHistory ?? false,
    yieldHomeHistory: options.yieldHomeHistory,
    scheduleHomeRefresh: options.scheduleHomeRefresh,
  });
}

test("home snapshot includes independent Claude and Codex usage limits without live sessions", async () => {
  const providers = [
    providerFixture("claude", "Claude Code"),
    providerFixture("codex", "Codex"),
  ];
  const calls = [];
  const state = await runtimeFixture([], new Map(), {
    registry: {
      providers,
      async readUsageLimits(selectedProvider) {
        calls.push(selectedProvider.id);
        if (selectedProvider.id === "claude") throw new Error("PROMPT_RESPONSE_COMMAND_CREDENTIAL");
        return { available: true, fetchedAt: "2026-08-23T12:00:00.000Z", attemptedAt: "2026-08-23T12:00:00.000Z", limits: [{ id: "codex-primary", label: "Codex", window: "5 hours", percent: 37.5, resetsAt: null, severity: "normal", active: false }], error: "" };
      },
    },
  }).homeSnapshot();

  assert.deepEqual(calls, ["claude", "codex"]);
  assert.deepEqual(state.projects, []);
  assert.equal(state.providerLimits[0].source, "Claude Code");
  assert.equal(state.providerLimits[0].usageLimits.error, "Usage limits are temporarily unavailable.");
  assert.equal(state.providerLimits[1].usageLimits.limits[0].percent, 37.5);
  assert.doesNotMatch(JSON.stringify(state), /PROMPT|RESPONSE|COMMAND|CREDENTIAL/);
});

test("home snapshot selects the Codex activity window from bounded dominant-model evidence", async () => {
  const codexProvider = providerFixture("codex", "Codex");
  const entry = { id: "codex:recent", provider: "codex", source: "Codex", title: "Recent Codex", project: "repo", updatedAt: "2026-08-23T16:30:00.000Z", isLive: false, needsInput: false };
  const limits = [
    { id: "gpt-5.3-codex-spark-primary", label: "GPT-5.3-Codex-Spark", window: "5 hours", percent: 20, resetsAt: "2026-08-23T17:00:00.000Z", severity: "normal", active: false },
    { id: "codex-secondary", label: "Codex", window: "7 days", percent: 60, resetsAt: "2026-08-29T17:00:00.000Z", severity: "normal", active: false },
  ];
  const activityForModel = async (model, requestModels = [model]) => runtimeFixture([entry], new Map([[entry.id, evidence({
    startedAt: "2026-08-23T16:00:00.000Z",
    updatedAt: "2026-08-23T16:30:00.000Z",
    agents: [agent("primary", "finished", model)],
    usageSnapshots: requestModels.map((requestModel, index) => ({
      dedupeId: `request-${index}`,
      actorId: "primary",
      timestamp: `2026-08-23T16:${String(30 + index).padStart(2, "0")}:00.000Z`,
      input: 100,
      output: 20,
      cacheWrite: 0,
      cacheRead: 0,
      model: requestModel,
    })),
  })]]), {
    now: () => Date.parse("2026-08-23T17:00:00.000Z"),
    registry: {
      defaultProvider: codexProvider,
      providers: [codexProvider],
      async readUsageLimits() {
        return { available: true, fetchedAt: "2026-08-23T17:00:00.000Z", attemptedAt: "2026-08-23T17:00:00.000Z", limits, error: "" };
      },
    },
  }).homeSnapshot();

  const spark = await activityForModel("gpt-5.3-codex-spark");
  const standard = await activityForModel("gpt-5.4");
  const switched = await activityForModel("gpt-5.3-codex-spark", ["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4"]);
  assert.equal(spark.limitActivities[0].limitId, "gpt-5.3-codex-spark-primary");
  assert.equal(spark.limitActivities[0].window, "5 hours");
  assert.equal(standard.limitActivities[0].limitId, "codex-secondary");
  assert.equal(standard.limitActivities[0].window, "7 days");
  assert.equal(switched.limitActivities[0].limitId, "codex-secondary");
  assert.doesNotMatch(JSON.stringify(standard), /gpt-5\.4|requestModelObservations/i);
  assert.doesNotMatch(JSON.stringify(spark), /requestModelObservations/i);
});

test("home snapshot correlates Claude limit movement across live-only projects", async () => {
  const claudeProvider = providerFixture("claude", "Claude Code");
  const entries = [
    { id: "claude:live", provider: "claude", source: "Claude Code", title: "Live session", project: "repo-live", updatedAt: "2026-08-23T12:10:00.000Z", isLive: true, needsInput: false },
    { id: "claude:closed", provider: "claude", source: "Claude Code", title: "Closed session", project: "repo-closed", updatedAt: "2026-08-23T12:05:00.000Z", isLive: false, needsInput: false },
    { id: "claude:weekly", provider: "claude", source: "Claude Code", title: "Weekly session", project: "repo-weekly", updatedAt: "2026-08-20T13:00:00.000Z", isLive: false, needsInput: false },
  ];
  const request = (dedupeId, timestamp, model = "claude-sonnet-4") => ({
    dedupeId,
    actorId: "primary",
    timestamp,
    input: 100,
    output: 20,
    cacheWrite: 0,
    cacheRead: 0,
    token: "PRIVATE_TOKEN",
    model,
    prompt: "PRIVATE_PROMPT",
    command: "PRIVATE_COMMAND",
    credential: "PRIVATE_CREDENTIAL",
  });
  const evidenceById = new Map([
    ["claude:live", evidence({ project: "repo-live", startedAt: "2026-08-23T11:30:00.000Z", updatedAt: "2026-08-23T12:10:00.000Z", agents: [agent("primary")], usageSnapshots: [request("live-request", "2026-08-23T12:10:00.000Z", "claude-fable-4")] })],
    ["claude:closed", evidence({ project: "repo-closed", startedAt: "2026-08-23T10:30:00.000Z", updatedAt: "2026-08-23T12:05:00.000Z", agents: [agent("primary", "finished")], usageSnapshots: [request("closed-request", "2026-08-23T12:05:00.000Z")], usageLimitRejections: [{ observedAt: "2026-08-23T12:20:00.000Z", resetsAt: "2026-08-23T17:00:00.000Z", private: "PRIVATE_REJECTION_PAYLOAD" }] })],
    ["claude:weekly", evidence({ project: "repo-weekly", startedAt: "2026-08-20T12:30:00.000Z", updatedAt: "2026-08-20T13:00:00.000Z", agents: [agent("primary", "finished")], usageSnapshots: [request("weekly-request", "2026-08-20T13:00:00.000Z", "CLAUDE.FABLE.4")] })],
  ]);
  let currentTime = Date.parse("2026-08-23T12:00:00.000Z");
  let limit = { fetchedAt: "2026-08-23T12:00:00.000Z", percent: 10, weeklyPercent: 40, fablePercent: 12 };
  const runtime = runtimeFixture(entries, evidenceById, {
    now: () => currentTime,
    homeSnapshotCacheMs: 0,
    registry: {
      defaultProvider: claudeProvider,
      providers: [claudeProvider],
      async readUsageLimits(selectedProvider) {
        assert.equal(selectedProvider.id, "claude");
        assert.equal(selectedProvider.source, "Claude Code");
        return { available: true, fetchedAt: limit.fetchedAt, attemptedAt: limit.fetchedAt, limits: [
          { id: "current-session", label: "Current session", window: "5 hours", percent: limit.percent, resetsAt: "2026-08-23T17:00:00.000Z", severity: "normal", active: true },
          { id: "all-models", label: "All models", window: "7 days", percent: limit.weeklyPercent, resetsAt: "2026-08-27T12:00:00.000Z", severity: "normal", active: false },
          { id: "model-fable", label: "Fable", window: "7 days", percent: limit.fablePercent, resetsAt: "2026-08-27T12:00:00.000Z", severity: "normal", active: false },
        ], error: "" };
      },
      async readSession(id) {
        return { evidence: evidenceById.get(id), provider: claudeProvider, sessionId: id };
      },
    },
  });

  const first = await runtime.homeSnapshot();
  currentTime = Date.parse("2026-08-23T12:30:00.000Z");
  limit = { fetchedAt: "2026-08-23T12:15:00.000Z", percent: 35, weeklyPercent: 46, fablePercent: 19 };
  const second = await runtime.homeSnapshot();

  assert.deepEqual(first.projects.map(({ project }) => project), ["repo-live"]);
  assert.deepEqual(second.projects.map(({ project }) => project), ["repo-live"]);
  assert.equal(second.projects[0].sessions.length, 1);
  assert.equal(second.limitActivities.length, 3);
  const activity = second.limitActivities.find(({ limitId }) => limitId === "current-session");
  const weeklyActivity = second.limitActivities.find(({ limitId }) => limitId === "all-models");
  const fableActivity = second.limitActivities.find(({ limitId }) => limitId === "model-fable");
  assert.ok(activity);
  assert.ok(weeklyActivity);
  assert.ok(fableActivity);
  assert.equal(activity.provider, "claude");
  assert.equal(activity.source, "Claude Code");
  assert.deepEqual(activity.sessions.map(({ project, isLive }) => ({ project, isLive })), [
    { project: "repo-closed", isLive: false },
    { project: "repo-live", isLive: true },
  ]);
  assert.equal(activity.movements.length, 1);
  assert.equal(activity.movements[0].correlation, "shared");
  assert.deepEqual(activity.movements[0].sessionIds, ["claude:closed", "claude:live"]);
  assert.equal(activity.movements[0].changePoints, 25);
  assert.equal(activity.firstRejectedAt, "2026-08-23T12:20:00.000Z");
  assert.ok(Number.isFinite(activity.movements[0].changePoints));
  assert.equal(activity.sessions.every((session) => session.requestObservations.length === 1), true);
  assert.deepEqual(activity.sessions.flatMap(({ requestObservations }) => requestObservations.map(({ observedAt }) => observedAt)).sort(), [
    "2026-08-23T12:05:00.000Z",
    "2026-08-23T12:10:00.000Z",
  ]);
  assert.deepEqual(weeklyActivity.sessions.map(({ project }) => project), ["repo-weekly", "repo-closed", "repo-live"]);
  assert.equal(weeklyActivity.window, "7 days");
  assert.equal(fableActivity.scope, "model");
  assert.deepEqual(fableActivity.sessions.map(({ project }) => project), ["repo-weekly", "repo-live"]);
  assert.equal(fableActivity.sessions.every((session) => session.requestObservations.length === 1), true);
  assert.doesNotMatch(JSON.stringify(second), /claude-fable|claude-sonnet|requestModelObservations/i);
  assert.doesNotMatch(JSON.stringify(second), /PRIVATE|token|prompt|command|credential/i);
});

test("home snapshot loads seven-day Claude history for a Fable-only activity limit", async () => {
  const claudeProvider = providerFixture("claude", "Claude Code");
  const entry = { id: "claude:fable-history", provider: "claude", source: "Claude Code", title: "Fable history", project: "repo-fable", updatedAt: "2026-08-20T13:00:00.000Z", isLive: false, needsInput: false };
  const usageSnapshots = [{
    dedupeId: "fable-request",
    actorId: "primary",
    timestamp: "2026-08-20T13:00:00.000Z",
    input: 100,
    output: 20,
    cacheWrite: 0,
    cacheRead: 0,
    model: "claude-fable-4",
  }];
  const state = await runtimeFixture([entry], new Map([[entry.id, evidence({
    project: "repo-fable",
    startedAt: "2026-08-20T12:30:00.000Z",
    updatedAt: "2026-08-20T13:00:00.000Z",
    agents: [agent("primary", "finished")],
    usageSnapshots,
  })]]), {
    registry: {
      defaultProvider: claudeProvider,
      providers: [claudeProvider],
      async readUsageLimits() {
        return { available: true, fetchedAt: "2026-08-23T12:00:00.000Z", attemptedAt: "2026-08-23T12:00:00.000Z", limits: [
          { id: "model-fable", label: "Fable", window: "7 days", percent: 19, resetsAt: "2026-08-27T12:00:00.000Z", severity: "normal", active: false },
        ], error: "" };
      },
      async readSession() {
        return { evidence: evidence({ project: "repo-fable", startedAt: "2026-08-20T12:30:00.000Z", updatedAt: "2026-08-20T13:00:00.000Z", agents: [agent("primary", "finished")], usageSnapshots }), provider: claudeProvider, sessionId: entry.id };
      },
    },
  }).homeSnapshot();

  assert.equal(state.limitActivities.length, 1);
  assert.equal(state.limitActivities[0].limitId, "model-fable");
  assert.equal(state.limitActivities[0].scope, "model");
  assert.deepEqual(state.limitActivities[0].sessions.map(({ project }) => project), ["repo-fable"]);
  assert.doesNotMatch(JSON.stringify(state), /claude-fable|requestModelObservations/i);
});

test("home limit activity marks failed live request evidence as truncated", async () => {
  const claudeProvider = providerFixture("claude", "Claude Code");
  const entry = { id: "claude:failed", provider: "claude", source: "Claude Code", title: "Failed live session", project: "repo", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false };
  const state = await runtimeFixture([entry], new Map([[entry.id, new Error("PRIVATE_FAILURE")]]), {
    registry: {
      defaultProvider: claudeProvider,
      providers: [claudeProvider],
      async readUsageLimits() {
        return { available: true, fetchedAt: "2026-08-23T12:00:00.000Z", attemptedAt: "2026-08-23T12:00:00.000Z", limits: [{ id: "current-session", label: "Current session", window: "5h", percent: 42, resetsAt: "2026-08-23T17:00:00.000Z", severity: "normal", active: true }], error: "" };
      },
    },
  }).homeSnapshot();

  assert.equal(state.limitActivities.length, 1);
  assert.equal(state.limitActivities[0].eventsTruncated, true);
  assert.equal(state.projects[0].sessions[0].latestContextTotal, null);
  assert.equal(state.projects[0].sessions[0].requestObservationsAvailable, undefined);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_FAILURE/);
});

test("home snapshot keeps only live projects and bounds seven-day history", async () => {
  const entries = [
    { id: "codex:live", provider: "codex", source: "Codex", title: "Live", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false },
    { id: "codex:old", provider: "codex", source: "Codex", title: "Old", project: "pomegr", updatedAt: "2026-08-10T11:59:00.000Z", isLive: false, needsInput: false },
    { id: "codex:history", provider: "codex", source: "Codex", title: "History", project: "pomegr", updatedAt: "2026-08-22T11:59:00.000Z", isLive: false, needsInput: false },
    { id: "codex:only-history", provider: "codex", source: "Codex", title: "Only history", project: "other", updatedAt: "2026-08-22T11:59:00.000Z", isLive: false, needsInput: false },
  ];
  const snapshots = [{ dedupeId: "a", actorId: "primary", timestamp: "2026-08-23T11:30:00.000Z", input: 100, output: 20, cacheWrite: 0, cacheRead: 0 }];
  const state = await runtimeFixture(entries, new Map([
    ["codex:live", evidence({ agents: [agent("primary")], usageSnapshots: snapshots })],
    ["codex:history", evidence({ updatedAt: "2026-08-22T11:59:00.000Z", agents: [agent("primary", "finished")], usageSnapshots: [{ ...snapshots[0], timestamp: "2026-08-22T11:00:00.000Z", input: 50 }] })],
  ])).homeSnapshot();
  assert.deepEqual(state.projects.map((project) => project.project), ["pomegr"]);
  assert.equal(state.projects[0].history.windowDays, 7);
  assert.equal(state.projects[0].history.completed, 1);
  assert.deepEqual(state.projects[0].history.finalContexts, [{ endedAt: "2026-08-22T11:59:00.000Z", total: 70 }]);
  assert.equal(state.projects[0].sessions[0].latestContextTotal, 120);
});

test("home latest context uses latest non-zero total per visible agent and safe resources", async () => {
  const entries = [{ id: "codex:live", provider: "codex", source: "Codex", title: "Live", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false }];
  const snapshots = [
    { dedupeId: "zero", actorId: "primary", timestamp: "2026-08-23T11:10:00.000Z", input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    { dedupeId: "latest", actorId: "primary", timestamp: "2026-08-23T11:20:00.000Z", input: 7, output: 3, cacheWrite: 0, cacheRead: 0 },
    { dedupeId: "hidden", actorId: "private", timestamp: "2026-08-23T11:30:00.000Z", input: 900, output: 0, cacheWrite: 0, cacheRead: 0 },
  ];
  let sampled = 0;
  const resources = { status: "ready", reason: null, current: { cpuCores: 1, cpuMachinePercent: 2, memoryBytes: 3, readBytesPerSecond: 4, writeBytesPerSecond: 5, pid: 99 }, observedPeak: { memoryBytes: 8, processStartIdentity: "PRIVATE" }, samples: [{ timestamp: "2026-08-23T11:59:00.000Z", cpuCores: 1, cpuMachinePercent: 2, memoryBytes: 3, readBytesPerSecond: 4, writeBytesPerSecond: 5, command: "PRIVATE" }] };
  const state = await runtimeFixture(entries, new Map([["codex:live", evidence({ agents: [agent("primary")], usageSnapshots: snapshots })]]), { resourceTargets: [{ sessionId: "codex:live", pid: 99, processStartIdentity: "PRIVATE" }], resourceUsageSampler: { async sample(targets) { sampled += targets.length; }, get() { return resources; } } }).homeSnapshot();
  assert.equal(sampled, 1);
  assert.equal(state.projects[0].sessions[0].latestContextTotal, 10);
  assert.equal(state.projects[0].sessions[0].resources.current.pid, undefined);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE|command|processStartIdentity|"pid"/i);
});

test("home live session exposes only bounded normalized progress", async () => {
  const entry = { id: "codex:progress", provider: "codex", source: "Codex", title: "Progress", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false };
  const progress = { phase: "implementing", percent: 42, remainingMinutesMin: 8, remainingMinutesMax: 14, confidence: "medium", reportedAt: "2026-08-23T11:45:00.000Z" };
  const state = await runtimeFixture([entry], new Map([[entry.id, evidence({ agents: [agent("primary")], progress, progressPrivate: "PRIVATE_PROGRESS_INPUT" })]])).homeSnapshot();
  assert.deepEqual(state.projects[0].sessions[0].progress, progress);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_PROGRESS_INPUT|progressPrivate/i);
});

test("session feed returns the catalog with bounded live summaries and refreshes progress", async () => {
  let entry = { id: "codex:feed", provider: "codex", source: "Codex", title: "Feed", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false, activityStatus: "working" };
  const evidenceById = new Map();
  const runtime = runtimeFixture([], evidenceById, {
    homeSummaryCacheMs: 60_000,
    resourceTargets: [{ sessionId: entry.id, pid: 99, processStartIdentity: "PRIVATE_FEED_RESOURCE" }],
    resourceUsageSampler: {
      async sample() {},
      get() {
        return { status: "ready", current: { pid: 99, command: "PRIVATE_FEED_RESOURCE" } };
      },
    },
    registry: {
      async inspectSessions() { return { sessions: [entry], resourceTargets: [{ sessionId: entry.id, pid: 99, processStartIdentity: "PRIVATE_FEED_RESOURCE" }] }; },
    },
  });

  const cold = await runtime.sessionFeed();
  assert.deepEqual(cold.sessions, [entry]);
  assert.deepEqual(cold.liveSessions, [{
    id: entry.id,
    provider: "codex",
    source: "Codex",
    title: "Feed",
    project: "pomegr",
    updatedAt: entry.updatedAt,
    isLive: true,
    needsInput: false,
    activityStatus: "working",
    agentCount: null,
    activeAgentCount: null,
    latestContextTotal: null,
    progress: null,
  }]);

  const progress = { phase: "verifying", percent: 70, remainingMinutesMin: 2, remainingMinutesMax: 5, confidence: "high", reportedAt: "2026-08-23T12:00:00.000Z" };
  entry = { ...entry, updatedAt: "2026-08-23T12:00:00.000Z" };
  const changedEvidence = evidence({ updatedAt: entry.updatedAt, agents: [agent("primary"), agent("helper", "idle")], progress, progressPrivate: "PRIVATE_FEED_PROGRESS" });
  changedEvidence.contextHistory = { private: "PRIVATE_FEED_CONTEXT" };
  changedEvidence.resources = { command: "PRIVATE_FEED_RESOURCE" };
  evidenceById.set(entry.id, changedEvidence);

  const changed = await runtime.sessionFeed();
  assert.deepEqual(changed.liveSessions[0].progress, progress);
  assert.equal(changed.liveSessions[0].agentCount, 2);
  assert.equal(changed.liveSessions[0].activeAgentCount, 1);
  assert.equal(Object.hasOwn(changed.liveSessions[0], "contextHistory"), false);
  assert.equal(Object.hasOwn(changed.liveSessions[0], "resources"), false);
  assert.deepEqual(Object.keys(changed.liveSessions[0]).sort(), [
    "activeAgentCount", "activityStatus", "agentCount", "id", "isLive", "latestContextTotal", "needsInput", "progress", "project", "provider", "source", "title", "updatedAt",
  ]);
  assert.doesNotMatch(JSON.stringify(changed), /PRIVATE_FEED_(?:CONTEXT|PROGRESS|RESOURCE)|contextHistory|resources/i);
});

test("session feed and home snapshot coalesce a cold live summary without sharing resource telemetry", async () => {
  const entry = { id: "codex:coalesced", provider: "codex", source: "Codex", title: "Coalesced", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false, activityStatus: "working" };
  let readCalls = 0;
  let releaseRead;
  const readReady = new Promise((resolve) => { releaseRead = resolve; });
  const runtime = runtimeFixture([entry], new Map([[entry.id, evidence({ agents: [agent("primary")] })]]), {
    homeSummaryCacheMs: 60_000,
    resourceTargets: [{ sessionId: entry.id, pid: 42, processStartIdentity: "PRIVATE_COALESCED_RESOURCE" }],
    resourceUsageSampler: {
      async sample() {},
      get() {
        return {
          status: "ready",
          reason: null,
          current: { cpuCores: 1, cpuMachinePercent: 2, memoryBytes: 3, readBytesPerSecond: 4, writeBytesPerSecond: 5 },
          observedPeak: { memoryBytes: 8 },
          samples: [],
        };
      },
    },
    registry: {
      async readSession() {
        readCalls += 1;
        await readReady;
        return { evidence: evidence({ agents: [agent("primary")] }), provider, sessionId: entry.id };
      },
    },
  });

  const feed = runtime.sessionFeed();
  await new Promise((resolve) => setImmediate(resolve));
  const home = runtime.homeSnapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readCalls, 1);
  releaseRead();
  const [feedSnapshot, homeSnapshot] = await Promise.all([feed, home]);

  assert.equal(feedSnapshot.liveSessions[0].agentCount, 1);
  assert.equal(Object.hasOwn(feedSnapshot.liveSessions[0], "resources"), false);
  assert.equal(homeSnapshot.projects[0].sessions[0].resources.current.memoryBytes, 3);
  assert.doesNotMatch(JSON.stringify({ feedSnapshot, homeSnapshot }), /PRIVATE_COALESCED_RESOURCE|processStartIdentity|"pid"/i);
});

test("failed live evidence keeps a live card with null metrics", async () => {
  const entry = { id: "codex:failed", provider: "codex", source: "Codex", title: "Failed", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: true };
  const state = await runtimeFixture([entry], new Map([[entry.id, new Error("PROMPT_RESPONSE_COMMAND_CREDENTIAL")]])).homeSnapshot();
  const session = state.projects[0].sessions[0];
  assert.equal(session.needsInput, true);
  assert.equal(session.agentCount, null);
  assert.equal(session.activeAgentCount, null);
  assert.equal(session.latestContextTotal, null);
  assert.equal(session.contextHistory, null);
});

test("missing live evidence keeps a live card with null metrics", async () => {
  const entry = { id: "codex:missing", provider: "codex", source: "Codex", title: "Missing", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false };
  const state = await runtimeFixture([entry], new Map(), { registry: { async readSession() { return null; } } }).homeSnapshot();
  assert.equal(state.projects[0].sessions.length, 1);
  assert.equal(state.projects[0].sessions[0].id, entry.id);
  assert.equal(state.projects[0].sessions[0].latestContextTotal, null);
});

test("seven-day history verifies the recorded session timestamp", async () => {
  const entries = [
    { id: "codex:live", provider: "codex", source: "Codex", title: "Live", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false },
    { id: "codex:mismatch", provider: "codex", source: "Codex", title: "Mismatch", project: "pomegr", updatedAt: "2026-08-22T11:59:00.000Z", isLive: false, needsInput: false },
  ];
  const state = await runtimeFixture(entries, new Map([
    ["codex:live", evidence()],
    ["codex:mismatch", evidence({ updatedAt: "2026-08-15T11:59:00.000Z" })],
  ])).homeSnapshot();
  assert.equal(state.projects[0].history.completed, 0);
  assert.deepEqual(state.projects[0].history.finalContexts, []);
});

test("seven-day history includes recent recorded evidence despite a stale catalog timestamp", async () => {
  const entries = [
    { id: "codex:live", provider: "codex", source: "Codex", title: "Live", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false },
    { id: "codex:stale-catalog", provider: "codex", source: "Codex", title: "Stale catalog", project: "pomegr", updatedAt: "2026-08-10T11:59:00.000Z", isLive: false, needsInput: false },
  ];
  const state = await runtimeFixture(entries, new Map([
    ["codex:live", evidence()],
    ["codex:stale-catalog", evidence({ updatedAt: "2026-08-22T11:59:00.000Z" })],
  ])).homeSnapshot();
  assert.equal(state.projects[0].history.completed, 1);
});

test("home snapshot coalesces concurrent builds and reuses the completed snapshot", async () => {
  const entry = { id: "codex:live", provider: "codex", source: "Codex", title: "Live", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false };
  let inspectCalls = 0;
  let readCalls = 0;
  let releaseInspect;
  const inspectReady = new Promise((resolve) => { releaseInspect = resolve; });
  const runtime = runtimeFixture([entry], new Map([[entry.id, evidence()]]), {
    homeSnapshotCacheMs: 10_000,
    registry: {
      async inspectSessions() {
        inspectCalls += 1;
        await inspectReady;
        return { sessions: [entry], resourceTargets: [] };
      },
      async readSession() {
        readCalls += 1;
        return { evidence: evidence(), provider, sessionId: entry.id };
      },
    },
  });

  const first = runtime.homeSnapshot();
  const concurrent = runtime.homeSnapshot();
  await Promise.resolve();
  assert.equal(inspectCalls, 1);
  releaseInspect();
  const [firstSnapshot, concurrentSnapshot] = await Promise.all([first, concurrent]);
  const cachedSnapshot = await runtime.homeSnapshot();

  assert.equal(readCalls, 1);
  assert.equal(inspectCalls, 1);
  assert.strictEqual(concurrentSnapshot, firstSnapshot);
  assert.strictEqual(cachedSnapshot, firstSnapshot);
});

test("home snapshot keeps recorded history summaries across live refreshes", async () => {
  const entries = [
    { id: "codex:live", provider: "codex", source: "Codex", title: "Live", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false },
    { id: "codex:history", provider: "codex", source: "Codex", title: "History", project: "pomegr", updatedAt: "2026-08-22T11:59:00.000Z", isLive: false, needsInput: false },
  ];
  let currentTime = Date.parse("2026-08-23T12:00:00.000Z");
  const reads = new Map();
  const evidenceById = new Map([
    ["codex:live", evidence()],
    ["codex:history", evidence({ updatedAt: "2026-08-22T11:59:00.000Z" })],
  ]);
  const runtime = runtimeFixture(entries, evidenceById, {
    now: () => currentTime,
    homeSummaryCacheMs: 0,
    homeHistorySummaryCacheMs: 60_000,
    registry: {
      async readSession(id) {
        reads.set(id, (reads.get(id) || 0) + 1);
        return { evidence: evidenceById.get(id), provider, sessionId: id };
      },
    },
  });

  await runtime.homeSnapshot();
  currentTime += 5_000;
  await runtime.homeSnapshot();

  assert.equal(reads.get("codex:live"), 2);
  assert.equal(reads.get("codex:history"), 1);
});

test("cold home snapshot defers history reads and publishes them after background warmup", async () => {
  const entries = [
    { id: "codex:live", provider: "codex", source: "Codex", title: "Live", project: "pomegr", updatedAt: "2026-08-23T11:59:00.000Z", isLive: true, needsInput: false },
    { id: "codex:history", provider: "codex", source: "Codex", title: "History", project: "pomegr", updatedAt: "2026-08-22T11:59:00.000Z", isLive: false, needsInput: false },
  ];
  const reads = [];
  let scheduledRefresh = null;
  let yields = 0;
  const evidenceById = new Map([
    ["codex:live", evidence()],
    ["codex:history", evidence({ updatedAt: "2026-08-22T11:59:00.000Z" })],
  ]);
  const runtime = runtimeFixture(entries, evidenceById, {
    deferHomeHistory: true,
    homeHistorySummaryCacheMs: 60_000,
    scheduleHomeRefresh(task) { scheduledRefresh = task; },
    async yieldHomeHistory() { yields += 1; },
    registry: {
      async readSession(id) {
        reads.push(id);
        return { evidence: evidenceById.get(id), provider, sessionId: id };
      },
    },
  });

  const cold = await runtime.homeSnapshot();
  assert.deepEqual(reads, ["codex:live"]);
  assert.equal(cold.projects[0].history.status, "loading");
  assert.equal(typeof scheduledRefresh, "function");

  await scheduledRefresh();
  const warmed = await runtime.homeSnapshot();
  assert.deepEqual(reads, ["codex:live", "codex:history", "codex:live"]);
  assert.equal(yields, 1);
  assert.equal(warmed.projects[0].history.status, "ready");
  assert.equal(warmed.projects[0].history.completed, 1);
});

test("expired home snapshots return before deferred refresh work starts", async () => {
  let currentTime = Date.parse("2026-08-23T12:00:00.000Z");
  let title = "First";
  let inspectCalls = 0;
  let scheduledRefresh = null;
  const entry = () => ({ id: "codex:live", provider: "codex", source: "Codex", title, project: "pomegr", updatedAt: new Date(currentTime).toISOString(), isLive: true, needsInput: false });
  const runtime = runtimeFixture([], new Map(), {
    now: () => currentTime,
    homeSnapshotCacheMs: 1_000,
    scheduleHomeRefresh(task) { scheduledRefresh = task; },
    registry: {
      async inspectSessions() {
        inspectCalls += 1;
        return { sessions: [entry()], resourceTargets: [] };
      },
      async readSession(id) {
        return { evidence: evidence(), provider, sessionId: id };
      },
    },
  });

  await runtime.homeSnapshot();
  currentTime += 1_001;
  title = "Second";
  const stale = await runtime.homeSnapshot();

  assert.equal(stale.projects[0].sessions[0].title, "First");
  assert.equal(inspectCalls, 1);
  assert.equal(typeof scheduledRefresh, "function");

  await scheduledRefresh();
  const refreshed = await runtime.homeSnapshot();
  assert.equal(inspectCalls, 2);
  assert.equal(refreshed.projects[0].sessions[0].title, "Second");
});

test("home handler sanitizes monitor failure", async () => {
  const server = createMonitorServer({ providerRegistry: { defaultProvider: provider, async inspectSessions() { throw new Error("PROMPT RESPONSE COMMAND CREDENTIAL"); } } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/home`);
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(body), { generatedAt: null, providerLimits: [], limitActivities: [], projects: [], error: "Home snapshot error" });
    assert.doesNotMatch(body, /PROMPT|RESPONSE|COMMAND|CREDENTIAL/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
