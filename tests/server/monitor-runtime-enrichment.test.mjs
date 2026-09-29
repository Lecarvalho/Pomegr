import assert from "node:assert/strict";
import test from "node:test";
import { createMonitorRuntime } from "../../server/server.mjs";
import { createSessionRepositoryEnrichment, liveRepositoryReadiness } from "../../server/repository/session-repository-enrichment.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../../shared/monitor-state.mjs";

const provider = Object.freeze({
  source: "Codex",
  capabilities: createEmptyProviderCapabilities(),
});

function sessionEvidence({
  historical = false,
  branch = "codex/live",
  cwd = "C:\\synthetic\\pomegr",
  pullRequestCreations = [],
} = {}) {
  return {
    historical,
    session: {
      title: "Runtime enrichment fixture",
      project: "pomegr",
      cwd,
      startedAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:01.000Z",
      recordedGitBranch: branch,
      cost: null,
      approvalMode: null,
      contextMachinery: null,
      summary: null,
      signal: null,
    },
    agents: [{
      id: "primary",
      parentId: null,
      label: "Primary agent",
      kind: "orchestrator",
      model: "gpt-test",
      effort: null,
      status: "idle",
      signal: null,
      toolCalls: 0,
      skills: [],
      executionTasks: [],
      lastSeen: "2026-08-11T12:00:01.000Z",
      startedAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:01.000Z",
      durationMs: 1_000,
    }],
    usageSnapshots: [],
    toolCalls: [],
    activity: [],
    planTasks: [],
    compactions: [],
    efficiencyRuleEvidence: {
      repetition: true,
      concurrentMutation: true,
      unsharedContext: true,
      healthyFallback: true,
    },
    pullRequestCreations,
  };
}

function repository(branch, root = "C:\\synthetic\\pomegr") {
  return {
    available: true,
    branch,
    files: [],
    isMain: false,
    comparison: null,
    commits: [],
    remote: { status: "ready", checkedAt: null },
    _repositoryRoot: root,
  };
}

function pullRequests(branch) {
  return { status: "ready", checkedAt: null, items: [{ headBranch: branch }] };
}

function runtimeFixture(options = {}) {
  const evidence = options.evidence || sessionEvidence();
  const readEvidence = options.readEvidence || (() => evidence);
  const usageReader = options.readUsageLimits || (() => createEmptyUsageLimits());
  const normalizedSessionId = options.normalizedSessionId || "codex:normalized-session";
  const selectedProvider = options.provider || provider;
  const registry = {
    defaultProvider: selectedProvider,
    async readSession() {
      const currentEvidence = readEvidence();
      const repositoryAttribution = typeof options.repositoryAttributionForSession === "function"
        ? options.repositoryAttributionForSession(currentEvidence)
        : Object.hasOwn(options, "repositoryAttribution") ? options.repositoryAttribution
          : { state: "single", repositoryId: "repo-0123456789abcdef01234567", root: currentEvidence.session.cwd, fingerprint: `bound:${currentEvidence.session.cwd}`, recordedBranch: currentEvidence.session.recordedGitBranch };
      return { evidence: currentEvidence, provider: selectedProvider, sessionId: normalizedSessionId, repositoryAttribution };
    },
    async readUsageLimits(...args) { return usageReader(...args); },
    async listSessions() { return []; },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    providerForSessionId() { return selectedProvider; },
    unavailableMessage() { return "Session unavailable"; },
    ...(options.resolveCapabilities ? { resolveCapabilities: options.resolveCapabilities } : {}),
  };
  return createMonitorRuntime({ ...options, providerRegistry: registry });
}

test("legacy Codex checkpoint labels name the project but cannot claim a repository before attribution", async () => {
  const evidence = sessionEvidence({ historical: true, branch: "feat/clapline" });
  evidence.session.project = "Clapline";
  const runtime = runtimeFixture({ evidence, provider: { ...provider, id: "codex" } });
  const state = await runtime.analyze("codex:legacy");
  // The launch directory names the project for every provider (approved 2026-09-27);
  // without a single-repository attribution no repository or branch is exposed.
  assert.equal(state.session.project, "Clapline");
  assert.equal(state.session.repository.available, false);
  assert.equal(JSON.stringify(state).includes("feat/clapline"), false);
  evidence.session.repositoryAttribution = "single";
  evidence.session.repositoryId = "repo-0123456789abcdef01234567";
  const bound = await runtime.analyze("codex:legacy");
  assert.equal(bound.session.project, "Clapline");
  assert.equal(bound.session.repository.branch, "feat/clapline");
});

