#!/usr/bin/env node
/**
 * Passive baseline measurements B1 to B6 for the monitor performance plan
 * (docs/internal/plans/monitor-performance.md). One plain Node script, no dependencies.
 *
 * It only sends GET requests to the loopback monitor (default 127.0.0.1:4317) and web proxy
 * (127.0.0.1:3003), reads the monitor's pipeline logs, lists Windows process counters through
 * `powershell.exe` and `Get-CimInstance Win32_Process`, and calls `fs.stat` (size and
 * modification time only) on provider transcript files. It never reads transcript content,
 * never launches a provider session, never signals a process, and writes nothing except the
 * result file named by `--out`. Output contains no session IDs, titles, prompts, or paths;
 * sessions appear as "live session A", "historical small/medium/large".
 *
 * Usage (run from anywhere; Node 22 or newer; Windows only for process counters):
 *
 *   node measure.mjs conditions            Record the environment: checkout, load, catalog size.
 *   node measure.mjs startup               B1 + B4. Start it first, then restart the dev app
 *                                          exactly once (the restart-pomegr skill script). It
 *                                          detects the new monitor process, takes its creation time
 *                                          as t0 and records milestones for 300 s after t0.
 *   node measure.mjs startup-logs --created <ISO time>
 *                                          Re-derive the pipeline-log startup milestones of a start that
 *                                          has already happened (the monitor creation time is in B1).
 *   node measure.mjs steady [--only b2,b6,b5,b3]
 *                                          B2, B6, B5 and B3, in that order by default. B6 waits
 *                                          until the monitor has run 10 minutes, then watches
 *                                          5 minutes without sending any request; it runs before B5
 *                                          so that session hydration does not pollute that window.
 *                                          B5 skips any session the monitor has already committed, so
 *                                          it times cold opens only. B3 watches every live Claude
 *                                          session (up to 4) for 200 s and needs sessions that are
 *                                          being written during that time.
 *   node measure.mjs b3-analyze --in raw.json
 *                                          Re-run the B3 pairing on the raw timeline that
 *                                          `steady` stored with `--out`.
 *
 * Options: --out <file> (full JSON incl. raw B3 timeline), --label <text>, --monitor <url>,
 * --web <url>, --checkout <dir> (main checkout whose outputs/pipeline-logs is read; default
 * C:\Workspace\repos\Pomegr), --claude-projects <dir>, --codex-sessions <dir>,
 * --attach [--attach-max-age-s 120] (startup: attach to a monitor started less than 120 s ago
 * instead of waiting for a restart; milestones already past are reported as upper bounds),
 * --startup-s 300, --wait-s 180 (startup: how long to wait for the restart),
 * --b3-s 200, --b3-stat-ms 50, --b3-get-ms 50, --b3-max-live 4,
 * --b5-skip 0 (take the k-th nearest candidate per size class; use a different value than the
 * baseline for after-fix runs, because a first open leaves a checkpoint behind),
 * --b5-sizes 100k,1m,10m, --b2-max 3, --poll-ms 50, --open-timeout-s 60 (B2/B5: give up waiting for ready),
 * --b6-s 300, --b6-min-uptime-s 600, --no-wait.
 *
 * Time bases: all instants are epoch milliseconds from the machine clock, the same clock that
 * stamps process creation, file modification, and pipeline-log records. B1/B4 elapsed times are
 * relative to the monitor process creation time reported by Windows.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const nowMs = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const sleepUntil = (epochMs) => sleep(epochMs - nowMs());
const r1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
const log = (...parts) => process.stderr.write(`[measure ${new Date().toISOString().slice(11, 23)}] ${parts.join(" ")}\n`);

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return { command: positional[0] || "help", options };
}
const { command, options } = parseArgs(process.argv.slice(2));
const num = (key, fallback) => (Number.isFinite(Number(options[key])) && options[key] !== undefined && options[key] !== true ? Number(options[key]) : fallback);
const cfg = {
  monitor: String(options.monitor || "http://127.0.0.1:4317"),
  web: String(options.web || "http://127.0.0.1:3003"),
  checkout: String(options.checkout || "C:\\Workspace\\repos\\Pomegr"),
  claudeProjects: String(options["claude-projects"] || path.join(os.homedir(), ".claude", "projects")),
  codexSessions: String(options["codex-sessions"] || path.join(os.homedir(), ".codex", "sessions")),
  label: String(options.label || "unlabeled"),
  pollMs: num("poll-ms", 50),
};

// ---------------------------------------------------------------- statistics

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, median: null, p95: null, max: null };
  const middle = (sorted.length - 1) / 2;
  const median = (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2;
  // Nearest-rank 95th percentile: an observed value, never an interpolated one.
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  return { n: sorted.length, min: r1(sorted[0]), median: r1(median), p95: r1(p95), max: r1(sorted[sorted.length - 1]) };
}

// ---------------------------------------------------------------- HTTP

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/** One GET with a keep-alive agent. Never throws; failures carry only an error code. */
function get(base, target, { headers = {}, timeoutMs = 20_000, keepBody = true } = {}, attempt = 0) {
  return new Promise((resolve) => {
    const start = nowMs();
    const url = new URL(target, base);
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET", agent, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; if (keepBody) chunks.push(chunk); });
      res.on("end", () => resolve({ ok: true, status: res.statusCode, headers: res.headers, bytes, body: keepBody ? Buffer.concat(chunks) : null, start, end: nowMs() }));
      res.on("error", (error) => resolve({ ok: false, error: error.code || "response_error", start, end: nowMs() }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (error) => {
      if (error.code === "ECONNRESET" && attempt === 0) { resolve(get(base, target, { headers, timeoutMs, keepBody }, 1)); return; }
      resolve({ ok: false, error: error.code || "request_error", start, end: nowMs() });
    });
    req.end();
  });
}
function json(response) {
  if (!response?.ok || !response.body?.length) return null;
  try { return JSON.parse(response.body.toString("utf8")); } catch { return null; }
}
const header = (response, name) => response?.headers?.[name] ?? null;

// ---------------------------------------------------------------- processes (CIM)

const PS_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"];

/** Win32_Process rows via `Get-CimInstance`. `filter` is an allowlisted WQL clause. */
function cim(filter = "") {
  const clause = /^[A-Za-z]+ = '?[A-Za-z0-9_.-]+'?$/u.test(filter) ? ` -Filter '${filter.replaceAll("'", "''")}'` : "";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `$rows = Get-CimInstance Win32_Process${clause} | ForEach-Object {`,
    "  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name;",
    "    created = $(if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 });",
    "    cpu100ns = [int64]$_.KernelModeTime + [int64]$_.UserModeTime; workingSet = [int64]$_.WorkingSetSize; cmd = [string]$_.CommandLine }",
    "}",
    "[pscustomobject]@{ sampledAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processes = @($rows) } | ConvertTo-Json -Compress -Depth 4",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell.exe", [...PS_ARGS, encoded], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60_000, encoding: "utf8" }, (error, stdout) => {
      if (error) { resolve({ ok: false, error: error.code || "powershell_failed", sampledAt: nowMs(), processes: [] }); return; }
      try {
        const parsed = JSON.parse(stdout);
        resolve({ ok: true, sampledAt: parsed.sampledAt, processes: (parsed.processes || []).filter(Boolean) });
      } catch { resolve({ ok: false, error: "powershell_output", sampledAt: nowMs(), processes: [] }); }
    });
  });
}

