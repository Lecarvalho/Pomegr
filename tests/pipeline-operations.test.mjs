import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startMonitorServer } from "../monitor/server.mjs";
import {
  createDurationSeries,
  createPipelineOperationsSnapshot,
  normalizePipelineOperationsSnapshot,
  PIPELINE_OPERATIONS_VERSION,
} from "../monitor/pipeline-operations.mjs";
import {
  pipelineOperationsEndpoint,
  startPipelineOperationsTransport,
} from "../monitor/pipeline-operations-transport.mjs";
import {
  formatPipelineOperationsSnapshot,
  parsePipelineOperationsArgs,
  pipelineOperationsHelp,
  runPipelineOperationsCli,
} from "../scripts/pipeline-ops.mjs";

async function availablePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

test("bounded duration windows report operational percentiles without retaining identities", () => {
  const series = createDurationSeries({ windowSize: 4 });
  for (const value of [1, 5, 10, 50, 100]) series.record(value);
  series.record(-20);
  const snapshot = series.snapshot();

  assert.deepEqual(snapshot, {
    sampleCount: 6,
    windowCount: 4,
    lastMs: 0,
    averageMs: 40,
    p50Ms: 10,
    p95Ms: 100,
    maxMs: 100,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /session|path|prompt|provider/i);
});

test("pipeline operations snapshots expose only the fixed aggregate schema", () => {
  const timing = { sampleCount: 2, windowCount: 2, lastMs: 7, averageMs: 5, p50Ms: 3, p95Ms: 7, maxMs: 7, private: "PRIVATE_MUST_NOT_LEAK" };
  const snapshot = createPipelineOperationsSnapshot({
    coordinator: {
      sessionCandidates: 4,
      sessionCommits: 3,
      rejectedCandidates: 1,
      catalogStructuralFastPaths: 2,
      transcriptPath: "C:\\PRIVATE_TRANSCRIPT_MUST_NOT_LEAK",
      timings: {
        catalogCommitWait: timing,
        catalogProjectionCommit: timing,
        sessionCommitWait: timing,
        sessionDerivation: timing,
        sessionStoreCommit: timing,
        sessionCandidateToCommit: timing,
      },
      observers: {
        codex: {
          hydrationConcurrency: 2,
          activeHydrations: 1,
          pendingHydrations: 3,
          hydrationAttempts: 8,
          prompt: "PROMPT_MUST_NOT_LEAK",
          timings: {
            catalogDiscovery: timing,
            queueWait: timing,
            preparation: timing,
            acquisitionNormalization: timing,
          },
        },
        "INVALID PROVIDER": { private: true },
      },
    },
    providers: {
      codex: { observerHydrationFailures: 1, rawError: "RAW_ERROR_MUST_NOT_LEAK" },
    },
    responseRevisions: { catalog: 12, home: 4, usageLimits: 2, private: 999 },
  }, "2026-08-29T12:00:00.000Z");

  assert.equal(snapshot.version, PIPELINE_OPERATIONS_VERSION);
  assert.equal(snapshot.providers.length, 1);
  assert.equal(snapshot.providers[0].id, "codex");
  assert.equal(snapshot.providers[0].workers.pending, 3);
  assert.equal(snapshot.providers[0].timings.queueWait.p95Ms, 7);
  assert.deepEqual(snapshot.revisions, { catalog: 12, home: 4, usageLimits: 2 });
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|PROMPT|RAW_ERROR|transcriptPath|rawError/i);

  const revalidated = normalizePipelineOperationsSnapshot({
    ...snapshot,
    private: "PRIVATE_MUST_NOT_LEAK",
    providers: snapshot.providers.map((provider) => ({ ...provider, raw: "RAW_MUST_NOT_LEAK" })),
  });
  assert.doesNotMatch(JSON.stringify(revalidated), /PRIVATE|RAW_MUST_NOT_LEAK/);
});

test("the operations transport streams bounded NDJSON over local IPC and closes cleanly", async (context) => {
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\pomegr-pipeline-test-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `pomegr-pipeline-test-${process.pid}-${Date.now()}.sock`);
  const expected = createPipelineOperationsSnapshot({}, "2026-08-29T12:00:00.000Z");
  const transport = await startPipelineOperationsTransport({
    port: 4317,
    endpoint,
    snapshot: () => expected,
    intervalMs: 100,
  });
  context.after(() => transport.close());

  const socket = createConnection(transport.endpoint);
  context.after(() => socket.destroy());
  const [chunk] = await once(socket, "data");
  const received = JSON.parse(String(chunk).split("\n")[0]);

  assert.deepEqual(received, expected);
  assert.doesNotMatch(JSON.stringify(received), /prompt|response|command|credential|transcript/i);
});

test("the operations transport bounds clients and refuses to delete a regular Unix-path collision", async (context) => {
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\pomegr-pipeline-limit-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `pomegr-pipeline-limit-${process.pid}-${Date.now()}.sock`);
  const transport = await startPipelineOperationsTransport({
    port: 4317,
    endpoint,
    snapshot: () => createPipelineOperationsSnapshot({}),
    intervalMs: 100,
    maxClients: 1,
  });
  context.after(() => transport.close());
  const first = createConnection(endpoint);
  context.after(() => first.destroy());
  await once(first, "data");
  const excess = createConnection(endpoint);
  excess.on("error", () => {});
  await once(excess, "close");

  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-pipeline-collision-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const collision = path.join(directory, "pipeline.sock");
  await writeFile(collision, "DO_NOT_DELETE", "utf8");
  await assert.rejects(
    startPipelineOperationsTransport({
      port: 4317,
      endpoint: collision,
      platform: "linux",
      snapshot: () => createPipelineOperationsSnapshot({}),
    }),
    /ENDPOINT_COLLISION/,
  );
  assert.equal(await readFile(collision, "utf8"), "DO_NOT_DELETE");
});

