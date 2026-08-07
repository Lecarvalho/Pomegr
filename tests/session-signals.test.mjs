import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearSessionSignalCache,
  latestSessionSignal,
  normalizeSessionSignal,
  readLatestSessionSignal,
  SESSION_SIGNAL_MCP_TOOL,
} from "../monitor/session-signals.mjs";

function signalRecord(label, tone, timestamp) {
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
});

test("uses the latest valid Threadlight MCP signal and ignores other content", () => {
  const records = [
    signalRecord("Needs changes", "negative", "2026-08-07T14:00:00.000Z"),
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
    signalRecord("Approved", "positive", "2026-08-07T14:03:00.000Z"),
  ];

  assert.deepEqual(latestSessionSignal(records), {
    label: "Approved",
    tone: "positive",
    reportedAt: "2026-08-07T14:03:00.000Z",
  });
});

test("reconstructs a historical signal outside the bounded activity tail", async () => {
  clearSessionSignalCache();
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadlight-signals-"));
  const transcript = path.join(directory, "agent-reviewer.jsonl");
  const olderSignal = JSON.stringify(signalRecord("Approved", "positive", "2026-08-07T14:00:00.000Z"));
  const filler = JSON.stringify({ type: "system", payload: "x".repeat(2 * 1024 * 1024 + 32) });
  await writeFile(transcript, `${olderSignal}\n${filler}\n`, "utf8");

  try {
    assert.deepEqual(await readLatestSessionSignal(transcript, []), {
      label: "Approved",
      tone: "positive",
      reportedAt: "2026-08-07T14:00:00.000Z",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
    clearSessionSignalCache();
  }
});