/** A role label from the command line. The command line itself is never kept or printed. */
function roleOf(process_) {
  const name = String(process_.name || "").toLowerCase();
  const cmd = String(process_.cmd || "").toLowerCase();
  if (name !== "node.exe") return name || "unknown";
  if (cmd.includes("dev-cli")) return "pomegr monitor";
  if (cmd.includes("vinext")) return "pomegr web dev server";
  if (cmd.includes("eslint")) return "eslint";
  if (cmd.includes("mcp")) return "mcp server";
  if (cmd.includes("npm") || cmd.includes("scripts/dev.mjs")) return "npm or dev launcher";
  return "node (other)";
}
const publicProcess = (process_) => ({ pid: process_.pid, startedAt: new Date(process_.created).toISOString(), cpuSeconds: r1(process_.cpu100ns / 1e7), rssMb: r1(process_.workingSet / 1048576) });

/** Monitor processes: node.exe running server/dev-cli.mjs. Newest creation time first. */
async function findMonitors() {
  const sample = await cim("Name = 'node.exe'");
  const monitors = sample.processes.filter((process_) => roleOf(process_) === "pomegr monitor").sort((a, b) => b.created - a.created);
  return { ok: sample.ok, sampledAt: sample.sampledAt, monitors };
}
async function sampleProcess(pid) {
  const sample = await cim(`ProcessId = ${Math.trunc(pid)}`);
  const found = sample.processes[0];
  return found ? { ok: true, sampledAt: sample.sampledAt, cpu100ns: found.cpu100ns, workingSet: found.workingSet, created: found.created } : { ok: false, sampledAt: sample.sampledAt };
}

// ---------------------------------------------------------------- git (read-only, main checkout)

