import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CONTROLLED_SCENARIOS, readDiagnosticMetadata } from "./diagnostics-metadata.mjs";

const execFileAsync = promisify(execFile);

export const PERFETTO_VERSION = "v58.2";
export const PERFETTO_BUILD = "add693d8b";
export const PERFETTO_RELEASE = Object.freeze({
  version: PERFETTO_VERSION,
  windowsArchive: Object.freeze({
    name: "windows-amd64.zip",
    sha256: "5a00dbb990b1aa422c818169259ffaf0671e2ff276a51857f30185d8bf9d1409",
  }),
  uiArchive: Object.freeze({
    name: "perfetto-ui.zip",
    sha256: "e9e35351ef95c42ae5c053f6d755ffb3369235a107c532cdd0e1da79cd48db97",
  }),
});

export const PERFETTO_EXPECTED_STAGES = Object.freeze([
  "source_notification",
  "catalog_discovery",
  "source_queue",
  "source_preparation",
  "acquisition_normalization",
  "catalog_commit_wait",
  "catalog_projection",
  "session_commit_wait",
  "session_derivation",
  "normalized_store_commit",
  "candidate_to_commit",
  "history_read",
  "history_publish",
  "history_contribution",
  "checkpoint",
  "revision_notify",
  "cache_serve",
  "renderer_event",
  "renderer_fetch",
  "renderer_react_commit",
  "renderer_next_frame",
  "calibration",
  "benchmark_source",
  "visible_row",
]);

const MAX_QUERY_OUTPUT = 64 * 1024;
const MAX_DOWNLOAD_BYTES = 220 * 1024 * 1024;
export const PERFETTO_QUERY_FILE = fileURLToPath(new URL("./diagnostics/perfetto-report.sql", import.meta.url));
const QUERY = readFileSync(PERFETTO_QUERY_FILE, "utf8");
const COUNTER_QUERY = readFileSync(new URL("./diagnostics/perfetto-counters.sql", import.meta.url), "utf8");
const FLOW_QUERY = readFileSync(new URL("./diagnostics/perfetto-flows.sql", import.meta.url), "utf8");
const RENDERER_QUERY = readFileSync(new URL("./diagnostics/perfetto-renderer.sql", import.meta.url), "utf8");
const COUNTERS = ["queue_depth", "oldest_pending_ms", "active", "capacity", "cpu", "memory", "event_loop_ms", "bytes", "records"];
const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
});
const VIEWER_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: data:; img-src 'self' blob: data:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";

function repositoryRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function defaultPerfettoRoot() {
  return join(repositoryRoot(), "work", "perfetto");
}

function assertSafeRoot(root) {
  const absolute = resolve(root);
  if (!isAbsolute(absolute)) throw new TypeError("Perfetto root must be absolute");
  return absolute;
}

export function perfettoPaths(root = defaultPerfettoRoot()) {
  const base = assertSafeRoot(root);
  return Object.freeze({
    root: base,
    downloads: join(base, "downloads"),
    native: join(base, "native", "windows-amd64"),
    ui: join(base, "ui"),
    manifest: join(base, "manifest.json"),
    traceProcessor: join(base, "native", "windows-amd64", "trace_processor_shell.exe"),
  });
}

