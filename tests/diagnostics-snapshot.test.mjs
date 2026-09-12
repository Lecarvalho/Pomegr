import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { createPipelineOperationsSnapshot } from "../monitor/pipeline-operations.mjs";
import { startPipelineOperationsTransport } from "../monitor/pipeline-operations-transport.mjs";
import {
  diagnosticsSnapshotHelp,
  formatDiagnosticsSnapshot,
  parseDiagnosticsSnapshotArgs,
  runDiagnosticsSnapshot,
} from "../scripts/diagnostics-snapshot.mjs";

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