function git(args) {
  return new Promise((resolve) => {
    execFile("git", ["--no-optional-locks", "-C", cfg.checkout, ...args], { windowsHide: true, timeout: 20_000, encoding: "utf8" }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}
async function checkoutFacts() {
  const [head, branch, status, committedAt] = await Promise.all([
    git(["rev-parse", "--short", "HEAD"]), git(["branch", "--show-current"]), git(["status", "--short"]), git(["log", "-1", "--format=%cI"]),
  ]);
  return { head, branch, dirty: status === null ? null : status.length > 0, headCommittedAt: committedAt };
}

// ---------------------------------------------------------------- transcript index (names and sizes only)

const safeReaddir = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const safeSize = (file) => { try { return fs.statSync(file).size; } catch { return null; } };

/** `provider:localId` to the main transcript path and the Claude subagents directory. No content is read. */
function buildTranscriptIndex() {
  const index = new Map();
  for (const project of safeReaddir(cfg.claudeProjects)) {
    if (!project.isDirectory()) continue;
    const dir = path.join(cfg.claudeProjects, project.name);
    for (const entry of safeReaddir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const localId = entry.name.slice(0, -".jsonl".length);
      index.set(`claude:${localId}`, { provider: "claude", main: path.join(dir, entry.name), subagents: path.join(dir, localId, "subagents") });
    }
  }
  for (const year of safeReaddir(cfg.codexSessions)) {
    if (!year.isDirectory()) continue;
    for (const month of safeReaddir(path.join(cfg.codexSessions, year.name))) {
      if (!month.isDirectory()) continue;
      for (const day of safeReaddir(path.join(cfg.codexSessions, year.name, month.name))) {
        if (!day.isDirectory()) continue;
        const dir = path.join(cfg.codexSessions, year.name, month.name, day.name);
        for (const entry of safeReaddir(dir)) {
          const match = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(entry.name);
          if (entry.isFile() && match) index.set(`codex:${match[1]}`, { provider: "codex", main: path.join(dir, entry.name), subagents: null });
        }
      }
    }
  }
  return index;
}
function subagentFiles(entry) {
  if (!entry?.subagents) return [];
  return safeReaddir(entry.subagents).filter((file) => file.isFile() && file.name.endsWith(".jsonl")).map((file) => path.join(entry.subagents, file.name));
}

/** Newest modification time across a session's main and subagent transcripts (0 when unknown). */
function latestWriteMs(entry) {
  let newest = 0;
  for (const file of entry ? [entry.main, ...subagentFiles(entry)] : []) {
    try { newest = Math.max(newest, fs.statSync(file).mtimeMs); } catch { /* vanished */ }
  }
  return newest;
}
/** Live rows, most recently written first. This order names "live session A, B, ..." in B1 and B2. */
function liveRowsByRecentWrite(shell, index) {
  return (shell?.sessions || []).filter((row) => row.isLive)
    .map((row) => ({ row, mtime: latestWriteMs(index.get(row.id)) })).sort((a, b) => b.mtime - a.mtime).map((item) => item.row);
}

// ---------------------------------------------------------------- catalog helpers

async function catalogShell() { return json(await get(cfg.monitor, "/api/sessions")); }
async function directoryPage(cursor = "", pageSize = 100) {
  const params = new URLSearchParams({ mode: "directory", filter: "all", pageSize: String(pageSize) });
  if (cursor) params.set("cursor", cursor);
  return json(await get(cfg.monitor, `/api/sessions?${params}`));
}
async function directoryRows(limit = 5000) {
  const rows = [];
  let cursor = "";
  for (let page = 0; page < 80 && rows.length < limit; page += 1) {
    const body = await directoryPage(cursor);
    if (!body?.sessions) break;
    rows.push(...body.sessions);
    cursor = body.nextCursor || "";
    if (!cursor) break;
  }
  return rows;
}
const domainPath = (sessionId, domain = "session-summary", revision = null) => {
  const params = new URLSearchParams({ sessionId, domain });
  if (revision !== null) params.set("revision", String(revision));
  return `/api/session-domain?${params}`;
};

// ---------------------------------------------------------------- pipeline logs

/** Spans, counters and file facts from `outputs/pipeline-logs/*.jsonl` records stamped inside [fromMs, toMs]. */
async function readPipelineWindow(fromMs, toMs) {
  const dir = path.join(cfg.checkout, "outputs", "pipeline-logs");
  const files = [];
  for (const entry of safeReaddir(dir)) {
    if (!entry.isFile() || !/^pipeline-.*\.jsonl$/u.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    const started = /^pipeline-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/u.exec(entry.name);
    const startedMs = started ? Date.UTC(+started[1], +started[2] - 1, +started[3], +started[4], +started[5], +started[6], +started[7]) : 0;
    if (stat.mtimeMs >= fromMs - 2000 && startedMs <= toMs + 2000) files.push(full);
  }
  const spans = [];
  const counters = new Map();
  const runs = new Set();
  let records = 0;
  for (const file of files) {
    const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      const isSpan = line.includes('"kind":"span"') && !line.includes('"kind":"span_start"');
      if (!isSpan && !line.includes('"kind":"counter"')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const at = Date.parse(record.at);
      if (!(at >= fromMs && at <= toMs)) continue;
      records += 1;
      runs.add(record.run);
      if (record.kind === "span" && Number.isFinite(record.durationMs)) {
        spans.push({ stage: record.stage, domain: record.domain, provider: record.provider, lane: record.priorityLane, outcome: record.outcome, durationMs: record.durationMs, scope: record.scope, endAt: at });
      } else if (record.kind === "counter" && Number.isFinite(record.value)) {
        if (!counters.has(record.counter)) counters.set(record.counter, []);
        counters.get(record.counter).push({ at, value: record.value, startMs: record.startMs });
      }
    }
  }
  return { files: files.length, records, runs: runs.size, spans, counters };
}
/** Duration summary of the window's spans for one stage, optionally narrowed by a predicate. */
function stageStats(window, stage, narrow = () => true, windowMs = null) {
  const durations = window.spans.filter((span) => span.stage === stage && narrow(span)).map((span) => span.durationMs);
  return { ...summarize(durations), ...(windowMs ? { perMinute: r1((durations.length / windowMs) * 60_000) } : {}) };
}

/**
 * Startup milestones that the pipeline log records for sessions that were live when the monitor
 * started (acquisition lane `urgent`), as elapsed milliseconds from process creation. The log
 * clock starts a little after process creation (`logOriginAfterCreationMs`). A session is
 * identified only by the log's opaque scope handle. These are commit times of the normalized
 * evidence, not served-readiness times: the summary domain can also wait for its repository
 * section, which this log does not show.
 */
async function startupFromLogs(createdMs, windowMs) {
  const window = await readPipelineWindow(createdMs, createdMs + windowMs);
  const counter = [...window.counters.values()].flat().find((item) => Number.isFinite(item.startMs));
  if (!counter) return { error: "no pipeline log records in the window" };
  const origin = counter.at - counter.startMs;
  const since = (value) => r1(value - createdMs);
  const accepted = window.spans.filter((span) => span.stage === "candidate_to_commit" && span.outcome === "accepted").sort((a, b) => a.endAt - b.endAt);
  const live = window.spans.filter((span) => span.stage === "acquisition_normalization" && span.lane === "urgent")
    .map((span) => {
      const commit = accepted.find((item) => item.scope === span.scope && item.endAt >= span.endAt);
      const earlier = accepted.find((item) => item.scope === span.scope && item.endAt < span.endAt);
      return {
        provider: span.provider, acquisitionMs: r1(span.durationMs), acquisitionEndedMs: since(span.endAt), acquisitionOutcome: span.outcome,
        evidenceCommittedMs: commit ? since(commit.endAt) : null, restoredCommitBeforeMs: earlier ? since(earlier.endAt) : null,
      };
    });
  const acquisitions = {};
  for (const span of window.spans) if (span.stage === "acquisition_normalization") { const key = `${span.provider}:${span.lane}`; acquisitions[key] = (acquisitions[key] || 0) + 1; }
  return {
    logOriginAfterCreationMs: since(origin), firstSessionCommitMs: accepted[0] ? since(accepted[0].endAt) : null,
    sessionsLiveAtStart: live, acquisitionsByProviderAndLane: acquisitions, records: window.records,
    note: "urgent-lane acquisitions are the first reads of sessions that were live at start; restoredCommitBeforeMs is a checkpoint-restored evidence commit of the same session",
  };
}

// ---------------------------------------------------------------- conditions

async function collectConditions() {
  const [facts, first, shell, directory] = await Promise.all([
    checkoutFacts(), cim(), catalogShell(), directoryPage("", 1),
  ]);
  await sleep(3000);
  const second = await cim();
  const index = buildTranscriptIndex();
  let claudeFiles = 0, claudeBytes = 0, codexFiles = 0, codexBytes = 0, subagentFileCount = 0;
  for (const entry of index.values()) {
    const size = safeSize(entry.main);
    if (entry.provider === "claude") { claudeFiles += 1; claudeBytes += size || 0; subagentFileCount += subagentFiles(entry).length; } else { codexFiles += 1; codexBytes += size || 0; }
  }
  const before = new Map(first.processes.map((process_) => [process_.pid, process_]));
  const busy = [];
  for (const process_ of second.processes) {
    const earlier = before.get(process_.pid);
    if (!earlier || earlier.created !== process_.created) continue;
    const share = (process_.cpu100ns - earlier.cpu100ns) / ((second.sampledAt - first.sampledAt) * 1e4);
    const role = roleOf(process_);
    if (share >= 0.1 && !["system idle process", "system"].includes(role)) busy.push({ role, cpuPercentOfOneCore: r1(share * 100) });
  }
  busy.sort((a, b) => b.cpuPercentOfOneCore - a.cpuPercentOfOneCore);
  const monitors = second.processes.filter((process_) => roleOf(process_) === "pomegr monitor");
  const live = (shell?.sessions || []).filter((row) => row.isLive);
  const logDir = path.join(cfg.checkout, "outputs", "pipeline-logs");
  return {
    takenAt: new Date().toISOString(), label: cfg.label, node: process.version, logicalProcessors: os.cpus().length, totalMemoryGb: r1(os.totalmem() / 2 ** 30),
    mainCheckout: facts,
    monitor: monitors.map((process_) => ({ ...publicProcess(process_), uptimeSeconds: r1((second.sampledAt - process_.created) / 1000) })),
    busyProcessesOverThreeSeconds: busy.slice(0, 10),
    busyProcessCountByRole: Object.fromEntries([...busy.reduce((map, item) => map.set(item.role, (map.get(item.role) || 0) + 1), new Map())]),
    catalog: {
      shellRows: shell?.sessions?.length ?? null, liveRows: live.length, liveByProvider: Object.fromEntries([...live.reduce((map, row) => map.set(row.provider, (map.get(row.provider) || 0) + 1), new Map())]),
      directoryCounts: directory?.counts ?? null, coverage: directory?.coverage ? { status: directory.coverage.status, knownCount: directory.coverage.knownCount, exactTotal: directory.coverage.exactTotal } : null,
    },
    transcripts: { claudeTopLevelFiles: claudeFiles, claudeSubagentFiles: subagentFileCount, claudeTopLevelBytes: claudeBytes, codexFiles, codexBytes, note: "sizes by fs.stat only" },
    pipelineLogFiles: safeReaddir(logDir).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).length,
  };
}

// ---------------------------------------------------------------- B1 + B4: startup

async function measureStartup() {
  const waitMs = num("wait-s", 180) * 1000;
  const windowMs = num("startup-s", 300) * 1000;
  const scriptStart = nowMs();
  const before = await findMonitors();
  const knownPids = new Set(before.monitors.map((process_) => process_.pid));
  const shell = await catalogShell();
  const index = buildTranscriptIndex();
  // The chosen live session ("live session A") is the live Claude row whose transcripts were written most recently.
  const chosenId = liveRowsByRecentWrite(shell, index).find((row) => row.provider === "claude")?.id || null;
  if (!chosenId) log("no live Claude session found before the restart: the live-session milestone will be null");
  const attach = options.attach === true;
  const attachMaxAgeMs = num("attach-max-age-s", 120) * 1000;

  const samples = [];
  let stopPolling = false;
  let t0 = null;
  const catalogRevisionRef = { value: null };
  async function pollLoop() {
    let domainReady = false;
    let domainReadyAt = null;
    while (!stopPolling) {
      const tick = nowMs();
      const slow = domainReadyAt !== null && tick - domainReadyAt > 2000;
      const [dir, cat, dom] = await Promise.all([
        get(cfg.monitor, "/api/sessions?mode=directory&filter=all&pageSize=1", { timeoutMs: 8000 }),
        get(cfg.monitor, `/api/sessions${catalogRevisionRef.value === null ? "" : `?revision=${catalogRevisionRef.value}`}`, { timeoutMs: 8000 }),
        chosenId && !slow ? get(cfg.monitor, domainPath(chosenId), { timeoutMs: 8000 }) : Promise.resolve(null),
      ]);
      const sample = { t: dir.end, anyOk: dir.ok || cat.ok || Boolean(dom?.ok) };
      const directory = json(dir);
      if (directory) sample.dir = { matched: directory.matchedCount, all: directory.counts?.all, live: directory.counts?.live, cov: directory.coverage?.status, known: directory.coverage?.knownCount, exact: directory.coverage?.exactTotal, ready: directory.readiness?.catalog };
      // A failed request means the previous monitor is gone; its revision numbers mean nothing to the next one.
      if (!cat.ok) catalogRevisionRef.value = null;
      if (cat.ok && cat.status === 200) {
        const body = json(cat);
        if (body) {
          catalogRevisionRef.value = body.revision ?? header(cat, "x-pomegr-revision");
          sample.cat = { rows: body.sessions?.length ?? 0, readyRows: (body.sessions || []).filter((row) => row.summaryReadiness === "ready").length, ready: body.readiness?.catalog, cov: body.coverage?.status };
        }
      }
      if (dom?.ok) {
        const body = json(dom);
        sample.dom = { status: dom.status, readiness: body?.readiness ?? null, core: body?.sectionReadiness?.core ?? null };
        // Only an answer from the new monitor ends the polling; the old one may already have answered ready.
        if (body?.readiness === "ready" && !domainReady && t0 !== null && dom.end >= t0) { domainReady = true; domainReadyAt = dom.end; }
      }
      samples.push(sample);
      await sleepUntil(tick + cfg.pollMs);
    }
  }
  const poller = pollLoop();

  // Detect the new monitor process, then take its creation time as t0.
  log(attach ? `attach mode: using the running monitor if it started less than ${attachMaxAgeMs / 1000} s ago` : "waiting for a new monitor process; restart the dev app now (once)");
  let monitor = null;
  const deadline = scriptStart + waitMs;
  while (nowMs() < deadline && !monitor) {
    const found = await findMonitors();
    monitor = found.monitors.find((process_) => attach ? found.sampledAt - process_.created < attachMaxAgeMs : !knownPids.has(process_.pid) && process_.created >= scriptStart - 5000) || null;
    if (!monitor) await sleep(250);
  }
  if (!monitor) { stopPolling = true; await poller; return { error: "no new monitor process detected within the wait window", waitedSeconds: r1((nowMs() - scriptStart) / 1000) }; }
  t0 = monitor.created;
  const detectedAt = nowMs();
  log(`new monitor detected, ${r1((detectedAt - t0) / 1000)} s after its creation; recording ${windowMs / 1000} s from creation`);

  // CPU and RSS at fixed offsets from creation.
  const processSamples = [];
  const offsets = [0, 60_000, 180_000, 300_000].filter((offset) => offset <= windowMs);
  for (const offset of offsets) {
    if (nowMs() < t0 + offset) await sleepUntil(t0 + offset);
    const sample = await sampleProcess(monitor.pid);
    if (sample.ok) processSamples.push({ targetOffsetS: offset / 1000, actualOffsetS: r1((sample.sampledAt - t0) / 1000), cpuSeconds: r1(sample.cpu100ns / 1e7), rssMb: r1(sample.workingSet / 1048576) });
  }
  if (nowMs() < t0 + windowMs) await sleepUntil(t0 + windowMs);
  stopPolling = true;
  await poller;
  const wallClockStartedMs = t0;

  // Milestones: samples taken at or after t0 are from the new monitor (the old one is stopped before it starts).
  const after = samples.filter((sample) => sample.t >= wallClockStartedMs);
  const first = (predicate) => { const hit = after.find(predicate); return hit ? r1(hit.t - wallClockStartedMs) : null; };
  const firstSampleOffset = after.length ? r1(after[0].t - wallClockStartedMs) : null;
  const finalDirectory = [...after].reverse().find((sample) => sample.dir)?.dir || null;
  const rowsAt = Object.fromEntries([1000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000].map((offset) => {
    const hit = [...after].reverse().find((sample) => sample.dir && sample.t - wallClockStartedMs <= offset);
    return [`${offset / 1000}s`, hit ? { rows: hit.dir.matched, coverage: hit.dir.cov, known: hit.dir.known } : null];
  }));
  const coverageTimeline = [];
  for (const sample of after) {
    if (!sample.dir) continue;
    const last = coverageTimeline[coverageTimeline.length - 1];
    if (!last || last.status !== sample.dir.cov) coverageTimeline.push({ atS: r1((sample.t - wallClockStartedMs) / 1000), status: sample.dir.cov });
  }
  const b1 = {
    monitorCreatedAt: new Date(t0).toISOString(), detectedAfterCreationS: r1((detectedAt - t0) / 1000), lateAttach: attach, firstSampleAfterCreationMs: firstSampleOffset,
    firstAnyResponseMs: first((sample) => sample.anyOk),
    firstCatalogShellRowMs: first((sample) => sample.cat?.rows > 0),
    firstReadyCatalogRowMs: first((sample) => sample.cat?.readyRows > 0),
    catalogReadinessReadyMs: first((sample) => sample.cat?.ready === "ready"),
    coverageCompleteMs: first((sample) => sample.dir?.cov === "complete"),
    liveSessionASummaryReadyMs: chosenId ? first((sample) => sample.dom?.readiness === "ready") : null,
    liveSessionACoreReadyMs: chosenId ? first((sample) => sample.dom?.core === "ready") : null,
    liveSessionAFirstResponseMs: chosenId ? first((sample) => Boolean(sample.dom)) : null,
    processAtOffsets: processSamples,
    note: "elapsed milliseconds from monitor process creation; null means the milestone was not reached in the window",
  };
  const b4 = {
    firstDirectoryRowMs: first((sample) => sample.dir?.matched > 0),
    rowsAtOffsets: rowsAt, finalDirectory, coverageTimeline,
    note: "directory rows come from the persisted header inventory; coverage complete needs a finished header scan of every provider",
  };
  b1.fromPipelineLog = await startupFromLogs(t0, windowMs);
  return { b1, b4, polls: after.length };
}

// ---------------------------------------------------------------- B2 + B5: opening sessions

/** First request for a session, then polling until it answers ready, absent, or unavailable. Timed from the first request. */
async function openSession(sessionId) {
  return openSessionFrom(sessionId, await get(cfg.monitor, domainPath(sessionId), { timeoutMs: 20_000 }));
}
async function repeatedRequests(base, sessionId, { count = 100, spacingMs = 20, headers = {} } = {}) {
  const times = [];
  for (let index = 0; index < count; index += 1) {
    const response = await get(base, domainPath(sessionId), { headers, keepBody: false });
    if (response.ok && response.status === 200) times.push(response.end - response.start);
    await sleep(spacingMs);
  }
  return summarize(times);
}

async function measureLiveOpen() {
  const live = liveRowsByRecentWrite(await catalogShell(), buildTranscriptIndex()).slice(0, num("b2-max", 3));
  const results = [];
  for (const [position, row] of live.entries()) {
    const opened = await openSession(row.id);
    const direct = opened.outcome === "ready" ? await repeatedRequests(cfg.monitor, row.id) : null;
    let proxy = null;
    if (opened.outcome === "ready") {
      const headers = { "accept-encoding": "gzip, deflate, br" };
      const warm = [];
      for (let index = 0; index < 3; index += 1) { const response = await get(cfg.web, domainPath(row.id), { headers, keepBody: false }); warm.push(r1(response.end - response.start)); }
      proxy = { warmupMs: warm, ...(await repeatedRequests(cfg.web, row.id, { headers })) };
    }
    results.push({ session: `live session ${String.fromCharCode(65 + position)}`, provider: row.provider, ...opened, repeatedMonitorMs: direct, repeatedProxyMs: proxy });
  }
  return { sessions: results, note: "first request, then polled every 2 x --poll-ms (100 ms by default) until ready; repeated = 100 sequential full-body GETs 20 ms apart" };
}

function parseSize(text) {
  const match = /^(\d+(?:\.\d+)?)([kmg]?)$/iu.exec(String(text).trim());
  if (!match) return null;
  return Number(match[1]) * ({ "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()]);
}

async function measureHistoricalOpen() {
  const targets = String(options["b5-sizes"] || "100k,1m,10m").split(",").map(parseSize);
  const labels = ["small", "medium", "large"];
  const skip = Math.max(0, Math.trunc(num("b5-skip", 0)));
  const index = buildTranscriptIndex();
  const rows = await directoryRows();
  const settledAge = Date.now() - 30 * 60_000;
  const candidates = [];
  for (const row of rows) {
    if (row.isLive || row.needsInput || ["working", "needs_input", "open"].includes(row.activityStatus)) continue;
    if (!(Date.parse(row.updatedAt) < settledAge)) continue;
    const entry = index.get(row.id);
    const size = entry ? safeSize(entry.main) : null;
    if (!size) continue;
    candidates.push({ id: row.id, provider: row.provider, size, entry });
  }
  const results = [];
  for (const provider of ["codex", "claude"]) {
    const pool = candidates.filter((candidate) => candidate.provider === provider);
    for (const [slot, target] of targets.entries()) {
      if (!target) continue;
      const ranked = pool.slice().sort((a, b) => Math.abs(Math.log(a.size / target)) - Math.abs(Math.log(b.size / target)));
      let measured = null;
      const skippedWarm = [];
      for (const candidate of ranked.slice(skip, skip + 6)) {
        const probe = await get(cfg.monitor, domainPath(candidate.id), { timeoutMs: 20_000 });
        const probeBody = json(probe);
        if (probeBody?.readiness === "ready") { skippedWarm.push(r1(candidate.size / 1024)); continue; }
        // The probe above was the first request; time from it, not from a second one.
        const opened = await openSessionFrom(candidate.id, probe);
        const subagents = subagentFiles(candidate.entry);
        measured = { size: labels[slot], provider, transcriptKb: r1(candidate.size / 1024), subagentFiles: subagents.length, subagentKb: r1(subagents.reduce((sum, file) => sum + (safeSize(file) || 0), 0) / 1024), ...opened };
        break;
      }
      results.push(measured || { size: labels[slot], provider, outcome: "no cold candidate", skippedWarmKb: skippedWarm });
      if (measured && skippedWarm.length) measured.skippedAlreadyCommittedKb = skippedWarm;
      await sleep(3000);
    }
  }
  return { skip, targetsBytes: targets, historicalCandidates: candidates.length, sessions: results, note: "each measurement starts at the first request of a session that answered loading; sessions already committed are skipped" };
}
/**
 * Continue polling after a first request that already answered, timing from that request.
 * `outcome` is the domain's top-level readiness. `coreReadyMs` is the first answer whose
 * `sectionReadiness.core` was ready; it can come earlier because the summary's top-level
 * readiness also waits for its repository section.
 */
async function openSessionFrom(sessionId, firstResponse) {
  const started = firstResponse.start;
  let polls = 0;
  let outcome = null;
  let firstStatus = null;
  let coreReadyMs = null;
  let sections = null;
  let end = firstResponse.end;
  let response = firstResponse;
  for (;;) {
    polls += 1;
    const body = json(response);
    outcome = !response.ok ? `error:${response.error}` : response.status === 404 ? "absent" : body?.readiness || `http:${response.status}`;
    firstStatus ??= outcome;
    end = response.end;
    if (body?.sectionReadiness) {
      sections = body.sectionReadiness;
      if (coreReadyMs === null && sections.core === "ready") coreReadyMs = r1(end - started);
    }
    if (["ready", "absent", "unavailable"].includes(outcome) || nowMs() - started >= num("open-timeout-s", 60) * 1000) break;
    await sleep(cfg.pollMs * 2);
    response = await get(cfg.monitor, domainPath(sessionId), { timeoutMs: 30_000 });
  }
  return {
    outcome, timeToReadyMs: outcome === "ready" ? r1(end - started) : null, coreReadyMs, sectionsAtEnd: sections,
    firstResponse: { status: firstStatus, afterMs: r1(firstResponse.end - started) }, polls,
  };
}

// ---------------------------------------------------------------- B3: live latency

function openEventStream(onEvent) {
  let request = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    const url = new URL("/api/events", cfg.monitor);
    request = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { accept: "text/event-stream" } }, (response) => {
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        const at = nowMs();
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const name = /^event: (.+)$/mu.exec(block)?.[1];
          const data = /^data: (.+)$/mu.exec(block)?.[1];
          if (!name || !data) continue;
          try { onEvent({ at, name, data: JSON.parse(data) }); } catch { /* ignore a malformed block */ }
        }
      });
      response.on("end", () => { if (!closed) setTimeout(connect, 500); });
      response.on("error", () => {});
    });
    request.on("error", () => { if (!closed) setTimeout(connect, 500); });
    request.end();
  };
  connect();
  return { close() { closed = true; try { request?.destroy(); } catch { /* already closed */ } } };
}

