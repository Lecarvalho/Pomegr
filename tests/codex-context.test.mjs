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
  for (let index = 0; index < 105; index += 1) records.push(
    { timestamp: new Date(Date.parse("2026-08-10T12:00:00.000Z") + index).toISOString(), type: "turn_context", payload: { turn_id: `bounded-${index}`, model: "gpt-5.6" } },
    tokenCount(new Date(Date.parse("2026-08-10T12:00:00.000Z") + index).toISOString(), { input_tokens: 100 + index, output_tokens: 1 }, { event_id: `bounded-${index}` }),
  );

  const { usageSnapshots } = parseCodexContextRecords(records, { actorId: "primary", sourceKey: "thread-1" });
  assert.equal(usageSnapshots.length, 100);
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
  ], { actorId: "primary", sourceKey: "thread-1" });

  assert.deepEqual(compactions, [
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
