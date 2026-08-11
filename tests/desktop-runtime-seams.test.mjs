import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startMonitorServer } from "../monitor/server.mjs";
import { startWebServer } from "../web/server.mjs";

const quietLogger = Object.freeze({ log() {} });

function waitForOutput(stream, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("CLI readiness timeout")), timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      resolve(output);
    });
  });
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
  const handle = await startMonitorServer({ port: 0, host: "127.0.0.1", logger: quietLogger });
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

  const first = await startMonitorServer({ port: 0, logger: quietLogger });
  try {
    await assert.rejects(
      startMonitorServer({ port: first.port, logger: quietLogger }),
      (error) => error.code === "MONITOR_START_FAILED"
        && error.message === "MONITOR_START_FAILED"
        && !error.cause,
    );
  } finally {
    await first.close();
  }
});

test("monitor reports an unexpected listener exit without arbitrary details", async () => {
  const handle = await startMonitorServer({ port: 0, logger: quietLogger });
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

test("thin monitor CLI preserves executable startup behavior", async (context) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../monitor/cli.mjs", import.meta.url))], {
    env: { ...process.env, SESSION_PULSE_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  context.after(() => { if (child.exitCode === null) child.kill(); });
  const output = await waitForOutput(child.stdout, /Monitor ready on http:\/\/127\.0\.0\.1:\d+/);
  assert.doesNotMatch(output, /Watching:|projects|sessions/i);
  const exited = once(child, "exit");
  child.kill();
  await exited;
});

test("production web server uses explicit runtime inputs from any working directory", async () => {
  const monitor = await startMonitorServer({ port: 0, logger: quietLogger });
  const otherDirectory = await mkdtemp(path.join(os.tmpdir(), "threadlight-web-cwd-"));
  const originalCwd = process.cwd();
  let web;
  try {
    process.chdir(otherDirectory);
    web = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      monitorOrigin: monitor.origin,
      logger: quietLogger,
    });
    assert.equal(web.host, "127.0.0.1");
    assert.ok(web.port > 0);
    const [page, sessions] = await Promise.all([
      fetch(web.origin),
      fetch(`${web.origin}/api/sessions`),
    ]);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Threadlight<\/title>/i);
    assert.equal(sessions.status, 200);
    assert.ok(Array.isArray((await sessions.json()).sessions));
  } finally {
    process.chdir(originalCwd);
    await web?.close();
    await monitor.close();
    await rm(otherDirectory, { recursive: true, force: true });
  }
  assert.deepEqual(await web.exit, { code: "WEB_CLOSED" });
  await web.close();
});

test("production web startup validation returns only fixed safe error codes", async () => {
  await assert.rejects(
    startWebServer({ host: "0.0.0.0", port: 0, monitorOrigin: "http://127.0.0.1:4317" }),
    (error) => error.code === "WEB_INVALID_HOST" && error.message === "WEB_INVALID_HOST",
  );
  await assert.rejects(
    startWebServer({ host: "127.0.0.1", port: 0, monitorOrigin: "https://example.invalid/private" }),
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

test("production web handle reports unexpected listener exit", async () => {
  const monitor = await startMonitorServer({ port: 0, logger: quietLogger });
  const web = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    monitorOrigin: monitor.origin,
    logger: quietLogger,
  });
  try {
    web.server.close();
    assert.deepEqual(await web.exit, { code: "WEB_EXIT_UNEXPECTED" });
    await web.close();
  } finally {
    await monitor.close();
  }
});

test("production web startup awaits listener cleanup after a post-bind failure", async () => {
  let server;
  let boundPort;
  let closeObserved = false;
  const previousOrigin = process.env.THREADLIGHT_MONITOR_ORIGIN;
  await assert.rejects(
    startWebServer({
      host: "127.0.0.1",
      port: 0,
      monitorOrigin: "http://127.0.0.1:4317",
      async startProdServerFn({ host, port }) {
        server = http.createServer();
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
  assert.equal(process.env.THREADLIGHT_MONITOR_ORIGIN, previousOrigin);
  await assertPortReusable(boundPort);
});