test("state assembly uses resolved capabilities without mutating provider declarations", async () => {
  const declared = Object.freeze({
    ...createEmptyProviderCapabilities(),
    liveSessions: true,
    usageLimits: true,
  });
  const dynamicProvider = Object.freeze({ source: "Codex", capabilities: declared });
  let resolutionCalls = 0;
  const runtime = runtimeFixture({
    provider: dynamicProvider,
    async resolveCapabilities(received) {
      resolutionCalls += 1;
      assert.equal(received, dynamicProvider);
      return { ...declared, usageLimits: false };
    },
  });

  const state = await runtime.analyze("codex:live");
  assert.equal(state.capabilities.usageLimits, false);
  assert.equal(state.capabilities.liveSessions, true);
  assert.equal(declared.usageLimits, true);
  assert.equal(resolutionCalls, 1);
});

function controlledScheduler() {
  const jobs = [];
  return {
    jobs,
    scheduleEnrichment(task) { jobs.push(task); },
    async runNext() {
      const task = jobs.shift();
      assert.ok(task, "expected a scheduled enrichment job");
      await task();
    },
  };
}

test("cold live analysis returns placeholders before scheduled Git and pull-request enrichment", async () => {
  const scheduler = controlledScheduler();
  const calls = [];
  const runtime = runtimeFixture({
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState() { calls.push("git"); return repository("codex/live"); },
    async readPullRequests() { calls.push("pull-requests"); return pullRequests("codex/live"); },
  });

  const cold = await runtime.analyze("codex:any-alias");
  assert.equal(cold.session.repository.available, false);
  assert.equal(cold.session.repository.historical, false);
  assert.deepEqual(cold.session.pullRequests, { status: "unavailable", checkedAt: null, items: [] });
  assert.deepEqual(calls, []);
  assert.equal(scheduler.jobs.length, 1);

  await scheduler.runNext();
  assert.deepEqual(calls, ["git", "pull-requests"]);
  const enriched = await runtime.analyze("codex:any-alias");
  assert.equal(enriched.session.repository.branch, "codex/live");
  assert.equal(enriched.session.pullRequests.status, "ready");
  assert.equal(scheduler.jobs.length, 0);
});

test("a live session without one proven repository binding never reads a shared checkout", async () => {
  const scheduler = controlledScheduler();
  let gitCalls = 0;
  let pullRequestCalls = 0;
  const evidence = sessionEvidence();
  const runtime = runtimeFixture({
    evidence,
    repositoryAttribution: { state: "multiple" },
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState() { gitCalls += 1; return repository("codex/other"); },
    async readPullRequests() { pullRequestCalls += 1; return pullRequests("codex/other"); },
  });

  await runtime.analyze();
  await scheduler.runNext();
  const state = await runtime.analyze();
  assert.equal(gitCalls, 0);
  assert.equal(pullRequestCalls, 0);
  assert.equal(state.session.repository.available, false);
  assert.equal(state.session.pullRequests.status, "unavailable");
});

test("Claude retains branch-qualified cwd enrichment when no mutation-root binding exists", async () => {
  const scheduler = controlledScheduler();
  const runtime = runtimeFixture({
    normalizedSessionId: "claude:legacy-session",
    evidence: sessionEvidence({ cwd: "C:\\work\\Pomegr\\nested", branch: "claude/pomegr" }),
    repositoryAttribution: null,
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState(cwd) {
      assert.equal(cwd, "C:\\work\\Pomegr\\nested");
      return repository("claude/pomegr", "C:\\work\\Pomegr");
    },
    async readPullRequests() { return pullRequests("claude/pomegr"); },
  });

  await runtime.analyze();
  await scheduler.runNext();
  assert.equal((await runtime.analyze()).session.repository.branch, "claude/pomegr");
});

test("root or branch mismatches use a bounded retry cooldown", async () => {
  const scheduler = controlledScheduler();
  let clock = 0;
  let gitCalls = 0;
  const runtime = runtimeFixture({
    now: () => clock,
    enrichmentCacheMs: 0,
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState(root) { gitCalls += 1; return repository("codex/other", root); },
    async readPullRequests() { assert.fail("mismatch must not query pull requests"); },
  });
  await runtime.analyze();
  await scheduler.runNext();
  await runtime.analyze();
  await runtime.analyze();
  assert.equal(gitCalls, 1);
  assert.equal(scheduler.jobs.length, 0);
  clock = 2_500;
  await runtime.analyze();
  assert.equal(scheduler.jobs.length, 1);
});

