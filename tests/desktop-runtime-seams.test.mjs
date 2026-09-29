import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { startMonitorServer } from "../server/server.mjs";
import { startWebServer } from "../web/server.mjs";

import { createProductionBuildFixture } from "./helpers/production-build.mjs";

const productionBuild = await createProductionBuildFixture();
after(() => productionBuild.close());

const quietLogger = Object.freeze({ log() {} });

// A started monitor with no provider runtime: the seam tests exercise binding and lifecycle,
// never the user's real provider profile, SQLite store, or observation cost.
function idleMonitorOptions(overrides = {}) {
  return {
    port: 0,
    logger: quietLogger,
    pipelineOperations: false,
    runtime: { async startObservation() {}, async stopObservation() {} },
    providerRegistry: { async watchTargets() { return []; } },
    ...overrides,
  };
}

async function assertPortReusable(port) {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}

test("monitor binds a dynamic loopback port and closes idempotently", async () => {
  const handle = await startMonitorServer(idleMonitorOptions({ host: "127.0.0.1" }));
  assert.equal(handle.host, "127.0.0.1");
  assert.ok(handle.port > 0);
  assert.deepEqual(handle.address, { host: "127.0.0.1", port: handle.port });
  assert.equal((await fetch(`${handle.origin}/health`)).status, 204);

  const firstClose = handle.close();
  const secondClose = handle.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  assert.deepEqual(await handle.exit, { code: "MONITOR_CLOSED" });
  await handle.close();
});

test("monitor shutdown stops observation once when the listener also closes", async () => {
  let stops = 0;
  const handle = await startMonitorServer({
    port: 0, logger: quietLogger, pipelineOperations: false,
    runtime: { async startObservation() {}, async stopObservation() { stops += 1; } },
    providerRegistry: { async watchTargets() { return []; } },
    serverFactory: () => http.createServer(),
  });
  await handle.close();
  assert.equal(stops, 1);
  await handle.close();
  assert.equal(stops, 1);
});

test("monitor rejects non-loopback binding and reports bounded startup failures", async () => {
  await assert.rejects(
    startMonitorServer({ port: 0, host: "0.0.0.0" }),
    (error) => error.code === "MONITOR_INVALID_HOST" && error.message === "MONITOR_INVALID_HOST",
  );
  await assert.rejects(
    startMonitorServer({
      port: 0,
      get runtime() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
    }),
    (error) => error.code === "MONITOR_START_FAILED"
      && error.stack === "LocalServiceError: MONITOR_START_FAILED",
  );

  const first = await startMonitorServer(idleMonitorOptions());
  try {
    await assert.rejects(
      startMonitorServer(idleMonitorOptions({ port: first.port })),
      (error) => error.code === "MONITOR_START_FAILED"
        && error.message === "MONITOR_START_FAILED"
        && !error.cause,
    );
  } finally {
    await first.close();
  }
});

test("monitor reports an unexpected listener exit without arbitrary details", async () => {
  const handle = await startMonitorServer(idleMonitorOptions());
  handle.server.close();
  assert.deepEqual(await handle.exit, { code: "MONITOR_EXIT_UNEXPECTED" });
  await handle.close();
});

test("monitor awaits cleanup and withholds readiness when post-bind initialization fails", async () => {
  let server;
  let boundPort;
  let closeObserved = false;
  const logs = [];
  await assert.rejects(
    startMonitorServer({
      port: 0,
      runtime: {},
      providerRegistry: {
        watchTargets() {
          boundPort = server.address().port;
          throw new Error("PRIVATE_PATH_MUST_NOT_LEAK");
        },
      },
      serverFactory() {
        server = http.createServer();
        server.once("close", () => { closeObserved = true; });
        return server;
      },
      logger: { log(message) { logs.push(message); } },
    }),
    (error) => error.code === "MONITOR_START_FAILED"
      && error.stack === "LocalServiceError: MONITOR_START_FAILED",
  );
  assert.ok(boundPort > 0);
  assert.equal(closeObserved, true);
  assert.equal(server.listening, false);
  assert.deepEqual(logs, []);
  await assertPortReusable(boundPort);
});

test("production web startup validation returns only fixed safe error codes", async () => {
  await assert.rejects(
    startWebServer({ outDir: productionBuild.outDir, host: "0.0.0.0", port: 0, monitorOrigin: "http://127.0.0.1:4317" }),
    (error) => error.code === "WEB_INVALID_HOST" && error.message === "WEB_INVALID_HOST",
  );
  await assert.rejects(
    startWebServer({ outDir: productionBuild.outDir, host: "127.0.0.1", port: 0, monitorOrigin: "https://example.invalid/private" }),
    (error) => error.code === "WEB_INVALID_MONITOR_ORIGIN"
      && error.message === "WEB_INVALID_MONITOR_ORIGIN",
  );
  await assert.rejects(
    startWebServer({
      host: "127.0.0.1",
      port: 0,
      monitorOrigin: "http://127.0.0.1:4317",
      outDir: Symbol("PRIVATE_PATH_MUST_NOT_LEAK"),
    }),
    (error) => error.code === "WEB_INVALID_BUILD_PATH"
      && error.stack === "LocalServiceError: WEB_INVALID_BUILD_PATH",
  );
  await assert.rejects(
    startWebServer({
      host: "127.0.0.1",
      port: 0,
      monitorOrigin: "http://127.0.0.1:4317",
      outDir: path.join(os.tmpdir(), "PRIVATE_PATH_MUST_NOT_LEAK"),
    }),
    (error) => error.code === "WEB_BUILD_MISSING"
      && error.message === "WEB_BUILD_MISSING"
      && error.stack === "LocalServiceError: WEB_BUILD_MISSING"
      && !error.message.includes("PRIVATE_PATH"),
  );
});

