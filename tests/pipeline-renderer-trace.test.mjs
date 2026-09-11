import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createPipelineRendererTraceBridge } from "../monitor/pipeline-renderer-trace.mjs";
import { createPipelineTraceRecorder } from "../monitor/pipeline-trace.mjs";
import { createRequestHandler } from "../monitor/request-handler.mjs";
import { normalizeRendererTracePayload } from "../shared/renderer-trace-contract.mjs";

async function origin(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("renderer payloads contain only fixed request-interval timing records", () => {
  assert.deepEqual(normalizeRendererTracePayload({ calibration: { requestStartedMs: 10, responseReceivedMs: 20 }, records: [{
    stage: "renderer_fetch", domain: "activity", token: "r0123456789abcdef_2", durationMs: 8.4, startedAtMs: 11, endedAtMs: 19.4,
  }] }), { calibration: { requestStartedMs: 10, responseReceivedMs: 20 }, records: [{
    stage: "renderer_fetch", domain: "activity", token: "r0123456789abcdef_2", durationMs: 8, startedAtMs: 11, endedAtMs: 19.4,
  }] });
  for (const payload of [
    { records: [{ stage: "renderer_fetch", domain: "activity", token: "r0123456789abcdef_1", durationMs: 1, startedAtMs: 1, endedAtMs: 2 }] },
    { calibration: { requestStartedMs: 10, responseReceivedMs: 5 }, records: [] },
    { calibration: { requestStartedMs: 0, responseReceivedMs: 2_000 }, records: [] },
    { calibration: { requestStartedMs: 0, responseReceivedMs: 2 }, records: [{ stage: "PRIVATE", domain: "activity", token: "r0123456789abcdef_1", durationMs: 1, startedAtMs: 1, endedAtMs: 2 }] },
    { calibration: { requestStartedMs: 0, responseReceivedMs: 2 }, records: [{ stage: "renderer_fetch", domain: "activity", token: "claude:private", durationMs: 1, startedAtMs: 1, endedAtMs: 2 }] },
    { calibration: { requestStartedMs: 0, responseReceivedMs: 2 }, records: [{ stage: "renderer_fetch", domain: "activity", token: "r0123456789abcdef_1", durationMs: 1, startedAtMs: 1, endedAtMs: 2, url: "PRIVATE" }] },
    { calibration: { requestStartedMs: 0, responseReceivedMs: 2 }, records: [{ stage: "calibration", domain: "activity", token: "r0123456789abcdef_1", durationMs: 1, startedAtMs: 1, endedAtMs: 2 }] },
  ]) assert.equal(normalizeRendererTracePayload(payload), null);
});

test("the bridge only accepts currently minted capture-local tokens", () => {
  const recorder = createPipelineTraceRecorder({ enabled: true, stages: ["renderer_fetch"] });
  const bridge = createPipelineRendererTraceBridge({ recorder, nonce: "0123456789abcdef" });
  const token = bridge.issueRevision("activity");
  assert.equal(token, "r0123456789abcdef_1");
  const payload = (value) => ({ calibration: { requestStartedMs: 10, responseReceivedMs: 12 }, records: [{ stage: "renderer_fetch", domain: "activity", token: value, durationMs: 3, startedAtMs: 10, endedAtMs: 13 }] });
  assert.equal(bridge.record(payload(token)), true);
  assert.equal(bridge.record(payload("r0123456789abcdef_2")), false);
  assert.doesNotMatch(JSON.stringify(recorder.snapshot()), /token|session|PRIVATE|claude/i);
  recorder.deactivate();
  recorder.activate();
  assert.equal(bridge.record(payload(token)), false);
  const nextToken = bridge.issueRevision("activity");
  assert.notEqual(nextToken, token);
  assert.equal(bridge.record(payload(token)), false);
  const newRecorder = createPipelineTraceRecorder({ enabled: true, stages: ["renderer_fetch"] });
  const newBridge = createPipelineRendererTraceBridge({ recorder: newRecorder, nonce: "fedcba9876543210" });
  assert.notEqual(newBridge.issueRevision("activity"), token);
  assert.equal(newBridge.record(payload(token)), false);
});

test("the bridge records a bounded request-interval clock and drops pre-capture renderer spans", () => {
  let now = 1_000;
  const recorder = createPipelineTraceRecorder({ enabled: true, now: () => now, stages: ["cache_serve", "renderer_event", "renderer_fetch"] });
  const bridge = createPipelineRendererTraceBridge({ recorder, nonce: "0123456789abcdef" });
  const token = bridge.issueRevision("activity");
  now = 1_040;
  assert.equal(bridge.record({ calibration: { requestStartedMs: 100, responseReceivedMs: 120 }, records: [{
    stage: "renderer_event", domain: "activity", token, durationMs: 10, startedAtMs: 130, endedAtMs: 140,
  }] }), true);
  const snapshot = recorder.snapshot();
  const renderer = snapshot.traceEvents.find((event) => event.name === "renderer_event");
  assert.deepEqual(renderer?.args, { outcome: "observed", revision: 1, clock: "request_interval_bound", clockErrorUs: 11_000, surface: "activity" });
  assert.equal(renderer?.ts, 20_000);
  assert.equal(snapshot.metadata.provenance.clockQuality, "backend_monotonic_renderer_interval_bound");
  assert.deepEqual(snapshot.metadata.rendererClock, { status: "bounded", calibratedSpans: 1, rejectedCalibrations: 0, maxErrorUs: 11_000 });
  assert.doesNotMatch(JSON.stringify(snapshot), /startedAtMs|endedAtMs|requestStartedMs|responseReceivedMs|r0123456789abcdef/u);
  assert.equal(bridge.record({ calibration: { requestStartedMs: 100, responseReceivedMs: 120 }, records: [{
    stage: "renderer_fetch", domain: "activity", token, durationMs: 10, startedAtMs: 80, endedAtMs: 90,
  }] }), false);
  assert.equal(recorder.snapshot().metadata.capture.incomplete, true);
  assert.equal(recorder.snapshot().metadata.capture.droppedSpans, 1);
  assert.equal(bridge.record({ records: [] }), false);
  assert.equal(recorder.snapshot().metadata.rendererClock.rejectedCalibrations, 1);
});

test("the bridge rejects a renderer end that remains in the monitor future after its clock bound", () => {
  let now = 1_000;
  const recorder = createPipelineTraceRecorder({ enabled: true, now: () => now, stages: ["cache_serve", "renderer_fetch"] });
  const bridge = createPipelineRendererTraceBridge({ recorder, nonce: "0123456789abcdef" });
  const token = bridge.issueRevision("activity");
  now = 1_005;
  assert.equal(bridge.record({ calibration: { requestStartedMs: 100, responseReceivedMs: 120 }, records: [{
    stage: "renderer_fetch", domain: "activity", token, durationMs: 10, startedAtMs: 130, endedAtMs: 140,
  }] }), false);
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.traceEvents.some((event) => event.name === "renderer_fetch"), false);
  assert.deepEqual(snapshot.metadata.rendererClock, { status: "unavailable", calibratedSpans: 0, rejectedCalibrations: 1, maxErrorUs: 0 });
});

