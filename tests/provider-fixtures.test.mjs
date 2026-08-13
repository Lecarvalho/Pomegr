import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoPrivateFixtureSentinels,
  PRIVATE_FIXTURE_SENTINELS,
  monitorStateFromProviderEvidence,
  readProviderFixture,
  readProviderJsonFixture,
  readProviderJsonlFixture,
} from "./helpers/provider-fixtures.mjs";

const fixturePaths = [
  "claude/session.jsonl",
  "claude/subagent.jsonl",
  "claude/malformed.jsonl",
  "claude/registry.json",
  "claude/task.json",
  "claude/statusline.json",
  "codex/parent.jsonl",
  "codex/child.jsonl",
  "codex/malformed.jsonl",
  "codex/approval-plan.jsonl",
  "codex/plan-missing.jsonl",
  "codex/plan-malformed.jsonl",
];

test("synthetic fixtures contain every privacy sentinel", async () => {
  const loadedFixtures = await Promise.all(fixturePaths.map(async (fixturePath) => [fixturePath, await readProviderFixture(fixturePath)]));
  for (const [fixturePath, contents] of loadedFixtures) {
    assert.equal(Buffer.byteLength(contents) <= 8 * 1024, true, `${fixturePath} must remain bounded`);
  }
  const rawFixtures = loadedFixtures.map(([, contents]) => contents).join("\n");
  for (const sentinel of PRIVATE_FIXTURE_SENTINELS) {
    assert.equal(rawFixtures.includes(sentinel), true, `fixtures do not exercise ${sentinel}`);
  }
});

test("Claude fixtures cover current normalized extraction inputs", async () => {
  const { records } = await readProviderJsonlFixture("claude/session.jsonl");
  const { records: subagentRecords } = await readProviderJsonlFixture("claude/subagent.jsonl");
  const toolNames = new Set(records.flatMap((record) => record.message?.content || []).map((item) => item.name).filter(Boolean));

  assert.equal(records.some((record) => record.type === "custom-title" && record.cwd && record.gitBranch), true);
  assert.equal(records.some((record) => record.permissionMode), true);
  assert.equal(records.some((record) => record.message?.usage), true);
  assert.deepEqual([...toolNames].sort(), [
    "Agent",
    "AskUserQuestion",
    "Bash",
    "Skill",
    "Write",
    "mcp__pomegr__report_agent_signal",
    "mcp__pomegr__report_session_signal",
    "mcp__pomegr__report_task_signal",
  ]);
  assert.equal(records.some((record) => record.type === "queue-operation"), true);
  assert.equal(records.some((record) => record.subtype === "away_summary"), true);
  assert.equal(records.some((record) => record.subtype === "local_command"), true);
  assert.equal(records.some((record) => record.subtype === "compact_boundary"), true);
  assert.equal(subagentRecords.some((record) => record.attributionAgent === "reviewer"), true);
  assert.equal((await readProviderJsonFixture("claude/registry.json")).needsInput, true);
  assert.equal((await readProviderJsonFixture("claude/task.json")).status, "in_progress");
  assert.equal(typeof (await readProviderJsonFixture("claude/statusline.json")).cost.total_cost_usd, "number");
});

test("Codex rollout fixtures cover metadata, usage, and supported item lifecycles", async () => {
  const { records } = await readProviderJsonlFixture("codex/parent.jsonl");
  const { records: childRecords } = await readProviderJsonlFixture("codex/child.jsonl");
  const responseItems = records.filter((record) => record.type === "response_item").map((record) => record.payload);
  const calls = new Set(responseItems.filter((item) => item.type.endsWith("_call")).map((item) => item.name));

  assert.equal(records.some((record) => record.type === "session_meta"), true);
  assert.equal(records.some((record) => record.type === "turn_context"), true);
  assert.equal(records.some((record) => record.payload?.type === "token_count" && record.payload.info.last_token_usage), true);
  assert.equal(calls.has("shell_command"), true);
  assert.equal(calls.has("apply_patch"), true);
  assert.equal(calls.has("mcp__pomegr__report_session_signal"), true);
  assert.equal(calls.has("synthetic_dynamic_tool"), true);
  assert.equal(calls.has("spawn_agent"), true);
  assert.equal(calls.has("request_user_input"), true);
  assert.equal(responseItems.filter((item) => item.type.endsWith("_output")).length, 6);
  assert.equal(childRecords[0].payload.parent_thread_id, "codex-fixture-parent");
  assert.equal(childRecords.some((record) => record.payload?.type === "token_count"), true);
});

test("Codex plan fixtures cover structured status snapshots, missing plans, and malformed updates", async () => {
  const { records } = await readProviderJsonlFixture("codex/approval-plan.jsonl");
  const { records: missingRecords } = await readProviderJsonlFixture("codex/plan-missing.jsonl");
  const { records: malformedRecords, rejectedLines } = await readProviderJsonlFixture("codex/plan-malformed.jsonl");
  const structured = records.find((record) => record.type === "turn/plan/updated")?.payload?.plan || [];

  assert.deepEqual(structured.map((step) => step.status), ["completed", "inProgress", "pending"]);
  assert.equal(missingRecords.some((record) => record.payload?.type === "plan"), true);
  assert.equal(malformedRecords.some((record) => record.payload?.name === "update_plan"), true);
  assert.equal(rejectedLines.length, 1);
});

test("bounded JSONL fixture reader skips malformed and truncated lines but keeps unknown records", async () => {
  for (const provider of ["claude", "codex"]) {
    const { records, rejectedLines } = await readProviderJsonlFixture(`${provider}/malformed.jsonl`);
    assert.equal(records.length, 2);
    assert.equal(rejectedLines.length, 2);
    assert.equal(records.some((record) => record.type === "future-record" || record.type === "future_record"), true);
    assert.equal(rejectedLines.every((line) => line.byteLength < 512), true);
  }
});

test("serialized MonitorState fixtures for both providers exclude every private sentinel", async () => {
  for (const provider of ["claude", "codex"]) {
    const evidence = await readProviderJsonFixture(`${provider}/expected-session-evidence.json`);
    const state = monitorStateFromProviderEvidence(provider, evidence);
    assert.equal(state.source, provider === "claude" ? "Claude Code" : "Codex");
    assert.equal(state.session.id, `${provider}:${evidence.localId}`);
    assert.equal(state.metrics.agents, evidence.agents.length);
    if (provider === "codex") {
      assert.equal(state.toolPatterns.reduce((total, pattern) => total + pattern.calls, 0), state.metrics.toolCalls);
    }
    assertNoPrivateFixtureSentinels(JSON.stringify(state), `${provider} MonitorState`);
  }

  assert.throws(
    () => assertNoPrivateFixtureSentinels({ session: { title: "PROMPT_MUST_NOT_LEAK" } }),
    /leaked PROMPT_MUST_NOT_LEAK/,
  );
});
