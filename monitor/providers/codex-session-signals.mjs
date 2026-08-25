import fs from "node:fs";
import readline from "node:readline";
import { createHash } from "node:crypto";
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
const CODEX_APP_MCP_SERVER = "pomegr";
const MAX_RECENT_CODEX_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_CODEX_SIGNAL_CACHE_ENTRIES = 512;
const signalCache = new Map();
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

function directSignalCall(record) {
  const payload = record?.payload;
  if (record?.type !== "response_item"
    || !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !["function_call", "custom_tool_call"].includes(payload.type)
    || !SIGNAL_TOOLS.has(payload.name)) return null;
  return {
    name: payload.name,
    input: payload.arguments ?? payload.input,
    timestamp: record.timestamp ?? payload.timestamp,
  };
}

function completedAppMcpSignalCall(record) {
  const payload = record?.payload;
  const item = payload?.item;
  if (record?.type !== "event_msg"
    || payload?.type !== "item_completed"
    || !item
    || typeof item !== "object"
    || Array.isArray(item)
    || item.type !== "McpToolCall"
    || item.server !== CODEX_APP_MCP_SERVER
    || item.status !== "completed"
    || typeof item.tool !== "string") return null;
  const name = `mcp__pomegr__${item.tool}`;
  if (!SIGNAL_TOOLS.has(name)) return null;
  return { name, input: item.arguments, timestamp: record.timestamp };
}

function signalCall(record) {
  return directSignalCall(record) || completedAppMcpSignalCall(record);
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
    const call = signalCall(record);
    if (!call) continue;
    const reportedAt = codexTimestamp(call.timestamp);
    if (!reportedAt) continue;
    const input = parseObject(call.input);
    if (!input) continue;

    if (AGENT_SIGNAL_MCP_TOOLS.has(call.name)) {
      const signal = normalizeAgentSignal(input, reportedAt);
      if (signal) setScopedSignal(signals, "agent", signal, signal.reportedAt);
    } else if (SESSION_SIGNAL_MCP_TOOLS.has(call.name)) {
      const signal = normalizeSessionSignal(input, reportedAt);
      if (signal) setScopedSignal(signals, "session", signal, signal.reportedAt);
    } else if (CLEAR_AGENT_SIGNAL_MCP_TOOLS.has(call.name) || CLEAR_SESSION_SIGNAL_MCP_TOOLS.has(call.name)) {
      if (Object.keys(input).length !== 0) continue;
      setScopedSignal(signals, CLEAR_AGENT_SIGNAL_MCP_TOOLS.has(call.name) ? "agent" : "session", null, reportedAt);
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

async function scanCompleteCodexTranscript(file) {
  const latest = signalState();
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      mergeCodexSignals(latest, parseCodexSignalRecords([JSON.parse(line)]));
    } catch {
      // Malformed and partially written JSONL records do not invalidate earlier signals.
    }
  }
  return latest;
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function priorSuffixStillMatches(file, generation) {
  if (!generation?.suffixDigest || !Number.isInteger(generation.suffixBytes) || generation.suffixBytes < 1) return false;
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(generation.suffixBytes);
    const read = fs.readSync(
      descriptor,
      buffer,
      0,
      generation.suffixBytes,
      generation.size - generation.suffixBytes,
    );
    return read === generation.suffixBytes && digest(buffer) === generation.suffixDigest;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export async function readCodexSignals(file, recentRecords = [], generation = null) {
  let stat;
  try { stat = fs.statSync(file); }
  catch {
    signalCache.delete(file);
    return signalState();
  }

  const cached = signalCache.get(file);
  const unchanged = cached
    && cached.size === stat.size
    && cached.mtimeMs === stat.mtimeMs
    && (!generation || (cached.generation?.identity === generation.identity
      && cached.generation?.suffixDigest === generation.suffixDigest));
  if (unchanged) return cached.signals;

  let signals;
  if (cached
    && generation
    && cached.generation?.identity === generation.identity
    && generation.size > cached.size
    && generation.mtimeMs >= cached.mtimeMs
    && generation.size - cached.size <= MAX_RECENT_CODEX_TRANSCRIPT_BYTES
    && priorSuffixStillMatches(file, cached.generation)) {
    signals = mergeCodexSignals(
      mergeCodexSignals(signalState(), cached.signals),
      parseCodexSignalRecords(recentRecords),
    );
  } else {
    signals = await scanCompleteCodexTranscript(file);
  }
  signalCache.delete(file);
  signalCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, generation, signals });
  while (signalCache.size > MAX_CODEX_SIGNAL_CACHE_ENTRIES) {
    signalCache.delete(signalCache.keys().next().value);
  }
  return signals;
}
