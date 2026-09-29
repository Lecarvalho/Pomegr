import fs from "node:fs";
import readline from "node:readline";

export const AGENT_SIGNAL_TOOL = "report_agent_signal";
export const AGENT_SIGNAL_MCP_TOOL = `mcp__pomegr__${AGENT_SIGNAL_TOOL}`;
export const SESSION_SIGNAL_TOOL = "report_session_signal";
export const SESSION_SIGNAL_MCP_TOOL = `mcp__pomegr__${SESSION_SIGNAL_TOOL}`;
export const TASK_SIGNAL_TOOL = "report_task_signal";
export const TASK_SIGNAL_MCP_TOOL = `mcp__pomegr__${TASK_SIGNAL_TOOL}`;
export const CLEAR_AGENT_SIGNAL_TOOL = "clear_agent_signal";
export const CLEAR_AGENT_SIGNAL_MCP_TOOL = `mcp__pomegr__${CLEAR_AGENT_SIGNAL_TOOL}`;
export const CLEAR_SESSION_SIGNAL_TOOL = "clear_session_signal";
export const CLEAR_SESSION_SIGNAL_MCP_TOOL = `mcp__pomegr__${CLEAR_SESSION_SIGNAL_TOOL}`;
export const SESSION_PROGRESS_TOOL = "report_session_progress";
export const SESSION_PROGRESS_MCP_TOOL = `mcp__pomegr__${SESSION_PROGRESS_TOOL}`;
export const CLEAR_SESSION_PROGRESS_TOOL = "clear_session_progress";
export const CLEAR_SESSION_PROGRESS_MCP_TOOL = `mcp__pomegr__${CLEAR_SESSION_PROGRESS_TOOL}`;
const CLAUDE_PLUGIN_MCP_PREFIX = "mcp__plugin_pomegr_pomegr__";
export const AGENT_SIGNAL_MCP_TOOLS = new Set([AGENT_SIGNAL_MCP_TOOL, `${CLAUDE_PLUGIN_MCP_PREFIX}${AGENT_SIGNAL_TOOL}`]);
export const SESSION_SIGNAL_MCP_TOOLS = new Set([SESSION_SIGNAL_MCP_TOOL, `${CLAUDE_PLUGIN_MCP_PREFIX}${SESSION_SIGNAL_TOOL}`]);
export const TASK_SIGNAL_MCP_TOOLS = new Set([TASK_SIGNAL_MCP_TOOL, `${CLAUDE_PLUGIN_MCP_PREFIX}${TASK_SIGNAL_TOOL}`]);
export const CLEAR_AGENT_SIGNAL_MCP_TOOLS = new Set([CLEAR_AGENT_SIGNAL_MCP_TOOL, `${CLAUDE_PLUGIN_MCP_PREFIX}${CLEAR_AGENT_SIGNAL_TOOL}`]);
export const CLEAR_SESSION_SIGNAL_MCP_TOOLS = new Set([CLEAR_SESSION_SIGNAL_MCP_TOOL, `${CLAUDE_PLUGIN_MCP_PREFIX}${CLEAR_SESSION_SIGNAL_TOOL}`]);
export const SESSION_PROGRESS_MCP_TOOLS = new Set([SESSION_PROGRESS_MCP_TOOL, `${CLAUDE_PLUGIN_MCP_PREFIX}${SESSION_PROGRESS_TOOL}`]);
export const CLEAR_SESSION_PROGRESS_MCP_TOOLS = new Set([CLEAR_SESSION_PROGRESS_MCP_TOOL, `${CLAUDE_PLUGIN_MCP_PREFIX}${CLEAR_SESSION_PROGRESS_TOOL}`]);
export const SIGNAL_MAX_LABEL_LENGTH = 20;
export const SIGNAL_MAX_DESCRIPTION_LENGTH = 160;
export const SESSION_SIGNAL_TONES = ["neutral", "info", "positive", "warning", "negative"];
export const SESSION_PROGRESS_PHASES = ["planning", "implementing", "verifying", "blocked", "complete"];
export const SESSION_PROGRESS_CONFIDENCES = ["low", "medium", "high"];