async function collectLive() {
  const durationMs = num("b3-s", 200) * 1000;
  const statMs = num("b3-stat-ms", 50);
  const getMs = num("b3-get-ms", 50);
  const maxLive = num("b3-max-live", 4);
  const index = buildTranscriptIndex();
  const shell = await catalogShell();
  const watched = [];
  for (const row of (shell?.sessions || []).filter((entry) => entry.isLive && entry.provider === "claude")) {
    const entry = index.get(row.id);
    if (entry && watched.length < maxLive) watched.push({ id: row.id, entry, files: new Map(), writes: [], summary: [], sse: [], summaryRev: null });
  }
  if (!watched.length) return { error: "no live Claude session with a locatable transcript" };
  const t0 = nowMs();
  const startWall = Date.now();
  let stop = false;
  const rel = (value) => r1(value - t0);

  const refreshFiles = (session) => {
    const wanted = [{ file: session.entry.main, kind: "main" }, ...subagentFiles(session.entry).map((file) => ({ file, kind: "subagent" }))];
    for (const { file, kind } of wanted) {
      if (!session.files.has(file)) session.files.set(file, { kind, size: null, late: nowMs() - t0 > 1000 });
    }
  };
  const pollFiles = (session) => {
    let bytes = 0;
    let mtime = 0;
    const kinds = new Set();
    for (const [file, info] of session.files) {
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (info.size === null) {
        info.size = stat.size;
        if (info.late && stat.size > 0) { bytes += stat.size; mtime = Math.max(mtime, stat.mtimeMs); kinds.add("new file"); }
        continue;
      }
      if (stat.size > info.size) { bytes += stat.size - info.size; mtime = Math.max(mtime, stat.mtimeMs); kinds.add(info.kind); }
      info.size = stat.size;
    }
    if (bytes > 0) session.writes.push({ at: rel(nowMs()), mtime: rel(mtime), bytes, kinds: [...kinds] });
  };
  for (const session of watched) { refreshFiles(session); pollFiles(session); session.writes.length = 0; }

  // The event stream replays every retained revision on connect, so the first 2 s are ignored.
  const byId = new Map(watched.map((session) => [session.id, session]));
  const events = openEventStream(({ at, name, data }) => {
    if (at - t0 < 2000) return;
    const session = byId.get(data?.sessionId);
    if (session && name === "session-summary") session.sse.push({ at: rel(at), rev: data.revision });
  });

  const tasks = [];
  tasks.push((async () => {
    let lastRefresh = 0;
    while (!stop) {
      const tick = nowMs();
      if (tick - lastRefresh > 250) { for (const session of watched) refreshFiles(session); lastRefresh = tick; }
      for (const session of watched) pollFiles(session);
      await sleepUntil(tick + statMs);
    }
  })());
  // The conditional request answers 204 until this session's summary revision changes, then 200 with the new body.
  for (const session of watched) {
    tasks.push((async () => {
      while (!stop) {
        const tick = nowMs();
        const response = await get(cfg.monitor, domainPath(session.id, "session-summary", session.summaryRev), { timeoutMs: 10_000 });
        if (response.ok && response.status === 200) {
          const revision = Number(header(response, "x-pomegr-revision"));
          const body = json(response);
          const baseline = session.summaryRev === null;
          if (Number.isFinite(revision)) session.summaryRev = revision;
          session.summary.push({ at: rel(response.end), sent: rel(response.start), rev: revision, baseline, updatedAt: body?.session?.updatedAt ? rel(Date.parse(body.session.updatedAt)) : null });
        }
        await sleepUntil(tick + getMs);
      }
    })());
  }
  log(`watching ${watched.length} live Claude session(s) for ${durationMs / 1000} s`);
  await sleep(durationMs);
  stop = true;
  events.close();
  await Promise.allSettled(tasks);

  return {
    meta: {
      durationS: r1((nowMs() - t0) / 1000), statMs, getMs, startedAtMs: Math.round(startWall), startedAt: new Date(startWall).toISOString(),
      clock: "all times are ms since the watch started, on the machine clock; mtime is the file modification time and updatedAt the served session.updatedAt, both on that clock",
    },
    sessions: watched.map((session) => ({
      provider: "claude", subagentFilesAtEnd: [...session.files.values()].filter((info) => info.kind === "subagent").length,
      writes: session.writes, summary: session.summary, sse: session.sse,
    })),
  };
}

