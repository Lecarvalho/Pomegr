import assert from "node:assert/strict";
import test from "node:test";
import { createSessionDomainStore, SESSION_DOMAIN_NAMES } from "../monitor/session-domain-store.mjs";
import { createEmptyMonitorState } from "../shared/monitor-state.mjs";

const SESSION_ID = "codex:domain-session";
const OBSERVED_AT = "2026-09-14T12:00:00.000Z";

function state(overrides = {}) {
  const base = createEmptyMonitorState({ connected: true, source: "Codex", view: "live" });
  return {
    ...base,
    session: {
      id: SESSION_ID,
      title: "Domain session",
      project: "Pomegr",
      startedAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT,
      durationMs: 1,
      cost: null,
      summary: null,
      progress: null,
      pomegrPlugin: null,
      signal: null,
      repositoryId: "repo-1",
      contextInventoryRef: null,
      cwd: "C:/private/workspace",
      repository: { available: true, branch: "main", files: [{ status: "modified", path: "app/file.ts" }], comparison: null },
      pullRequests: null,
    },
    agents: [
      { id: "primary", parentId: null, label: "Primary", role: "orchestrator", customType: null, model: "test", status: "active", currentActivity: null, tokens: { total: 20 }, lastSeen: OBSERVED_AT, updatedAt: OBSERVED_AT, cacheLifetime: null, signal: null },
      { id: "child", parentId: "primary", label: "Child", role: "builder", customType: null, model: "test", status: "idle", currentActivity: null, tokens: { total: 10 }, lastSeen: OBSERVED_AT, updatedAt: OBSERVED_AT, cacheLifetime: null, signal: null },
    ],
    metrics: {
      ...base.metrics,
      agents: 2,
      activeAgents: 1,
      tokens: { ...base.metrics.tokens, allAgents: 30, contextHistory: { bucketMs: 60_000, buckets: [], boundaries: [] } },
    },
    readiness: { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: "ready", resources: "ready", usageLimits: "ready" },
    ...overrides,
  };
}

function snapshot(publicState, observedAt = OBSERVED_AT) {
  return { publicState, readiness: publicState.readiness, observedAt };
}

test("commits all seven complete domain snapshots with independent revisions", () => {
  const store = createSessionDomainStore();
  const events = [];
  store.subscribe((event) => events.push(event));
  const changed = store.commit(SESSION_ID, snapshot(state()), { isLive: true, needsInput: false, activityStatus: "working" });

  assert.deepEqual(changed.map((event) => event.domain).sort(), [...SESSION_DOMAIN_NAMES].sort());
  assert.deepEqual(events.map((event) => event.domain).sort(), [...SESSION_DOMAIN_NAMES].sort());
  for (const domain of SESSION_DOMAIN_NAMES) {
    const result = store.read(SESSION_ID, domain, domain === "agent" ? "primary" : null);
    assert.equal(result.status, "ready", domain);
    assert.equal(result.snapshot.value.domain, domain);
    assert.equal(result.snapshot.value.sessionId, SESSION_ID);
    assert.equal(result.snapshot.value.readiness, "ready", domain);
    assert.equal(result.snapshot.value.observedAt, OBSERVED_AT);
  }
  const summary = store.read(SESSION_ID, "session-summary").snapshot.value;
  assert.deepEqual(Object.keys(summary).sort(), ["activity", "allAgentContext", "capabilities", "domain", "lifecycle", "metrics", "observedAt", "planTasks", "readiness", "repository", "requestSnapshots", "revision", "rightNow", "sectionReadiness", "session", "sessionId", "source", "topSignals", "view"].sort());
});

