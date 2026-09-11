import { createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePipelineLogRecord } from "../monitor/pipeline-log-schema.mjs";

const DEFAULT_DIRECTORY = "outputs/pipeline-logs";
const MAX_FILE_COUNT = 10;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_PENDING = 10_000;
const RESERVOIR_SIZE = 2_048;
const MAX_HEALTH_HISTORY = 100;
const MAX_FOLLOW_POLL_BYTES = 1 * 1024 * 1024;
const MAX_FOLLOW_RECORDS = 1_000;
const LOG_FILE = /^pipeline-\d{8}T\d{9}Z-[a-f0-9]{12}-\d{6}\.jsonl$/u;

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function parseTime(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError(`${label} must be an ISO timestamp`);
  return time;
}

function parseBoundary(value, label, now = Date.now()) {
  if (!value) return null;
  const relative = /^(5m|1h)$/u.exec(value);
  if (relative) return now - (relative[1] === "5m" ? 5 * 60_000 : 60 * 60_000);
  return parseTime(value, label);
}

function safeStage(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value) ? value : "unknown";
}

function keyFor(record) {
  return `${record.run}|${record.lane}|${record.startMs}`;
}

function sampleAdd(stat, duration) {
  stat.samples += 1;
  stat.sum += duration;
  stat.min = Math.min(stat.min, duration);
  stat.max = Math.max(stat.max, duration);
  if (stat.reservoir.length < RESERVOIR_SIZE) stat.reservoir.push(duration);
  else {
    // A deterministic reservoir is bounded and has no hidden randomness in reports.
    const index = (stat.samples * 2_654_435_761 >>> 0) % stat.samples;
    if (index < RESERVOIR_SIZE) stat.reservoir[index] = duration;
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction))];
}

function publicStat(stat) {
  if (!stat?.samples) return { count: 0, failed: stat?.failed || 0, incomplete: stat?.incomplete || 0 };
  return {
    count: stat.count,
    failed: stat.failed,
    incomplete: stat.incomplete,
    minMs: stat.min,
    maxMs: stat.max,
    averageMs: Math.round((stat.sum / stat.samples) * 100) / 100,
    p50Ms: percentile(stat.reservoir, 0.5),
    p95Ms: percentile(stat.reservoir, 0.95),
    quantiles: stat.count > RESERVOIR_SIZE ? "sampled" : "exact",
  };
}

function healthFailures(snapshot) {
  const output = [];
  for (const provider of Array.isArray(snapshot?.providers) ? snapshot.providers : []) {
    for (const detail of Object.values(provider?.failureDetails || {})) {
      if (!detail || output.length >= 20) continue;
      const item = { stage: safeStage(detail.stage), reason: safeStage(detail.reason) };
      const fields = Array.isArray(detail.validation?.issues)
        ? detail.validation.issues.map((issue) => safeStage(issue?.field)).filter((field) => field !== "unknown").slice(0, 5)
        : [];
      if (fields.length) item.validationFields = fields;
      output.push(item);
    }
  }
  return output;
}

export function parseDiagnosticsLogsArgs(args = [], { now = Date.now() } = {}) {
  const options = { directory: DEFAULT_DIRECTORY, input: "", since: null, until: null, stage: "", json: false, follow: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--input") options.input = String(args[index += 1] || "");
    else if (argument === "--directory") options.directory = String(args[index += 1] || "");
    else if (argument === "--since") options.since = parseBoundary(String(args[index += 1] || ""), "--since", now);
    else if (argument === "--until") options.until = parseBoundary(String(args[index += 1] || ""), "--until", now);
    else if (argument === "--stage") options.stage = safeStage(String(args[index += 1] || ""));
    else if (argument === "--json") options.json = true;
    else if (argument === "--markdown") options.json = false;
    else if (argument === "--follow") options.follow = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new TypeError("Unknown diagnostics logs option");
  }
  if (options.input && options.directory !== DEFAULT_DIRECTORY) throw new TypeError("Use either --input or --directory");
  if (!options.input && !options.directory) throw new TypeError("A log input is required");
  if (options.stage === "unknown" && args.includes("--stage")) throw new TypeError("--stage is invalid");
  if (options.since && options.until && options.since > options.until) throw new TypeError("--since must precede --until");
  return Object.freeze(options);
}

