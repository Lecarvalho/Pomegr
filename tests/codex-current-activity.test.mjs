import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_CURRENT_ACTIVITY_MAX_LENGTH,
  parseCodexCurrentActivityRecords,
  parseCodexCurrentActivityStateRecords,
} from "../monitor/providers/codex-current-activity.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { monitorStateFromProviderEvidence } from "./helpers/provider-fixtures.mjs";

const eventSummary = (timestamp, text) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "agent_reasoning", text },
});

const responseSummary = (timestamp, ...text) => ({
  timestamp,
  type: "response_item",
  payload: {
    type: "reasoning",
    encrypted_content: "ENCRYPTED_REASONING_MUST_NOT_LEAK",
    summary: text.map((value) => ({ type: "summary_text", text: value })),
  },
});

test("deduplicates Codex activity representations and replaces them with the latest valid summary", () => {
  const activity = parseCodexCurrentActivityRecords([
    eventSummary("2026-08-12T12:00:01.000Z", "**Planning detailed shell stage logging**"),
    responseSummary("2026-08-12T12:00:01.000Z", "**Planning detailed shell stage logging**"),
    eventSummary("2026-08-12T12:00:02.000Z", "**Checking responsive activity layout**"),
  ], { agentStatus: "active" });

  assert.deepEqual(activity, {
    label: "Checking responsive activity layout",
    observedAt: "2026-08-12T12:00:02.000Z",
  });
  assert.doesNotMatch(JSON.stringify(activity), /ENCRYPTED_REASONING_MUST_NOT_LEAK/);
});

test("keeps activity scoped to an open live turn and clears every recognized terminal shape", () => {
  const terminalRecords = [
    { type: "event_msg", payload: { type: "task_complete" } },
    { type: "event_msg", payload: { type: "task_failed" } },
    { type: "event_msg", payload: { type: "turn_aborted" } },
    { type: "event_msg", payload: { type: "turn_interrupted" } },
    { type: "turn_completed", payload: { status: "completed" } },
  ];
  for (const terminal of terminalRecords) {
    assert.equal(parseCodexCurrentActivityRecords([
      eventSummary("2026-08-12T12:00:01.000Z", "**Working safely**"),
      { timestamp: "2026-08-12T12:00:02.000Z", ...terminal },
    ], { agentStatus: "active" }), null);
  }
  for (const agentStatus of ["finished", "stopped", "idle"]) {
    assert.equal(parseCodexCurrentActivityRecords([
      eventSummary("2026-08-12T12:00:01.000Z", "**Working safely**"),
    ], { agentStatus }), null);
  }
  assert.equal(parseCodexCurrentActivityRecords([
    eventSummary("2026-08-12T12:00:01.000Z", "**Working safely**"),
  ], { historical: true, agentStatus: "active" }), null);
});

test("keeps an open-turn heading stable across heuristic idle gaps and unrelated later records", () => {
  const records = [
    { timestamp: "2026-08-12T12:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-1" } },
    eventSummary("2026-08-12T12:00:01.000Z", "**Adjusting node positions and labels**"),
    { timestamp: "2026-08-12T12:01:24.000Z", type: "event_msg", payload: { type: "token_count" } },
  ];
  const expected = {
    label: "Adjusting node positions and labels",
    observedAt: "2026-08-12T12:00:01.000Z",
  };

  assert.deepEqual(parseCodexCurrentActivityRecords(records, { agentStatus: "active" }), expected);
  assert.deepEqual(parseCodexCurrentActivityRecords(records, {
    agentStatus: "idle",
    rolloutHeuristicIdle: true,
  }), expected);
});

test("carries normalized activity across a bounded-tail gap and clears it on lifecycle transitions", () => {
  const initial = parseCodexCurrentActivityStateRecords([
    { timestamp: "2026-08-12T12:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-1" } },
    eventSummary("2026-08-12T12:00:01.000Z", "**Stable live heading**"),
  ], { agentStatus: "active" });
  const carried = parseCodexCurrentActivityStateRecords([
    { timestamp: "2026-08-12T12:00:02.000Z", type: "event_msg", payload: { type: "token_count" } },
  ], { agentStatus: "active", existingState: initial });

  assert.deepEqual(carried, initial);

  const cleared = parseCodexCurrentActivityStateRecords([
    { timestamp: "2026-08-12T12:00:03.000Z", type: "turn_completed", payload: { status: "completed" } },
    responseSummary("2026-08-12T12:00:04.000Z", "**Late duplicate**"),
  ], { agentStatus: "active", existingState: carried });
  assert.deepEqual(cleared, { currentActivity: null, turnOpen: false });

  const nextTurn = parseCodexCurrentActivityStateRecords([
    { timestamp: "2026-08-12T12:00:05.000Z", type: "turn_context", payload: { turn_id: "turn-2" } },
  ], { agentStatus: "active", existingState: cleared });
  assert.deepEqual(nextTurn, { currentActivity: null, turnOpen: true });
});

