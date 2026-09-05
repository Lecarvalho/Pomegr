import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lanPairingPage } from "./lan-pairing-page.mjs";

const PRIVATE_RANGES = Object.freeze([
  [10, 0, 0, 0, 8], [172, 16, 0, 0, 12], [192, 168, 0, 0, 16],
]);
const API_PATHS = new Set(["/api/state", "/api/sessions", "/api/home", "/api/agents", "/api/usage-limits", "/api/provider-status", "/api/events"]);
const APP_PATHS = new Set(["/", "/sessions", "/agents", "/usage-limits", "/repositories", "/dashboards", "/settings"]);
const REQUEST_HEADERS = new Set([
  "accept", "accept-language", "content-type", "if-none-match", "if-modified-since",
  "rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url",
  "x-vinext-interception-context", "x-vinext-mounted-slots", "x-vinext-rsc-render-mode",
]);
const RESPONSE_HEADERS = new Set([
  "content-type", "content-encoding", "content-length", "etag", "last-modified", "vary",
  "rsc", "next-router-state-tree", "next-router-prefetch", "next-url",
  "x-pomegr-revision", "x-accel-buffering", "content-security-policy", "cross-origin-opener-policy",
  "cross-origin-resource-policy", "permissions-policy", "x-frame-options",
  "x-vinext-rsc", "x-vinext-params",
]);
const MAX_CONNECTIONS = 16;
const MAX_SESSIONS = 4;
const PAIRING_TTL_MS = 5 * 60_000;
const NETWORK_CHECK_TIMEOUT_MS = 4_000;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_QUERY_BYTES = 2 * 1024;
const MAX_PAIR_BODY_BYTES = 256;
const MAX_PAIR_ATTEMPTS = 8;
const PAIR_ATTEMPT_WINDOW_MS = 60_000;
const MAX_PAIRING_ATTEMPT_CLIENTS = 128;
const KNOWN_PUBLIC_PATHS = new Set([
  "/favicon.ico", "/favicon.png", "/pomegr-mark-painted.png", "/pomegr-mark-brush-outline.png", "/pomegr-logo.png",
  "/pomegr-mark-outline-dark.svg", "/pomegr-mark-outline-light.svg", "/file.svg", "/globe.svg", "/window.svg",
  "/legal/LICENSE.txt", "/legal/NOTICE.txt", "/legal/SOURCE.txt", "/legal/THIRD_PARTY_NOTICES.txt", "/legal/TRADEMARKS.txt",
]);

class LanGatewayError extends Error {
  constructor(code) { super(code); this.name = "LanGatewayError"; this.code = code; this.stack = `${this.name}: ${code}`; }
}

function parseIpv4(value) {
  if (typeof value !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const octets = value.split(".").map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function toUint32(octets) { return (((octets[0] << 24) >>> 0) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0; }

function isPrivateIpv4(value) {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const numeric = toUint32(octets);
  return PRIVATE_RANGES.some(([a, b, c, d, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (numeric & mask) === (toUint32([a, b, c, d]) & mask);
  });
}

function parseMask(value) {
  const octets = parseIpv4(value);
  if (!octets) return null;
  const mask = toUint32(octets);
  let zeroSeen = false;
  for (let bit = 31; bit >= 0; bit -= 1) {
    const set = Boolean(mask & (2 ** bit));
    if (!set) zeroSeen = true;
    else if (zeroSeen) return null;
  }
  return mask;
}

function sameSubnet(host, remoteAddress, mask) {
  const remote = parseIpv4(remoteAddress);
  const local = parseIpv4(host);
  return Boolean(remote && local && (toUint32(remote) & mask) === (toUint32(local) & mask));
}

function randomToken(bytes = 32) { return randomBytes(bytes).toString("base64url"); }
function tokenMatches(value, expected) {
  if (typeof value !== "string" || typeof expected !== "string") return false;
  const actual = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function safeOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new LanGatewayError("LAN_GATEWAY_INVALID_UPSTREAM"); }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
    || !parsed.port || !["127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new LanGatewayError("LAN_GATEWAY_INVALID_UPSTREAM");
  }
  return parsed;
}

function requestPathIsSafe(requestUrl) {
  if (typeof requestUrl !== "string" || requestUrl.length > MAX_QUERY_BYTES + 1024) return false;
  const rawPath = requestUrl.split("?", 1)[0];
  if (!rawPath.startsWith("/") || /(?:\\|%00|%2e|%2f|%5c|\0|\.\.)/i.test(rawPath)) return false;
  return requestUrl.length - rawPath.length <= MAX_QUERY_BYTES;
}

function pageRouteIsAllowed(pathname) {
  return APP_PATHS.has(pathname) || /^\/sessions\/[^/]+$/.test(pathname);
}

function routeIsAllowed(pathname) {
  if (API_PATHS.has(pathname)) return true;
  if (pageRouteIsAllowed(pathname)) return true;
  if (pathname.endsWith(".rsc")) return pageRouteIsAllowed(pathname.slice(0, -4));
  return /^\/assets\/[A-Za-z0-9._/-]+$/.test(pathname) || KNOWN_PUBLIC_PATHS.has(pathname);
}

function acceptsHtml(request) { return /(?:^|,)\s*(?:text\/html|\*\/\*)/i.test(String(request.headers.accept || "")); }
function noStore(response) { response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("X-Content-Type-Options", "nosniff"); }
function fixed(response, status, body = "Access denied") {
  if (!response.headersSent) { noStore(response); response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); }
  response.end(body);
}

function readPairingBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_PAIR_BODY_BYTES) { reject(new LanGatewayError("LAN_GATEWAY_PAIRING_BODY")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.once("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(typeof value?.secret === "string" ? value.secret : null);
      } catch { reject(new LanGatewayError("LAN_GATEWAY_PAIRING_BODY")); }
    });
    request.once("error", () => reject(new LanGatewayError("LAN_GATEWAY_PAIRING_BODY")));
  });
}