/**
 * Pair file growth with the served revision that reflects it.
 *
 * Why not pair with "the next revision": a revision counter advances for many reasons that have
 * nothing to do with the transcript (resource samples, history revisions, catalog-driven summary
 * recomputation), and several writes can share one published revision. The served
 * `session.updatedAt` is the timestamp of the newest transcript record the revision reflects, so
 * it identifies which write a revision contains.
 *
 * A write is one stat poll that saw a watched file of the session grow. Its time is the file
 * modification time (within the clock granularity of about 16 ms), not the poll time, which is
 * up to one poll interval later. A write is reflected by the first summary revision published
 * after it whose `updatedAt` is at least `toleranceMs` before the write time: a record carries
 * its own timestamp from slightly before the file write (the trial showed about 113 ms).
 * Publication time is the arrival of the revision's `session-summary` event on the monitor's
 * event stream (the moment the browser is told); the first successful conditional GET that
 * returned the new body is used if the event was missed, and `readableAfterPublishMs` reports
 * how much later a GET could read it.
 *
 * Writes with no such revision within `windowMs` did not change what is served (for example
 * records that carry no timestamp) and are counted, not paired. Several writes can map to one
 * revision; `oldestWritePerRevision` keeps the longest wait of each such burst.
 */
function analyzeLive(raw, { toleranceMs = 400, windowMs = 15_000 } = {}) {
  const perSession = raw.sessions.map((session) => {
    const published = new Map();
    for (const event of session.sse) if (!published.has(event.rev)) published.set(event.rev, event.at);
    const changes = session.summary.filter((item) => !item.baseline).map((item) => ({ ...item, published: published.get(item.rev) ?? item.at }));
    const pairs = [];
    let unpaired = 0;
    for (const write of session.writes) {
      const change = changes.find((item) => item.published > write.mtime && item.updatedAt !== null && item.updatedAt >= write.mtime - toleranceMs);
      if (!change || change.published - write.mtime > windowMs) { unpaired += 1; continue; }
      pairs.push({ write, change, latency: change.published - write.mtime, lead: write.mtime - change.updatedAt });
    }
    const bursts = new Map();
    for (const pair of pairs) if (!bursts.has(pair.change.rev) || pair.write.mtime < bursts.get(pair.change.rev).write.mtime) bursts.set(pair.change.rev, pair);
    const isNew = (pair) => pair.write.kinds.includes("new file");
    const followUps = [];
    for (const pair of bursts.values()) {
      const next = changes.find((item) => item.rev > pair.change.rev && item.updatedAt === pair.change.updatedAt);
      if (next && next.published - pair.change.published < 1000) followUps.push(next.published - pair.change.published);
    }
    const lag = changes.map((item) => (published.has(item.rev) ? item.at - published.get(item.rev) : null)).filter((value) => value !== null);
    return {
      writes: session.writes.length, unpairedWrites: unpaired, revisionsObserved: changes.length,
      writeToServed: summarize(pairs.filter((pair) => !isNew(pair)).map((pair) => pair.latency)),
      oldestWritePerRevision: summarize([...bursts.values()].filter((pair) => !isNew(pair)).map((pair) => pair.latency)),
      newFileWritesPaired: pairs.filter(isNew).length,
      recordLeadsFileWriteMs: summarize(pairs.map((pair) => pair.lead)),
      catalogFollowUpAfterEvidenceMs: summarize(followUps),
      readableAfterPublishMs: summarize(lag),
      writesByKind: Object.fromEntries(session.writes.reduce((map, write) => map.set(write.kinds.join("+"), (map.get(write.kinds.join("+")) || 0) + 1), new Map())),
      _pairs: pairs,
    };
  });
  const named = perSession.map((entry, position) => ({ entry, position })).sort((a, b) => b.entry.writes - a.entry.writes)
    .map(({ entry }, rank) => ({ session: `live session ${String.fromCharCode(65 + rank)}`, ...entry }));
  const kept = (entry) => entry._pairs.filter((pair) => !pair.write.kinds.includes("new file"));
  const pooledBursts = named.flatMap((entry) => {
    const seen = new Map();
    for (const pair of kept(entry)) if (!seen.has(pair.change.rev) || pair.write.mtime < seen.get(pair.change.rev).write.mtime) seen.set(pair.change.rev, pair);
    return [...seen.values()];
  });
  return {
    pooled: {
      writes: named.reduce((sum, entry) => sum + entry.writes, 0), unpairedWrites: named.reduce((sum, entry) => sum + entry.unpairedWrites, 0),
      writeToServed: summarize(named.flatMap((entry) => kept(entry).map((pair) => pair.latency))),
      oldestWritePerRevision: summarize(pooledBursts.map((pair) => pair.latency)),
    },
    sessions: named.map((entry) => { const rest = { ...entry }; delete rest._pairs; return rest; }),
    method: "write time = file mtime; served time = first session-summary event for the first revision whose updatedAt is within tolerance of the write; see the comment above analyzeLive",
  };
}