test("keeps the live heading across interim agent commentary until genuine turn completion", () => {
  const interimMessage = {
    timestamp: "2026-08-12T12:00:02.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "RESPONSE_MUST_NOT_LEAK" },
  };
  const records = [
    { timestamp: "2026-08-12T12:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-1" } },
    interimMessage,
    eventSummary("2026-08-12T12:00:03.000Z", "**Planning task ID parsing and association**"),
  ];

  assert.deepEqual(parseCodexCurrentActivityRecords(records, { agentStatus: "active" }), {
    label: "Planning task ID parsing and association",
    observedAt: "2026-08-12T12:00:03.000Z",
  });
  assert.equal(parseCodexCurrentActivityRecords([
    ...records,
    { timestamp: "2026-08-12T12:00:04.000Z", type: "event_msg", payload: { type: "task_complete" } },
  ], { agentStatus: "active" }), null);
});

test("ignores a late duplicate after terminal until a subsequent turn starts", () => {
  assert.equal(parseCodexCurrentActivityRecords([
    eventSummary("2026-08-12T12:00:01.000Z", "**Completed activity**"),
    { timestamp: "2026-08-12T12:00:02.000Z", type: "event_msg", payload: { type: "turn_complete" } },
    responseSummary("2026-08-12T12:00:03.000Z", "**Completed activity**"),
  ], { agentStatus: "active" }), null);

  assert.deepEqual(parseCodexCurrentActivityRecords([
    eventSummary("2026-08-12T12:00:01.000Z", "**Completed activity**"),
    { timestamp: "2026-08-12T12:00:02.000Z", type: "event_msg", payload: { type: "turn_complete" } },
    responseSummary("2026-08-12T12:00:03.000Z", "**Completed activity**"),
    { timestamp: "2026-08-12T12:00:04.000Z", type: "turn_context", payload: { turn_id: "turn-2" } },
    eventSummary("2026-08-12T12:00:05.000Z", "**New-turn activity**"),
  ], { agentStatus: "active" }), {
    label: "New-turn activity",
    observedAt: "2026-08-12T12:00:05.000Z",
  });
});

test("a newer turn may replace activity after an earlier turn completed", () => {
  assert.deepEqual(parseCodexCurrentActivityRecords([
    eventSummary("2026-08-12T12:00:01.000Z", "**Earlier activity**"),
    { timestamp: "2026-08-12T12:00:02.000Z", type: "event_msg", payload: { type: "turn_complete" } },
    { timestamp: "2026-08-12T12:00:03.000Z", type: "turn_context", payload: { turn_id: "turn-2" } },
    responseSummary("2026-08-12T12:00:04.000Z", "**Current activity**"),
  ], { agentStatus: "active" }), {
    label: "Current activity",
    observedAt: "2026-08-12T12:00:04.000Z",
  });
});

test("rejects private and unknown reasoning shapes while bounding safe one-line Unicode labels", () => {
  const longLabel = `**${"\u8A08\u753B\uD83D\uDD0D".repeat(100)}**`;
  const activity = parseCodexCurrentActivityRecords([
    { timestamp: "2026-08-12T12:00:00.000Z", type: "event_msg", payload: { type: "agent_reasoning", text: "REASONING_MUST_NOT_LEAK" } },
    { timestamp: "2026-08-12T12:00:01.000Z", type: "event_msg", payload: { type: "agent_reasoning", text: "**MULTILINE\nMUST_NOT_LEAK**" } },
    { timestamp: "2026-08-12T12:00:02.000Z", type: "response_item", payload: { type: "reasoning", encrypted_content: "ENCRYPTED_MUST_NOT_LEAK", summary: [{ type: "future_summary", text: "**FUTURE_MUST_NOT_LEAK**" }] } },
    { timestamp: "2026-08-12T12:00:03.000Z", type: "response_item", payload: { type: "agent_message", summary: [{ type: "summary_text", text: "**RESPONSE_MUST_NOT_LEAK**" }] } },
    eventSummary("not-a-time", "**INVALID_TIME_MUST_NOT_LEAK**"),
    eventSummary("2026-08-12T12:00:04.000Z", longLabel),
  ], { agentStatus: "active" });

  assert.equal([...activity.label].length, CODEX_CURRENT_ACTIVITY_MAX_LENGTH);
  assert.equal(activity.label.startsWith("\u8A08\u753B\uD83D\uDD0D"), true);
  assert.doesNotMatch(JSON.stringify(activity), /MUST_NOT_LEAK|encrypted|reasoning|summary/iu);
});

