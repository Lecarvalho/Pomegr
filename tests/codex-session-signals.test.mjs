import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { mergeCodexSignals, parseCodexSignalRecords, readCodexSignals } from "../monitor/providers/codex-session-signals.mjs";
import { assertNoPrivateFixtureSentinels, monitorStateFromProviderEvidence } from "./helpers/provider-fixtures.mjs";

const record = (timestamp, type, payload) => ({ timestamp, type, payload });
const signalCall = (timestamp, name, callId, input, type = "function_call") => record(timestamp, "response_item", {
  type,
  name,
  call_id: callId,
  [type === "custom_tool_call" ? "input" : "arguments"]: JSON.stringify(input),
});
const appMcpSignalCall = (timestamp, tool, input, options = {}) => record(timestamp, "event_msg", {
  type: "item_completed",
  item: {
    type: "McpToolCall",
    id: options.id || `mcp-${tool}`,
    server: options.server || "pomegr",
    tool,
    arguments: input,
    pluginId: options.pluginId || "pomegr@synthetic",
    readOnlyHint: true,
    status: options.status || "completed",
    result: options.result || { content: [{ type: "text", text: "PRIVATE_TOOL_RESULT_MUST_NOT_LEAK" }] },
  },
});
const nestedMcpSignalCall = (timestamp, tool, input, options = {}) => record(timestamp, "event_msg", {
  type: "mcp_tool_call_end",
  call_id: options.callId || `nested-${tool}`,
  invocation: {
    server: options.server || "pomegr",
    tool,
    arguments: input,
  },
  plugin_id: options.pluginId || "pomegr@synthetic",
  read_only_hint: true,
  result: options.result || {
    Ok: { content: [{ type: "text", text: "PRIVATE_NESTED_TOOL_RESULT_MUST_NOT_LEAK" }] },
  },
});
const PLUGIN_MCP_PREFIX = "mcp__plugin_pomegr_pomegr__";

test("accepts only allowlisted Codex Pomegr signal calls and rollout timestamps", () => {
  const signals = parseCodexSignalRecords([
    signalCall("2026-08-11T14:00:00.000Z", "mcp__pomegr__report_agent_signal", "agent-1", { label: "Reviewing", tone: "info" }),
    signalCall("2026-08-11T14:01:00.000Z", "mcp__pomegr__report_agent_signal", "agent-2", { label: "Ready", tone: "positive", description: "All review findings were resolved." }, "custom_tool_call"),
    signalCall("2026-08-11T14:02:00.000Z", "mcp__pomegr__report_session_signal", "session-1", { label: "PR ready", tone: "positive", description: "All requested checks passed." }),
    signalCall("2026-08-11T14:03:00.000Z", "mcp__pomegr__report_task_signal", "task-1", { task_id: "command-1", label: "Passed", tone: "positive" }),
    signalCall("2026-08-11T14:04:00.000Z", "mcp__another__report_session_signal", "spoof-1", { label: "Spoofed", tone: "negative" }),
    signalCall("2026-08-11T14:05:00.000Z", "mcp__pomegr__report_agent_signal", "spoof-2", { label: "Spoofed", tone: "negative", agent_id: "primary" }),
    signalCall("not-a-time", "mcp__pomegr__report_session_signal", "bad-time", { label: "Spoofed", tone: "negative" }),
    signalCall("2026-08-11T14:06:00.000Z", "mcp__threadlight__report_session_signal", "legacy-direct", { label: "Legacy direct", tone: "negative" }),
    signalCall("2026-08-11T14:07:00.000Z", "mcp__plugin_threadlight_threadlight__report_session_signal", "legacy-plugin", { label: "Legacy plugin", tone: "negative" }),
  ]);

  assert.deepEqual(signals.agent, { label: "Ready", tone: "positive", reportedAt: "2026-08-11T14:01:00.000Z", description: "All review findings were resolved." });
  assert.deepEqual(signals.session, { label: "PR ready", tone: "positive", reportedAt: "2026-08-11T14:02:00.000Z", description: "All requested checks passed." });
  assert.deepEqual([...signals.tasks], [["command-1", {
    label: "Passed",
    tone: "positive",
    reportedAt: "2026-08-11T14:03:00.000Z",
  }]]);
  assertNoPrivateFixtureSentinels(signals, "Codex signal evidence");
});