export async function findPipelineLogFiles(options, { fs = { lstat, readdir } } = {}) {
  if (options.input) {
    const entry = await fs.lstat(resolve(options.input));
    return entry.isFile() && !entry.isSymbolicLink() ? [resolve(options.input)] : [];
  }
  let names;
  try { names = await fs.readdir(resolve(options.directory)); } catch { return []; }
  const candidates = [];
  for (const name of names) {
    if (!LOG_FILE.test(name)) continue;
    const path = resolve(options.directory, name);
    try {
      const entry = await fs.lstat(path);
      if (entry.isFile() && !entry.isSymbolicLink()) candidates.push({ path, mtimeMs: entry.mtimeMs, size: entry.size });
    } catch { /* A rotating file may disappear before it is read. */ }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || basename(right.path).localeCompare(basename(left.path)));
  return candidates.slice(0, MAX_FILE_COUNT).sort((left, right) => left.mtimeMs - right.mtimeMs
    || basename(left.path).localeCompare(basename(right.path))).map((entry) => entry.path);
}

async function readLog(path, consume, { createStream = createReadStream, maxBytes = MAX_TOTAL_BYTES } = {}) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) return { bytes: 0, truncated: false, skipped: true };
  let bytes = 0;
  let remainder = Buffer.alloc(0);
  let discardingLine = false;
  let truncated = false;
  const stream = createStream(path, { highWaterMark: 16 * 1024 });
  for await (const chunk of stream) {
    const allowed = Math.max(0, maxBytes - bytes);
    const part = chunk.length > allowed ? chunk.subarray(0, allowed) : chunk;
    bytes += part.length;
    if (part.length) {
      let data = remainder.length ? Buffer.concat([remainder, part]) : part;
      if (discardingLine) {
        const newline = data.indexOf(10);
        if (newline < 0) continue;
        data = data.subarray(newline + 1);
        discardingLine = false;
      }
      let start = 0;
      for (;;) {
        const end = data.indexOf(10, start);
        if (end < 0) break;
        const line = data.subarray(start, end);
        if (line.length > MAX_LINE_BYTES) truncated = true;
        else consume(line.toString("utf8").replace(/\r$/u, ""));
        start = end + 1;
      }
      remainder = data.subarray(start);
      if (remainder.length > MAX_LINE_BYTES) {
        truncated = true;
        remainder = Buffer.alloc(0);
        discardingLine = true;
      }
    }
    if (part.length < chunk.length) { truncated = true; stream.destroy(); break; }
  }
  // A partial final line is never parsed: it may be a concurrent writer's unfinished JSON.
  if (remainder.length || discardingLine) truncated = true;
  return { bytes, truncated, skipped: false };
}