test("session-summary alone carries the bounded header and Overview data", () => {
  const publicState = state();
  publicState.session.cost = { amount: 1.25, currency: "USD", type: "estimated", observedAt: OBSERVED_AT };
  publicState.session.progress = { phase: "implementing", percent: 60, confidence: "medium", reportedAt: OBSERVED_AT };
  publicState.session.repository.comparison = { branch: "origin/main", kind: "upstream", ahead: 2, behind: 0, integrated: false };
  publicState.agents[0].currentActivity = { label: "Running focused tests", observedAt: OBSERVED_AT };
  publicState.insights = [0, 1, 2].map((index) => ({ id: `signal-${index}`, level: "info", title: `Signal ${index}`, detail: "Observed evidence" }));
  publicState.planTasks = [{ id: "task-1", subject: "Finish domains", status: "in_progress", blocks: [], blockedBy: [] }];
  publicState.activity = { items: [], total: 3, toolCalls: 3, messages: 0, failed: 0,
    byKind: [{ kind: "shell", count: 3, medianDurationMs: 25 }] };
  publicState.metrics.tokens.requestSnapshots = { status: "ready", items: Array.from({ length: 50 }, (_, index) => ({
    id: `request-${String(index).padStart(16, "0")}`, agentId: index % 2 ? "child" : "primary", observedAt: OBSERVED_AT,
    cacheLifetime: null, uncachedInputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 2, outputTokens: 1, totalTokens: 4,
    precedingWork: [{ kind: "shell", count: 1 }], precedingAssociation: "transcript_adjacency", issuedWork: [], issuedAssociation: null,
  })) };
  const store = createSessionDomainStore();
  store.commit(SESSION_ID, snapshot(publicState), { isLive: true, needsInput: false, activityStatus: "working" });
  const summary = store.read(SESSION_ID, "session-summary").snapshot.value;

  assert.deepEqual(summary.lifecycle, { isLive: true, needsInput: false, activityStatus: "working", currentActivity: null, activityFallback: null });
  assert.deepEqual(summary.rightNow[0], {
    id: "primary", label: "Primary", role: "orchestrator", customType: null, model: "test", status: "active",
    currentActivity: { label: "Running focused tests", observedAt: OBSERVED_AT }, tokens: { total: 20 }, lastSeen: OBSERVED_AT, updatedAt: OBSERVED_AT,
  });
  assert.equal(summary.allAgentContext, 30);
  assert.deepEqual(summary.topSignals.map((item) => item.id), ["signal-0", "signal-1"]);
  assert.deepEqual(summary.repository.comparison, publicState.session.repository.comparison);
  assert.equal(summary.requestSnapshots.status, "ready");
  assert.equal(summary.requestSnapshots.items.length, 48);
  assert.equal(summary.requestSnapshots.items[0].id, "request-0000000000000002");
  assert.deepEqual(new Set(summary.requestSnapshots.items.map((item) => item.agentRole)), new Set(["orchestrator", "builder"]));
  assert.deepEqual(summary.planTasks, publicState.planTasks);
  assert.deepEqual(summary.activity.byKind, [{ kind: "shell", count: 3, medianDurationMs: 25 }]);
  assert.equal(summary.session.progress.percent, 60);
  assert.equal(summary.session.cost.amount, 1.25);
});

test("does not publish a revision or event when only observedAt changes", () => {
  const store = createSessionDomainStore();
  const events = [];
  store.subscribe((event) => events.push(event));
  const first = state();
  store.commit(SESSION_ID, snapshot(first));
  const summaryRevision = store.read(SESSION_ID, "session-summary").revision;
  events.length = 0;

  const changed = store.commit(SESSION_ID, snapshot(structuredClone(first), "2026-09-14T12:01:00.000Z"));
  assert.deepEqual(changed, []);
  assert.deepEqual(events, []);
  assert.equal(store.read(SESSION_ID, "session-summary").revision, summaryRevision);
  assert.equal(store.read(SESSION_ID, "session-summary").snapshot.value.observedAt, OBSERVED_AT);
});

