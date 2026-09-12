import assert from "node:assert/strict";
import test from "node:test";
import { createMonitorRuntime } from "../monitor/server.mjs";

const SAFE_CWD = "C:\\synthetic\\pomegr-api-fixture";

test("serializes a partial-reuse Codex read-drop while keeping cache-write events unavailable and private markers hidden", async () => {
  const provider = { id: "codex", source: "Codex", capabilities: {} };
  const beforeAt = "2026-09-02T09:00:00.000Z";
  const afterAt = "2026-09-02T09:05:00.000Z";
  const usageSnapshots = [
    { dedupeId: "read-drop-before", actorId: "primary", timestamp: beforeAt, input: 1_000, output: 10, cacheWrite: 0, cacheRead: 9_000, model: "gpt-5.6-sol", comparisonGroup: 0, cacheComparable: true, cacheReadComparable: true, cacheReadPreviousAt: null },
    { dedupeId: "read-drop-after", actorId: "primary", timestamp: afterAt, input: 8_760, output: 10, cacheWrite: 0, cacheRead: 1_240, model: "gpt-5.6-sol", comparisonGroup: 0, cacheComparable: true, cacheReadComparable: true, cacheReadPreviousAt: beforeAt },
  ];
  const runtime = createMonitorRuntime({
    providerRegistry: {
      defaultProvider: provider,
      async readSession() {
        return {
          provider,
          sessionId: "codex:read-drop",
          evidence: {
            historical: true,
            session: {
              title: "Read drop fixture", project: "pomegr", cwd: SAFE_CWD, startedAt: beforeAt, updatedAt: afterAt,
              recordedGitBranch: "", cost: null, approvalMode: null, contextMachinery: null, summary: null, signal: null,
            },
            agents: [{
              id: "primary", parentId: null, label: "Primary agent", kind: "orchestrator", model: "gpt-5.6-sol", effort: "unknown", status: "idle", signal: null,
              toolCalls: 0, skills: [], executionTasks: [], lastSeen: afterAt, startedAt: beforeAt, updatedAt: afterAt, durationMs: 300_000,
            }],
            workflows: [], usageSnapshots, toolCalls: [], activity: [], planTasks: [], compactions: [], pullRequestCreations: [],
            efficiencyRuleEvidence: { repetition: false, concurrentMutation: false, unsharedContext: false, healthyFallback: false, cacheUsageClassification: false },
          },
        };
      },
      async readUsageLimits() { return { available: false, fetchedAt: null, attemptedAt: null, limits: [], error: "" }; },
    },
    async readPullRequests() { return { status: "ready", checkedAt: null, items: [] }; },
  });
  const state = await runtime.analyze("codex:read-drop");
  assert.deepEqual(state.metrics.tokens.cacheReadDrops, {
    status: "ready",
    items: [{
      agentId: "primary",
      count: 1,
      occurrences: [{
        id: state.metrics.tokens.cacheReadDrops.items[0].occurrences[0].id,
        observedAt: afterAt,
        previousCacheReadPercent: 90,
        cacheReadPercent: 12.4,
        gapMs: 300_000,
      }],
    }],
  });
  assert.equal(state.metrics.tokens.cacheEvents.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(state), /cacheReadComparable|cacheReadPreviousAt|dedupeId|comparisonGroup/);
});

test("serializes a model-change read drop using only its bounded kind", async () => {
  const provider = { id: "codex", source: "Codex", capabilities: {} };
  const beforeAt = "2026-09-02T09:00:00.000Z";
  const afterAt = "2026-09-02T21:38:50.000Z";
  const usageSnapshots = [
    { dedupeId: "8", actorId: "primary", timestamp: beforeAt, input: 10_249, output: 4_643, cacheWrite: 0, cacheRead: 59_008, model: "gpt-5.6-sol", comparisonGroup: 0, cacheComparable: true, cacheReadComparable: true, cacheReadPreviousAt: null },
    { dedupeId: "9", actorId: "primary", timestamp: afterAt, input: 74_007, output: 155, cacheWrite: 0, cacheRead: 7_168, model: "gpt-6-astra", comparisonGroup: 0, cacheComparable: true, cacheReadComparable: true, cacheReadPreviousAt: beforeAt },
  ];
  const runtime = createMonitorRuntime({
    providerRegistry: {
      defaultProvider: provider,
      async readSession() {
        return {
          provider,
          sessionId: "codex:model-change-read-drop",
          evidence: {
            historical: true,
            session: {
              title: "Model-change read drop fixture", project: "pomegr", cwd: SAFE_CWD, startedAt: beforeAt, updatedAt: afterAt,
              recordedGitBranch: "", cost: null, approvalMode: null, contextMachinery: null, summary: null, signal: null,
            },
            agents: [{
              id: "primary", parentId: null, label: "Primary agent", kind: "orchestrator", model: "gpt-6-astra", effort: "unknown", status: "idle", signal: null,
              toolCalls: 0, skills: [], executionTasks: [], lastSeen: afterAt, startedAt: beforeAt, updatedAt: afterAt, durationMs: 12 * 60 * 60_000 + 38 * 60_000 + 50_000,
            }],
            workflows: [], usageSnapshots, toolCalls: [], activity: [], planTasks: [], compactions: [], pullRequestCreations: [],
            efficiencyRuleEvidence: { repetition: false, concurrentMutation: false, unsharedContext: false, healthyFallback: false, cacheUsageClassification: false },
          },
        };
      },
      async readUsageLimits() { return { available: false, fetchedAt: null, attemptedAt: null, limits: [], error: "" }; },
    },
    async readPullRequests() { return { status: "ready", checkedAt: null, items: [] }; },
  });
  const state = await runtime.analyze("codex:model-change-read-drop");
  const occurrence = state.metrics.tokens.cacheReadDrops.items[0].occurrences[0];
  assert.deepEqual(occurrence, {
    id: occurrence.id,
    observedAt: afterAt,
    previousCacheReadPercent: 85.2,
    cacheReadPercent: 8.8,
    gapMs: 12 * 60 * 60_000 + 38 * 60_000 + 50_000,
    kind: "model_change",
  });
  assert.equal(state.metrics.tokens.cacheEvents.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(state.metrics.tokens.cacheReadDrops), /gpt-5\.6-sol|gpt-6-astra|dedupeId|comparisonGroup|input|cacheWrite/);
});
