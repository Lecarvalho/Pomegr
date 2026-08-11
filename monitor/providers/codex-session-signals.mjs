import fs from "node:fs";
import {
  AGENT_SIGNAL_MCP_TOOL,
  normalizeAgentSignal,
  normalizeSessionSignal,
  normalizeTaskSignal,
  SESSION_SIGNAL_MCP_TOOL,
  TASK_SIGNAL_MCP_TOOL,
} from "../session-signals.mjs";
import { codexTimestamp } from "./codex-session-metadata.mjs";

const SIGNAL_TOOLS = new Set([AGENT_SIGNAL_MCP_TOOL, SESSION_SIGNAL_MCP_TOOL, TASK_SIGNAL_MCP_TOOL]);

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function timestampValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function newerSignal(previous, next) {
  if (!previous) return next || null;
  if (!next) return previous;
  return timestampValue(next.reportedAt) >= timestampValue(previous.reportedAt) ? next : previous;
}

export function mergeCodexSignals(target, source) {
  target.agent = newerSignal(target.agent, source.agent);
  target.session = newerSignal(target.session, source.session);
  for (const [taskId, signal] of source.tasks) {
    target.tasks.set(taskId, newerSignal(target.tasks.get(taskId), signal));
  }
  return target;
}

export function parseCodexSignalRecords(records) {
  const signals = { agent: null, session: null, tasks: new Map() };
  for (const record of Array.isArray(records) ? records : []) {
    const payload = record?.payload;
    if (record?.type !== "response_item"
      || !payload
      || typeof payload !== "object"
      || Array.isArray(payload)
      || !["function_call", "custom_tool_call"].includes(payload.type)
      || !SIGNAL_TOOLS.has(payload.name)) continue;
    const reportedAt = codexTimestamp(record.timestamp ?? payload.timestamp);
    if (!reportedAt) continue;
    const input = parseObject(payload.arguments ?? payload.input);
    if (!input) continue;

    if (payload.name === AGENT_SIGNAL_MCP_TOOL) {
      signals.agent = newerSignal(signals.agent, normalizeAgentSignal(input, reportedAt));
    } else if (payload.name === SESSION_SIGNAL_MCP_TOOL) {
      signals.session = newerSignal(signals.session, normalizeSessionSignal(input, reportedAt));
    } else {
      const taskSignal = normalizeTaskSignal(input, reportedAt);
      if (!taskSignal) continue;
      const { taskId, ...signal } = taskSignal;
      signals.tasks.set(taskId, newerSignal(signals.tasks.get(taskId), signal));
    }
  }
  return signals;
}

export function readCodexSignalRollout(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { agent: null, session: null, tasks: new Map() }; }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
    } catch {
      // Malformed and truncated lines do not invalidate recognized signal calls.
    }
  }
  return parseCodexSignalRecords(records);
}
