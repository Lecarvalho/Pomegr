import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzePerfettoTrace,
  comparePerfettoReports,
  defaultPerfettoRoot,
  downloadPerfettoAsset,
  parseArgs,
  parsePerfettoCsv,
  perfettoPaths,
  PERFETTO_EXPECTED_STAGES,
  runPerfettoQueryRows,
  startPerfettoViewer,
} from "../scripts/diagnostics-tools.mjs";
import { createPipelineTraceRecorder, PIPELINE_TRACE_STAGES } from "../monitor/pipeline-trace.mjs";
import { readDiagnosticMetadata } from "../scripts/diagnostics-metadata.mjs";

test("setup follows official asset redirects and rejects other destinations before requesting them", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-perfetto-download-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const visited = [];
  const file = path.join(directory, "asset.zip");
  await downloadPerfettoAsset("https://github.com/google/perfetto/releases/download/v58.2/windows-amd64.zip", file, async (url) => {
    visited.push(url);
    return visited.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/asset" } })
      : new Response("synthetic asset");
  });
  assert.equal(visited.length, 2);
  assert.equal(await readFile(file, "utf8"), "synthetic asset");
  let requests = 0;
  await assert.rejects(() => downloadPerfettoAsset("https://github.com/asset", path.join(directory, "rejected.zip"), async () => {
    requests += 1;
    return new Response(null, { status: 302, headers: { location: "https://unapproved.invalid/asset" } });
  }), /not official/);
  assert.equal(requests, 1);
});

test("diagnostics CLI parses only bounded options", () => {
  assert.deepEqual(parseArgs(["analyze", "trace.json", "--json"]), {
    command: "analyze", paths: ["trace.json"], input: "", before: "", after: "", json: true, markdown: false, offline: false, port: 0,
  });
  assert.throws(() => parseArgs(["viewer", "--shell", "cmd"]), /Unknown diagnostics option/);
  assert.throws(() => parseArgs(["viewer", "--port", "65536"]), /Port must be between/);
});

test("Perfetto CSV parser handles quoted fields and returns one bounded row", () => {
  assert.deepEqual(parsePerfettoCsv('"slice_count","total_dur_ns","max_dur_ns"\n"2","800000","500000"'), {
    slice_count: "2", total_dur_ns: "800000", max_dur_ns: "500000",
  });
  assert.throws(() => parsePerfettoCsv(""), /no rows/);
});

test("Perfetto report comparison exposes fixed metric deltas", () => {
  const before = { schema: "pomegr.perfetto.diagnostic.v1", version: "v58.2", traceSchemaVersion: 1, sliceCount: 2, totalDurationNs: 800000, maxDurationNs: 500000 };
  const after = { schema: "pomegr.perfetto.diagnostic.v1", version: "v58.2", traceSchemaVersion: 1, sliceCount: 3, totalDurationNs: 1000000, maxDurationNs: 600000 };
  const comparison = comparePerfettoReports(before, after);
  assert.deepEqual(comparison.metrics.totalDurationNs, { before: 800000, after: 1000000, delta: 200000 });
  assert.equal(comparison.compatibility.compatible, false, "same schema alone cannot establish comparable workload or clocks");
  const context = { provenance: { scenario: "progressive_activity_withheld_correlation", clockQuality: "performance.now" },
    coverage: { observedStages: ["history_publish"] } };
  assert.equal(comparePerfettoReports({ ...before, ...context }, { ...after, ...context }).compatibility.compatible, true);
  assert.throws(() => comparePerfettoReports({ schema: "other" }, after), /unsupported schema/);
});

test("Perfetto coverage stays aligned with the recorder stage contract", () => {
  assert.deepEqual(PERFETTO_EXPECTED_STAGES, PIPELINE_TRACE_STAGES);
});

test("report metadata preserves capture loss and never echoes arbitrary identity", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-report-metadata-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "trace.json");
  const recorder = createPipelineTraceRecorder({ enabled: true, maxEvents: 1 });
  recorder.recordCounter({ counter: "memory", value: 1024 });
  recorder.recordCounter({ counter: "memory", value: 2048 });
  recorder.deactivate();
  const trace = structuredClone(recorder.snapshot());
  trace.metadata.provenance.private = "PRIVATE_SENTINEL";
  trace.metadata.private = "PRIVATE_SENTINEL";
  await writeFile(file, JSON.stringify(trace));
  const metadata = await readDiagnosticMetadata(file, PERFETTO_EXPECTED_STAGES);
  assert.equal(metadata.capture.droppedEvents, 1);
  assert.equal(metadata.provenance.scenario, "live_observation");
  assert.equal(JSON.stringify(metadata).includes("PRIVATE_SENTINEL"), false);
  trace.metadata.provenance.scenario = "synthetic_benchmark";
  await writeFile(file, JSON.stringify(trace));
  assert.equal((await readDiagnosticMetadata(file, PERFETTO_EXPECTED_STAGES)).provenance.scenario, "synthetic_benchmark");
});

