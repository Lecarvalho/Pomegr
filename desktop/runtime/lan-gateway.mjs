import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lanPairingPage } from "./lan-pairing-page.mjs";
import { TASK_START_STATUSES } from "./task-dispatch.mjs";

const PRIVATE_RANGES = Object.freeze([
  [10, 0, 0, 0, 8], [172, 16, 0, 0, 12], [192, 168, 0, 0, 16],
]);
const API_PATHS = new Set(["/api/state", "/api/sessions", "/api/session-domain", "/api/session-history", "/api/home", "/api/agents", "/api/usage-limits", "/api/provider-status", "/api/notifications", "/api/storage", "/api/provider-folders", "/api/repositories", "/api/repository-files", "/api/events", "/api/tasks"]);
// A paired device's fixed board action is the one write forwarded to the web host.
const TASK_ACTION_PATH = "/api/tasks/action";
// Paired manual starts stay in desktop main; the private start plan never reaches the web host.
const TASK_START_PATH = "/api/tasks/start";
const TASK_LOG_PATH = "/api/tasks/log-read";
const MAX_TASK_LOG_BODY_BYTES = 256;
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const MAX_TASK_START_BODY_BYTES = 512;
// A paired device's task images: answered here by desktop main, never forwarded to the web host.
const TASK_IMAGE_ADD_PATH = "/api/tasks/image-add";
const TASK_IMAGE_REMOVE_PATH = "/api/tasks/image-remove";
const TASK_IMAGE_READ_PATH = "/api/tasks/image-read";
const IMAGE_ID = /^img-[0-9a-f]{12}$/u;
const MAX_TASK_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TASK_IMAGE_REMOVE_BODY_BYTES = 512;
const IMAGE_MEDIA_TYPES = Object.freeze({ png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" });
const IMAGE_ERRORS = new Set(["invalid", "not_found", "limit", "conflict", "unavailable"]);
// The Pomegr agent chat of a paired device: answered here by desktop main, never forwarded upstream.
const AGENT_CHAT_PATH = "/api/agent-chat";
// The images a paired device sends to the agent chat, and reads back from a conversation: answered by desktop main too.
const AGENT_CHAT_IMAGE_ADD_PATH = "/api/agent-chat/image-add";
const AGENT_CHAT_IMAGE_READ_PATH = "/api/agent-chat/image-read";
const CONVERSATION_ID = /^chat-[0-9a-f]{12}$/u;
// The 16 KiB action payload plus its fixed envelope, as the monitor bounds it.
const MAX_TASK_ACTION_BODY_BYTES = 17 * 1024;
const APP_PATHS = new Set(["/", "/sessions", "/tasks", "/agents", "/usage-limits", "/repositories", "/dashboards", "/settings"]);
const REQUEST_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language", "content-type", "if-none-match", "if-modified-since",
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
const NETWORK_CHECK_TIMEOUT_MS = 11_000;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_QUERY_BYTES = 2 * 1024;
const MAX_PAIR_BODY_BYTES = 256;
const MAX_PAIR_ATTEMPTS = 8;
const PAIR_ATTEMPT_WINDOW_MS = 60_000;
const MAX_PAIRING_ATTEMPT_CLIENTS = 128;
const KNOWN_PUBLIC_PATHS = new Set([
  "/favicon.ico", "/favicon.png", "/pomegr-mark-painted.png", "/pomegr-mark-brush-outline.png", "/pomegr-logo.png",
  "/file.svg", "/globe.svg", "/window.svg",
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
  return APP_PATHS.has(pathname) || /^\/sessions\/[^/]+$/.test(pathname) || /^\/repositories\/repo-[a-f0-9]{24}$/.test(pathname);
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

function readBoundedBody(request, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { resolve(null); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", () => resolve(null));
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

function pairedStartRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (!keys.every((key) => ["repositoryId", "taskId", "confirmed", "worktree"].includes(key))
    || keys.length !== (Object.hasOwn(body, "worktree") ? 4 : 3)
    || typeof body.repositoryId !== "string" || !REPOSITORY_ID.test(body.repositoryId)
    || typeof body.taskId !== "string" || !TASK_ID.test(body.taskId)
    || body.confirmed !== true || (Object.hasOwn(body, "worktree") && body.worktree !== true)) return null;
  return body;
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
  try { if (await options.isNetworkAllowed({ host, subnetMask: options.subnetMask }) !== true) throw new LanGatewayError("LAN_GATEWAY_NETWORK_UNAVAILABLE"); }
  catch (error) { throw error instanceof LanGatewayError ? error : new LanGatewayError("LAN_GATEWAY_NETWORK_UNAVAILABLE"); }

  const sessions = new Map();
  const sockets = new Set();
  const upstreamRequests = new Set();
  const upstreamStreams = new Set();
  const pairingAttempts = new Map();
  const cookieName = `pomegr_lan_${randomToken(12)}`;
  let pairing = null;
  let active = true;
  let suspended = false;
  let networkRevision = 0;
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
  // null means verification is temporarily unavailable, never permission to serve.
  // Retain only the listener and bounded existing sessions while access is blocked.
  const updateNetworkState = (allowed) => {
    if (!active) return;
    if (allowed !== true && allowed !== null) { revoke(); return; }
    if (suspended === (allowed === null)) return;
    networkRevision += 1;
    suspended = allowed === null;
    if (suspended) {
      pairing = null;
      for (const pending of upstreamRequests) pending.destroy();
      for (const stream of upstreamStreams) stream.destroy();
    }
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
      resolve(value === null ? null : value === true);
    };
    const timeout = setTimeout(() => finish(null), NETWORK_CHECK_TIMEOUT_MS);
    Promise.resolve().then(() => options.isNetworkAllowed({ host, subnetMask: options.subnetMask })).then(finish, () => finish(null));
  });
  const networkAllowed = async () => {
    if (!active) return false;
    const revision = networkRevision;
    const allowed = await checkNetworkIdentity();
    // A watcher observation or explicit revocation wins over an older request.
    if (revision === networkRevision) updateNetworkState(allowed);
    return active ? suspended ? null : true : false;
  };
  const requireNetwork = (response) => {
    if (active && !suspended) return true;
    if (active && suspended) {
      response.setHeader("Retry-After", "5");
      fixed(response, 503, "Network verification unavailable; retry shortly");
    } else fixed(response, 403);
    return false;
  };
  const authenticated = (request) => {
    const token = cookieValue(request, cookieName);
    return Boolean(token && sessions.has(token));
  };
  // One image operation of a paired device. The device's cookie, its own origin, and the bounds are checked here; the bytes
  // go to the task store through desktop main and nothing else of the answer is passed on.
  const serveTaskImage = async (request, response, url, operation) => {
    const refuse = (error) => {
      if (!active || suspended || response.destroyed) { if (!response.destroyed) fixed(response, 403); return; }
      noStore(response);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error }));
    };
    const declared = request.headers["content-length"];
    const reading = operation === "read";
    const limit = operation === "add" ? MAX_TASK_IMAGE_BYTES : MAX_TASK_IMAGE_REMOVE_BODY_BYTES;
    const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (request.headers["transfer-encoding"] !== undefined
      || (reading ? declared !== undefined && declared !== "0"
        : request.headers.origin !== origin || !/^\d+$/.test(String(declared ?? "")) || Number(declared) > limit
          || contentType !== (operation === "add" ? "application/octet-stream" : "application/json"))) { fixed(response, 403); return; }
    let input = null;
    let bytes = null;
    if (operation === "remove") {
      if (url.search) { fixed(response, 403); return; }
      const body = await readBoundedBody(request, limit);
      if (body === null) { fixed(response, 400); return; }
      try { input = JSON.parse(body.toString("utf8")); } catch { input = null; }
      const valid = input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 3
        && ["repositoryId", "taskId", "imageId"].every((key) => typeof input[key] === "string");
      if (!valid) input = null;
    } else {
      const keys = [...url.searchParams.keys()].sort();
      if (keys.join() === "imageId,repositoryId,taskId") input = Object.fromEntries(url.searchParams);
      if (operation === "add") {
        bytes = await readBoundedBody(request, limit);
        if (bytes === null) { fixed(response, 400); return; }
      }
    }
    if (!active || suspended || !authenticated(request)) { fixed(response, 403); return; }
    if (!input || !REPOSITORY_ID.test(input.repositoryId) || !TASK_ID.test(input.taskId) || !IMAGE_ID.test(input.imageId)
      || (bytes !== null && bytes.length === 0)) { refuse("invalid"); return; }
    let answer = null;
    try {
      answer = typeof options.taskImage === "function"
        ? await options.taskImage(input.repositoryId, operation, operation === "add"
          ? { taskId: input.taskId, imageId: input.imageId, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) }
          : { taskId: input.taskId, imageId: input.imageId })
        : null;
    } catch { answer = null; }
    if (!active || suspended || !authenticated(request) || response.destroyed) { if (!response.destroyed) fixed(response, 403); return; }
    if (answer?.ok === true && operation === "read") {
      const mediaType = Object.hasOwn(IMAGE_MEDIA_TYPES, answer.type) ? IMAGE_MEDIA_TYPES[answer.type] : null;
      if (mediaType && answer.bytes instanceof Uint8Array && answer.bytes.length > 0 && answer.bytes.length <= MAX_TASK_IMAGE_BYTES) {
        noStore(response);
        response.writeHead(200, { "Content-Type": mediaType, "Content-Length": String(answer.bytes.length) });
        response.end(Buffer.from(answer.bytes));
        return;
      }
      refuse("unavailable");
      return;
    }
    if (answer?.ok === true) {
      noStore(response);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(operation === "add" ? { ok: true, imageId: input.imageId } : { ok: true }));
      return;
    }
    refuse(IMAGE_ERRORS.has(answer?.error) ? answer.error : "unavailable");
  };
  // One chat image operation of a paired device, under the same checks as a task image. `add` keeps the bytes for a
  // message that is not sent yet and answers the image's ID, type, and size; `read` answers the bytes of an image that
  // a message of the conversation names.
  const serveChatImage = async (request, response, url, operation) => {
    const refuse = (error) => {
      if (!active || suspended || response.destroyed) { if (!response.destroyed) fixed(response, 403); return; }
      noStore(response);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error }));
    };
    const adding = operation === "add";
    const declared = request.headers["content-length"];
    const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (request.headers["transfer-encoding"] !== undefined
      || (adding ? request.headers.origin !== origin || !/^\d+$/.test(String(declared ?? "")) || Number(declared) > MAX_TASK_IMAGE_BYTES || contentType !== "application/octet-stream"
        : declared !== undefined && declared !== "0")) { fixed(response, 403); return; }
    const keys = [...url.searchParams.keys()].sort().join();
    const input = keys === (adding ? "repositoryId" : "conversationId,imageId,repositoryId") ? Object.fromEntries(url.searchParams) : null;
    let bytes = null;
    if (adding) {
      bytes = await readBoundedBody(request, MAX_TASK_IMAGE_BYTES);
      if (bytes === null) { fixed(response, 400); return; }
    }
    if (!active || suspended || !authenticated(request)) { fixed(response, 403); return; }
    if (!input || !REPOSITORY_ID.test(input.repositoryId) || (adding ? bytes.length === 0 : !CONVERSATION_ID.test(input.conversationId) || !IMAGE_ID.test(input.imageId))) { refuse("invalid"); return; }
    let answer = null;
    try {
      answer = typeof options.agentChatImage === "function"
        ? await options.agentChatImage(operation, adding
          ? { repositoryId: input.repositoryId, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) }
          : { repositoryId: input.repositoryId, conversationId: input.conversationId, imageId: input.imageId })
        : null;
    } catch { answer = null; }
    if (!active || suspended || !authenticated(request) || response.destroyed) { if (!response.destroyed) fixed(response, 403); return; }
    if (answer?.ok === true && !adding) {
      const mediaType = Object.hasOwn(IMAGE_MEDIA_TYPES, answer.type) ? IMAGE_MEDIA_TYPES[answer.type] : null;
      if (mediaType && answer.bytes instanceof Uint8Array && answer.bytes.length > 0 && answer.bytes.length <= MAX_TASK_IMAGE_BYTES) {
        noStore(response);
        response.writeHead(200, { "Content-Type": mediaType, "Content-Length": String(answer.bytes.length) });
        response.end(Buffer.from(answer.bytes));
        return;
      }
      refuse("unavailable");
      return;
    }
    const image = answer?.ok === true ? answer.image : null;
    if (image && typeof image.id === "string" && IMAGE_ID.test(image.id) && Object.hasOwn(IMAGE_MEDIA_TYPES, image.type)
      && Number.isInteger(image.bytes) && image.bytes > 0 && image.bytes <= MAX_TASK_IMAGE_BYTES) {
      noStore(response);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, image: { id: image.id, type: image.type, bytes: image.bytes } }));
      return;
    }
    refuse(answer?.ok === false && IMAGE_ERRORS.has(answer.error) ? answer.error : "unavailable");
  };
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, async (request, response) => {
    const port = server.address()?.port;
    if (!Number.isInteger(port) || !active || !clientAllowed(request)) { fixed(response, 403); return; }
    const requestHost = request.headers.host;
    if (requestHost !== expectedHost(port) || !requestPathIsSafe(request.url)) { fixed(response, 400); return; }
    if (request.headers.origin && request.headers.origin !== origin) { fixed(response, 403); return; }
    await networkAllowed();
    if (!requireNetwork(response)) return;
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
      await networkAllowed();
      if (!requireNetwork(response)) return;
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
    const agentChat = method === "POST" && pathname === AGENT_CHAT_PATH;
    const taskAction = method === "POST" && pathname === TASK_ACTION_PATH;
    const taskStart = method === "POST" && pathname === TASK_START_PATH;
    const taskLog = method === "POST" && pathname === TASK_LOG_PATH;
    const imageAdd = method === "POST" && pathname === TASK_IMAGE_ADD_PATH;
    const imageRemove = method === "POST" && pathname === TASK_IMAGE_REMOVE_PATH;
    const imageRead = method === "GET" && pathname === TASK_IMAGE_READ_PATH;
    const chatImageAdd = method === "POST" && pathname === AGENT_CHAT_IMAGE_ADD_PATH;
    const chatImageRead = method === "GET" && pathname === AGENT_CHAT_IMAGE_READ_PATH;
    if (method !== "GET" && method !== "HEAD" && !taskAction && !taskStart && !taskLog && !agentChat && !imageAdd && !imageRemove && !chatImageAdd) { fixed(response, 405); return; }
    if (!authenticated(request)) {
      if (pathname.startsWith("/api/")) { fixed(response, 401, "Unauthorized"); return; }
      if (acceptsHtml(request)) { noStore(response); response.writeHead(302, { Location: "/__pomegr/pair" }); response.end(); return; }
      fixed(response, 401, "Unauthorized"); return;
    }
    if (pathname === TASK_LOG_PATH && !taskLog) { fixed(response, 405); return; }
    if (pathname === "/api/client-access") {
      noStore(response); response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      if (method === "GET") response.end('{"mode":"lan","canCopyTranscriptPath":false}'); else response.end();
      return;
    }
    if (pathname === "/api/provider-folders") {
      const contentLength = request.headers["content-length"];
      const hasBody = request.headers["transfer-encoding"] !== undefined
        || (contentLength !== undefined && (!/^\d+$/.test(String(contentLength)) || Number(contentLength) !== 0));
      if (method !== "GET") { fixed(response, 405); return; }
      if (url.search || hasBody) { fixed(response, 403); return; }
    }
    if (imageAdd || imageRemove || imageRead) {
      await serveTaskImage(request, response, url, imageAdd ? "add" : imageRemove ? "remove" : "read");
      return;
    }
    if (chatImageAdd || chatImageRead) {
      await serveChatImage(request, response, url, chatImageAdd ? "add" : "read");
      return;
    }
    let actionBody = null;
    if (taskAction || taskStart || taskLog || agentChat) {
      // A paired device's own page only: the gateway's origin, a JSON body within the bound, and no query.
      const declared = request.headers["content-length"];
      const bodyLimit = taskLog ? MAX_TASK_LOG_BODY_BYTES : taskStart ? MAX_TASK_START_BODY_BYTES : MAX_TASK_ACTION_BODY_BYTES;
      const contentType = String(request.headers["content-type"] || "");
      if (url.search || request.headers.origin !== origin || !(taskStart || taskLog
        ? /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
        : contentType.startsWith("application/json"))
        || request.headers["transfer-encoding"] !== undefined || !/^\d+$/.test(String(declared ?? "")) || Number(declared) > bodyLimit) { fixed(response, 403); return; }
      actionBody = await readBoundedBody(request, bodyLimit);
      if (actionBody === null) { fixed(response, 400); return; }
      if (!active || suspended || !authenticated(request)) { fixed(response, 403); return; }
    } else if (!routeIsAllowed(pathname)) { fixed(response, 404); return; }
    if (taskLog) {
      let body = null;
      try { body = JSON.parse(actionBody.toString("utf8")); } catch { /* invalid JSON */ }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
        || typeof body.repositoryId !== "string" || !REPOSITORY_ID.test(body.repositoryId)) { fixed(response, 400); return; }
      let answer;
      try { answer = typeof options.taskLog === "function" ? await options.taskLog(body.repositoryId) : { ok: false, error: "unavailable" }; }
      catch { answer = { ok: false, error: "unavailable" }; }
      if (!active || suspended || !authenticated(request) || response.destroyed) { if (!response.destroyed) fixed(response, 403); return; }
      noStore(response);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(answer));
      return;
    }
    if (taskStart) {
      let body = null;
      try { body = pairedStartRequest(JSON.parse(actionBody.toString("utf8"))); } catch { /* invalid JSON */ }
      let answer = { status: "invalid" };
      if (body) {
        const revision = networkRevision;
        const isAuthorized = async () => {
          if (!active || suspended || revision !== networkRevision || !authenticated(request) || response.destroyed) return false;
          await networkAllowed();
          return active && !suspended && revision === networkRevision && authenticated(request) && !response.destroyed;
        };
        try {
          answer = typeof options.taskStart === "function"
            ? await options.taskStart(body.repositoryId, body.taskId, body.worktree, isAuthorized)
            : { status: "unavailable" };
        } catch { answer = { status: "unavailable" }; }
      }
      if (!active || suspended || !authenticated(request) || response.destroyed) { if (!response.destroyed) fixed(response, 403); return; }
      noStore(response);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: TASK_START_STATUSES.includes(answer?.status) ? answer.status : "unavailable" }));
      return;
    }
    if (taskAction && typeof options.arilOn === "function" && !options.arilOn()) {
      // With Aril Off a repository's memory is read only on a paired device too: the one memory write is refused here, before the web host.
      let named = null;
      try { named = JSON.parse(actionBody.toString("utf8"))?.action; } catch { /* the web host refuses invalid JSON */ }
      if (named === "aril_memory_set") {
        noStore(response);
        response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        response.end('{"ok":false,"error":"conflict"}');
        return;
      }
    }
    if (agentChat) {
      // One fixed operation and its payload in; the chat's own bounded answer out. Nothing of it reaches the web host.
      let answer = { ok: false, error: "invalid" };
      let body = null;
      try { body = JSON.parse(actionBody.toString("utf8")); } catch { body = null; }
      if (body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => key === "operation" || key === "payload")) {
        try { answer = typeof options.agentChat === "function" ? await options.agentChat(body.operation, body.payload) : { ok: false, error: "unavailable" }; }
        catch { answer = { ok: false, error: "unavailable" }; }
      }
      if (!active || suspended || !authenticated(request)) { fixed(response, 403); return; }
      noStore(response);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(answer));
      return;
    }
    // The upstream sees a loopback host, so every forwarded request is marked: a route can tell a paired device from a
    // same-computer client, and the one write route takes only a marked request. Client headers pass only by allowlist.
    const headers = { host: upstream.host, "x-pomegr-desktop-authorization": options.authorizationToken, "x-pomegr-lan-gateway": "1" };
    for (const [name, value] of Object.entries(request.headers)) {
      if (!REQUEST_HEADERS.has(name) || typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) continue;
      headers[name] = value;
    }
    if (actionBody) { headers["content-type"] = "application/json"; headers["content-length"] = String(actionBody.length); }
    const forwardingRevision = networkRevision;
    const upstreamRequest = http.request({
      protocol: upstream.protocol, hostname: upstream.hostname.replace(/^\[|\]$/g, ""), port: upstream.port,
      method, path: `${pathname}${url.search}`, headers, timeout: 15_000,
    }, (upstreamResponse) => {
      upstreamRequests.delete(upstreamRequest);
      if (response.destroyed || !active || suspended || forwardingRevision !== networkRevision) {
        upstreamResponse.destroy(); response.destroy(); return;
      }
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
    upstreamRequest.end(actionBody ?? undefined);
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
      if (!active || suspended) throw new LanGatewayError("LAN_GATEWAY_REVOKED");
      const secret = randomToken();
      const expiresAt = Date.now() + PAIRING_TTL_MS;
      pairing = { secret, expiresAt };
      return Object.freeze({ url: `${origin}/__pomegr/pair#${secret}`, expiresAt: new Date(expiresAt).toISOString() });
    },
    snapshot: () => Object.freeze({ pairedClients: sessions.size }),
    revoke,
    updateNetworkState,
    close() {
      if (closePromise) return closePromise;
      closeRequested = true; revoke(); closePromise = closeSoon(server, sockets, upstreamRequests, upstreamStreams); return closePromise;
    },
    exit,
  });
}
