import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPipelineTraceRecorder } from "../monitor/pipeline-trace.mjs";
import { validTrace } from "../scripts/diagnostics-capture.mjs";
import {
  pipelineTraceCaptureDescriptor,
  startPipelineTraceCaptureTransport,
} from "../monitor/pipeline-trace-transport.mjs";

test("the trace recorder is disabled by default and only accepts fixed trace vocabulary", () => {
  let now = 10;
  const recorder = createPipelineTraceRecorder({ now: () => now });
  assert.equal(recorder.begin({ stage: "catalog_discovery", domain: "acquisition" }), null);
  assert.equal(recorder.recordDuration({ stage: "PRIVATE_STAGE", domain: "PRIVATE_DOMAIN", durationMs: 7 }), false);
  assert.deepEqual(recorder.snapshot().traceEvents, []);

  recorder.activate();
  now = 17;
  assert.equal(recorder.recordDuration({
    stage: "catalog_discovery", domain: "acquisition", durationMs: 7, outcome: "PRIVATE_OUTCOME",
  }), true);
  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.traceEvents[0], {
    name: "catalog_discovery", cat: "acquisition", ph: "X", ts: 0, dur: 7_000, pid: 1, tid: 1,
    args: { outcome: "observed" },
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|prompt|response|command|credential|transcript|path|native/i);
});

test("the trace recorder bounds events and local handles while retaining overlapping lanes", () => {
  let now = 10;
  const recorder = createPipelineTraceRecorder({ enabled: true, now: () => now, maxEvents: 8, maxOpenSpans: 2, maxHandles: 2 });
  const flow = recorder.createFlow();
  const revision = recorder.createRevision();
  assert.ok(flow);
  assert.ok(revision);
  assert.equal(recorder.createFlow(), null);
  const first = recorder.begin({ stage: "source_queue", domain: "acquisition", lane: 2, flow, revision });
  const second = recorder.begin({ stage: "session_derivation", domain: "derivation", lane: 3, flow, revision });
  assert.equal(recorder.begin({ stage: "catalog_projection", domain: "commit" }), null);
  now = 15;
  assert.equal(recorder.end(second, { outcome: "completed" }), true);
  now = 20;
  assert.equal(recorder.end(first, { outcome: "failed" }), true);
  assert.equal(recorder.recordDuration({ stage: "catalog_projection", domain: "commit", durationMs: 1 }), true);
  const snapshot = recorder.snapshot();
  const slices = snapshot.traceEvents.filter((event) => event.ph === "X");
  assert.deepEqual(slices.map((event) => event.tid), [2, 1, 2]);
  assert.deepEqual(slices.slice(0, 2).map((event) => event.args), [
    { outcome: "completed", revision: 1 },
    { outcome: "failed", revision: 1 },
  ]);
  assert.equal(snapshot.metadata.capture.droppedSpans, 1);
  assert.equal(snapshot.metadata.capture.droppedHandles, 1);
  assert.deepEqual(snapshot.metadata.coverage.observedStages, ["catalog_projection", "session_derivation", "source_queue"]);
});

test("retroactive durations clip at capture start and disclose incomplete coverage", () => {
  let now = 100;
  const recorder = createPipelineTraceRecorder({ enabled: true, now: () => now });
  now = 105;
  assert.equal(recorder.recordDuration({ stage: "history_read", domain: "activity", durationMs: 10, outcome: "accepted", startedAt: 95 }), true);
  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.traceEvents[0], {
    name: "history_read", cat: "activity", ph: "X", ts: 0, dur: 5_000, pid: 1, tid: 1,
    args: { outcome: "incomplete" },
  });
  assert.equal(snapshot.metadata.capture.incomplete, true);
});

test("deactivation marks unfinished spans incomplete", () => {
  let now = 100;
  const recorder = createPipelineTraceRecorder({ enabled: true, now: () => now });
  recorder.begin({ stage: "session_commit_wait", domain: "commit" });
  now = 125;
  recorder.deactivate();
  assert.deepEqual(recorder.snapshot().traceEvents[0].args, { outcome: "incomplete" });
  assert.equal(recorder.snapshot().metadata.capture.incomplete, true);
});