test("a bound Pomegr session rejects a Clapline root or branch and does not start pull-request enrichment", async () => {
  const scheduler = controlledScheduler();
  const calls = [];
  const runtime = runtimeFixture({
    evidence: sessionEvidence({
      cwd: "C:\\work\\Pomegr",
      branch: "codex/pomegr",
    }),
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState(root) {
      calls.push(["git", root]);
      return repository("codex/clapline", "C:\\work\\Clapline");
    },
    async readPullRequests() { calls.push(["pull-requests"]); return pullRequests("codex/clapline"); },
  });

  await runtime.analyze();
  await scheduler.runNext();
  const state = await runtime.analyze();
  assert.deepEqual(calls, [["git", "C:\\work\\Pomegr"]]);
  assert.equal(state.session.repository.available, false);
  assert.equal(state.session.pullRequests.status, "unavailable");
});

test("a shared Clapline checkout branch switch retains Pomegr's last known-good session value", async () => {
  const scheduler = controlledScheduler();
  let clock = 0;
  let branch = "codex/pomegr";
  const evidence = sessionEvidence({ cwd: "C:\\work\\shared\\Clapline", branch: "codex/pomegr" });
  const runtime = runtimeFixture({
    evidence,
    now: () => clock,
    enrichmentCacheMs: 1,
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState(root) { return repository(branch, root); },
    async readPullRequests() { return pullRequests(branch); },
  });

  await runtime.analyze();
  await scheduler.runNext();
  assert.equal((await runtime.analyze()).session.repository.branch, "codex/pomegr");
  clock = 2;
  branch = "codex/clapline";
  await runtime.analyze();
  await scheduler.runNext();
  const afterSwitch = await runtime.analyze();
  assert.equal(afterSwitch.session.repository.branch, "codex/pomegr");
  assert.equal(afterSwitch.session.pullRequests.items[0].headBranch, "codex/pomegr");
});

test("pending asynchronous Git does not block analysis or start pull-request enrichment early", async () => {
  const scheduler = controlledScheduler();
  const events = [];
  let resolveGit;
  const pendingGit = new Promise((resolve) => { resolveGit = resolve; });
  const runtime = runtimeFixture({
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState() { events.push("git"); return pendingGit; },
    async readPullRequests() { events.push("pull-requests"); return pullRequests("codex/live"); },
  });

  const cold = await runtime.analyze();
  assert.equal(cold.session.repository.available, false);
  const work = scheduler.jobs.shift()();
  await Promise.resolve();
  assert.deepEqual(events, ["git"]);

  const whileGitPending = await runtime.analyze();
  assert.equal(whileGitPending.session.repository.available, false);
  assert.equal(scheduler.jobs.length, 0);
  assert.deepEqual(events, ["git"]);

  resolveGit(repository("codex/live"));
  await work;
  assert.deepEqual(events, ["git", "pull-requests"]);
  assert.equal((await runtime.analyze()).session.repository.branch, "codex/live");
});

test("live enrichment is not scheduled until awaited response data is ready", async () => {
  const scheduler = controlledScheduler();
  const events = [];
  let resolveUsage;
  const usage = new Promise((resolve) => { resolveUsage = resolve; });
  const runtime = runtimeFixture({
    scheduleEnrichment(task) { events.push("scheduled"); scheduler.scheduleEnrichment(task); },
    readUsageLimits() { events.push("usage-started"); return usage; },
    readGitState() { events.push("sync-git"); return repository("codex/live"); },
    async readPullRequests() { return pullRequests("codex/live"); },
  });

  const pendingState = runtime.analyze();
  await Promise.resolve();
  assert.deepEqual(events, ["usage-started"]);
  assert.equal(scheduler.jobs.length, 0);

  resolveUsage(createEmptyUsageLimits());
  const state = await pendingState;
  assert.equal(state.session.repository.available, false);
  assert.deepEqual(events, ["usage-started", "scheduled"]);
  assert.equal(scheduler.jobs.length, 1);

  await scheduler.runNext();
  assert.deepEqual(events, ["usage-started", "scheduled", "sync-git"]);
});

