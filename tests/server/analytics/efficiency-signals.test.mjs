import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contextCompactions, readContextCompactions } from "../../../server/normalize/context-compactions.mjs";
import { EFFICIENCY_SIGNAL_RULES, evaluateEfficiencySignals } from "../../../server/analytics/efficiency-signals.mjs";

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
    agentId: "primary",
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

test("ambiguous triggerless provider compaction does not emit an efficiency signal", () => {
  const { insights } = evaluateEfficiencySignals({
    agents: [primary({ toolCalls: 0, tokens: { total: 20_000 } })],
    compactions: [{
      actorId: "primary",
      timestamp: "2026-08-25T00:36:36.233Z",
      trigger: "unknown",
      preTokens: null,
    }],
  });

  assert.equal(insights.length, 1);
  assert.equal(insights[0].id, "healthy-flow");
});

test("inferred automatic compaction emits a warning with transparent lifecycle copy", () => {
  const { insights } = evaluateEfficiencySignals({
    agents: [primary({ toolCalls: 0, tokens: { total: 20_000 } })],
    compactions: [{
      actorId: "primary",
      timestamp: "2026-08-25T00:36:36.233Z",
      trigger: "auto",
      preTokens: 235_253,
      inferred: true,
    }],
  });

  assert.deepEqual(insights, [{
    id: "automatic-compaction-primary",
    agentId: "primary",
    level: "warning",
    title: "Primary agent context was automatically compacted",
    detail: "Codex compacted context during an active task and resumed that task at 235.3K context. Pomegr classifies this recorded lifecycle as automatic; this rollout did not persist the provider trigger itself. Earlier conversation detail was summarized to continue the session. Consider delegating or starting a focused follow-up before context pressure builds again.",
  }]);
});

test("full transcript scans retain only bounded compaction events", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-compactions-"));
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
  assert.deepEqual(insights.filter((insight) => insight.id.startsWith("loop-")).map((insight) => insight.agentId), ["primary", "primary", "primary"]);
  assert.deepEqual(insights.filter((insight) => insight.id.startsWith("overlap-")).map((insight) => insight.agentId), [null, null]);
});

test("repeated Pomegr reporting calls are not loops, but repeated Pomegr reads still are", () => {
  const actor = { id: "primary", label: "Primary agent" };
  const repeated = (tool, detail) => ({ actor, tool, detail, count: 5 });
  const { insights, loops } = evaluateEfficiencySignals({
    agents: [primary({ toolCalls: 0, tokens: { total: 0 } })],
    repetitionCandidates: [
      repeated("mcp__plugin_pomegr_pomegr__report_session_progress", ""),
      repeated("mcp__pomegr__report_session_signal", ""),
      repeated("mcp__plugin_pomegr_pomegr__clear_agent_signal", ""),
      repeated("mcp__plugin_pomegr_pomegr__rename_session", ""),
      repeated("MCP", "pomegr / report_task_signal"),
      repeated("MCP", "other / report_session_progress"),
      repeated("mcp__plugin_pomegr_pomegr__get_session_report", ""),
    ],
  });
  assert.deepEqual(loops.map((loop) => [loop.tool, loop.detail]), [
    ["MCP", "other / report_session_progress"],
    ["mcp__plugin_pomegr_pomegr__get_session_report", ""],
  ]);
  assert.equal(insights.filter((insight) => insight.id.startsWith("loop-")).length, 2);
});

