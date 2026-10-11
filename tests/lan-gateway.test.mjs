import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { startLanGateway } from "../desktop/runtime/lan-gateway.mjs";
import { createLanSharingController } from "../desktop/runtime/lan-sharing.mjs";

const AUTHORIZATION = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
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

function requestStatus(origin, { path = "/", method = "GET", headers = {}, body } = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path, method, headers, agent: false }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end(body);
  });
}

async function pair(gateway) {
  const created = gateway.createPairing();
  const pairingUrl = new URL(created.url);
  assert.equal(pairingUrl.search, "");
  assert.match(pairingUrl.hash, /^#[A-Za-z0-9_-]{43}$/);
  const response = await fetch(`${gateway.origin}/__pomegr/pair`, {
    method: "POST",
    headers: { Origin: gateway.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ secret: pairingUrl.hash.slice(1) }),
  });
  assert.equal(response.status, 204);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie || "", /HttpOnly; SameSite=Strict; Path=\/$/);
  assert.equal(cookie?.includes("Secure"), false);
  return cookie.split(";", 1)[0];
}

test("LAN gateway pairs a same-subnet browser once and forwards only bounded read routes", async () => {
  const observed = [];
  const upstream = http.createServer((request, response) => {
    const seen = { url: request.url, method: request.method, headers: request.headers, body: "" };
    request.on("data", (chunk) => { seen.body += chunk; });
    observed.push(seen);
    if (request.url === "/api/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", Vary: "RSC" });
      response.write("data: ready\n\n");
      return;
    }
    const compressed = request.url.startsWith("/api/session-domain?") && request.headers["accept-encoding"] === "gzip";
    response.writeHead(200, {
      "Content-Type": "application/json", Vary: "RSC", "Set-Cookie": "upstream=forbidden",
      "X-Pomegr-Revision": "42", "X-Accel-Buffering": "no", "X-Vinext-Rsc": "1",
      "Content-Security-Policy": "default-src 'self'", "X-Frame-Options": "DENY",
      ...(compressed ? { "Content-Encoding": "gzip", Vary: "RSC, Accept-Encoding" } : {}),
    });
    const body = JSON.stringify({ local: true });
    response.end(compressed ? gzipSync(body) : body);
  });
  const upstreamOrigin = await listen(upstream);
  let changes = 0;
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true,
    networkPolicy: loopbackTestNetwork, onChange: () => { changes += 1; },
  });
  try {
    const pairingPage = await fetch(`${gateway.origin}/__pomegr/pair`);
    assert.equal(pairingPage.status, 200);
    const pairingMarkup = await pairingPage.text();
    assert.match(pairingMarkup, /Pair Pomegr/);
    const first = gateway.createPairing();
    const firstSecret = new URL(first.url).hash.slice(1);
    assert.doesNotMatch(pairingMarkup, new RegExp(firstSecret));
    assert.equal(await requestStatus(gateway.origin, { path: "/__pomegr/pair", headers: { Host: "localhost:1" } }), 400);
    assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
      method: "POST", headers: { Origin: "http://127.0.0.1:1", "Content-Type": "application/json" }, body: JSON.stringify({ secret: firstSecret }),
    })).status, 403);
    assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
      method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: `${firstSecret}x` }),
    })).status, 403);
    const redeemed = await fetch(`${gateway.origin}/__pomegr/pair`, {
      method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: firstSecret }),
    });
    assert.equal(redeemed.status, 204, "an incorrect attempt does not consume a live code");
    const cookie = redeemed.headers.get("set-cookie").split(";", 1)[0];

    assert.equal((await fetch(`${gateway.origin}/api/state`)).status, 401);
    const domainPath = "/api/session-domain?sessionId=claude%3Afixture&domain=agents&revision=7";
    assert.equal((await fetch(`${gateway.origin}${domainPath}`)).status, 401);
    assert.equal((await fetch(`${gateway.origin}/api/provider-folders`)).status, 401);
    assert.equal((await fetch(`${gateway.origin}/api/notifications`)).status, 401);
    assert.equal((await fetch(`${gateway.origin}/api/repositories`)).status, 401);
    const redirect = await fetch(gateway.origin, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/__pomegr/pair");

    assert.deepEqual(gateway.snapshot(), { pairedClients: 1 });
    assert.ok(changes >= 1);
    const access = await fetch(`${gateway.origin}/api/client-access`, { headers: { Cookie: cookie } });
    assert.deepEqual(await access.json(), { mode: "lan", canCopyTranscriptPath: false });
    assert.equal(access.headers.get("cache-control"), "no-store");
    const providerFolders = await fetch(`${gateway.origin}/api/provider-folders`, {
      headers: { Cookie: cookie, "x-pomegr-desktop-authorization": "client-value" },
    });
    assert.equal(providerFolders.status, 200);
    assert.deepEqual(await providerFolders.json(), { local: true });
    assert.equal(observed.at(-1).url, "/api/provider-folders");
    assert.equal(observed.at(-1).headers.host, new URL(upstreamOrigin).host);
    assert.equal(observed.at(-1).headers["x-pomegr-desktop-authorization"], AUTHORIZATION);
    assert.equal(observed.at(-1).headers.cookie, undefined);
    // Every forwarded request is marked, so the upstream never takes a LAN client for a same-computer one.
    assert.equal(observed.at(-1).headers["x-pomegr-lan-gateway"], "1");
    assert.equal((await fetch(`${gateway.origin}/api/provider-folders?source=client`, { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await fetch(`${gateway.origin}/api/provider-folders`, { method: "POST", headers: { Cookie: cookie } })).status, 405);
    assert.equal((await fetch(`${gateway.origin}/api/provider-folders`, { method: "HEAD", headers: { Cookie: cookie } })).status, 405);
    assert.equal(await requestStatus(gateway.origin, {
      path: "/api/provider-folders", headers: { Cookie: cookie, "Content-Length": "1" }, body: "x",
    }), 403);
    assert.equal((await fetch(`${gateway.origin}/api/provider-folders`, { headers: { Origin: "http://127.0.0.1:1", Cookie: cookie } })).status, 403);
    const notifications = await fetch(`${gateway.origin}/api/notifications`, { headers: { Cookie: cookie } });
    assert.equal(notifications.status, 200);
    assert.equal(observed.at(-1).url, "/api/notifications");
    assert.equal((await fetch(`${gateway.origin}/api/notifications`, { method: "POST", headers: { Cookie: cookie } })).status, 405);
    assert.equal((await fetch(`${gateway.origin}/api/state`, { headers: { Cookie: cookie, Origin: "http://127.0.0.1:1" } })).status, 403);

    await pair(gateway);
    await pair(gateway);
    await pair(gateway);
    assert.equal(gateway.snapshot().pairedClients, 4);
    const capacity = gateway.createPairing();
    const capacitySecret = new URL(capacity.url).hash.slice(1);
    for (let index = 0; index < 2; index += 1) {
      assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
        method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: capacitySecret }),
      })).status, 429, "capacity does not consume a valid pairing code");
    }

    const data = await fetch(`${gateway.origin}/api/state?revision=7`, {
      headers: { Cookie: cookie, RSC: "1", "Next-Url": "/?revision=7", "x-pomegr-desktop-authorization": "client-value" },
    });
    assert.equal(data.status, 200);
    assert.equal(data.headers.get("set-cookie"), null);
    assert.equal(data.headers.get("vary"), "RSC");
    assert.equal(data.headers.get("x-pomegr-revision"), "42");
    assert.equal(data.headers.get("x-accel-buffering"), "no");
    assert.equal(data.headers.get("x-vinext-rsc"), "1");
    assert.equal(data.headers.get("content-security-policy"), "default-src 'self'");
    assert.deepEqual(await data.json(), { local: true });
    const forwarded = observed.at(-1);
    assert.equal(forwarded.url, "/api/state?revision=7");
    assert.equal(forwarded.headers["x-pomegr-desktop-authorization"], AUTHORIZATION);
    assert.equal(forwarded.headers.cookie, undefined);
    assert.equal(forwarded.headers.rsc, "1");
    assert.equal(forwarded.headers["next-url"], "/?revision=7");

    const domain = await fetch(`${gateway.origin}${domainPath}`, {
      headers: { Cookie: cookie, "Accept-Encoding": "gzip", "x-pomegr-desktop-authorization": "client-value" },
    });
    assert.equal(domain.status, 200);
    assert.deepEqual(await domain.json(), { local: true });
    assert.equal(domain.headers.get("x-pomegr-revision"), "42");
    assert.equal(domain.headers.get("content-encoding"), "gzip");
    assert.equal(domain.headers.get("vary"), "RSC, Accept-Encoding");
    assert.equal(observed.at(-1).url, domainPath);
    assert.equal(observed.at(-1).headers["accept-encoding"], "gzip");
    assert.equal(observed.at(-1).headers["x-pomegr-desktop-authorization"], AUTHORIZATION);
    assert.equal(observed.at(-1).headers.cookie, undefined);
    assert.equal((await fetch(`${gateway.origin}${domainPath}`, {
      headers: { Cookie: cookie, Origin: "http://127.0.0.1:1" },
    })).status, 403);

    const rsc = await fetch(`${gateway.origin}/settings.rsc?_rsc=test`, {
      headers: { Cookie: cookie, RSC: "1", "X-Vinext-Mounted-Slots": "main", "X-Vinext-Rsc-Render-Mode": "prefetch" },
    });
    assert.equal(rsc.status, 200);
    assert.equal(observed.at(-1).url, "/settings.rsc?_rsc=test");
    assert.equal(observed.at(-1).headers["x-vinext-mounted-slots"], "main");
    assert.equal((await fetch(`${gateway.origin}/api/transcript-path.rsc`, { headers: { Cookie: cookie } })).status, 404);

    const repositories = await fetch(`${gateway.origin}/api/repositories?revision=3`, { headers: { Cookie: cookie } });
    assert.equal(repositories.status, 200, "the repository list is a read-only LAN route");
    assert.equal(observed.at(-1).url, "/api/repositories?revision=3");
    assert.equal(observed.at(-1).headers["x-pomegr-desktop-authorization"], AUTHORIZATION);
    assert.equal((await fetch(`${gateway.origin}/api/repositories`, { method: "POST", headers: { Cookie: cookie } })).status, 405);

    for (const route of ["/repositories/repo-0123456789abcdef01234567", "/repositories/repo-0123456789abcdef01234567.rsc?tab=inventory&provider=claude&revision=ctx-001"]) {
      assert.equal(await requestStatus(gateway.origin, { path: route, headers: { Cookie: cookie } }), 200);
      assert.equal(observed.at(-1).url, route);
    }
    // A paired browser reads the Tasks page and its board, and sends task actions through one POST route.
    for (const route of ["/tasks?repository=repo-0123456789abcdef01234567", "/tasks.rsc?repository=repo-0123456789abcdef01234567", "/api/tasks?repositoryId=repo-0123456789abcdef01234567"]) {
      assert.equal(await requestStatus(gateway.origin, { path: route, headers: { Cookie: cookie } }), 200);
      assert.equal(observed.at(-1).url, route);
      assert.equal(observed.at(-1).headers["x-pomegr-lan-gateway"], "1");
    }
    const action = JSON.stringify({ repositoryId: "repo-0123456789abcdef01234567", action: "create", payload: { text: "From a phone" } });
    const actionHeaders = { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" };
    const sent = await fetch(`${gateway.origin}/api/tasks/action`, { method: "POST", headers: { ...actionHeaders, "x-pomegr-desktop-authorization": "client-value" }, body: action });
    assert.equal(sent.status, 200);
    assert.deepEqual(
      [observed.at(-1).method, observed.at(-1).url, observed.at(-1).body, observed.at(-1).headers["x-pomegr-desktop-authorization"], observed.at(-1).headers["x-pomegr-lan-gateway"], observed.at(-1).headers.origin, observed.at(-1).headers.cookie],
      ["POST", "/api/tasks/action", action, AUTHORIZATION, "1", undefined, undefined],
    );
    const beforeRefused = observed.length;
    // Not paired, another origin or none, another content type, a query, an oversize body, and every other POST path are refused unforwarded.
    assert.equal((await fetch(`${gateway.origin}/api/tasks/action`, { method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: action })).status, 401);
    assert.equal((await fetch(`${gateway.origin}/api/tasks/action`, { method: "POST", headers: { ...actionHeaders, Origin: "http://127.0.0.1:1" }, body: action })).status, 403);
    assert.equal(await requestStatus(gateway.origin, { path: "/api/tasks/action", method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(action) }, body: action }), 403);
    assert.equal((await fetch(`${gateway.origin}/api/tasks/action`, { method: "POST", headers: { ...actionHeaders, "Content-Type": "text/plain" }, body: action })).status, 403);
    assert.equal((await fetch(`${gateway.origin}/api/tasks/action?x=1`, { method: "POST", headers: actionHeaders, body: action })).status, 403);
    assert.equal((await fetch(`${gateway.origin}/api/tasks/action`, { method: "POST", headers: actionHeaders, body: JSON.stringify({ payload: "x".repeat(18 * 1024) }) })).status, 403);
    for (const route of ["/api/tasks", "/api/tasks/action/", "/api/tasks/start", "/internal/tasks/create"]) {
      assert.equal((await fetch(`${gateway.origin}${route}`, { method: "POST", headers: actionHeaders, body: action })).status, 405);
    }
    assert.equal((await fetch(`${gateway.origin}/api/tasks/action`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal(observed.length, beforeRefused);
    const beforeDenied = observed.length;
    assert.equal(await requestStatus(gateway.origin, { path: "/repositories/../settings", headers: { Cookie: cookie } }), 400);
    assert.equal(await requestStatus(gateway.origin, { path: "/repositories/%2e%2e/settings", headers: { Cookie: cookie } }), 400);
    for (const route of ["/repositories/x", "/repositories/repo-0123456789abcdef0123456", "/repositories/repo-0123456789abcdef0123456g", "/repositories/repo-0123456789abcdef01234567/extra", "/repositories/x.rsc"]) {
      assert.equal(await requestStatus(gateway.origin, { path: route, headers: { Cookie: cookie } }), 404);
    }
    assert.equal((await fetch(`${gateway.origin}/api/transcript-path`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await fetch(`${gateway.origin}/api%2fstate`, { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await fetch(`${gateway.origin}/unknown`, { headers: { Cookie: cookie } })).status, 404);
    // The web-only design-system reference is intentionally absent from the LAN page allowlist.
    assert.equal((await fetch(`${gateway.origin}/design-system`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await fetch(`${gateway.origin}/design-system.rsc`, { headers: { Cookie: cookie, RSC: "1" } })).status, 404);
    assert.equal(observed.length, beforeDenied);

    const stream = await fetch(`${gateway.origin}/api/events`, { headers: { Cookie: cookie } });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /ready/);
    gateway.revoke();
    const streamEnded = await Promise.race([
      reader.read().then((value) => value.done, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    assert.equal(streamEnded, true, "revocation closes active event streams");
    assert.equal(gateway.snapshot().pairedClients, 0);
    // Revocation destroys pooled sockets. Verify access with a fresh connection.
    assert.equal(await requestStatus(gateway.origin, { path: "/api/state", headers: { Cookie: cookie } }), 403);
    assert.equal(await requestStatus(gateway.origin, { path: "/api/provider-folders", headers: { Cookie: cookie } }), 403);
  } finally {
    await gateway.close();
    await close(upstream);
  }
  assert.deepEqual(await gateway.exit, { code: "LAN_GATEWAY_CLOSED" });
});

test("LAN gateway bounds idle client connections", async () => {
  const upstream = http.createServer((_request, response) => response.end("ok"));
  const upstreamOrigin = await listen(upstream);
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork,
  });
  const url = new URL(gateway.origin);
  const sockets = [];
  try {
    for (let index = 0; index < 16; index += 1) {
      const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
      sockets.push(socket);
      await once(socket, "connect");
    }
    const overflow = net.createConnection({ host: url.hostname, port: Number(url.port) });
    sockets.push(overflow);
    await once(overflow, "close");
    assert.equal(overflow.destroyed, true);
  } finally {
    for (const socket of sockets) socket.destroy();
    await gateway.close();
    await close(upstream);
  }
});

test("LAN gateway bounds pairing guesses without disclosing or consuming the code", async () => {
  const upstream = http.createServer((_request, response) => response.end("ok"));
  const upstreamOrigin = await listen(upstream);
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork,
  });
  try {
    const pairing = gateway.createPairing();
    const secret = new URL(pairing.url).hash.slice(1);
    for (let index = 0; index < 8; index += 1) {
      assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
        method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: `${secret}x` }),
      })).status, 403);
    }
    assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
      method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret }),
    })).status, 429);
    assert.deepEqual(gateway.snapshot(), { pairedClients: 0 });
  } finally {
    await gateway.close();
    await close(upstream);
  }
});

