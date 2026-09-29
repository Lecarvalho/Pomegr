import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  analyzePipelineLogs,
  createPipelineLogFollower,
  diagnosticsLogsHelp,
  formatDiagnosticsLogs,
  parseDiagnosticsLogsArgs,
} from "../scripts/diagnostics-logs.mjs";
import {
  diagnosticsSnapshotHelp,
  formatDiagnosticsSnapshot,
  parseDiagnosticsSnapshotArgs,
  runDiagnosticsSnapshot,
} from "../scripts/diagnostics-snapshot.mjs";
import { createPipelineOperationsSnapshot } from "../monitor/pipeline-operations.mjs";
import { startPipelineOperationsTransport } from "../monitor/pipeline-operations-transport.mjs";
import { normalizePipelineLogRecord } from "../monitor/pipeline-log-schema.mjs";

const execFileAsync = promisify(execFile);

const run = "123e4567-e89b-12d3-a456-426614174000";
const at = "2026-09-11T12:00:00.000Z";
const common = { version: 1, run, at };

async function fixture(records, name = "pipeline-20260911T120000000Z-a1b2c3d4e5f6-000000.jsonl") {
  const directory = await mkdtemp(join(tmpdir(), "pomegr-logs-"));
  const path = join(directory, name);
  await writeFile(path, records.map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n"), "utf8");
  return { directory, path };
}

test("pipeline log analysis aggregates validated spans and bounded gap data", async () => {
  const { directory } = await fixture([
    { ...common, kind: "span_start", stage: "catalog_discovery", domain: "acquisition", startMs: 10, lane: 1 },
    { ...common, at: "2026-09-11T12:00:01.000Z", kind: "span", stage: "catalog_discovery", domain: "acquisition", startMs: 10, lane: 1, durationMs: 24, outcome: "completed" },
    { ...common, at: "2026-09-11T12:00:02.000Z", kind: "span_start", stage: "catalog_discovery", domain: "acquisition", startMs: 12.5, lane: 1 },
    { ...common, at: "2026-09-11T12:00:03.000Z", kind: "gap", droppedRecords: 4, rejectedRecords: 2, reason: "backpressure" },
    "{not json}\n",
  ]);
  const report = await analyzePipelineLogs({ directory, maxBytes: 1024 * 1024 });
  assert.equal(report.records.total, 4);
  assert.equal(report.records.malformed, 1);
  assert.deepEqual(report.gaps, { records: 1, droppedRecords: 4, rejectedRecords: 2 });
  assert.deepEqual(report.stages.catalog_discovery, {
    count: 1, failed: 0, incomplete: 1, minMs: 24, maxMs: 24, averageMs: 24, p50Ms: 24, p95Ms: 24, quantiles: "exact",
  });
  assert.match(formatDiagnosticsLogs(report), /retained logs; not a whole session/);
  assert.match(formatDiagnosticsLogs(report), /\| exact \|/);
});

test("pipeline log schema accepts a bounded provider and priority lane, and rejects unknown values or extra fields", () => {
  const spanStart = { ...common, kind: "span_start", stage: "source_queue", domain: "acquisition", startMs: 1, lane: 1, provider: "codex", priorityLane: "urgent" };
  const normalizedStart = normalizePipelineLogRecord(spanStart);
  assert.ok(normalizedStart);
  assert.equal(normalizedStart.provider, "codex");
  assert.equal(normalizedStart.priorityLane, "urgent");

  const span = { ...common, kind: "span", stage: "source_queue", domain: "acquisition", startMs: 1, lane: 1, durationMs: 5, outcome: "completed", provider: "codex", priorityLane: "urgent" };
  const normalized = normalizePipelineLogRecord(span);
  assert.equal(normalized.provider, "codex");
  assert.equal(normalized.priorityLane, "urgent");

  // A stage with no lane (catalog_discovery) may carry provider alone.
  const noLane = { ...common, kind: "span", stage: "catalog_discovery", domain: "acquisition", startMs: 1, lane: 1, durationMs: 5, outcome: "completed", provider: "claude" };
  assert.ok(normalizePipelineLogRecord(noLane));

  assert.equal(normalizePipelineLogRecord({ ...span, provider: "openai" }), null, "an unknown provider is rejected");
  assert.equal(normalizePipelineLogRecord({ ...span, priorityLane: "urgent-ish" }), null, "an unknown lane is rejected");
  assert.equal(normalizePipelineLogRecord({ ...span, priorityLane: "selected" })?.priorityLane, "selected", "a selection lane is accepted");
  assert.equal(normalizePipelineLogRecord({ ...span, region: "us" }), null, "any extra field is rejected");
});

test("pipeline log analysis groups stage timings by provider and priority lane, keeping legacy records unattributed", async () => {
  const { directory } = await fixture([
    { ...common, kind: "span", stage: "source_queue", domain: "acquisition", startMs: 1, lane: 1, durationMs: 10, outcome: "completed", provider: "codex", priorityLane: "urgent" },
    { ...common, at: "2026-09-11T12:00:01.000Z", kind: "span", stage: "source_queue", domain: "acquisition", startMs: 2, lane: 1, durationMs: 10, outcome: "completed", provider: "codex", priorityLane: "urgent" },
    { ...common, at: "2026-09-11T12:00:02.000Z", kind: "span", stage: "source_queue", domain: "acquisition", startMs: 3, lane: 1, durationMs: 5, outcome: "completed" },
    { ...common, at: "2026-09-11T12:00:03.000Z", kind: "span", stage: "catalog_discovery", domain: "acquisition", startMs: 4, lane: 1, durationMs: 8, outcome: "completed", provider: "claude" },
    "",
  ]);
  const report = await analyzePipelineLogs({ directory, maxBytes: 1024 * 1024 });
  assert.equal(report.stages.source_queue.count, 3, "the existing aggregate stays unchanged");
  assert.deepEqual(report.stagesByAttribution.source_queue.codex.urgent, {
    count: 2, failed: 0, incomplete: 0, minMs: 10, maxMs: 10, averageMs: 10, p50Ms: 10, p95Ms: 10, quantiles: "exact",
  });
  assert.deepEqual(report.stagesByAttribution.source_queue.unattributed.unattributed, {
    count: 1, failed: 0, incomplete: 0, minMs: 5, maxMs: 5, averageMs: 5, p50Ms: 5, p95Ms: 5, quantiles: "exact",
  });
  assert.deepEqual(report.stagesByAttribution.catalog_discovery.claude.unattributed, {
    count: 1, failed: 0, incomplete: 0, minMs: 8, maxMs: 8, averageMs: 8, p50Ms: 8, p95Ms: 8, quantiles: "exact",
  });
});

test("partial trailing and oversized lines are reported without parsing them", async () => {
  const { directory } = await fixture([
    JSON.stringify({ ...common, kind: "span", stage: "catalog_discovery", domain: "acquisition", startMs: 1, lane: 1, durationMs: 1, outcome: "completed" }),
    "x".repeat(70 * 1024),
    '{"version":1',
  ]);
  const report = await analyzePipelineLogs({ directory });
  assert.equal(report.records.total, 1);
  assert.ok(report.records.incompleteTrailingFiles >= 1);
  assert.equal(report.records.malformed, 0);
});

test("oversized lines are discarded through their newline instead of parsing a suffix", async () => {
  const valid = JSON.stringify({ ...common, kind: "lifecycle", event: "started" });
  const { directory } = await fixture([`${"x".repeat(70 * 1024)}${valid}\n${valid}\n`]);
  const report = await analyzePipelineLogs({ directory });
  assert.equal(report.records.total, 1);
  assert.equal(report.records.malformed, 0);
});

test("health failures retain bounded timestamped history while latest health can recover", async () => {
  const failedAt = "2026-09-11T12:00:01.000Z";
  const healthyAt = "2026-09-11T12:00:02.000Z";
  const failed = createPipelineOperationsSnapshot({ coordinator: { observers: { claude: {
    acquisitionFailures: 1,
    failureDetails: { acquisitionFailures: { stage: "acquire_normalize", reason: "EACCES", observedAt: failedAt } },
  } } } }, failedAt);
  const healthy = createPipelineOperationsSnapshot({}, healthyAt);
  const { directory } = await fixture([
    { ...common, at: failedAt, kind: "health", snapshot: failed },
    `${JSON.stringify({ ...common, at: healthyAt, kind: "health", snapshot: healthy })}\n`,
  ]);
  const report = await analyzePipelineLogs({ directory });
  assert.deepEqual(report.healthFailures, []);
  assert.equal(report.healthHistory.length, 1);
  assert.equal(report.healthHistory[0].at, failedAt);
  assert.deepEqual(report.healthHistory[0].failures, [{ stage: "acquire_normalize", reason: "EACCES" }]);
});

test("directory selection ignores symlinks and non-writer filenames", async (t) => {
  const { directory, path } = await fixture([`${JSON.stringify({ ...common, kind: "lifecycle", event: "started" })}\n`]);
  await writeFile(join(directory, "private.jsonl"), "{bad}\n");
  const beforeLink = await analyzePipelineLogs({ directory });
  assert.equal(beforeLink.files.selected, 1);
  assert.equal(beforeLink.records.total, 1);
  const linked = join(directory, "pipeline-20260911T120001000Z-a1b2c3d4e5f6-000001.jsonl");
  try { await symlink(path, linked); } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) { t.skip("file symlinks unavailable"); return; }
    throw error;
  }
  const report = await analyzePipelineLogs({ directory });
  assert.equal(report.files.selected, 1);
  assert.equal(report.records.total, 1);
});