test("provider normalization keeps live current activity on its owning agent and omits it from history", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-current-activity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "12");
  await mkdir(directory, { recursive: true });
  const rootFile = path.join(directory, "rollout-activity-root.jsonl");
  const childFile = path.join(directory, "rollout-activity-child.jsonl");
  const sessionRecord = (id, sessionId, parentThreadId, source) => ({
    timestamp: "2026-08-12T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      session_id: sessionId,
      parent_thread_id: parentThreadId,
      source,
      cwd: "C:\\synthetic\\pomegr",
      instructions: "DEVELOPER_INSTRUCTIONS_MUST_NOT_LEAK",
    },
  });
  await writeFile(rootFile, [
    sessionRecord("activity-root", "activity-root", null, "cli"),
    { timestamp: "2026-08-12T12:00:00.500Z", type: "event_msg", payload: { type: "agent_message", message: "INTERIM_RESPONSE_MUST_NOT_LEAK" } },
    eventSummary("2026-08-12T12:00:01.000Z", "**Root activity**"),
    responseSummary("2026-08-12T12:00:01.000Z", "**Root activity**"),
  ].map(JSON.stringify).join("\n"), "utf8");
  await writeFile(childFile, [
    sessionRecord("activity-child", "activity-root", "activity-root", "sub_agent"),
    eventSummary("2026-08-12T12:00:02.000Z", "**Child activity**"),
    responseSummary("2026-08-12T12:00:02.000Z", "**Child activity**"),
  ].map(JSON.stringify).join("\n"), "utf8");

  const threads = [
    { id: "activity-root", sessionId: "activity-root", createdAt: 1_786_536_000, updatedAt: 1_786_536_003, source: "cli", cwd: "C:\\synthetic\\pomegr", name: "Activity root", status: { type: "notLoaded" }, path: rootFile },
    { id: "activity-child", sessionId: "activity-root", parentThreadId: "activity-root", createdAt: 1_786_536_001, updatedAt: 1_786_536_003, source: "sub_agent", cwd: "C:\\synthetic\\pomegr", name: "Activity child", status: { type: "notLoaded" }, path: childFile },
  ];
  const appServer = {
    async listThreads() { return { data: threads }; },
    async readThread({ threadId, includeTurns }) {
      const thread = threads.find((item) => item.id === threadId);
      return thread ? { thread: { ...thread, turns: includeTurns ? [] : undefined } } : null;
    },
  };
  const provider = createCodexProvider({
    codexHome: root,
    appServer,
    cacheMs: 0,
    includeArchived: false,
    now: () => Date.parse("2026-08-12T12:00:20.000Z"),
  });
  const liveEvidence = await provider.readSession("activity-root", { historical: false });
  const liveState = monitorStateFromProviderEvidence("codex", liveEvidence);
  const liveAgents = new Map(liveState.agents.map((agent) => [agent.id, agent]));

  assert.deepEqual(liveAgents.get("primary").currentActivity, { label: "Root activity", observedAt: "2026-08-12T12:00:01.000Z" });
  assert.deepEqual(liveAgents.get("agent-activity-child").currentActivity, { label: "Child activity", observedAt: "2026-08-12T12:00:02.000Z" });
  assert.equal(liveAgents.get("primary").status, "active");
  assert.equal(liveAgents.get("agent-activity-child").status, "active");
  assert.equal(liveState.metrics.activeAgents, 2);
  assert.equal(liveState.executionTasks.length, 0);
  assert.equal(liveState.activity.length, 0);
  assert.doesNotMatch(JSON.stringify(liveState), /MUST_NOT_LEAK|encrypted_content|agent_reasoning|summary_text|instructions/iu);

  const historicalEvidence = await provider.readSession("activity-root", { historical: true });
  const historicalState = monitorStateFromProviderEvidence("codex", historicalEvidence);
  assert.equal(historicalState.agents.every((agent) => !agent.currentActivity), true);
});