test("authorized production assets retain desktop security and no-store headers", async () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const responseHeaders = {
    "Content-Security-Policy": "default-src 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  const stages = [];
  const web = await startWebServer({
    outDir: productionBuild.outDir,
    host: "127.0.0.1",
    port: 0,
    monitorOrigin: "http://127.0.0.1:4317",
    authorizationToken: token,
    responseHeaders,
    recordStage: (stage) => stages.push(stage),
    logger: quietLogger,
  });
  const authorization = { "x-pomegr-desktop-authorization": token };
  try {
    const page = await fetch(web.origin, { headers: authorization });
    const html = await page.text();
    const assetPath = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
    assert.ok(assetPath);
    const asset = await fetch(`${web.origin}${assetPath}`, { headers: authorization });
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") || "", /^text\/css/);
    assert.equal(asset.headers.get("cache-control"), "no-store");
    for (const [name, value] of Object.entries(responseHeaders)) {
      assert.equal(asset.headers.get(name), value);
    }
    assert.ok((await asset.arrayBuffer()).byteLength > 0);
    assert.equal((await fetch(`${web.origin}${assetPath}`)).status, 401);
  } finally {
    await web.close();
  }
  assert.deepEqual(await web.exit, { code: "WEB_CLOSED" });
  assert.deepEqual(stages, [
    "SHELL_WEB_OUT_DIR_VALIDATING",
    "SHELL_WEB_OUT_DIR_READY",
    "SHELL_WEB_VINEXT_LOADING",
    "SHELL_WEB_VINEXT_LOADED",
    "SHELL_WEB_ENTRY_LOADING",
    "SHELL_WEB_ENTRY_READY",
    "SHELL_WEB_LISTENER_STARTING",
    "SHELL_WEB_LISTENER_READY",
    "SHELL_WEB_AUTH_READY",
    "SHELL_WEB_HANDLE_READY",
  ]);
});

test("production web startup stages stop at the fixed failing boundary", async () => {
  const stages = [];
  await assert.rejects(startWebServer({
    outDir: productionBuild.outDir,
    host: "127.0.0.1",
    port: 0,
    monitorOrigin: "http://127.0.0.1:4317",
    recordStage: (stage) => stages.push(stage),
    loadBuildEntryFn: async () => ({ default() {} }),
    loadProdServerFn: async () => ({
      async startProdServer() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
    }),
  }), (error) => error.code === "WEB_START_FAILED"
    && error.stack === "LocalServiceError: WEB_START_FAILED"
    && !error.stack.includes("PRIVATE_PATH"));
  assert.deepEqual(stages, [
    "SHELL_WEB_OUT_DIR_VALIDATING",
    "SHELL_WEB_OUT_DIR_READY",
    "SHELL_WEB_VINEXT_LOADING",
    "SHELL_WEB_VINEXT_LOADED",
    "SHELL_WEB_ENTRY_LOADING",
    "SHELL_WEB_ENTRY_READY",
    "SHELL_WEB_LISTENER_STARTING",
  ]);
});

test("production web startup stages isolate a generated entry import failure", async () => {
  const stages = [];
  await assert.rejects(startWebServer({
    outDir: productionBuild.outDir,
    host: "127.0.0.1",
    port: 0,
    monitorOrigin: "http://127.0.0.1:4317",
    recordStage: (stage) => stages.push(stage),
    loadBuildEntryFn: async () => { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
    loadProdServerFn: async () => ({ async startProdServer() {} }),
  }), (error) => error.code === "WEB_START_FAILED"
    && error.stack === "LocalServiceError: WEB_START_FAILED"
    && !error.stack.includes("PRIVATE_PATH"));
  assert.deepEqual(stages, [
    "SHELL_WEB_OUT_DIR_VALIDATING",
    "SHELL_WEB_OUT_DIR_READY",
    "SHELL_WEB_VINEXT_LOADING",
    "SHELL_WEB_VINEXT_LOADED",
    "SHELL_WEB_ENTRY_LOADING",
  ]);
});

test("production web handle reports unexpected listener exit", async () => {
  const web = await startWebServer({
    outDir: productionBuild.outDir,
    host: "127.0.0.1",
    port: 0,
    monitorOrigin: "http://127.0.0.1:4317",
    logger: quietLogger,
  });
  web.server.close();
  assert.deepEqual(await web.exit, { code: "WEB_EXIT_UNEXPECTED" });
  await web.close();
});

test("production web startup awaits listener cleanup after a post-bind failure", async () => {
  let server;
  let boundPort;
  let closeObserved = false;
  const previousOrigin = process.env.POMEGR_MONITOR_ORIGIN;
  await assert.rejects(
    startWebServer({
      outDir: productionBuild.outDir,
      host: "127.0.0.1",
      port: 0,
      monitorOrigin: "http://127.0.0.1:4317",
      async startProdServerFn({ host, port }) {
        server = http.createServer((_request, response) => response.end("test"));
        server.once("close", () => { closeObserved = true; });
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, resolve);
        });
        boundPort = server.address().port;
        return { server, port: boundPort };
      },
      logger: { log() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); } },
    }),
    (error) => error.code === "WEB_START_FAILED"
      && error.stack === "LocalServiceError: WEB_START_FAILED",
  );
  assert.ok(boundPort > 0);
  assert.equal(closeObserved, true);
  assert.equal(server.listening, false);
  assert.equal(process.env.POMEGR_MONITOR_ORIGIN, previousOrigin);
  await assertPortReusable(boundPort);
});
