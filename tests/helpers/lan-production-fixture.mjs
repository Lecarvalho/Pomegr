import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { closeServer } from "../../shared/local-service.mjs";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import { createEmptyProviderStatusSnapshot } from "../../shared/provider-status.mjs";
import { startLanGateway } from "../../desktop/lan-gateway.mjs";
import { createLanSharingController } from "../../desktop/lan-sharing.mjs";
import { startWebServer } from "../../web/server.mjs";
import { createProductionBuildFixture } from "./production-build.mjs";

const TOKEN = "fixture_production_web_authorization_0123456789";
const FIXTURE_NETWORK = Object.freeze({
  id: "fixture-loopback-network",
  label: "Test network (simulated)",
  address: "127.0.0.1",
  subnetMask: "255.255.255.0",
});
const LOOPBACK_POLICY = Object.freeze({
  isBindHostAllowed: (host, mask) => host === "127.0.0.1" && mask === "255.255.255.0",
  isClientAddressAllowed: (address) => address === "127.0.0.1",
});

function responseJson(response, status, value, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

function closeSockets(server, sockets) {
  for (const socket of sockets) socket.destroy();
  return closeServer(server);
}

async function startSyntheticMonitor() {
  const sockets = new Set();
  const streams = new Set();
  const server = http.createServer((request, response) => {
    if (request.headers["x-pomegr-desktop-authorization"] !== TOKEN) {
      response.writeHead(401, { "Cache-Control": "no-store" }); response.end("Unauthorized"); return;
    }
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
      response.write('event: catalog\ndata: {"domain":"sessions","revision":1}\n\n');
      streams.add(response);
      response.once("close", () => streams.delete(response));
      return;
    }
    if (url.pathname === "/api/sessions") {
      if (url.searchParams.get("revision") === "1") { response.writeHead(204, { "Cache-Control": "no-store", "X-Pomegr-Revision": "1" }); response.end(); return; }
      responseJson(response, 200, { revision: 1, sessions: [], readiness: { catalog: "ready" } }, { "X-Pomegr-Revision": "1" }); return;
    }
    if (url.pathname === "/api/state") { responseJson(response, 200, createEmptyMonitorState({ connected: true }), { "X-Pomegr-Revision": "1" }); return; }
    if (url.pathname === "/api/home") { responseJson(response, 200, { generatedAt: null, providerLimits: [], limitActivities: [] }); return; }
    if (url.pathname === "/api/agents") { responseJson(response, 200, { readiness: "ready", generatedAt: null, overview: null, roster: [], models: [], work: [] }); return; }
    if (url.pathname === "/api/usage-limits") { responseJson(response, 200, { revision: 1, generatedAt: null, providers: [], readiness: { claude: "unavailable", codex: "unavailable" } }); return; }
    if (url.pathname === "/api/provider-status") { responseJson(response, 200, createEmptyProviderStatusSnapshot("unavailable")); return; }
    response.writeHead(404, { "Cache-Control": "no-store" }); response.end("Not found");
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return Object.freeze({ origin: `http://127.0.0.1:${port}`, close: async () => { for (const stream of streams) stream.destroy(); await closeSockets(server, sockets); } });
}

function bridgeScript() {
  return `<script>(function(){const listeners=new Set(),desktopListeners=new Set(),desktopState={paused:false,launchAtLogin:false,launchAtLoginAvailable:false,closeBehavior:'ask',notifications:false,notificationQuietUntil:null,displayPreferences:{contextHistory:true,estimatedCost:true},update:null};const call=async(path,body)=>{try{const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});if(!r.ok)return null;const v=await r.json();if(v&&v.status){for(const f of listeners)f(v)}return v}catch(_){return null}};window.pomegrDesktop=Object.freeze({getPhoneAccessState:()=>call('/__fixture/state'),setPhoneSharing:(enabled,networkId)=>call('/__fixture/sharing',{enabled,networkId}),setPhoneAutoStart:(enabled)=>call('/__fixture/autostart',{enabled}),createPhonePairing:()=>call('/__fixture/pair',{}),onPhoneAccessChanged:(f)=>{if(typeof f!=='function')return()=>{};listeners.add(f);return()=>listeners.delete(f)},getDesktopState:async()=>desktopState,onDesktopStateChanged:(f)=>{if(typeof f!=='function')return()=>{};desktopListeners.add(f);return()=>desktopListeners.delete(f)}})})()</script>`;
}

function injectBridge(html) {
  const script = bridgeScript();
  return html.includes("<head>") ? html.replace("<head>", `<head>${script}`) : `${script}${html}`;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0;
    request.on("data", (chunk) => { size += chunk.length; if (size <= 2048) chunks.push(chunk); });
    request.once("end", () => { try { resolve(size <= 2048 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null); } catch { resolve(null); } });
    request.once("error", () => resolve(null));
  });
}