// ---------------------------------------------------------------- B6: background cost

async function measureBackground() {
  const windowMs = num("b6-s", 300) * 1000;
  const minUptimeMs = num("b6-min-uptime-s", 600) * 1000;
  let found = await findMonitors();
  let monitor = found.monitors[0];
  if (!monitor) return { error: "no monitor process found" };
  while (found.sampledAt - monitor.created < minUptimeMs) {
    if (options["no-wait"]) return { error: "monitor uptime below the minimum", uptimeS: r1((found.sampledAt - monitor.created) / 1000) };
    log(`monitor uptime ${r1((found.sampledAt - monitor.created) / 1000)} s; waiting for ${minUptimeMs / 1000} s`);
    await sleep(Math.min(30_000, monitor.created + minUptimeMs - nowMs() + 500));
    found = await findMonitors();
    monitor = found.monitors[0];
    if (!monitor) return { error: "monitor process disappeared while waiting" };
  }
  const pid = monitor.pid;
  const created = monitor.created;
  const startSample = await sampleProcess(pid);
  if (!startSample.ok || startSample.created !== created) return { error: "monitor process changed" };
  log(`background window ${windowMs / 1000} s starts at uptime ${r1((startSample.sampledAt - created) / 1000)} s; no requests are sent`);
  const middle = await (async () => { await sleepUntil(startSample.sampledAt + windowMs / 2); return sampleProcess(pid); })();
  await sleepUntil(startSample.sampledAt + windowMs);
  const endSample = await sampleProcess(pid);
  if (!endSample.ok || endSample.created !== created) return { error: "monitor process changed during the window" };
  const wallMs = endSample.sampledAt - startSample.sampledAt;
  const logs = await readPipelineWindow(startSample.sampledAt, endSample.sampledAt);
  const stage = (name) => stageStats(logs, name, () => true, wallMs);
  const values = (name) => (logs.counters.get(name) || []).map((item) => item.value);
  const cpuCounter = values("cpu");
  return {
    window: { startUptimeS: r1((startSample.sampledAt - created) / 1000), lengthS: r1(wallMs / 1000), requestsSent: 0 },
    cpuShareOfOneCore: { fromProcessCounters: r1(((endSample.cpu100ns - startSample.cpu100ns) / (wallMs * 1e4)) * 100), fromLogCpuCounter: cpuCounter.length ? r1((cpuCounter.reduce((sum, value) => sum + value, 0) / (wallMs * 1000)) * 100) : null, unit: "percent of one core" },
    rssMb: { start: r1(startSample.workingSet / 1048576), middle: middle.ok ? r1(middle.workingSet / 1048576) : null, end: r1(endSample.workingSet / 1048576), logCounterMedian: r1(summarize(values("memory")).median / 1048576), logCounterMax: r1(summarize(values("memory")).max / 1048576) },
    eventLoopMs: summarize(values("event_loop_ms")),
    stagesMs: { catalog_projection: stage("catalog_projection"), revision_notify: stage("revision_notify"), history_contribution: stage("history_contribution"), candidate_to_commit: stage("candidate_to_commit"), checkpoint: stage("checkpoint") },
    logs: { files: logs.files, records: logs.records, runs: logs.runs, note: "event_loop_ms is the maximum loop delay in each 250 ms sample; stage durations are span records stamped inside the window" },
  };
}

