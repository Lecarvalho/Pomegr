// The transport of the effort routing's call: a name lookup with the DNS library instead of the thread pool, a kept connection, and a connection
// opened ahead. It runs against a real local HTTP server (the same agent, lookup, and connection code as TLS, without a certificate) and a fake
// resolver, so no request leaves the machine.

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createJevTransport, JEV_DNS_TTL_CAP_MS, JEV_HOST, JEV_IDLE_MS } from "../desktop/runtime/agent-chat-jev-transport.mjs";

const HOST = "jev.test";
const PLAIN = { module: http, secure: false, ready: "connect" };

// A local server that records each connection, the bytes it received, and each request.
async function server(context, handler = (_request, response) => response.end('{"ok":true}')) {
  const seen = { connections: [], requests: [] };
  const listener = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8"), connection: seen.connections.indexOf(request.socket) });
      handler(request, response);
    });
  });
  listener.on("connection", (socket) => { const entry = socket; entry.received = 0; entry.on("data", (chunk) => { entry.received += chunk.length; }); seen.connections.push(entry); });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  context.after(() => { for (const socket of seen.connections) socket.destroy(); listener.close(); });
  return { port: listener.address().port, seen };
}

// A resolver that counts its questions and answers 127.0.0.1 unless told otherwise.
function fakeResolver({ ttl = 60, fail4 = false, fail6 = true, delayMs = 0 } = {}) {
  const asked = [];
  const answer = async (family, options) => {
    asked.push([family, options]);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (family === 4 ? fail4 : fail6) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    return [{ address: family === 4 ? "127.0.0.1" : "::1", ttl }];
  };
  return { asked, resolve4: async (host, options) => { assert.equal(host, HOST); return answer(4, options); }, resolve6: async (host, options) => { assert.equal(host, HOST); return answer(6, options); } };
}

const never = () => { throw new Error("The operating system's lookup must not be used."); };
function transportFor(port, overrides = {}) {
  const clock = { at: 1_000_000 };
  const resolver = overrides.resolver ?? fakeResolver();
  const transport = createJevTransport({ host: HOST, port, resolver, lookup: overrides.lookup ?? never, protocol: overrides.protocol ?? PLAIN, now: () => clock.at, idleMs: 5_000, ...overrides.options });
  return { transport, clock, resolver };
}
const post = (transport, port, body = "{}", extra = {}) => transport.fetch(`http://${HOST}:${port}/v1/systemone`, { method: "POST", headers: { authorization: "Bearer test-key-123", "content-type": "application/json" }, body, ...extra });
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test("the host name is resolved with the DNS library, and the call reaches the server with the host name as its Host", async (context) => {
  const { port, seen } = await server(context);
  const { transport, resolver } = transportFor(port);
  const response = await post(transport, port, '{"state":"hello"}');
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(await response.text()), { ok: true });
  assert.deepEqual(resolver.asked, [[4, { ttl: true }]], "the DNS library was asked once, for IPv4, with the TTL");
  assert.equal(seen.requests.length, 1);
  const [request] = seen.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/systemone");
  assert.equal(request.body, '{"state":"hello"}');
  assert.equal(request.headers.host, `${HOST}:${port}`);
  assert.equal(request.headers.authorization, "Bearer test-key-123");
  assert.equal(request.headers["content-length"], "17");
});

test("an address is kept while its TTL lasts, then asked for again; a zero TTL is never kept; no TTL is kept past the cap", async (context) => {
  // Each answer closes its connection, so each call connects and so looks the name up.
  const { port } = await server(context, (_request, response) => { response.setHeader("connection", "close"); response.end("{}"); });
  const { transport, clock, resolver } = transportFor(port, { resolver: fakeResolver({ ttl: 60 }) });
  await post(transport, port);
  clock.at += 59_000;
  await post(transport, port);
  assert.equal(resolver.asked.length, 1, "kept for 59 of 60 seconds");
  clock.at += 2_000;
  await post(transport, port);
  assert.equal(resolver.asked.length, 2, "asked again after the TTL");
  const zero = transportFor(port, { resolver: fakeResolver({ ttl: 0 }) });
  await post(zero.transport, port);
  await post(zero.transport, port);
  assert.equal(zero.resolver.asked.length, 2, "a record with no time to live is not kept");
  const long = transportFor(port, { resolver: fakeResolver({ ttl: 86_400 }) });
  await post(long.transport, port);
  long.clock.at += JEV_DNS_TTL_CAP_MS - 1;
  await post(long.transport, port);
  assert.equal(long.resolver.asked.length, 1);
  long.clock.at += 2;
  await post(long.transport, port);
  assert.equal(long.resolver.asked.length, 2, "a day-long TTL is cut to ten minutes");
});

