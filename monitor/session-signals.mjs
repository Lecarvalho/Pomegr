import fs from "node:fs";
import readline from "node:readline";

export const SESSION_SIGNAL_TOOL = "report_session_signal";
export const SESSION_SIGNAL_MCP_TOOL = `mcp__threadlight__${SESSION_SIGNAL_TOOL}`;
export const SESSION_SIGNAL_MAX_LABEL_LENGTH = 40;
export const SESSION_SIGNAL_TONES = ["neutral", "info", "positive", "warning", "negative"];

const toneSet = new Set(SESSION_SIGNAL_TONES);
const signalCache = new Map();
const MAX_RECENT_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

function normalizedTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) return null;
  return value;
}

export function normalizeSessionSignal(input, reportedAt = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (Object.keys(input).some((key) => key !== "label" && key !== "tone")) return null;
  const rawLabel = typeof input.label === "string" ? input.label.trim() : "";
  if (!rawLabel || rawLabel.length > SESSION_SIGNAL_MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(rawLabel)) return null;
  const label = rawLabel.replace(/ {2,}/g, " ");
  const tone = input?.tone === undefined ? "neutral" : input.tone;
  if (!toneSet.has(tone)) return null;
  return { label, tone, reportedAt: normalizedTimestamp(reportedAt) };
}

function signalFromRecord(record) {
  if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) return null;
  let latest = null;
  for (const content of record.message.content) {
    if (content?.type !== "tool_use" || content.name !== SESSION_SIGNAL_MCP_TOOL) continue;
    const signal = normalizeSessionSignal(content.input, record.timestamp || record.message?.timestamp);
    if (signal) latest = signal;
  }
  return latest;
}

export function latestSessionSignal(records) {
  let latest = null;
  for (const record of records || []) {
    const signal = signalFromRecord(record);
    if (signal) latest = signal;
  }
  return latest;
}

async function scanCompleteTranscript(file) {
  let latest = null;
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const signal = signalFromRecord(JSON.parse(line));
      if (signal) latest = signal;
    } catch {
      // Ignore malformed or partially written JSONL records.
    }
  }
  return latest;
}

export async function readLatestSessionSignal(file, recentRecords = []) {
  let stat;
  try { stat = fs.statSync(file); }
  catch { return null; }

  const cached = signalCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.signal;

  let signal;
  if (cached && stat.size > cached.size && stat.size - cached.size <= MAX_RECENT_TRANSCRIPT_BYTES) {
    signal = latestSessionSignal(recentRecords) || cached.signal;
  } else {
    signal = await scanCompleteTranscript(file);
  }
  signalCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, signal });
  return signal;
}

export function clearSessionSignalCache() {
  signalCache.clear();
}