test("the operations transport fails closed when Unix socket permissions cannot be hardened", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-pipeline-permissions-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const endpoint = path.join(directory, "pipeline.sock");
  const fakeServer = new EventEmitter();
  fakeServer.listen = () => queueMicrotask(() => fakeServer.emit("listening"));
  fakeServer.unref = () => {};
  fakeServer.close = (callback) => queueMicrotask(callback);

  await assert.rejects(
    startPipelineOperationsTransport({
      port: 4317,
      endpoint,
      platform: "linux",
      snapshot: () => createPipelineOperationsSnapshot({}),
      serverFactory: () => fakeServer,
      chmodSocket: async () => { throw new Error("simulated permission failure"); },
    }),
    /PERMISSION_FAILED/,
  );
  await assert.rejects(lstat(endpoint), { code: "ENOENT" });
});

test("a concrete-port monitor owns and closes the operations transport lifecycle", async (context) => {
  const port = await availablePort();
  let diagnosticReads = 0;
  const monitor = await startMonitorServer({
    port,
    runtime: {
      observationDiagnostics() { diagnosticReads += 1; return {}; },
      async startObservation() {},
      async stopObservation() {},
    },
    providerRegistry: { async watchTargets() {} },
    logger: { log() {}, warn() {} },
  });
  context.after(() => monitor.close());
  assert.equal(monitor.operationsEndpoint, pipelineOperationsEndpoint(port));
  const socket = createConnection(monitor.operationsEndpoint);
  context.after(() => socket.destroy());
  const [chunk] = await once(socket, "data");
  assert.equal(JSON.parse(String(chunk).split("\n")[0]).version, PIPELINE_OPERATIONS_VERSION);
  assert.equal(diagnosticReads, 1);
});

test("pipeline endpoint names are deterministic per concrete monitor port", () => {
  assert.equal(
    pipelineOperationsEndpoint(4317, { platform: "win32" }),
    "\\\\.\\pipe\\pomegr-pipeline-4317",
  );
  assert.match(
    pipelineOperationsEndpoint(4317, { platform: "linux", temporaryDirectory: "/tmp", userId: 42 }),
    /pomegr-pipeline-42-4317\.sock$/,
  );
  assert.throws(() => pipelineOperationsEndpoint(0), /concrete monitor port/);
});

test("the terminal formatter and options stay bounded and provider-filterable", () => {
  const snapshot = createPipelineOperationsSnapshot({
    coordinator: {
      observers: {
        claude: { hydrationConcurrency: 2, activeHydrations: 1, pendingHydrations: 0 },
        codex: { hydrationConcurrency: 2, activeHydrations: 2, pendingHydrations: 1 },
      },
    },
    providers: { claude: {}, codex: {} },
    responseRevisions: { catalog: 3, home: 2, usageLimits: 1 },
  }, "2026-08-29T12:00:00.000Z");
  const rendered = formatPipelineOperationsSnapshot(snapshot, { provider: "codex" });

  assert.match(rendered, /Pomegr pipeline operations/);
  assert.match(rendered, /codex\s+2\s+2\s+1/);
  assert.doesNotMatch(rendered, /claude/);
  assert.match(rendered, /acquire \+ normalize/);
  assert.match(pipelineOperationsHelp(), /npm run ops:pipeline/);
  assert.deepEqual(parsePipelineOperationsArgs(["--provider", "codex", "--port", "5000", "--json", "--once"]), {
    port: 5000,
    provider: "codex",
    json: true,
    once: true,
    help: false,
  });
  assert.throws(() => parsePipelineOperationsArgs(["--provider", "PRIVATE PROVIDER"]), /provider is invalid/);
  assert.throws(() => parsePipelineOperationsArgs(["--unknown"]), /Unknown/);
});

test("the continuous CLI reconnects and once mode consumes only one buffered snapshot", async (context) => {
  const port = await availablePort();
  let resolveOutput;
  const output = new Promise((resolve) => { resolveOutput = resolve; });
  const cli = runPipelineOperationsCli({ port, provider: "", json: true, once: false }, {
    stdout: { isTTY: false, write(value) { resolveOutput(value); } },
    stderr: { write() {} },
    schedule(task) { return setTimeout(task, 10); },
  });
  context.after(() => cli.close());
  await new Promise((resolve) => setTimeout(resolve, 25));
  const transport = await startPipelineOperationsTransport({
    port,
    snapshot: () => createPipelineOperationsSnapshot({}, "2026-08-29T12:00:00.000Z"),
    intervalMs: 100,
  });
  context.after(() => transport.close());
  assert.match(await output, /"version":1/);

  class FakeSocket extends EventEmitter {
    setEncoding() {}
    end() { this.emit("close"); }
    destroy() { this.emit("close"); }
  }
  const socket = new FakeSocket();
  const writes = [];
  runPipelineOperationsCli({ port, provider: "", json: true, once: true }, {
    connect: () => socket,
    stdout: { isTTY: false, write(value) { writes.push(value); } },
    stderr: { write() {} },
  });
  const line = JSON.stringify(createPipelineOperationsSnapshot({}));
  socket.emit("data", `${line}\n${line}\n`);
  assert.equal(writes.length, 1);
});