test("calls that start together share one resolution, and the other family is tried when IPv4 has no answer", async (context) => {
  const { port } = await server(context);
  const together = transportFor(port, { resolver: fakeResolver({ delayMs: 30 }) });
  await Promise.all([post(together.transport, port), post(together.transport, port)]);
  assert.equal(together.resolver.asked.length, 1);
  const six = transportFor(port, { resolver: { ...fakeResolver({ fail4: true, fail6: false }) } });
  // IPv6 loopback may not be listening where this server is, so only the order of the questions is asserted.
  await post(six.transport, port).catch(() => {});
  assert.deepEqual(six.resolver.asked.map(([family]) => family).slice(0, 2), [4, 6]);
});

test("the operating system's lookup is the fallback when the DNS library has no answer", async (context) => {
  const { port } = await server(context);
  const asked = [];
  const lookup = (hostname, options, callback) => { asked.push(hostname); callback(null, options?.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4); };
  const { transport } = transportFor(port, { resolver: fakeResolver({ fail4: true, fail6: true }), lookup });
  const response = await post(transport, port);
  assert.equal(response.ok, true);
  assert.deepEqual(asked, [HOST]);
});

test("a connection is kept and reused by the next call", async (context) => {
  const { port, seen } = await server(context);
  const { transport } = transportFor(port);
  await post(transport, port);
  await post(transport, port);
  await post(transport, port);
  assert.equal(seen.requests.length, 3);
  assert.equal(seen.connections.length, 1, "one connection served all three calls");
  assert.deepEqual(seen.requests.map((request) => request.connection), [0, 0, 0]);
});

test("a pre-connect opens a connection and sends nothing; the next call uses it, and a second pre-connect opens no other", async (context) => {
  const { port, seen } = await server(context);
  const { transport, resolver } = transportFor(port);
  assert.equal(await transport.preconnect(), true);
  assert.equal(seen.connections.length, 1);
  assert.equal(resolver.asked.length, 1, "the pre-connect resolved the name");
  await settle();
  assert.equal(seen.connections[0].received, 0, "not one byte reached the server: no request, no key, no text");
  assert.equal(await transport.preconnect(), true);
  await settle();
  assert.equal(seen.connections.length, 1, "a connection that is ready is not duplicated");
  const response = await post(transport, port, '{"state":"owner words"}');
  assert.equal(response.ok, true);
  assert.equal(seen.connections.length, 1, "the call took the connection opened ahead");
  assert.equal(seen.requests[0].connection, 0);
  assert.equal(resolver.asked.length, 1, "and needed no name lookup");
  assert.equal(await transport.preconnect(), true);
  assert.equal(seen.connections.length, 1, "the kept connection counts as ready");
});

test("pre-connects in flight are one: calls together share it, and a call that starts meanwhile waits for it instead of opening another", async (context) => {
  const { port, seen } = await server(context);
  const { transport } = transportFor(port, { resolver: fakeResolver({ delayMs: 40 }) });
  const first = transport.preconnect();
  const second = transport.preconnect();
  assert.strictEqual(first, second);
  const call = post(transport, port);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal((await call).ok, true);
  assert.equal(seen.connections.length, 1);
});