test("options use bounded filters and produce concise, sanitized output", () => {
  const options = parseDiagnosticsLogsArgs(["--since", "5m", "--until", "2026-09-11T12:00:00.000Z", "--stage", "catalog_discovery", "--json"], { now: Date.parse("2026-09-11T12:03:00.000Z") });
  assert.equal(options.since, Date.parse("2026-09-11T11:58:00.000Z"));
  assert.equal(options.json, true);
  assert.match(diagnosticsLogsHelp(), /--follow/);
  assert.throws(() => parseDiagnosticsLogsArgs(["--stage", "raw prompt here"]), /invalid/);
  assert.throws(() => parseDiagnosticsLogsArgs(["--since", "late"]), /ISO/);
});

test("follow reads only appended complete records and starts a new rotation at its beginning", async () => {
  const { directory, path } = await fixture([{ ...common, kind: "lifecycle", event: "started" }]);
  const follower = await createPipelineLogFollower({ directory });
  const first = { ...common, at: "2026-09-11T12:00:04.000Z", kind: "lifecycle", event: "stopped" };
  const line = JSON.stringify(first);
  await appendFile(path, `\n${line.slice(0, 20)}`, "utf8");
  assert.deepEqual(await follower.poll(), []);
  await appendFile(path, `${line.slice(20)}\n`, "utf8");
  assert.deepEqual(await follower.poll(), [first]);
  assert.deepEqual(await follower.poll(), []);

  const rotated = join(directory, "pipeline-20260911T120001000Z-a1b2c3d4e5f6-000001.jsonl");
  const next = { ...common, at: "2026-09-11T12:00:05.000Z", kind: "lifecycle", event: "started" };
  await writeFile(rotated, `${JSON.stringify(next)}\n`, "utf8");
  assert.deepEqual(await follower.poll(), [next]);
});