test("a session signal updates only the signals domain", () => {
  const store = createSessionDomainStore();
  store.commit(SESSION_ID, snapshot(state()));
  const next = state({ session: { ...state().session, signal: { label: "Review ready", tone: "positive", reportedAt: OBSERVED_AT, description: null } } });
  const changed = store.commit(SESSION_ID, snapshot(next));
  assert.deepEqual(changed.map((event) => event.domain), ["signals"]);
  assert.deepEqual(store.read(SESSION_ID, "signals").snapshot.value.sessionSignal, next.session.signal);
});

test("preserves sectional and request readiness without presenting missing evidence as zero", () => {
  const publicState = state();
  publicState.readiness = { ...publicState.readiness, agentEvidence: "loading", contextEvidence: "unavailable", activityEvidence: "loading" };
  publicState.metrics.tokens.requestSnapshots = { status: "unavailable", items: [] };
  const store = createSessionDomainStore();
  store.commit(SESSION_ID, snapshot(publicState));

  const summary = store.read(SESSION_ID, "session-summary").snapshot.value;
  assert.equal(summary.readiness, "loading");
  assert.deepEqual(summary.sectionReadiness, {
    core: "ready", agentEvidence: "loading", contextEvidence: "unavailable", activityEvidence: "loading", repository: "ready",
  });
  assert.deepEqual(summary.requestSnapshots, { status: "unavailable", items: [] });
  const agent = store.read(SESSION_ID, "agent", "primary").snapshot.value;
  assert.equal(agent.readiness, "loading");
  assert.deepEqual(agent.sectionReadiness, { agentEvidence: "loading", contextEvidence: "unavailable", activityEvidence: "loading" });
  assert.equal(agent.requestSnapshots.status, "unavailable");
  const details = store.read(SESSION_ID, "details").snapshot.value;
  assert.deepEqual(details.sectionReadiness, { core: "ready", contextEvidence: "unavailable" });
  const flow = store.read(SESSION_ID, "signals").snapshot.value.flowScore;
  assert.equal(flow.repeatedCalls, null);
  assert.equal(flow.overlappingTargets, null);
});