test("concurrent aliases coalesce enrichment by normalized session ID", async () => {
  const scheduler = controlledScheduler();
  let gitCalls = 0;
  const runtime = runtimeFixture({
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState() { gitCalls += 1; return repository("codex/live"); },
    async readPullRequests() { return pullRequests("codex/live"); },
  });

  await Promise.all([
    runtime.analyze("codex:first-alias"),
    runtime.analyze("codex:second-alias"),
  ]);
  assert.equal(scheduler.jobs.length, 1);
  await scheduler.runNext();
  assert.equal(gitCalls, 1);
});

test("expired enrichment serves stale data while one refresh runs", async () => {
  const scheduler = controlledScheduler();
  let clock = 0;
  const runtime = runtimeFixture({
    now: () => clock,
    enrichmentCacheMs: 10,
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState() { return repository("codex/live"); },
    async readPullRequests() { return pullRequests("codex/live"); },
  });

  await runtime.analyze();
  await scheduler.runNext();
  assert.equal((await runtime.analyze()).session.repository.branch, "codex/live");

  clock = 11;
  const [firstStale, secondStale] = await Promise.all([runtime.analyze(), runtime.analyze()]);
  assert.equal(firstStale.session.repository.branch, "codex/live");
  assert.equal(secondStale.session.pullRequests.items[0].headBranch, "codex/live");
  assert.equal(scheduler.jobs.length, 1);

  await scheduler.runNext();
  const refreshed = await runtime.analyze();
  assert.equal(refreshed.session.repository.branch, "codex/live");
  assert.equal(refreshed.session.pullRequests.items[0].headBranch, "codex/live");
});

test("changed enrichment inputs invalidate stale data and reject older in-flight completion", async () => {
  const scheduler = controlledScheduler();
  let currentEvidence = sessionEvidence({
    cwd: "C:\\synthetic\\old",
    branch: "codex/old",
    pullRequestCreations: [{ url: "https://example.test/old" }],
  });
  let resolveOldPullRequests;
  const oldPullRequests = new Promise((resolve) => { resolveOldPullRequests = resolve; });
  const observedInputs = [];
  const runtime = runtimeFixture({
    readEvidence: () => currentEvidence,
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState(cwd) { return repository(cwd.endsWith("old") ? "codex/old" : "codex/new", cwd); },
    async readPullRequests(_records, options) {
      observedInputs.push(options);
      if (options.cwd.endsWith("old")) return oldPullRequests;
      return pullRequests(options.branch);
    },
  });

  await runtime.analyze();
  const oldWork = scheduler.jobs.shift()();
  await Promise.resolve();
  currentEvidence = sessionEvidence({
    cwd: "C:\\synthetic\\new",
    branch: "codex/new",
    pullRequestCreations: [{ url: "https://example.test/new" }],
  });

  const invalidated = await runtime.analyze();
  assert.equal(invalidated.session.repository.available, false);
  assert.equal(scheduler.jobs.length, 1);
  await scheduler.runNext();
  assert.equal((await runtime.analyze()).session.repository.branch, "codex/new");

  resolveOldPullRequests(pullRequests("codex/old"));
  await oldWork;
  const afterOldCompletion = await runtime.analyze();
  assert.equal(afterOldCompletion.session.repository.branch, "codex/new");
  assert.equal(afterOldCompletion.session.pullRequests.items[0].headBranch, "codex/new");
  assert.deepEqual(observedInputs.map(({ cwd, sessionCreations }) => ({ cwd, sessionCreations })), [
    { cwd: "C:\\synthetic\\old", sessionCreations: [{ url: "https://example.test/old" }] },
    { cwd: "C:\\synthetic\\new", sessionCreations: [{ url: "https://example.test/new" }] },
  ]);
});