test("accepts plugin-namespaced tools and applies report-clear-report transitions", () => {
  const signals = parseCodexSignalRecords([
    signalCall("2026-08-11T14:00:00.000Z", `${PLUGIN_MCP_PREFIX}report_agent_signal`, "agent-report-1", { label: "Reviewing", tone: "info" }),
    signalCall("2026-08-11T14:01:00.000Z", `${PLUGIN_MCP_PREFIX}clear_agent_signal`, "agent-clear", {}),
    signalCall("2026-08-11T14:02:00.000Z", `${PLUGIN_MCP_PREFIX}report_agent_signal`, "agent-report-2", { label: "Ready", tone: "positive" }),
    signalCall("2026-08-11T14:00:30.000Z", `${PLUGIN_MCP_PREFIX}report_session_signal`, "session-report", { label: "Needs input", tone: "warning" }),
    signalCall("2026-08-11T14:03:00.000Z", `${PLUGIN_MCP_PREFIX}clear_session_signal`, "session-clear", {}),
    signalCall("2026-08-11T14:04:00.000Z", `${PLUGIN_MCP_PREFIX}clear_agent_signal`, "invalid-clear", { reason: "must not be accepted" }),
  ]);

  assert.deepEqual(signals.agent, {
    label: "Ready",
    tone: "positive",
    reportedAt: "2026-08-11T14:02:00.000Z",
  });
  assert.equal(signals.session, null);
});

test("accepts bounded Codex session progress, including backward reports, but rejects invalid ETA and completion data", () => {
  const signals = parseCodexSignalRecords([
    signalCall("2026-08-11T14:00:00.000Z", "mcp__pomegr__report_session_progress", "progress-1", {
      phase: "implementing", percent: 70, confidence: "high",
    }),
    signalCall("2026-08-11T14:01:00.000Z", "mcp__pomegr__report_session_progress", "progress-2", {
      phase: "planning", percent: 20, remaining_minutes_min: 5, remaining_minutes_max: 15, confidence: "medium",
    }),
    signalCall("2026-08-11T14:02:00.000Z", "mcp__pomegr__report_session_progress", "bad-complete", {
      phase: "complete", percent: 99, confidence: "high",
    }),
    signalCall("2026-08-11T14:03:00.000Z", "mcp__pomegr__clear_session_progress", "progress-clear", {}),
  ]);
  assert.equal(signals.progress, null);
  const retained = parseCodexSignalRecords([
    signalCall("2026-08-11T14:00:00.000Z", "mcp__pomegr__report_session_progress", "progress-1", {
      phase: "implementing", percent: 70, confidence: "high",
    }),
    signalCall("2026-08-11T14:01:00.000Z", "mcp__pomegr__report_session_progress", "progress-2", {
      phase: "planning", percent: 20, remaining_minutes_min: 5, remaining_minutes_max: 15, confidence: "medium",
    }),
  ]);
  assert.deepEqual(retained.progress, {
    phase: "planning", percent: 20, remainingMinutesMin: 5, remainingMinutesMax: 15,
    confidence: "medium", reportedAt: "2026-08-11T14:01:00.000Z",
  });
});