function releaseUrl(assetName) {
  return `https://github.com/google/perfetto/releases/download/${PERFETTO_VERSION}/${assetName}`;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function downloadPerfettoAsset(url, target, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("Perfetto setup requires fetch");
  let response;
  let destination = new URL(url);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    if (destination.protocol !== "https:" || destination.username || destination.password
      || !["github.com", "release-assets.githubusercontent.com"].includes(destination.hostname)) {
      throw new Error("Perfetto download destination is not official");
    }
    response = await fetchImpl(destination.href, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 4) throw new Error("Perfetto download redirect unavailable");
    destination = new URL(location, destination);
  }
  if (!response.ok || !response.body) throw new Error(`Perfetto download failed (${response.status})`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error("Perfetto download is too large");
  await mkdir(dirname(target), { recursive: true });
  let bytes = 0;
  const limit = new Transform({ transform(chunk, encoding, done) {
      bytes += chunk.byteLength;
      done(bytes > MAX_DOWNLOAD_BYTES ? new Error("Perfetto download is too large") : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(target, { flags: "wx" }));
}

async function extractArchive(archive, destination, exec = execFileAsync) {
  await mkdir(destination, { recursive: true });
  await exec("tar", ["-xf", archive, "-C", destination], { windowsHide: true, maxBuffer: MAX_QUERY_OUTPUT });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function setupPerfetto({
  root = defaultPerfettoRoot(),
  offline = false,
  fetchImpl = globalThis.fetch,
  exec = execFileAsync,
} = {}) {
  const paths = perfettoPaths(root);
  await mkdir(paths.downloads, { recursive: true });
  const archives = [
    [PERFETTO_RELEASE.windowsArchive, join(paths.downloads, PERFETTO_RELEASE.windowsArchive.name)],
    [PERFETTO_RELEASE.uiArchive, join(paths.downloads, PERFETTO_RELEASE.uiArchive.name)],
  ];
  for (const [asset, archive] of archives) {
    const valid = await exists(archive) && await hashFile(archive) === asset.sha256;
    if (!valid) {
      if (offline) throw new Error(`Missing or invalid offline Perfetto asset: ${asset.name}`);
      if (await exists(archive)) await unlink(archive);
      await downloadPerfettoAsset(releaseUrl(asset.name), archive, fetchImpl);
      if (await hashFile(archive) !== asset.sha256) throw new Error(`Perfetto asset hash mismatch: ${asset.name}`);
    }
  }
  // Reinstall from verified archives even offline: an existing extracted file is
  // not proof that its contents still match the pinned release.
  await extractArchive(archives[0][1], join(paths.root, "native"), exec);
  await extractArchive(archives[1][1], paths.ui, exec);
  if (!await exists(paths.traceProcessor) || !await exists(join(paths.ui, "index.html"))) {
    throw new Error("Perfetto archives did not contain the expected native shell and UI");
  }
  const manifest = {
    version: PERFETTO_VERSION,
    build: PERFETTO_BUILD,
    windowsArchiveSha256: PERFETTO_RELEASE.windowsArchive.sha256,
    uiArchiveSha256: PERFETTO_RELEASE.uiArchive.sha256,
  };
  await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return Object.freeze({ ...paths, manifest });
}

function assertTracePath(tracePath) {
  if (typeof tracePath !== "string" || !tracePath.trim()) throw new TypeError("A trace path is required");
  const path = resolve(tracePath);
  const extension = extname(path).toLowerCase();
  if (![".json", ".pftrace", ".perfetto-trace", ".zip", ".gz"].includes(extension)) {
    throw new TypeError("Trace must be a Perfetto, JSON, ZIP, or GZIP file");
  }
  return path;
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) { cells.push(cell); cell = ""; }
    else cell += character;
  }
  cells.push(cell);
  return cells;
}

export function parsePerfettoCsv(output) {
  const rows = parsePerfettoCsvRows(output);
  if (!rows.length) throw new Error("Perfetto query returned no rows");
  return rows[0];
}

export function parsePerfettoCsvRows(output) {
  const lines = String(output).trim().split(/\r?\n/u).filter(Boolean);
  if (!lines[0]) throw new Error("Perfetto query returned no rows");
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    if (headers.length !== values.length) throw new Error("Perfetto query returned malformed CSV");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

export async function runPerfettoQueryRows(tracePath, { root = defaultPerfettoRoot(), exec = execFileAsync, query = QUERY, queryFile = PERFETTO_QUERY_FILE } = {}) {
  const trace = assertTracePath(tracePath);
  const paths = perfettoPaths(root);
  if (!await exists(paths.traceProcessor)) throw new Error("Perfetto is not installed; run diagnostics-tools setup");
  const maintainedFile = query === QUERY ? queryFile : query === COUNTER_QUERY
    ? fileURLToPath(new URL("./diagnostics/perfetto-counters.sql", import.meta.url)) : query === FLOW_QUERY
      ? fileURLToPath(new URL("./diagnostics/perfetto-flows.sql", import.meta.url)) : query === RENDERER_QUERY
        ? fileURLToPath(new URL("./diagnostics/perfetto-renderer.sql", import.meta.url)) : null;
  const argumentsList = maintainedFile
    ? ["query", "-f", maintainedFile, trace]
    : ["query", trace, query];
  let result;
  try {
    result = await exec(paths.traceProcessor, argumentsList, {
      windowsHide: true,
      maxBuffer: MAX_QUERY_OUTPUT,
      timeout: 120_000,
    });
  } catch {
    throw new Error("Perfetto query failed");
  }
  return parsePerfettoCsvRows(result.stdout);
}

export async function runPerfettoQuery(tracePath, options = {}) {
  return (await runPerfettoQueryRows(tracePath, options))[0];
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function optionalNonNegativeInteger(value) {
  if (value === "[NULL]" || value === "" || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export async function analyzePerfettoTrace(tracePath, options = {}) {
  const [rows, counterRows, flowRows, rendererRows, metadata] = await Promise.all([
    runPerfettoQueryRows(tracePath, { ...options, query: QUERY }),
    runPerfettoQueryRows(tracePath, { ...options, query: COUNTER_QUERY, queryFile: null }),
    runPerfettoQueryRows(tracePath, { ...options, query: FLOW_QUERY, queryFile: null }),
    runPerfettoQueryRows(tracePath, { ...options, query: RENDERER_QUERY, queryFile: null }),
    readDiagnosticMetadata(assertTracePath(tracePath), PERFETTO_EXPECTED_STAGES),
  ]);
  const row = rows[0];
  if (!row) throw new Error("Perfetto query returned no rows");
  const stageCoverage = Object.fromEntries(rows.filter((entry) => PERFETTO_EXPECTED_STAGES.includes(entry.name)).map((entry) => [entry.name, Object.freeze({
    spans: nonNegativeInteger(entry.span_count),
    durationNs: nonNegativeInteger(entry.stage_dur_ns),
    p50Ns: optionalNonNegativeInteger(entry.p50_ns),
    p95Ns: optionalNonNegativeInteger(entry.p95_ns),
    maxNs: nonNegativeInteger(entry.stage_max_ns),
    incomplete: nonNegativeInteger(entry.incomplete_count),
    failures: nonNegativeInteger(entry.failure_count),
  })]));
  const missingStages = PERFETTO_EXPECTED_STAGES.filter((stage) => !stageCoverage[stage]?.spans);
  const counters = Object.fromEntries(counterRows.filter((entry) => COUNTERS.includes(entry.name)).map((entry) => [entry.name, {
    samples: nonNegativeInteger(entry.samples),
    minimum: optionalNonNegativeInteger(entry.minimum), maximum: optionalNonNegativeInteger(entry.maximum),
    total: optionalNonNegativeInteger(entry.total),
  }]));
  const flows = flowRows.filter((entry) => PERFETTO_EXPECTED_STAGES.includes(entry.upstream) && PERFETTO_EXPECTED_STAGES.includes(entry.downstream))
    .slice(0, 32).map((entry) => ({ upstream: entry.upstream, downstream: entry.downstream,
      samples: nonNegativeInteger(entry.samples), maxGapNs: nonNegativeInteger(entry.max_gap_ns) }));
  const renderer = rendererRows.filter((entry) => ["renderer_fetch", "renderer_react_commit", "renderer_next_frame"].includes(entry.name)
    && ["catalog", "activity", "requests"].includes(entry.surface)).slice(0, 9).map((entry) => ({
      stage: entry.name, surface: entry.surface, samples: nonNegativeInteger(entry.samples),
      p50LowerNs: optionalNonNegativeInteger(entry.p50_lower_ns), p50UpperNs: optionalNonNegativeInteger(entry.p50_upper_ns),
      p95LowerNs: optionalNonNegativeInteger(entry.p95_lower_ns), p95UpperNs: optionalNonNegativeInteger(entry.p95_upper_ns),
      maxErrorNs: optionalNonNegativeInteger(entry.max_error_ns),
    }));
  return Object.freeze({
    schema: "pomegr.perfetto.diagnostic.v1",
    tool: "Perfetto Trace Processor",
    version: PERFETTO_VERSION,
    traceSchemaVersion: optionalNonNegativeInteger(row.trace_schema_version),
    provenance: metadata.provenance,
    capture: metadata.capture,
    rendererClock: metadata.rendererClock,
    counters, flows, renderer,
    visualLatency: "unavailable",
    sliceCount: nonNegativeInteger(row.slice_count),
    totalDurationNs: nonNegativeInteger(row.total_dur_ns),
    maxDurationNs: nonNegativeInteger(row.max_dur_ns),
    coverage: Object.freeze({
      expectedStages: PERFETTO_EXPECTED_STAGES,
      enabledStages: metadata.enabledStages,
      unobservedEnabledStages: metadata.enabledStages?.filter((stage) => !stageCoverage[stage]?.spans) ?? null,
      observedStages: Object.freeze(PERFETTO_EXPECTED_STAGES.filter((stage) => stageCoverage[stage]?.spans)),
      missingStages: Object.freeze(missingStages),
      stageCoverage: Object.freeze(stageCoverage),
    }),
  });
}

export function comparePerfettoReports(before, after) {
  if (!before || !after || before.schema !== "pomegr.perfetto.diagnostic.v1" || after.schema !== before.schema) {
    throw new TypeError("Perfetto reports have an unsupported schema");
  }
  const scenario = CONTROLLED_SCENARIOS.includes(before.provenance?.scenario)
    && before.provenance.scenario === after.provenance?.scenario;
  const clock = Boolean(before.provenance?.clockQuality) && before.provenance.clockQuality === after.provenance?.clockQuality;
  const coverage = Array.isArray(before.coverage?.observedStages) && Array.isArray(after.coverage?.observedStages)
    && [...before.coverage.observedStages].sort().join(",") === [...after.coverage.observedStages].sort().join(",");
  const complete = (report) => report.capture ? report.capture.incomplete === false && report.capture.active === false
    && report.capture.droppedEvents === 0 && report.capture.droppedSpans === 0 && report.capture.droppedHandles === 0 : scenario;
  return Object.freeze({
    schema: "pomegr.perfetto.compare.v1",
    tool: "Perfetto Trace Processor",
    version: PERFETTO_VERSION,
    compatibility: Object.freeze({
      schema: before.schema === after.schema,
      traceProcessor: before.version === after.version,
      traceSchema: before.traceSchemaVersion === null || after.traceSchemaVersion === null
        ? "unknown" : before.traceSchemaVersion === after.traceSchemaVersion,
      scenario, clock, coverage, complete: complete(before) && complete(after),
      compatible: before.schema === after.schema && before.version === after.version
        && before.traceSchemaVersion !== null && after.traceSchemaVersion !== null
        && before.traceSchemaVersion === after.traceSchemaVersion && scenario && clock && coverage
        && complete(before) && complete(after),
    }),
    coverage: Object.freeze({
      beforeMissingStages: Object.freeze([...(before.coverage?.missingStages || [])]),
      afterMissingStages: Object.freeze([...(after.coverage?.missingStages || [])]),
    }),
    metrics: Object.freeze({
      sliceCount: Object.freeze({ before: before.sliceCount, after: after.sliceCount, delta: after.sliceCount - before.sliceCount }),
      totalDurationNs: Object.freeze({ before: before.totalDurationNs, after: after.totalDurationNs, delta: after.totalDurationNs - before.totalDurationNs }),
      maxDurationNs: Object.freeze({ before: before.maxDurationNs, after: after.maxDurationNs, delta: after.maxDurationNs - before.maxDurationNs }),
    }),
    stages: Object.fromEntries(PERFETTO_EXPECTED_STAGES.filter((stage) => before.coverage?.stageCoverage?.[stage]?.spans
      && after.coverage?.stageCoverage?.[stage]?.spans).map((stage) => [stage, {
        before: before.coverage.stageCoverage[stage], after: after.coverage.stageCoverage[stage],
      }])),
  });
}

export function formatPerfettoReportMarkdown(report) {
  const missing = report.coverage?.missingStages || [];
  const missingLabel = missing.length ? missing.join(", ") : "none";
  return [
    "# Pomegr Perfetto report",
    "",
    `Tool version: ${report.version}`,
    `Trace schema version: ${report.traceSchemaVersion ?? "unknown"}`,
    `Scenario: ${report.provenance?.scenario ?? "unknown"}; build: ${report.provenance?.build ?? "unknown"}`,
    `Clock quality: ${report.provenance?.clockQuality ?? "unknown"}; visual latency: unavailable`,
    `Renderer calibration: ${report.rendererClock?.status ?? "unavailable"}; rejected: ${report.rendererClock?.rejectedCalibrations ?? "unknown"}; maximum uncertainty (µs): ${report.rendererClock?.maxErrorUs ?? "unknown"}`,
    `Capture: ${report.capture ? (report.capture.incomplete || report.capture.active ? "incomplete" : "closed") : "unknown"}; dropped events: ${report.capture?.droppedEvents ?? "unknown"}; dropped spans: ${report.capture?.droppedSpans ?? "unknown"}; dropped handles: ${report.capture?.droppedHandles ?? "unknown"}`,
    `Slices: ${report.sliceCount}`,
    `Sum of slice durations (ns, overlapping work included): ${report.totalDurationNs}`,
    `Maximum slice (ns): ${report.maxDurationNs}`,
    "",
    "## Coverage",
    "",
    `Observed stages: ${(report.coverage?.observedStages || []).join(", ") || "none"}`,
    `Enabled but unobserved: ${report.coverage?.unobservedEnabledStages?.join(", ") || (report.coverage?.enabledStages ? "none" : "unknown")}`,
    `Missing stages: ${missingLabel}`,
    "",
    "| Stage | Samples | p50 ms | p95 ms | Incomplete | Failed/rejected |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(report.coverage?.stageCoverage || {}).map(([stage, value]) =>
      `| ${stage} | ${value.spans} | ${value.p50Ns === null ? "unavailable" : (value.p50Ns / 1e6).toFixed(3)} | ${value.p95Ns === null ? "unavailable" : (value.p95Ns / 1e6).toFixed(3)} | ${value.incomplete} | ${value.failures} |`),
    "", "## Resource and queue counters", "",
    "CPU is sampled process microseconds; memory is RSS bytes. Other units follow the counter name.",
    "Counter totals other than CPU/bytes/records are sample sums, not consumption.", "",
    "| Counter | Samples | Minimum | Maximum |", "| --- | ---: | ---: | ---: |",
    ...Object.entries(report.counters || {}).map(([counter, value]) => `| ${counter} | ${value.samples} | ${value.minimum ?? "unavailable"} | ${value.maximum ?? "unavailable"} |`),
    "", "## Causal slice edges", "",
    "These are backend slice gaps, not source-to-pixel latency.", "",
    ...(report.flows?.length ? report.flows.map((flow) => `${flow.upstream} → ${flow.downstream}: ${flow.samples} edges; maximum gap ${(flow.maxGapNs / 1e6).toFixed(3)} ms`) : ["No causal edges observed."]),
    "", "## Committed-response issuance to renderer milestone", "",
    "These intervals include the measured clock uncertainty. They do not measure source arrival or paint.", "",
    ...(report.renderer?.length ? report.renderer.map((entry) => `${entry.surface} / ${entry.stage}: ${entry.samples} samples; p95 interval ${entry.p95LowerNs === null ? "unavailable" : (entry.p95LowerNs / 1e6).toFixed(3)}–${entry.p95UpperNs === null ? "unavailable" : (entry.p95UpperNs / 1e6).toFixed(3)} ms`) : ["No calibrated renderer milestones observed."]),
  ].join("\n");
}

export function formatPerfettoComparisonMarkdown(comparison) {
  const metric = (name) => comparison.metrics[name];
  return [
    "# Pomegr Perfetto comparison",
    "",
    `Compatible: ${comparison.compatibility.compatible ? "yes" : "no"}`,
    `Schema compatible: ${comparison.compatibility.schema ? "yes" : "no"}`,
    `Trace Processor compatible: ${comparison.compatibility.traceProcessor ? "yes" : "no"}`,
    `Trace schema compatible: ${comparison.compatibility.traceSchema === "unknown" ? "unknown" : comparison.compatibility.traceSchema ? "yes" : "no"}`,
    `Controlled scenario: ${comparison.compatibility.scenario ? "matched" : "unknown or different"}; clock: ${comparison.compatibility.clock ? "matched" : "unknown or different"}; coverage: ${comparison.compatibility.coverage ? "matched" : "unknown or different"}`,
    "Deltas are descriptive only when compatibility is unavailable; this is not a visual-speed claim.",
    "",
    "| Metric | Before | After | Delta |",
    "| --- | ---: | ---: | ---: |",
    `| Slices | ${metric("sliceCount").before} | ${metric("sliceCount").after} | ${metric("sliceCount").delta} |`,
    `| Total duration (ns) | ${metric("totalDurationNs").before} | ${metric("totalDurationNs").after} | ${metric("totalDurationNs").delta} |`,
    `| Maximum slice (ns) | ${metric("maxDurationNs").before} | ${metric("maxDurationNs").after} | ${metric("maxDurationNs").delta} |`,
    "",
    `Missing stages before: ${comparison.coverage.beforeMissingStages.join(", ") || "none"}`,
    `Missing stages after: ${comparison.coverage.afterMissingStages.join(", ") || "none"}`,
  ].join("\n");
}

function safeRelativePath(root, pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0]);
  const candidate = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

export async function startPerfettoViewer({ root = defaultPerfettoRoot(), port = 0, host = "127.0.0.1", create = createServer } = {}) {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new TypeError("Perfetto viewer must bind to loopback");
  const paths = perfettoPaths(root);
  if (!await exists(join(paths.ui, "index.html"))) throw new Error("Perfetto UI is not installed; run diagnostics-tools setup");
  const actualRoot = await realpath(paths.ui);
  const server = create(async (request, response) => {
    try {
      const requested = safeRelativePath(paths.ui, request.url || "/");
      if (!requested) { response.writeHead(400); response.end("Bad request"); return; }
      let file = requested;
      if (await (async () => { try { return (await stat(file)).isDirectory(); } catch { return false; } })()) file = join(file, "index.html");
      file = await realpath(file);
      const actualRelative = relative(actualRoot, file);
      if (actualRelative.startsWith("..") || isAbsolute(actualRelative)) {
        response.writeHead(403); response.end("Forbidden"); return;
      }
      const body = await readFile(file);
      response.writeHead(200, { "content-type": MIME_TYPES[extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store", "content-security-policy": VIEWER_CSP, "referrer-policy": "no-referrer" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => { server.removeListener("error", reject); resolvePromise(); });
  });
  const address = server.address();
  return Object.freeze({ server, url: `http://${host === "::1" ? "[::1]" : host}:${address.port}/`, port: address.port });
}

export function parseArgs(args = []) {
  const options = { command: args[0] || "help", paths: [], input: "", before: "", after: "", json: false, markdown: false, offline: false, port: 0 };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--markdown") options.markdown = true;
    else if (argument === "--offline") options.offline = true;
    else if (argument === "--input") options.input = String(args[index += 1] || "");
    else if (argument === "--before") options.before = String(args[index += 1] || "");
    else if (argument === "--after") options.after = String(args[index += 1] || "");
    else if (argument === "--port") {
      const parsed = Number(args[index += 1]);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new TypeError("Port must be between 0 and 65535");
      options.port = parsed;
    } else if (argument.startsWith("--")) throw new TypeError("Unknown diagnostics option");
    else options.paths.push(argument);
  }
  return Object.freeze(options);
}

export function diagnosticsHelp() {
  return [
    "Usage: node scripts/diagnostics-tools.mjs <setup|viewer|analyze|compare> [options]",
    "",
    "  setup [--offline]       Install or verify pinned Perfetto v58.2 assets",
    "  viewer [--port <port>]  Serve the pinned UI on loopback",
    "  analyze --input <trace> Print a fixed aggregate trace report",
    "  compare --before <trace> --after <trace>  Compare two reports",
    "  --json                  Emit machine-readable output",
    "  --markdown              Emit a concise Markdown report",
  ].join("\n");
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.command === "help" || options.command === "--help" || options.command === "-h") { process.stdout.write(`${diagnosticsHelp()}\n`); return; }
  if (options.command === "setup") { process.stdout.write(`${JSON.stringify(await setupPerfetto({ offline: options.offline }), null, 2)}\n`); return; }
  if (options.command === "viewer") {
    const viewer = await startPerfettoViewer({ port: options.port });
    process.stdout.write(`${viewer.url}\n`);
    await new Promise((resolvePromise) => { const stop = () => { viewer.server.close(() => resolvePromise()); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); });
    return;
  }
  if (options.command === "analyze") {
    const input = options.input || (options.paths.length === 1 ? options.paths[0] : "");
    if (!input || options.paths.length > 1) throw new TypeError("analyze requires one trace path");
    const report = await analyzePerfettoTrace(input);
    process.stdout.write(`${options.markdown ? formatPerfettoReportMarkdown(report) : JSON.stringify(report, null, options.json ? 0 : 2)}\n`);
    return;
  }
  if (options.command === "compare") {
    const paths = options.before && options.after ? [options.before, options.after] : options.paths;
    if (paths.length !== 2) throw new TypeError("compare requires two trace paths");
    const report = comparePerfettoReports(await analyzePerfettoTrace(paths[0]), await analyzePerfettoTrace(paths[1]));
    process.stdout.write(`${options.markdown ? formatPerfettoComparisonMarkdown(report) : JSON.stringify(report, null, options.json ? 0 : 2)}\n`);
    return;
  }
  throw new TypeError("Unknown diagnostics command");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("[pomegr] Diagnostics command failed. Use --help.\n"); process.exitCode = 1; });
}