test("renderer clock coverage counts only slices that fit the capture event cap", () => {
  let now = 1_000;
  const recorder = createPipelineTraceRecorder({ enabled: true, now: () => now, maxEvents: 1, stages: ["cache_serve", "renderer_fetch"] });
  const bridge = createPipelineRendererTraceBridge({ recorder, nonce: "0123456789abcdef" });
  const token = bridge.issueRevision("activity");
  now = 1_040;
  assert.equal(bridge.record({ calibration: { requestStartedMs: 100, responseReceivedMs: 120 }, records: [{
    stage: "renderer_fetch", domain: "activity", token, durationMs: 10, startedAtMs: 130, endedAtMs: 140,
  }] }), false);
  assert.deepEqual(recorder.snapshot().metadata.rendererClock, { status: "unavailable", calibratedSpans: 0, rejectedCalibrations: 0, maxErrorUs: 0 });
});

test("the monitor bridge is a local authenticated POST without an activation control", async (context) => {
  const recorder = createPipelineTraceRecorder({ enabled: true, stages: ["renderer_fetch"] });
  const bridge = createPipelineRendererTraceBridge({ recorder, nonce: "0123456789abcdef" });
  const token = bridge.issueRevision("activity");
  const authorization = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const server = http.createServer(createRequestHandler({ runtime: {}, rendererTraceBridge: bridge, authorizationToken: authorization }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = await origin(server);
  const response = await fetch(`${base}/internal/renderer-trace`, {
    method: "POST", body: JSON.stringify({ calibration: { requestStartedMs: 10, responseReceivedMs: 12 }, records: [{ stage: "renderer_fetch", domain: "activity", token, durationMs: 3, startedAtMs: 10, endedAtMs: 13 }] }),
    headers: { "content-type": "application/json", "x-pomegr-desktop-authorization": authorization },
  });
  assert.equal(response.status, 204);
  assert.equal(recorder.snapshot().traceEvents.length, 1);
  assert.equal((await fetch(`${base}/internal/renderer-trace`, { method: "GET" })).status, 404);
  assert.equal((await fetch(`${base}/internal/renderer-trace`, {
    method: "POST", body: "{}", headers: { "content-type": "application/json", Origin: base },
  })).status, 404);
});

test("only a committed history GET mints a renderer revision token", async (context) => {
  const recorder = createPipelineTraceRecorder({ enabled: true, stages: ["renderer_fetch"] });
  const bridge = createPipelineRendererTraceBridge({ recorder, nonce: "0123456789abcdef" });
  let ready = false;
  const runtime = {
    serveSessionHistory: async () => ready
      ? { kind: "activity", status: "ready", revision: "1", total: 0, offset: 0, items: [], linkedCount: 0 }
      : { kind: "activity", status: "loading", revision: "0", total: 0, offset: 0, items: [], linkedCount: 0 },
  };
  const server = http.createServer(createRequestHandler({ runtime, rendererTraceBridge: bridge }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = await origin(server);
  const address = `${base}/api/session-history?sessionId=claude:opaque&kind=activity&scope=all&offset=0&limit=8`;
  assert.equal((await fetch(address)).headers.get("x-pomegr-trace-revision"), null);
  ready = true;
  assert.equal((await fetch(address)).headers.get("x-pomegr-trace-revision"), "r0123456789abcdef_1");
});