test("accepts completed Codex app MCP items without exposing wrapper metadata or results", () => {
  const signals = parseCodexSignalRecords([
    appMcpSignalCall("2026-08-11T14:00:00.000Z", "report_agent_signal", {
      label: "Investigating",
      tone: "info",
      description: "Reviewing the provider boundary.",
    }),
    appMcpSignalCall("2026-08-11T14:01:00.000Z", "report_session_signal", {
      label: "Privacy verified",
      tone: "positive",
      description: "The bounded signal surface passed review.",
    }),
    appMcpSignalCall("2026-08-11T14:02:00.000Z", "report_task_signal", {
      task_id: "command-1",
      label: "Checks passed",
      tone: "positive",
    }),
  ]);

  assert.deepEqual(signals.agent, {
    label: "Investigating",
    tone: "info",
    reportedAt: "2026-08-11T14:00:00.000Z",
    description: "Reviewing the provider boundary.",
  });
  assert.deepEqual(signals.session, {
    label: "Privacy verified",
    tone: "positive",
    reportedAt: "2026-08-11T14:01:00.000Z",
    description: "The bounded signal surface passed review.",
  });
  assert.deepEqual([...signals.tasks], [["command-1", {
    label: "Checks passed",
    tone: "positive",
    reportedAt: "2026-08-11T14:02:00.000Z",
  }]]);
  assertNoPrivateFixtureSentinels(signals, "Codex app MCP signal evidence");
  assert.doesNotMatch(JSON.stringify(signals), /pluginId|readOnlyHint|PRIVATE_TOOL_RESULT_MUST_NOT_LEAK/);
});

test("accepts completed nested Codex MCP events without exposing wrapper metadata or results", () => {
  const signals = parseCodexSignalRecords([
    nestedMcpSignalCall("2026-08-11T14:00:00.000Z", "report_agent_signal", {
      label: "Investigating",
      tone: "info",
      description: "Reviewing the nested provider boundary.",
    }),
    nestedMcpSignalCall("2026-08-11T14:01:00.000Z", "report_session_progress", {
      phase: "implementing",
      percent: 45,
      remaining_minutes_min: 5,
      remaining_minutes_max: 10,
      confidence: "high",
    }),
    nestedMcpSignalCall("2026-08-11T14:02:00.000Z", "report_task_signal", {
      task_id: "command-1",
      label: "Checks passed",
      tone: "positive",
    }),
  ]);

  assert.deepEqual(signals.agent, {
    label: "Investigating",
    tone: "info",
    reportedAt: "2026-08-11T14:00:00.000Z",
    description: "Reviewing the nested provider boundary.",
  });
  assert.deepEqual(signals.progress, {
    phase: "implementing",
    percent: 45,
    remainingMinutesMin: 5,
    remainingMinutesMax: 10,
    confidence: "high",
    reportedAt: "2026-08-11T14:01:00.000Z",
  });
  assert.deepEqual([...signals.tasks], [["command-1", {
    label: "Checks passed",
    tone: "positive",
    reportedAt: "2026-08-11T14:02:00.000Z",
  }]]);
  assertNoPrivateFixtureSentinels(signals, "nested Codex signal evidence");
  assert.doesNotMatch(JSON.stringify(signals), /pluginId|readOnlyHint|PRIVATE_NESTED_TOOL_RESULT_MUST_NOT_LEAK/);
});

test("requires successful nested MCP completion and deduplicates authoritative call IDs", () => {
  const duplicateCallId = "progress-duplicate";
  const signals = parseCodexSignalRecords([
    signalCall("2026-08-11T14:00:00.000Z", "mcp__pomegr__report_session_progress", "progress-baseline", {
      phase: "planning", percent: 10, confidence: "low",
    }),
    signalCall("2026-08-11T14:01:00.000Z", "mcp__pomegr__report_session_progress", duplicateCallId, {
      phase: "implementing", percent: 80, confidence: "high",
    }),
    nestedMcpSignalCall("2026-08-11T14:01:01.000Z", "report_session_progress", {
      phase: "implementing", percent: 80, confidence: "high",
    }, {
      callId: duplicateCallId,
      result: { Ok: { isError: true, content: [{ type: "text", text: "PRIVATE_REJECTION_MUST_NOT_LEAK" }] } },
    }),
    nestedMcpSignalCall("2026-08-11T14:02:00.000Z", "report_session_progress", {
      phase: "verifying", percent: 90, confidence: "high",
    }, { callId: "foreign", server: "another" }),
    nestedMcpSignalCall("2026-08-11T14:03:00.000Z", "report_session_progress", {
      phase: "complete", percent: 100, confidence: "high",
    }, { callId: "failed", result: { Err: { message: "PRIVATE_ERROR_MUST_NOT_LEAK" } } }),
  ]);

  assert.deepEqual(signals.progress, {
    phase: "planning",
    percent: 10,
    confidence: "low",
    reportedAt: "2026-08-11T14:00:00.000Z",
  });
  assertNoPrivateFixtureSentinels(signals, "deduplicated Codex signal evidence");
});

