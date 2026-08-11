import assert from "node:assert/strict";
import test from "node:test";
import { createMonitorRuntime } from "../monitor/server.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../shared/monitor-state.mjs";

const provider = Object.freeze({
  source: "Codex",
  capabilities: createEmptyProviderCapabilities(),
});

function sessionEvidence({
  historical = false,
  branch = "codex/recorded",
  cwd = "C:\\synthetic\\threadlight",
  pullRequestCreations = [],
} = {}) {
  return {
    historical,
    session: {
      title: "Runtime enrichment fixture",
      project: "threadlight",
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

function repository(branch) {
  return {
    available: true,
    branch,
    files: [],
    isMain: false,
    comparison: null,
    commits: [],
    remote: { status: "ready", checkedAt: null },
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
  const registry = {
    defaultProvider: provider,
    async readSession() { return { evidence: readEvidence(), provider, sessionId: normalizedSessionId }; },
    async readUsageLimits(...args) { return usageReader(...args); },
    async listSessions() { return []; },
    providerForSessionId() { return provider; },
    unavailableMessage() { return "Session unavailable"; },
  };
  return createMonitorRuntime({ ...options, providerRegistry: registry });
}

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
  let version = 1;
  const runtime = runtimeFixture({
    now: () => clock,
    enrichmentCacheMs: 10,
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState() { return repository(`codex/live-${version}`); },
    async readPullRequests() { return pullRequests(`codex/live-${version}`); },
  });

  await runtime.analyze();
  await scheduler.runNext();
  assert.equal((await runtime.analyze()).session.repository.branch, "codex/live-1");

  clock = 11;
  version = 2;
  const [firstStale, secondStale] = await Promise.all([runtime.analyze(), runtime.analyze()]);
  assert.equal(firstStale.session.repository.branch, "codex/live-1");
  assert.equal(secondStale.session.pullRequests.items[0].headBranch, "codex/live-1");
  assert.equal(scheduler.jobs.length, 1);

  await scheduler.runNext();
  const refreshed = await runtime.analyze();
  assert.equal(refreshed.session.repository.branch, "codex/live-2");
  assert.equal(refreshed.session.pullRequests.items[0].headBranch, "codex/live-2");
});

test("changed enrichment inputs invalidate stale data and reject older in-flight completion", async () => {
  const scheduler = controlledScheduler();
  let currentEvidence = sessionEvidence({
    cwd: "C:\\synthetic\\old",
    pullRequestCreations: [{ url: "https://example.test/old" }],
  });
  let resolveOldPullRequests;
  const oldPullRequests = new Promise((resolve) => { resolveOldPullRequests = resolve; });
  const observedInputs = [];
  const runtime = runtimeFixture({
    readEvidence: () => currentEvidence,
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState(cwd) { return repository(cwd.endsWith("old") ? "codex/old" : "codex/new"); },
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

test("historical analysis uses recorded Git and historical pull-request semantics without scheduling", async () => {
  const scheduler = controlledScheduler();
  const pullRequestOptions = [];
  const runtime = runtimeFixture({
    evidence: sessionEvidence({ historical: true, branch: "codex/recorded-branch" }),
    scheduleEnrichment: scheduler.scheduleEnrichment,
    readGitState() { assert.fail("historical analysis must not inspect current Git"); },
    async readPullRequests(_records, options) {
      pullRequestOptions.push(options);
      return pullRequests(options.branch);
    },
  });

  const state = await runtime.analyze("codex:historical");
  assert.equal(state.view, "history");
  assert.equal(state.session.repository.branch, "codex/recorded-branch");
  assert.equal(state.session.repository.historical, true);
  assert.equal(state.session.pullRequests.status, "ready");
  assert.equal(scheduler.jobs.length, 0);
  assert.equal(pullRequestOptions.length, 1);
  assert.equal(pullRequestOptions[0].historical, true);
  assert.equal(pullRequestOptions[0].branch, "codex/recorded-branch");
});