test("user-input attention stays out of the efficiency signal catalog", () => {
  const { insights } = evaluateEfficiencySignals({
    agents: [primary({ status: "needs_input", toolCalls: 0, tokens: { total: 0 } })],
  });
  assert.equal(insights.some((insight) => insight.id.startsWith("needs-input-")), false);
  assert.equal(insights[0].id, "healthy-flow");
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

test("normalized miss-refill events produce cautious bounded insights", () => {
  const missRefill = {
    id: "cache-opaque",
    agentId: "primary",
    kind: "miss_refill",
    observedAt: "2026-08-11T11:00:00.000Z",
    promptInputTokens: 16_000,
    cacheReadPercent: 5,
    cacheWriteTokens: 8_000,
    previousCacheReadPercent: 80,
    gapMs: 25 * 60 * 60 * 1_000,
    relatedEventId: null,
  };
  const { insights } = evaluateEfficiencySignals({
    agents: [primary({ toolCalls: 0, tokens: { total: 8_000 } })],
    cacheEvents: [missRefill, missRefill],
    availableEvidence: {
      repetition: false,
      concurrentMutation: false,
      unsharedContext: false,
      healthyFallback: false,
      cacheUsageClassification: true,
    },
  });

  assert.deepEqual(insights, [{
    id: "prompt-cache-miss-primary",
    level: "warning",
    agentId: "primary",
    title: "Prompt cache miss and refill after idle gap",
    detail: "Primary agent's prompt input was 16K with 5% read from cache after 25 hours. The preceding comparable request read 80% from cache, and the provider recorded an 8K cache refill. Cache expiration or eviction may have reduced efficiency, but a changed prefix, cache key, or routing can produce the same pattern.",
  }]);
  assert.doesNotMatch(JSON.stringify(insights), /charged|price|billing|paid|cache key value/i);
});

test("refill and reuse facts do not produce warnings and provider evidence gates misses", () => {
  const base = {
    id: "cache-opaque",
    agentId: "primary",
    observedAt: "2026-08-10T10:00:00.000Z",
    promptInputTokens: 10_000,
    cacheReadPercent: 0,
    cacheWriteTokens: 8_000,
    previousCacheReadPercent: null,
    gapMs: null,
    relatedEventId: null,
  };
  const facts = evaluateEfficiencySignals({
    agents: [primary()],
    cacheEvents: [{ ...base, kind: "refill" }, { ...base, id: "reuse", kind: "reuse", cacheReadPercent: 90 }],
    availableEvidence: { cacheUsageClassification: true },
  });
  assert.equal(facts.insights.some((insight) => insight.id === "prompt-cache-miss-primary"), false);
  const disabled = evaluateEfficiencySignals({
    agents: [primary()],
    cacheEvents: [{ ...base, kind: "miss_refill", previousCacheReadPercent: 90, gapMs: 1_800_000 }],
    availableEvidence: { cacheUsageClassification: false },
  });
  assert.equal(disabled.insights.some((insight) => insight.id === "prompt-cache-miss-primary"), false);
});

const reviewer = { id: "agent-review", label: "Reviewer", status: "finished", toolCalls: 4, tokens: { total: 1_000 } };
const tester = { id: "agent-test", label: "Tester", status: "finished", toolCalls: 4, tokens: { total: 1_000 } };

function change(actorId, filePath, overrides = {}) {
  return { actorId, repositoryId: "repo-000000000000000000000001", path: filePath, previousPath: null, ...overrides };
}

function exclusiveChanges(actorId, count, prefix = "src/file") {
  return Array.from({ length: count }, (_, index) => change(actorId, `${prefix}-${index}.ts`));
}

test("a file changed by more than one agent emits a bounded warning without its path", () => {
  const { insights } = evaluateEfficiencySignals({
    agents: [primary({ toolCalls: 0, tokens: { total: 0 } }), reviewer],
    fileChanges: [
      change("primary", "server/deep/private-dir/index.ts"),
      change("primary", "server/deep/private-dir/index.ts"),
      change("agent-review", "server/deep/private-dir/index.ts"),
      change("primary", "server/only-primary.ts"),
    ],
  });

  assert.equal(insights.length, 1);
  const [insight] = insights;
  assert.match(insight.id, /^shared-file-[a-f0-9]{12}$/);
  assert.deepEqual({ ...insight, id: "opaque" }, {
    id: "opaque",
    agentId: null,
    level: "warning",
    title: "2 agents changed index.ts",
    detail: "Primary agent and Reviewer each recorded changes to this file in this session (3 recorded changes). Check that their assignments did not overlap; a planned handoff such as a review fix also produces this pattern.",
  });
  assert.doesNotMatch(JSON.stringify(insights), /private-dir|server\//);
});

test("shared-file identity keeps repository and directory apart and follows recorded moves", () => {
  const agents = [primary({ toolCalls: 0, tokens: { total: 0 } }), reviewer];
  const distinct = evaluateEfficiencySignals({
    agents,
    fileChanges: [
      change("primary", "app/index.ts"),
      change("agent-review", "server/index.ts"),
      change("primary", "src/shared.ts"),
      change("agent-review", "src/shared.ts", { repositoryId: "repo-000000000000000000000002" }),
    ],
  });
  assert.equal(distinct.insights.some((insight) => insight.id.startsWith("shared-file-")), false);

  const moved = evaluateEfficiencySignals({
    agents,
    fileChanges: [
      change("primary", "src/old-name.ts"),
      change("agent-review", "src/new-name.ts", { previousPath: "src/old-name.ts" }),
    ],
  });
  assert.deepEqual(moved.insights.map((insight) => insight.title), ["2 agents changed old-name.ts"]);
});

test("shared-file signals ignore unobserved agents, order by breadth, cap, and skip concurrent overlaps", () => {
  const agents = [primary({ toolCalls: 0, tokens: { total: 0 } }), reviewer, tester];
  const fileChanges = [
    change("primary", "src/a.ts"), change("agent-review", "src/a.ts"),
    change("primary", "src/b.ts"), change("agent-review", "src/b.ts"), change("agent-test", "src/b.ts"),
    change("primary", "src/c.ts"), change("agent-review", "src/c.ts"), change("agent-review", "src/c.ts"),
    change("primary", "src/d.ts"), change("agent-test", "src/d.ts"),
    change("primary", "src/e.ts"), change("agent-unobserved", "src/e.ts"),
  ];
  const { insights } = evaluateEfficiencySignals({ agents, fileChanges });
  assert.deepEqual(insights.map((insight) => insight.title), [
    "3 agents changed b.ts",
    "2 agents changed c.ts",
    "2 agents changed a.ts",
  ]);
  assert.equal(insights[0].detail.startsWith("Primary agent, Reviewer, and Tester each recorded"), true);

  const withOverlap = evaluateEfficiencySignals({
    agents,
    fileChanges,
    overlaps: [{ display: "B.ts", actors: new Set(["primary", "agent-review"]), calls: 2 }],
  });
  assert.deepEqual(withOverlap.insights.map((insight) => insight.title), [
    "Concurrent edits may conflict in B.ts",
    "2 agents changed c.ts",
    "2 agents changed a.ts",
    "2 agents changed d.ts",
  ]);
});

test("an agent that alone changed the documented number of files emits a breadth warning", () => {
  const minimum = EFFICIENCY_SIGNAL_RULES.broadFileChanges.minimumExclusiveFiles;
  const agents = [primary({ toolCalls: 0, tokens: { total: 0 } }), reviewer];
  const { insights } = evaluateEfficiencySignals({
    agents,
    fileChanges: [...exclusiveChanges("primary", minimum), ...exclusiveChanges("primary", 3)],
  });
  assert.deepEqual(insights, [{
    id: "broad-file-changes-primary",
    agentId: "primary",
    level: "warning",
    title: `Primary agent changed ${minimum} files alone`,
    detail: "No other agent recorded a change to any of these files in this session. Consider splitting broad work into bounded tasks that are easier to review or delegate.",
  }]);

  const belowMinimum = evaluateEfficiencySignals({ agents, fileChanges: exclusiveChanges("primary", minimum - 1) });
  assert.deepEqual(belowMinimum.insights.map((insight) => insight.id), ["healthy-flow"]);
});

test("breadth counts only files no other agent changed and counts a move once", () => {
  const minimum = EFFICIENCY_SIGNAL_RULES.broadFileChanges.minimumExclusiveFiles;
  const agents = [primary({ toolCalls: 0, tokens: { total: 0 } }), reviewer];
  const shared = evaluateEfficiencySignals({
    agents,
    fileChanges: [...exclusiveChanges("primary", minimum), change("agent-review", "src/file-0.ts")],
  });
  assert.equal(shared.insights.some((insight) => insight.id.startsWith("broad-file-changes-")), false);
  assert.equal(shared.insights.some((insight) => insight.id.startsWith("shared-file-")), true);

  const moves = Array.from({ length: minimum - 1 }, (_, index) => change("agent-review", `src/moved-${index}.ts`, {
    previousPath: `src/original-${index}.ts`,
  }));
  const moved = evaluateEfficiencySignals({ agents, fileChanges: moves });
  assert.equal(moved.insights.some((insight) => insight.id.startsWith("broad-file-changes-")), false);

  const subagent = evaluateEfficiencySignals({ agents, fileChanges: exclusiveChanges("agent-review", minimum) });
  assert.deepEqual(subagent.insights.map((insight) => [insight.id, insight.agentId, insight.title]), [
    ["broad-file-changes-agent-review", "agent-review", `Reviewer changed ${minimum} files alone`],
  ]);
});
