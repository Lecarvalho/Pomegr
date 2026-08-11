import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_SIGNAL_MCP_TOOL,
  clearSessionSignalCache,
  latestAgentSignal,
  latestSessionSignal,
  latestTaskSignals,
  normalizeSessionSignal,
  normalizeAgentSignal,
  normalizeTaskSignal,
  readTranscriptSignals,
  SESSION_SIGNAL_MCP_TOOL,
  TASK_SIGNAL_MCP_TOOL,
} from "../monitor/session-signals.mjs";

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

function sessionSignalRecord(label, tone, timestamp) {
  return {
    type: "assistant",
    timestamp,
    message: {
      content: [{
        type: "tool_use",
        id: `signal-${label}`,
        name: SESSION_SIGNAL_MCP_TOOL,
        input: { label, tone },
      }],
    },
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

test("normalizes bounded plain-text signals", () => {
  assert.deepEqual(normalizeSessionSignal({ label: "  Research   complete  ", tone: "info" }, "2026-08-07T14:00:00.000Z"), {
    label: "Research complete",
    tone: "info",
    reportedAt: "2026-08-07T14:00:00.000Z",
  });
  assert.deepEqual(normalizeSessionSignal({ label: "Approved" }), { label: "Approved", tone: "neutral", reportedAt: null });
  assert.equal(normalizeSessionSignal({ label: "", tone: "positive" }), null);
  assert.equal(normalizeSessionSignal({ label: "x".repeat(41), tone: "positive" }), null);
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
  assert.equal(normalizeSessionSignal({ label: "Approved", description: "Agent-only field" }), null);
  assert.deepEqual(normalizeTaskSignal({ task_id: "background_123", label: "Approved with suggestions", tone: "info" }), {
    taskId: "background_123",
    label: "Approved with suggestions",
    tone: "info",
    reportedAt: null,
  });
  assert.equal(normalizeTaskSignal({ task_id: "../unsafe", label: "Approved", tone: "positive" }), null);
  assert.equal(normalizeTaskSignal({ task_id: "background_123", label: "Approved", tone: "positive", result: "private" }), null);
});

test("uses the latest valid Threadlight MCP signal and ignores other content", () => {
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
    sessionSignalRecord("Approved", "positive", "2026-08-07T14:03:00.000Z"),
  ];

  assert.deepEqual(latestSessionSignal(records), {
    label: "Approved",
    tone: "positive",
    reportedAt: "2026-08-07T14:03:00.000Z",
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

test("reconstructs historical session and task signals outside the bounded activity tail", async () => {
  clearSessionSignalCache();
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadlight-signals-"));
  const transcript = path.join(directory, "agent-reviewer.jsonl");
  const olderAgentSignal = JSON.stringify(agentSignalRecord("Reviewer finished", "positive", "2026-08-07T13:59:00.000Z"));
  const olderSignal = JSON.stringify(sessionSignalRecord("Approved", "positive", "2026-08-07T14:00:00.000Z"));
  const olderTaskSignal = JSON.stringify(taskSignalRecord("background_123", "Approved with suggestions", "info", "2026-08-07T14:01:00.000Z"));
  const filler = JSON.stringify({ type: "system", payload: "x".repeat(2 * 1024 * 1024 + 32) });
  await writeFile(transcript, `${olderAgentSignal}\n${olderSignal}\n${olderTaskSignal}\n${filler}\n`, "utf8");

  try {
    const signals = await readTranscriptSignals(transcript, []);
    assert.deepEqual(signals.agent, {
      label: "Reviewer finished",
      tone: "positive",
      reportedAt: "2026-08-07T13:59:00.000Z",
    });
    assert.deepEqual(signals.session, {
      label: "Approved",
      tone: "positive",
      reportedAt: "2026-08-07T14:00:00.000Z",
    });
    assert.deepEqual([...signals.tasks], [["background_123", {
      label: "Approved with suggestions",
      tone: "info",
      reportedAt: "2026-08-07T14:01:00.000Z",
    }]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    clearSessionSignalCache();
  }
});