const toneSet = new Set(SESSION_SIGNAL_TONES);
const sessionSignalKeys = new Set(["label", "tone", "description"]);
const agentSignalKeys = new Set(["label", "tone", "description"]);
const taskSignalKeys = new Set(["task_id", "label", "tone"]);
const sessionProgressKeys = new Set(["phase", "percent", "remaining_minutes_min", "remaining_minutes_max", "confidence"]);
const progressPhaseSet = new Set(SESSION_PROGRESS_PHASES);
const progressConfidenceSet = new Set(SESSION_PROGRESS_CONFIDENCES);
const signalCache = new Map();
const signalStateMetadata = new WeakMap();
const MAX_RECENT_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const SAFE_TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function normalizedTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) return null;
  return value;
}

function normalizedSignal(input, allowedKeys, reportedAt) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return null;
  const rawLabel = typeof input.label === "string" ? input.label.trim() : "";
  if (!rawLabel || rawLabel.length > SIGNAL_MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(rawLabel)) return null;
  const label = rawLabel.replace(/ {2,}/g, " ");
  const tone = input?.tone === undefined ? "neutral" : input.tone;
  if (!toneSet.has(tone)) return null;
  return { label, tone, reportedAt: normalizedTimestamp(reportedAt) };
}

export function normalizeSessionSignal(input, reportedAt = null) {
  return normalizedDescribedSignal(input, sessionSignalKeys, reportedAt);
}

export function normalizeSessionProgress(input, reportedAt = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !sessionProgressKeys.has(key))
    || !progressPhaseSet.has(input.phase)
    || !progressConfidenceSet.has(input.confidence)
    || !Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100) return null;
  const hasMin = input.remaining_minutes_min !== undefined;
  const hasMax = input.remaining_minutes_max !== undefined;
  if (hasMin !== hasMax) return null;
  if (hasMin && (!Number.isInteger(input.remaining_minutes_min) || !Number.isInteger(input.remaining_minutes_max)
    || input.remaining_minutes_min < 0 || input.remaining_minutes_max > 10080
    || input.remaining_minutes_min > input.remaining_minutes_max)) return null;
  if (["blocked", "complete"].includes(input.phase) && (hasMin || hasMax)) return null;
  if (input.phase === "complete" && input.percent !== 100) return null;
  const reported = normalizedTimestamp(reportedAt);
  return {
    phase: input.phase,
    percent: input.percent,
    ...(hasMin ? { remainingMinutesMin: input.remaining_minutes_min, remainingMinutesMax: input.remaining_minutes_max } : {}),
    confidence: input.confidence,
    reportedAt: reported,
  };
}

function isPlainEmptyObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.keys(value).length === 0;
}

function signalState(agent = null, session = null, tasks = new Map(), progress = null) {
  const state = { agent, session, progress, tasks };
  signalStateMetadata.set(state, {
    agentAt: agent?.reportedAt || null,
    sessionAt: session?.reportedAt || null,
    progressAt: progress?.reportedAt || null,
  });
  return state;
}

function signalTimestamp(state, scope) {
  const signal = state?.[scope];
  return signal?.reportedAt || signalStateMetadata.get(state)?.[`${scope}At`] || null;
}

function timestampValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
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

function normalizedDescribedSignal(input, allowedKeys, reportedAt) {
  const signal = normalizedSignal(input, allowedKeys, reportedAt);
  if (!signal || input.description === undefined) return signal;
  const rawDescription = typeof input.description === "string" ? input.description.trim() : "";
  if (!rawDescription
    || rawDescription.length > SIGNAL_MAX_DESCRIPTION_LENGTH
    || /[\u0000-\u001f\u007f]/.test(rawDescription)) return null;
  return { ...signal, description: rawDescription.replace(/ {2,}/g, " ") };
}

export function normalizeAgentSignal(input, reportedAt = null) {
  return normalizedDescribedSignal(input, agentSignalKeys, reportedAt);
}

export function normalizeTaskSignal(input, reportedAt = null) {
  const signal = normalizedSignal(input, taskSignalKeys, reportedAt);
  const taskId = typeof input?.task_id === "string" && SAFE_TASK_ID.test(input.task_id) ? input.task_id : null;
  return signal && taskId ? { taskId, ...signal } : null;
}

