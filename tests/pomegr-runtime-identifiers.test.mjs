import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { monitorOrigin, proxyMonitorJson } from "../app/api/monitor-proxy.ts";
import { DESKTOP_AUTH_HEADER, requestHasDesktopAuthorization } from "../shared/local-auth.mjs";
import { resolvePomegrDataRoot } from "../shared/pomegr-paths.mjs";
import { webRuntimeOptions } from "../web/runtime-options.mjs";

const TOKEN = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";

test("uses only the Pomegr desktop authorization header", () => {
  assert.equal(DESKTOP_AUTH_HEADER, "x-pomegr-desktop-authorization");
  assert.equal(requestHasDesktopAuthorization({ headers: { [DESKTOP_AUTH_HEADER]: TOKEN } }, TOKEN), true);
  assert.equal(requestHasDesktopAuthorization({ headers: { "x-threadlight-desktop-authorization": TOKEN } }, TOKEN), false);
});

test("uses only the Pomegr data environment and roots", () => {
  assert.equal(resolvePomegrDataRoot({
    environment: { APPDATA: "C:\\Users\\Fixture\\AppData\\Roaming" },
    platform: "win32",
  }), path.resolve("C:\\Users\\Fixture\\AppData\\Roaming", "pomegr"));

  assert.equal(resolvePomegrDataRoot({
    environment: {
      APPDATA: "C:\\Users\\Fixture\\AppData\\Roaming",
      THREADLIGHT_DATA_DIR: "D:\\Legacy",
    },
    platform: "win32",
  }), path.resolve("C:\\Users\\Fixture\\AppData\\Roaming", "pomegr"));

  assert.equal(resolvePomegrDataRoot({
    environment: { POMEGR_DATA_DIR: "D:\\Pomegr Data" },
    platform: "win32",
  }), path.resolve("D:\\Pomegr Data"));

  assert.equal(resolvePomegrDataRoot({
    environment: {},
    platform: "linux",
    homeDir: "/home/fixture",
  }), path.resolve("/home/fixture", ".pomegr"));
});

test("uses only the Pomegr API monitor origin environment", () => {
  const previousPomegr = process.env.POMEGR_MONITOR_ORIGIN;
  const previousThreadlight = process.env.THREADLIGHT_MONITOR_ORIGIN;
  try {
    process.env.POMEGR_MONITOR_ORIGIN = "http://127.0.0.1:4545";
    process.env.THREADLIGHT_MONITOR_ORIGIN = "http://127.0.0.1:9999";
    assert.equal(monitorOrigin(), "http://127.0.0.1:4545");

    delete process.env.POMEGR_MONITOR_ORIGIN;
    assert.equal(monitorOrigin(), "http://127.0.0.1:4317");
  } finally {
    if (previousPomegr === undefined) delete process.env.POMEGR_MONITOR_ORIGIN;
    else process.env.POMEGR_MONITOR_ORIGIN = previousPomegr;
    if (previousThreadlight === undefined) delete process.env.THREADLIGHT_MONITOR_ORIGIN;
    else process.env.THREADLIGHT_MONITOR_ORIGIN = previousThreadlight;
  }
});

test("forwards only the Pomegr API monitor token and header", async () => {
  const previousFetch = globalThis.fetch;
  const previousPomegr = process.env.POMEGR_MONITOR_TOKEN;
  const previousThreadlight = process.env.THREADLIGHT_MONITOR_TOKEN;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response("{}", { status: 200 });
  };
  try {
    process.env.POMEGR_MONITOR_TOKEN = TOKEN;
    process.env.THREADLIGHT_MONITOR_TOKEN = "legacy-token-must-be-ignored";
    await proxyMonitorJson({ path: "/api/state", timeoutMs: 100, unavailableBody: {} });
    assert.deepEqual(requests[0].options.headers, { "x-pomegr-desktop-authorization": TOKEN });
    assert.equal(JSON.stringify(requests[0].options.headers).includes("legacy-token"), false);

    delete process.env.POMEGR_MONITOR_TOKEN;
    await proxyMonitorJson({ path: "/api/sessions", timeoutMs: 100, unavailableBody: {} });
    assert.equal(requests[1].options.headers, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPomegr === undefined) delete process.env.POMEGR_MONITOR_TOKEN;
    else process.env.POMEGR_MONITOR_TOKEN = previousPomegr;
    if (previousThreadlight === undefined) delete process.env.THREADLIGHT_MONITOR_TOKEN;
    else process.env.THREADLIGHT_MONITOR_TOKEN = previousThreadlight;
  }
});

test("uses only Pomegr web host, port, and monitor-origin environments", () => {
  assert.deepEqual(webRuntimeOptions({
    POMEGR_WEB_HOST: "::1",
    POMEGR_WEB_PORT: "4321",
    POMEGR_MONITOR_ORIGIN: "http://127.0.0.1:8765",
    THREADLIGHT_WEB_HOST: "legacy-host",
    THREADLIGHT_WEB_PORT: "9999",
    THREADLIGHT_MONITOR_ORIGIN: "http://127.0.0.1:9998",
  }), {
    host: "::1",
    port: 4321,
    monitorOrigin: "http://127.0.0.1:8765",
  });

  assert.deepEqual(webRuntimeOptions({
    THREADLIGHT_WEB_HOST: "legacy-host",
    THREADLIGHT_WEB_PORT: "9999",
    THREADLIGHT_MONITOR_ORIGIN: "http://127.0.0.1:9998",
  }), {
    host: "127.0.0.1",
    port: 3003,
    monitorOrigin: "http://127.0.0.1:4317",
  });
});
