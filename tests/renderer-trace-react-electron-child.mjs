import { build } from "esbuild";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session } from "electron";
import { normalizeRendererTracePayload } from "../shared/renderer-trace-contract.mjs";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const entryPoint = path.join(testsDirectory, "renderer-trace-react-entry.tsx");
const captureToken = "r0123456789abcdef_1";
const rowId = "row-event-fixed";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function localAddress(url) {
  try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname); } catch { return false; }
}

function historyPage(released) {
  return {
    kind: "activity",
    status: "ready",
    revision: released ? "2" : "1",
    total: 1,
    offset: 0,
    linkedCount: released ? 1 : 0,
    items: [{
      id: "event-fixed",
      timestamp: "2026-09-10T00:00:00.000Z",
      actor: "Primary agent",
      agentId: "primary",
      tool: "Assistant replied",
      detail: "",
      workKind: "report",
      status: null,
      requestId: released ? "request-0000000000000001" : null,
      requestNumber: released ? 1 : null,
      durationMs: released ? 17 : null,
    }],
  };
}

async function waitFor(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "pomegr-renderer-trace-react-"));
  const bundlePath = path.join(directory, "bundle.js");
  let browserWindow;
  let server;
  let released = false;
  let release;
  let eventStream;
  let unexpectedExternalRequests = 0;
  let rendererPosts = 0;
  let rejectedRendererPosts = 0;
  let maxRendererCalibrationRttMs = 0;
  const rendererStages = new Set();
  let stage = "setup";
  try {
    await build({
      entryPoints: [entryPoint],
      outfile: bundlePath,
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      logLevel: "silent",
    });
    const bundle = await readFile(bundlePath);
    const releasedSignal = new Promise((resolve) => { release = resolve; });
    server = http.createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; connect-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "cache-control": "no-store",
        });
        response.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
        return;
      }
      if (requestUrl.pathname === "/bundle.js") {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
        response.end(bundle);
        return;
      }
      if (requestUrl.pathname === "/api/session-history" && request.method === "GET") {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-pomegr-trace-revision": captureToken,
        });
        response.end(JSON.stringify(historyPage(released)));
        return;
      }
      if (requestUrl.pathname === "/api/events" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        response.write(": connected\n\n");
        eventStream = response;
        request.once("close", () => { if (eventStream === response) eventStream = undefined; });
        return;
      }
      if (requestUrl.pathname === "/api/renderer-trace" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        let payload = null;
        try { payload = normalizeRendererTracePayload(JSON.parse(body)); } catch { /* rejection stays aggregate */ }
        if (!payload) {
          rejectedRendererPosts += 1;
          response.writeHead(400).end();
          return;
        }
        rendererPosts += 1;
        maxRendererCalibrationRttMs = Math.max(maxRendererCalibrationRttMs,
          payload.calibration.responseReceivedMs - payload.calibration.requestStartedMs);
        for (const record of payload.records) rendererStages.add(record.stage);
        response.writeHead(204).end();
        return;
      }
      if (requestUrl.pathname === "/release" && request.method === "POST") {
        released = true;
        eventStream?.write("event: history\ndata: {\"domain\":\"history\",\"revision\":2}\n\n");
        release();
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback fixture did not bind a port");
    const origin = `http://127.0.0.1:${address.port}`;
    stage = "app_ready";
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (!localAddress(details.url)) unexpectedExternalRequests += 1;
      callback({});
    });
    browserWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
    await browserWindow.loadURL(origin);
    stage = "initial_dom";
    await waitFor(async () => await browserWindow.webContents.executeJavaScript(`Boolean(document.getElementById(${JSON.stringify(rowId)})?.dataset.link === "unlinked")`), 10_000, "initial unlinked activity row");
    await waitFor(() => Boolean(eventStream), 5_000, "history publication subscription");
    await browserWindow.webContents.executeJavaScript(`window.__pomegrInitialActivityRow = document.getElementById(${JSON.stringify(rowId)});`);
    process.stdout.write(`${JSON.stringify({ type: "initial", origin })}\n`);
    await releasedSignal;
    stage = "enriched_dom";
    await waitFor(async () => await browserWindow.webContents.executeJavaScript(`(() => { const row = document.getElementById(${JSON.stringify(rowId)}); return row === window.__pomegrInitialActivityRow && row?.dataset.link === "linked" && row?.dataset.duration === "17"; })()`), 10_000, "same activity row enriched by the publication");
    await waitFor(() => rendererStages.has("renderer_event") && rendererStages.has("renderer_fetch")
      && rendererStages.has("renderer_react_commit") && rendererStages.has("renderer_next_frame"), 5_000, "fixed renderer timing records");
    process.stdout.write(`${JSON.stringify({ type: "complete", proof: {
      initialVisible: true,
      sameNodeEnriched: true,
      rendererStages: [...rendererStages].sort(),
      rendererPosts,
      rejectedRendererPosts,
      maxRendererCalibrationRttMs,
      unexpectedExternalRequests,
    } })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ type: "complete", proof: {
      initialVisible: false,
      sameNodeEnriched: false,
      rendererStages: [],
      rendererPosts,
      rejectedRendererPosts,
      maxRendererCalibrationRttMs,
      unexpectedExternalRequests,
      stage,
    } })}\n`);
  } finally {
    try { browserWindow?.destroy(); } catch { /* hidden fixture closes */ }
    try { eventStream?.end(); } catch { /* local event stream closes */ }
    try { await new Promise((resolve) => server?.close(resolve)); } catch { /* local server closes */ }
    await rm(directory, { recursive: true, force: true });
    app.quit();
  }
}

void main();
