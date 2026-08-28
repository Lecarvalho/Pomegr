import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildContextHistory } from "../monitor/context-history.mjs";
import { evaluateEfficiencySignals } from "../monitor/efficiency-signals.mjs";
import { parseCodexContextRecords } from "../monitor/providers/codex-context.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import {
  assertNoPrivateFixtureSentinels,
  monitorStateFromProviderEvidence,
  readProviderFixture,
} from "./helpers/provider-fixtures.mjs";

function tokenCount(timestamp, lastTokenUsage, extras = {}) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 900_000,
          output_tokens: 80_000,
          total_tokens: 980_000,
        },
        last_token_usage: lastTokenUsage,
        model_context_window: 200_000,
      },
      ...extras,
    },
  };
}

test("maps only last_token_usage and keeps cached and reasoning tokens from being double-counted", () => {
  const { usageSnapshots } = parseCodexContextRecords([
    { timestamp: "2026-08-10T13:00:01.000Z", type: "turn_context", payload: { turn_id: "turn-1" } },
    tokenCount("2026-08-10T13:00:02.000Z", {
      input_tokens: 1_500,
      cached_input_tokens: 500,
      cache_write_input_tokens: 50,
      output_tokens: 120,
      reasoning_output_tokens: 40,
      total_tokens: 1_620,
    }, { event_id: "usage-1" }),
  ], { actorId: "primary", sourceKey: "thread-1" });

  assert.deepEqual(usageSnapshots, [{
    dedupeId: "thread-1:token-count:usage-1",
    actorId: "primary",
    timestamp: "2026-08-10T13:00:02.000Z",
    input: 950,
    output: 120,
    cacheWrite: 50,
    cacheRead: 500,
    reasoningOutput: 40,
    totalTokens: 1_620,
    modelContextWindow: 200_000,
    model: "",
    comparisonGroup: 0,
    cacheComparable: true,
    cacheLifetime: null,
    cacheMissProviderStatus: null,
  }]);
  assert.equal(usageSnapshots[0].input + usageSnapshots[0].output + usageSnapshots[0].cacheWrite + usageSnapshots[0].cacheRead, 1_620);
  assert.equal(JSON.stringify(usageSnapshots).includes("total_token_usage"), false);
});

test("preserves bounded comparable usage and marks missing intermediate evidence", () => {
  const records = [
    { timestamp: "2026-08-10T10:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.6" } },
    tokenCount("2026-08-10T10:00:01.000Z", { input_tokens: 10_000, cached_input_tokens: 9_000, output_tokens: 10 }, { event_id: "before" }),
    { timestamp: "2026-08-10T10:10:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 99_999 } } } },
    { timestamp: "2026-08-10T11:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-5.6" } },
    tokenCount("2026-08-10T11:00:01.000Z", { input_tokens: 10_000, cached_input_tokens: 500, output_tokens: 10 }, { event_id: "after" }),
  ];
  const interrupted = parseCodexContextRecords(records, { actorId: "primary", sourceKey: "thread-1" }).usageSnapshots;
  assert.equal(interrupted.length, 2);
  assert.notEqual(interrupted[0].comparisonGroup, interrupted[1].comparisonGroup);
  const interruptedSignals = evaluateEfficiencySignals({
    agents: [{ id: "primary", label: "Primary agent", kind: "orchestrator", status: "idle", toolCalls: 0, tokens: { total: 10_000 } }],
    usageSnapshots: interrupted,
    availableEvidence: { cacheUsageClassification: true },
  }).insights;
  assert.equal(interruptedSignals.some((insight) => insight.id === "prompt-cache-miss-primary"), false);
  for (let index = 0; index < 1_005; index += 1) records.push(
    { timestamp: new Date(Date.parse("2026-08-10T12:00:00.000Z") + index).toISOString(), type: "turn_context", payload: { turn_id: `bounded-${index}`, model: "gpt-5.6" } },
    tokenCount(new Date(Date.parse("2026-08-10T12:00:00.000Z") + index).toISOString(), { input_tokens: 100 + index, output_tokens: 1 }, { event_id: `bounded-${index}` }),
  );

  const { usageSnapshots } = parseCodexContextRecords(records, { actorId: "primary", sourceKey: "thread-1" });
  assert.equal(usageSnapshots.length, 1_000);
  assert.equal(usageSnapshots.some((snapshot) => snapshot.dedupeId.endsWith(":before")), false);
  assert.equal(usageSnapshots.every((snapshot) => snapshot.model === "gpt-5.6"), true);
});