test("follow bounds each poll by bytes and records, reports partial lines, and detects missed rotation", async () => {
  const { directory, path } = await fixture([{ ...common, kind: "lifecycle", event: "started" }]);
  const follower = await createPipelineLogFollower({ directory, maxPollBytes: 32, maxPollRecords: 1 });
  const next = { ...common, at: "2026-09-11T12:00:06.000Z", kind: "lifecycle", event: "stopped" };
  await appendFile(path, `\n${JSON.stringify(next)}`, "utf8");
  const partial = await follower.poll();
  assert.deepEqual(partial, []);
  assert.equal(partial.coverage.status, "partial");
  assert.ok(partial.coverage.bytesRead <= 32);
  const rotated = join(directory, "pipeline-20260911T120001000Z-a1b2c3d4e5f6-000001.jsonl");
  await writeFile(rotated, `${JSON.stringify({ ...next, at: "2026-09-11T12:00:07.000Z" })}\n`, "utf8");
  const { unlink } = await import("node:fs/promises");
  await unlink(path);
  const missed = await follower.poll();
  assert.equal(missed.coverage.status, "rotation_missed");
  assert.equal(missed.coverage.missedRotation, true);

  const limited = await fixture([{ ...common, kind: "lifecycle", event: "started" }]);
  const limitedFollower = await createPipelineLogFollower({ directory: limited.directory, maxPollRecords: 1 });
  const stopped = { ...common, at: "2026-09-11T12:00:08.000Z", kind: "lifecycle", event: "stopped" };
  const restarted = { ...common, at: "2026-09-11T12:00:09.000Z", kind: "lifecycle", event: "started" };
  await appendFile(limited.path, `
${JSON.stringify(stopped)}
${JSON.stringify(restarted)}
`, "utf8");
  assert.deepEqual(await limitedFollower.poll(), [stopped], "complete records past the per-poll limit are preserved");
  assert.deepEqual(await limitedFollower.poll(), [restarted]);
});