test("reconciles a later authoritative completion across the live signal cache boundary", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-signal-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  const duplicateCallId = "cached-progress";
  const baseline = signalCall("2026-08-11T14:00:00.000Z", "mcp__pomegr__report_session_progress", "baseline-progress", {
    phase: "planning", percent: 10, confidence: "low",
  });
  const direct = signalCall("2026-08-11T14:01:00.000Z", "mcp__pomegr__report_session_progress", duplicateCallId, {
    phase: "implementing", percent: 80, confidence: "high",
  });
  await writeFile(file, `${[baseline, direct].map(JSON.stringify).join("\n")}\n`, "utf8");

  assert.equal((await readCodexSignals(file)).progress.percent, 80);

  const failedCompletion = nestedMcpSignalCall("2026-08-11T14:01:01.000Z", "report_session_progress", {
    phase: "implementing", percent: 80, confidence: "high",
  }, {
    callId: duplicateCallId,
    result: { Ok: { isError: true, content: [{ type: "text", text: "PRIVATE_CACHED_REJECTION_MUST_NOT_LEAK" }] } },
  });
  await appendFile(file, `${JSON.stringify(failedCompletion)}\n`, "utf8");

  const reconciled = await readCodexSignals(file, [failedCompletion]);
  assert.deepEqual(reconciled.progress, {
    phase: "planning",
    percent: 10,
    confidence: "low",
    reportedAt: "2026-08-11T14:00:00.000Z",
  });
  assertNoPrivateFixtureSentinels(reconciled, "cached Codex signal evidence");
});

test("ignores incomplete, foreign, malformed, and non-signal Codex app MCP items", () => {
  const signals = parseCodexSignalRecords([
    appMcpSignalCall("2026-08-11T14:00:00.000Z", "report_session_signal", { label: "Failed", tone: "negative" }, { status: "failed" }),
    appMcpSignalCall("2026-08-11T14:01:00.000Z", "report_session_signal", { label: "Spoofed", tone: "negative" }, { server: "another" }),
    appMcpSignalCall("2026-08-11T14:02:00.000Z", "unrecognized_signal", { label: "Spoofed", tone: "negative" }),
    appMcpSignalCall("2026-08-11T14:03:00.000Z", "report_session_signal", { label: "Spoofed", tone: "negative", extra: true }),
    record("2026-08-11T14:04:00.000Z", "event_msg", {
      type: "item_started",
      item: { type: "McpToolCall", server: "pomegr", tool: "report_session_signal", arguments: { label: "Spoofed", tone: "negative" }, status: "completed" },
    }),
  ]);

  assert.equal(signals.agent, null);
  assert.equal(signals.session, null);
  assert.deepEqual([...signals.tasks], []);
});

test("applies Codex app MCP report and clear transitions in transcript order", () => {
  const signals = parseCodexSignalRecords([
    appMcpSignalCall("2026-08-11T14:00:00.000Z", "report_session_signal", { label: "Needs input", tone: "warning" }),
    appMcpSignalCall("2026-08-11T14:01:00.000Z", "clear_session_signal", {}),
    appMcpSignalCall("2026-08-11T14:02:00.000Z", "report_session_signal", { label: "Privacy verified", tone: "positive" }),
    appMcpSignalCall("2026-08-11T14:03:00.000Z", "report_agent_signal", { label: "Reviewed", tone: "info" }),
    appMcpSignalCall("2026-08-11T14:04:00.000Z", "clear_agent_signal", {}),
  ]);

  assert.deepEqual(signals.session, {
    label: "Privacy verified",
    tone: "positive",
    reportedAt: "2026-08-11T14:02:00.000Z",
  });
  assert.equal(signals.agent, null);
});

