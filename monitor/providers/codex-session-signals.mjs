import fs from "node:fs";
import readline from "node:readline";
import { createHash } from "node:crypto";
import {
  AGENT_SIGNAL_MCP_TOOLS,
  CLEAR_AGENT_SIGNAL_MCP_TOOLS,
  CLEAR_SESSION_SIGNAL_MCP_TOOLS,
  CLEAR_SESSION_PROGRESS_MCP_TOOLS,
  normalizeAgentSignal,
  normalizeSessionProgress,
  normalizeSessionSignal,
  normalizeTaskSignal,
  SESSION_SIGNAL_MCP_TOOLS,
  SESSION_PROGRESS_MCP_TOOLS,
  TASK_SIGNAL_MCP_TOOLS,
} from "../session-signals.mjs";
import { codexTimestamp } from "./codex-session-metadata.mjs";

const SIGNAL_TOOLS = new Set([
  ...AGENT_SIGNAL_MCP_TOOLS,
  ...SESSION_SIGNAL_MCP_TOOLS,
  ...TASK_SIGNAL_MCP_TOOLS,
  ...CLEAR_AGENT_SIGNAL_MCP_TOOLS,
  ...CLEAR_SESSION_SIGNAL_MCP_TOOLS,
  ...SESSION_PROGRESS_MCP_TOOLS,
  ...CLEAR_SESSION_PROGRESS_MCP_TOOLS,
]);
const CODEX_APP_MCP_SERVER = "pomegr";
const MAX_RECENT_CODEX_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_CODEX_SIGNAL_CACHE_ENTRIES = 512;
const MAX_SIGNAL_CALL_ID_LENGTH = 512;
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
  const state = { agent: null, session: null, progress: null, tasks: new Map() };
  signalStateMetadata.set(state, { agentAt: null, sessionAt: null, progressAt: null });
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

function setProgress(state, progress, reportedAt) {
  state.progress = progress;
  const metadata = signalStateMetadata.get(state) || { agentAt: null, sessionAt: null, progressAt: null };
  metadata.progressAt = reportedAt || progress?.reportedAt || null;
  signalStateMetadata.set(state, metadata);
}

function boundedCallId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SIGNAL_CALL_ID_LENGTH
    ? value
    : null;
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
    callId: boundedCallId(payload.call_id),
    authoritative: false,
    successful: true,
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
    || typeof item.tool !== "string") return null;
  const name = `mcp__pomegr__${item.tool}`;
  if (!SIGNAL_TOOLS.has(name)) return null;
  return {
    name,
    input: item.arguments,
    timestamp: record.timestamp,
    callId: boundedCallId(item.id),
    authoritative: true,
    successful: item.status === "completed" && item.error == null && item.result?.isError !== true,
  };
}

function completedNestedMcpSignalCall(record) {
  const payload = record?.payload;
  const invocation = payload?.invocation;
  if (record?.type !== "event_msg"
    || payload?.type !== "mcp_tool_call_end"
    || !invocation
    || typeof invocation !== "object"
    || Array.isArray(invocation)
    || invocation.server !== CODEX_APP_MCP_SERVER
    || typeof invocation.tool !== "string") return null;
  const name = `mcp__pomegr__${invocation.tool}`;
  if (!SIGNAL_TOOLS.has(name)) return null;
  const result = payload.result;
  const ok = result && typeof result === "object" && !Array.isArray(result)
    && Object.hasOwn(result, "Ok")
    && result.Ok && typeof result.Ok === "object" && !Array.isArray(result.Ok)
    ? result.Ok
    : null;
  return {
    name,
    input: invocation.arguments,
    timestamp: record.timestamp,
    callId: boundedCallId(payload.call_id),
    authoritative: true,
    successful: Boolean(ok) && ok.isError !== true,
  };
}

function signalCall(record) {
  return directSignalCall(record)
    || completedAppMcpSignalCall(record)
    || completedNestedMcpSignalCall(record);
}

function signalCalls(records) {
  return (Array.isArray(records) ? records : []).map(signalCall).filter(Boolean);
}

function signalCallKey(call) {
  return call.callId ? `${call.name}\u0000${call.callId}` : null;
}