test("flows use Chrome Trace s/t/f events and capture epochs reject old handles", () => {
  let now = 1;
  const recorder = createPipelineTraceRecorder({ enabled: true, now: () => now });
  const flow = recorder.createFlow();
  const revision = recorder.createRevision();
  const span = recorder.begin({ stage: "history_publish", domain: "activity", flow, revision });
  now = 3;
  recorder.end(span, { outcome: "accepted" });
  now = 4;
  assert.equal(recorder.finishFlow(flow), true);
  const flowEvents = recorder.snapshot().traceEvents.filter((event) => event.ph !== "X");
  assert.deepEqual(flowEvents.map((event) => event.ph), ["s", "t", "f"]);
  assert.ok(flowEvents.every((event) => event.name === "pipeline_flow" && event.cat === "runtime" && event.tid === 1));
  recorder.activate();
  now = 5;
  assert.equal(recorder.recordDuration({ stage: "history_publish", domain: "activity", durationMs: 1, flow, revision }), true);
  assert.deepEqual(recorder.snapshot().traceEvents[0].args, { outcome: "observed" });
});

test("fixed counters and configured coverage reject arbitrary names", () => {
  const recorder = createPipelineTraceRecorder({ enabled: true, stages: ["history_read", "PRIVATE"] });
  assert.equal(recorder.recordCounter({ counter: "memory", value: 10 }), true);
  assert.equal(recorder.recordCounter({ counter: "PRIVATE", value: 10 }), false);
  assert.equal(recorder.recordDuration({ stage: "history_read", domain: "activity", durationMs: 2 }), true);
  assert.equal(recorder.recordDuration({ stage: "history_publish", domain: "activity", durationMs: 2 }), false);
  assert.deepEqual(recorder.snapshot().metadata.coverage, {
    enabledStages: ["history_read"], observedStages: ["history_read"],
  });
});

test("rolling recorders evict expired evidence and keep the actual five-minute-style window", () => {
  let now = 0;
  const recorder = createPipelineTraceRecorder({ rolling: true, retentionMs: 100, now: () => now });
  assert.equal(recorder.isActive(), true);
  assert.equal(recorder.isRolling(), true);
  now = 10;
  recorder.recordCounter({ counter: "active", value: 1 });
  now = 60;
  recorder.recordCounter({ counter: "active", value: 2 });
  now = 120;
  recorder.recordCounter({ counter: "active", value: 3 });
  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.traceEvents.map((event) => event.args.value), [2, 3]);
  assert.deepEqual(snapshot.metadata.rolling, {
    retentionMs: 100, windowStartMs: 20, windowEndMs: 120, retainedMs: 100,
    evictedEvents: 1, capacityLimited: false, selection: "all", matchedEvents: 0,
  });
  assert.equal(recorder.isActive(), true);
});

test("rolling snapshots are nonmutating, clip a selected window, and continue recording", () => {
  let now = 0;
  const recorder = createPipelineTraceRecorder({ rolling: true, retentionMs: 100, now: () => now });
  now = 50;
  const span = recorder.begin({ stage: "history_read", domain: "activity" });
  now = 110;
  const clipped = recorder.snapshot({ windowMs: 40 });
  assert.equal(clipped.metadata.capture.openSpanCount, 1);
  assert.equal(clipped.metadata.capture.active, false);
  assert.equal(clipped.metadata.capture.incomplete, true);
  assert.equal(clipped.traceEvents[0].args.outcome, "incomplete");
  assert.equal(clipped.metadata.rolling.windowStartMs, 70);
  assert.equal(recorder.isActive(), true);
  now = 115;
  assert.equal(recorder.end(span, { outcome: "accepted" }), true);
  const next = recorder.snapshot({ windowMs: 40 });
  assert.equal(next.metadata.capture.openSpanCount, 0);
  assert.equal(next.traceEvents.find((event) => event.ph === "X").args.outcome, "incomplete");
  now = 116;
  assert.equal(recorder.recordCounter({ counter: "active", value: 3 }), true);
  assert.equal(recorder.snapshot().traceEvents.at(-1).args.value, 3);
});

test("rolling capacity evicts oldest events and releases expired handle slots", () => {
  let now = 0;
  const recorder = createPipelineTraceRecorder({ rolling: true, retentionMs: 100, maxEvents: 2, maxHandles: 2, now: () => now });
  recorder.recordCounter({ counter: "active", value: 1 });
  now = 1;
  recorder.recordCounter({ counter: "active", value: 2 });
  now = 2;
  recorder.recordCounter({ counter: "active", value: 3 });
  const capped = recorder.snapshot();
  assert.deepEqual(capped.traceEvents.map((event) => event.args.value), [2, 3]);
  assert.deepEqual(capped.metadata.rolling, {
    retentionMs: 100, windowStartMs: 1, windowEndMs: 2, retainedMs: 1,
    evictedEvents: 1, capacityLimited: true, selection: "all", matchedEvents: 0,
  });
  const first = recorder.createRevision();
  const second = recorder.createRevision();
  assert.ok(first);
  assert.ok(second);
  assert.equal(recorder.createRevision(), null);
  now = 103;
  assert.ok(recorder.createRevision());
});

