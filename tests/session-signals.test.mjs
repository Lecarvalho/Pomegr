import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPomegrMcpServer } from "../mcp/server.mjs";
import {
  AGENT_SIGNAL_MCP_TOOL,
  CLEAR_AGENT_SIGNAL_MCP_TOOL,
  CLEAR_SESSION_SIGNAL_MCP_TOOL,
  clearSessionSignalCache,
  latestAgentSignal,
  latestSessionSignal,
  latestSessionProgress,
  latestTaskSignals,
  latestTranscriptSignals,
  mergeTranscriptSignals,
  normalizeSessionSignal,
  normalizeSessionProgress,
  normalizeAgentSignal,
  normalizeTaskSignal,
  readTranscriptSignals,
  SESSION_SIGNAL_MCP_TOOL,
  SESSION_PROGRESS_MCP_TOOL,
  CLEAR_SESSION_PROGRESS_MCP_TOOL,
  TASK_SIGNAL_MCP_TOOL,
} from "../monitor/session-signals.mjs";

const PLUGIN_MCP_PREFIX = "mcp__plugin_pomegr_pomegr__";
const LEGACY_MCP_PREFIX = "mcp__threadlight__";

test("registers the session signal MCP tool with an agent-reported summary description", async () => {
  const server = buildPomegrMcpServer();
  const tool = server._registeredTools.report_session_signal;

  assert.equal(tool?.title, "Report Pomegr session signal");
  assert.match(tool?.description || "", /agent-authored summary/);
  const result = await tool.handler({
    label: "Awaiting merge",
    tone: "info",
    description: "Implementation is complete. Next: merge the approved pull request.",
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Session signal reported: Awaiting merge/);
  const progressTool = server._registeredTools.report_session_progress;
  const progressResult = await progressTool.handler({ phase: "verifying", percent: 80, confidence: "high" });
  assert.equal(progressResult.isError, undefined);
  assert.match(progressResult.content[0].text, /Session progress reported: verifying \(80%\)/);
});

function agentSignalRecord(label, tone, timestamp) {
  return {
    type: "assistant",
    timestamp,
    message: {
      content: [{
        type: "tool_use",
        id: `agent-signal-${label}`,
        name: AGENT_SIGNAL_MCP_TOOL,
        input: { label, tone },
      }],
    },
  };
}

function sessionSignalRecord(label, tone, timestamp, description) {
  return {
    type: "assistant",
    timestamp,
    message: {
      content: [{
        type: "tool_use",
        id: `signal-${label}`,
        name: SESSION_SIGNAL_MCP_TOOL,
        input: { label, tone, ...(description ? { description } : {}) },
      }],
    },
  };
}

function sessionProgressRecord(progress, timestamp, tool = SESSION_PROGRESS_MCP_TOOL) {
  return {
    type: "assistant",
    timestamp,
    message: { content: [{ type: "tool_use", name: tool, input: progress }] },
  };
}

function taskSignalRecord(taskId, label, tone, timestamp) {
  return {
    type: "assistant",
    timestamp,
    message: {
      content: [{
        type: "tool_use",
        id: `task-signal-${taskId}`,
        name: TASK_SIGNAL_MCP_TOOL,
        input: { task_id: taskId, label, tone },
      }],
    },
  };
}

function clearSignalRecord(scope, timestamp, input = {}, pluginNamespaced = false) {
  const tool = scope === "agent" ? CLEAR_AGENT_SIGNAL_MCP_TOOL : CLEAR_SESSION_SIGNAL_MCP_TOOL;
  return {
    type: "assistant",
    timestamp,
    message: {
      content: [{
        type: "tool_use",
        id: `clear-${scope}-${timestamp}`,
        name: pluginNamespaced ? `${PLUGIN_MCP_PREFIX}${tool.replace("mcp__pomegr__", "")}` : tool,
        input,
      }],
    },
  };
}

function clearSignalRecordWithoutInput(scope, timestamp) {
  const record = clearSignalRecord(scope, timestamp);
  delete record.message.content[0].input;
  return record;
}

test("normalizes bounded plain-text signals", () => {
  assert.deepEqual(normalizeSessionSignal({ label: "  Research   complete  ", tone: "info" }, "2026-08-07T14:00:00.000Z"), {
    label: "Research complete",
    tone: "info",
    reportedAt: "2026-08-07T14:00:00.000Z",
  });
  assert.deepEqual(normalizeSessionSignal({ label: "Approved" }), { label: "Approved", tone: "neutral", reportedAt: null });
  assert.equal(normalizeSessionSignal({ label: "", tone: "positive" }), null);
  assert.deepEqual(normalizeSessionSignal({ label: "x".repeat(20), tone: "positive" }), {
    label: "x".repeat(20),
    tone: "positive",
    reportedAt: null,
  });
  assert.equal(normalizeSessionSignal({ label: "x".repeat(21), tone: "positive" }), null);
  assert.equal(normalizeAgentSignal({ label: "x".repeat(21), tone: "positive" }), null);
  assert.equal(normalizeTaskSignal({ task_id: "background_123", label: "x".repeat(21), tone: "positive" }), null);
  assert.equal(normalizeSessionSignal({ label: "Approved", tone: "green" }), null);
  assert.equal(normalizeSessionSignal({ label: "Approved\nprivate output", tone: "positive" }), null);
  assert.equal(normalizeSessionSignal({ label: "Approved", tone: "positive", detail: "not exposed" }), null);
  assert.deepEqual(normalizeAgentSignal({
    label: "Approved",
    tone: "positive",
    description: "  All requested checks   passed.  ",
  }, "2026-08-07T14:00:00.000Z"), {
    label: "Approved",
    tone: "positive",
    reportedAt: "2026-08-07T14:00:00.000Z",
    description: "All requested checks passed.",
  });
  assert.equal(normalizeAgentSignal({ label: "Approved", description: "" }), null);
  assert.equal(normalizeAgentSignal({ label: "Approved", description: "x".repeat(161) }), null);
  assert.equal(normalizeAgentSignal({ label: "Approved", description: "Private\noutput" }), null);
  assert.deepEqual(normalizeSessionSignal({
    label: "Approved",
    tone: "positive",
    description: "  Session checks   passed.  ",
  }), {
    label: "Approved",
    tone: "positive",
    reportedAt: null,
    description: "Session checks passed.",
  });
  assert.equal(normalizeSessionSignal({ label: "Approved", description: "x".repeat(161) }), null);
  assert.equal(normalizeSessionSignal({ label: "Approved", description: "Private\noutput" }), null);
  assert.deepEqual(normalizeTaskSignal({ task_id: "background_123", label: "Approved w/ notes", tone: "info" }), {
    taskId: "background_123",
    label: "Approved w/ notes",
    tone: "info",
    reportedAt: null,
  });
  assert.equal(normalizeTaskSignal({ task_id: "../unsafe", label: "Approved", tone: "positive" }), null);
  assert.equal(normalizeTaskSignal({ task_id: "background_123", label: "Approved", tone: "positive", result: "private" }), null);
});

test("normalizes bounded session progress and applies timestamped report-clear transitions", () => {
  assert.deepEqual(normalizeSessionProgress({
    phase: "implementing",
    percent: 40,
    remaining_minutes_min: 10,
    remaining_minutes_max: 20,
    confidence: "medium",
  }, "2026-08-07T14:00:00.000Z"), {
    phase: "implementing",
    percent: 40,
    remainingMinutesMin: 10,
    remainingMinutesMax: 20,
    confidence: "medium",
    reportedAt: "2026-08-07T14:00:00.000Z",
  });
  assert.equal(normalizeSessionProgress({ phase: "complete", percent: 99, confidence: "high" }), null);
  assert.equal(normalizeSessionProgress({ phase: "blocked", percent: 20, remaining_minutes_min: 1, remaining_minutes_max: 2, confidence: "high" }), null);
  assert.equal(normalizeSessionProgress({ phase: "planning", percent: 20, remaining_minutes_min: 2, confidence: "low" }), null);
  assert.equal(normalizeSessionProgress({ phase: "planning", percent: 20, confidence: "low", private: "must not leak" }), null);

  const progress = latestSessionProgress([
    sessionProgressRecord({ phase: "implementing", percent: 70, confidence: "high" }, "2026-08-07T14:00:00.000Z"),
    sessionProgressRecord({ phase: "planning", percent: 20, confidence: "low" }, "2026-08-07T14:01:00.000Z"),
    sessionProgressRecord({}, "2026-08-07T14:02:00.000Z", CLEAR_SESSION_PROGRESS_MCP_TOOL),
  ]);
  assert.equal(progress, null);
  assert.deepEqual(latestSessionProgress([
    sessionProgressRecord({ phase: "implementing", percent: 70, confidence: "high" }, "2026-08-07T14:00:00.000Z"),
    sessionProgressRecord({ phase: "planning", percent: 20, confidence: "low" }, "2026-08-07T14:01:00.000Z"),
  ]), { phase: "planning", percent: 20, confidence: "low", reportedAt: "2026-08-07T14:01:00.000Z" });
});

test("uses the latest valid Pomegr MCP signal and ignores other content", () => {
  const records = [
    sessionSignalRecord("Needs changes", "negative", "2026-08-07T14:00:00.000Z"),
    {
      type: "assistant",
      timestamp: "2026-08-07T14:01:00.000Z",
      message: { content: [{ type: "tool_use", name: "mcp__another__report_session_signal", input: { label: "Spoofed", tone: "positive" } }] },
    },
    {
      type: "user",
      timestamp: "2026-08-07T14:02:00.000Z",
      message: { content: [{ type: "tool_result", content: "Approved" }] },
    },
    sessionSignalRecord("Approved", "positive", "2026-08-07T14:03:00.000Z", "All review checks passed."),
  ];

  assert.deepEqual(latestSessionSignal(records), {
    label: "Approved",
    tone: "positive",
    reportedAt: "2026-08-07T14:03:00.000Z",
    description: "All review checks passed.",
  });
});

test("keeps agent and session signal scopes independent", () => {
  const records = [
    agentSignalRecord("Reviewing", "info", "2026-08-07T14:00:00.000Z"),
    sessionSignalRecord("PR ready", "positive", "2026-08-07T14:01:00.000Z"),
    agentSignalRecord("Approved", "positive", "2026-08-07T14:02:00.000Z"),
  ];

  assert.deepEqual(latestAgentSignal(records), {
    label: "Approved",
    tone: "positive",
    reportedAt: "2026-08-07T14:02:00.000Z",
  });
  assert.deepEqual(latestSessionSignal(records), {
    label: "PR ready",
    tone: "positive",
    reportedAt: "2026-08-07T14:01:00.000Z",
  });
});

test("rejects legacy Threadlight MCP tool identifiers", () => {
  const records = [
    sessionSignalRecord("Pomegr accepted", "positive", "2026-08-07T14:00:00.000Z"),
    {
      type: "assistant",
      timestamp: "2026-08-07T14:01:00.000Z",
      message: { content: [{ type: "tool_use", name: `${LEGACY_MCP_PREFIX}report_session_signal`, input: { label: "Legacy accepted", tone: "negative" } }] },
    },
    {
      type: "assistant",
      timestamp: "2026-08-07T14:02:00.000Z",
      message: { content: [{ type: "tool_use", name: "mcp__plugin_threadlight_threadlight__report_session_signal", input: { label: "Legacy plugin accepted", tone: "negative" } }] },
    },
  ];

  assert.equal(latestSessionSignal(records)?.label, "Pomegr accepted");
});

test("accepts plugin-namespaced tools and applies report-clear-report transitions", () => {
  const pluginAgentReport = agentSignalRecord("Reviewing", "info", "2026-08-07T14:00:00.000Z");
  pluginAgentReport.message.content[0].name = `${PLUGIN_MCP_PREFIX}report_agent_signal`;
  const pluginAgentRestore = agentSignalRecord("Ready", "positive", "2026-08-07T14:02:00.000Z");
  pluginAgentRestore.message.content[0].name = `${PLUGIN_MCP_PREFIX}report_agent_signal`;
  const pluginSessionReport = sessionSignalRecord("Needs input", "warning", "2026-08-07T14:00:30.000Z");
  pluginSessionReport.message.content[0].name = `${PLUGIN_MCP_PREFIX}report_session_signal`;

  const signals = latestTranscriptSignals([
    pluginAgentReport,
    clearSignalRecord("agent", "2026-08-07T14:01:00.000Z", {}, true),
    pluginAgentRestore,
    pluginSessionReport,
    clearSignalRecord("session", "2026-08-07T14:03:00.000Z", {}, true),
    clearSignalRecord("agent", "2026-08-07T14:04:00.000Z", { reason: "must not be accepted" }, true),
    clearSignalRecord("agent", "2026-08-07T14:05:00.000Z", null, true),
    clearSignalRecordWithoutInput("agent", "2026-08-07T14:06:00.000Z"),
  ]);

  assert.deepEqual(signals.agent, {
    label: "Ready",
    tone: "positive",
    reportedAt: "2026-08-07T14:02:00.000Z",
  });
  assert.equal(signals.session, null);
});

test("orders session reports and clears across agent transcripts by timestamp", () => {
  const parent = latestTranscriptSignals([
    sessionSignalRecord("Implementing", "info", "2026-08-07T14:02:00.000Z"),
  ]);
  const child = latestTranscriptSignals([
    clearSignalRecord("session", "2026-08-07T14:03:00.000Z", {}, true),
  ]);
  const staleChild = latestTranscriptSignals([
    sessionSignalRecord("Stale", "warning", "2026-08-07T14:01:00.000Z"),
  ]);

  const combined = { agent: null, session: null, tasks: new Map() };
  mergeTranscriptSignals(combined, child);
  mergeTranscriptSignals(combined, parent);
  mergeTranscriptSignals(combined, staleChild);
  assert.equal(combined.session, null);

  mergeTranscriptSignals(combined, latestTranscriptSignals([
    sessionSignalRecord("Ready", "positive", "2026-08-07T14:04:00.000Z"),
  ]));
  assert.deepEqual(combined.session, {
    label: "Ready",
    tone: "positive",
    reportedAt: "2026-08-07T14:04:00.000Z",
  });
});

test("keeps the latest signal for each safe task identifier", () => {
  const signals = latestTaskSignals([
    taskSignalRecord("background_123", "Reviewing", "info", "2026-08-07T14:00:00.000Z"),
    taskSignalRecord("background_456", "Rejected", "negative", "2026-08-07T14:01:00.000Z"),
    taskSignalRecord("background_123", "Approved", "positive", "2026-08-07T14:02:00.000Z"),
    {
      type: "assistant",
      timestamp: "2026-08-07T14:03:00.000Z",
      message: { content: [{ type: "tool_use", name: "mcp__another__report_task_signal", input: { task_id: "background_123", label: "Spoofed", tone: "negative" } }] },
    },
  ]);

  assert.deepEqual([...signals], [
    ["background_123", { label: "Approved", tone: "positive", reportedAt: "2026-08-07T14:02:00.000Z" }],
    ["background_456", { label: "Rejected", tone: "negative", reportedAt: "2026-08-07T14:01:00.000Z" }],
  ]);
});

test("reconstructs historical report and clear transitions outside the bounded activity tail", async () => {
  clearSessionSignalCache();
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-signals-"));
  const transcript = path.join(directory, "agent-reviewer.jsonl");
  const olderAgentSignal = JSON.stringify(agentSignalRecord("Reviewer finished", "positive", "2026-08-07T13:59:00.000Z"));
  const olderSignal = JSON.stringify(sessionSignalRecord("Approved", "positive", "2026-08-07T14:00:00.000Z"));
  const olderTaskSignal = JSON.stringify(taskSignalRecord("background_123", "Approved w/ notes", "info", "2026-08-07T14:01:00.000Z"));
  const olderAgentClear = JSON.stringify(clearSignalRecord("agent", "2026-08-07T14:02:00.000Z", {}, true));
  const restoredAgentSignal = JSON.stringify(agentSignalRecord("Handoff ready", "info", "2026-08-07T14:03:00.000Z"));
  const olderSessionClear = JSON.stringify(clearSignalRecord("session", "2026-08-07T14:04:00.000Z"));
  const filler = JSON.stringify({ type: "system", payload: "x".repeat(2 * 1024 * 1024 + 32) });
  await writeFile(transcript, `${olderAgentSignal}\n${olderSignal}\n${olderTaskSignal}\n${olderAgentClear}\n${restoredAgentSignal}\n${olderSessionClear}\n${filler}\n`, "utf8");

  try {
    const signals = await readTranscriptSignals(transcript, []);
    assert.deepEqual(signals.agent, {
      label: "Handoff ready",
      tone: "info",
      reportedAt: "2026-08-07T14:03:00.000Z",
    });
    assert.equal(signals.session, null);
    assert.deepEqual([...signals.tasks], [["background_123", {
      label: "Approved w/ notes",
      tone: "info",
      reportedAt: "2026-08-07T14:01:00.000Z",
    }]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    clearSessionSignalCache();
  }
});