async function proxyWeb(request, response, webOrigin) {
  const url = new URL(request.url || "/", webOrigin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (["host", "connection", "content-length", "origin"].includes(name) || typeof value !== "string") continue;
    headers.set(name, value);
  }
  headers.set("x-pomegr-desktop-authorization", TOKEN);
  const upstream = await fetch(url, { method: request.method, headers, redirect: "manual" });
  const contentType = upstream.headers.get("content-type") || "";
  const outgoing = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
  if (contentType) outgoing["Content-Type"] = contentType;
  if (upstream.headers.get("rsc")) outgoing.rsc = upstream.headers.get("rsc");
  if (upstream.headers.get("vary")) outgoing.Vary = upstream.headers.get("vary");
  if (upstream.headers.get("x-pomegr-revision")) outgoing["X-Pomegr-Revision"] = upstream.headers.get("x-pomegr-revision");
  if (request.method === "HEAD") { response.writeHead(upstream.status, outgoing); response.end(); return; }
  if (/text\/event-stream/i.test(contentType) && upstream.body) {
    response.writeHead(upstream.status, outgoing);
    const reader = upstream.body.getReader();
    const pump = async () => {
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; if (!response.write(Buffer.from(chunk.value))) await once(response, "drain"); }
      } finally { response.end(); }
    };
    void pump();
    return;
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  if (/text\/html/i.test(contentType)) { response.writeHead(upstream.status, outgoing); response.end(injectBridge(body.toString("utf8"))); return; }
  response.writeHead(upstream.status, outgoing); response.end(body);
}

async function startPreviewWeb(options) {
  const log = console.log;
  console.log = () => {};
  try { return await startWebServer(options); }
  finally { console.log = log; }
}

export async function startLanProductionFixture(options = {}) {
  const build = options.outDir ? { outDir: options.outDir, close: async () => {} } : await createProductionBuildFixture();
  const monitor = await startSyntheticMonitor();
  let web;
  let controller;
  let preview;
  const sockets = new Set();
  const previousMonitorToken = process.env.POMEGR_MONITOR_TOKEN;
  try {
    process.env.POMEGR_MONITOR_TOKEN = TOKEN;
    web = await startPreviewWeb({ host: "127.0.0.1", port: 0, outDir: build.outDir, monitorOrigin: monitor.origin, authorizationToken: TOKEN });
    controller = createLanSharingController({
      upstreamOrigin: web.origin,
      authorizationToken: TOKEN,
      canPersist: true,
      saveAutoStart: async () => {},
      networkReader: { read: async () => ({ status: "available", candidates: [FIXTURE_NETWORK] }) },
      startGateway: (gatewayOptions) => startLanGateway({ ...gatewayOptions, networkPolicy: LOOPBACK_POLICY }),
    });
    preview = http.createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/__fixture/")) {
        const body = await readBody(request);
        if (url.pathname === "/__fixture/state" && request.method === "GET") { responseJson(response, 200, await controller.getState()); return; }
        if (url.pathname === "/__fixture/sharing" && request.method === "POST" && typeof body?.enabled === "boolean") { responseJson(response, 200, await controller.setSharing(body.enabled, typeof body.networkId === "string" ? body.networkId : undefined)); return; }
        if (url.pathname === "/__fixture/autostart" && request.method === "POST" && typeof body?.enabled === "boolean") { responseJson(response, 200, await controller.setAutoStart(body.enabled)); return; }
        if (url.pathname === "/__fixture/pair" && request.method === "POST") { const pair = await controller.createPairing(); if (pair) responseJson(response, 200, pair); else responseJson(response, 409, { error: "Sharing is not active." }); return; }
        response.writeHead(404, { "Cache-Control": "no-store" }); response.end("Not found"); return;
      }
      try { await proxyWeb(request, response, web.origin); } catch { if (!response.headersSent) response.writeHead(502, { "Cache-Control": "no-store" }); response.end("Preview unavailable"); }
    });
    preview.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    preview.listen(0, "127.0.0.1");
    await once(preview, "listening");
    const previewOrigin = `http://127.0.0.1:${preview.address().port}`;
    let closed = false;
    return Object.freeze({ previewOrigin, webOrigin: web.origin, controller, async close() {
      if (closed) return; closed = true;
      await closeSockets(preview, sockets);
      await controller.dispose();
      await web.close();
      await monitor.close();
      await build.close();
      if (previousMonitorToken === undefined) delete process.env.POMEGR_MONITOR_TOKEN;
      else process.env.POMEGR_MONITOR_TOKEN = previousMonitorToken;
    } });
  } catch (error) {
    await closeSockets(preview, sockets);
    await controller?.dispose();
    await web?.close();
    await monitor.close();
    await build.close();
    if (previousMonitorToken === undefined) delete process.env.POMEGR_MONITOR_TOKEN;
    else process.env.POMEGR_MONITOR_TOKEN = previousMonitorToken;
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await startLanProductionFixture();
  process.stdout.write(`${fixture.previewOrigin}\n`);
  await new Promise((resolve) => {
    const close = () => { void fixture.close().then(resolve); };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}