test("orders session reports and clears across Codex rollouts by timestamp", () => {
  const parent = parseCodexSignalRecords([
    signalCall("2026-08-11T14:02:00.000Z", "mcp__pomegr__report_session_signal", "parent-report", { label: "Implementing", tone: "info" }),
  ]);
  const child = parseCodexSignalRecords([
    signalCall("2026-08-11T14:03:00.000Z", `${PLUGIN_MCP_PREFIX}clear_session_signal`, "child-clear", {}),
  ]);
  const staleChild = parseCodexSignalRecords([
    signalCall("2026-08-11T14:01:00.000Z", "mcp__pomegr__report_session_signal", "stale-report", { label: "Stale", tone: "warning" }),
  ]);
  const combined = { agent: null, session: null, tasks: new Map() };

  mergeCodexSignals(combined, child);
  mergeCodexSignals(combined, parent);
  mergeCodexSignals(combined, staleChild);
  assert.equal(combined.session, null);

  mergeCodexSignals(combined, parseCodexSignalRecords([
    signalCall("2026-08-11T14:04:00.000Z", "mcp__pomegr__report_session_signal", "new-report", { label: "Ready", tone: "positive" }),
  ]));
  assert.deepEqual(combined.session, {
    label: "Ready",
    tone: "positive",
    reportedAt: "2026-08-11T14:04:00.000Z",
  });
});

test("derives the reporting agent from each rollout and resolves task targets monitor-side", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-signals-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(directory, { recursive: true });
  const parent = [
    record("2026-08-11T15:00:00.000Z", "session_meta", { id: "signal-parent", cwd: "C:\\synthetic\\repo", source: "cli" }),
    record("2026-08-11T15:00:01.000Z", "turn_context", { model: "gpt-synthetic" }),
    record("2026-08-11T15:00:02.000Z", "response_item", { type: "function_call", name: "shell_command", call_id: "command-1", arguments: JSON.stringify({ command: "COMMAND_MUST_NOT_LEAK", description: "Run checks" }) }),
    signalCall("2026-08-11T15:00:03.000Z", "mcp__pomegr__report_task_signal", "task-valid", { task_id: "command-1", label: "Checks passed", tone: "positive" }),
    signalCall("2026-08-11T15:00:04.000Z", "mcp__pomegr__report_task_signal", "task-private", { task_id: "unknown-task", label: "MCP_ARGUMENT_MUST_NOT_LEAK", tone: "negative" }),
    signalCall("2026-08-11T15:00:05.000Z", "mcp__pomegr__report_session_signal", "session-valid", { label: "Ready", tone: "positive", description: "The session is ready for handoff." }),
    signalCall("2026-08-11T15:00:05.500Z", "mcp__pomegr__report_session_progress", "progress-valid", { phase: "implementing", percent: 30, remaining_minutes_min: 10, remaining_minutes_max: 20, confidence: "medium" }),
    nestedMcpSignalCall("2026-08-11T15:00:05.750Z", "report_session_progress", { phase: "implementing", percent: 45, remaining_minutes_min: 5, remaining_minutes_max: 10, confidence: "high" }, { callId: "progress-nested" }),
  ];
  const child = [
    record("2026-08-11T15:00:06.000Z", "session_meta", { id: "signal-child", parent_thread_id: "signal-parent", cwd: "C:\\synthetic\\repo", source: { subagent: "review" } }),
    signalCall("2026-08-11T15:00:07.000Z", "mcp__pomegr__report_agent_signal", "agent-valid", { label: "Reviewed", tone: "info", description: "No blocking findings." }),
    signalCall("2026-08-11T15:00:08.000Z", "mcp__pomegr__report_agent_signal", "agent-spoof", { label: "Spoofed", tone: "negative", agent_id: "primary" }),
    signalCall("2026-08-11T15:00:09.000Z", `${PLUGIN_MCP_PREFIX}clear_session_signal`, "session-clear", {}),
    signalCall("2026-08-11T15:00:10.000Z", "mcp__pomegr__report_session_progress", "progress-child", { phase: "complete", percent: 100, confidence: "high" }),
  ];
  await writeFile(path.join(directory, "rollout-parent.jsonl"), `${parent.map(JSON.stringify).join("\n")}\n`, "utf8");
  await writeFile(path.join(directory, "rollout-child.jsonl"), `${child.map(JSON.stringify).join("\n")}\n`, "utf8");

  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, includeArchived: false });
  const evidence = await provider.readSession("signal-parent", { historical: true });
  const childAgent = evidence.agents.find((agent) => agent.id === "agent-signal-child");
  const task = evidence.agents.find((agent) => agent.id === "primary").executionTasks.find(({ id }) => id === "command-1");

  assert.equal(provider.capabilities.signals, true);
  assert.equal(evidence.session.signal, null);
  assert.deepEqual(evidence.session.progress, {
    phase: "implementing",
    percent: 45,
    remainingMinutesMin: 5,
    remainingMinutesMax: 10,
    confidence: "high",
    reportedAt: "2026-08-11T15:00:05.750Z",
  });
  assert.deepEqual(childAgent.signal, { label: "Reviewed", tone: "info", reportedAt: "2026-08-11T15:00:07.000Z", description: "No blocking findings." });
  assert.deepEqual(task.signal, { label: "Checks passed", tone: "positive", reportedAt: "2026-08-11T15:00:03.000Z" });
  assert.doesNotMatch(JSON.stringify(evidence), /unknown-task|Spoofed|MCP_ARGUMENT_MUST_NOT_LEAK|COMMAND_MUST_NOT_LEAK/);
  assertNoPrivateFixtureSentinels(monitorStateFromProviderEvidence("codex", evidence), "Codex signal MonitorState");
});

