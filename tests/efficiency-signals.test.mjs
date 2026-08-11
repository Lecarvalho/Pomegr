import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contextCompactions, readContextCompactions } from "../monitor/context-compactions.mjs";
import { EFFICIENCY_SIGNAL_RULES, evaluateEfficiencySignals } from "../monitor/efficiency-signals.mjs";

function primary(overrides = {}) {
  return {
    id: "primary",
    label: "Primary agent",
    status: "active",
    toolCalls: EFFICIENCY_SIGNAL_RULES.unsharedContextPressure.minimumPrimaryToolCalls,
    tokens: { total: EFFICIENCY_SIGNAL_RULES.unsharedContextPressure.minimumPrimaryContext },
    ...overrides,
  };
}

test("unshared context pressure triggers at the documented boundaries", () => {
  const { insights } = evaluateEfficiencySignals({ agents: [primary()] });
  assert.deepEqual(insights, [{
    id: "unshared-context-pressure",
    level: "warning",
    title: "Large primary context, no delegation observed",
    detail: "The primary agent's current context is 150K after 40 tool calls. No subagent transcript was observed. Consider delegating the next bounded, independent task.",
  }]);
});

test("unshared context pressure requires context, sustained tool use, and no observed subagent", () => {
  const contextRule = EFFICIENCY_SIGNAL_RULES.unsharedContextPressure;
  const cases = [
    [primary({ tokens: { total: contextRule.minimumPrimaryContext - 1 } })],
    [primary({ toolCalls: contextRule.minimumPrimaryToolCalls - 1 })],
    [primary(), { id: "agent-review", label: "Reviewer", status: "finished", toolCalls: 1, tokens: { total: 1_000 } }],
  ];

  for (const agents of cases) {
    const { insights } = evaluateEfficiencySignals({ agents });
    assert.equal(insights.some((insight) => insight.id === "unshared-context-pressure"), false);
    assert.equal(insights[0].id, "healthy-flow");
  }
});

test("automatic context compaction emits a warning with bounded event metadata", () => {
  const compactions = contextCompactions([{
    type: "system",
    subtype: "compact_boundary",
    content: "PRIVATE PROVIDER CONTENT",
    timestamp: "2026-08-10T18:30:00.000Z",
    compactMetadata: {
      trigger: "auto",
      preTokens: 207_400,
      privateField: "PRIVATE METADATA",
    },
  }, {
    type: "user",
    isCompactSummary: true,
    message: { content: "PRIVATE COMPACTED SUMMARY" },
  }]).map((compaction) => ({
    ...compaction,
    actor: { id: "primary", label: "Primary agent" },
  }));

  assert.deepEqual(compactions, [{
    actor: { id: "primary", label: "Primary agent" },
    trigger: "auto",
    preTokens: 207_400,
    timestamp: "2026-08-10T18:30:00.000Z",
  }]);
  assert.doesNotMatch(JSON.stringify(compactions), /PRIVATE/);

  const { insights } = evaluateEfficiencySignals({
    agents: [primary({ toolCalls: 0, tokens: { total: 20_000 } })],
    compactions,
  });
  assert.deepEqual(insights, [{
    id: "automatic-compaction-primary",
    level: "warning",
    title: "Primary agent context was automatically compacted",
    detail: "The provider automatically compacted this agent's conversation at 207.4K context. Earlier conversation detail was summarized to continue the session. Consider delegating or starting a focused follow-up before context pressure builds again.",
  }]);
});

test("manual compaction does not emit an efficiency warning", () => {
  const compactions = contextCompactions([{
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: { trigger: "manual", preTokens: 131_367 },
  }]).map((compaction) => ({
    ...compaction,
    actor: { id: "primary", label: "Primary agent" },
  }));
  const { insights } = evaluateEfficiencySignals({
    agents: [primary({ toolCalls: 0, tokens: { total: 20_000 } })],
    compactions,
  });

  assert.equal(insights[0].id, "healthy-flow");
});

test("full transcript scans retain only bounded compaction events", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "threadlight-compactions-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, "session.jsonl");
  await fs.writeFile(transcript, [
    JSON.stringify({ type: "user", message: { content: "PRIVATE PROMPT" } }),
    "invalid json",
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      content: "PRIVATE PROVIDER CONTENT",
      timestamp: "2026-08-10T18:30:00.000Z",
      compactMetadata: { trigger: "auto", preTokens: 207_400, privateField: "PRIVATE METADATA" },
    }),
  ].join("\n"));

  const compactions = await readContextCompactions(transcript);
  assert.deepEqual(compactions, [{
    trigger: "auto",
    preTokens: 207_400,
    timestamp: "2026-08-10T18:30:00.000Z",
  }]);
  assert.doesNotMatch(JSON.stringify(compactions), /PRIVATE/);
});

test("the centralized catalog selects and caps repetition and overlap signals", () => {
  const actor = { id: "primary", label: "Primary agent" };
  const repetitionCandidates = [6, 5, 4, 3, 2].map((count, index) => ({
    actor,
    tool: `Tool${index}`,
    detail: "target",
    count,
  }));
  const overlaps = ["one.js", "two.js", "three.js"].map((display) => ({
    display,
    actors: new Set(["primary", "agent-review"]),
    calls: 2,
  }));

  const { insights, loops } = evaluateEfficiencySignals({
    agents: [primary({ toolCalls: 0, tokens: { total: 0 } })],
    repetitionCandidates,
    overlaps,
  });

  assert.deepEqual(loops.map((loop) => loop.count), [6, 5, 4, 3]);
  assert.equal(insights.filter((insight) => insight.id.startsWith("loop-")).length, 3);
  assert.equal(insights.filter((insight) => insight.id.startsWith("overlap-")).length, 2);
});

test("user-input attention remains part of the centralized signal catalog", () => {
  const { insights } = evaluateEfficiencySignals({
    agents: [primary({ status: "needs_input", toolCalls: 0, tokens: { total: 0 } })],
  });
  assert.equal(insights[0].id, "needs-input-primary");
  assert.equal(insights.some((insight) => insight.id === "healthy-flow"), false);
});

test("missing provider evidence disables dependent rules and the healthy fallback", () => {
  const actor = { id: "primary", label: "Primary agent" };
  const { insights, loops } = evaluateEfficiencySignals({
    agents: [primary()],
    repetitionCandidates: [{ actor, tool: "Shell", detail: "Command execution", count: 4 }],
    overlaps: [{ display: "index.ts", actors: new Set(["primary", "agent-review"]), calls: 2 }],
    availableEvidence: {
      repetition: false,
      concurrentMutation: false,
      unsharedContext: false,
      healthyFallback: false,
    },
  });

  assert.deepEqual(loops, []);
  assert.deepEqual(insights, []);
});