test("a connection that waits keeps nothing alive, and one that grew old is replaced", async (context) => {
  const { port, seen } = await server(context);
  const created = [];
  class Recording extends http.Agent {
    createConnection(options, callback) { const socket = super.createConnection(options, callback); created.push(socket); return socket; }
  }
  const { transport, clock } = transportFor(port, { protocol: { ...PLAIN, module: { Agent: Recording, request: http.request } } });
  await transport.preconnect();
  assert.equal(created.length, 1);
  assert.equal(created[0]._handle.hasRef(), false, "the waiting socket is unref'd");
  clock.at += 6_000;
  assert.equal(await transport.preconnect(), true);
  await settle();
  assert.equal(seen.connections.length, 2, "a connection past the idle time is not trusted: a new one is opened");
  assert.equal(created[0].destroyed, true);
  // A call after the idle time does not reuse a kept connection either.
  const response = await post(transport, port);
  assert.equal(response.ok, true);
  clock.at += 6_000;
  await post(transport, port);
  assert.equal(seen.connections.length >= 3, true);
});

test("a pre-connect that cannot complete answers false, never rejects, and leaves no connection held", async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const { transport } = transportFor(port);
  assert.equal(await transport.preconnect(), false);
  assert.equal(await transport.preconnect(), false, "and it can be tried again");
});

test("the abort ends a call that waits, and the phase says where it waited", async (context) => {
  const { port } = await server(context, (_request, response) => setTimeout(() => response.end("{}"), 400).unref());
  const slow = transportFor(port);
  const controller = new AbortController();
  const phases = [];
  const waiting = post(slow.transport, port, "{}", { signal: controller.signal, watch: (read) => { phases.push(read); } });
  await settle(120);
  assert.equal(phases[0](), "response", "the request went out and the answer is awaited");
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });

  const lookup = transportFor(port, { resolver: fakeResolver({ delayMs: 300 }) });
  const second = new AbortController();
  const reads = [];
  const looking = post(lookup.transport, port, "{}", { signal: second.signal, watch: (read) => { reads.push(read); } });
  await settle(60);
  assert.equal(reads[0](), "dns", "the name is still being looked up");
  second.abort();
  await assert.rejects(looking, { name: "AbortError" });
});

test("only the one host is reachable, a redirect is not followed, and an answer larger than 64 KB is refused", async (context) => {
  const { port, seen } = await server(context, (request, response) => {
    if (request.url === "/big") response.end("x".repeat(70 * 1024));
    else if (request.url === "/moved") { response.statusCode = 302; response.setHeader("location", "/elsewhere"); response.end(); }
    else response.end("{}");
  });
  const { transport } = transportFor(port);
  await assert.rejects(transport.fetch(`http://other.test:${port}/`, { method: "POST", body: "{}" }), TypeError);
  await assert.rejects(transport.fetch(`https://${HOST}:${port}/`, { method: "POST", body: "{}" }), TypeError, "the scheme is the transport's own");
  assert.equal(seen.requests.length, 0, "nothing was sent for either");
  const moved = await transport.fetch(`http://${HOST}:${port}/moved`, { method: "POST", body: "{}" });
  assert.equal(moved.ok, false);
  assert.equal(moved.status, 302);
  assert.equal(seen.requests.length, 1, "the redirect was not followed");
  await assert.rejects(transport.fetch(`http://${HOST}:${port}/big`, { method: "POST", body: "{}" }), /too large/u);
});

test("the production transport is TLS to api.typesafe.ai through the DNS library and a keep-alive agent", async () => {
  assert.equal(JEV_HOST, "api.typesafe.ai");
  assert.equal(JEV_IDLE_MS, 30_000);
  const { default: https } = await import("node:https");
  let created = null;
  const recording = class extends https.Agent { constructor(options) { super(options); created = options; } };
  const transport = createJevTransport({ protocol: { module: { Agent: recording, request: https.request }, secure: true, ready: "secureConnect" } });
  assert.equal(typeof transport.fetch, "function");
  assert.equal(typeof transport.preconnect, "function");
  assert.equal(created.keepAlive, true);
  assert.equal(typeof created.lookup, "function");
  // Only its own host, over TLS: a plain-HTTP URL for it is refused before any connection.
  await assert.rejects(transport.fetch("http://api.typesafe.ai/v1/systemone", { method: "POST", body: "{}" }), TypeError);
  await assert.rejects(transport.fetch("https://example.com/", { method: "POST", body: "{}" }), TypeError);
});
