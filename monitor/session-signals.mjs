import fs from "node:fs";
import readline from "node:readline";

export const AGENT_SIGNAL_TOOL = "report_agent_signal";
export const AGENT_SIGNAL_MCP_TOOL = `mcp__threadlight__${AGENT_SIGNAL_TOOL}`;
export const SESSION_SIGNAL_TOOL = "report_session_signal";
export const SESSION_SIGNAL_MCP_TOOL = `mcp__threadlight__${SESSION_SIGNAL_TOOL}`;
export const TASK_SIGNAL_TOOL = "report_task_signal";
export const TASK_SIGNAL_MCP_TOOL = `mcp__threadlight__${TASK_SIGNAL_TOOL}`;
export const SIGNAL_MAX_LABEL_LENGTH = 20;
export const SIGNAL_MAX_DESCRIPTION_LENGTH = 160;
export const SESSION_SIGNAL_TONES = ["neutral", "info", "positive", "warning", "negative"];

const toneSet = new Set(SESSION_SIGNAL_TONES);
const sessionSignalKeys = new Set(["label", "tone", "description"]);
const agentSignalKeys = new Set(["label", "tone", "description"]);
const taskSignalKeys = new Set(["task_id", "label", "tone"]);
const signalCache = new Map();
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
  const found = { agent: null, session: null, tasks: new Map() };
  if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) return found;
  for (const content of record.message.content) {
    if (content?.type !== "tool_use") continue;
    const reportedAt = record.timestamp || record.message?.timestamp;
    if (content.name === AGENT_SIGNAL_MCP_TOOL) {
      const signal = normalizeAgentSignal(content.input, reportedAt);
      if (signal) found.agent = signal;
    }
    if (content.name === SESSION_SIGNAL_MCP_TOOL) {
      const signal = normalizeSessionSignal(content.input, reportedAt);
      if (signal) found.session = signal;
    }
    if (content.name === TASK_SIGNAL_MCP_TOOL) {
      const taskSignal = normalizeTaskSignal(content.input, reportedAt);
      if (taskSignal) {
        const { taskId, ...signal } = taskSignal;
        found.tasks.set(taskId, signal);
      }
    }
  }
  return found;
}

function mergeSignals(target, source) {
  if (source.agent) target.agent = source.agent;
  if (source.session) target.session = source.session;
  for (const [taskId, signal] of source.tasks) target.tasks.set(taskId, signal);
  return target;
}

export function latestTranscriptSignals(records) {
  const latest = { agent: null, session: null, tasks: new Map() };
  for (const record of records || []) mergeSignals(latest, signalsFromRecord(record));
  return latest;
}

export function latestSessionSignal(records) {
  return latestTranscriptSignals(records).session;
}

export function latestAgentSignal(records) {
  return latestTranscriptSignals(records).agent;
}

export function latestTaskSignals(records) {
  return latestTranscriptSignals(records).tasks;
}

async function scanCompleteTranscript(file) {
  const latest = { agent: null, session: null, tasks: new Map() };
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      mergeSignals(latest, signalsFromRecord(JSON.parse(line)));
    } catch {
      // Ignore malformed or partially written JSONL records.
    }
  }
  return latest;
}

export async function readTranscriptSignals(file, recentRecords = []) {
  let stat;
  try { stat = fs.statSync(file); }
  catch { return { agent: null, session: null, tasks: new Map() }; }

  const cached = signalCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.signals;

  let signals;
  if (cached && stat.size > cached.size && stat.size - cached.size <= MAX_RECENT_TRANSCRIPT_BYTES) {
    signals = mergeSignals({ agent: cached.signals.agent, session: cached.signals.session, tasks: new Map(cached.signals.tasks) }, latestTranscriptSignals(recentRecords));
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