test("malformed present cached-input evidence invalidates cache classification while absence remains valid", () => {
  for (const cachedField of ["cached_input_tokens", "cachedInputTokens"]) {
    const malformedUsage = {
      input_tokens: 10_000,
      output_tokens: 10,
      [cachedField]: "not-a-token-count",
    };
    const { usageSnapshots } = parseCodexContextRecords([
      { timestamp: "2026-08-10T10:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.6" } },
      tokenCount("2026-08-10T10:00:01.000Z", { input_tokens: 10_000, cached_input_tokens: 9_000, output_tokens: 10 }, { event_id: "before" }),
      tokenCount("2026-08-10T10:10:00.000Z", malformedUsage, { event_id: `malformed-${cachedField}` }),
      { timestamp: "2026-08-10T11:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-5.6" } },
      tokenCount("2026-08-10T11:00:01.000Z", { input_tokens: 10_000, cached_input_tokens: 500, output_tokens: 10 }, { event_id: "after" }),
    ], { actorId: "primary", sourceKey: `thread-${cachedField}` });

    assert.equal(usageSnapshots.length, 2);
    assert.notEqual(usageSnapshots[0].comparisonGroup, usageSnapshots[1].comparisonGroup);
    const { insights } = evaluateEfficiencySignals({
      agents: [{ id: "primary", label: "Primary agent", kind: "orchestrator", status: "idle", toolCalls: 0, tokens: { total: 10_000 } }],
      usageSnapshots,
      availableEvidence: { cacheUsageClassification: true },
    });
    assert.equal(insights.some((insight) => insight.id === "prompt-cache-miss-primary"), false);
  }

  const absent = parseCodexContextRecords([
    { timestamp: "2026-08-10T12:00:00.000Z", type: "turn_context", payload: { model: "gpt-5.6" } },
    tokenCount("2026-08-10T12:00:01.000Z", { input_tokens: 1_000, output_tokens: 10 }, { event_id: "absent-cache-read" }),
  ], { actorId: "primary", sourceKey: "thread-absent" }).usageSnapshots;
  assert.equal(absent.length, 1);
  assert.equal(absent[0].cacheRead, 0);
});

test("provider compaction actorId suppresses a cache comparison and remains valid automatic-compaction evidence", () => {
  const { usageSnapshots, compactions } = parseCodexContextRecords([
    { timestamp: "2026-08-10T10:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.6" } },
    tokenCount("2026-08-10T10:00:01.000Z", { input_tokens: 10_000, cached_input_tokens: 9_000, output_tokens: 10 }, { event_id: "before" }),
    { timestamp: "2026-08-10T10:15:00.000Z", id: "compacted", type: "compacted", payload: { trigger: "auto", pre_tokens: 10_000 } },
    { timestamp: "2026-08-10T11:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-5.6" } },
    tokenCount("2026-08-10T11:00:01.000Z", { input_tokens: 10_000, cached_input_tokens: 500, output_tokens: 10 }, { event_id: "after" }),
  ], { actorId: "primary", sourceKey: "thread-compacted" });
  assert.deepEqual(compactions, [{
    actorId: "primary",
    timestamp: "2026-08-10T10:15:00.000Z",
    trigger: "auto",
    preTokens: 10_000,
  }]);

  const { insights } = evaluateEfficiencySignals({
    agents: [{ id: "primary", label: "Primary agent", kind: "orchestrator", status: "idle", toolCalls: 0, tokens: { total: 10_000 } }],
    usageSnapshots,
    compactions,
    availableEvidence: { cacheUsageClassification: true },
  });
  assert.equal(insights.some((insight) => insight.id === "prompt-cache-miss-primary"), false);
  assert.equal(insights.some((insight) => insight.id === "automatic-compaction-primary"), true);
});

