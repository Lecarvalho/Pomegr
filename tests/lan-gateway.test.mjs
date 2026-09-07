import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { startLanGateway } from "../desktop/lan-gateway.mjs";
import { createLanSharingController } from "../desktop/lan-sharing.mjs";

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

function requestStatus(origin, { path = "/", headers = {} } = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path, headers, agent: false }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
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
    observed.push({ url: request.url, headers: request.headers });
    if (request.url === "/api/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", Vary: "RSC" });
      response.write("data: ready\n\n");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json", Vary: "RSC", "Set-Cookie": "upstream=forbidden",
      "X-Pomegr-Revision": "42", "X-Accel-Buffering": "no", "X-Vinext-Rsc": "1",
      "Content-Security-Policy": "default-src 'self'", "X-Frame-Options": "DENY",
    });
    response.end(JSON.stringify({ local: true }));
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
    const redirect = await fetch(gateway.origin, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/__pomegr/pair");

    assert.deepEqual(gateway.snapshot(), { pairedClients: 1 });
    assert.ok(changes >= 1);
    const access = await fetch(`${gateway.origin}/api/client-access`, { headers: { Cookie: cookie } });
    assert.deepEqual(await access.json(), { mode: "lan", canCopyTranscriptPath: false });
    assert.equal(access.headers.get("cache-control"), "no-store");
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

    const rsc = await fetch(`${gateway.origin}/settings.rsc?_rsc=test`, {
      headers: { Cookie: cookie, RSC: "1", "X-Vinext-Mounted-Slots": "main", "X-Vinext-Rsc-Render-Mode": "prefetch" },
    });
    assert.equal(rsc.status, 200);
    assert.equal(observed.at(-1).url, "/settings.rsc?_rsc=test");
    assert.equal(observed.at(-1).headers["x-vinext-mounted-slots"], "main");
    assert.equal((await fetch(`${gateway.origin}/api/transcript-path.rsc`, { headers: { Cookie: cookie } })).status, 404);

    for (const route of ["/repositories/repo-0123456789abcdef01234567", "/repositories/repo-0123456789abcdef01234567.rsc?tab=inventory&provider=claude&revision=ctx-001"]) {
      assert.equal(await requestStatus(gateway.origin, { path: route, headers: { Cookie: cookie } }), 200);
      assert.equal(observed.at(-1).url, route);
    }
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