test("follow preserves valid health and ordinary rows crossing read-buffer boundaries", async () => {
  const observers = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`p${index}`, {
    failureDetails: { acquisitionFailures: {
      stage: "acquire_normalize", reason: "schema_validation", observedAt: at,
      validation: { issues: Array.from({ length: 20 }, (_, issue) => ({ field: `field_${issue}`, rule: `rule_${issue}` })) },
    } },
  }]));
  const health = normalizePipelineLogRecord({ ...common, kind: "health",
    snapshot: createPipelineOperationsSnapshot({ coordinator: { observers } }),
  });
  assert.ok(health);
  assert.ok(Buffer.byteLength(JSON.stringify(health)) > 16 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(health)) < 64 * 1024);
  const ordinary = Array.from({ length: 200 }, (_, index) => ({
    ...common, kind: "lifecycle", event: index % 2 ? "started" : "stopped",
  }));
  for (const expected of [[health], ordinary]) {
    const { directory, path } = await fixture([]);
    const follower = await createPipelineLogFollower({ directory });
    await appendFile(path, expected.map((record) => `${JSON.stringify(record)}\n`).join(""));
    const actual = await follower.poll();
    assert.deepEqual(actual, expected);
    assert.equal(actual.coverage.status, "complete");
    assert.equal(actual.coverage.malformedRecords, 0);
  }
});

test("follow reports invalid rows as coverage loss while keeping filtering lossless", async () => {
  const { directory, path } = await fixture([]);
  const follower = await createPipelineLogFollower({ directory, stage: "catalog_discovery" });
  const filtered = { ...common, kind: "span", stage: "history_read", domain: "activity",
    startMs: 1, lane: 1, durationMs: 1, outcome: "completed" };
  const valid = { ...common, kind: "lifecycle", event: "started" };
  await appendFile(path, `{not json}\n{}\n${"x".repeat(70 * 1024)}\n${JSON.stringify(valid)}\n`);
  const damaged = await follower.poll();
  assert.deepEqual(damaged, [valid]);
  assert.equal(damaged.coverage.status, "partial");
  assert.equal(damaged.coverage.malformedRecords, 2);
  assert.equal(damaged.coverage.oversizedRecords, 1);
  await appendFile(path, `${JSON.stringify(filtered)}\n`);
  const filteredOnly = await follower.poll();
  assert.deepEqual(filteredOnly, []);
  assert.equal(filteredOnly.coverage.status, "complete");
  assert.equal(filteredOnly.coverage.malformedRecords, 0);
  assert.equal(filteredOnly.coverage.oversizedRecords, 0);
});