// ---------------------------------------------------------------- output

const fmt = (value, unit = "") => (value === null || value === undefined ? "n/a" : `${value}${unit}`);
const triple = (stats) => `${fmt(stats?.median)} / ${fmt(stats?.p95)} / ${fmt(stats?.max)}`;
function markdown(result) {
  const lines = [`## Monitor measurements: ${result.label} (${result.takenAt})`, "", "| ID | Measurement | Value | Unit |", "| --- | --- | --- | --- |"];
  const { b1, b2, b3, b4, b5, b6 } = result;
  if (b1?.error) lines.push(`| B1 | startup | ${b1.error} | |`);
  if (b1 && !b1.error && b1.firstAnyResponseMs !== undefined) {
    lines.push(`| B1 | first response after process creation | ${fmt(b1.firstAnyResponseMs)} | ms |`);
    lines.push(`| B1 | first session-list row with a ready summary | ${fmt(b1.firstReadyCatalogRowMs)} | ms |`);
    lines.push(`| B1 | catalog coverage complete | ${fmt(b1.coverageCompleteMs)} | ms |`);
    lines.push(`| B1 | live session A summary ready (core section ready) | ${fmt(b1.liveSessionASummaryReadyMs)} (${fmt(b1.liveSessionACoreReadyMs)}) | ms |`);
    for (const live of b1.fromPipelineLog?.sessionsLiveAtStart || []) lines.push(`| B1 | live-at-start ${live.provider} session, first read ended / evidence committed (from log) | ${fmt(live.acquisitionEndedMs)} / ${fmt(live.evidenceCommittedMs)} | ms |`);
    for (const sample of b1.processAtOffsets || []) lines.push(`| B1 | CPU seconds / RSS at ${sample.targetOffsetS} s | ${sample.cpuSeconds} / ${sample.rssMb} | s / MB |`);
  }
  if (b4 && !b4.error) {
    lines.push(`| B4 | first directory row | ${fmt(b4.firstDirectoryRowMs)} | ms |`);
    lines.push(`| B4 | rows served at end of window / coverage | ${fmt(b4.finalDirectory?.matched)} / ${fmt(b4.finalDirectory?.cov)} | rows |`);
  }
  if (b2?.error) lines.push(`| B2 | open a live session | ${b2.error} | |`);
  for (const session of b2?.sessions || []) {
    lines.push(`| B2 | ${session.session}: first request to ready (first answer ${session.firstResponse?.status}) | ${fmt(session.timeToReadyMs)} | ms |`);
    lines.push(`| B2 | ${session.session}: repeated request, monitor, median / p95 | ${fmt(session.repeatedMonitorMs?.median)} / ${fmt(session.repeatedMonitorMs?.p95)} | ms |`);
    lines.push(`| B2 | ${session.session}: repeated request, web proxy, median / p95 | ${fmt(session.repeatedProxyMs?.median)} / ${fmt(session.repeatedProxyMs?.p95)} | ms |`);
  }
  if (b3?.error) lines.push(`| B3 | live latency | ${b3.error} | |`);
  if (b3?.analysis) {
    const pooled = b3.analysis.pooled;
    lines.push(`| B3 | write to served revision, every paired write, median / p95 / max (n=${pooled.writeToServed.n}) | ${triple(pooled.writeToServed)} | ms |`);
    lines.push(`| B3 | oldest write behind each revision, median / p95 / max (n=${pooled.oldestWritePerRevision.n}) | ${triple(pooled.oldestWritePerRevision)} | ms |`);
    lines.push(`| B3 | writes seen / writes with no served change | ${pooled.writes} / ${pooled.unpairedWrites} | writes |`);
  }
  if (b5?.error) lines.push(`| B5 | open a historical session | ${b5.error} | |`);
  for (const session of b5?.sessions || []) lines.push(`| B5 | ${session.provider} historical ${session.size} (${fmt(session.transcriptKb)} KB): first request to ready (core section ready) | ${session.timeToReadyMs ?? `${session.outcome} at timeout`} (${fmt(session.coreReadyMs)}) | ms |`);
  if (b6?.error) lines.push(`| B6 | background cost | ${b6.error} | |`);
  if (b6 && !b6.error) {
    lines.push(`| B6 | CPU share of one core (process counters / log counter) | ${fmt(b6.cpuShareOfOneCore.fromProcessCounters)} / ${fmt(b6.cpuShareOfOneCore.fromLogCpuCounter)} | % |`);
    lines.push(`| B6 | RSS start / end | ${fmt(b6.rssMb.start)} / ${fmt(b6.rssMb.end)} | MB |`);
    lines.push(`| B6 | event loop delay median / max | ${fmt(b6.eventLoopMs.median)} / ${fmt(b6.eventLoopMs.max)} | ms |`);
    for (const [name, stats] of Object.entries(b6.stagesMs)) lines.push(`| B6 | ${name} median / p95 (n=${stats.n}, ${fmt(stats.perMinute)} per minute) | ${fmt(stats.median)} / ${fmt(stats.p95)} | ms |`);
  }
  return lines.join("\n");
}

