import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDiagnosticsSaveArgs } from "../scripts/diagnostics-save.mjs";
import { runDiagnosticsCapture, validTrace } from "../scripts/diagnostics-capture.mjs";
import { createPipelineTraceRecorder } from "../monitor/pipeline-trace.mjs";
import { startPipelineTraceCaptureTransport } from "../monitor/pipeline-trace-transport.mjs";
import { readDiagnosticMetadata } from "../scripts/diagnostics-metadata.mjs";
import { existsSync } from "node:fs";
import { analyzePerfettoTrace, perfettoPaths } from "../scripts/diagnostics-tools.mjs";

test("save defaults to a unique local historical window and rejects invalid selectors", () => {
  const options = parseDiagnosticsSaveArgs([], { now: () => new Date("2026-09-11T12:00:00.000Z"), nonce: () => "12345678" });
  assert.equal(options.mode, "save");
  assert.equal(options.windowMs, 300_000);
  assert.ok(options.outputPath.endsWith("2026-09-11T12-00-00-000Z-12345678.trace.json"));
  assert.equal(parseDiagnosticsSaveArgs(["--last", "30s", "--session", "codex:one"]).windowMs, 30_000);
  for (const args of [["--last", "6m"], ["--last", "0s"], ["--last"], ["--session", "../private"], ["--output"], ["--duration", "15"]]) {
    assert.throws(() => parseDiagnosticsSaveArgs(args));
  }
});

test("authenticated save exports past events repeatedly without clearing, stopping, or leaking session selection", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-save-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const lease = createServer();
  await new Promise((resolve) => lease.listen(0, "127.0.0.1", resolve));
  const port = lease.address().port;
  await new Promise((resolve) => lease.close(resolve));
  const descriptorPath = path.join(directory, "capability.json");
  let now = 100;
  const recorder = createPipelineTraceRecorder({ rolling: true, now: () => now });
  const selectedScope = recorder.createScope();
  const otherScope = recorder.createScope();
  recorder.recordDuration({ stage: "history_contribution", domain: "activity", durationMs: 0, scope: selectedScope });
  recorder.recordDuration({ stage: "history_read", domain: "activity", durationMs: 0, scope: otherScope });
  recorder.recordCounter({ counter: "active", value: 1 });
  const transport = await startPipelineTraceCaptureTransport({ enabled: true, port, recorder, descriptorPath,
    resolveSessionScope: (key) => key === "codex:PRIVATE_ONE" ? selectedScope : otherScope });
  context.after(() => transport.close());
  const outputPath = path.join(directory, "first.json");
  const options = { ...parseDiagnosticsSaveArgs(["--session", "codex:PRIVATE_ONE"]), port, descriptorPath, outputPath };
  now = 150;
  const first = await runDiagnosticsCapture(options);
  assert.ok(first.eventCount >= 2);
  assert.equal(recorder.isActive(), true);
  const exported = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(validTrace(exported), true);
  assert.equal(exported.metadata.rolling.selection, "session");
  assert.ok(exported.metadata.rolling.matchedEvents >= 1);
  assert.ok(exported.traceEvents.some((event) => event.name === "history_contribution"));
  assert.ok(exported.traceEvents.some((event) => event.name === "active"));
  assert.ok(!exported.traceEvents.some((event) => event.name === "history_read"));
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE|sessionKey|capability/u);
  const metadata = await readDiagnosticMetadata(outputPath, ["history_contribution", "history_read"]);
  assert.equal(metadata.rolling.selection, "session");
  if (existsSync(perfettoPaths().traceProcessor)) {
    const report = await analyzePerfettoTrace(outputPath);
    assert.equal(report.rolling.selection, "session");
    assert.equal(report.coverage.stageCoverage.history_contribution.spans, 1);
    assert.ok(!report.coverage.observedStages.includes("history_read"));
  }
  await assert.rejects(() => runDiagnosticsCapture(options), /CAPTURE_WRITE_FAILED/u);
  assert.equal(await readFile(outputPath, "utf8"), `${JSON.stringify(exported)}\n`);
  now = 175;
  recorder.recordCounter({ counter: "records", value: 2 });
  const second = await runDiagnosticsCapture({ ...options, outputPath: path.join(directory, "second.json") });
  assert.ok(second.eventCount > first.eventCount);
  assert.equal(recorder.isActive(), true);
  const poisoned = structuredClone(exported);
  poisoned.metadata.rolling.sessionKey = "PRIVATE";
  assert.equal(validTrace(poisoned), false);
});

test("save direct callers cannot bypass the retained-window limit", async () => {
  await assert.rejects(() => runDiagnosticsCapture({ ...parseDiagnosticsSaveArgs([]), windowMs: 600_000 }), /CAPTURE_SELECTION_INVALID/u);
});
