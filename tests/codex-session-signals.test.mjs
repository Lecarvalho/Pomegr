import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { mergeCodexSignals, parseCodexSignalRecords } from "../monitor/providers/codex-session-signals.mjs";
import { assertNoPrivateFixtureSentinels, monitorStateFromProviderEvidence } from "./helpers/provider-fixtures.mjs";

const record = (timestamp, type, payload) => ({ timestamp, type, payload });
const signalCall = (timestamp, name, callId, input, type = "function_call") => record(timestamp, "response_item", {
  type,
  name,
  call_id: callId,
  [type === "custom_tool_call" ? "input" : "arguments"]: JSON.stringify(input),
});
const PLUGIN_MCP_PREFIX = "mcp__plugin_threadlight_threadlight__";

test("accepts only allowlisted Codex Threadlight signal calls and rollout timestamps", () => {
  const signals = parseCodexSignalRecords([
    signalCall("2026-08-11T14:00:00.000Z", "mcp__threadlight__report_agent_signal", "agent-1", { label: "Reviewing", tone: "info" }),
    signalCall("2026-08-11T14:01:00.000Z", "mcp__threadlight__report_agent_signal", "agent-2", { label: "Ready", tone: "positive", description: "All review findings were resolved." }, "custom_tool_call"),
    signalCall("2026-08-11T14:02:00.000Z", "mcp__threadlight__report_session_signal", "session-1", { label: "PR ready", tone: "positive", description: "All requested checks passed." }),
    signalCall("2026-08-11T14:03:00.000Z", "mcp__threadlight__report_task_signal", "task-1", { task_id: "command-1", label: "Passed", tone: "positive" }),
    signalCall("2026-08-11T14:04:00.000Z", "mcp__another__report_session_signal", "spoof-1", { label: "Spoofed", tone: "negative" }),
    signalCall("2026-08-11T14:05:00.000Z", "mcp__threadlight__report_agent_signal", "spoof-2", { label: "Spoofed", tone: "negative", agent_id: "primary" }),
    signalCall("not-a-time", "mcp__threadlight__report_session_signal", "bad-time", { label: "Spoofed", tone: "negative" }),
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

test("orders session reports and clears across Codex rollouts by timestamp", () => {
  const parent = parseCodexSignalRecords([
    signalCall("2026-08-11T14:02:00.000Z", "mcp__threadlight__report_session_signal", "parent-report", { label: "Implementing", tone: "info" }),
  ]);
  const child = parseCodexSignalRecords([
    signalCall("2026-08-11T14:03:00.000Z", `${PLUGIN_MCP_PREFIX}clear_session_signal`, "child-clear", {}),
  ]);
  const staleChild = parseCodexSignalRecords([
    signalCall("2026-08-11T14:01:00.000Z", "mcp__threadlight__report_session_signal", "stale-report", { label: "Stale", tone: "warning" }),
  ]);
  const combined = { agent: null, session: null, tasks: new Map() };

  mergeCodexSignals(combined, child);
  mergeCodexSignals(combined, parent);
  mergeCodexSignals(combined, staleChild);
  assert.equal(combined.session, null);

  mergeCodexSignals(combined, parseCodexSignalRecords([
    signalCall("2026-08-11T14:04:00.000Z", "mcp__threadlight__report_session_signal", "new-report", { label: "Ready", tone: "positive" }),
  ]));
  assert.deepEqual(combined.session, {
    label: "Ready",
    tone: "positive",
    reportedAt: "2026-08-11T14:04:00.000Z",
  });
});

test("derives the reporting agent from each rollout and resolves task targets monitor-side", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-signals-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(directory, { recursive: true });
  const parent = [
    record("2026-08-11T15:00:00.000Z", "session_meta", { id: "signal-parent", cwd: "C:\\synthetic\\repo", source: "cli" }),
    record("2026-08-11T15:00:01.000Z", "turn_context", { model: "gpt-synthetic" }),
    record("2026-08-11T15:00:02.000Z", "response_item", { type: "function_call", name: "shell_command", call_id: "command-1", arguments: JSON.stringify({ command: "COMMAND_MUST_NOT_LEAK", description: "Run checks" }) }),
    signalCall("2026-08-11T15:00:03.000Z", "mcp__threadlight__report_task_signal", "task-valid", { task_id: "command-1", label: "Checks passed", tone: "positive" }),
    signalCall("2026-08-11T15:00:04.000Z", "mcp__threadlight__report_task_signal", "task-private", { task_id: "unknown-task", label: "MCP_ARGUMENT_MUST_NOT_LEAK", tone: "negative" }),
    signalCall("2026-08-11T15:00:05.000Z", "mcp__threadlight__report_session_signal", "session-valid", { label: "Ready", tone: "positive", description: "The session is ready for handoff." }),
  ];
  const child = [
    record("2026-08-11T15:00:06.000Z", "session_meta", { id: "signal-child", parent_thread_id: "signal-parent", cwd: "C:\\synthetic\\repo", source: { subagent: "review" } }),
    signalCall("2026-08-11T15:00:07.000Z", "mcp__threadlight__report_agent_signal", "agent-valid", { label: "Reviewed", tone: "info", description: "No blocking findings." }),
    signalCall("2026-08-11T15:00:08.000Z", "mcp__threadlight__report_agent_signal", "agent-spoof", { label: "Spoofed", tone: "negative", agent_id: "primary" }),
    signalCall("2026-08-11T15:00:09.000Z", `${PLUGIN_MCP_PREFIX}clear_session_signal`, "session-clear", {}),
  ];
  await writeFile(path.join(directory, "rollout-parent.jsonl"), `${parent.map(JSON.stringify).join("\n")}\n`, "utf8");
  await writeFile(path.join(directory, "rollout-child.jsonl"), `${child.map(JSON.stringify).join("\n")}\n`, "utf8");

  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, includeArchived: false });
  const evidence = await provider.readSession("signal-parent", { historical: true });
  const childAgent = evidence.agents.find((agent) => agent.id === "agent-signal-child");
  const task = evidence.agents.find((agent) => agent.id === "primary").executionTasks.find(({ id }) => id === "command-1");

  assert.equal(provider.capabilities.signals, true);
  assert.equal(evidence.session.signal, null);
  assert.deepEqual(childAgent.signal, { label: "Reviewed", tone: "info", reportedAt: "2026-08-11T15:00:07.000Z", description: "No blocking findings." });
  assert.deepEqual(task.signal, { label: "Checks passed", tone: "positive", reportedAt: "2026-08-11T15:00:03.000Z" });
  assert.doesNotMatch(JSON.stringify(evidence), /unknown-task|Spoofed|MCP_ARGUMENT_MUST_NOT_LEAK|COMMAND_MUST_NOT_LEAK/);
  assertNoPrivateFixtureSentinels(monitorStateFromProviderEvidence("codex", evidence), "Codex signal MonitorState");
});
