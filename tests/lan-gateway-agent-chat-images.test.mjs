import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { startLanGateway } from "../desktop/runtime/lan-gateway.mjs";
import { createLanSharingController } from "../desktop/runtime/lan-sharing.mjs";

const AUTHORIZATION = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const REPOSITORY = "repo-0123456789abcdef01234567";
const CONVERSATION = "chat-0123456789ab";
const IMAGE = "img-0123456789ab";
const MAX_BYTES = 5 * 1024 * 1024;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const loopbackTestNetwork = Object.freeze({
  isBindHostAllowed: (host, mask) => host === "127.0.0.1" && mask === "255.255.255.0",
  isClientAddressAllowed: (address) => address === "127.0.0.1",
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

async function pair(gateway) {
  const pairingUrl = new URL(gateway.createPairing().url);
  const response = await fetch(`${gateway.origin}/__pomegr/pair`, {
    method: "POST",
    headers: { Origin: gateway.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ secret: pairingUrl.hash.slice(1) }),
  });
  assert.equal(response.status, 204);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

/** A gateway with a fake desktop handler and an upstream that records every request it sees. */
async function withGateway(context, handler) {
  const calls = [];
  const observed = [];
  const upstream = http.createServer((request, response) => { observed.push(`${request.method} ${request.url}`); response.end("{}"); });
  const upstreamOrigin = await listen(upstream);
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin, authorizationToken: AUTHORIZATION,
    isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork,
    ...(handler === undefined ? {} : { agentChatImage: async (operation, payload) => { calls.push([operation, payload]); return handler(operation, payload); } }),
  });
  context.after(async () => { await gateway.close(); await close(upstream); });
  const cookie = await pair(gateway);
  const addQuery = (repository = REPOSITORY, extra = "") => `?repositoryId=${repository}${extra}`;
  const readQuery = (conversation = CONVERSATION, image = IMAGE, repository = REPOSITORY, extra = "") => `?repositoryId=${repository}&conversationId=${conversation}&imageId=${image}${extra}`;
  const add = (query = addQuery(), { headers = {}, body = PNG, cookie: useCookie = cookie } = {}) => fetch(`${gateway.origin}/api/agent-chat/image-add${query}`, {
    method: "POST", headers: { ...(useCookie ? { Cookie: useCookie } : {}), Origin: gateway.origin, "Content-Type": "application/octet-stream", ...headers }, body,
  });
  const read = (query = readQuery(), { headers = {}, cookie: useCookie = cookie } = {}) => fetch(`${gateway.origin}/api/agent-chat/image-read${query}`, { headers: { ...(useCookie ? { Cookie: useCookie } : {}), ...headers } });
  return { gateway, calls, observed, cookie, add, read, addQuery, readQuery };
}

/** A raw request, for the headers that fetch would not let a test set. */
function rawRequest(gateway, lines, body = "") {
  const { port, hostname } = new URL(gateway.origin);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port: Number(port), host: hostname });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("error", reject);
    socket.on("close", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/u.exec(data)?.[1] ?? 0), data }));
    socket.write([...lines, "Connection: close", "", body].join("\r\n"));
  });
}

const okImage = { ok: true, image: { id: IMAGE, type: "png", bytes: PNG.length } };
const standard = (operation) => (operation === "add" ? okImage : { ok: true, type: "png", bytes: PNG });

test("a paired device adds an image with the exact bytes and gets only the ID, type, and size back", async (context) => {
  const h = await withGateway(context, standard);
  const response = await h.add();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/u);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), okImage);
  assert.equal(h.calls.length, 1);
  const [operation, payload] = h.calls[0];
  assert.equal(operation, "add");
  assert.deepEqual(Object.keys(payload).sort(), ["bytes", "repositoryId"]);
  assert.equal(payload.repositoryId, REPOSITORY);
  assert.ok(payload.bytes instanceof Uint8Array);
  assert.deepEqual([...payload.bytes], [...PNG]);
});