export async function analyzePipelineLogs(options = {}, dependencies = {}) {
  const settings = { ...options, maxFiles: positiveInteger(options.maxFiles, MAX_FILE_COUNT, MAX_FILE_COUNT), maxBytes: positiveInteger(options.maxBytes, MAX_TOTAL_BYTES, MAX_TOTAL_BYTES) };
  const files = await findPipelineLogFiles(settings, dependencies);
  const state = { totalRecords: 0, malformedRecords: 0, truncatedLines: 0, bytesRead: 0, filesRead: 0, skippedFiles: 0, earliest: null, latest: null, gaps: 0, droppedRecords: 0, rejectedRecords: 0, healthFailures: [], healthHistory: [], pending: new Map(), pendingTruncated: false, stages: new Map() };
  const stage = (name) => {
    if (!state.stages.has(name)) state.stages.set(name, { count: 0, failed: 0, incomplete: 0, samples: 0, sum: 0, min: Infinity, max: 0, reservoir: [] });
    return state.stages.get(name);
  };
  const consume = (line) => {
    let parsed;
    try { parsed = JSON.parse(line); } catch { state.malformedRecords += 1; return; }
    const record = normalizePipelineLogRecord(parsed);
    if (!record) { state.malformedRecords += 1; return; }
    const at = Date.parse(record.at);
    if (!Number.isFinite(at) || (settings.since && at < settings.since) || (settings.until && at > settings.until)) return;
    state.totalRecords += 1;
    state.earliest = state.earliest === null ? at : Math.min(state.earliest, at);
    state.latest = state.latest === null ? at : Math.max(state.latest, at);
    if (record.kind === "gap") { state.gaps += 1; state.droppedRecords += record.droppedRecords; state.rejectedRecords += record.rejectedRecords; return; }
    if (record.kind === "health") {
      const failures = healthFailures(record.snapshot);
      state.healthFailures = failures;
      if (failures.length) {
        if (state.healthHistory.length >= MAX_HEALTH_HISTORY) state.healthHistory.shift();
        state.healthHistory.push({ at: record.at, failures });
      }
      return;
    }
    if (record.kind === "span_start") {
      if (!settings.stage || record.stage === settings.stage) {
        if (state.pending.size < MAX_PENDING) state.pending.set(keyFor(record), { stage: record.stage }); else state.pendingTruncated = true;
      }
      return;
    }
    if (record.kind === "span" && (!settings.stage || record.stage === settings.stage)) {
      const target = stage(record.stage); target.count += 1;
      if (record.outcome === "failed") target.failed += 1;
      if (Number.isFinite(record.durationMs) && record.durationMs >= 0) sampleAdd(target, record.durationMs);
      state.pending.delete(keyFor(record));
    }
  };
  let remaining = settings.maxBytes;
  for (const path of files.slice(0, settings.maxFiles)) {
    if (!remaining) { state.truncatedLines += 1; break; }
    try {
      const result = await readLog(path, consume, { ...dependencies, maxBytes: remaining });
      state.bytesRead += result.bytes; remaining -= result.bytes;
      state.filesRead += result.skipped ? 0 : 1; state.skippedFiles += result.skipped ? 1 : 0;
      state.truncatedLines += result.truncated ? 1 : 0;
    } catch {
      if (settings.input) throw new Error("Diagnostics log input is unavailable");
      state.skippedFiles += 1;
    }
  }
  for (const pending of state.pending.values()) stage(pending.stage).incomplete += 1;
  const stages = Object.fromEntries([...state.stages.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, stat]) => [name, publicStat(stat)]));
  return Object.freeze({
    observedCoverage: { earliest: state.earliest === null ? null : new Date(state.earliest).toISOString(), latest: state.latest === null ? null : new Date(state.latest).toISOString(), wholeSession: false },
    files: { read: state.filesRead, skipped: state.skippedFiles, selected: files.length, bytesRead: state.bytesRead, byteLimit: settings.maxBytes },
    records: { total: state.totalRecords, malformed: state.malformedRecords, incompleteTrailingFiles: state.truncatedLines },
    gaps: { records: state.gaps, droppedRecords: state.droppedRecords, rejectedRecords: state.rejectedRecords },
    pending: { count: state.pending.size, truncated: state.pendingTruncated }, stages,
    healthFailures: state.healthFailures, healthHistory: state.healthHistory,
  });
}