test("fractional rolling capacity metadata stays integer-valid without exposing scope identity", () => {
  let now = 0.123;
  const recorder = createPipelineTraceRecorder({ rolling: true, retentionMs: 100, maxEvents: 2, now: () => now });
  const scope = recorder.createScope();
  now = 1.123;
  recorder.recordDuration({ stage: "history_read", domain: "activity", durationMs: 0.001, scope });
  now = 2.246;
  recorder.recordDuration({ stage: "history_publish", domain: "activity", durationMs: 0.001, scope });
  now = 3.579;
  recorder.recordCounter({ counter: "active", value: 1 });
  const snapshot = recorder.snapshot({ scope });
  assert.ok(Number.isSafeInteger(snapshot.metadata.rolling.windowStartMs));
  assert.ok(Number.isSafeInteger(snapshot.metadata.rolling.windowEndMs));
  assert.ok(Number.isSafeInteger(snapshot.metadata.rolling.retainedMs));
  assert.equal(snapshot.metadata.rolling.capacityLimited, true);
  assert.equal(validTrace(snapshot), true);
  assert.doesNotMatch(JSON.stringify(snapshot), /scope|PRIVATE|raw-session-id/i);
});

test("rolling exports derive renderer coverage from the selected window only", () => {
  let now = 0;
  const recorder = createPipelineTraceRecorder({ rolling: true, retentionMs: 100, now: () => now });
  now = 10;
  recorder.recordDuration({ stage: "renderer_fetch", domain: "presentation", durationMs: 1,
    clock: "request_interval_bound", clockErrorUs: 1_000, surface: "catalog" });
  assert.deepEqual(recorder.snapshot().metadata.rendererClock, {
    status: "bounded", calibratedSpans: 1, rejectedCalibrations: 0, maxErrorUs: 1_000,
  });
  now = 120;
  recorder.recordCounter({ counter: "active", value: 1 });
  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.metadata.rendererClock, {
    status: "unavailable", calibratedSpans: 0, rejectedCalibrations: 0, maxErrorUs: 0,
  });
  assert.ok(!snapshot.metadata.coverage.observedStages.includes("renderer_fetch"));
});

test("rolling scope selection stays monitor-private and keeps unscoped shared evidence", () => {
  let now = 0;
  const recorder = createPipelineTraceRecorder({ rolling: true, retentionMs: 100, now: () => now });
  const selectedScope = recorder.createScope();
  const otherScope = recorder.createScope();
  const flow = recorder.createFlow({ scope: selectedScope });
  now = 1;
  recorder.recordDuration({ stage: "history_read", domain: "activity", durationMs: 1, flow });
  now = 2;
  recorder.recordDuration({ stage: "history_publish", domain: "activity", durationMs: 1, scope: otherScope });
  now = 3;
  recorder.recordCounter({ counter: "active", value: 1 });
  const snapshot = recorder.snapshot({ scope: selectedScope });
  assert.equal(snapshot.metadata.rolling.selection, "session");
  assert.ok(snapshot.metadata.rolling.matchedEvents > 0);
  assert.ok(snapshot.traceEvents.some((event) => event.name === "history_read"));
  assert.ok(snapshot.traceEvents.some((event) => event.name === "active"));
  assert.ok(!snapshot.traceEvents.some((event) => event.name === "history_publish"));
  assert.doesNotMatch(JSON.stringify(snapshot), /raw-session-id|prompt|response|command|credential|transcript|path/i);
  assert.equal(recorder.snapshot({ scope: "raw-session-id" }).traceEvents.length, 0);
});


test("the disabled transport creates no listener or descriptor", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-trace-disabled-"));
  const descriptorPath = path.join(directory, "private.json");
  const result = await startPipelineTraceCaptureTransport({
    enabled: false,
    recorder: createPipelineTraceRecorder(),
    descriptorPath,
  });
  assert.equal(result, null);
  await assert.rejects(readFile(descriptorPath, "utf8"), { code: "ENOENT" });
  await rm(directory, { recursive: true, force: true });
});