test("a paired device adds an image of exactly 5 MiB, and one byte more is refused before the handler", async (context) => {
  const h = await withGateway(context, standard);
  const exact = new Uint8Array(MAX_BYTES);
  exact.set(PNG);
  assert.deepEqual(await (await h.add(h.addQuery(), { body: exact })).json(), okImage);
  assert.equal(h.calls[0][1].bytes.length, MAX_BYTES);
  h.calls.length = 0;
  assert.equal((await h.add(h.addQuery(), { body: new Uint8Array(MAX_BYTES + 1) })).status, 403);
  assert.equal(h.calls.length, 0);
});

test("a paired device reads the bytes of an image with its media type and no-store, for each of the four types", async (context) => {
  for (const type of ["png", "jpeg", "gif", "webp"]) {
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const h = await withGateway(context, () => ({ ok: true, type, bytes }));
    const response = await h.read();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), `image/${type}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-length"), "5");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytes]);
    assert.deepEqual(h.calls, [["read", { repositoryId: REPOSITORY, conversationId: CONVERSATION, imageId: IMAGE }]]);
  }
});

test("a request without the pairing cookie is unauthorized and never reaches the handler", async (context) => {
  const h = await withGateway(context, standard);
  assert.equal((await h.add(h.addQuery(), { cookie: "" })).status, 401);
  assert.equal((await h.read(h.readQuery(), { cookie: "" })).status, 401);
  assert.equal((await h.add(h.addQuery(), { cookie: "pomegr_pairing=forged" })).status, 401);
  assert.equal((await h.read(h.readQuery(), { cookie: "pomegr_pairing=forged" })).status, 401);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.observed, []);
});

test("an add from another origin, with another content type, or oversized by its header is refused", async (context) => {
  const h = await withGateway(context, standard);
  assert.equal((await h.add(h.addQuery(), { headers: { Origin: "http://127.0.0.1:1" } })).status, 403);
  assert.equal((await h.add(h.addQuery(), { headers: { Origin: "http://evil.example" } })).status, 403);
  assert.equal((await h.add(h.addQuery(), { headers: { "Content-Type": "image/png" } })).status, 403);
  assert.equal((await h.add(h.addQuery(), { headers: { "Content-Type": "application/json" } })).status, 403);
  assert.equal((await h.add(h.addQuery(), { headers: { "Content-Type": "text/plain" } })).status, 403);
  assert.equal((await h.add(h.addQuery(), { body: new Uint8Array(MAX_BYTES + 1) })).status, 403);
  assert.equal((await h.add(h.addQuery(), { headers: { "Content-Type": "application/octet-stream; charset=binary" } })).status, 200, "a parameter on the right type is allowed");
  assert.equal(h.calls.length, 1);
});

test("an add without an origin, without a content length, or with a chunked body is refused", async (context) => {
  const h = await withGateway(context, standard);
  const path = `/api/agent-chat/image-add${h.addQuery()}`;
  const base = [`POST ${path} HTTP/1.1`, `Host: ${new URL(h.gateway.origin).host}`, `Cookie: ${h.cookie}`, "Content-Type: application/octet-stream"];
  const origin = `Origin: ${h.gateway.origin}`;
  assert.equal((await rawRequest(h.gateway, [...base, origin, "Content-Length: 3"], "abc")).status, 200, "the raw request itself is well-formed");
  h.calls.length = 0;
  assert.equal((await rawRequest(h.gateway, [...base, "Content-Length: 3"], "abc")).status, 403, "no origin");
  assert.equal((await rawRequest(h.gateway, [...base, origin])).status, 403, "no content length");
  assert.ok([400, 403].includes((await rawRequest(h.gateway, [...base, origin, "Content-Length: abc"], "abc")).status), "a content length that is no number");
  assert.equal((await rawRequest(h.gateway, [...base, origin, "Transfer-Encoding: chunked"], "3\r\nabc\r\n0\r\n\r\n")).status, 403, "chunked");
  assert.ok((await rawRequest(h.gateway, [...base, origin, "Transfer-Encoding: chunked", "Content-Length: 3"], "3\r\nabc\r\n0\r\n\r\n")).status >= 400, "both");
  assert.deepEqual(h.calls, []);
});

test("an add whose query is not exactly the repository, or whose bytes are empty, answers invalid and calls no handler", async (context) => {
  const h = await withGateway(context, standard);
  const invalid = { ok: false, error: "invalid" };
  for (const query of [
    "", "?", `?repositoryId=${REPOSITORY}&x=1`, `?repositoryId=${REPOSITORY}&taskId=T-1`, `?repositoryId=${REPOSITORY}&repositoryId=${REPOSITORY}`, `?conversationId=${CONVERSATION}`,
    `?repositoryID=${REPOSITORY}`, "?repositoryId=repo-bad", "?repositoryId=", "?repositoryId=repo-0123456789ABCDEF01234567", "?repositoryId=repo-0123456789abcdef012345678", "?repositoryId=..%2Fx",
    `?repositoryId=${REPOSITORY}%0A`, `?repositoryId=${REPOSITORY}&imageId=${IMAGE}`,
  ]) {
    const response = await h.add(query);
    assert.equal(response.status, 200, query);
    assert.deepEqual(await response.json(), invalid, query);
  }
  assert.deepEqual(await (await h.add(h.addQuery(), { body: new Uint8Array(0) })).json(), invalid, "empty body");
  assert.deepEqual(h.calls, []);
});

test("a read whose query is not exactly the three keys with well-formed IDs answers invalid and calls no handler", async (context) => {
  const h = await withGateway(context, standard);
  const invalid = { ok: false, error: "invalid" };
  for (const query of [
    "", `?repositoryId=${REPOSITORY}`, `?repositoryId=${REPOSITORY}&conversationId=${CONVERSATION}`, `?repositoryId=${REPOSITORY}&imageId=${IMAGE}`, `?conversationId=${CONVERSATION}&imageId=${IMAGE}`,
    h.readQuery(CONVERSATION, IMAGE, REPOSITORY, "&x=1"), h.readQuery(CONVERSATION, IMAGE, REPOSITORY, `&imageId=${IMAGE}`), h.readQuery(CONVERSATION, IMAGE, REPOSITORY, "&taskId=T-1"),
    h.readQuery("chat-x"), h.readQuery("chat-0123456789AB"), h.readQuery("chat-0123456789abc"), h.readQuery("..%2Fx"), h.readQuery(CONVERSATION, "img-x"), h.readQuery(CONVERSATION, "IMG-0123456789AB"),
    h.readQuery(CONVERSATION, "img-0123456789ab%0A"), h.readQuery(CONVERSATION, "..%2Fimg-0123456789ab"), h.readQuery(CONVERSATION, IMAGE, "repo-bad"), h.readQuery(CONVERSATION, IMAGE, "..%2Fx"),
    h.readQuery(CONVERSATION, "", REPOSITORY), `?repositoryId=${REPOSITORY}&conversationId=&imageId=${IMAGE}`,
  ]) {
    const response = await h.read(query);
    assert.equal(response.status, 200, query);
    assert.deepEqual(await response.json(), invalid, query);
  }
  assert.deepEqual(h.calls, []);
});

test("a read with a body is refused, and the routes accept only their own method", async (context) => {
  const h = await withGateway(context, standard);
  const path = `/api/agent-chat/image-read${h.readQuery()}`;
  const head = [`GET ${path} HTTP/1.1`, `Host: ${new URL(h.gateway.origin).host}`, `Cookie: ${h.cookie}`];
  assert.equal((await rawRequest(h.gateway, [...head, "Content-Length: 0"])).status, 200, "an explicit zero length is allowed");
  assert.equal((await rawRequest(h.gateway, [...head, "Content-Length: 3"], "abc")).status, 403, "a body on a read");
  assert.equal((await rawRequest(h.gateway, [...head, "Transfer-Encoding: chunked"], "0\r\n\r\n")).status, 403, "chunked on a read");
  const wrongMethod = await fetch(`${h.gateway.origin}/api/agent-chat/image-read${h.readQuery()}`, { method: "POST", headers: { Cookie: h.cookie, Origin: h.gateway.origin, "Content-Type": "application/octet-stream" }, body: PNG });
  assert.equal(wrongMethod.status, 405);
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const response = await fetch(`${h.gateway.origin}/api/agent-chat/image-add${h.addQuery()}`, { method, headers: { Cookie: h.cookie, Origin: h.gateway.origin, "Content-Type": "application/octet-stream" }, body: PNG });
    assert.equal(response.status, 405, method);
  }
  assert.equal(h.calls.length, 1, "only the well-formed read reached the handler");
  assert.deepEqual(h.observed, []);
});

test("the handler's add answer is filtered: only image.id, type, and bytes pass", async (context) => {
  const dirty = { ok: true, image: { id: IMAGE, type: "gif", bytes: 12, path: "C:\\secret\\a.gif", file: "x" }, path: "C:\\secret", detail: "private" };
  const h = await withGateway(context, () => dirty);
  const body = await (await h.add()).json();
  assert.deepEqual(body, { ok: true, image: { id: IMAGE, type: "gif", bytes: 12 } });
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("an add answer outside the contract becomes unavailable", async (context) => {
  const unavailable = { ok: false, error: "unavailable" };
  const bad = [
    { ok: true }, { ok: true, image: null }, { ok: true, image: "img" }, { ok: true, image: { id: "img-x", type: "png", bytes: 3 } }, { ok: true, image: { id: IMAGE, type: "svg", bytes: 3 } },
    { ok: true, image: { id: IMAGE, type: "toString", bytes: 3 } }, { ok: true, image: { id: IMAGE, type: "png", bytes: 0 } }, { ok: true, image: { id: IMAGE, type: "png", bytes: -1 } },
    { ok: true, image: { id: IMAGE, type: "png", bytes: 1.5 } }, { ok: true, image: { id: IMAGE, type: "png", bytes: "3" } }, { ok: true, image: { id: IMAGE, type: "png", bytes: MAX_BYTES + 1 } },
    { ok: false, error: "teapot" }, { ok: false, error: "C:\\private\\boom" }, { ok: false }, { ok: "yes", image: okImage.image }, null, undefined, "ok", 5, [],
  ];
  for (const answer of bad) {
    const h = await withGateway(context, () => answer);
    assert.deepEqual(await (await h.add()).json(), unavailable, JSON.stringify(answer));
  }
});

test("a known failure of the handler passes with its error, for add and for read", async (context) => {
  for (const error of ["invalid", "not_found", "limit", "conflict", "unavailable"]) {
    const h = await withGateway(context, () => ({ ok: false, error, detail: "C:\\secret" }));
    assert.deepEqual(await (await h.add()).json(), { ok: false, error }, error);
    const read = await h.read();
    assert.equal(read.status, 200);
    assert.match(read.headers.get("content-type"), /^application\/json/u);
    assert.deepEqual(await read.json(), { ok: false, error }, error);
  }
});

test("a read answer outside the contract becomes unavailable", async (context) => {
  const unavailable = { ok: false, error: "unavailable" };
  const bad = [
    { ok: true, type: "svg", bytes: PNG }, { ok: true, type: "png", bytes: new Uint8Array(0) }, { ok: true, type: "png", bytes: [1, 2, 3] },
    { ok: true, type: "png", bytes: "abc" }, { ok: true, type: "png", bytes: null }, { ok: true, type: "png" }, { ok: true, bytes: PNG }, { ok: true, type: "png", bytes: new Uint8Array(MAX_BYTES + 1) },
    { ok: true, image: okImage.image }, { ok: false, error: "teapot" }, { ok: false }, null, undefined, "png", 5,
  ];
  for (const answer of bad) {
    const h = await withGateway(context, () => answer);
    const response = await h.read();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json/u, JSON.stringify(answer));
    assert.deepEqual(await response.json(), unavailable, JSON.stringify(answer));
  }
});

test("a read answers 5 MiB of bytes, the most an image can be", async (context) => {
  const big = new Uint8Array(MAX_BYTES);
  big[0] = 7;
  const h = await withGateway(context, () => ({ ok: true, type: "webp", bytes: big }));
  const response = await h.read();
  assert.equal(response.headers.get("content-type"), "image/webp");
  const received = new Uint8Array(await response.arrayBuffer());
  assert.equal(received.length, MAX_BYTES);
  assert.equal(received[0], 7);
});

test("a handler that throws, rejects, or is missing answers unavailable, without its message", async (context) => {
  const unavailable = { ok: false, error: "unavailable" };
  for (const handler of [() => { throw new Error("C:\\private\\boom"); }, () => Promise.reject(new Error("C:\\private\\boom"))]) {
    const h = await withGateway(context, handler);
    assert.deepEqual(await (await h.add()).json(), unavailable);
    assert.deepEqual(await (await h.read()).json(), unavailable);
  }
  const bare = await withGateway(context, undefined);
  assert.deepEqual(await (await bare.add()).json(), unavailable);
  assert.deepEqual(await (await bare.read()).json(), unavailable);
  assert.deepEqual(bare.observed, []);
});

test("nothing of a chat image is forwarded to the web host", async (context) => {
  const h = await withGateway(context, standard);
  await h.add();
  await h.read();
  await h.add(h.addQuery("repo-bad"));
  await h.read(h.readQuery("chat-x"));
  await h.add(h.addQuery(), { headers: { Origin: "http://evil.example" } });
  await h.read(h.readQuery(), { cookie: "" });
  assert.deepEqual(h.observed, []);
});

test("a revoked pairing can no longer add or read an image", async (context) => {
  const h = await withGateway(context, standard);
  assert.equal((await h.add()).status, 200);
  h.gateway.revoke();
  h.calls.length = 0;
  const outcome = async (request) => { try { return (await request()).status; } catch { return "reset"; } };
  assert.ok([401, 403, "reset"].includes(await outcome(() => h.add())));
  assert.ok([401, 403, "reset"].includes(await outcome(() => h.read())));
  assert.deepEqual(h.calls, []);
});
// fixed types, so nothing reaches the device today. Remove `todo` when the lookup uses Object.hasOwn.
test("a read answer with an inherited property name as its type becomes unavailable", async (context) => {
  const h = await withGateway(context, () => ({ ok: true, type: "toString", bytes: PNG }));
  const response = await h.read();
  assert.match(response.headers.get("content-type"), /^application\/json/u);
  assert.deepEqual(await response.json(), { ok: false, error: "unavailable" });
});

function controllerHarness(overrides) {
  const handles = [];
  const home = { id: "lan-home", address: "192.168.1.20", subnetMask: "255.255.255.0", label: "Wi-Fi" };
  const controller = createLanSharingController({
    upstreamOrigin: "http://127.0.0.1:1234", authorizationToken: "private-launch-token",
    networkReader: { read: async () => ({ status: "available", candidates: [home] }) },
    schedule: (fn) => fn, cancel: () => {}, canPersist: true, saveAutoStart: async () => {}, onChange: () => {},
    startGateway: async (options) => {
      const handle = {
        options, origin: "http://192.168.1.20:5678", revoke() {}, async close() {}, snapshot: () => ({ pairedClients: 0 }), updateNetworkState() {},
        createPairing: () => ({ url: "http://192.168.1.20:5678/__pomegr/pair#x", expiresAt: "2026-09-03T15:00:00.000Z" }), exit: new Promise(() => {}),
      };
      handles.push(handle);
      return handle;
    },
    ...overrides,
  });
  return { controller, handles };
}

test("the sharing controller starts the gateway with the chat image handler it was given", async () => {
  const agentChatImage = async () => ({ ok: true });
  const wired = controllerHarness({ agentChatImage });
  await wired.controller.setSharing(true);
  assert.equal(wired.handles[0].options.agentChatImage, agentChatImage);
  await wired.controller.dispose();
});