test("background enrichment failures produce only sanitized unavailable shapes", async () => {
  const scheduler = controlledScheduler();
  const runtime = runtimeFixture({
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
    async readPullRequests() { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK"); },
  });

  await runtime.analyze();
  await scheduler.runNext();
  const state = await runtime.analyze();
  assert.deepEqual(state.session.repository, {
    available: false,
    branch: "Not a Git repository",
    files: [],
    isMain: false,
    comparison: null,
    commits: [],
    remote: { status: "unavailable", checkedAt: null },
    historical: false,
  });
  assert.deepEqual(state.session.pullRequests, { status: "unavailable", checkedAt: null, items: [] });
  assert.doesNotMatch(JSON.stringify(state), /MUST_NOT_LEAK/);
});

test("unexpected scheduled rejection is explicitly sunk and leaves a retryable placeholder", async () => {
  const scheduler = controlledScheduler();
  let nowCalls = 0;
  const runtime = runtimeFixture({
    now() {
      nowCalls += 1;
      if (nowCalls === 1) throw new Error("UNEXPECTED_BACKGROUND_FAILURE_MUST_NOT_LEAK");
      return 0;
    },
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState() { return repository("codex/live"); },
    async readPullRequests() { return pullRequests("codex/live"); },
  });

  await runtime.analyze();
  await assert.doesNotReject(scheduler.runNext());
  const retry = await runtime.analyze();
  assert.equal(retry.session.repository.available, false);
  assert.equal(scheduler.jobs.length, 1);
  assert.doesNotMatch(JSON.stringify(retry), /MUST_NOT_LEAK/);
});

test("historical analysis with no snapshot shows only recorded Git and never queries the current checkout", async () => {
  const scheduler = controlledScheduler();
  const pullRequestOptions = [];
  const runtime = runtimeFixture({
    evidence: (() => {
      const evidence = sessionEvidence({ historical: true, branch: "codex/recorded-branch" });
      return { ...evidence, session: { ...evidence.session, repositoryAttribution: "single", repositoryId: "repo-0123456789abcdef01234567" } };
    })(),
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState() { assert.fail("historical analysis must not inspect current Git"); },
    async readPullRequests(_records, options) { pullRequestOptions.push(options); return pullRequests(options.branch); },
  });

  const state = await runtime.analyze("codex:historical");
  assert.equal(state.view, "history");
  assert.equal(state.session.repository.branch, "codex/recorded-branch");
  assert.equal(state.session.repository.historical, true);
  assert.equal(state.session.pullRequests.status, "unavailable");
  assert.equal(scheduler.jobs.length, 0);
  assert.equal(pullRequestOptions.length, 0);
});

test("session catalog samples private live targets and returns only sanitized catalog entries", async () => {
  const sessions = [{
    id: "codex:live",
    provider: "codex",
    source: "Codex",
    title: "Live",
    project: "pomegr",
    updatedAt: "2026-08-11T12:00:01.000Z",
    isLive: true,
    needsInput: false,
  }];
  const resourceTargets = [{
    sessionId: "codex:live",
    pid: 41,
    processStartIdentity: "private-start",
  }];
  const sampled = [];
  const runtime = createMonitorRuntime({
    providerRegistry: {
      defaultProvider: provider,
      async inspectSessions() { return { sessions, resourceTargets }; },
    },
    resourceUsageSampler: {
      async sample(targets) { sampled.push(targets); },
      get() { return null; },
    },
  });

  const catalog = await runtime.sessionCatalog();
  assert.deepEqual(catalog, sessions);
  assert.deepEqual(sampled, [resourceTargets]);
  assert.doesNotMatch(JSON.stringify(catalog), /private-start|processStartIdentity|"pid"|interval|cadence/i);
});

test("live analysis reads cached resource usage through a strict public allowlist", async () => {
  const cached = {
    status: "ready",
    reason: null,
    current: {
      cpuCores: 1.25,
      cpuMachinePercent: 15.625,
      memoryBytes: 2_048,
      readBytesPerSecond: 400,
      writeBytesPerSecond: 200,
      pid: 41,
    },
    observedPeak: { memoryBytes: 4_096, processStartIdentity: "private-start" },
    samples: [{
      timestamp: "2026-08-11T12:00:01.000Z",
      cpuCores: 1.25,
      cpuMachinePercent: 15.625,
      memoryBytes: 2_048,
      readBytesPerSecond: 400,
      writeBytesPerSecond: 200,
      command: "PRIVATE_COMMAND",
    }],
    intervalMs: 5_000,
  };
  let sampled = false;
  const runtime = runtimeFixture({
    resourceUsageSampler: {
      async sample() { sampled = true; },
      get(sessionId) {
        assert.equal(sessionId, "codex:normalized-session");
        return cached;
      },
    },
  });

  const state = await runtime.analyze("codex:live");
  assert.equal(sampled, false, "analysis reads the request-driven cache without sampling");
  assert.deepEqual(state.metrics.resources, {
    status: "ready",
    reason: null,
    current: {
      cpuCores: 1.25,
      cpuMachinePercent: 15.625,
      memoryBytes: 2_048,
      readBytesPerSecond: 400,
      writeBytesPerSecond: 200,
    },
    samples: [{
      timestamp: "2026-08-11T12:00:01.000Z",
      cpuCores: 1.25,
      cpuMachinePercent: 15.625,
      memoryBytes: 2_048,
      readBytesPerSecond: 400,
      writeBytesPerSecond: 200,
    }],
  });
  assert.doesNotMatch(JSON.stringify(state.metrics.resources), /PRIVATE|processStartIdentity|"pid"|interval|cadence/i);
});

test("resource sampler failures cannot break catalog, analysis, scoring, or enrichment", async () => {
  const scheduler = controlledScheduler();
  const sessions = [{ id: "codex:live", isLive: true }];
  const runtime = runtimeFixture({
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState() { return repository("codex/live"); },
    async readPullRequests() { return pullRequests("codex/live"); },
    resourceUsageSampler: {
      async sample() { throw new Error("PRIVATE_SAMPLER_FAILURE"); },
      get() { throw new Error("PRIVATE_CACHE_FAILURE"); },
    },
  });

  const catalogRuntime = createMonitorRuntime({
    providerRegistry: {
      defaultProvider: provider,
      async inspectSessions() {
        return {
          sessions,
          resourceTargets: [{ sessionId: "codex:live", pid: 41, processStartIdentity: "private-start" }],
        };
      },
    },
    resourceUsageSampler: {
      async sample() { throw new Error("PRIVATE_SAMPLER_FAILURE"); },
      get() { throw new Error("PRIVATE_CACHE_FAILURE"); },
    },
  });
  assert.deepEqual(await catalogRuntime.sessionCatalog(), sessions);

  const state = await runtime.analyze();
  assert.equal(state.score, 100);
  assert.deepEqual(state.metrics.resources, {
    status: "unavailable",
    reason: "collection_failed",
    current: null,
    samples: [],
  });
  assert.equal(scheduler.jobs.length, 1);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_SAMPLER|PRIVATE_CACHE/);
});