test("provider carries current activity after large records evict its source from the live tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-current-activity-tail-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "12");
  await mkdir(directory, { recursive: true });
  const rolloutFile = path.join(directory, "rollout-tail-activity.jsonl");
  const sessionRecord = {
    timestamp: "2026-08-12T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "tail-activity",
      session_id: "tail-activity",
      source: "cli",
      cwd: "C:\\synthetic\\pomegr",
    },
  };
  const writeRecords = (records) => records.map(JSON.stringify).join("\n");
  await writeFile(rolloutFile, `${writeRecords([
    sessionRecord,
    { timestamp: "2026-08-12T12:00:00.500Z", type: "turn_context", payload: { turn_id: "turn-1" } },
    responseSummary("2026-08-12T12:00:01.000Z", "**Heading survives tail eviction**"),
  ])}\n`, "utf8");

  let now = Date.parse("2026-08-12T12:00:02.000Z");
  const thread = {
    id: "tail-activity",
    sessionId: "tail-activity",
    createdAt: 1_786_536_000,
    updatedAt: 1_786_536_001,
    source: "cli",
    cwd: "C:\\synthetic\\pomegr",
    name: "Tail activity",
    status: { type: "notLoaded" },
    path: rolloutFile,
  };
  const appServer = {
    async listThreads() { return { data: [thread] }; },
    async readThread({ threadId, includeTurns }) {
      return threadId === thread.id ? { thread: { ...thread, turns: includeTurns ? [] : undefined } } : null;
    },
  };
  const provider = createCodexProvider({
    codexHome: root,
    appServer,
    cacheMs: 0,
    includeArchived: false,
    maximumStateTailBytes: 1_024,
    maximumTaskHistoryBytes: 1_024,
    now: () => now,
  });
  let providerEvidence = await provider.readSession("tail-activity", { historical: false });
  const currentActivity = () => monitorStateFromProviderEvidence("codex", providerEvidence).agents[0]?.currentActivity;
  assert.deepEqual(currentActivity(), {
    label: "Heading survives tail eviction",
    observedAt: "2026-08-12T12:00:01.000Z",
  });

  await appendFile(rolloutFile, `${writeRecords([
    {
      timestamp: "2026-08-12T12:00:03.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call_output", output: "PRIVATE_TOOL_RESULT_MUST_NOT_LEAK".repeat(300) },
    },
    { timestamp: "2026-08-12T12:00:04.000Z", type: "event_msg", payload: { type: "token_count" } },
  ])}\n`, "utf8");
  now = Date.parse("2026-08-12T12:00:05.000Z");
  providerEvidence = await provider.readSession("tail-activity", { historical: false });
  const carriedState = monitorStateFromProviderEvidence("codex", providerEvidence);
  assert.deepEqual(carriedState.agents[0]?.currentActivity, {
    label: "Heading survives tail eviction",
    observedAt: "2026-08-12T12:00:01.000Z",
  });
  assert.doesNotMatch(JSON.stringify(carriedState), /PRIVATE_TOOL_RESULT_MUST_NOT_LEAK/);

  await appendFile(rolloutFile, `${JSON.stringify({
    timestamp: "2026-08-12T12:00:06.000Z",
    type: "turn_completed",
    payload: { status: "completed" },
  })}\n`, "utf8");
  now = Date.parse("2026-08-12T12:00:07.000Z");
  providerEvidence = await provider.readSession("tail-activity", { historical: false });
  assert.equal(currentActivity(), undefined);

  await appendFile(rolloutFile, `${writeRecords([
    { timestamp: "2026-08-12T12:00:08.000Z", type: "turn_context", payload: { turn_id: "turn-2" } },
    eventSummary("2026-08-12T12:00:09.000Z", "**Replacement heading**"),
  ])}\n`, "utf8");
  now = Date.parse("2026-08-12T12:00:10.000Z");
  providerEvidence = await provider.readSession("tail-activity", { historical: false });
  assert.deepEqual(currentActivity(), {
    label: "Replacement heading",
    observedAt: "2026-08-12T12:00:09.000Z",
  });

  await writeFile(rolloutFile, `${writeRecords([
    sessionRecord,
    { timestamp: "2026-08-12T12:00:11.000Z", type: "event_msg", payload: { type: "token_count" } },
  ])}\n`, "utf8");
  now = Date.parse("2026-08-12T12:00:12.000Z");
  providerEvidence = await provider.readSession("tail-activity", { historical: false });
  assert.equal(currentActivity(), undefined);
  assert.equal(provider.qaStats().liveCurrentActivityEntries, 1);
});
