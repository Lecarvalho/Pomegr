import assert from "node:assert/strict";
import test from "node:test";
import { createMonitorRuntime, createMonitorServer } from "../monitor/server.mjs";
import { createEmptyProviderCapabilities } from "../shared/monitor-state.mjs";

const provider = { source: "Codex", capabilities: createEmptyProviderCapabilities() };

function evidence({ project = "pomegr", updatedAt = "2026-08-23T12:00:00.000Z", agents = [], usageSnapshots = [] } = {}) {
  return {
    historical: false,
    session: { title: "Home fixture", project, cwd: "C:\\synthetic\\pomegr", startedAt: "2026-08-23T11:00:00.000Z", updatedAt, recordedGitBranch: "main", cost: null, approvalMode: null, contextMachinery: null, summary: null, signal: null },
    agents, usageSnapshots, toolCalls: [], activity: [], planTasks: [], compactions: [],
    efficiencyRuleEvidence: { repetition: true, concurrentMutation: true, unsharedContext: true, healthyFallback: true },
    pullRequestCreations: [],
  };
}

function agent(id, status = "active") {
  return { id, parentId: null, label: id, kind: "orchestrator", model: "test", effort: null, status, signal: null, toolCalls: 0, skills: [], executionTasks: [], lastSeen: "2026-08-23T12:00:00.000Z", startedAt: "2026-08-23T11:00:00.000Z", updatedAt: "2026-08-23T12:00:00.000Z", durationMs: 3600000 };
}

function runtimeFixture(entries, evidenceById, options = {}) {
  const registry = {
    defaultProvider: provider,
    async inspectSessions() { return { sessions: entries, resourceTargets: options.resourceTargets || [] }; },
    async readSession(id) { const value = evidenceById.get(id); if (value instanceof Error) throw value; return { evidence: value, provider, sessionId: id }; },
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
    { id: "claude", source: "Claude Code" },
    { id: "codex", source: "Codex" },
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
    assert.deepEqual(JSON.parse(body), { generatedAt: null, providerLimits: [], projects: [], error: "Home snapshot error" });
    assert.doesNotMatch(body, /PROMPT|RESPONSE|COMMAND|CREDENTIAL/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