test("LAN gateway bounds retained pairing attempt clients", async () => {
  const upstream = http.createServer((_request, response) => response.end("ok"));
  const upstreamOrigin = await listen(upstream);
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true,
    networkPolicy: { ...loopbackTestNetwork, pairingAttemptKey: (request) => request.headers["x-test-client"] },
  });
  try {
    const pairing = gateway.createPairing();
    const secret = new URL(pairing.url).hash.slice(1);
    for (let index = 0; index < 128; index += 1) {
      assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
        method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json", "X-Test-Client": `client_${index}` }, body: JSON.stringify({ secret: `${secret}x` }),
      })).status, 403);
    }
    assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
      method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json", "X-Test-Client": "client_129" }, body: JSON.stringify({ secret }),
    })).status, 429);
    assert.deepEqual(gateway.snapshot(), { pairedClients: 0 });
  } finally {
    await gateway.close();
    await close(upstream);
  }
});

test("LAN gateway rejects malformed network inputs and closes access when identity changes", async () => {
  await assert.rejects(
    startLanGateway({ host: "8.8.8.8", subnetMask: "255.255.255.0", upstreamOrigin: "http://127.0.0.1:4317", authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true }),
    (error) => error.code === "LAN_GATEWAY_INVALID_NETWORK",
  );
  await assert.rejects(
    startLanGateway({ host: "192.168.1.2", subnetMask: "255.0.255.0", upstreamOrigin: "http://127.0.0.1:4317", authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true }),
    (error) => error.code === "LAN_GATEWAY_INVALID_NETWORK",
  );
  await assert.rejects(
    startLanGateway({ host: "192.168.1.2", subnetMask: "255.255.255.0", upstreamOrigin: "http://localhost:4317", authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true }),
    (error) => error.code === "LAN_GATEWAY_INVALID_UPSTREAM",
  );

  const upstream = http.createServer((request, response) => response.end("ok"));
  const upstreamOrigin = await listen(upstream);
  let allowed = true;
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => allowed, networkPolicy: loopbackTestNetwork,
  });
  try {
    const cookie = await pair(gateway);
    allowed = false;
    const response = await fetch(`${gateway.origin}/api/state`, { headers: { Cookie: cookie } }).then((value) => value.status, () => "closed");
    assert.ok(response === 403 || response === "closed");
    assert.equal(gateway.snapshot().pairedClients, 0);
  } finally {
    await gateway.close();
    await close(upstream);
  }
});