test("local viewer serves the static UI and rejects traversal", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-perfetto-viewer-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, "ui"), { recursive: true });
  await writeFile(path.join(root, "ui", "index.html"), "<title>local perfetto</title>");
  const viewer = await startPerfettoViewer({ root });
  context.after(() => new Promise((resolve) => viewer.server.close(resolve)));
  const response = await fetch(viewer.url);
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self' blob: data:/u);
  const page = await response.text();
  assert.match(page, /local perfetto/);
  const traversal = await fetch(`${viewer.url}..%2Fdiagnostics-tools.mjs`);
  assert.equal(traversal.status, 400);
});

test("viewer refuses non-loopback binding", async () => {
  await assert.rejects(() => startPerfettoViewer({ root: path.join(os.tmpdir(), "missing"), host: "0.0.0.0" }), /loopback/);
});

test("viewer cannot follow an asset directory link outside its UI root", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-perfetto-link-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "ui"));
  await mkdir(path.join(root, "outside"));
  await writeFile(path.join(root, "ui", "index.html"), "synthetic UI");
  await writeFile(path.join(root, "outside", "private.txt"), "PRIVATE_SENTINEL");
  await symlink(path.join(root, "outside"), path.join(root, "ui", "linked"), process.platform === "win32" ? "junction" : "dir");
  const viewer = await startPerfettoViewer({ root });
  context.after(() => new Promise((resolve) => viewer.server.close(resolve)));
  const response = await fetch(`${viewer.url}linked/private.txt`);
  assert.equal(response.status, 403);
  assert.equal((await response.text()).includes("PRIVATE_SENTINEL"), false);
});

test("native Perfetto validates a synthetic trace when the pinned local setup exists", async (context) => {
  const root = defaultPerfettoRoot();
  const paths = perfettoPaths(root);
  try { await access(paths.traceProcessor); } catch { context.skip("pinned local Perfetto setup is not present"); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-perfetto-trace-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const trace = path.join(directory, "synthetic.json");
  await writeFile(trace, JSON.stringify({ metadata: { version: 1 }, traceEvents: [
    { name: "pipeline_flow", cat: "runtime", ph: "s", ts: 1000, pid: 1, tid: 2, id: 1 },
    { name: "catalog_discovery", cat: "acquisition", ph: "X", ts: 1000, dur: 500, pid: 1, tid: 2 },
    { name: "pipeline_flow", cat: "runtime", ph: "t", ts: 1500, pid: 1, tid: 2, id: 1 },
    { name: "source_queue", cat: "runtime", ph: "X", ts: 2000, dur: 300, pid: 1, tid: 2 },
    { name: "pipeline_flow", cat: "runtime", ph: "f", ts: 2300, pid: 1, tid: 2, id: 1 },
    { name: "memory", cat: "runtime", ph: "C", ts: 2300, pid: 1, tid: 1, args: { value: 4096 } },
  ] }), "utf8");
  const report = await analyzePerfettoTrace(trace, { root });
  assert.deepEqual({
    schema: report.schema,
    version: report.version,
    traceSchemaVersion: report.traceSchemaVersion,
    sliceCount: report.sliceCount,
    totalDurationNs: report.totalDurationNs,
    maxDurationNs: report.maxDurationNs,
  }, {
    schema: "pomegr.perfetto.diagnostic.v1",
    version: "v58.2",
    traceSchemaVersion: 1,
    sliceCount: 2,
    totalDurationNs: 800000,
    maxDurationNs: 500000,
  });
  assert.deepEqual(report.coverage.observedStages, ["catalog_discovery", "source_queue"]);
  assert.ok(report.coverage.missingStages.includes("session_derivation"));
  assert.deepEqual(report.coverage.stageCoverage.catalog_discovery, { spans: 1, durationNs: 500000,
    p50Ns: 500000, p95Ns: 500000, maxNs: 500000, incomplete: 0, failures: 0 });
  assert.equal(report.counters.memory.maximum, 4096);
  const [flow] = await runPerfettoQueryRows(trace, { root, query: "SELECT COUNT(*) AS flow_count FROM flow" });
  assert.ok(Number(flow.flow_count) >= 1);
});

test("native renderer query reports calibrated intervals rather than false exact paint latency", async (context) => {
  try { await access(perfettoPaths().traceProcessor); } catch { context.skip("pinned local Perfetto setup is not present"); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-renderer-query-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "synthetic.json");
  await writeFile(file, JSON.stringify({ metadata: { version: 1 }, traceEvents: [
    { name: "cache_serve", cat: "serving", ph: "X", ts: 10000, dur: 0, pid: 1, tid: 1,
      args: { outcome: "observed", revision: 1, surface: "activity" } },
    { name: "renderer_react_commit", cat: "presentation", ph: "X", ts: 10500, dur: 500, pid: 1, tid: 2,
      args: { outcome: "observed", revision: 1, surface: "activity", clock: "request_interval_bound", clockErrorUs: 1000 } },
  ] }));
  const report = await analyzePerfettoTrace(file);
  assert.deepEqual(report.renderer, [{ stage: "renderer_react_commit", surface: "activity", samples: 1,
    p50LowerNs: 0, p50UpperNs: 2000000, p95LowerNs: 0, p95UpperNs: 2000000, maxErrorNs: 1000000 }]);
  assert.equal(report.visualLatency, "unavailable");
});