function preferredSignalCalls(calls) {
  const selectedByCallId = new Map();
  const callsWithoutIds = [];
  for (const [index, call] of (Array.isArray(calls) ? calls : []).entries()) {
    const candidate = { ...call, index };
    const key = signalCallKey(call);
    if (!key) {
      callsWithoutIds.push(candidate);
      continue;
    }
    const previous = selectedByCallId.get(key);
    if (!previous
      || (call.authoritative && !previous.authoritative)
      || call.authoritative === previous.authoritative) {
      selectedByCallId.set(key, candidate);
    }
  }
  return [...callsWithoutIds, ...selectedByCallId.values()].sort((left, right) => left.index - right.index);
}

export function mergeCodexSignals(target, source) {
  for (const scope of ["agent", "session"]) {
    const sourceAt = signalTimestamp(source, scope);
    if (sourceAt && timestampValue(sourceAt) >= timestampValue(signalTimestamp(target, scope))) {
      setScopedSignal(target, scope, source[scope], sourceAt);
    }
  }
  const sourceProgressAt = signalTimestamp(source, "progress");
  if (sourceProgressAt && timestampValue(sourceProgressAt) >= timestampValue(signalTimestamp(target, "progress"))) {
    setProgress(target, source.progress, sourceProgressAt);
  }
  for (const [taskId, signal] of source.tasks) {
    target.tasks.set(taskId, newerSignal(target.tasks.get(taskId), signal));
  }
  return target;
}

function parseCodexSignalCalls(calls) {
  const signals = signalState();
  for (const call of preferredSignalCalls(calls)) {
    if (!call.successful) continue;
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
    } else if (SESSION_PROGRESS_MCP_TOOLS.has(call.name)) {
      const progress = normalizeSessionProgress(input, reportedAt);
      if (progress) setProgress(signals, progress, progress.reportedAt);
    } else if (CLEAR_AGENT_SIGNAL_MCP_TOOLS.has(call.name) || CLEAR_SESSION_SIGNAL_MCP_TOOLS.has(call.name)) {
      if (Object.keys(input).length !== 0) continue;
      setScopedSignal(signals, CLEAR_AGENT_SIGNAL_MCP_TOOLS.has(call.name) ? "agent" : "session", null, reportedAt);
    } else if (CLEAR_SESSION_PROGRESS_MCP_TOOLS.has(call.name)) {
      if (Object.keys(input).length !== 0) continue;
      setProgress(signals, null, reportedAt);
    } else {
      const taskSignal = normalizeTaskSignal(input, reportedAt);
      if (!taskSignal) continue;
      const { taskId, ...signal } = taskSignal;
      signals.tasks.set(taskId, newerSignal(signals.tasks.get(taskId), signal));
    }
  }
  return signals;
}

export function parseCodexSignalRecords(records) {
  return parseCodexSignalCalls(signalCalls(records));
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
  const calls = [];
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const call = signalCall(JSON.parse(line));
      if (call) calls.push(call);
    } catch {
      // Malformed and partially written JSONL records do not invalidate earlier signals.
    }
  }
  return {
    signals: parseCodexSignalCalls(calls),
    authoritativeCallKeys: new Set(calls.filter(({ authoritative }) => authoritative).map(signalCallKey).filter(Boolean)),
  };
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
  let authoritativeCallKeys;
  const recentCalls = signalCalls(recentRecords);
  const hasNewAuthoritativeCall = cached && recentCalls.some((call) => (
    call.authoritative
    && signalCallKey(call)
    && !cached.authoritativeCallKeys?.has(signalCallKey(call))
  ));
  if (cached
    && generation
    && cached.generation?.identity === generation.identity
    && generation.size > cached.size
    && generation.mtimeMs >= cached.mtimeMs
    && generation.size - cached.size <= MAX_RECENT_CODEX_TRANSCRIPT_BYTES
    && priorSuffixStillMatches(file, cached.generation)
    && !hasNewAuthoritativeCall) {
    signals = mergeCodexSignals(
      mergeCodexSignals(signalState(), cached.signals),
      parseCodexSignalCalls(recentCalls),
    );
    authoritativeCallKeys = new Set([
      ...(cached.authoritativeCallKeys || []),
      ...recentCalls.filter(({ authoritative }) => authoritative).map(signalCallKey).filter(Boolean),
    ]);
  } else {
    const scanned = await scanCompleteCodexTranscript(file);
    signals = scanned.signals;
    authoritativeCallKeys = scanned.authoritativeCallKeys;
  }
  signalCache.delete(file);
  signalCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, generation, signals, authoritativeCallKeys });
  while (signalCache.size > MAX_CODEX_SIGNAL_CACHE_ENTRIES) {
    signalCache.delete(signalCache.keys().next().value);
  }
  return signals;
}