function signalsFromRecord(record) {
  const found = signalState();
  if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) return found;
  for (const content of record.message.content) {
    if (content?.type !== "tool_use") continue;
    const reportedAt = record.timestamp || record.message?.timestamp;
    if (AGENT_SIGNAL_MCP_TOOLS.has(content.name)) {
      const signal = normalizeAgentSignal(content.input, reportedAt);
      if (signal) setScopedSignal(found, "agent", signal, signal.reportedAt);
    }
    if (SESSION_SIGNAL_MCP_TOOLS.has(content.name)) {
      const signal = normalizeSessionSignal(content.input, reportedAt);
      if (signal) setScopedSignal(found, "session", signal, signal.reportedAt);
    }
    if (CLEAR_AGENT_SIGNAL_MCP_TOOLS.has(content.name) && isPlainEmptyObject(content.input)) {
      const timestamp = normalizedTimestamp(reportedAt);
      if (timestamp) setScopedSignal(found, "agent", null, timestamp);
    }
    if (CLEAR_SESSION_SIGNAL_MCP_TOOLS.has(content.name) && isPlainEmptyObject(content.input)) {
      const timestamp = normalizedTimestamp(reportedAt);
      if (timestamp) setScopedSignal(found, "session", null, timestamp);
    }
    if (SESSION_PROGRESS_MCP_TOOLS.has(content.name)) {
      const progress = normalizeSessionProgress(content.input, reportedAt);
      if (progress?.reportedAt) setProgress(found, progress, progress.reportedAt);
    }
    if (CLEAR_SESSION_PROGRESS_MCP_TOOLS.has(content.name) && isPlainEmptyObject(content.input)) {
      const timestamp = normalizedTimestamp(reportedAt);
      if (timestamp) setProgress(found, null, timestamp);
    }
    if (TASK_SIGNAL_MCP_TOOLS.has(content.name)) {
      const taskSignal = normalizeTaskSignal(content.input, reportedAt);
      if (taskSignal) {
        const { taskId, ...signal } = taskSignal;
        found.tasks.set(taskId, signal);
      }
    }
  }
  return found;
}

export function mergeTranscriptSignals(target, source) {
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
    const previous = target.tasks.get(taskId);
    if (!previous || timestampValue(signal.reportedAt) >= timestampValue(previous.reportedAt)) {
      target.tasks.set(taskId, signal);
    }
  }
  return target;
}

export function latestTranscriptSignals(records) {
  const latest = signalState();
  for (const record of records || []) mergeTranscriptSignals(latest, signalsFromRecord(record));
  return latest;
}

export function latestSessionSignal(records) {
  return latestTranscriptSignals(records).session;
}

export function latestSessionProgress(records) {
  return latestTranscriptSignals(records).progress;
}

export function latestAgentSignal(records) {
  return latestTranscriptSignals(records).agent;
}

export function latestTaskSignals(records) {
  return latestTranscriptSignals(records).tasks;
}

async function scanCompleteTranscript(file) {
  const latest = signalState();
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      mergeTranscriptSignals(latest, signalsFromRecord(JSON.parse(line)));
    } catch {
      // Ignore malformed or partially written JSONL records.
    }
  }
  return latest;
}

export async function readTranscriptSignals(file, recentRecords = []) {
  let stat;
  try { stat = fs.statSync(file); }
  catch { return signalState(); }

  const cached = signalCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.signals;

  let signals;
  if (cached && stat.size > cached.size && stat.size - cached.size <= MAX_RECENT_TRANSCRIPT_BYTES) {
    signals = mergeTranscriptSignals(
      mergeTranscriptSignals(signalState(), cached.signals),
      latestTranscriptSignals(recentRecords),
    );
  } else {
    signals = await scanCompleteTranscript(file);
  }
  signalCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, signals });
  return signals;
}

export async function readLatestSessionSignal(file, recentRecords = []) {
  return (await readTranscriptSignals(file, recentRecords)).session;
}

export function clearSessionSignalCache() {
  signalCache.clear();
}