test("invalid CLI input emits a fixed sanitized failure", async () => {
  const missing = join(tmpdir(), "pomegr-private-missing-log.jsonl");
  const script = join(process.cwd(), "scripts", "diagnostics-logs.mjs");
  await assert.rejects(execFileAsync(process.execPath, [script, "--input", missing]), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stderr, "[pomegr] Unable to read diagnostics logs.\n");
    assert.doesNotMatch(error.stderr, /private-missing/u);
    return true;
  });
});

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("the diagnostics snapshot is bounded, provider-filterable, and retains failure details", () => {
  const snapshot = createPipelineOperationsSnapshot({
    coordinator: { observers: { claude: { acquisitionFailures: 2, failureDetails: { acquisitionFailures: {
      stage: "acquire_normalize", reason: "EACCES", observedAt: "2026-08-30T12:00:00.000Z",
    } } } } },
    providers: { claude: { observerStartFailures: 1 }, codex: {} },
  });
  const rendered = formatDiagnosticsSnapshot(snapshot);
  assert.match(rendered, /# Pomegr diagnostics snapshot/);
  assert.match(rendered, /## Failures/);
  assert.match(rendered, /claude · acquisitionFailures.*2/);
  assert.match(rendered, /acquire_normalize · EACCES · 2026-08-30T12:00:00\.000Z/);
  assert.match(formatDiagnosticsSnapshot(snapshot, { provider: "codex" }), /\| codex \|/);
  assert.doesNotMatch(formatDiagnosticsSnapshot(snapshot, { provider: "codex" }), /claude|## Failures/);
});

test("diagnostics snapshot options accept only bounded one-shot output modes", () => {
  assert.deepEqual(parseDiagnosticsSnapshotArgs(["--provider", "codex", "--port", "5000", "--json"]), {
    port: 5000, provider: "codex", json: true, help: false,
  });
  assert.equal(parseDiagnosticsSnapshotArgs(["--markdown"]).json, false);
  assert.match(diagnosticsSnapshotHelp(), /npm run diagnostics:snapshot/);
  assert.throws(() => parseDiagnosticsSnapshotArgs(["--provider", "PRIVATE PROVIDER"]), /provider is invalid/);
  assert.throws(() => parseDiagnosticsSnapshotArgs(["--unknown"]), /Unknown/);
});

test("one-shot snapshot consumes only the first bounded feed record", async () => {
  class FakeSocket extends EventEmitter {
    setEncoding() {}
    end() { this.emit("close"); }
    destroy() { this.emit("close"); }
  }
  const socket = new FakeSocket();
  const snapshot = createPipelineOperationsSnapshot({}, "2026-08-29T12:00:00.000Z");
  const pending = runDiagnosticsSnapshot({ port: 4317, json: true }, { connect: () => socket });
  socket.emit("data", `${JSON.stringify(snapshot)}\n${JSON.stringify(snapshot)}\n`);
  const result = await pending;
  assert.deepEqual(JSON.parse(result.output), snapshot);
});

test("snapshot reader consumes a real passive operations transport once", async (t) => {
  const port = await availablePort();
  const snapshot = createPipelineOperationsSnapshot({ providers: { claude: { observerStartFailures: 2 } } });
  const transport = await startPipelineOperationsTransport({ port, snapshot: () => snapshot, intervalMs: 100 });
  t.after(() => transport.close());

  const result = await runDiagnosticsSnapshot({ port, json: true, provider: "" });
  assert.deepEqual(JSON.parse(result.output), snapshot);
  assert.equal(result.snapshot.providers[0].id, snapshot.providers[0].id);
});

test("markdown snapshot output contains no terminal control sequences", () => {
  const output = formatDiagnosticsSnapshot(createPipelineOperationsSnapshot({}));
  assert.doesNotMatch(output, /\u001b/);
  assert.match(output, /## Pipeline timings/);
});