test("historical analysis never reads or exposes cached live resources", async () => {
  let gets = 0;
  const runtime = runtimeFixture({
    evidence: sessionEvidence({ historical: true }),
    async readPullRequests() { return pullRequests("codex/recorded"); },
    resourceUsageSampler: {
      async sample() {},
      get() { gets += 1; throw new Error("must not read historical resources"); },
    },
  });

  const state = await runtime.analyze("codex:historical");
  assert.equal(state.metrics.resources, null);
  assert.equal(gets, 0);
});

test("live repository readiness separates no binding, a pending check, and a confirmed answer", () => {
  assert.equal(liveRepositoryReadiness({ historical: true }), "ready");
  assert.equal(liveRepositoryReadiness({ available: true, check: "pending" }), "ready");
  assert.equal(liveRepositoryReadiness({ available: false, check: "none" }), "ready");
  assert.equal(liveRepositoryReadiness({ available: false, check: "pending" }), "loading");
  assert.equal(liveRepositoryReadiness({ available: false, check: "confirmed" }), "unavailable");
  assert.equal(liveRepositoryReadiness(), "loading");
});

function enrichmentFixture(readGit) {
  const jobs = [];
  let clock = 0;
  const enrichment = createSessionRepositoryEnrichment({
    gitReader: async (root) => readGit(root),
    pullRequestReader: async () => ({ status: "unavailable", checkedAt: null, items: [] }),
    now: () => clock,
    cacheMs: 2_500,
    providerFolders: { folders: {} },
    unavailableGitState: () => ({ available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
    unavailablePullRequests: () => ({ status: "unavailable", checkedAt: null, items: [] }),
  });
  const read = (sessionId, evidence, attribution) => {
    const live = enrichment.liveEnrichment(sessionId, evidence, attribution, (task) => jobs.push(task));
    live.enqueue?.();
    return { ...live, readiness: liveRepositoryReadiness({ available: live.value.repository.available, check: live.check }) };
  };
  return { read, advance(ms) { clock += ms; }, async runAll() { while (jobs.length) await jobs.shift()(); } };
}

const boundTo = (cwd) => ({ state: "single", repositoryId: "repo-0123456789abcdef01234567", root: cwd, fingerprint: `bound:${cwd}`, recordedBranch: "codex/live" });

test("a live session with no repository binding is a factual empty result and never reads Git", async () => {
  let gitCalls = 0;
  const fixture = enrichmentFixture(() => { gitCalls += 1; return repository("codex/live"); });
  const codex = fixture.read("codex:no-edits", sessionEvidence(), { state: "unknown" });
  assert.equal(codex.check, "none");
  assert.equal(codex.readiness, "ready");
  assert.equal(codex.value.repository.available, false);
  const claude = fixture.read("claude:outside-git", sessionEvidence({ branch: "" }), null);
  assert.equal(claude.readiness, "ready");
  await fixture.runAll();
  assert.equal(gitCalls, 0);
});

test("a bound live session stays loading through transient failures and rebinds, unavailable only on a confirmed answer", async () => {
  let answer = () => repository("codex/other", "C:\synthetic\pomegr");
  const fixture = enrichmentFixture((root) => answer(root));
  const evidence = sessionEvidence();
  assert.equal(fixture.read("codex:bound", evidence, boundTo(evidence.session.cwd)).readiness, "loading");
  answer = () => { throw new Error("transient"); };
  await fixture.runAll();
  assert.equal(fixture.read("codex:bound", evidence, boundTo(evidence.session.cwd)).readiness, "loading", "a failed check is not a confirmed answer");
  answer = (root) => repository("codex/other", root);
  fixture.advance(2_500);
  fixture.read("codex:bound", evidence, boundTo(evidence.session.cwd));
  await fixture.runAll();
  assert.equal(fixture.read("codex:bound", evidence, boundTo(evidence.session.cwd)).readiness, "unavailable", "a branch mismatch is confirmed");
  answer = (root) => repository("codex/live", root);
  fixture.advance(2_500);
  fixture.read("codex:bound", evidence, boundTo(evidence.session.cwd));
  await fixture.runAll();
  assert.equal(fixture.read("codex:bound", evidence, boundTo(evidence.session.cwd)).readiness, "ready");
  const moved = fixture.read("codex:bound", evidence, boundTo("C:\\synthetic\\moved"));
  assert.equal(moved.readiness, "loading", "a changed binding waits as loading so clients keep the committed value");
  await fixture.runAll();
  assert.equal(fixture.read("codex:bound", evidence, boundTo("C:\\synthetic\\moved")).readiness, "ready");
});

test("a session that had a repository stays loading while its attribution is briefly unknown", async () => {
  const fixture = enrichmentFixture((root) => repository("codex/live", root));
  const evidence = sessionEvidence();
  fixture.read("codex:rebinding", evidence, boundTo(evidence.session.cwd));
  await fixture.runAll();
  assert.equal(fixture.read("codex:rebinding", evidence, boundTo(evidence.session.cwd)).readiness, "ready");
  assert.equal(fixture.read("codex:rebinding", evidence, { state: "unknown" }).readiness, "loading");
  assert.equal(fixture.read("codex:rebinding", evidence, { state: "multiple" }).readiness, "ready", "two proven repositories are a confirmed state");
});

test("a launch-bound live check records the evidence's proven repository ID on its sidecar, and none for launch evidence", async () => {
  const jobs = [];
  const checks = new Map();
  const enrichment = createSessionRepositoryEnrichment({
    gitReader: async (root) => repository("codex/live", root),
    pullRequestReader: async () => ({ status: "unavailable", checkedAt: null, items: [] }),
    now: () => 0,
    cacheMs: 2_500,
    providerFolders: { folders: {} },
    unavailableGitState: () => ({ available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
    unavailablePullRequests: () => ({ status: "unavailable", checkedAt: null, items: [] }),
  });
  enrichment.setOnRepositoryCheck((sessionId, check) => checks.set(sessionId, check.repositoryId));
  const evidenceWith = (repositoryAttribution) => {
    const evidence = sessionEvidence();
    return { ...evidence, session: { ...evidence.session, repositoryAttribution, repositoryId: repositoryAttribution === "single" ? "repo-0123456789abcdef01234567" : null } };
  };
  for (const [sessionId, attribution] of [["claude:proven", "single"], ["claude:launch", "launch"]]) {
    enrichment.liveEnrichment(sessionId, evidenceWith(attribution), null, (task) => jobs.push(task)).enqueue?.();
  }
  while (jobs.length) await jobs.shift()();
  assert.equal(checks.get("claude:proven"), "repo-0123456789abcdef01234567");
  assert.equal(checks.get("claude:launch"), null);
});
