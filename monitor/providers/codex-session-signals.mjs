import fs from "node:fs";
import {
  AGENT_SIGNAL_MCP_TOOLS,
  CLEAR_AGENT_SIGNAL_MCP_TOOLS,
  CLEAR_SESSION_SIGNAL_MCP_TOOLS,
  normalizeAgentSignal,
  normalizeSessionSignal,
  normalizeTaskSignal,
  SESSION_SIGNAL_MCP_TOOLS,
  TASK_SIGNAL_MCP_TOOLS,
} from "../session-signals.mjs";
import { codexTimestamp } from "./codex-session-metadata.mjs";

const SIGNAL_TOOLS = new Set([
  ...AGENT_SIGNAL_MCP_TOOLS,
  ...SESSION_SIGNAL_MCP_TOOLS,
  ...TASK_SIGNAL_MCP_TOOLS,
  ...CLEAR_AGENT_SIGNAL_MCP_TOOLS,
  ...CLEAR_SESSION_SIGNAL_MCP_TOOLS,
]);
const signalStateMetadata = new WeakMap();

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

function signalState() {
  const state = { agent: null, session: null, tasks: new Map() };
  signalStateMetadata.set(state, { agentAt: null, sessionAt: null });
  return state;
}

function signalTimestamp(state, scope) {
  return state?.[scope]?.reportedAt || signalStateMetadata.get(state)?.[`${scope}At`] || null;
}

function setScopedSignal(state, scope, signal, reportedAt) {
  state[scope] = signal;
  const metadata = signalStateMetadata.get(state) || { agentAt: null, sessionAt: null };
  metadata[`${scope}At`] = reportedAt || signal?.reportedAt || null;
  signalStateMetadata.set(state, metadata);
}

export function mergeCodexSignals(target, source) {
  for (const scope of ["agent", "session"]) {
    const sourceAt = signalTimestamp(source, scope);
    if (sourceAt && timestampValue(sourceAt) >= timestampValue(signalTimestamp(target, scope))) {
      setScopedSignal(target, scope, source[scope], sourceAt);
    }
  }
  for (const [taskId, signal] of source.tasks) {
    target.tasks.set(taskId, newerSignal(target.tasks.get(taskId), signal));
  }
  return target;
}

export function parseCodexSignalRecords(records) {
  const signals = signalState();
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

    if (AGENT_SIGNAL_MCP_TOOLS.has(payload.name)) {
      const signal = normalizeAgentSignal(input, reportedAt);
      if (signal) setScopedSignal(signals, "agent", signal, signal.reportedAt);
    } else if (SESSION_SIGNAL_MCP_TOOLS.has(payload.name)) {
      const signal = normalizeSessionSignal(input, reportedAt);
      if (signal) setScopedSignal(signals, "session", signal, signal.reportedAt);
    } else if (CLEAR_AGENT_SIGNAL_MCP_TOOLS.has(payload.name) || CLEAR_SESSION_SIGNAL_MCP_TOOLS.has(payload.name)) {
      if (Object.keys(input).length !== 0) continue;
      setScopedSignal(signals, CLEAR_AGENT_SIGNAL_MCP_TOOLS.has(payload.name) ? "agent" : "session", null, reportedAt);
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
  try { text = fs.readFileSync(file, "utf8"); } catch { return signalState(); }
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