test("controller recovery closes streams, blocks reads and pairing, and restores the same cookie and URL", async () => {
  let reads = 0;
  const upstream = http.createServer((request, response) => {
    reads++;
    if (request.url === "/api/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("data: ready\n\n");
    } else response.end("safe state");
  });
  const upstreamOrigin = await listen(upstream);
  const home = { id: "test-home", label: "Test", address: "127.0.0.1", subnetMask: "255.255.255.0" };
  let network = { status: "available", candidates: [home] };
  const timers = new Set();
  let gateway;
  const controller = createLanSharingController({
    upstreamOrigin, authorizationToken: AUTHORIZATION,
    networkReader: { read: async () => network },
    schedule(fn) { timers.add(fn); return fn; }, cancel(fn) { timers.delete(fn); },
    startGateway: async (options) => {
      gateway = await startLanGateway({ ...options, networkPolicy: loopbackTestNetwork });
      return gateway;
    },
  });
  try {
    await controller.setSharing(true);
    const origin = gateway.origin;
    const cookie = await pair(gateway);
    const events = await fetch(`${origin}/api/events`, { headers: { Cookie: cookie } });
    const stream = events.body.getReader();
    await stream.read();
    const streamEnded = stream.read().then((result) => result.done, () => true);
    network = { status: "unavailable", candidates: [], reason: "probe_failed" };
    const tick = [...timers][0]; timers.delete(tick); await tick();
    assert.equal(await streamEnded, true);
    assert.equal(controller.snapshot().status, "recovering");
    assert.equal(controller.snapshot().address, origin);
    assert.equal(await controller.createPairing(), null);
    assert.throws(() => gateway.createPairing());
    for (const route of ["/api/state", "/api/client-access", "/__pomegr/pair"]) {
      const blocked = await fetch(`${origin}${route}`, { headers: { Cookie: cookie } });
      assert.equal(blocked.status, 503);
      assert.equal(blocked.headers.get("Cache-Control"), "no-store");
      assert.equal(blocked.headers.get("Retry-After"), "5");
      assert.equal(blocked.headers.get("Set-Cookie"), null);
      assert.equal(await blocked.text(), "Network verification unavailable; retry shortly");
    }
    assert.equal(reads, 1);
    assert.equal(gateway.snapshot().pairedClients, 1);
    network = { status: "available", candidates: [home] };
    const restored = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(restored.status, 200);
    assert.equal(await restored.text(), "safe state");
    assert.equal(controller.snapshot().status, "sharing");
    assert.equal(reads, 2);
  } finally { await controller.dispose(); await close(upstream); }
});

