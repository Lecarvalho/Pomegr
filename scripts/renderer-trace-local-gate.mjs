import { hostname, networkInterfaces } from "node:os";

const MAX_TRACE_BYTES = 8 * 1024;

function loopbackMonitorOrigin(value) {
  try {
    const origin = new URL(value);
    if (origin.protocol !== "http:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
      || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) return null;
    return origin.origin;
  } catch { return null; }
}

function address(value) { return value?.toLowerCase().replace(/^\[|\]$/gu, "").replace(/^::ffff:/u, ""); }

/** Reject LAN renderer telemetry before Vite converts the request to Fetch. */
export function rendererTraceLocalGate(request, response, next, identity = undefined) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname).replace(/\/+$/u, ""); } catch { next(); return; }
  if (pathname !== "/api/renderer-trace") { next(); return; }
  identity ??= { hostname: hostname(), addresses: Object.values(networkInterfaces()).flatMap((items) => items || []).map((item) => item.address) };
  const addresses = new Set(["127.0.0.1", "::1", ...identity.addresses].map(address));
  const names = new Set(["localhost", identity.hostname.toLowerCase(), `${identity.hostname.toLowerCase()}.local`]);
  let trusted = false;
  try {
    const host = request.headers.host;
    const origin = `http://${host}`;
    const parsed = new URL(origin);
    const name = address(parsed.hostname);
    trusted = request.method === "POST" && parsed.host === host?.toLowerCase() && (names.has(name) || addresses.has(name))
      && addresses.has(address(request.socket?.remoteAddress)) && (!request.headers.origin || request.headers.origin === origin)
      && (!request.headers["sec-fetch-site"] || request.headers["sec-fetch-site"] === "same-origin")
      && Number(parsed.port || 80) === request.socket?.localPort;
  } catch { /* Only an actual local peer can proceed. */ }
  if (trusted) {
    // Only after checking the real socket peer, project a recognized machine
    // alias into the route's loopback-only authorization contract.
    request.headers.host = `127.0.0.1:${request.socket.localPort}`;
    if (request.headers.origin) request.headers.origin = `http://${request.headers.host}`;
    for (let index = 0; index < (request.rawHeaders?.length || 0); index += 2) {
      const key = request.rawHeaders[index].toLowerCase();
      if (key === "host" || key === "origin") request.rawHeaders[index + 1] = request.headers[key];
    }
    next(); return;
  }
  response.writeHead(404, { "Cache-Control": "no-store" }); response.end();
}

export function rendererTraceLocalGatePlugin() {
  return {
    name: "pomegr-renderer-trace-development-middleware",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(rendererTraceLocalGate);
      server.middlewares.use(rendererTraceDevelopmentProxy);
    },
  };
}

/** Dev-server-only bridge; production has no renderer telemetry route. */
export async function rendererTraceDevelopmentProxy(request, response, next, {
  fetchImpl = fetch,
  monitorOrigin = process.env.POMEGR_MONITOR_ORIGIN || "http://127.0.0.1:4317",
} = {}) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname).replace(/\/+$/u, ""); } catch { next(); return; }
  if (pathname !== "/api/renderer-trace") { next(); return; }
  const target = loopbackMonitorOrigin(monitorOrigin);
  if (!target) { response.writeHead(503, { "Cache-Control": "no-store" }); response.end(); return; }
  let body = "";
  try {
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_TRACE_BYTES) {
        response.writeHead(413, { "Cache-Control": "no-store" }); response.end(); return;
      }
    }
    const upstream = await fetchImpl(`${target}/internal/renderer-trace`, {
      method: "POST",
      body,
      headers: { "content-type": request.headers["content-type"] || "" },
      signal: AbortSignal.timeout(2_000),
    });
    response.writeHead(upstream.ok ? 204 : 503, { "Cache-Control": "no-store" }); response.end();
  } catch {
    response.writeHead(503, { "Cache-Control": "no-store" }); response.end();
  }
}