export function formatDiagnosticsLogs(report) {
  const lines = ["# Pomegr pipeline log analysis", "", `Observed coverage: ${report.observedCoverage.earliest || "none"} to ${report.observedCoverage.latest || "none"} (retained logs; not a whole session)`, `Records: ${report.records.total}; malformed: ${report.records.malformed}; incomplete trailing files: ${report.records.incompleteTrailingFiles}`, `Files: ${report.files.read}/${report.files.selected}; bytes read: ${report.files.bytesRead}; skipped: ${report.files.skipped}`, `Gaps: ${report.gaps.records}; dropped records: ${report.gaps.droppedRecords}; rejected records: ${report.gaps.rejectedRecords}`, `Unfinished spans: ${report.pending.count}${report.pending.truncated ? "+ (tracking limit reached)" : ""}`, "", "## Stage timings", "", "| Stage | Count | Failed | Incomplete | Min | Avg | p50 | p95 | Max | Quantiles |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"];
  const timing = (value) => value === undefined || value === null ? "—" : `${value}ms`;
  const entries = Object.entries(report.stages);
  if (!entries.length) lines.push("| No matching span records. |  |  |  |  |  |  |  |  |  |");
  for (const [name, stat] of entries) lines.push(`| ${name} | ${stat.count} | ${stat.failed} | ${stat.incomplete} | ${timing(stat.minMs)} | ${timing(stat.averageMs)} | ${timing(stat.p50Ms)} | ${timing(stat.p95Ms)} | ${timing(stat.maxMs)} | ${stat.quantiles || "exact"} |`);
  if (report.healthFailures.length) {
    lines.push("", "## Latest health failures", "");
    for (const failure of report.healthFailures) lines.push(`- ${failure.stage} · ${failure.reason}${failure.validationFields?.length ? ` · fields: ${failure.validationFields.join(", ")}` : ""}`);
  }
  return lines.join("\n");
}

export function diagnosticsLogsHelp() {
  return ["Usage: node scripts/diagnostics-logs.mjs [options]", "", "Options:", "  --input <file>       Analyze one log file", "  --directory <dir>    Analyze recent writer logs (default outputs/pipeline-logs)", "  --since <ISO|5m|1h>  Limit observed records by timestamp", "  --until <ISO>        Limit observed records by timestamp", "  --stage <name>       Limit span timings to one stage", "  --json               Print JSON", "  --markdown           Print Markdown (default)", "  --follow             Tail validated new records as JSON lines from current EOF", "  --help, -h           Show this help"].join("\n");
}

function recordMatches(options, record) {
  const at = Date.parse(record.at);
  return Number.isFinite(at) && (!options.since || at >= options.since) && (!options.until || at <= options.until)
    && (!options.stage || !Object.hasOwn(record, "stage") || record.stage === options.stage);
}

