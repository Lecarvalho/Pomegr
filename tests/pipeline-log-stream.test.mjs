import assert from "node:assert/strict";
import test from "node:test";
import { createPipelineLogStream } from "../monitor/pipeline-log-stream.mjs";
import { normalizePipelineLogRecord } from "../monitor/pipeline-log-schema.mjs";
import { createPipelineTraceRecorder } from "../monitor/pipeline-trace.mjs";
import { createPipelineOperationsSnapshot } from "../monitor/pipeline-operations.mjs";

const run = "00000000-0000-4000-8000-000000000001";
const at = "2026-09-11T00:00:00.000Z";

test("continuous logs expose starts immediately and retain events beyond an in-memory capture window", () => {
  const rows = [];
  const writer = { write(row) { rows.push(row); return true; }, stats: () => ({}) };
  const stream = createPipelineLogStream({ writer, run, now: () => at });
  let time = 0;
  const recorder = createPipelineTraceRecorder({ rolling: true, retainEvents: false, onEvent: stream.event, now: () => time });
  const scope = recorder.createScope();
  const span = recorder.begin({ stage: "history_read", domain: "activity", scope });
  assert.equal(rows[0].kind, "span_start");
  time = 125;
  recorder.end(span, { outcome: "completed" });
  assert.equal(rows[1].durationMs, 125);
  assert.equal(rows[1].scope, rows[0].scope);
  time = 600_000;
  recorder.recordCounter({ counter: "records", value: 2 });
  assert.equal(rows.length, 3);
  assert.equal(rows[2].kind, "counter");
  assert.equal(recorder.snapshot().traceEvents.length, 0, "file logging needs no retained capture");
  assert.ok(rows.every(normalizePipelineLogRecord));
});

test("file records reject arbitrary fields and strip private metadata from health and event inputs", () => {
  const rows = [];
  const stream = createPipelineLogStream({ writer: { write(row) { rows.push(row); return true; }, stats: () => ({}) }, run, now: () => at });
  assert.equal(stream.record({ kind: "lifecycle", event: "started", secret: "PRIVATE_SECRET" }), false);
  assert.equal(stream.event({ ph: "X", name: "PRIVATE_TEXT", cat: "activity", ts: 0, dur: 1_000, tid: 1, args: { outcome: "completed" } }), false);
  stream.event({ ph: "X", name: "history_read", cat: "activity", ts: 0, dur: 1_000, tid: 1,
    privatePath: "PRIVATE_PATH", args: { outcome: "completed", secret: "PRIVATE_SECRET" } });
  const snapshot = createPipelineOperationsSnapshot({});
  stream.record({ kind: "health", snapshot: { ...snapshot, privateSession: "PRIVATE_SESSION" } });
  assert.equal(rows.length, 2);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|privatePath|privateSession|secret/u);
});

test("writer backpressure is reported once after capacity returns and sink failure cannot escape instrumentation", () => {
  const rows = [];
  const writer = { write(row) { rows.push(row); return true; }, stats: () => ({ droppedRecords: 3, rejectedRecords: 2 }) };
  const stream = createPipelineLogStream({ writer, run, now: () => at });
  stream.reportLoss(); stream.reportLoss();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "gap");
  assert.equal(rows[0].droppedRecords, 3);
  const recorder = createPipelineTraceRecorder({ enabled: true, onEvent() { throw new Error("PRIVATE_ERROR"); } });
  assert.doesNotThrow(() => recorder.recordCounter({ counter: "records", value: 1 }));
});