function cookieValue(request, name) {
  const values = String(request.headers.cookie || "").split(";");
  for (const part of values) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function safeRedirect(value, upstream) {
  if (typeof value !== "string" || value.length > 2048 || /[\\\r\n]/.test(value)) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const parsed = new URL(value);
    return parsed.origin === upstream.origin ? `${parsed.pathname}${parsed.search}` : null;
  } catch { return null; }
}

function closeSoon(server, sockets, upstreamRequests, upstreamStreams) {
  for (const upstream of upstreamRequests) upstream.destroy();
  for (const stream of upstreamStreams) stream.destroy();
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    const timer = setTimeout(() => { server.closeAllConnections?.(); resolve(); }, 1_500);
    server.close(() => { clearTimeout(timer); resolve(); });
  });
}

export async function startLanGateway(options = {}) {
  const host = options.host;
  const mask = parseMask(options.subnetMask);
  const testNetwork = options.networkPolicy;
  const hostAllowed = typeof testNetwork?.isBindHostAllowed === "function"
    ? testNetwork.isBindHostAllowed(host, options.subnetMask)
    : isPrivateIpv4(host);
  if (!hostAllowed || !mask || typeof host !== "string") throw new LanGatewayError("LAN_GATEWAY_INVALID_NETWORK");
  const upstream = safeOrigin(options.upstreamOrigin);
  if (typeof options.authorizationToken !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(options.authorizationToken)) {
    throw new LanGatewayError("LAN_GATEWAY_INVALID_AUTHORIZATION");
  }
  if (typeof options.isNetworkAllowed !== "function") throw new LanGatewayError("LAN_GATEWAY_INVALID_NETWORK_POLICY");
  try { if (!await options.isNetworkAllowed({ host, subnetMask: options.subnetMask })) throw new LanGatewayError("LAN_GATEWAY_NETWORK_UNAVAILABLE"); }
  catch (error) { throw error instanceof LanGatewayError ? error : new LanGatewayError("LAN_GATEWAY_NETWORK_UNAVAILABLE"); }

  const sessions = new Map();
  const sockets = new Set();
  const upstreamRequests = new Set();
  const upstreamStreams = new Set();
  const pairingAttempts = new Map();
  const cookieName = `pomegr_lan_${randomToken(12)}`;
  let pairing = null;
  let active = true;
  let closePromise;
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });
  let closeRequested = false;
  let lastCount = 0;
  const change = () => {
    const count = sessions.size;
    if (count !== lastCount) { lastCount = count; try { options.onChange?.(); } catch { /* Controller callbacks are optional. */ } }
  };
  const revoke = () => {
    if (!active) return;
    active = false;
    pairing = null;
    sessions.clear();
    change();
    for (const pending of upstreamRequests) pending.destroy();
    for (const stream of upstreamStreams) stream.destroy();
    for (const socket of sockets) socket.destroy();
  };
  const clientAllowed = (request) => {
    const remote = request.socket.remoteAddress || "";
    if (typeof testNetwork?.isClientAddressAllowed === "function") {
      try { return Boolean(testNetwork.isClientAddressAllowed(remote, host, options.subnetMask)); } catch { return false; }
    }
    return isPrivateIpv4(remote) && sameSubnet(host, remote, mask);
  };
  const pairingAttemptAllowed = (request) => {
    const remote = request.socket.remoteAddress || "";
    let client = remote;
    if (typeof testNetwork?.pairingAttemptKey === "function") {
      try {
        const candidate = testNetwork.pairingAttemptKey(request);
        if (typeof candidate === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(candidate)) client = candidate;
      } catch { return false; }
    }
    const now = Date.now();
    for (const [address, record] of pairingAttempts) if (record.resetAt <= now) pairingAttempts.delete(address);
    const record = pairingAttempts.get(client);
    if (!record && pairingAttempts.size >= MAX_PAIRING_ATTEMPT_CLIENTS) return false;
    if (record && record.count >= MAX_PAIR_ATTEMPTS) return false;
    pairingAttempts.set(client, record ? { count: record.count + 1, resetAt: record.resetAt } : { count: 1, resetAt: now + PAIR_ATTEMPT_WINDOW_MS });
    return true;
  };
  const expectedHost = (port) => `${host}:${port}`;
  let origin;
  const checkNetworkIdentity = () => new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value === true);
    };
    const timeout = setTimeout(() => finish(false), NETWORK_CHECK_TIMEOUT_MS);
    Promise.resolve().then(() => options.isNetworkAllowed({ host, subnetMask: options.subnetMask })).then(finish, () => finish(false));
  });
  const networkAllowed = async () => {
    try {
      if (active && await checkNetworkIdentity()) return true;
    } catch { /* A failed revalidation closes LAN access. */ }
    revoke();
    return false;
  };
  const authenticated = (request) => {
    const token = cookieValue(request, cookieName);
    return Boolean(token && sessions.has(token));
  };
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, async (request, response) => {
    const port = server.address()?.port;
    if (!Number.isInteger(port) || !active || !clientAllowed(request) || !(await networkAllowed())) { fixed(response, 403); return; }
    const requestHost = request.headers.host;
    if (requestHost !== expectedHost(port) || !requestPathIsSafe(request.url)) { fixed(response, 400); return; }
    if (request.headers.origin && request.headers.origin !== origin) { fixed(response, 403); return; }
    let url;
    try { url = new URL(request.url, origin); } catch { fixed(response, 400); return; }
    const pathname = url.pathname;
    const method = request.method || "GET";
    if (pathname === "/__pomegr/pair") {
      if (method === "GET" && !url.search) {
        noStore(response);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'" });
        response.end(lanPairingPage()); return;
      }
      if (method !== "POST" || url.search || request.headers.origin !== origin || !String(request.headers["content-type"] || "").startsWith("application/json")) { fixed(response, 403); return; }
      if (!pairingAttemptAllowed(request)) { fixed(response, 429, "Try again later"); return; }
      let secret;
      try { secret = await readPairingBody(request); } catch { fixed(response, 400); return; }
      if (!active || !(await networkAllowed())) { fixed(response, 403); return; }
      const current = pairing;
      if (!current || current.expiresAt <= Date.now()) { pairing = null; fixed(response, 410, "Pairing link expired"); return; }
      if (!tokenMatches(secret, current.secret)) { fixed(response, 403, "Pairing code invalid"); return; }
      if (sessions.size >= MAX_SESSIONS) { fixed(response, 429, "Pairing capacity reached"); return; }
      pairing = null;
      const session = randomToken();
      sessions.set(session, Object.freeze({}));
      change();
      noStore(response);
      response.setHeader("Set-Cookie", `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`);
      response.writeHead(204); response.end(); return;
    }
    if (method !== "GET" && method !== "HEAD") { fixed(response, 405); return; }
    if (!authenticated(request)) {
      if (pathname.startsWith("/api/")) { fixed(response, 401, "Unauthorized"); return; }
      if (acceptsHtml(request)) { noStore(response); response.writeHead(302, { Location: "/__pomegr/pair" }); response.end(); return; }
      fixed(response, 401, "Unauthorized"); return;
    }
    if (pathname === "/api/client-access") {
      noStore(response); response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      if (method === "GET") response.end('{"mode":"lan","canCopyTranscriptPath":false}'); else response.end();
      return;
    }
    if (!routeIsAllowed(pathname)) { fixed(response, 404); return; }
    const headers = { host: upstream.host, "x-pomegr-desktop-authorization": options.authorizationToken };
    for (const [name, value] of Object.entries(request.headers)) {
      if (!REQUEST_HEADERS.has(name) || typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) continue;
      headers[name] = value;
    }
    const upstreamRequest = http.request({
      protocol: upstream.protocol, hostname: upstream.hostname.replace(/^\[|\]$/g, ""), port: upstream.port,
      method, path: `${pathname}${url.search}`, headers, timeout: 15_000,
    }, (upstreamResponse) => {
      upstreamRequests.delete(upstreamRequest);
      if (response.destroyed) { upstreamResponse.destroy(); return; }
      upstreamStreams.add(upstreamResponse);
      const clearStream = () => {
        upstreamStreams.delete(upstreamResponse);
        if (!response.writableEnded) response.destroy();
      };
      upstreamResponse.once("close", clearStream);
      const upstreamStatus = upstreamResponse.statusCode || 502;
      if (upstreamStatus >= 400) {
        upstreamResponse.resume();
        noStore(response);
        response.writeHead(upstreamStatus, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Request unavailable");
        return;
      }
      const responseHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (RESPONSE_HEADERS.has(name) && value !== undefined) responseHeaders[name] = value;
      }
      const redirect = safeRedirect(upstreamResponse.headers.location, upstream);
      if (redirect) responseHeaders.Location = redirect;
      response.writeHead(upstreamStatus, responseHeaders);
      if (method === "HEAD") { upstreamResponse.resume(); response.end(); return; }
      upstreamResponse.pipe(response);
      upstreamResponse.once("error", () => { if (!response.writableEnded) response.destroy(); });
    });
    upstreamRequests.add(upstreamRequest);
    upstreamRequest.once("timeout", () => upstreamRequest.destroy());
    upstreamRequest.once("error", () => { upstreamRequests.delete(upstreamRequest); if (!response.headersSent) fixed(response, 502, "Gateway unavailable"); else response.destroy(); });
    request.once("aborted", () => upstreamRequest.destroy());
    response.once("close", () => { if (!response.writableEnded) upstreamRequest.destroy(); });
    upstreamRequest.end();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 50;
  server.on("connection", (socket) => {
    if (sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.once("close", () => resolveExit(Object.freeze({ code: closeRequested ? "LAN_GATEWAY_CLOSED" : "LAN_GATEWAY_EXIT_UNEXPECTED" })));
  try {
    await new Promise((resolve, reject) => {
      const onError = () => { server.removeListener("error", onError); reject(new LanGatewayError("LAN_GATEWAY_START_FAILED")); };
      server.once("error", onError);
      server.listen(0, host, () => { server.removeListener("error", onError); resolve(); });
    });
  } catch { await closeSoon(server, sockets, upstreamRequests, upstreamStreams); throw new LanGatewayError("LAN_GATEWAY_START_FAILED"); }
  const address = server.address();
  if (!address || typeof address === "string") { await closeSoon(server, sockets, upstreamRequests, upstreamStreams); throw new LanGatewayError("LAN_GATEWAY_START_FAILED"); }
  origin = `http://${host}:${address.port}`;
  server.on("error", () => {
    if (closeRequested) return;
    revoke();
    void closeSoon(server, sockets, upstreamRequests, upstreamStreams);
  });
  return Object.freeze({
    origin,
    createPairing() {
      if (!active) throw new LanGatewayError("LAN_GATEWAY_REVOKED");
      const secret = randomToken();
      const expiresAt = Date.now() + PAIRING_TTL_MS;
      pairing = { secret, expiresAt };
      return Object.freeze({ url: `${origin}/__pomegr/pair#${secret}`, expiresAt: new Date(expiresAt).toISOString() });
    },
    snapshot: () => Object.freeze({ pairedClients: sessions.size }),
    revoke,
    close() {
      if (closePromise) return closePromise;
      closeRequested = true; revoke(); closePromise = closeSoon(server, sockets, upstreamRequests, upstreamStreams); return closePromise;
    },
    exit,
  });
}