test("gateway timeout and rejected verification preserve pairing without serving upstream data", async () => {
  let reads = 0;
  const upstream = http.createServer((_request, response) => { reads++; response.end("safe state"); });
  const upstreamOrigin = await listen(upstream);
  let policy = () => true;
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: () => policy(), networkPolicy: loopbackTestNetwork,
  });
  try {
    const cookie = await pair(gateway);
    for (const next of [() => Promise.reject(new Error("PRIVATE_PROBE_ERROR")), () => new Promise(() => {})]) {
      policy = next;
      const response = await fetch(`${gateway.origin}/api/state`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /PRIVATE_PROBE_ERROR/);
      assert.equal(gateway.snapshot().pairedClients, 1);
      assert.equal(reads, 0);
    }
    policy = () => true;
    const recovered = await fetch(`${gateway.origin}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(recovered.status, 200);
    await recovered.text();
  } finally { await gateway.close(); await close(upstream); }
});

test("new suspension or revocation wins over a pending successful request check", async () => {
  for (const revoke of [false, true]) {
    let reads = 0;
    const upstream = http.createServer((_request, response) => { reads++; response.end("safe state"); });
    const upstreamOrigin = await listen(upstream);
    let policy = () => true;
    const gateway = await startLanGateway({
      host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
      authorizationToken: AUTHORIZATION, isNetworkAllowed: () => policy(), networkPolicy: loopbackTestNetwork,
    });
    try {
      const cookie = await pair(gateway);
      let started;
      const checking = new Promise((resolve) => { started = resolve; });
      let finish;
      policy = () => { started(); return new Promise((resolve) => { finish = resolve; }); };
      const request = fetch(`${gateway.origin}/api/state`, { headers: { Cookie: cookie } })
        .then(async (response) => { await response.text(); return response.status; }, () => "closed");
      await checking;
      if (revoke) gateway.revoke();
      else gateway.updateNetworkState(null);
      finish(true);
      const status = await request;
      assert.ok(revoke ? status === "closed" || status === 403 : status === 503);
      assert.equal(reads, 0);
      assert.equal(gateway.snapshot().pairedClients, revoke ? 0 : 1);
    } finally { await gateway.close(); await close(upstream); }
  }
});

const CHAT_REPOSITORY = "repo-0123456789abcdef01234567";
const CHAT_LIMIT_BYTES = 17 * 1024;

async function startChatGateway(agentChat) {
  const observed = [];
  const upstream = http.createServer((request, response) => { observed.push({ url: request.url, method: request.method }); response.end("{}"); });
  const upstreamOrigin = await listen(upstream);
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork,
    ...(agentChat === undefined ? {} : { agentChat }),
  });
  return { gateway, upstream, observed };
}

test("LAN gateway answers POST /api/agent-chat itself, holds it to the task-action rules, and never forwards it", async () => {
  const received = [];
  const agentChat = async (operation, payload) => { received.push([operation, payload]); return { ok: true, conversations: [], running: null }; };
  const { gateway, upstream, observed } = await startChatGateway(agentChat);
  try {
    const cookie = await pair(gateway);
    const headers = { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" };
    const body = JSON.stringify({ operation: "list", payload: { repositoryId: CHAT_REPOSITORY } });
    const answered = await fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers: { ...headers, "x-pomegr-desktop-authorization": "client-value" }, body });
    assert.equal(answered.status, 200);
    assert.equal(answered.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(answered.headers.get("cache-control"), "no-store");
    assert.equal(answered.headers.get("set-cookie"), null);
    assert.deepEqual(await answered.json(), { ok: true, conversations: [], running: null });
    assert.deepEqual(received, [["list", { repositoryId: CHAT_REPOSITORY }]]);
    // The operation and payload are handed over unchanged: the chat, not the gateway, decides what they mean.
    await (await fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers, body: JSON.stringify({ operation: "erase", payload: { any: ["thing"] } }) })).text();
    assert.deepEqual(received.at(-1), ["erase", { any: ["thing"] }]);
    received.length = 0;

    // Not paired, another origin or none, another content type, a query, a chunked or oversize body: refused, never handed on.
    assert.equal((await fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body })).status, 401);
    assert.equal((await fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers: { ...headers, Origin: "http://127.0.0.1:1" }, body })).status, 403);
    assert.equal(await requestStatus(gateway.origin, { path: "/api/agent-chat", method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, body }), 403);
    assert.equal((await fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body })).status, 403);
    assert.equal((await fetch(`${gateway.origin}/api/agent-chat?x=1`, { method: "POST", headers, body })).status, 403);
    assert.equal(await requestStatus(gateway.origin, { path: "/api/agent-chat", method: "POST", headers: { ...headers, "Transfer-Encoding": "chunked" }, body }), 403);
    assert.equal((await fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers, body: JSON.stringify({ operation: "list", payload: { pad: "x".repeat(CHAT_LIMIT_BYTES) } }) })).status, 403);
    // A GET is not a chat request, and every other write path stays closed.
    assert.equal((await fetch(`${gateway.origin}/api/agent-chat`, { headers: { Cookie: cookie } })).status, 404);
    for (const route of ["/api/agent-chat/", "/api/agent-chat/send", "/api/chat", "/internal/agent-chat", "/api/agent-chat.rsc"]) {
      assert.equal((await fetch(`${gateway.origin}${route}`, { method: "POST", headers, body })).status, 405, route);
    }
    for (const method of ["PUT", "PATCH", "DELETE"]) assert.equal((await fetch(`${gateway.origin}/api/agent-chat`, { method, headers, body })).status, 405, method);
    assert.deepEqual(received, [], "a refused request never reaches the chat");
    assert.deepEqual(observed, [], "the web host never sees a chat request");
  } finally {
    await gateway.close();
    await close(upstream);
  }
});

test("LAN gateway accepts a chat request of exactly 17 KiB and refuses one byte more", async () => {
  const received = [];
  const { gateway, upstream, observed } = await startChatGateway(async (operation, payload) => { received.push([operation, payload]); return { ok: true }; });
  try {
    const cookie = await pair(gateway);
    const headers = { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" };
    const envelope = JSON.stringify({ operation: "list", payload: { pad: "" } }).length;
    const sized = (size) => JSON.stringify({ operation: "list", payload: { pad: "x".repeat(size - envelope) } });
    const exact = sized(CHAT_LIMIT_BYTES);
    assert.equal(Buffer.byteLength(exact), CHAT_LIMIT_BYTES);
    const accepted = await fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers, body: exact });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true });
    assert.equal(received.length, 1);
    assert.equal((await fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers, body: sized(CHAT_LIMIT_BYTES + 1) })).status, 403);
    assert.equal(received.length, 1);
    assert.deepEqual(observed, []);
  } finally {
    await gateway.close();
    await close(upstream);
  }
});

test("LAN gateway answers a chat body with another key, or that is not JSON, as invalid without calling the chat", async () => {
  const received = [];
  const { gateway, upstream, observed } = await startChatGateway(async (...args) => { received.push(args); return { ok: true }; });
  try {
    const cookie = await pair(gateway);
    const headers = { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" };
    for (const body of [
      JSON.stringify({ operation: "list", payload: { repositoryId: CHAT_REPOSITORY }, extra: true }), JSON.stringify({ operation: "list", repositoryId: CHAT_REPOSITORY }),
      JSON.stringify({ action: "list", payload: {} }), JSON.stringify([]), JSON.stringify([{ operation: "list", payload: {} }]), "null", "5", '"list"', "not json", "{", "",
    ]) {
      const response = await fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers, body });
      assert.equal(response.status, 200, body);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { ok: false, error: "invalid" }, body);
    }
    assert.deepEqual(received, []);
    assert.deepEqual(observed, []);
  } finally {
    await gateway.close();
    await close(upstream);
  }
});

test("LAN gateway answers unavailable when it was given no chat, and never leaks what a failing chat says", async () => {
  for (const agentChat of [undefined, null, "chat", {}]) {
    const { gateway, upstream, observed } = await startChatGateway(agentChat);
    try {
      const cookie = await pair(gateway);
      const response = await fetch(`${gateway.origin}/api/agent-chat`, {
        method: "POST", headers: { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "list", payload: { repositoryId: CHAT_REPOSITORY } }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: false, error: "unavailable" });
      assert.deepEqual(observed, []);
    } finally {
      await gateway.close();
      await close(upstream);
    }
  }
  const { gateway, upstream } = await startChatGateway(async () => { throw new Error("private failure C:\\secret\\path"); });
  try {
    const cookie = await pair(gateway);
    const response = await fetch(`${gateway.origin}/api/agent-chat`, {
      method: "POST", headers: { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "list", payload: { repositoryId: CHAT_REPOSITORY } }),
    });
    const answer = await response.json();
    assert.equal(response.status, 200);
    assert.equal(answer.ok, false);
    assert.ok(["invalid", "unavailable"].includes(answer.error));
    assert.equal(JSON.stringify(answer).includes("private"), false);
  } finally {
    await gateway.close();
    await close(upstream);
  }
});

test("LAN gateway ends chat access when pairing is revoked, including a chat call that was already running", async () => {
  let started;
  const begun = new Promise((resolve) => { started = resolve; });
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const received = [];
  const { gateway, upstream, observed } = await startChatGateway(async (operation) => {
    received.push(operation);
    if (operation === "send") { started(); await gate; }
    return { ok: true, note: "answer-after-revocation" };
  });
  try {
    const cookie = await pair(gateway);
    const headers = { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" };
    const request = (operation) => fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers, body: JSON.stringify({ operation, payload: { repositoryId: CHAT_REPOSITORY } }) })
      .then(async (response) => ({ status: response.status, text: await response.text() }), () => ({ status: "closed", text: "" }));
    const running = request("send");
    await begun;
    gateway.revoke();
    finish();
    const outcome = await running;
    assert.notEqual(outcome.status, 200);
    assert.equal(outcome.text.includes("answer-after-revocation"), false);
    // Revocation destroys pooled sockets, so a fresh connection checks that access is gone.
    const later = JSON.stringify({ operation: "list", payload: {} });
    assert.equal(await requestStatus(gateway.origin, {
      path: "/api/agent-chat", method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(later) }, body: later,
    }), 403);
    assert.deepEqual(received, ["send"]);
    assert.deepEqual(observed, []);
  } finally {
    await gateway.close();
    await close(upstream);
  }
});