test("an authenticated local capture emits a bounded trace and removes its private descriptor", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-trace-capture-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\pomegr-trace-test-${process.pid}-${Date.now()}`
    : path.join(directory, "capture.sock");
  const descriptorPath = path.join(directory, "private.json");
  const recorder = createPipelineTraceRecorder();
  const transport = await startPipelineTraceCaptureTransport({
    enabled: true, port: 4317, endpoint, descriptorPath, recorder, token: "x".repeat(48), captureDurationMs: 1_000,
  });
  context.after(() => transport.close());
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  assert.equal(descriptor.endpoint, endpoint);
  assert.equal(descriptor.token, "x".repeat(48));
  const socket = createConnection(endpoint);
  context.after(() => socket.destroy());
  let received = "";
  socket.setEncoding("utf8");
  socket.write(`${JSON.stringify({ type: "authenticate", token: descriptor.token })}\n`);
  await once(socket, "data");
  recorder.recordDuration({ stage: "catalog_projection", domain: "commit", durationMs: 4 });
  socket.write('{"type":"complete"}\n');
  socket.on("data", (chunk) => { received += chunk; });
  await once(socket, "close");
  const trace = JSON.parse(received.replace('{"type":"capturing"}\n', ""));
  assert.equal(trace.traceEvents[0].name, "catalog_projection");
  assert.doesNotMatch(JSON.stringify(trace), /token|prompt|response|command|credential|transcript|path/i);
  await transport.close();
  await assert.rejects(readFile(descriptorPath, "utf8"), { code: "ENOENT" });
});

test("the capture transport rejects bad authentication and closes an abandoned capture as incomplete", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-trace-disconnect-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\pomegr-trace-disconnect-${process.pid}-${Date.now()}`
    : path.join(directory, "capture.sock");
  const recorder = createPipelineTraceRecorder();
  const transport = await startPipelineTraceCaptureTransport({
    enabled: true, port: 4317, endpoint, descriptorPath: path.join(directory, "private.json"), recorder, token: "y".repeat(48),
  });
  context.after(() => transport.close());
  const rejected = createConnection(endpoint);
  rejected.on("error", () => {});
  rejected.write('{"type":"authenticate","token":"wrong"}\n');
  await once(rejected, "close");
  assert.equal(recorder.isActive(), false);

  const socket = createConnection(endpoint);
  socket.setEncoding("utf8");
  socket.write(`${JSON.stringify({ type: "authenticate", token: "y".repeat(48) })}\n`);
  await once(socket, "data");
  const pending = recorder.begin({ stage: "session_derivation", domain: "derivation" });
  assert.ok(pending);
  socket.destroy();
  await once(socket, "close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recorder.isActive(), false);
  assert.equal(recorder.snapshot().metadata.capture.incomplete, true);
  assert.equal(recorder.snapshot().traceEvents[0].args.outcome, "incomplete");
});

test("the capture descriptor is deterministic in a user-private directory", () => {
  assert.match(
    pipelineTraceCaptureDescriptor(4317, { platform: "linux", temporaryDirectory: "/tmp", userId: "private user" }),
    /^\/tmp\/pomegr-diagnostics-private_user\/pipeline-trace-unix-4317\.json$/,
  );
});

test("capture startup never removes an incumbent endpoint or descriptor", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-trace-collision-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\pomegr-trace-collision-${process.pid}-${Date.now()}`
    : path.join(directory, "capture.sock");
  const descriptorPath = path.join(directory, "private.json");
  const incumbent = createServer((socket) => socket.end("incumbent"));
  incumbent.listen(endpoint);
  await once(incumbent, "listening");
  context.after(() => new Promise((resolve) => incumbent.close(resolve)));
  await assert.rejects(startPipelineTraceCaptureTransport({
    enabled: true, port: 4317, endpoint, descriptorPath, recorder: createPipelineTraceRecorder(), token: "z".repeat(48),
  }), /PIPELINE_TRACE_START_FAILED/);
  await assert.rejects(readFile(descriptorPath, "utf8"), { code: "ENOENT" });
  const client = createConnection(endpoint);
  const [chunk] = await once(client, "data");
  assert.equal(String(chunk), "incumbent");

  const freeEndpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\pomegr-trace-descriptor-${process.pid}-${Date.now()}`
    : path.join(directory, "free.sock");
  await writeFile(descriptorPath, "incumbent descriptor", "utf8");
  await assert.rejects(startPipelineTraceCaptureTransport({
    enabled: true, port: 4317, endpoint: freeEndpoint, descriptorPath, recorder: createPipelineTraceRecorder(), token: "z".repeat(48),
  }), /PIPELINE_TRACE_DESCRIPTOR_FAILED/);
  assert.equal(await readFile(descriptorPath, "utf8"), "incumbent descriptor");
});