/** Polling tailer that retains only offsets and at most one bounded partial line per writer file. */
export async function createPipelineLogFollower(options = {}, { fs = { lstat, open }, listFiles = findPipelineLogFiles } = {}) {
  const offsets = new Map();
  const partials = new Map();
  const pollByteLimit = positiveInteger(options.maxPollBytes, MAX_FOLLOW_POLL_BYTES, MAX_FOLLOW_POLL_BYTES);
  const pollRecordLimit = positiveInteger(options.maxPollRecords, MAX_FOLLOW_RECORDS, MAX_FOLLOW_RECORDS);
  for (const path of await listFiles(options)) {
    try {
      const entry = await fs.lstat(path);
      if (entry.isFile() && !entry.isSymbolicLink()) offsets.set(path, entry.size);
    } catch { /* A rotation may remove a file during initialization. */ }
  }
  let activePoll = null;
  const pollOnce = async () => {
      const output = [];
      let bytesRead = 0;
      let partialCoverage = false;
      let missedRotation = false;
      const files = await listFiles(options);
      const live = new Set(files);
      for (const path of offsets.keys()) if (!live.has(path)) { offsets.delete(path); partials.delete(path); missedRotation = true; }
      for (const path of files) {
        if (bytesRead >= pollByteLimit || output.length >= pollRecordLimit) { partialCoverage = true; break; }
        let entry;
        try { entry = await fs.lstat(path); } catch { missedRotation = true; continue; }
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const priorOffset = offsets.get(path) ?? 0;
        if (entry.size < priorOffset) { missedRotation = true; partials.delete(path); }
        let offset = entry.size < priorOffset ? 0 : priorOffset;
        let partialState = partials.get(path) || { buffer: Buffer.alloc(0), discardingLine: false };
        let partial = partialState.buffer;
        let discardingLine = partialState.discardingLine;
        if (entry.size <= offset) {
          offsets.set(path, offset);
          if (partial.length || discardingLine) partialCoverage = true;
          continue;
        }
        let handle;
        try { handle = await fs.open(path, "r"); } catch { missedRotation = true; continue; }
        try {
          const chunk = Buffer.allocUnsafe(16 * 1024);
          while (offset < entry.size && bytesRead < pollByteLimit && output.length < pollRecordLimit) {
            const chunkOffset = offset;
            const amount = Math.min(chunk.length, entry.size - offset, pollByteLimit - bytesRead);
            const read = await handle.read(chunk, 0, amount, offset);
            if (!read.bytesRead) break;
            offset += read.bytesRead;
            bytesRead += read.bytesRead;
            let bytes = partial.length ? Buffer.concat([partial, chunk.subarray(0, read.bytesRead)]) : chunk.subarray(0, read.bytesRead);
            let dataStartOffset = chunkOffset - partial.length;
            if (discardingLine) {
              const newline = bytes.indexOf(10);
              if (newline < 0) continue;
              bytes = bytes.subarray(newline + 1);
              dataStartOffset = chunkOffset + newline + 1;
              discardingLine = false;
            }
            let start = 0;
            let stopOffset = null;
            for (;;) {
              const end = bytes.indexOf(10, start);
              if (end < 0) break;
              const line = bytes.subarray(start, end);
              if (line.length <= MAX_LINE_BYTES) {
                try {
                  const record = normalizePipelineLogRecord(JSON.parse(line.toString("utf8").replace(/\r$/u, "")));
                  if (record && recordMatches(options, record)) output.push(record);
                } catch { /* Live output never reports unvalidated source data. */ }
              }
              start = end + 1;
              if (output.length >= pollRecordLimit) { stopOffset = dataStartOffset + start; break; }
            }
            if (output.length >= pollRecordLimit) {
              partialCoverage = true;
              offset = stopOffset ?? offset;
              partial = Buffer.alloc(0);
              discardingLine = false;
              break;
            }
            partial = bytes.subarray(start);
            if (partial.length > MAX_LINE_BYTES) { partial = Buffer.alloc(0); discardingLine = true; partialCoverage = true; }
          }
          if (partial.length || discardingLine) partialCoverage = true;
          if (bytesRead >= pollByteLimit || output.length >= pollRecordLimit) partialCoverage = true;
        } finally { await handle.close(); }
        offsets.set(path, offset);
        if (partial.length || discardingLine) partials.set(path, { buffer: partial, discardingLine }); else partials.delete(path);
      }
      const coverage = Object.freeze({
        status: missedRotation ? "rotation_missed" : partialCoverage ? "partial" : "complete",
        missedRotation,
        partial: partialCoverage,
        bytesRead,
        byteLimit: pollByteLimit,
        recordsReturned: output.length,
        recordLimit: pollRecordLimit,
      });
      Object.defineProperty(output, "coverage", { value: coverage, enumerable: false });
      return Object.freeze(output);
  };
  return Object.freeze({
    poll() {
      if (!activePoll) activePoll = pollOnce().finally(() => { activePoll = null; });
      return activePoll;
    },
  });
}

async function main() {
  let options;
  try { options = parseDiagnosticsLogsArgs(process.argv.slice(2)); } catch { process.stderr.write("[pomegr] Invalid diagnostics log options. Use --help.\n"); process.exitCode = 1; return; }
  if (options.help) { process.stdout.write(`${diagnosticsLogsHelp()}\n`); return; }
  if (options.follow) {
    try {
      const follower = await createPipelineLogFollower(options);
      let polling = false;
      const print = async () => {
        if (polling) return;
        polling = true;
        try {
          const records = await follower.poll();
          for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
          if (records.coverage.status !== "complete") process.stderr.write(`[pomegr] Follow coverage: ${records.coverage.status}.\n`);
        } finally { polling = false; }
      };
      await print();
      setInterval(() => { void print(); }, 1_000);
    } catch {
      process.stderr.write("[pomegr] Unable to follow diagnostics logs.\n");
      process.exitCode = 1;
    }
    return;
  }
  try {
    const report = await analyzePipelineLogs(options);
    process.stdout.write(`${options.json ? JSON.stringify(report) : formatDiagnosticsLogs(report)}\n`);
  } catch {
    process.stderr.write("[pomegr] Unable to read diagnostics logs.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
