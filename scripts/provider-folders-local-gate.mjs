import { hostname, networkInterfaces } from "node:os";

function normalizeAddress(value) {
  return value?.toLowerCase().replace(/^\[|\]$/gu, "").replace(/^::ffff:/u, "");
}

function localIdentity() {
  return { hostname: hostname(), addresses: Object.values(networkInterfaces()).flatMap((entries) => entries ?? []).map((entry) => entry.address) };
}

// A denied task-board read answers the contract's desktop_only board with no
// task content; a denied provider-folders read stays unavailable.
const gatedRoutes = new Map([
  ["/api/provider-folders", { status: 404, body: '{"error":"Provider folders unavailable."}' }],
  ["/api/tasks", { status: 200, body: JSON.stringify({ version: 1, readiness: "desktop_only", repositoryId: "", columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, order: [] }, runModels: { codex: [] } }) }],
]);

// Served to every peer, but with same-computer content only for a local one: the Sessions list's task
// references. A peer that is not local is marked like the LAN gateway marks what it forwards, so the route
// cannot take a forged loopback Host header for a same-computer client.
const markedRoutes = new Set(["/api/sessions"]);
const LAN_MARKER = "x-pomegr-lan-gateway";

// Vite listens on the LAN during development. Check the actual peer before the
// Fetch API loses socket information; forwarded headers cannot authorize reads.
export function providerFoldersLocalGate(request, response, next, identity = undefined) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname).replace(/\/+$/u, ""); }
  catch { next(); return; }
  const denied = gatedRoutes.get(pathname);
  if (!denied && !markedRoutes.has(pathname)) {
    next(); return;
  }
  identity ??= localIdentity();
  const addresses = new Set(["127.0.0.1", "::1", ...identity.addresses].map(normalizeAddress));
  const machineName = identity.hostname.toLowerCase();
  const names = new Set(["localhost", machineName, `${machineName}.local`]);
  let trusted = false;
  try {
    const host = request.headers.host;
    const origin = `http://${host}`;
    const parsed = new URL(origin);
    const name = normalizeAddress(parsed.hostname);
    trusted = parsed.host === host?.toLowerCase() && (names.has(name) || addresses.has(name))
      && addresses.has(normalizeAddress(request.socket?.remoteAddress))
      && (!request.headers.origin || request.headers.origin === origin)
      && (!request.headers["sec-fetch-site"] || request.headers["sec-fetch-site"] === "same-origin")
      && Number(parsed.port || 80) === request.socket?.localPort;
  } catch { /* Invalid hosts are unavailable. */ }
  if (trusted) {
    // The route receives a canonical local origin only after validating the
    // actual peer and original origin. Never use forwarded headers as proof.
    request.headers.host = `localhost:${request.socket.localPort}`;
    if (request.headers.origin) request.headers.origin = `http://${request.headers.host}`;
    // Cloudflare's development adapter constructs Fetch headers from rawHeaders.
    for (let index = 0; index < (request.rawHeaders?.length ?? 0); index += 2) {
      const key = request.rawHeaders[index].toLowerCase();
      if (key === "host" || key === "origin") request.rawHeaders[index + 1] = request.headers[key];
    }
    next(); return;
  }
  if (!denied) {
    request.headers[LAN_MARKER] = "1";
    // Cloudflare's development adapter constructs Fetch headers from rawHeaders.
    if (Array.isArray(request.rawHeaders)) request.rawHeaders.push(LAN_MARKER, "1");
    next(); return;
  }
  response.writeHead(denied.status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(denied.body);
}

/** @returns {import("vite").Plugin} */
export function providerFoldersLocalGatePlugin() {
  return {
    name: "pomegr-provider-folders-local-gate",
    enforce: "pre",
    configureServer(server) { server.middlewares.use(providerFoldersLocalGate); },
  };
}