test("Flow inputs require ready activity evidence and valid nonnegative counts", () => {
  const store = createSessionDomainStore();
  store.commitUnavailable(SESSION_ID, { updatedAt: OBSERVED_AT }, "Codex", {});
  assert.deepEqual(store.read(SESSION_ID, "signals").snapshot.value.flowScore, {
    score: 0, repeatedCalls: null, overlappingTargets: null,
  });
  for (const activityEvidence of ["loading", "unavailable", "ready"]) {
    for (const count of [0, 2, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const publicState = state();
      publicState.readiness.activityEvidence = activityEvidence;
      publicState.metrics.repeatedCalls = count;
      publicState.metrics.overlappingTargets = count;
      store.commit(SESSION_ID, snapshot(publicState));
      const flow = store.read(SESSION_ID, "signals").snapshot.value.flowScore;
      const expected = activityEvidence === "ready" && Number.isSafeInteger(count) && count >= 0 ? count : null;
      assert.equal(flow.repeatedCalls, expected);
      assert.equal(flow.overlappingTargets, expected);
    }
  }
});

test("signals carry the Flow-score inputs and agent projections carry selected inspector evidence", () => {
  const publicState = state();
  publicState.score = 81;
  publicState.metrics.repeatedCalls = 3;
  publicState.metrics.overlappingTargets = 1;
  publicState.metrics.tokens.requestSnapshots = { status: "ready", items: [{
    id: "request-1111111111111111", agentId: "primary", observedAt: OBSERVED_AT, cacheLifetime: "1h",
    uncachedInputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4, totalTokens: 10,
    precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null,
  }] };
  publicState.metrics.tokens.cacheEvents = { status: "ready", items: [{
    id: "event-1", agentId: "primary", kind: "refill", observedAt: OBSERVED_AT, promptInputTokens: 4,
    cacheReadPercent: 30, cacheWriteTokens: 2, previousCacheReadPercent: 90, gapMs: 100, relatedEventId: null,
  }], possibleFullRefills: [{ agentId: "primary", count: 1, occurrences: [], reasons: [], toolChangeAttributions: [] }] };
  publicState.metrics.tokens.cacheReadDrops = { status: "ready", items: [{ agentId: "primary", count: 1, occurrences: [] }] };
  publicState.insights = [{ id: "agent-insight", level: "warning", title: "Repeated work", detail: "Observed", agentId: "primary" },
    { id: "child-insight", level: "info", title: "Child", detail: "Observed", agentId: "child" }];
  const store = createSessionDomainStore();
  store.commit(SESSION_ID, snapshot(publicState));

  const signals = store.read(SESSION_ID, "signals").snapshot.value;
  assert.deepEqual(signals.flowScore, { score: 81, repeatedCalls: 3, overlappingTargets: 1 });
  const agent = store.read(SESSION_ID, "agent", "primary").snapshot.value;
  assert.deepEqual(agent.requestSnapshots.items.map((item) => item.id), ["request-1111111111111111"]);
  assert.deepEqual(agent.insights.map((item) => item.id), ["agent-insight"]);
  assert.equal(agent.cacheEvents.possibleFullRefills[0].agentId, "primary");
  assert.equal(agent.cacheReadDrops.items[0].agentId, "primary");
});

test("rejects a late unserializable value atomically and retains every committed revision", () => {
  const store = createSessionDomainStore();
  const events = [];
  store.subscribe((event) => events.push(event));
  store.commit(SESSION_ID, snapshot(state()));
  const before = Object.fromEntries(SESSION_DOMAIN_NAMES.map((domain) => [domain,
    store.read(SESSION_ID, domain, domain === "agent" ? "primary" : null).snapshot.serialized]));
  events.length = 0;
  const invalid = state();
  invalid.metrics.tokens.contextHistory = { bucketMs: 60_000, buckets: [{ at: OBSERVED_AT, total: 1n }], boundaries: [] };

  assert.throws(() => store.commit(SESSION_ID, snapshot(invalid)), /BigInt/u);
  assert.deepEqual(events, []);
  for (const domain of SESSION_DOMAIN_NAMES) {
    assert.equal(store.read(SESSION_ID, domain, domain === "agent" ? "primary" : null).snapshot.serialized, before[domain], domain);
  }
});

test("bounds inactive session records and serves agent selection from the committed projection", () => {
  let clock = 0;
  const store = createSessionDomainStore({ now: () => clock, maxSessions: 2, idleMs: 10 * 60_000 });
  const one = "codex:domain-one";
  const two = "codex:domain-two";
  const three = "codex:domain-three";
  for (const id of [one, two, three]) {
    store.commit(id, snapshot({ ...state(), session: { ...state().session, id } }));
    clock += 1;
  }
  assert.equal(store.size(), 2);
  assert.equal(store.read(one, "details").status, "empty");
  const child = store.read(three, "agent", "child").snapshot.value;
  assert.equal(child.agent.id, "child");
  assert.deepEqual(child.ancestors.map((agent) => agent.id), ["primary"]);
  assert.equal(store.read(three, "agent", "missing").status, "unavailable");
  clock += 10 * 60_000;
  assert.deepEqual(store.evictIdle(), [two, three]);
  assert.equal(store.size(), 0);
});

test("retains committed repository live evidence while future resource history stays unavailable and strips private fields", () => {
  const store = createSessionDomainStore({ forbiddenRoots: [`${process.cwd()}/private`], repositoryRootForSession: () => process.cwd() });
  const publicState = state();
  publicState.readiness = { ...publicState.readiness, resources: "unavailable" };
  publicState.session.cwd = process.cwd();
  publicState.session.repository.files.push({ status: "modified", path: "C:/private/secret.txt" });
  publicState.agents[0].rawPrompt = "PRIVATE_PROMPT";
  publicState.metrics.privateToken = "PRIVATE_TOKEN";
  publicState.session.repository.comparison = { branch: "main", kind: "upstream", ahead: 0, behind: 0, integrated: true, rawPrompt: "PRIVATE_COMPARISON" };
  publicState.session.contextInventoryRef = { repositoryId: "repo-1", provider: "codex", revisionId: "rev-1", capturedAt: OBSERVED_AT,
    model: "test", machineryTokens: 1, contextAllocation: { initialTokens: 1, deferredTokens: 2, reservedTokens: 3, rawPrompt: "PRIVATE_ALLOCATION" },
    categoryCount: 0, itemCount: 0, detailRetained: false, rawPrompt: "PRIVATE_INVENTORY" };
  publicState.workflows = [{ id: "flow", name: "Flow", summary: null, status: "running", metadataStatus: "ready", startedAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT, durationMs: 1, agentIds: ["primary"], phases: [{ id: "phase", label: "Build", agentIds: ["primary"], rawPrompt: "PRIVATE_PHASE" }], rawPrompt: "PRIVATE_WORKFLOW" }];
  publicState.insights = [{ id: "insight", level: "info", title: "Safe", detail: "Safe", agentId: "primary", rawPrompt: "PRIVATE_INSIGHT" }];
  publicState.metrics.tokens.requestSnapshots = { status: "ready", items: [{
    id: "request-2222222222222222", agentId: "primary", observedAt: OBSERVED_AT, cacheLifetime: null,
    uncachedInputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1, totalTokens: 2,
    precedingWork: [{ kind: "read", count: 1, rawPrompt: "PRIVATE_REQUEST_WORK" }], precedingAssociation: "transcript_adjacency",
    issuedWork: [], issuedAssociation: null, rawPrompt: "PRIVATE_REQUEST",
  }] };
  publicState.metrics.tokens.cacheEvents = { status: "ready", items: [{ id: "cache", agentId: "primary", kind: "reuse",
    observedAt: OBSERVED_AT, promptInputTokens: 1, cacheReadPercent: 100, cacheWriteTokens: 0, previousCacheReadPercent: null,
    gapMs: null, relatedEventId: null, rawPrompt: "PRIVATE_CACHE" }], possibleFullRefills: [] };
  publicState.session.contextMachinery = { observedAt: OBSERVED_AT, model: "test", machineryTokens: 1,
    contextAllocation: { initialTokens: 1, deferredTokens: 0, reservedTokens: 0, rawPrompt: "PRIVATE_MACHINERY_ALLOCATION" },
    total: { used: "1", limit: "2", percentage: 50, rawPrompt: "PRIVATE_TOTAL" }, categories: [],
    groups: [{ id: "group", label: "Group", items: [{ name: "Item", detail: "Safe", tokens: "1", rawPrompt: "PRIVATE_CONTEXT_ITEM" }], rawPrompt: "PRIVATE_GROUP" }],
    rawPrompt: "PRIVATE_MACHINERY" };
  publicState.metrics.resources = { status: "ready", reason: null, current: null, observedPeak: null,
    samples: [{ timestamp: OBSERVED_AT, cpuCores: 1, cpuMachinePercent: 2, memoryBytes: 3, readBytesPerSecond: 4, writeBytesPerSecond: 5, rawPrompt: "PRIVATE_RESOURCE" }] };
  store.commit(SESSION_ID, snapshot(publicState));

  const repository = store.read(SESSION_ID, "repository").snapshot.value;
  const resources = store.read(SESSION_ID, "resources").snapshot.value;
  assert.equal(repository.repository.available, true);
  assert.deepEqual(repository.repository.files, [{ status: "modified", path: "app/file.ts" }]);
  assert.deepEqual(repository.fileHistory, { readiness: "unavailable", items: [] });
  assert.deepEqual(resources.retained, { readiness: "unavailable", reason: "producer_not_implemented", minutes: [], peaks: [], peakSamples: [] });
  for (const domain of SESSION_DOMAIN_NAMES) {
    const serialized = store.read(SESSION_ID, domain, domain === "agent" ? "primary" : null).snapshot.serialized;
    assert.doesNotMatch(serialized, /PRIVATE_/u, domain);
  }
});
