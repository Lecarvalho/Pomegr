import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMonitorWorker } from "../desktop/monitor-worker.mjs";
import { startShellRuntime } from "../desktop/shell-orchestrator.mjs";
import { waitForMessage } from "../desktop/utility-lifecycle.mjs";
import {
  publishAgentQueryDescriptor,
  readAgentQueryDescriptor,
  resolveAgentQueryDescriptorPath,
} from "../shared/agent-query-transport.mjs";

const TOKEN = "A".repeat(43);
const STOP_OPTIONS = { gracefulTimeoutMs: 100, killTimeoutMs: 5_000 };
const workerSource = `
  const { parentPort, workerData } = require('node:worker_threads');
  const http = require('node:http');
  (async () => {
    const { publishAgentQueryDescriptor } = await import(workerData.transportUrl);
    const server = http.createServer((_request, response) => response.end('{}'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    await publishAgentQueryDescriptor({
      descriptorPath: workerData.agentQueryDescriptorPath,
      token: workerData.agentAuthorizationToken,
      origin,
    });
    parentPort.on('message', message => {
      if (message.type === 'crash') throw new Error('PRIVATE_WORKER_ERROR');
      if (message.type === 'shutdown' && workerData.mode === 'graceful') {
        server.close(() => { parentPort.postMessage({ type: 'stopped' }); process.exit(0); });
      }
    });
    parentPort.postMessage({ type: 'ready', origin });
  })();
`;

async function fixture(t, mode) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-monitor-worker-"));
  const descriptorPath = resolveAgentQueryDescriptorPath(root);
  const child = createMonitorWorker(workerSource, {
    eval: true,
    execArgv: [],
    workerData: {
      mode,
      agentQueryDescriptorPath: descriptorPath,
      agentAuthorizationToken: TOKEN,
      transportUrl: new URL("../shared/agent-query-transport.mjs", import.meta.url).href,
    },
  });
  const errors = [];
  child.on("error", (error) => errors.push(error.message));
  t.after(async () => {
    await child.stop(STOP_OPTIONS);
    await rm(root, { recursive: true, force: true });
  });
  const ready = await waitForMessage(child, "ready", 5_000);
  return { child, descriptorPath, origin: ready.origin, errors };
}

async function assertListenerStopped(origin) {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(new URL(origin).port), "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

for (const mode of ["graceful", "unresponsive"]) {
  test(`desktop ${mode} monitor shutdown awaits parent descriptor cleanup and releases its port`, async (t) => {
    const { child, descriptorPath, origin } = await fixture(t, mode);
    assert.ok(await readAgentQueryDescriptor({ descriptorPath }));
    assert.deepEqual(await child.stop(STOP_OPTIONS), { forced: mode === "unresponsive" });
    assert.equal(child.pid, undefined);
    assert.equal(await readAgentQueryDescriptor({ descriptorPath }), null);
    await assertListenerStopped(origin);
    await child.stop(STOP_OPTIONS);
  });
}

test("unexpected monitor exit cleans discovery before an already-exited child stop completes", async (t) => {
  const { child, descriptorPath, origin, errors } = await fixture(t, "unresponsive");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.send({ type: "crash" });
  await exited;
  await child.stop(STOP_OPTIONS);
  assert.equal(await readAgentQueryDescriptor({ descriptorPath }), null);
  assert.deepEqual(errors, ["DESKTOP_MONITOR_FAILED"]);
  await assertListenerStopped(origin);
});

test("monitor shutdown preserves discovery owned by a replacement launch", async (t) => {
  const { child, descriptorPath, origin } = await fixture(t, "unresponsive");
  const replacement = await publishAgentQueryDescriptor({
    descriptorPath, origin: "http://127.0.0.1:4567", token: "B".repeat(43),
  });
  await child.stop(STOP_OPTIONS);
  assert.deepEqual(await readAgentQueryDescriptor({ descriptorPath }), replacement);
  await assertListenerStopped(origin);
});

test("desktop startup rollback awaits forced monitor and descriptor cleanup", async (t) => {
  const { child, descriptorPath, origin } = await fixture(t, "unresponsive");
  await assert.rejects(startShellRuntime({
    startTimeoutMs: 1_000,
    stopTimeoutMs: 5_000,
    startMonitor: () => child,
    waitForMonitor: async () => ({ origin }),
    startWeb: () => { throw new Error("PRIVATE_STARTUP_ERROR"); },
    stopMonitor: (monitor) => monitor.stop(STOP_OPTIONS),
    stopWeb: async () => {},
  }), { message: "DESKTOP_START_FAILED" });
  assert.equal(child.pid, undefined);
  assert.equal(await readAgentQueryDescriptor({ descriptorPath }), null);
  await assertListenerStopped(origin);
});