test("retains a completed Codex app session signal outside the bounded live tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-signals-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(directory, { recursive: true });
  const filler = "PRIVATE_TRANSCRIPT_CONTENT_MUST_NOT_LEAK".repeat(16_000);
  const records = [
    record("2026-08-11T15:00:00.000Z", "session_meta", { id: "live-signal-parent", cwd: "C:\\synthetic\\repo", source: "cli" }),
    appMcpSignalCall("2026-08-11T15:00:01.000Z", "report_session_signal", {
      label: "Privacy verified",
      tone: "positive",
      description: "The bounded live signal remains current.",
    }),
    record("2026-08-11T15:00:02.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: filler }],
    }),
    record("2026-08-11T15:00:03.000Z", "event_msg", { type: "token_count", info: null }),
  ];
  await writeFile(path.join(directory, "rollout-live.jsonl"), `${records.map(JSON.stringify).join("\n")}\n`, "utf8");

  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, includeArchived: false });
  const evidence = await provider.readSession("live-signal-parent", { historical: false });

  assert.deepEqual(evidence.session.signal, {
    label: "Privacy verified",
    tone: "positive",
    reportedAt: "2026-08-11T15:00:01.000Z",
    description: "The bounded live signal remains current.",
  });
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_TRANSCRIPT_CONTENT_MUST_NOT_LEAK/);
  assertNoPrivateFixtureSentinels(monitorStateFromProviderEvidence("codex", evidence), "Codex live signal MonitorState");

  const replacement = [
    record("2026-08-11T16:00:00.000Z", "session_meta", { id: "live-signal-parent", cwd: "C:\\synthetic\\repo", source: "cli" }),
    record("2026-08-11T16:00:01.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "PRIVATE_REPLACEMENT_CONTENT_MUST_NOT_LEAK".repeat(17_000) }],
    }),
    record("2026-08-11T16:00:02.000Z", "event_msg", { type: "token_count", info: null }),
  ];
  await writeFile(path.join(directory, "rollout-live.jsonl"), `${replacement.map(JSON.stringify).join("\n")}\n`, "utf8");
  const replacedEvidence = await provider.readSession("live-signal-parent", { historical: false });

  assert.equal(replacedEvidence.session.signal, null);
  assert.doesNotMatch(JSON.stringify(replacedEvidence), /PRIVATE_REPLACEMENT_CONTENT_MUST_NOT_LEAK|Privacy verified/);
});