test("deduplicates stable event identities, ignores cumulative-only and zero snapshots, and retains chronological latest snapshots", () => {
  const positive = tokenCount("2026-08-10T13:00:04.000Z", {
    input_tokens: 300,
    cached_input_tokens: 100,
    output_tokens: 30,
    reasoning_output_tokens: 10,
    total_tokens: 330,
  }, { message_id: "same-message" });
  const { usageSnapshots } = parseCodexContextRecords([
    { timestamp: "2026-08-10T13:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-1" } },
    positive,
    { ...positive, timestamp: "2026-08-10T13:00:05.000Z" },
    tokenCount("2026-08-10T13:00:06.000Z", { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, { event_id: "zero" }),
    { timestamp: "2026-08-10T13:00:07.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 999_999 } } } },
    tokenCount("2026-08-10T13:00:08.000Z", {
      input_tokens: 300,
      cached_input_tokens: 100,
      output_tokens: 30,
      reasoning_output_tokens: 10,
      total_tokens: 330,
    }, { event_id: "repeated-snapshot" }),
  ], { actorId: "agent-child", sourceKey: "thread-child" });

  assert.equal(usageSnapshots.length, 2);
  assert.equal(usageSnapshots[0].timestamp, "2026-08-10T13:00:05.000Z");
  assert.equal(usageSnapshots[1].timestamp, "2026-08-10T13:00:08.000Z");
  const history = buildContextHistory(usageSnapshots, {
    startedAt: "2026-08-10T13:00:00.000Z",
    updatedAt: "2026-08-10T13:00:10.000Z",
    targetBuckets: 1,
  });
  assert.equal(history.buckets.at(-1).total, 330);
});

test("keeps early observations available across a busy full-session context timeline", () => {
  const startedAt = Date.parse("2026-08-10T13:00:00.000Z");
  const records = Array.from({ length: 150 }, (_, index) => tokenCount(
    new Date(startedAt + index * 60_000).toISOString(),
    { input_tokens: 1_000 + index, output_tokens: 10 },
    { event_id: `history-${index}` },
  ));
  const { usageSnapshots } = parseCodexContextRecords(records, {
    actorId: "primary",
    sourceKey: "thread-history",
  });
  const history = buildContextHistory(usageSnapshots, {
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(startedAt + 149 * 60_000).toISOString(),
  });

  assert.equal(usageSnapshots.length, 150);
  assert.equal(usageSnapshots[0].timestamp, new Date(startedAt).toISOString());
  assert.equal(history.buckets[0].total > 0, true);
  assert.equal(history.buckets.at(-1).total, 1_159);
});

test("keeps only bounded compaction evidence and warns only for an explicit automatic trigger", () => {
  const { compactions } = parseCodexContextRecords([
    {
      id: "implicit",
      timestamp: "2026-08-10T13:00:01.000Z",
      type: "compacted",
      payload: { summary: "RESPONSE_MUST_NOT_LEAK", pre_tokens: 190_000 },
    },
    {
      id: "manual",
      timestamp: "2026-08-10T13:00:02.000Z",
      type: "compacted",
      payload: { trigger: "manual", summary: "RESPONSE_MUST_NOT_LEAK", pre_tokens: 180_000 },
    },
    {
      id: "automatic",
      timestamp: "2026-08-10T13:00:03.000Z",
      type: "event_msg",
      payload: { type: "context_compacted", trigger: "automatic", summary: "RESPONSE_MUST_NOT_LEAK", pre_tokens: 195_000 },
    },
    {
      id: "unrecognized",
      timestamp: "2026-08-10T13:00:04.000Z",
      type: "compacted",
      payload: { trigger: "future-trigger", summary: "RESPONSE_MUST_NOT_LEAK" },
    },
    {
      id: "conflicting",
      timestamp: "2026-08-10T13:00:05.000Z",
      type: "compacted",
      trigger: "manual",
      payload: { trigger: "auto", summary: "RESPONSE_MUST_NOT_LEAK" },
    },
  ], { actorId: "primary", sourceKey: "thread-1" });

  assert.deepEqual(compactions, [
    { actorId: "primary", timestamp: "2026-08-10T13:00:01.000Z", trigger: "unknown", preTokens: 190_000 },
    { actorId: "primary", timestamp: "2026-08-10T13:00:02.000Z", trigger: "manual", preTokens: 180_000 },
    { actorId: "primary", timestamp: "2026-08-10T13:00:03.000Z", trigger: "auto", preTokens: 195_000 },
  ]);
  const { insights } = evaluateEfficiencySignals({
    agents: [{ id: "primary", label: "Primary agent", status: "idle", toolCalls: 0, tokens: { total: 20_000 } }],
    compactions: compactions.map((compaction) => ({ ...compaction, actor: { id: "primary", label: "Primary agent" } })),
  });
  assert.equal(insights.filter((insight) => insight.id === "automatic-compaction-primary").length, 1);
  assertNoPrivateFixtureSentinels(compactions, "Codex compaction evidence");
});

test("keeps an isolated windowed compaction ambiguous when the rollout omits the trigger", () => {
  const { compactions } = parseCodexContextRecords([{
    timestamp: "2026-08-25T00:36:36.233Z",
    type: "compacted",
    payload: {
      message: "RESPONSE_MUST_NOT_LEAK",
      replacement_history: [{ private: "RESPONSE_MUST_NOT_LEAK" }],
      window_number: 2,
      first_window_id: "PRIVATE_PROVIDER_ID",
      previous_window_id: "PRIVATE_PROVIDER_ID",
      window_id: "PRIVATE_PROVIDER_ID",
    },
  }], { actorId: "primary", sourceKey: "thread-windowed" });

  assert.deepEqual(compactions, [{
    actorId: "primary",
    timestamp: "2026-08-25T00:36:36.233Z",
    trigger: "unknown",
    preTokens: null,
  }]);
  assertNoPrivateFixtureSentinels(compactions, "windowed Codex compaction evidence");
});

test("classifies the current in-turn windowed compaction receipt as automatic", () => {
  const { compactions } = parseCodexContextRecords([
    { timestamp: "2026-08-25T00:36:35.000Z", type: "turn_context", payload: { turn_id: "active-turn" } },
    tokenCount("2026-08-25T00:36:36.000Z", {
      input_tokens: 230_000,
      cached_input_tokens: 220_000,
      output_tokens: 5_253,
      total_tokens: 235_253,
    }, { event_id: "before-auto" }),
    {
      timestamp: "2026-08-25T00:36:36.233Z",
      type: "compacted",
      payload: {
        message: "RESPONSE_MUST_NOT_LEAK",
        replacement_history: [{ private: "RESPONSE_MUST_NOT_LEAK" }],
        window_number: 2,
      },
    },
    { timestamp: "2026-08-25T00:36:36.300Z", type: "world_state", payload: {} },
    { timestamp: "2026-08-25T00:36:36.400Z", type: "turn_context", payload: { turn_id: "active-turn" } },
    tokenCount("2026-08-25T00:36:36.500Z", { input_tokens: 20_000, output_tokens: 458 }, { event_id: "after-auto" }),
    { timestamp: "2026-08-25T00:36:36.600Z", type: "event_msg", payload: { type: "item_completed", item: { type: "ContextCompaction" } } },
    { timestamp: "2026-08-25T00:36:36.700Z", type: "response_item", payload: { type: "reasoning", private: "RESPONSE_MUST_NOT_LEAK" } },
  ], { actorId: "primary", sourceKey: "thread-auto-receipt" });

  assert.deepEqual(compactions, [{
    actorId: "primary",
    timestamp: "2026-08-25T00:36:36.233Z",
    trigger: "auto",
    preTokens: 235_253,
    inferred: true,
  }]);
  const { insights } = evaluateEfficiencySignals({
    agents: [{ id: "primary", label: "Primary agent", status: "idle", toolCalls: 0, tokens: { total: 20_458 } }],
    compactions,
  });
  assert.equal(insights[0].id, "automatic-compaction-primary");
  assert.equal(insights[0].level, "warning");
  assertNoPrivateFixtureSentinels(compactions, "automatic receipt evidence");
});

test("classifies the current nested context_compacted receipt without creating a duplicate boundary", () => {
  const { compactions } = parseCodexContextRecords([
    { timestamp: "2026-08-28T04:30:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "active-turn" } },
    { timestamp: "2026-08-28T04:30:00.100Z", type: "turn_context", payload: { turn_id: "active-turn" } },
    tokenCount("2026-08-28T04:32:14.905Z", {
      input_tokens: 220_000,
      cached_input_tokens: 210_000,
      output_tokens: 5_481,
      total_tokens: 225_481,
    }, { event_id: "before-nested-auto" }),
    { timestamp: "2026-08-28T04:32:15.464Z", type: "event_msg", payload: { type: "patch_apply_end", status: "completed", stdout: "RESPONSE_MUST_NOT_LEAK" } },
    { timestamp: "2026-08-28T04:32:15.790Z", type: "response_item", payload: { type: "message", content: "RESPONSE_MUST_NOT_LEAK" } },
    {
      timestamp: "2026-08-28T04:33:02.205Z",
      type: "compacted",
      payload: {
        replacement_history: [{ private: "RESPONSE_MUST_NOT_LEAK" }],
        window_number: 2,
        first_window_id: "PRIVATE_PROVIDER_ID",
        previous_window_id: "PRIVATE_PROVIDER_ID",
        window_id: "PRIVATE_PROVIDER_ID",
      },
    },
    { timestamp: "2026-08-28T04:33:02.223Z", type: "world_state", payload: { state: "RESPONSE_MUST_NOT_LEAK" } },
    { timestamp: "2026-08-28T04:33:02.223Z", type: "turn_context", payload: { turn_id: "active-turn" } },
    tokenCount("2026-08-28T04:33:02.301Z", { input_tokens: 50_000, output_tokens: 2_714 }, { event_id: "after-nested-auto" }),
    { timestamp: "2026-08-28T04:33:02.372Z", type: "event_msg", payload: { type: "context_compacted" } },
    { timestamp: "2026-08-28T04:33:02.669Z", type: "response_item", payload: { type: "message", content: "RESPONSE_MUST_NOT_LEAK" } },
  ], { actorId: "primary", sourceKey: "thread-nested-auto-receipt" });

  assert.deepEqual(compactions, [{
    actorId: "primary",
    timestamp: "2026-08-28T04:33:02.205Z",
    trigger: "auto",
    preTokens: 225_481,
    inferred: true,
  }]);
  assertNoPrivateFixtureSentinels(compactions, "nested automatic compaction receipt evidence");
});

test("classifies a dedicated windowed compaction task receipt as manual", () => {
  const { compactions } = parseCodexContextRecords([
    { timestamp: "2026-08-25T01:03:53.000Z", type: "event_msg", payload: { type: "task_started" } },
    {
      timestamp: "2026-08-25T01:04:33.516Z",
      type: "compacted",
      payload: {
        message: "RESPONSE_MUST_NOT_LEAK",
        replacement_history: [{ private: "RESPONSE_MUST_NOT_LEAK" }],
        window_number: 3,
      },
    },
    tokenCount("2026-08-25T01:04:33.600Z", { input_tokens: 6_000, output_tokens: 628 }, { event_id: "after-manual" }),
    { timestamp: "2026-08-25T01:04:33.700Z", type: "event_msg", payload: { type: "item_completed", item: { type: "ContextCompaction" } } },
    { timestamp: "2026-08-25T01:04:33.800Z", type: "event_msg", payload: { type: "task_complete" } },
  ], { actorId: "primary", sourceKey: "thread-manual-receipt" });

  assert.deepEqual(compactions, [{
    actorId: "primary",
    timestamp: "2026-08-25T01:04:33.516Z",
    trigger: "manual",
    preTokens: null,
    inferred: true,
  }]);
  const { insights } = evaluateEfficiencySignals({
    agents: [{ id: "primary", label: "Primary agent", status: "idle", toolCalls: 0, tokens: { total: 6_628 } }],
    compactions,
  });
  assert.equal(insights[0].id, "healthy-flow");
  assertNoPrivateFixtureSentinels(compactions, "manual receipt evidence");
});

test("integrates primary and child latest snapshots into all-agent context", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-context-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "10");
  await mkdir(directory, { recursive: true });
  const parent = (await readProviderFixture("codex/parent.jsonl")).replaceAll("PRIVATE_PATH_MUST_NOT_LEAK", "synthetic");
  const child = (await readProviderFixture("codex/child.jsonl")).replaceAll("PRIVATE_PATH_MUST_NOT_LEAK", "synthetic");
  await writeFile(path.join(directory, "rollout-parent.jsonl"), parent, "utf8");
  await writeFile(path.join(directory, "rollout-child.jsonl"), child, "utf8");
  await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({
    id: "codex-fixture-parent",
    thread_name: "Codex context fixture",
    updated_at: "2026-08-10T13:00:17.000Z",
  })}\n`, "utf8");

  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, scanLimit: 10 });
  const evidence = await provider.readSession("codex-fixture-parent", { historical: true });
  assert.equal(provider.capabilities.cacheWriteUsage, false);
  assert.equal(provider.capabilities.cacheUsageClassification, false);
  assert.equal(evidence.efficiencyRuleEvidence.cacheUsageClassification, false);
  assert.deepEqual(evidence.usageSnapshots.map(({ actorId, input, output, cacheWrite, cacheRead }) => ({
    actorId, input, output, cacheWrite, cacheRead,
  })), [
    { actorId: "primary", input: 950, output: 120, cacheWrite: 50, cacheRead: 500 },
    { actorId: "agent-codex-fixture-child", input: 200, output: 30, cacheWrite: 0, cacheRead: 100 },
  ]);

  const state = monitorStateFromProviderEvidence("codex", evidence);
  assert.equal(state.agents.find((agent) => agent.id === "primary").tokens.total, 1_620);
  assert.equal(state.agents.find((agent) => agent.id === "agent-codex-fixture-child").tokens.total, 330);
  assert.equal(state.metrics.tokens.allAgents, 1_950);
  assert.equal(state.metrics.tokens.input, 1_150);
  assert.equal(state.metrics.tokens.output, 150);
  assert.equal(state.metrics.tokens.cacheWrite, 50);
  assert.equal(state.metrics.tokens.cacheRead, 600);
  assertNoPrivateFixtureSentinels(evidence, "Codex context provider evidence");
  assert.doesNotMatch(JSON.stringify(evidence), /total_token_usage|900000|980000/);
});

test("retains live Codex usage snapshots across a moving tail and resets on replacement or deletion", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-context-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "12");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "rollout-live-context-cache.jsonl");
  const session = {
    timestamp: "2026-08-12T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "live-context-cache",
      session_id: "live-context-cache",
      cwd: "C:\\synthetic\\context-cache",
      source: "cli",
    },
  };
  const turn = {
    timestamp: "2026-08-12T12:00:01.000Z",
    type: "turn_context",
    payload: { turn_id: "turn-live-context" },
  };
  const first = tokenCount("2026-08-12T12:00:02.000Z", { input_tokens: 100, output_tokens: 10 });
  const second = tokenCount("2026-08-12T12:00:03.000Z", { input_tokens: 200, output_tokens: 20 });
  const serialize = (records) => `${records.map(JSON.stringify).join("\n")}\n`;
  await writeFile(file, serialize([session, turn, first]), "utf8");

  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    maximumStateTailBytes: 2 * 1024,
  });
  const initial = await provider.readSession("live-context-cache", { historical: false });
  assert.deepEqual(initial.usageSnapshots.map(({ timestamp, input, output }) => ({ timestamp, input, output })), [
    { timestamp: first.timestamp, input: 100, output: 10 },
  ]);
  const firstDedupeId = initial.usageSnapshots[0].dedupeId;

  await appendFile(file, `${JSON.stringify({
    timestamp: "2026-08-12T12:00:02.500Z",
    type: "padding",
    payload: { value: "x".repeat(3_000) },
  })}\n${JSON.stringify(second)}\n`, "utf8");
  const afterAppend = await provider.readSession("live-context-cache", { historical: false });
  assert.deepEqual(afterAppend.usageSnapshots.map(({ timestamp, input, output }) => ({ timestamp, input, output })), [
    { timestamp: first.timestamp, input: 100, output: 10 },
    { timestamp: second.timestamp, input: 200, output: 20 },
  ]);
  assert.equal(afterAppend.usageSnapshots[0].dedupeId, firstDedupeId);

  const regrown = tokenCount("2026-08-12T12:00:04.000Z", { input_tokens: 250, output_tokens: 25 });
  await writeFile(file, serialize([session, turn, {
    timestamp: "2026-08-12T12:00:03.500Z",
    type: "padding",
    payload: { value: "y".repeat(3_000) },
  }, regrown]), "utf8");
  const afterRegrow = await provider.readSession("live-context-cache", { historical: false });
  assert.deepEqual(afterRegrow.usageSnapshots.map(({ timestamp, input, output }) => ({ timestamp, input, output })), [
    { timestamp: regrown.timestamp, input: 250, output: 25 },
  ]);

  const replacement = tokenCount("2026-08-12T12:01:00.000Z", { input_tokens: 300, output_tokens: 30 });
  await writeFile(file, serialize([session, turn, replacement]), "utf8");
  const afterReplacement = await provider.readSession("live-context-cache", { historical: false });
  assert.deepEqual(afterReplacement.usageSnapshots.map(({ timestamp, input, output }) => ({ timestamp, input, output })), [
    { timestamp: replacement.timestamp, input: 300, output: 30 },
  ]);

  await rm(file);
  assert.equal(await provider.readSession("live-context-cache", { historical: false }), null);
});

test("hydrates and retains live Codex compactions after they move outside the state tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-compaction-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "25");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "rollout-live-compaction-cache.jsonl");
  const session = {
    timestamp: "2026-08-25T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "live-compaction-cache",
      session_id: "live-compaction-cache",
      cwd: "C:\\synthetic\\compaction-cache",
      source: "cli",
    },
  };
  const receipt = [
    { timestamp: "2026-08-25T12:00:01.000Z", type: "turn_context", payload: { turn_id: "active-turn" } },
    tokenCount("2026-08-25T12:00:02.000Z", { input_tokens: 218_000, output_tokens: 159, total_tokens: 218_159 }, { event_id: "before-auto" }),
    { timestamp: "2026-08-25T12:00:03.000Z", type: "compacted", payload: { replacement_history: [{ private: "RESPONSE_MUST_NOT_LEAK" }], window_number: 2 } },
    { timestamp: "2026-08-25T12:00:03.100Z", type: "world_state", payload: {} },
    { timestamp: "2026-08-25T12:00:03.200Z", type: "turn_context", payload: { turn_id: "active-turn" } },
    tokenCount("2026-08-25T12:00:03.300Z", { input_tokens: 20_000, output_tokens: 100 }, { event_id: "after-auto" }),
    { timestamp: "2026-08-25T12:00:03.400Z", type: "event_msg", payload: { type: "item_completed", item: { type: "ContextCompaction" } } },
    { timestamp: "2026-08-25T12:00:03.500Z", type: "response_item", payload: { type: "reasoning" } },
  ];
  const serialize = (records) => `${records.map(JSON.stringify).join("\n")}\n`;
  await writeFile(file, serialize([session, ...receipt, {
    timestamp: "2026-08-25T12:00:04.000Z",
    type: "padding",
    payload: { value: "x".repeat(2 * 1024 * 1024 + 128 * 1024) },
  }]), "utf8");

  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    maximumStateTailBytes: 2 * 1024,
  });
  const hydrated = await provider.readSession("live-compaction-cache", { historical: false });
  assert.deepEqual(hydrated.usageSnapshots.map(({ timestamp, input, output }) => ({ timestamp, input, output })), [
    { timestamp: receipt[1].timestamp, input: 218_000, output: 159 },
    { timestamp: receipt[5].timestamp, input: 20_000, output: 100 },
  ]);
  assert.deepEqual(hydrated.compactions, [{
    actorId: "primary",
    timestamp: "2026-08-25T12:00:03.000Z",
    trigger: "auto",
    preTokens: 218_159,
    inferred: true,
  }]);

  await appendFile(file, `${JSON.stringify({
    timestamp: "2026-08-25T12:00:05.000Z",
    type: "padding",
    payload: { value: "y".repeat(9_000) },
  })}\n`, "utf8");
  const retained = await provider.readSession("live-compaction-cache", { historical: false });
  assert.deepEqual(retained.compactions, hydrated.compactions);
  const { insights } = evaluateEfficiencySignals({
    agents: retained.agents,
    compactions: retained.compactions,
    availableEvidence: retained.efficiencyRuleEvidence,
  });
  assert.equal(insights.some((insight) => insight.id === "automatic-compaction-primary"), true);
  assertNoPrivateFixtureSentinels(retained.compactions, "retained Codex compaction evidence");

  await writeFile(file, serialize([session, {
    timestamp: "2026-08-25T12:01:00.000Z",
    type: "padding",
    payload: { value: "z".repeat(3_000) },
  }]), "utf8");
  const replaced = await provider.readSession("live-compaction-cache", { historical: false });
  assert.deepEqual(replaced.compactions, []);
});

test("captures a live Codex compaction appended between polls beyond the state tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-compaction-gap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "25");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "rollout-live-compaction-gap.jsonl");
  const session = { timestamp: "2026-08-25T13:00:00.000Z", type: "session_meta", payload: { id: "live-compaction-gap", session_id: "live-compaction-gap", cwd: "C:\\synthetic\\compaction-gap", source: "cli" } };
  const serialize = (records) => `${records.map(JSON.stringify).join("\n")}\n`;
  await writeFile(file, serialize([session, tokenCount("2026-08-25T13:00:01.000Z", { input_tokens: 10_000, output_tokens: 10 }, { event_id: "initial" })]), "utf8");
  const provider = createCodexProvider({ codexHome: root, includeArchived: false, cacheMs: 0, maximumStateTailBytes: 2 * 1024, maximumTaskHistoryBytes: 16 * 1024 });
  const initial = await provider.readSession("live-compaction-gap", { historical: false });
  assert.deepEqual(initial.compactions, []);

  const receipt = [
    tokenCount("2026-08-25T13:00:02.000Z", { input_tokens: 210_000, output_tokens: 50, total_tokens: 210_050 }, { event_id: "before-gap-auto" }),
    { timestamp: "2026-08-25T13:00:03.000Z", type: "compacted", payload: { replacement_history: [], window_number: 2 } },
    { timestamp: "2026-08-25T13:00:03.100Z", type: "world_state", payload: {} },
    { timestamp: "2026-08-25T13:00:03.200Z", type: "turn_context", payload: { turn_id: "active-turn" } },
    tokenCount("2026-08-25T13:00:03.300Z", { input_tokens: 20_000, output_tokens: 100 }, { event_id: "after-gap-auto" }),
    { timestamp: "2026-08-25T13:00:03.400Z", type: "event_msg", payload: { type: "item_completed", item: { type: "ContextCompaction" } } },
    { timestamp: "2026-08-25T13:00:03.500Z", type: "response_item", payload: { type: "reasoning" } },
    { timestamp: "2026-08-25T13:00:04.000Z", type: "padding", payload: { value: "x".repeat(4_000) } },
  ];
  await appendFile(file, serialize(receipt), "utf8");
  const afterGap = await provider.readSession("live-compaction-gap", { historical: false });
  assert.equal(afterGap.compactions[0]?.trigger, "auto");
  assert.equal(evaluateEfficiencySignals({ agents: afterGap.agents, compactions: afterGap.compactions }).insights.some((insight) => insight.id === "automatic-compaction-primary"), true);
});

test("upgrades partial live Codex compaction evidence when its completion arrives", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-compaction-upgrade-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "25");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "rollout-live-compaction-upgrade.jsonl");
  const session = { timestamp: "2026-08-25T14:00:00.000Z", type: "session_meta", payload: { id: "live-compaction-upgrade", session_id: "live-compaction-upgrade", cwd: "C:\\synthetic\\compaction-upgrade", source: "cli" } };
  const before = tokenCount("2026-08-25T14:00:01.000Z", { input_tokens: 205_000, output_tokens: 25, total_tokens: 205_025 }, { event_id: "before-upgrade" });
  const compacted = { timestamp: "2026-08-25T14:00:02.000Z", type: "compacted", payload: { replacement_history: [], window_number: 2 } };
  const serialize = (records) => `${records.map(JSON.stringify).join("\n")}\n`;
  await writeFile(file, serialize([session, before, compacted]), "utf8");
  const provider = createCodexProvider({ codexHome: root, includeArchived: false, cacheMs: 0, maximumStateTailBytes: 2 * 1024, maximumTaskHistoryBytes: 8 * 1024 });
  const partial = await provider.readSession("live-compaction-upgrade", { historical: false });
  assert.equal(partial.compactions[0]?.trigger, "unknown");

  await appendFile(file, serialize([
    { timestamp: "2026-08-25T14:00:02.100Z", type: "world_state", payload: {} },
    { timestamp: "2026-08-25T14:00:02.200Z", type: "turn_context", payload: { turn_id: "active-turn" } },
    tokenCount("2026-08-25T14:00:02.300Z", { input_tokens: 18_000, output_tokens: 100 }, { event_id: "after-upgrade" }),
    { timestamp: "2026-08-25T14:00:02.400Z", type: "event_msg", payload: { type: "item_completed", item: { type: "ContextCompaction" } } },
    { timestamp: "2026-08-25T14:00:02.500Z", type: "response_item", payload: { type: "reasoning" } },
  ]), "utf8");
  const completed = await provider.readSession("live-compaction-upgrade", { historical: false });
  assert.deepEqual(completed.compactions, [{ actorId: "primary", timestamp: compacted.timestamp, trigger: "auto", preTokens: 205_025, inferred: true }]);
});

test("keeps hydrated automatic evidence when the smaller live tail sees only an ambiguous boundary", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-compaction-strength-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "25");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "rollout-live-compaction-strength.jsonl");
  const session = { timestamp: "2026-08-25T15:00:00.000Z", type: "session_meta", payload: { id: "live-compaction-strength", session_id: "live-compaction-strength", cwd: "C:\\synthetic\\compaction-strength", source: "cli" } };
  const before = tokenCount("2026-08-25T15:00:01.000Z", { input_tokens: 215_000, output_tokens: 25, total_tokens: 215_025 }, { event_id: "before-strength" });
  const compacted = { timestamp: "2026-08-25T15:00:02.000Z", type: "compacted", payload: { replacement_history: [], window_number: 2 } };
  const records = [
    session,
    before,
    compacted,
    { timestamp: "2026-08-25T15:00:02.100Z", type: "world_state", payload: {} },
    { timestamp: "2026-08-25T15:00:02.200Z", type: "turn_context", payload: { turn_id: "active-turn" } },
    tokenCount("2026-08-25T15:00:02.300Z", { input_tokens: 18_000, output_tokens: 100 }, { event_id: "after-strength" }),
    { timestamp: "2026-08-25T15:00:02.400Z", type: "event_msg", payload: { type: "item_completed", item: { type: "ContextCompaction" } } },
    { timestamp: "2026-08-25T15:00:02.500Z", type: "response_item", payload: { type: "reasoning" } },
    { timestamp: "2026-08-25T15:00:03.000Z", type: "padding", payload: { value: "x".repeat(1_650) } },
  ];
  await writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  const provider = createCodexProvider({ codexHome: root, includeArchived: false, cacheMs: 0, maximumStateTailBytes: 2 * 1024, maximumTaskHistoryBytes: 8 * 1024 });
  const evidence = await provider.readSession("live-compaction-strength", { historical: false });
  assert.deepEqual(evidence.compactions, [{ actorId: "primary", timestamp: compacted.timestamp, trigger: "auto", preTokens: 215_025, inferred: true }]);
});

test("stable live Codex fallback identities do not depend on tail turn context or fallback time", () => {
  const usage = tokenCount(undefined, { input_tokens: 100, output_tokens: 10 });
  const withTurn = parseCodexContextRecords([
    { timestamp: "2026-08-12T12:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-before-tail" } },
    usage,
  ], {
    actorId: "primary",
    sourceKey: "thread-live",
    fallbackTimestamp: "2026-08-12T12:01:00.000Z",
    stableFallbackIdentity: true,
  }).usageSnapshots;
  const tailOnly = parseCodexContextRecords([usage], {
    actorId: "primary",
    sourceKey: "thread-live",
    fallbackTimestamp: "2026-08-12T12:02:00.000Z",
    stableFallbackIdentity: true,
  }).usageSnapshots;

  assert.equal(withTurn[0].dedupeId, tailOnly[0].dedupeId);
});