/** Pipeline-log stage durations inside the B3 watch window, to show where the wait goes. */
async function liveStages(raw) {
  const from = raw.meta.startedAtMs;
  const window = await readPipelineWindow(from, from + raw.meta.durationS * 1000);
  const claudeUpdate = (span) => span.provider === "claude" && span.lane === "source_update";
  return {
    files: window.files, records: window.records,
    source_queue_claude_source_update: stageStats(window, "source_queue", (span) => span.domain === "acquisition" && claudeUpdate(span)),
    acquisition_normalization_claude_source_update: stageStats(window, "acquisition_normalization", claudeUpdate),
    candidate_to_commit: stageStats(window, "candidate_to_commit"),
    candidate_to_commit_accepted: stageStats(window, "candidate_to_commit", (span) => span.outcome === "accepted"),
    candidate_to_commit_superseded: stageStats(window, "candidate_to_commit", (span) => span.outcome === "superseded"),
    session_derivation: stageStats(window, "session_derivation"),
    catalog_projection: stageStats(window, "catalog_projection"),
    note: "all sessions together, not only the watched ones; spans are stamped at their end",
  };
}

function emit(result) {
  const printable = result.b3?.raw ? { ...result, b3: { ...result.b3, raw: "omitted from stdout; stored by --out" } } : result;
  if (options.out && options.out !== true) fs.writeFileSync(String(options.out), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(printable, null, 2)}\n\n${markdown(result)}\n`);
}

async function main() {
  if (command === "help" || options.help) { process.stdout.write("See the comment header of this file.\n"); return; }
  const result = { label: cfg.label, takenAt: new Date().toISOString() };
  if (command === "conditions") {
    result.conditions = await collectConditions();
  } else if (command === "startup") {
    result.conditionsBefore = { mainCheckout: await checkoutFacts() };
    const outcome = await measureStartup();
    if (outcome.error) { result.b1 = outcome; result.b4 = outcome; } else { result.b1 = outcome.b1; result.b4 = outcome.b4; result.pollsAfterCreation = outcome.polls; }
    result.conditionsAfter = { mainCheckout: await checkoutFacts() };
  } else if (command === "startup-logs") {
    // Re-derive the log-based startup milestones for a start that has already happened.
    const created = Date.parse(String(options.created));
    if (!Number.isFinite(created)) {
      process.stderr.write("startup-logs needs --created <ISO time of monitor process creation>\n");
      process.exitCode = 2;
      return;
    }
    result.b1 = { monitorCreatedAt: new Date(created).toISOString(), fromPipelineLog: await startupFromLogs(created, num("startup-s", 300) * 1000) };
  } else if (command === "steady") {
    const steps = String(options.only || "b2,b6,b5,b3").split(",").map((part) => part.trim().toLowerCase());
    result.conditions = await collectConditions();
    for (const step of steps) {
      log(`running ${step}`);
      try {
        if (step === "b2") result.b2 = await measureLiveOpen();
        else if (step === "b5") result.b5 = await measureHistoricalOpen();
        else if (step === "b6") result.b6 = await measureBackground();
        else if (step === "b3") {
          const raw = await collectLive();
          result.b3 = raw.error ? raw : { raw, analysis: analyzeLive(raw), stages: await liveStages(raw) };
        } else log(`unknown step ${step}`);
      } catch (error) { result[step] = { error: String(error?.code || error?.name || "failed") }; }
    }
    result.conditionsAfter = { mainCheckout: await checkoutFacts() };
  } else if (command === "b3-analyze") {
    const input = JSON.parse(fs.readFileSync(String(options.in), "utf8"));
    const raw = input.b3?.raw || input.raw || input;
    result.b3 = { raw, analysis: analyzeLive(raw), stages: await liveStages(raw) };
  } else {
    process.stderr.write(`Unknown command "${command}". See the comment header of this file.\n`);
    process.exitCode = 2;
    return;
  }
  emit(result);
}

await main();
agent.destroy();
